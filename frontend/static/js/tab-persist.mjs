// Open editor tabs, stored in this browser only.
//
// The list lives in localStorage under the same key the tab row already
// uses. Nothing on the server remembers which documents were open, and the
// separate "last active document" entry is not a second copy of that list.
//
// iOS WebKit (Safari, Orion) can kill a page on lock, jetsam, or reboot
// without ever firing beforeunload or unload. A write that waits for the
// next document to load, or for unload, never lands, and the closed tabs
// are back on the next launch. Callers therefore store the list at the
// moment it changes. pagehide and visibilitychange to hidden are the
// events that do fire on the way out, so they flush whatever is in memory
// even if a caller missed a change.
//
// Two more ways a closed tab came back as the active one after the list
// had already been shortened:
//
// * An in-flight switch/load finished afterwards and wrote the pre-close
//   list (the closed document still current). Each write carries a
//   revision; an older revision is ignored.
// * iOS WebKit can roll localStorage back to an earlier checkpoint when
//   the process is killed from the app switcher, so the same snapshot is
//   also written to IndexedDB. The newer revision of the two is the list.
// * The page URL (?project&session&file) is how "open in a new tab" lands
//   on a document. A relaunch of that same URL — an installed home-screen
//   icon keeps its start URL — must not open a document the stored list
//   has already dropped. There is no service worker and no server copy of
//   this list.
//
// Orion (iPhone) does not always reload after the app is swiped away. It
// restores the page from its own session snapshot and fires pageshow with
// persisted=true, so the JavaScript heap still has the tab list from before
// the close. Chrome reloads and reads storage, which is why the same build
// already behaved there. On pageshow and when the page is shown again, the
// heap is replaced with the highest stored revision. A cookie holds that
// snapshot too: the cookie jar is not part of the page snapshot, so a
// frozen localStorage or IndexedDB view cannot hide the close. Tabs are
// not kept in sessionStorage or history.state; both would come back with
// the restored page.

import { TABS_STORAGE_KEY, snapshotTabs } from "./tab-order.mjs";

export { TABS_STORAGE_KEY };

export const TAB_MIRROR_DB = "mark-vector-tabs";
export const TAB_MIRROR_STORE = "tabs";
const TAB_MIRROR_KEY = "open";
// Readable from this page. Path=/ is what document.cookie can see; the
// value is the tab list (refs and titles), and nothing on the server reads it.
export const TAB_STATE_COOKIE = "mv-tabs";
const TAB_COOKIE_LIMIT = 3500;

function sameTabRef(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.filename === b.filename &&
    a.hermesSessionId === b.hermesSessionId;
}

function clampIndex(current, length) {
  if (length <= 0) return -1;
  if (!Number.isInteger(current) || current < 0) return 0;
  if (current >= length) return length - 1;
  return current;
}

export function tabRevisionOf(snapshot) {
  return snapshot && Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
}

function readLocalSnapshot(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const saved = JSON.parse(storage.getItem(TABS_STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.tabs)) return saved;
  } catch {
    // unreadable - treat as nothing stored
  }
  return null;
}

export function tabCookieAssignment(snapshot, { secure = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.tabs)) return null;
  let encoded;
  try {
    encoded = encodeURIComponent(JSON.stringify(snapshot));
  } catch {
    return null;
  }
  if (encoded.length > TAB_COOKIE_LIMIT) return null;
  const secureAttr = secure ? "; Secure" : "";
  return `${TAB_STATE_COOKIE}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${secureAttr}`;
}

export function readTabCookie(cookieString) {
  if (!cookieString) return null;
  const prefix = `${TAB_STATE_COOKIE}=`;
  const found = String(cookieString).split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!found) return null;
  try {
    const saved = JSON.parse(decodeURIComponent(found.slice(prefix.length)));
    if (saved && Array.isArray(saved.tabs)) return saved;
  } catch {
    // unreadable cookie
  }
  return null;
}

// Returns false when `snapshot.revision` is older than what is already
// stored: a load that started before a close must not put that tab back.
// `mirrorWrite` receives the accepted snapshot (the IndexedDB copy).
// `cookieWrite` receives a document.cookie assignment. The cookie jar stays
// outside a restored page heap.
export function writeTabSnapshot(storage, snapshot, { mirrorWrite, cookieWrite, secure = false } = {}) {
  const incoming = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!incoming || !Array.isArray(incoming.tabs)) return false;
  const previous = readLocalSnapshot(storage);
  const revision = Number.isInteger(incoming.revision) ? incoming.revision : tabRevisionOf(previous) + 1;
  if (previous && revision < tabRevisionOf(previous)) return false;
  const stored = { ...incoming, revision };
  let wrote = false;
  if (storage && typeof storage.setItem === "function") {
    try {
      storage.setItem(TABS_STORAGE_KEY, JSON.stringify(stored));
      wrote = true;
    } catch {
      // localStorage unavailable - the mirror and cookie may still keep the list
    }
  }
  if (typeof mirrorWrite === "function") {
    try {
      mirrorWrite(stored);
      wrote = true;
    } catch {
      // mirror unavailable
    }
  }
  if (typeof cookieWrite === "function") {
    const line = tabCookieAssignment(stored, { secure });
    if (line) {
      try {
        cookieWrite(line);
        wrote = true;
      } catch {
        // cookie unavailable
      }
    }
  }
  return wrote;
}

// A hide during startup must not replace the stored list with the empty
// one still in memory. `ready` is false until that list has been copied
// back into memory.
export function flushTabSnapshot(storage, ready, snapshot) {
  if (!ready) return;
  writeTabSnapshot(storage, snapshot);
}

export function readTabSnapshot(storage) {
  return readLocalSnapshot(storage);
}

// The greater revision wins. Pass localStorage, the IndexedDB mirror, and
// the cookie. A tie keeps the earlier source.
export function chooseTabSnapshot(...snapshots) {
  let best = null;
  for (const snapshot of snapshots) {
    if (!snapshot || !Array.isArray(snapshot.tabs)) continue;
    if (!best || tabRevisionOf(snapshot) > tabRevisionOf(best)) best = snapshot;
  }
  return best;
}

function sameTabList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (!sameTabRef(a && a.ref, b && b.ref)) return false;
    if ((a && a.title) !== (b && b.title)) return false;
  }
  return true;
}

// A restored page heap is not the list the user left. When the stored
// revision is newer, or the same revision disagrees, the stored list
// replaces memory. A newer in-memory revision is a close that storage has
// not caught up with, and it stays.
export function reconcileTabList({ memoryRevision = 0, memoryTabs = [], memoryCurrent = -1, stored = null } = {}) {
  const memory = {
    tabs: (Array.isArray(memoryTabs) ? memoryTabs : []).filter((tab) => tab && tab.ref).map(({ ref, title }) => ({ ref, title })),
    current: Number.isInteger(memoryCurrent) ? memoryCurrent : -1,
    revision: Number.isInteger(memoryRevision) && memoryRevision >= 0 ? memoryRevision : 0,
    changed: false,
  };
  if (!stored || !Array.isArray(stored.tabs)) return memory;
  const tabs = stored.tabs.filter((tab) => tab && tab.ref).map(({ ref, title }) => ({ ref, title }));
  const current = clampIndex(stored.current, tabs.length);
  const storedRev = tabRevisionOf(stored);
  if (storedRev < memory.revision) return memory;
  const changed = storedRev > memory.revision || !sameTabList(memory.tabs, tabs) || memory.current !== current;
  return {
    tabs: changed ? tabs : memory.tabs,
    current: changed ? current : memory.current,
    revision: changed ? storedRev : memory.revision,
    changed,
    consumedSearch: stored.consumedSearch,
  };
}

// pageshow runs when Orion restores a frozen page (persisted=true) and
// also on an ordinary load. Becoming visible covers a relaunch that does
// not set persisted. Hidden does not reconcile; that is when we flush.
export function bindTabReconcile({ target, document, reconcile }) {
  const onPageShow = (event) => {
    reconcile({ persisted: !!(event && event.persisted), reason: "pageshow" });
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") reconcile({ persisted: false, reason: "visible" });
  };
  target.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibility);
  return function unbindTabReconcile() {
    target.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

// The list to store the moment a tab is closed, before any document load.
// Closing the tab on screen leaves the one that slides into its slot (or
// the new last tab). Closing another tab leaves the one on screen current.
export function snapshotAfterClose(tabs, current, index) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return snapshotTabs(list, Number.isInteger(current) ? current : -1);
  }
  const next = list.filter((_, i) => i !== index);
  let nextCurrent = current;
  if (index === current) nextCurrent = next.length ? Math.min(index, next.length - 1) : -1;
  else if (Number.isInteger(current) && index < current) nextCurrent = current - 1;
  return snapshotTabs(next, nextCurrent);
}

// A new tab is inserted just after the one on screen, and becomes current.
// An empty row (current -1) gains its first tab at index 0.
export function snapshotAfterOpen(tabs, current, opened) {
  const next = (Array.isArray(tabs) ? tabs : []).slice();
  const at = Number.isInteger(current) && current >= 0 ? current + 1 : 0;
  next.splice(at, 0, opened);
  return snapshotTabs(next, at);
}

export function snapshotAfterActivate(tabs, index) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return snapshotTabs(list, list.length ? 0 : -1);
  }
  return snapshotTabs(list, index);
}

// A ?project&session&file URL opens a document only when there is no stored
// list yet, or when this load is a different URL from the one already
// recorded on the list (`consumedSearch`). The same URL again — a relaunch,
// or a home-screen icon whose start URL never changes — leaves the stored
// list alone, so a tab the user closed stays closed. `activeDoc` is only
// for a browser that has never stored a list.
function urlForRestore(hasSnapshot, saved, urlRef, pageSearch) {
  if (!urlRef) return null;
  if (!hasSnapshot) return urlRef;
  if (typeof saved.consumedSearch !== "string") return null;
  if ((saved.consumedSearch || "") === (pageSearch || "")) return null;
  return urlRef;
}

export function planTabRestore({ saved = null, activeDoc = null, urlRef = null, pageSearch = "" } = {}) {
  const hasSnapshot = !!saved && Array.isArray(saved.tabs);
  const tabs = hasSnapshot
    ? saved.tabs.filter((tab) => tab && tab.ref).map(({ ref, title }) => ({ ref, title }))
    : [];
  const index = clampIndex(hasSnapshot ? saved.current : -1, tabs.length);
  const fromList = index >= 0 ? tabs[index].ref : null;
  const openRef = urlForRestore(hasSnapshot, saved, urlRef, pageSearch) || fromList || (hasSnapshot ? null : activeDoc || null);
  const openIndex = openRef ? tabs.findIndex((tab) => sameTabRef(tab.ref, openRef)) : -1;
  return { tabs, openRef: openRef || null, openIndex, hasSnapshot };
}

function finishMirror(db, resolve, value) {
  try {
    db.close();
  } catch {
    // already closing
  }
  resolve(value);
}

// The copy that survives an iOS localStorage rollback. `open` is async;
// the write is started immediately and finishes on its own.
export function readTabMirror(idb, { timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    if (!idb || typeof idb.open !== "function") {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    let request;
    try {
      request = idb.open(TAB_MIRROR_DB, 1);
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TAB_MIRROR_STORE)) db.createObjectStore(TAB_MIRROR_STORE);
    };
    request.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    request.onsuccess = () => {
      const db = request.result;
      try {
        const get = db.transaction(TAB_MIRROR_STORE, "readonly").objectStore(TAB_MIRROR_STORE).get(TAB_MIRROR_KEY);
        get.onsuccess = () => {
          clearTimeout(timer);
          finishMirror(db, done, get.result || null);
        };
        get.onerror = () => {
          clearTimeout(timer);
          finishMirror(db, done, null);
        };
      } catch {
        clearTimeout(timer);
        finishMirror(db, done, null);
      }
    };
  });
}

export function writeTabMirror(idb, snapshot) {
  if (!idb || typeof idb.open !== "function" || !snapshot) return;
  let request;
  try {
    request = idb.open(TAB_MIRROR_DB, 1);
  } catch {
    return;
  }
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(TAB_MIRROR_STORE)) db.createObjectStore(TAB_MIRROR_STORE);
  };
  request.onerror = () => {};
  request.onsuccess = () => {
    const db = request.result;
    try {
      const tx = db.transaction(TAB_MIRROR_STORE, "readwrite");
      tx.objectStore(TAB_MIRROR_STORE).put(snapshot, TAB_MIRROR_KEY);
      const close = () => {
        try {
          db.close();
        } catch {
          // already closing
        }
      };
      tx.oncomplete = close;
      tx.onerror = close;
    } catch {
      try {
        db.close();
      } catch {
        // already closing
      }
    }
  };
}

// Flush while the page is still alive. `beforeunload` is included for
// browsers that do fire it; iOS often does not, which is why pagehide and
// a hidden page are not optional.
export function bindTabPersistenceFlush({ target, document, flush }) {
  const onHide = () => flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  target.addEventListener("pagehide", onHide);
  target.addEventListener("beforeunload", onHide);
  document.addEventListener("visibilitychange", onVisibility);
  return function unbindTabPersistenceFlush() {
    target.removeEventListener("pagehide", onHide);
    target.removeEventListener("beforeunload", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

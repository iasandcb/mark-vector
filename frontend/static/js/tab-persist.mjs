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

import { TABS_STORAGE_KEY, snapshotTabs } from "./tab-order.mjs";

export { TABS_STORAGE_KEY };

export const TAB_MIRROR_DB = "mark-vector-tabs";
export const TAB_MIRROR_STORE = "tabs";
const TAB_MIRROR_KEY = "open";

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

// Returns false when `snapshot.revision` is older than what is already
// stored: a load that started before a close must not put that tab back.
// `mirrorWrite` receives the accepted snapshot (the IndexedDB copy).
export function writeTabSnapshot(storage, snapshot, { mirrorWrite } = {}) {
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
      // localStorage unavailable - the mirror may still keep the list
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

// localStorage may have been rolled back to an older checkpoint. The
// greater revision is the list the user last closed or opened.
export function chooseTabSnapshot(localSnapshot, mirrorSnapshot) {
  const local = localSnapshot && Array.isArray(localSnapshot.tabs) ? localSnapshot : null;
  const mirror = mirrorSnapshot && Array.isArray(mirrorSnapshot.tabs) ? mirrorSnapshot : null;
  if (!local) return mirror;
  if (!mirror) return local;
  return tabRevisionOf(mirror) > tabRevisionOf(local) ? mirror : local;
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

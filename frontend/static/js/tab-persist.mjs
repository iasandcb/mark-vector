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

import { TABS_STORAGE_KEY, snapshotTabs } from "./tab-order.mjs";

export { TABS_STORAGE_KEY };

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

export function writeTabSnapshot(storage, snapshot) {
  if (!storage || typeof storage.setItem !== "function") return;
  try {
    storage.setItem(TABS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage unavailable - the tabs just won't survive a reload
  }
}

// A hide during startup must not replace the stored list with the empty
// one still in memory. `ready` is false until that list has been copied
// back into memory.
export function flushTabSnapshot(storage, ready, snapshot) {
  if (!ready) return;
  writeTabSnapshot(storage, snapshot);
}

export function readTabSnapshot(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const saved = JSON.parse(storage.getItem(TABS_STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.tabs)) return saved;
  } catch {
    // unreadable - treat as nothing stored
  }
  return null;
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

// `saved` is the stored tab list, or null when that key was never written.
// A present list — including an empty one — is the whole set of open
// documents. `activeDoc` is only for a browser that has never stored a
// list; it must not reopen a tab the list has already dropped, even when
// `current` doesn't point at a remaining tab. `urlRef` is an explicit
// request (a ?project&session&file link) and may name a document that is
// not open yet.
export function planTabRestore({ saved = null, activeDoc = null, urlRef = null } = {}) {
  const hasSnapshot = !!saved && Array.isArray(saved.tabs);
  const tabs = hasSnapshot
    ? saved.tabs.filter((tab) => tab && tab.ref).map(({ ref, title }) => ({ ref, title }))
    : [];
  const index = clampIndex(hasSnapshot ? saved.current : -1, tabs.length);
  const fromList = index >= 0 ? tabs[index].ref : null;
  const openRef = urlRef || fromList || (hasSnapshot ? null : activeDoc || null);
  const openIndex = openRef ? tabs.findIndex((tab) => sameTabRef(tab.ref, openRef)) : -1;
  return { tabs, openRef: openRef || null, openIndex, hasSnapshot };
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

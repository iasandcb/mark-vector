import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { reorderTabs, snapshotTabs } from "./tab-order.mjs";
import {
  TABS_STORAGE_KEY,
  bindTabPersistenceFlush,
  bindTabReconcile,
  chooseTabSnapshot,
  flushTabSnapshot,
  planTabRestore,
  readTabCookie,
  readTabSnapshot,
  reconcileTabList,
  snapshotAfterActivate,
  snapshotAfterClose,
  snapshotAfterOpen,
  tabCookieAssignment,
  writeTabSnapshot,
} from "./tab-persist.mjs";

function tab(title, extra) {
  return { ref: { role: "document", filename: title }, title, ...extra };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function emitter() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
  };
}

function sliceFn(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(start >= 0 && end > start, `${signature} .. ${nextSignature}`);
  return source.slice(start, end);
}

test("the open-tab list stays under the same localStorage key", () => {
  assert.equal(TABS_STORAGE_KEY, "mark-vector:tabs");
});

test("a close is stored before unload, and a stale active document stays closed", () => {
  const storage = memoryStorage();
  let tabs = [tab("a.md"), tab("b.md"), tab("c.md")];
  let current = 0;
  writeTabSnapshot(storage, snapshotTabs(tabs, current));

  // Close the current tab, then the one now on the right. No unload runs.
  let saved = snapshotAfterClose(tabs, current, 0);
  writeTabSnapshot(storage, saved);
  tabs = saved.tabs;
  current = saved.current;
  saved = snapshotAfterClose(tabs, current, 1);
  writeTabSnapshot(storage, saved);

  const plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: { role: "document", filename: "a.md" },
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["b.md"]);
  assert.equal(plan.openRef.filename, "b.md");
  assert.equal(plan.openIndex, 0);
  assert.equal(plan.hasSnapshot, true);
  assert.equal(storage.getItem(TABS_STORAGE_KEY).includes("a.md"), false);
  assert.equal(storage.getItem(TABS_STORAGE_KEY).includes("c.md"), false);
});

test("closing the tab on screen leaves the neighbor that slides into its slot", () => {
  const tabs = [tab("a.md"), tab("b.md"), tab("c.md")];
  assert.equal(snapshotAfterClose(tabs, 0, 0).current, 0);
  assert.deepEqual(snapshotAfterClose(tabs, 0, 0).tabs.map((item) => item.title), ["b.md", "c.md"]);
  assert.equal(snapshotAfterClose(tabs, 2, 2).current, 1);
  assert.deepEqual(snapshotAfterClose(tabs, 2, 2).tabs.map((item) => item.title), ["a.md", "b.md"]);
  assert.equal(snapshotAfterClose(tabs, 1, 1).current, 1);
  assert.deepEqual(snapshotAfterClose(tabs, 1, 1).tabs.map((item) => item.title), ["a.md", "c.md"]);
  assert.equal(tabs.length, 3);
});

test("closing some other tab keeps the one on screen", () => {
  const tabs = [tab("a.md"), tab("b.md"), tab("c.md")];
  const closedBefore = snapshotAfterClose(tabs, 2, 0);
  assert.deepEqual(closedBefore.tabs.map((item) => item.title), ["b.md", "c.md"]);
  assert.equal(closedBefore.current, 1);
  const closedAfter = snapshotAfterClose(tabs, 0, 2);
  assert.deepEqual(closedAfter.tabs.map((item) => item.title), ["a.md", "b.md"]);
  assert.equal(closedAfter.current, 0);
});

test("the stored close drops unsaved text", () => {
  const beta = tab("b.md", { stash: { content: "dirty" } });
  const saved = snapshotAfterClose([tab("a.md"), beta], 0, 0);
  assert.equal("stash" in saved.tabs[0], false);
  assert.equal(beta.stash.content, "dirty");
});

test("closing the last tab stores an empty list and does not reopen it", () => {
  const storage = memoryStorage();
  const only = [tab("a.md")];
  writeTabSnapshot(storage, snapshotAfterClose(only, 0, 0));
  const plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: only[0].ref,
  });
  assert.deepEqual(plan.tabs, []);
  assert.equal(plan.openRef, null);
  assert.equal(plan.openIndex, -1);
  assert.equal(plan.hasSnapshot, true);
});

test("an impossible close leaves the stored list alone", () => {
  const tabs = [tab("a.md"), tab("b.md")];
  const saved = snapshotAfterClose(tabs, 0, 5);
  assert.deepEqual(saved.tabs.map((item) => item.title), ["a.md", "b.md"]);
  assert.equal(saved.current, 0);
  assert.equal(tabs[0].title, "a.md");
  assert.equal(tabs.length, 2);
});

test("opening a tab stores it just after the current one, immediately", () => {
  const storage = memoryStorage();
  const tabs = [tab("a.md"), tab("b.md")];
  const opened = tab("c.md", { stash: { content: "not stored" } });
  writeTabSnapshot(storage, snapshotAfterOpen(tabs, 0, opened));
  const plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: tabs[0].ref,
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["a.md", "c.md", "b.md"]);
  assert.equal(plan.openIndex, 1);
  assert.equal(plan.openRef.filename, "c.md");
  assert.equal("stash" in plan.tabs[1], false);
  assert.equal(tabs.length, 2);
  const first = snapshotAfterOpen([], -1, tab("only.md"));
  assert.deepEqual(first.tabs.map((item) => item.title), ["only.md"]);
  assert.equal(first.current, 0);
});

test("activating a tab stores that index immediately", () => {
  const storage = memoryStorage();
  const tabs = [tab("a.md"), tab("b.md"), tab("c.md")];
  writeTabSnapshot(storage, snapshotAfterActivate(tabs, 2));
  const plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: tabs[0].ref,
  });
  assert.equal(plan.openRef.filename, "c.md");
  assert.equal(plan.openIndex, 2);
  assert.equal(snapshotAfterActivate(tabs, 9).current, 0);
  assert.equal(snapshotAfterActivate([], 0).current, -1);
});

test("reordering is the list that gets stored, not the previous order", () => {
  const storage = memoryStorage();
  const tabs = [tab("a.md"), tab("b.md"), tab("c.md")];
  writeTabSnapshot(storage, snapshotTabs(tabs, 0));
  const moved = reorderTabs(tabs, 0, 2, 0);
  writeTabSnapshot(storage, snapshotTabs(moved.tabs, moved.current));
  const plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: tabs[2].ref,
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["c.md", "a.md", "b.md"]);
  assert.equal(plan.openIndex, 1);
  assert.equal(plan.openRef.filename, "a.md");
});

test("a bad current index does not fall through to a closed document", () => {
  const plan = planTabRestore({
    saved: {
      tabs: [
        { ref: { role: "document", filename: "a.md" }, title: "a.md" },
        { ref: { role: "document", filename: "b.md" }, title: "b.md" },
      ],
      current: 9,
    },
    activeDoc: { role: "document", filename: "closed.md" },
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["a.md", "b.md"]);
  assert.equal(plan.openRef.filename, "b.md");
  const negative = planTabRestore({
    saved: {
      tabs: [{ ref: { role: "document", filename: "a.md" }, title: "a.md" }],
      current: -1,
    },
    activeDoc: { role: "document", filename: "closed.md" },
  });
  assert.equal(negative.openRef.filename, "a.md");
});

test("a tab with no document is dropped and still does not restore the active document", () => {
  const plan = planTabRestore({
    saved: {
      tabs: [null, { title: "nope" }, { ref: { role: "document", filename: "a.md" }, title: "a.md" }],
      current: 0,
    },
    activeDoc: { role: "document", filename: "closed.md" },
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["a.md"]);
  assert.equal(plan.openRef.filename, "a.md");
});

test("with no stored list the active document still opens", () => {
  const activeDoc = { role: "document", filename: "only.md" };
  const plan = planTabRestore({ saved: null, activeDoc });
  assert.equal(plan.hasSnapshot, false);
  assert.equal(plan.openRef, activeDoc);
  assert.deepEqual(plan.tabs, []);
  assert.equal(plan.openIndex, -1);
});

test("a different document link still opens when it is not already a tab", () => {
  const urlRef = { role: "document", projectId: "p", sessionId: "s", filename: "linked.md" };
  const plan = planTabRestore({
    saved: {
      tabs: [{ ref: { role: "document", projectId: "p", sessionId: "s", filename: "kept.md" }, title: "kept.md" }],
      current: 0,
      consumedSearch: "",
    },
    activeDoc: { role: "document", filename: "closed.md" },
    urlRef,
    pageSearch: "?project=p&session=s&file=linked.md",
  });
  assert.equal(plan.openRef, urlRef);
  assert.equal(plan.openIndex, -1);
  assert.equal(plan.tabs.length, 1);
  assert.equal(plan.tabs[0].title, "kept.md");
});

test("a different document link switches to the tab that already has it", () => {
  const urlRef = { role: "hermes-session", hermesSessionId: "1" };
  const plan = planTabRestore({
    saved: {
      tabs: [{ ref: { role: "hermes-session", hermesSessionId: "1", hermesTitle: "chat" }, title: "chat" }],
      current: 0,
      consumedSearch: "",
    },
    activeDoc: { role: "document", filename: "chat" },
    urlRef,
    pageSearch: "?project=p&session=s&file=chat",
  });
  assert.equal(plan.openIndex, 0);
  assert.equal(plan.openRef, urlRef);
});

test("closing 2026-11-15.c.md keeps it closed when a stale load and the page URL name it", () => {
  const now = {
    ref: { role: "document", projectId: "p", sessionId: "s", filename: "now.md" },
    title: "now.md",
  };
  const closed = {
    ref: { role: "document", projectId: "p", sessionId: "s", filename: "2026-11-15.c.md" },
    title: "2026-11-15.c.md",
  };
  const page = "?project=p&session=s&file=2026-11-15.c.md";
  const storage = memoryStorage();
  let mirror = null;
  const mirrorWrite = (snapshot) => {
    mirror = snapshot;
  };

  // Both tabs are open and the conversation file is the one on screen.
  // That is also what the address bar (or the home-screen start URL) names.
  writeTabSnapshot(storage, {
    ...snapshotAfterActivate([now, closed], 1),
    revision: 1,
    consumedSearch: page,
  }, { mirrorWrite });

  // Close the second tab. This revision has to be the one that survives.
  const closedList = snapshotAfterClose([now, closed], 1, 1);
  assert.equal(writeTabSnapshot(storage, {
    ...closedList,
    revision: 2,
    consumedSearch: page,
  }, { mirrorWrite }), true);
  assert.deepEqual(mirror.tabs.map((item) => item.title), ["now.md"]);
  assert.equal(mirror.current, 0);

  // The switch that was loading 2026-11-15.c.md finishes and tries to store
  // the pre-close list, with that file current.
  assert.equal(writeTabSnapshot(storage, {
    ...snapshotTabs([now, closed], 1),
    revision: 1,
    consumedSearch: page,
  }, { mirrorWrite }), false);
  assert.equal(mirror.revision, 2);

  // Swiping the app away rolls localStorage back to the previous checkpoint.
  // IndexedDB kept the close.
  storage.setItem(TABS_STORAGE_KEY, JSON.stringify({
    tabs: [
      { ref: now.ref, title: now.title },
      { ref: closed.ref, title: closed.title },
    ],
    current: 1,
    revision: 1,
    consumedSearch: page,
  }));
  const saved = chooseTabSnapshot(readTabSnapshot(storage), mirror);
  const plan = planTabRestore({
    saved,
    activeDoc: closed.ref,
    urlRef: closed.ref,
    pageSearch: page,
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["now.md"]);
  assert.equal(plan.openRef.filename, "now.md");
  assert.equal(plan.openIndex, 0);
  assert.equal(plan.tabs.some((item) => item.title === "2026-11-15.c.md"), false);
});

function docTab(filename) {
  return {
    ref: { role: "document", projectId: "p", sessionId: "s", filename },
    title: filename,
  };
}

test("Orion's restored heap drops the closed tab when storage or the cookie is newer", () => {
  const now = docTab("now.md");
  const closed = docTab("2026-11-15.c.md");
  const page = "?project=p&session=s&file=2026-11-15.c.md";
  const storage = memoryStorage();
  let jar = "";
  const closedList = {
    ...snapshotAfterClose([now, closed], 1, 1),
    revision: 4,
    consumedSearch: page,
  };
  assert.equal(writeTabSnapshot(storage, closedList, {
    cookieWrite: (line) => { jar = line; },
    secure: true,
  }), true);
  assert.match(jar, /^mv-tabs=/);
  assert.match(jar, /Path=\//);
  assert.match(jar, /Secure/);
  const roundTrip = readTabCookie(jar);
  assert.equal(roundTrip.revision, 4);
  assert.deepEqual(roundTrip.tabs.map((item) => item.title), ["now.md"]);

  // The page snapshot still has both tabs, and so do the storage views
  // Orion froze with the heap. The cookie jar was written at close time.
  storage.setItem(TABS_STORAGE_KEY, JSON.stringify({
    tabs: [
      { ref: now.ref, title: now.title },
      { ref: closed.ref, title: closed.title },
    ],
    current: 1,
    revision: 3,
    consumedSearch: page,
  }));
  const frozenMirror = {
    tabs: [
      { ref: now.ref, title: now.title },
      { ref: closed.ref, title: closed.title },
    ],
    current: 1,
    revision: 3,
    consumedSearch: page,
  };
  const stored = chooseTabSnapshot(readTabSnapshot(storage), frozenMirror, readTabCookie(jar));
  const heap = reconcileTabList({
    memoryRevision: 3,
    memoryTabs: [now, closed],
    memoryCurrent: 1,
    stored,
  });
  assert.equal(heap.changed, true);
  assert.equal(heap.revision, 4);
  assert.equal(heap.current, 0);
  assert.deepEqual(heap.tabs.map((item) => item.title), ["now.md"]);
  const plan = planTabRestore({
    saved: stored,
    activeDoc: closed.ref,
    urlRef: closed.ref,
    pageSearch: page,
  });
  assert.equal(plan.openRef.filename, "now.md");
  assert.deepEqual(plan.tabs.map((item) => item.title), ["now.md"]);
});

test("a newer in-memory close is kept when the stored list is older", () => {
  const now = docTab("now.md");
  const closed = docTab("2026-11-15.c.md");
  const next = reconcileTabList({
    memoryRevision: 5,
    memoryTabs: [now],
    memoryCurrent: 0,
    stored: {
      tabs: [now, closed],
      current: 1,
      revision: 4,
    },
  });
  assert.equal(next.changed, false);
  assert.equal(next.revision, 5);
  assert.deepEqual(next.tabs.map((item) => item.title), ["now.md"]);
});

test("an older cookie does not beat a newer local list", () => {
  const now = docTab("now.md");
  const closed = docTab("2026-11-15.c.md");
  const chosen = chooseTabSnapshot(
    { tabs: [now], current: 0, revision: 5 },
    null,
    { tabs: [now, closed], current: 1, revision: 4 },
  );
  assert.equal(chosen.revision, 5);
  assert.deepEqual(chosen.tabs.map((item) => item.title), ["now.md"]);
});

test("a tab list that does not fit in a cookie is not written there", () => {
  const huge = [{ ref: { role: "document", filename: "x".repeat(4000) }, title: "x" }];
  assert.equal(tabCookieAssignment({ tabs: huge, current: 0, revision: 1 }), null);
});

test("pageshow on a restored page and becoming visible reconcile the heap", () => {
  const events = [];
  const target = emitter();
  const doc = emitter();
  doc.visibilityState = "hidden";
  const unbind = bindTabReconcile({
    target,
    document: doc,
    reconcile: (info) => events.push(info),
  });
  target.dispatch("pageshow", { persisted: true });
  target.dispatch("pageshow", { persisted: false });
  doc.visibilityState = "visible";
  doc.dispatch("visibilitychange");
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  assert.deepEqual(events, [
    { persisted: true, reason: "pageshow" },
    { persisted: false, reason: "pageshow" },
    { persisted: false, reason: "visible" },
  ]);
  unbind();
  target.dispatch("pageshow", { persisted: true });
  assert.equal(events.length, 3);
});

test("unreadable storage is an absent list, and a failed write does not throw", () => {
  const storage = memoryStorage();
  storage.setItem(TABS_STORAGE_KEY, "{");
  assert.equal(readTabSnapshot(storage), null);
  storage.setItem(TABS_STORAGE_KEY, "null");
  assert.equal(readTabSnapshot(storage), null);
  assert.equal(readTabSnapshot(null), null);
  const full = {
    setItem() {
      throw new Error("full");
    },
  };
  writeTabSnapshot(full, snapshotTabs([tab("a.md")], 0));
  writeTabSnapshot(null, snapshotTabs([], -1));
});

test("a flush before the stored list is loaded does not wipe it", () => {
  const storage = memoryStorage();
  writeTabSnapshot(storage, snapshotTabs([tab("a.md"), tab("b.md")], 1));
  flushTabSnapshot(storage, false, snapshotTabs([], -1));
  const plan = planTabRestore({ saved: readTabSnapshot(storage), activeDoc: null });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["a.md", "b.md"]);
  assert.equal(plan.openIndex, 1);
  flushTabSnapshot(storage, true, snapshotAfterClose([tab("a.md"), tab("b.md")], 1, 0));
  const next = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: { role: "document", filename: "a.md" },
  });
  assert.deepEqual(next.tabs.map((item) => item.title), ["b.md"]);
  assert.equal(next.openRef.filename, "b.md");
});

test("pagehide, beforeunload, and hiding the page flush the list in memory", () => {
  const storage = memoryStorage();
  let tabs = [tab("a.md"), tab("b.md")];
  let current = 1;
  const target = emitter();
  const doc = emitter();
  doc.visibilityState = "visible";
  const unbind = bindTabPersistenceFlush({
    target,
    document: doc,
    flush: () => writeTabSnapshot(storage, snapshotTabs(tabs, current)),
  });

  doc.dispatch("visibilitychange");
  assert.equal(readTabSnapshot(storage), null);

  const saved = snapshotAfterClose(tabs, current, 0);
  tabs = saved.tabs;
  current = saved.current;
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  let plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: { role: "document", filename: "a.md" },
  });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["b.md"]);
  assert.equal(plan.openRef.filename, "b.md");

  tabs = [tab("a.md"), tab("c.md")];
  current = 1;
  target.dispatch("pagehide", { persisted: false });
  plan = planTabRestore({
    saved: readTabSnapshot(storage),
    activeDoc: { role: "document", filename: "a.md" },
  });
  assert.equal(plan.openRef.filename, "c.md");
  assert.deepEqual(plan.tabs.map((item) => item.title), ["a.md", "c.md"]);

  tabs = [tab("only.md")];
  current = 0;
  target.dispatch("beforeunload");
  plan = planTabRestore({ saved: readTabSnapshot(storage), activeDoc: null });
  assert.deepEqual(plan.tabs.map((item) => item.title), ["only.md"]);

  unbind();
  tabs = [tab("gone.md")];
  current = 0;
  target.dispatch("pagehide");
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  target.dispatch("beforeunload");
  assert.equal(readTabSnapshot(storage).tabs[0].title, "only.md");
});

test("the editor stores a close before it loads the next document, and flushes on hide", () => {
  const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const closeTab = sliceFn(app, "async function closeTab", "function canMoveTabToSplit");
  const saveAt = closeTab.indexOf("saveTabs(saved)");
  const awaitAt = closeTab.indexOf("await switchToTab");
  assert.ok(closeTab.includes("snapshotAfterClose(tabs, currentTab, index)"));
  assert.ok(closeTab.indexOf("bumpTabEpoch()") < saveAt);
  assert.ok(saveAt > 0 && awaitAt > saveAt);

  const switchToTab = sliceFn(app, "async function switchToTab", "async function closeTab");
  const activateAt = switchToTab.indexOf("saveTabs(snapshotAfterActivate(tabs, currentTab))");
  const loadAt = switchToTab.indexOf("await loadIntoTab");
  assert.ok(activateAt > 0 && loadAt > activateAt);
  assert.ok(switchToTab.indexOf("if (!tabLoadCurrent(epoch)) return") > loadAt);
  const dropAt = switchToTab.indexOf("saveTabs(saved)");
  const nextAt = switchToTab.indexOf("await switchToTab");
  assert.ok(dropAt > loadAt && nextAt > dropAt);

  const openInTab = sliceFn(app, "async function openInTab", "async function switchToTab");
  const openedAt = openInTab.indexOf("snapshotAfterOpen(tabs, previous, opened)");
  const openedSave = openInTab.indexOf("saveTabs(saved)", openedAt);
  assert.ok(openedAt > 0 && openedSave > openedAt);
  assert.equal(openInTab.slice(openedAt, openedSave).includes("await "), false);

  const reorder = sliceFn(app, "function applyTabOrder", "function armTabClickSuppression");
  assert.ok(reorder.includes("saveTabs()"));
  assert.equal(reorder.includes("await "), false);

  assert.match(app, /flush: \(\) => \{\n\s+if \(!tabsHydrated\) return;\n\s+saveTabs\(\);\n\s+\}/);
  assert.match(app, /chooseTabSnapshot\(localTabs, mirrorTabs, readTabCookie\(document\.cookie\)\)/);
  assert.match(app, /readTabMirror\(globalThis\.indexedDB\)/);
  assert.match(app, /writeTabMirror\(globalThis\.indexedDB, stored\)/);
  assert.match(app, /bindTabReconcile\(\{[\s\S]*?reconcile: \(\) => \{ reconcileTabsFromDisk\(\); \}/);
  const code = app.replace(/\/\/[^\n]*/g, "");
  assert.equal(code.includes("sessionStorage"), false);
  assert.equal(/history\.(state|replaceState|pushState)/.test(code), false);
  const select = sliceFn(app, "async function selectDocument(", "async function selectDocumentB");
  const epochGate = select.indexOf("if (!tabLoadCurrent(epoch)) return");
  const assign = select.indexOf("active = {");
  assert.ok(epochGate > 0 && assign > epochGate);
  const restore = app.slice(app.indexOf("const restored = planTabRestore"));
  const hydratedAt = restore.indexOf("tabsHydrated = true");
  const awaitRestore = restore.indexOf("await switchToTab");
  assert.ok(hydratedAt > 0 && awaitRestore > hydratedAt);
  assert.match(app, /planTabRestore\(\{[\s\S]*?activeDoc: savedDocRef,[\s\S]*?urlRef: urlDocRef/);
  const hiddenFlush = fs.readFileSync(new URL("./tab-persist.mjs", import.meta.url), "utf8");
  assert.match(hiddenFlush, /visibilityState === "hidden"/);
  assert.match(hiddenFlush, /addEventListener\("pagehide"/);
  assert.match(hiddenFlush, /addEventListener\("beforeunload"/);
});

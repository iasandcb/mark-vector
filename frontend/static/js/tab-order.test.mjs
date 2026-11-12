import assert from "node:assert/strict";
import test from "node:test";
import {
  TABS_STORAGE_KEY,
  dropIndicatorX,
  pointerPastDragThreshold,
  reorderTabs,
  snapshotTabs,
  tabDropTarget,
  tabGapIndex,
} from "./tab-order.mjs";

const edges = [
  { left: 0, right: 100 },
  { left: 102, right: 202 },
  { left: 204, right: 304 },
];

function tab(title, extra) {
  return { ref: { role: "document", filename: title }, title, ...extra };
}

test("the open-tab list stays under the same localStorage key", () => {
  assert.equal(TABS_STORAGE_KEY, "mark-vector:tabs");
});

test("a short press is not a drag", () => {
  assert.equal(pointerPastDragThreshold(0, 0), false);
  assert.equal(pointerPastDragThreshold(3, 0), false);
  assert.equal(pointerPastDragThreshold(0, 3), false);
  assert.equal(pointerPastDragThreshold(-3, 2), false);
  assert.equal(pointerPastDragThreshold(4, 0), true);
  assert.equal(pointerPastDragThreshold(0, -4), true);
  assert.equal(pointerPastDragThreshold(3, 3), true);
});

test("the pointer picks the gap before the first midpoint it has not passed", () => {
  assert.equal(tabGapIndex(-10, edges), 0);
  assert.equal(tabGapIndex(0, edges), 0);
  assert.equal(tabGapIndex(49, edges), 0);
  assert.equal(tabGapIndex(50, edges), 1);
  assert.equal(tabGapIndex(151, edges), 1);
  assert.equal(tabGapIndex(152, edges), 2);
  assert.equal(tabGapIndex(400, edges), 3);
  assert.equal(tabGapIndex(10, []), 0);
});

test("the drop line sits on the chosen gap", () => {
  assert.equal(dropIndicatorX(0, edges), 0);
  assert.equal(dropIndicatorX(1, edges), 101);
  assert.equal(dropIndicatorX(2, edges), 203);
  assert.equal(dropIndicatorX(3, edges), 304);
  assert.equal(dropIndicatorX(0, []), 0);
});

test("dropping on either side of the dragged tab does not move it", () => {
  assert.equal(tabDropTarget(1, 1, 3), null);
  assert.equal(tabDropTarget(1, 2, 3), null);
  assert.equal(tabDropTarget(0, 0, 3), null);
  assert.equal(tabDropTarget(0, 1, 3), null);
  assert.equal(tabDropTarget(2, 2, 3), null);
  assert.equal(tabDropTarget(2, 3, 3), null);
  assert.equal(tabDropTarget(1, -1, 3), null);
  assert.equal(tabDropTarget(1, 4, 3), null);
  assert.equal(tabDropTarget(1.5, 0, 3), null);
});

test("a gap on the other side of the row is an index after removal", () => {
  assert.equal(tabDropTarget(2, 0, 3), 0);
  assert.equal(tabDropTarget(2, 1, 3), 1);
  assert.equal(tabDropTarget(0, 2, 3), 1);
  assert.equal(tabDropTarget(0, 3, 3), 2);
  assert.equal(tabDropTarget(1, 0, 4), 0);
  assert.equal(tabDropTarget(1, 3, 4), 2);
  assert.equal(tabDropTarget(1, 4, 4), 3);
});

test("reordering moves that tab and keeps the others in place", () => {
  const alpha = tab("alpha.md");
  const beta = tab("beta.md", { stash: { content: "unsaved", active: { savedContent: "" } } });
  const gamma = tab("gamma.md");
  const tabs = [alpha, beta, gamma];
  const moved = reorderTabs(tabs, 0, 2, 0);
  assert.deepEqual(moved.tabs.map((item) => item.title), ["gamma.md", "alpha.md", "beta.md"]);
  assert.equal(moved.tabs[0], gamma);
  assert.equal(moved.tabs[2], beta);
  assert.equal(moved.tabs[2].stash.content, "unsaved");
  assert.equal(moved.current, 1);
  assert.equal(moved.moved, true);
  assert.deepEqual(tabs.map((item) => item.title), ["alpha.md", "beta.md", "gamma.md"]);
});

test("the active tab stays active when it is the one that moves", () => {
  const tabs = [tab("alpha.md"), tab("beta.md"), tab("gamma.md")];
  const moved = reorderTabs(tabs, 1, 1, 2);
  assert.deepEqual(moved.tabs.map((item) => item.title), ["alpha.md", "gamma.md", "beta.md"]);
  assert.equal(moved.current, 2);
  const back = reorderTabs(moved.tabs, moved.current, 2, 0);
  assert.deepEqual(back.tabs.map((item) => item.title), ["beta.md", "alpha.md", "gamma.md"]);
  assert.equal(back.current, 0);
});

test("a tab that did not move keeps its place when another passes it", () => {
  const tabs = [tab("a.md"), tab("b.md"), tab("c.md"), tab("d.md")];
  assert.equal(reorderTabs(tabs, 2, 0, 3).current, 1);
  assert.equal(reorderTabs(tabs, 2, 3, 0).current, 3);
  assert.equal(reorderTabs(tabs, 0, 2, 3).current, 0);
});

test("an unchanged or impossible move leaves the list alone", () => {
  const tabs = [tab("a.md"), tab("b.md")];
  for (const [from, to] of [[0, 0], [1, 1], [-1, 0], [0, 2], [2, 0]]) {
    const same = reorderTabs(tabs, 1, from, to);
    assert.equal(same.moved, false);
    assert.equal(same.tabs, tabs);
    assert.equal(same.current, 1);
  }
});

test("the saved list is the new order and the active index, without unsaved text", () => {
  const alpha = tab("alpha.md");
  const beta = tab("beta.md", { stash: { content: "still dirty" } });
  const gamma = tab("gamma.md");
  const moved = reorderTabs([alpha, beta, gamma], 2, 2, 0);
  const saved = JSON.parse(JSON.stringify(snapshotTabs(moved.tabs, moved.current)));
  assert.deepEqual(saved, {
    tabs: [
      { ref: { role: "document", filename: "gamma.md" }, title: "gamma.md" },
      { ref: { role: "document", filename: "alpha.md" }, title: "alpha.md" },
      { ref: { role: "document", filename: "beta.md" }, title: "beta.md" },
    ],
    current: 0,
  });
  assert.equal("stash" in saved.tabs[2], false);
  assert.equal(saved.tabs[saved.current].title, "gamma.md");
});

test("dragging the last tab onto the first gap is that reorder", () => {
  const gap = tabGapIndex(20, edges);
  const to = tabDropTarget(2, gap, edges.length);
  assert.equal(gap, 0);
  assert.equal(to, 0);
  assert.equal(dropIndicatorX(gap, edges), edges[0].left);
  const moved = reorderTabs([tab("alpha.md"), tab("beta.md"), tab("gamma.md")], 2, 2, to);
  assert.deepEqual(moved.tabs.map((item) => item.title), ["gamma.md", "alpha.md", "beta.md"]);
  assert.equal(moved.current, 0);
});

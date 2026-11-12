// Order of the open document tabs.
//
// A drag does not live-reorder the row. The pointer picks a gap (0 before
// the first tab, through `length` after the last) by which tab midpoint it
// has crossed, and the drop indicator sits in that gap. The gap on either
// side of the dragged tab is its current slot, so releasing there changes
// nothing. Any other gap is an index in the array after the dragged tab is
// removed.
//
// The saved list is the array order, same shape the editor already writes
// to localStorage. Unsaved text is not part of that list.

export const TABS_STORAGE_KEY = "mark-vector:tabs";

// A shorter move stays a click: switch to the tab, or press its close
// button. Matches the tree row drag, which uses the same 4px gate.
export const TAB_DRAG_THRESHOLD_PX = 4;

export function pointerPastDragThreshold(dx, dy, threshold = TAB_DRAG_THRESHOLD_PX) {
  return Math.hypot(dx, dy) >= threshold;
}

export function tabGapIndex(pointerX, edges) {
  if (!Array.isArray(edges) || edges.length === 0) return 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const left = edge && typeof edge.left === "number" ? edge.left : 0;
    const right = edge && typeof edge.right === "number" ? edge.right : left;
    if (pointerX < (left + right) / 2) return i;
  }
  return edges.length;
}

export function tabDropTarget(from, gap, count) {
  if (!Number.isInteger(from) || !Number.isInteger(gap) || !Number.isInteger(count)) return null;
  if (count < 1 || from < 0 || from >= count || gap < 0 || gap > count) return null;
  if (gap === from || gap === from + 1) return null;
  return gap > from ? gap - 1 : gap;
}

export function dropIndicatorX(gap, edges) {
  if (!Array.isArray(edges) || edges.length === 0) return 0;
  if (gap <= 0) return edges[0].left;
  if (gap >= edges.length) return edges[edges.length - 1].right;
  return (edges[gap - 1].right + edges[gap].left) / 2;
}

export function reorderTabs(tabs, current, from, to) {
  if (!Array.isArray(tabs)) return { tabs, current, moved: false };
  const count = tabs.length;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= count ||
    to >= count ||
    from === to
  ) {
    return { tabs, current, moved: false };
  }
  const next = tabs.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  let nextCurrent = current;
  if (current === from) nextCurrent = to;
  else if (typeof current === "number" && from < current && to >= current) nextCurrent = current - 1;
  else if (typeof current === "number" && from > current && to <= current) nextCurrent = current + 1;
  return { tabs: next, current: nextCurrent, moved: true };
}

export function snapshotTabs(tabs, current) {
  return {
    tabs: (Array.isArray(tabs) ? tabs : []).map(({ ref, title }) => ({ ref, title })),
    current,
  };
}

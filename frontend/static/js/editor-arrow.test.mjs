import assert from "node:assert/strict";
import test from "node:test";
import { ARROW_ECHO_MS, arrowFromKeyEvent, createArrowEcho, createModifierLatch, editorArrowPlan, moveCaret } from "./editor-arrow.mjs";

function applyChanges(text, changes) {
  const ordered = [...(changes || [])].sort((a, b) => b.from - a.from);
  let next = text;
  for (const change of ordered) next = next.slice(0, change.from) + (change.insert || "") + next.slice(change.to ?? change.from);
  return next;
}

test("ArrowLeft and ArrowRight move one code point and collapse the caret", () => {
  assert.deepEqual(moveCaret("가나다", 2, 2, "ArrowLeft"), { anchor: 1, head: 1 });
  assert.deepEqual(moveCaret("가나다", 1, 1, "ArrowRight"), { anchor: 2, head: 2 });
  assert.deepEqual(moveCaret("a😀b", 3, 3, "ArrowLeft"), { anchor: 1, head: 1 });
  assert.deepEqual(moveCaret("ab", 0, 0, "ArrowLeft"), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret("ab", 2, 2, "ArrowRight"), { anchor: 2, head: 2 });
});

test("ArrowUp and ArrowDown keep the column on the neighbouring logical line", () => {
  const doc = "abc\nxy\nhello";
  assert.deepEqual(moveCaret(doc, 5, 5, "ArrowUp"), { anchor: 1, head: 1 });
  assert.deepEqual(moveCaret(doc, 1, 1, "ArrowDown"), { anchor: 5, head: 5 });
  assert.deepEqual(moveCaret(doc, 0, 0, "ArrowUp"), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret(doc, doc.length, doc.length, "ArrowDown"), { anchor: doc.length, head: doc.length });
});

test("a selection collapses to the edge, and Shift extends it", () => {
  assert.deepEqual(moveCaret("abcdef", 0, 4, "ArrowLeft"), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret("abcdef", 0, 4, "ArrowRight"), { anchor: 4, head: 4 });
  assert.deepEqual(moveCaret("abcdef", 2, 2, "ArrowRight", { shift: true }), { anchor: 2, head: 3 });
  assert.deepEqual(moveCaret("abcdef", 2, 4, "ArrowRight", { shift: true }), { anchor: 2, head: 5 });
  assert.deepEqual(moveCaret("abcdef", 2, 4, "ArrowLeft", { shift: true }), { anchor: 2, head: 3 });
});

test("Ctrl and Alt move by group, and Ctrl+Up jumps to the document edge", () => {
  const doc = "abc def";
  assert.deepEqual(moveCaret(doc, 7, 7, "ArrowLeft", { ctrl: true }), { anchor: 4, head: 4 });
  assert.deepEqual(moveCaret(doc, 4, 4, "ArrowLeft", { ctrl: true }), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret(doc, 0, 0, "ArrowRight", { alt: true, shift: true }), { anchor: 0, head: 3 });
  assert.deepEqual(moveCaret("abc\ndef", 5, 5, "ArrowUp", { ctrl: true }), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret("abc\ndef", 1, 1, "ArrowDown", { meta: true, shift: true }), { anchor: 1, head: 7 });
});

test("Home and End stop at the line, and Ctrl+Home at the document", () => {
  const doc = "  ab\ncd";
  assert.deepEqual(moveCaret(doc, 4, 4, "Home"), { anchor: 2, head: 2 });
  assert.deepEqual(moveCaret(doc, 2, 2, "Home"), { anchor: 0, head: 0 });
  assert.deepEqual(moveCaret(doc, 1, 1, "End"), { anchor: 4, head: 4 });
  assert.deepEqual(moveCaret(doc, 6, 6, "Home", { ctrl: true, shift: true }), { anchor: 6, head: 0 });
  assert.deepEqual(moveCaret(doc, 0, 0, "End", { ctrl: true }), { anchor: doc.length, head: doc.length });
});

test("Alt+Up and Alt+Down move the line, Shift+Alt copies it", () => {
  const down = moveCaret("aaa\nbbb", 1, 1, "ArrowDown", { alt: true });
  assert.equal(applyChanges("aaa\nbbb", down.changes), "bbb\naaa");
  assert.deepEqual({ anchor: down.anchor, head: down.head }, { anchor: 5, head: 5 });
  const up = moveCaret("aaa\nbbb", 5, 5, "ArrowUp", { alt: true });
  assert.equal(applyChanges("aaa\nbbb", up.changes), "bbb\naaa");
  assert.equal(up.head, 1);
  const copied = moveCaret("aaa", 1, 1, "ArrowUp", { alt: true, shift: true });
  assert.equal(applyChanges("aaa", copied.changes), "aaa\naaa");
  assert.equal(copied.head, 1);
  assert.deepEqual(moveCaret("aaa", 1, 1, "ArrowUp", { alt: true }), { anchor: 1, head: 1 });
});

test("a normal Arrow key is left to the editor; a DPAD keyCode is moved here", () => {
  const echo = createArrowEcho();
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", keyCode: 37 }, echo, 0), { type: "native", key: "ArrowLeft" });
  const odd = createArrowEcho();
  assert.equal(arrowFromKeyEvent({ key: "Unidentified", keyCode: 21 }), "ArrowLeft");
  assert.deepEqual(editorArrowPlan({ key: "Unidentified", keyCode: 21 }, odd, 0), {
    type: "move",
    key: "ArrowLeft",
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  });
  assert.deepEqual(editorArrowPlan({ key: "Unidentified", keyCode: 21, shiftKey: true }, createArrowEcho(), 0), {
    type: "move",
    key: "ArrowLeft",
    modifiers: { shift: true, ctrl: false, alt: false, meta: false },
  });
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", altKey: true, keyCode: 37 }, createArrowEcho(), 0), { type: "native", key: "ArrowLeft" });
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", ctrlKey: true, keyCode: 37 }, createArrowEcho(), 0), { type: "native", key: "ArrowLeft" });
  assert.deepEqual(editorArrowPlan({ key: "Home", keyCode: 36 }, createArrowEcho(), 0), { type: "native", key: "Home" });
  assert.deepEqual(editorArrowPlan({ key: "Unidentified", keyCode: 123, ctrlKey: true }, createArrowEcho(), 0), {
    type: "move",
    key: "End",
    modifiers: { shift: false, ctrl: true, alt: false, meta: false },
  });
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", keyCode: 37, isTrusted: false }, createArrowEcho(), 0), { type: "ignore" });
});

test("the modifier latch remembers Shift after its keydown and forgets it on keyup", () => {
  const latch = createModifierLatch();
  latch.note({ type: "keydown", key: "Shift", shiftKey: true, isTrusted: true });
  assert.deepEqual(latch.snapshot(), { shift: true, ctrl: false, alt: false, meta: false });
  latch.note({ type: "keydown", key: "Unidentified", keyCode: 17, ctrlKey: true, isTrusted: true });
  assert.equal(latch.snapshot().ctrl, true);
  assert.equal(latch.snapshot().shift, true);
  latch.note({ type: "keyup", key: "Shift", shiftKey: false, isTrusted: true });
  assert.equal(latch.snapshot().shift, false);
  latch.note({ type: "keydown", key: "ArrowLeft", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isTrusted: false });
  assert.equal(latch.snapshot().shift, false);
  latch.clear();
  assert.deepEqual(latch.snapshot(), { shift: false, ctrl: false, alt: false, meta: false });
});

test("the gamepad sample of a key that already moved the caret is swallowed", () => {
  const echo = createArrowEcho();
  assert.equal(echo.claimKey("ArrowRight", 0), true);
  assert.equal(echo.claimPad("ArrowRight", 16), false);
  assert.equal(editorArrowPlan({ key: "ArrowRight", keyCode: 39 }, echo, 20).type, "native");
});

test("a keydown that arrives after the gamepad sample does not move again", () => {
  const echo = createArrowEcho();
  assert.equal(echo.claimPad("ArrowUp", 0), true);
  assert.deepEqual(editorArrowPlan({ key: "ArrowUp", keyCode: 38 }, echo, 16), { type: "swallow", key: "ArrowUp" });
  assert.equal(echo.claimPad("ArrowUp", ARROW_ECHO_MS + 1), true);
});

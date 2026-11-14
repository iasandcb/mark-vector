import assert from "node:assert/strict";
import test from "node:test";
import { ARROW_ECHO_MS, arrowFromKeyEvent, createArrowEcho, editorArrowPlan, moveCaret } from "./editor-arrow.mjs";

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

test("a selection steps from its head", () => {
  assert.deepEqual(moveCaret("abcdef", 0, 4, "ArrowLeft"), { anchor: 3, head: 3 });
});

test("a normal Arrow key is left to the editor; a DPAD keyCode is moved here", () => {
  const echo = createArrowEcho();
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", keyCode: 37 }, echo, 0), { type: "native", key: "ArrowLeft" });
  const odd = createArrowEcho();
  assert.equal(arrowFromKeyEvent({ key: "Unidentified", keyCode: 21 }), "ArrowLeft");
  assert.deepEqual(editorArrowPlan({ key: "Unidentified", keyCode: 21 }, odd, 0), { type: "move", key: "ArrowLeft" });
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", altKey: true, keyCode: 37 }, createArrowEcho(), 0), { type: "ignore" });
  assert.deepEqual(editorArrowPlan({ key: "ArrowLeft", keyCode: 37, isTrusted: false }, createArrowEcho(), 0), { type: "ignore" });
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

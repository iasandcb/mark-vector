import assert from "node:assert/strict";
import test from "node:test";

import {
  createEditorEnterController,
  editorEnterPlan,
  imeNewlineStillNeeded,
  newlineAfterKoreanComposition,
} from "./editor-enter.mjs";

const HEADING = "# 스스로 배우는 법";
const LIST = "- 스스로 배우는 법";
const TASK = "- [ ] 스스로 배우는 법";
const NESTED = "  - 스스로 배우는 법";

function enter(extra) {
  return { key: "Enter", code: "Enter", keyCode: 13, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra };
}

function docState(value, cursor = value.length) {
  return { value, selectionStart: cursor, selectionEnd: cursor, disabled: false };
}

function controllerFor(doc, { now = () => 0 } = {}) {
  const inserted = [];
  let queued = null;
  const controller = createEditorEnterController({
    read: () => doc,
    insert(text) {
      const start = doc.selectionStart;
      const end = doc.selectionEnd;
      doc.value = doc.value.slice(0, start) + text + doc.value.slice(end);
      doc.selectionStart = doc.selectionEnd = start + text.length;
      inserted.push(text);
    },
    now,
    schedule(fn) {
      queued = fn;
    },
  });
  return {
    controller,
    inserted,
    flush() {
      const fn = queued;
      queued = null;
      if (fn) fn();
    },
  };
}

test("a heading, list item, or task keeps a normal Enter for the editor", () => {
  for (const line of [HEADING, LIST, TASK]) {
    const plan = editorEnterPlan(enter(), { value: line, selectionStart: line.length });
    assert.equal(plan.type, "native", line);
    assert.equal(plan.prevent, false, line);
  }
});

test("an indented line still carries its indent on a normal Enter", () => {
  const plan = editorEnterPlan(enter(), { value: NESTED, selectionStart: NESTED.length });
  assert.deepEqual(plan, { type: "insert", prevent: true, text: "\n  ", direct: true });
});

test("macOS Korean composition Enter is not claimed up front", () => {
  for (const line of [HEADING, LIST, TASK, NESTED]) {
    const plan = editorEnterPlan(enter({ keyCode: 229, isComposing: true }), {
      value: line,
      selectionStart: line.length,
    });
    assert.equal(plan.type, "ime-defer", line);
    assert.equal(plan.prevent, false, line);
  }
});

test("Enter right after 스스로 배우는 법 breaks the line once the composition ends", () => {
  const doc = docState(HEADING);
  const { controller, inserted, flush } = controllerFor(doc, { now: () => 1000 });
  const plan = controller.keydown(enter({ keyCode: 229, isComposing: true }));
  assert.equal(plan.type, "ime-defer");
  assert.equal(doc.value, HEADING);
  controller.compositionend({ data: "법" });
  assert.deepEqual(inserted, []);
  flush();
  assert.deepEqual(inserted, ["\n"]);
  assert.equal(doc.value, `${HEADING}\n`);
  const echo = controller.keydown(enter());
  assert.equal(echo.type, "swallow");
  assert.equal(doc.value, `${HEADING}\n`);
});

test("the caret right after the phrase breaks that line, even mid-document", () => {
  const value = `앞\n${HEADING}\n뒤`;
  const cursor = value.indexOf("법") + "법".length;
  const doc = docState(value, cursor);
  const { controller, flush } = controllerFor(doc, { now: () => 1000 });
  controller.keydown(enter({ keyCode: 229, isComposing: true }));
  controller.compositionend({ data: "법" });
  flush();
  assert.equal(doc.value, `앞\n${HEADING}\n\n뒤`);
  assert.equal(doc.selectionStart, cursor + 1);
});

test("a list item and a task item break the same way", () => {
  for (const line of [LIST, TASK]) {
    const doc = docState(line);
    const { controller, flush } = controllerFor(doc, { now: () => 1000 });
    controller.keydown(enter({ keyCode: 229, isComposing: true }));
    controller.compositionend({ data: "법" });
    flush();
    assert.equal(doc.value, `${line}\n`);
    assert.equal(controller.keydown(enter()).type, "swallow");
    assert.equal(doc.value, `${line}\n`);
  }
});

test("the echo Enter before compositionend does not take the indent path", () => {
  const doc = docState(NESTED);
  const { controller, inserted, flush } = controllerFor(doc, { now: () => 1000 });
  controller.keydown(enter({ keyCode: 229, isComposing: true }));
  const echo = controller.keydown(enter());
  assert.equal(echo.type, "swallow");
  assert.equal(echo.prevent, true);
  assert.deepEqual(inserted, []);
  assert.equal(doc.value, NESTED);
  controller.compositionend({ data: "법" });
  flush();
  assert.equal(doc.value, `${NESTED}\n  `);
});

test("a nested Korean item keeps its indent and does not break twice", () => {
  const doc = docState(NESTED);
  const { controller, flush } = controllerFor(doc, { now: () => 1000 });
  const plan = controller.keydown(enter({ keyCode: 229, isComposing: true }));
  assert.equal(plan.prevent, false);
  controller.compositionend({ data: "법" });
  flush();
  assert.equal(doc.value, `${NESTED}\n  `);
  assert.equal(doc.selectionStart, doc.value.length);
});

test("Safari reports the Korean Enter after compositionend, still as keyCode 229", () => {
  const doc = docState(HEADING);
  const { controller, inserted } = controllerFor(doc, { now: () => 1000 });
  controller.compositionend({ data: "법" });
  const plan = controller.keydown(enter({ keyCode: 229, isComposing: false }));
  assert.equal(plan.type, "insert");
  assert.equal(plan.direct, true);
  assert.equal(plan.prevent, true);
  assert.deepEqual(inserted, ["\n"]);
  assert.equal(controller.keydown(enter()).type, "swallow");
  assert.equal(doc.value, `${HEADING}\n`);
});

test("the syllable can land in the document only after compositionend", () => {
  const doc = docState("# ");
  const { controller, flush } = controllerFor(doc, { now: () => 1000 });
  controller.keydown(enter({ keyCode: 229, isComposing: true }));
  controller.compositionend({ data: "법" });
  doc.value = "# 법";
  doc.selectionStart = doc.selectionEnd = doc.value.length;
  flush();
  assert.equal(doc.value, "# 법\n");
});

test("an echo that already broke the line is not followed by a second break", () => {
  const doc = docState(HEADING);
  const { controller, flush } = controllerFor(doc, { now: () => 1000 });
  controller.keydown(enter({ keyCode: 229, isComposing: true }));
  doc.value = `${HEADING}\n`;
  doc.selectionStart = doc.selectionEnd = doc.value.length;
  controller.compositionend({ data: "법" });
  flush();
  assert.equal(doc.value, `${HEADING}\n`);
  assert.equal(imeNewlineStillNeeded(HEADING, doc.value), false);
});

test("a Japanese conversion confirm does not insert a newline", () => {
  const doc = docState("日本語");
  const { controller, inserted, flush } = controllerFor(doc, { now: () => 1000 });
  const plan = controller.keydown(enter({ keyCode: 229, isComposing: true }));
  assert.equal(plan.prevent, false);
  controller.compositionend({ data: "日本語" });
  flush();
  assert.deepEqual(inserted, []);
  assert.equal(doc.value, "日本語");
  assert.equal(newlineAfterKoreanComposition("日本語", "日本語".length, "日本語"), null);
});

test("keyCode 229 on a non-Korean line is left to the editor", () => {
  const plan = editorEnterPlan(enter({ keyCode: 229, isComposing: false }), {
    value: "hello",
    selectionStart: 5,
  });
  assert.equal(plan.type, "passthrough");
  assert.equal(plan.prevent, false);
});

test("a later real Enter is not swallowed with the IME echo", () => {
  let clock = 1000;
  const doc = docState(`${HEADING}\n`);
  const { controller } = controllerFor(doc, { now: () => clock });
  controller.keydown(enter({ keyCode: 229, isComposing: true }));
  controller.compositionend({ data: "법" });
  clock = 1200;
  const plan = controller.keydown(enter());
  assert.equal(plan.type, "native");
});

test("Enter at the end of a nested bullet breaks the line and keeps the indent", () => {
  const markers = ["*", "-"];
  const indents = ["  ", "   ", "    ", "\t"];
  for (const marker of markers) {
    for (const indent of indents) {
      const bullet = `${indent}${marker} 스스로 배우는 법`;
      const value = `4. 인능을 어떻게 써야하는가\n${bullet}\n5. 우리의 미래`;
      const cursor = value.indexOf("법") + "법".length;
      const doc = docState(value, cursor);
      const { controller } = controllerFor(doc);
      const plan = controller.keydown(enter());
      assert.equal(plan.type, "insert", JSON.stringify({ marker, indent }));
      assert.equal(plan.direct, true);
      assert.equal(plan.echo, undefined);
      assert.equal(doc.value, `${value.slice(0, cursor)}\n${indent}${value.slice(cursor)}`);
      assert.equal(doc.selectionStart, cursor + 1 + indent.length);
      // A second Enter is another line, not an IME echo to swallow.
      const again = controller.keydown(enter());
      assert.equal(again.type, "insert");
      assert.equal(doc.value, `${value.slice(0, cursor)}\n${indent}\n${indent}${value.slice(cursor)}`);
    }
  }
});

test("Enter at the end of a numbered item is left to the editor", () => {
  const value = "4. 인능을 어떻게 써야하는가\n   * 스스로 배우는 법\n5. 우리의 미래";
  const cursor = value.indexOf("가") + "가".length;
  const doc = docState(value, cursor);
  const { controller, inserted } = controllerFor(doc);
  const plan = controller.keydown(enter());
  assert.equal(plan.type, "native");
  assert.equal(plan.prevent, false);
  assert.deepEqual(inserted, []);
  assert.equal(doc.value, value);
});

test("an IME Enter reported as Process still waits for compositionend", () => {
  const plan = editorEnterPlan(
    { key: "Process", code: "Enter", keyCode: 229, isComposing: true },
    { value: HEADING, selectionStart: HEADING.length },
  );
  assert.equal(plan.type, "ime-defer");
  assert.equal(plan.prevent, false);
});

test("Cmd/Ctrl+Enter is not treated as a line break", () => {
  const plan = editorEnterPlan(enter({ metaKey: true }), { value: HEADING, selectionStart: HEADING.length });
  assert.equal(plan.type, "passthrough");
});

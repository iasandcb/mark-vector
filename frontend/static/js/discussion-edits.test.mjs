import assert from "node:assert/strict";
import test from "node:test";
import { applyEditsToEditor, planDiscussionEdits, undoEditOnEditor } from "./discussion-edits.mjs";

function fakeEditor(initial) {
  let value = initial;
  const selected = [];
  return {
    get value() {
      return value;
    },
    replaceRange(from, to, text) {
      value = value.slice(0, from) + text + value.slice(to);
    },
    setSelectionRange(start, end) {
      selected.push([start, end]);
    },
    selected,
  };
}

const REPLY = [
  "첫 문장을 고쳤습니다.",
  "",
  "````edit",
  "<<<<<<< SEARCH",
  "본문입니다.",
  "=======",
  "고친 본문입니다.",
  ">>>>>>> REPLACE",
  "````",
  "",
  "````edit",
  "<<<<<<< SEARCH",
  "",
  "=======",
  "덧붙인 줄",
  ">>>>>>> REPLACE",
  "````",
].join("\n");

test("a mocked reply's edit blocks change the editor and each one undoes", () => {
  const editor = fakeEditor("# 제목\n\n본문입니다.\n");
  const plan = planDiscussionEdits(editor.value, REPLY);
  assert.equal(plan.display.includes("SEARCH"), false);
  assert.equal(plan.display.includes("첫 문장을 고쳤습니다."), true);
  assert.equal(plan.applied, 2);
  assert.equal(plan.failed, 0);
  applyEditsToEditor(editor, plan.edits);
  assert.equal(editor.value, "# 제목\n\n고친 본문입니다.\n\n덧붙인 줄\n");
  assert.deepEqual(editor.selected.at(-1), [plan.edits[1].start, plan.edits[1].end]);
  assert.equal(undoEditOnEditor(editor, plan.edits[1]), true);
  assert.equal(editor.value, "# 제목\n\n고친 본문입니다.\n");
  assert.equal(undoEditOnEditor(editor, plan.edits[0]), true);
  assert.equal(editor.value, "# 제목\n\n본문입니다.\n");
  editor.replaceRange(0, 0, "앞 ");
  assert.equal(undoEditOnEditor(editor, plan.edits[0]), false);
});

test("a question with no edit block leaves the document alone", () => {
  const plan = planDiscussionEdits("# 제목\n\n본문입니다.\n", "그 문장은 이미 분명합니다.");
  assert.equal(plan.applied, 0);
  assert.equal(plan.content, "# 제목\n\n본문입니다.\n");
  assert.equal(plan.display, "그 문장은 이미 분명합니다.");
});

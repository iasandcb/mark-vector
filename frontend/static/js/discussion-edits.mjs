// Applies the same edit blocks the text conversation already uses
// (doc-edits.js, taught to the model by the backend) to the open document.
// Each splice is one editor change, so it can be undone on its own.

import { applyEditBlock, collapseEditBlocks, parseEditBlocks } from "./doc-edits.js";

export function discussionDisplayText(reply) {
  return collapseEditBlocks(reply || "", " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// `edits` are in order. `from`/`to`/`inserted` are the splice to play on the
// document as it stands after the earlier edits in this same list. `start`
// is where the new text sits, which is what an undo looks for.
export function planDiscussionEdits(content, reply, { final = true } = {}) {
  const blocks = parseEditBlocks(reply || "", { final });
  let text = content;
  const edits = [];
  let failed = 0;
  for (const block of blocks) {
    const result = applyEditBlock(text, block);
    if (!result) {
      failed += 1;
      continue;
    }
    edits.push({
      from: result.from,
      to: result.to,
      removed: text.slice(result.from, result.to),
      inserted: result.text,
      start: result.start,
      end: result.end,
    });
    text = result.content;
  }
  return {
    content: text,
    edits,
    failed,
    applied: edits.length,
    display: discussionDisplayText(reply || ""),
  };
}

export function applyEditsToEditor(editor, edits) {
  for (const edit of edits) {
    editor.replaceRange(edit.from, edit.to, edit.inserted);
    if (typeof editor.setSelectionRange === "function") editor.setSelectionRange(edit.start, edit.end);
  }
}

// Undoes one applied edit if that inserted text is still at the splice.
// Later edits have to be undone first; a change in the middle returns false
// and leaves the document as it is.
export function undoEditOnEditor(editor, edit) {
  if (!edit) return false;
  const content = editor.value;
  const at = content.slice(edit.from, edit.from + edit.inserted.length);
  if (at !== edit.inserted) return false;
  editor.replaceRange(edit.from, edit.from + edit.inserted.length, edit.removed);
  return true;
}

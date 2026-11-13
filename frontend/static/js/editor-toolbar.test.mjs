import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} .. ${endMarker}`);
  return source.slice(start, end);
}

const column = sliceBetween(html, 'id="editor-column"', 'id="split-resizer"');
const paneB = sliceBetween(html, 'id="editor-pane-b"', 'id="preview-resizer"');

test("the editor column has no separate header row for the primary actions", () => {
  assert.equal(column.includes('class="pane-header"'), false);
  assert.match(column, /class="editor-commandbar"/);
});

test("filename and tool status sit on the command bar, ahead of the icon row", () => {
  const titleAt = column.indexOf('id="editor-filename"');
  const statusAt = column.indexOf('id="tool-status"');
  const scrollAt = column.indexOf('class="editor-actions-scroll"');
  assert.ok(titleAt > 0 && statusAt > titleAt && scrollAt > statusAt);
  assert.match(column, /id="editor-filename"[^>]*class="pane-filename"/);
});

test("save, publish, and X article are icon buttons pinned outside the scroller", () => {
  const scrollEnd = column.indexOf("</div>", column.indexOf('id="split-toggle-btn"'));
  const pinned = column.slice(scrollEnd);
  for (const id of ["save-btn", "publish-btn", "export-x-article-btn"]) {
    assert.ok(pinned.includes(`id="${id}"`), id);
    assert.ok(column.indexOf(`id="${id}"`) > scrollEnd, id);
  }
  assert.match(pinned, /id="save-btn"[^>]*data-i18n-title="editor.save"/);
  assert.match(pinned, /id="publish-btn"[\s\S]*id="publish-label"/);
  assert.match(pinned, /id="export-x-article-btn"[^>]*data-i18n-title="xArticle.title"[^>]*data-i18n-aria-label="xArticle.title"/);
  assert.match(pinned, /id="publish-icon"/);
});

test("대화 stays accent-filled, with its label, just before the settings gear", () => {
  assert.match(
    column,
    /id="export-x-article-btn"[\s\S]*<button id="send-btn" class="primary-btn editor-send"[^>]*data-i18n-title="editor.send"[\s\S]*data-i18n="editor.send"[\s\S]*id="toolbar-toggle-btn"/,
  );
  const sendAt = column.indexOf('id="send-btn"');
  const gearAt = column.indexOf('id="toolbar-toggle-btn"');
  const scrollAt = column.indexOf('class="editor-actions-scroll"');
  const scrollEnd = column.indexOf("</div>", column.indexOf('id="split-toggle-btn"'));
  assert.ok(sendAt > scrollEnd && gearAt > sendAt && scrollAt < scrollEnd);
});

test("a narrow phone gives the dictation cluster its own row", () => {
  const css = fs.readFileSync(new URL("../css/workspace.css", import.meta.url), "utf8");
  const marker = "Narrow phone: recording controls on their own row.";
  const at = css.indexOf(marker);
  assert.ok(at > 0, "missing narrow-phone recording-row comment");
  const mediaAt = css.lastIndexOf("@media (max-width: 700px)", at);
  assert.ok(mediaAt > 0 && mediaAt < at, "the recording row must stay inside the phone breakpoint");
  const block = css.slice(at, at + 2200);
  assert.match(block, /@container editor-column \(max-width: 700px\)/);
  assert.match(block, /\.editor-commandbar \.dictation-group \{[^}]*order:\s*-1/);
  assert.match(block, /\.editor-commandbar \.dictation-group \{[^}]*flex:\s*1 0 100%/);
  assert.match(block, /display:\s*contents/);
  assert.match(block, /#dictation-record-btn|dictation-record/);
  const base = css.slice(0, mediaAt);
  assert.match(base, /\.editor-commandbar \{[^}]*flex-wrap:\s*nowrap/);
});

test("the split pane keeps filename plus icon-only publish, article, and save", () => {
  assert.match(paneB, /id="editor-filename-b"/);
  assert.match(paneB, /class="editor-actions-scroll"[\s\S]*id="fold-all-b"[\s\S]*id="unfold-all-b"/);
  const scrollEnd = paneB.indexOf("</div>", paneB.indexOf('id="unfold-all-b"'));
  const pinned = paneB.slice(scrollEnd);
  assert.match(pinned, /id="publish-btn-b"[\s\S]*id="publish-label-b"[\s\S]*id="export-x-article-btn-b"[\s\S]*id="save-btn-b"/);
  assert.match(pinned, /id="save-btn-b"[^>]*data-i18n-title="editor.save"/);
  assert.match(pinned, /id="export-x-article-btn-b"[^>]*data-i18n-aria-label="xArticle.title"/);
  assert.ok(pinned.indexOf('id="close-split-btn"') > pinned.indexOf('id="save-btn-b"'));
});

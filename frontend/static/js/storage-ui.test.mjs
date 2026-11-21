import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../css/workspace.css", import.meta.url), "utf8");
const dialog = fs.readFileSync(new URL("./storage-dialog.js", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");

test("storage is reachable from the editor icon bar and from settings", () => {
  const column = html.slice(html.indexOf('id="editor-column"'), html.indexOf('id="split-resizer"'));
  const scrollAt = column.indexOf('class="editor-actions-scroll"');
  const buttonAt = column.indexOf('id="storage-btn"');
  assert.ok(scrollAt > 0 && buttonAt > scrollAt);
  assert.match(column, /id="storage-btn"[^>]*data-i18n-title="storage.open"/);
  assert.match(column, /id="storage-warning"[^>]*hidden/);
  assert.ok(column.indexOf('id="storage-warning"') < column.indexOf('class="editor-commandbar"'));
  assert.match(html, /id="storage-settings-btn"[^>]*data-i18n-title="storage.open"/);
  assert.match(html, /id="storage-settings-badge"[^>]*hidden/);
});

test("recording rows stack and wrap instead of sharing one line height", () => {
  const list = css.slice(css.indexOf(".storage-list {"), css.indexOf(".storage-summary,"));
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /flex:\s*1\s+1\s+auto/);
  const row = css.slice(css.indexOf(".storage-row {"), css.indexOf(".storage-row:hover"));
  assert.match(row, /flex:\s*0\s+0\s+auto/);
  assert.match(row, /align-items:\s*flex-start/);
  assert.match(row, /height:\s*auto/);
  assert.doesNotMatch(row, /height:\s*\d+px/);
  assert.match(css, /\.storage-row input \{[^}]*align-self:\s*flex-start/);
  assert.match(css, /\.storage-row-main \{[^}]*display:\s*block/);
  const linesAt = css.indexOf(".storage-row-title,");
  const lines = css.slice(linesAt, css.indexOf("}", linesAt) + 1);
  assert.match(lines, /display:\s*block/);
  assert.match(lines, /line-height:\s*1\.45/);
  assert.match(lines, /white-space:\s*normal/);
  assert.match(lines, /overflow-wrap:\s*anywhere/);
});

test("the storage panel stays usable on a phone", () => {
  const at = css.indexOf(".storage-panel");
  assert.ok(at > 0);
  const mediaAt = css.indexOf("@media (max-width: 700px)", at);
  assert.ok(mediaAt > at);
  const block = css.slice(mediaAt, css.indexOf("}", css.indexOf(".storage-preview-list { max-height", mediaAt)) + 1);
  assert.match(block, /\.storage-panel \{[^}]*width:\s*100%/);
  assert.match(block, /\.storage-actions \.secondary-btn \{[^}]*min-height:\s*44px/);
  assert.match(block, /font-size:\s*calc\(14px \* var\(--font-scale\)\)/);
  assert.match(css, /\.storage-usage \{[^}]*font-size:\s*calc\(13px \* var\(--font-scale\)\)/);
  assert.match(css, /\.storage-warning\[hidden\] \{ display: none; \}/);
});

test("Korean copy and a confirm step guard delete and cleanup", () => {
  assert.match(i18n, /"storage.title": "저장 공간"/);
  assert.match(i18n, /"storage.warning": "저장 공간이 \{percent\}% 찼습니다\./);
  assert.match(i18n, /"storage.deleteConfirm": "선택한 녹음 \{count\}개를 삭제할까요\?/);
  assert.match(i18n, /YouTube 업로드가 끝난 원본 \{originals\}개와 재생용 복사본 \{plays\}개/);
  const cleanupAt = dialog.indexOf("previewStorageCleanup");
  const runAt = dialog.indexOf("runStorageCleanup");
  assert.ok(cleanupAt > 0 && runAt > cleanupAt);
  assert.match(dialog.slice(cleanupAt, runAt), /cleanupDecision\(preview, ok\)\.proceed/);
  assert.match(dialog, /showModal\(\)/);
  const deleteAt = dialog.indexOf("storage.deleteConfirm");
  const deleteCall = dialog.indexOf("deleteStorageRecordings");
  assert.ok(deleteAt > 0 && deleteCall > deleteAt);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");

test("Copy to clipboard sits after PDF and uses the same label keys", () => {
  const md = html.indexOf('id="download-md-btn"');
  const pdf = html.indexOf('id="export-pdf-btn"');
  const copy = html.indexOf('id="copy-md-btn"');
  const collapse = html.indexOf('id="preview-collapse-btn"');
  assert.ok(md !== -1 && pdf !== -1 && copy !== -1 && collapse !== -1);
  assert.ok(md < pdf && pdf < copy && copy < collapse);
  assert.match(html, /id="copy-md-btn"[^>]*class="icon-btn preview-only"/);
  assert.match(html, /id="copy-md-btn"[^>]*disabled/);
  assert.match(html, /id="copy-md-btn"[^>]*data-i18n="preview\.copyMd"/);
  assert.match(html, /id="copy-md-btn"[^>]*data-i18n-title="preview\.copyMdTitle"/);
});

test("copy labels exist in English, Korean, and Japanese", () => {
  for (const key of ["preview.copyMd", "preview.copyMdTitle", "preview.copyMdDone", "preview.copyMdFailed"]) {
    assert.equal(i18n.split(`"${key}"`).length - 1, 3, key);
  }
  assert.equal(i18n.includes('"preview.copyMd": "Copy to clipboard"'), true);
  assert.equal(i18n.includes('"preview.copyMd": "클립보드에 복사"'), true);
  assert.equal(i18n.includes('"preview.copyMd": "クリップボードにコピー"'), true);
  assert.equal(i18n.includes('"preview.copyMdDone": "Copied"'), true);
  assert.equal(i18n.includes('"preview.copyMdDone": "복사됨"'), true);
  assert.equal(i18n.includes('"preview.copyMdDone": "コピーしました"'), true);
  assert.equal(i18n.includes('"preview.copyMdFailed": "Couldn\'t copy"'), true);
  assert.equal(i18n.includes('"preview.copyMdFailed": "복사하지 못했습니다"'), true);
  assert.equal(i18n.includes('"preview.copyMdFailed": "コピーできませんでした"'), true);
});

test("download and copy share markdownDownloadForPreview and the clipboard helper", () => {
  assert.equal(app.split("markdownDownloadForPreview(").length - 1, 3);
  assert.match(app, /function downloadActiveAsMarkdown\(\) \{\n  const doc = markdownDownloadForPreview\(\)/);
  assert.match(app, /async function copyPreviewMarkdown\(\) \{\n  const doc = markdownDownloadForPreview\(\)/);
  assert.match(app, /new Blob\(\[doc\.text\]/);
  assert.match(app, /copyToClipboard\(doc\.text\)/);
  assert.match(app, /return copyText\(text\)/);
  const clipboard = fs.readFileSync(new URL("./clipboard-copy.mjs", import.meta.url), "utf8");
  assert.match(clipboard, /navigator\.clipboard\.writeText|clipboard\.writeText/);
  assert.match(clipboard, /execCommand\("copy"\)/);
  assert.match(clipboard, /setSelectionRange/);
  assert.match(app, /COPY_FEEDBACK_MS = 1500/);
  assert.match(app, /el\.copyMdBtn\.disabled = !active/);
  assert.match(app, /el\.copyMdBtn\.addEventListener\("click", copyPreviewMarkdown\)/);
  assert.equal(app.includes("new Blob([el.editor.value]"), false);
});

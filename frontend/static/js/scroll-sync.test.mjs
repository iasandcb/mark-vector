import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { collapseEditBlocks } from "./doc-edits.js";
import {
  annotateSegment,
  annotateTopLevel,
  collapseWithEditorLines,
  dedupeAnchors,
  editorLinesForBlocks,
  lineIndexAt,
  offsetForSourceLine,
  previewScrollForEditor,
  proportionalScroll,
  sourceBlocks,
  sourceLineForOffset,
  sourceLineForPreviewScroll,
} from "./scroll-sync.mjs";

const TALL = [
  { line: 1, top: 0 },
  { line: 20, top: 200 },
  { line: 30, top: 4200 },
  { line: 200, top: 5000 },
];
const END = { line: 201, top: 5600 };

function scrollAt(sourceLine, editorScrollTop) {
  return previewScrollForEditor({
    sourceLine,
    anchors: TALL,
    editorScrollTop,
    editorScrollHeight: 4000,
    editorClientHeight: 600,
    previewScrollHeight: 5600,
    previewClientHeight: 600,
    documentLines: 200,
  });
}

test("top-level blocks record the source line the renderer starts them on", () => {
  const source = [
    "<!-- math: latex -->",
    "# Title",
    "",
    "A paragraph",
    "that stays one block.",
    "",
    "- alpha",
    "- beta",
    "",
    "- gamma",
    "",
    "1. one",
    "   continued",
    "   - nested",
    "2. two",
    "",
    "```lean",
    "theorem t : True := by",
    "  trivial",
    "```",
    "",
    "$$",
    "\\\\int_0^1 x \\, dx",
    "",
    "$$",
    "",
    "![plot](https://example.com/plot.png)",
    "",
    "| a | b |",
    "| --- | ---: |",
    "| 1 | 2 |",
    "",
    "> quoted",
    "> still quoted",
    "",
    "---",
    "",
    "## Later",
  ].join("\n");

  assert.deepEqual(sourceBlocks(source).map((block) => block.line), [
    2, // heading, directive produces nothing
    4, // paragraph covering lines 4-5
    7, // one loose list, blank line included
    12, // ordered list, nested item included
    17, // lean fence
    22, // display math, blank line inside
    27, // image paragraph
    29, // table
    33, // blockquote
    36, // rule
    38, // heading
  ]);
});

test("a math directive between prose lines does not split the paragraph", () => {
  assert.deepEqual(sourceBlocks("hello\n<!-- math: asciimath -->\nworld").map((block) => block.line), [1]);
  assert.deepEqual(sourceBlocks("hello\n\n<!-- math: latex -->\n\nworld").map((block) => block.line), [1, 5]);
});

test("fences, display math, and tables are one block each", () => {
  const source = ["Before", "", "```python", "print(1)", "print(2)", "```", "", "$$x = 1$$", "", "\\[", "a", "\\\\", "b", "\\]", ""].join("\n");
  assert.deepEqual(sourceBlocks(source).map((block) => block.line), [1, 3, 8, 10]);
});

test("annotateTopLevel stamps only the outer element", () => {
  const html = [
    "<h1>Title</h1>",
    '<div class="math-display"><span class="katex"><span>x</span></span></div>',
    "<ul>",
    "<li>alpha</li>",
    "<li>beta<ul><li>nested</li></ul></li>",
    "</ul>",
    "<pre><code>line</code></pre>",
    "<hr>",
  ].join("\n");
  const stamped = annotateTopLevel(html, [2, 8, 14, 20, 30]);
  assert.equal(stamped.match(/data-source-line="/g).length, 5);
  assert.match(stamped, /<h1 data-source-line="2">Title<\/h1>/);
  assert.match(stamped, /<div data-source-line="8" class="math-display">/);
  assert.match(stamped, /<ul data-source-line="14">/);
  assert.equal(stamped.includes("<li data-source-line"), false);
  assert.match(stamped, /<pre data-source-line="20"><code>line<\/code><\/pre>/);
  assert.match(stamped, /<hr data-source-line="30">/);
});

test("an edit fence keeps the following block on its editor line", () => {
  const note = "> edited";
  const source = ["hello", "```edit", "<<<<<<< SEARCH", "a", "=======", "b", ">>>>>>> REPLACE", "```", "world"].join("\n");
  const collapsed = collapseWithEditorLines(source, note);
  assert.equal(collapsed.text, collapseEditBlocks(source, note));
  assert.deepEqual(collapsed.editorLine, [1, 2, 9]);
  assert.deepEqual(editorLinesForBlocks(collapsed.text, 0, collapsed.editorLine), [1, 2, 9]);
  const html = "<p>hello</p>\n<blockquote><p>edited</p></blockquote>\n<p>world</p>";
  const stamped = annotateSegment(html, collapsed.text, 0, collapsed.editorLine);
  assert.match(stamped, /<p data-source-line="1">hello<\/p>/);
  assert.match(stamped, /<blockquote data-source-line="2">/);
  assert.match(stamped, /<p data-source-line="9">world<\/p>/);
});

test("a line inside a tall block interpolates between its neighbours, not by document percentage", () => {
  // Source line 25 is halfway through the 10-line region that renders as 4000px.
  assert.equal(offsetForSourceLine(25, TALL, END), 2200);
  assert.equal(offsetForSourceLine(20, TALL, END), 200);
  assert.equal(offsetForSourceLine(30, TALL, END), 4200);
  const mapped = scrollAt(25, 480);
  const proportional = proportionalScroll(480, 3400, 5000);
  assert.equal(mapped, 2200);
  assert.ok(Math.abs(mapped - proportional) > 1000);
});

test("the start and the end of the editor stay pinned to the preview", () => {
  assert.equal(scrollAt(1, 0), 0);
  assert.equal(scrollAt(200, 3400), 5000);
  // Just off the bottom eases toward the end instead of stopping short of it.
  const nearEnd = scrollAt(190, 3390);
  assert.ok(nearEnd > 4900 && nearEnd < 5000);
});

test("the middle of a long document is not pulled toward the percentage", () => {
  const mapped = scrollAt(100, 1980);
  const proportional = proportionalScroll(1980, 3400, 5000);
  assert.ok(Math.abs(mapped - 4529.41) < 0.1);
  assert.ok(Math.abs(mapped - proportional) > 1000);
});

test("source line and preview offset round-trip between anchors", () => {
  for (const line of [20, 25, 25.5, 30, 100, 150.25]) {
    const offset = offsetForSourceLine(line, TALL, END);
    const back = sourceLineForOffset(offset, TALL, END);
    assert.ok(Math.abs(back - line) < 1e-9, `${line} -> ${offset} -> ${back}`);
  }
  const fromPreview = sourceLineForPreviewScroll({
    previewScrollTop: 2200,
    anchors: TALL,
    previewScrollHeight: 5600,
    documentLines: 200,
  });
  assert.ok(Math.abs(fromPreview - 25) < 1e-9);
});

test("duplicate anchors keep the outer block", () => {
  assert.deepEqual(dedupeAnchors([
    { line: 4, top: 80 },
    { line: 4, top: 96 },
    { line: 9, top: 140 },
  ]), [
    { line: 4, top: 80 },
    { line: 9, top: 140 },
  ]);
});

test("the editor drives the preview from source-line anchors", () => {
  const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /previewScrollForEditor\(/);
  assert.match(app, /annotateSegment\(/);
  assert.match(app, /data-source-line/);
  assert.equal(app.includes("sourceEditor.scrollTop / editorRange"), false);
});

test("lineIndexAt counts the line a segment was sliced from", () => {
  const text = "a\n\nb\n";
  assert.equal(lineIndexAt(text, 0), 0);
  assert.equal(lineIndexAt(text, text.indexOf("b")), 2);
});

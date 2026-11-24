import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import LZString from "./vendor/lz-string.mjs";
import {
  LEAN_PLAYGROUND_PROJECT,
  buildLeanPlaygroundUrl,
  concatenateLeanBlocks,
  extractLeanBlocks,
} from "./lean-playground.mjs";

const SAMPLE = `<!-- math: asciimath -->
$$
f(x) = ax^2 + bx + c
$$
테스트
\`\`\`lean
example : 2 = 2 := by
  rfl
\`\`\`
`;

function parseArgs(hash) {
  // lean4web client/src/store/url-converters.ts parseArgs.
  return Object.fromEntries(
    hash
      .replace("#", "")
      .split("&")
      .map((part) => part.split("="))
      .filter((entry) => entry[0])
      .map(([key, val]) => [key, decodeURIComponent(val)]),
  );
}

function codeFromUrl(url) {
  const args = parseArgs(new URL(url).hash);
  assert.equal(args.project, LEAN_PLAYGROUND_PROJECT);
  if (args.codez) {
    assert.equal(args.code, undefined);
    return LZString.decompressFromBase64(args.codez);
  }
  assert.equal(args.codez, undefined);
  return args.code;
}

test("extracts lean and lean4 fences from the raw source, in order", () => {
  const markdown = `${SAMPLE}
\`\`\`python
print("<not lean>")
\`\`\`

\`\`\`lean4
import Mathlib
example : 3 = 3 := by
  rfl
\`\`\`

\`\`\`math
x^2
\`\`\`

\`\`\`Lean
example : (1 + 1) = 2 := by
  rfl
\`\`\`
`;
  const blocks = extractLeanBlocks(markdown);
  assert.deepEqual(blocks.map((block) => block.language), ["lean", "lean4", "lean"]);
  assert.equal(blocks[0].code, "example : 2 = 2 := by\n  rfl");
  assert.equal(blocks[1].code, "import Mathlib\nexample : 3 = 3 := by\n  rfl");
  assert.equal(blocks[2].code, "example : (1 + 1) = 2 := by\n  rfl");
  assert.equal(blocks.some((block) => block.code.includes("<not lean>")), false);
  assert.equal(blocks.some((block) => block.code.includes("x^2")), false);
});

test("keeps indentation and special characters that HTML would escape", () => {
  const markdown = "```lean\nexample : \"α < β\" := by\n  -- 50% & fun (n : Nat)\n  rfl\n```\r\n";
  const [block] = extractLeanBlocks(markdown);
  assert.equal(block.code, "example : \"α < β\" := by\n  -- 50% & fun (n : Nat)\n  rfl");
});

test("a lean fence inside another language is not its own block", () => {
  const markdown = [
    "```python",
    "```lean",
    "example : False := by",
    "  rfl",
    "print(1)",
    "```",
    "```lean",
    "example : True := by rfl",
    "```",
    "",
  ].join("\n");
  const blocks = extractLeanBlocks(markdown);
  assert.deepEqual(blocks.map((block) => block.code), ["example : True := by rfl"]);
});

test("concatenates every lean block with a blank line between", () => {
  const markdown = "```lean\nexample : 2 = 2 := by\n  rfl\n```\n\ntext\n\n```lean4\nexample : 3 = 3 := by\n  rfl\n```\n";
  assert.equal(
    concatenateLeanBlocks(extractLeanBlocks(markdown)),
    "example : 2 = 2 := by\n  rfl\n\nexample : 3 = 3 := by\n  rfl",
  );
  assert.equal(concatenateLeanBlocks([]), "");
});

test("an unclosed fence keeps the rest of the source", () => {
  const blocks = extractLeanBlocks("```lean\nexample : 1 = 1 := by\n  rfl");
  assert.equal(blocks[0].code, "example : 1 = 1 := by\n  rfl");
});

test("the playground URL round-trips through lean4web's hash parser", () => {
  const code = concatenateLeanBlocks(extractLeanBlocks(SAMPLE));
  const built = buildLeanPlaygroundUrl(code);
  assert.equal(built.ok, true);
  assert.match(built.url, /^https:\/\/live\.lean-lang\.org\/#project=MathlibDemo&/);
  assert.equal(codeFromUrl(built.url), code);
  assert.equal(built.url.includes("=") && !built.url.endsWith("="), true);
});

test("parentheses, quotes, and percent signs survive the hash", () => {
  const code = "example : (1 + 1) = 2 := by\n  -- 50% \"α\"\n  rfl";
  const built = buildLeanPlaygroundUrl(code);
  assert.equal(built.ok, true);
  assert.equal(codeFromUrl(built.url), code);
  if (built.format === "code") assert.match(built.url, /%28/);
});

test("a long program prefers codez and a too-long URL is refused", () => {
  const code = Array.from({ length: 80 }, (_, i) => `theorem t${i} : ${i} = ${i} := by rfl`).join("\n");
  const built = buildLeanPlaygroundUrl(code);
  assert.equal(built.ok, true);
  assert.equal(built.format, "codez");
  assert.equal(codeFromUrl(built.url), code);
  const plain = buildLeanPlaygroundUrl(code, { maxLength: 10_000_000 });
  assert.ok(built.length < `https://live.lean-lang.org/#project=MathlibDemo&code=${encodeURIComponent(code)}`.length);
  assert.equal(plain.format, "codez");
  const refused = buildLeanPlaygroundUrl(code, { maxLength: 80 });
  assert.deepEqual(
    { ok: refused.ok, reason: refused.reason },
    { ok: false, reason: "too-long" },
  );
  assert.equal(refused.url, undefined);
});

test("the editor and the preview expose the document action, and buttons use font-scale", () => {
  const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
  const i18n = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(html, /id="run-all-lean-editor-btn"[^>]*hidden/);
  assert.match(html, /id="run-all-lean-btn"[^>]*class="secondary-btn preview-only"[^>]*hidden/);
  assert.match(html, /id="run-all-lean-btn"[^>]*data-i18n="lean\.runAll"/);
  assert.equal(i18n.split('"lean.runBlock"').length - 1, 3);
  assert.equal(i18n.includes('"lean.runBlock": "Lean에서 실행"'), true);
  assert.equal(i18n.includes('"lean.runAll": "문서의 Lean 모두 실행"'), true);
  assert.match(css, /\.markdown-body \.lean-run \{[^}]*font-size:\s*calc\(12px \* var\(--font-scale\)\)/);
  assert.match(css, /#run-all-lean-btn \{[^}]*font-size:\s*calc\(12px \* var\(--font-scale\)\)/);
  assert.match(app, /extractLeanBlocks\(/);
  assert.match(app, /decorateLeanBlocks\(/);
  assert.match(app, /buildLeanPlaygroundUrl\(/);
});

// Open Lean from a mark-vector document in the official web editor.
// Nothing is executed here: the browser only opens https://live.lean-lang.org
// with the source in the URL hash.
//
// live.lean-lang.org (lean4web) reads the hash as `#key=value&...`.
// `code=` is URI-encoded source. `codez=` is LZ-string compressToBase64
// with the trailing `=` padding removed, then URI-encoded the same way
// lean4web's formatArgs does (encodeURIComponent, plus `(` and `)`).
// `code` wins over `codez` when both are present, so a link carries only one.
// The shorter of the two is used. Long programs therefore go out as `codez`.
//
// `project=MathlibDemo` is the site's default project ("Latest Mathlib").
// Its lakefile requires mathlib, so `import Mathlib` works without the
// reader changing the project dropdown. Confirmed from
// https://live.lean-lang.org/api/projects (MathlibDemo, default: true).

import LZString from "./vendor/lz-string.mjs";

export const LEAN_PLAYGROUND_ORIGIN = "https://live.lean-lang.org/";
// Folder name of the default Mathlib project on live.lean-lang.org.
export const LEAN_PLAYGROUND_PROJECT = "MathlibDemo";
// Phone browsers start failing well before desktop URL limits. Past this,
// opening the tab would drop or reject the hash, so the caller warns instead.
export const LEAN_PLAYGROUND_URL_LIMIT = 32000;

const LEAN_LANGUAGE = /^(lean|lean4)$/i;
// asciimath-markdown opens a fence only at column 0, with exactly three
// backticks, a single word of info, and optional trailing whitespace, and
// closes it on a line that is exactly ```. Matching that keeps the bytes we
// send equal to the fence body in the source (indentation and characters
// included) and in the same order the preview renders `language-*` blocks.
const FENCE_OPEN = /^```(\w*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

function normalizeNewlines(markdown) {
  return String(markdown ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Lean fences in source order. Each `code` is the raw body between the
// fences, joined with `\n`, with no extra indent stripped and no HTML escape.
export function extractLeanBlocks(markdown) {
  const lines = normalizeNewlines(markdown).split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) {
      index += 1;
      continue;
    }
    const language = open[1].toLowerCase();
    const body = [];
    index += 1;
    while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1;
    if (!LEAN_LANGUAGE.test(language)) continue;
    blocks.push({
      language: language === "lean4" ? "lean4" : "lean",
      code: body.join("\n"),
    });
  }
  return blocks;
}

// One program, blocks in document order, a blank line between them.
export function concatenateLeanBlocks(blocks) {
  return (blocks || []).map((block) => (typeof block === "string" ? block : block.code)).join("\n\n");
}

// Same encoding lean4web writes into the hash (`fixedEncodeURIComponent`).
function fixedEncodeURIComponent(value) {
  return encodeURIComponent(value).replace(/[()]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
}

function playgroundUrl(hash) {
  return `${LEAN_PLAYGROUND_ORIGIN}${hash}`;
}

// `{ ok, url, format, length }` or `{ ok: false, reason: "too-long", length, limit }`.
export function buildLeanPlaygroundUrl(code, { maxLength = LEAN_PLAYGROUND_URL_LIMIT } = {}) {
  const source = String(code ?? "");
  const compressed = LZString.compressToBase64(source).replace(/=+$/g, "");
  const project = fixedEncodeURIComponent(LEAN_PLAYGROUND_PROJECT);
  const codezHash = `#project=${project}&codez=${fixedEncodeURIComponent(compressed)}`;
  const codeHash = `#project=${project}&code=${fixedEncodeURIComponent(source)}`;
  const candidates = [
    { format: "codez", url: playgroundUrl(codezHash) },
    { format: "code", url: playgroundUrl(codeHash) },
  ].sort((a, b) => a.url.length - b.url.length || (a.format === "codez" ? -1 : 1));
  const shortest = candidates[0];
  if (shortest.url.length > maxLength) {
    return { ok: false, reason: "too-long", length: shortest.url.length, limit: maxLength };
  }
  return { ok: true, url: shortest.url, format: shortest.format, length: shortest.url.length };
}

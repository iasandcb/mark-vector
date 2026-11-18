import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const css = fs.readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

function block(header) {
  const at = css.indexOf(header);
  assert.notEqual(at, -1, header);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`unclosed ${header}`);
}

const tablet = block("@media (min-width: 701px) and (max-width: 900px)");
const phone = block("@media (max-width: 700px), (pointer: coarse) and (max-width: 1000px) and (max-height: 500px) {\n  /* The tab bar");
const belowDesktop = block("@media (max-width: 900px), (pointer: coarse) and (max-width: 1000px) and (max-height: 500px)");

test("the 701–900px band lets the tree and the preview collapse", () => {
  assert.match(tablet, /\.layout\.tree-collapsed[\s\S]*?grid-template-columns:\s*0px 0px minmax\(0, 1fr\)/);
  assert.match(tablet, /\.layout\.preview-collapsed[\s\S]*?0px !important/);
  assert.match(tablet, /\.layout\.tree-collapsed\.preview-collapsed[\s\S]*?0px 0px minmax\(0, 1fr\) 0px 0px 0px 0px/);
  assert.doesNotMatch(tablet, /\.tree-pane\.collapsed/);
  assert.doesNotMatch(tablet, /display:\s*none/);
  assert.match(tablet, /#editor-pane\s*\{\s*grid-column:\s*3/);
  assert.match(tablet, /\.preview-pane\s*\{\s*grid-column:\s*7/);
});

test("collapse buttons stay on from 701px up and stay off on a phone", () => {
  assert.doesNotMatch(belowDesktop, /pane-collapse-btn/);
  assert.doesNotMatch(belowDesktop, /pane-expand-btn/);
  assert.match(phone, /\.pane-collapse-btn/);
  assert.match(phone, /\.pane-expand-btn/);
  assert.match(phone, /display:\s*none !important/);
});

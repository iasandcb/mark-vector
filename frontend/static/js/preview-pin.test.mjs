import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PREVIEW_PIN_STORAGE_KEY,
  normalizePreviewPin,
  previewContent,
  resolvePreviewSource,
} from "./preview-pin.mjs";

const open = { splitOpen: true, hasRight: true, leftText: "left unsaved", rightText: "right unsaved" };

test("anything other than left or right is auto", () => {
  assert.equal(normalizePreviewPin("auto"), "auto");
  assert.equal(normalizePreviewPin("left"), "left");
  assert.equal(normalizePreviewPin("right"), "right");
  assert.equal(normalizePreviewPin(null), "auto");
  assert.equal(normalizePreviewPin(""), "auto");
  assert.equal(normalizePreviewPin("LEFT"), "auto");
  assert.equal(normalizePreviewPin("both"), "auto");
});

test("the pin is stored under a stable localStorage key", () => {
  assert.equal(PREVIEW_PIN_STORAGE_KEY, "mark-vector:preview-pin");
});

test("auto follows the focused pane", () => {
  assert.deepEqual(previewContent({ ...open, pin: "auto", focused: "a", pair: false }), {
    source: "a",
    text: "left unsaved",
  });
  assert.deepEqual(previewContent({ ...open, pin: "auto", focused: "b", pair: false }), {
    source: "b",
    text: "right unsaved",
  });
});

test("auto keeps a conversation pair on the right document", () => {
  const paired = { ...open, pin: "auto", pair: true };
  assert.equal(resolvePreviewSource({ ...paired, focused: "a" }), "b");
  assert.equal(resolvePreviewSource({ ...paired, focused: "b" }), "b");
  assert.equal(previewContent({ ...paired, focused: "a" }).text, "right unsaved");
});

test("a left pin stays on the left buffer, including unsaved edits", () => {
  const pinned = { ...open, pin: "left", pair: true, focused: "b", leftText: "left plus more" };
  assert.deepEqual(previewContent(pinned), { source: "a", text: "left plus more" });
  assert.equal(previewContent({ ...pinned, rightText: "right was edited", focused: "a" }).text, "left plus more");
});

test("a right pin stays on the right buffer, including unsaved edits", () => {
  const pinned = { ...open, pin: "right", pair: false, focused: "a", rightText: "right plus more" };
  assert.deepEqual(previewContent(pinned), { source: "b", text: "right plus more" });
  assert.equal(previewContent({ ...pinned, leftText: "left was edited", focused: "b" }).text, "right plus more");
  assert.equal(previewContent({ ...pinned, pair: true, focused: "a" }).source, "b");
});

test("edits and focus in the other pane do not move a pin", () => {
  const steps = [
    { focused: "a", leftText: "L1", rightText: "R1" },
    { focused: "b", leftText: "L1", rightText: "R2" },
    { focused: "b", leftText: "L2", rightText: "R2" },
    { focused: "a", leftText: "L3", rightText: "R3" },
  ];
  for (const step of steps) {
    assert.equal(previewContent({ ...open, pin: "left", pair: true, ...step }).text, step.leftText);
    assert.equal(previewContent({ ...open, pin: "right", pair: false, ...step }).text, step.rightText);
  }
});

test("closing the split ignores the pin and shows the primary editor", () => {
  for (const pin of ["auto", "left", "right"]) {
    assert.deepEqual(
      previewContent({
        pin,
        splitOpen: false,
        focused: "b",
        pair: true,
        hasRight: true,
        leftText: "primary",
        rightText: "secondary",
      }),
      { source: "a", text: "primary" },
    );
  }
});

test("a right pin with no right document falls back to the primary editor", () => {
  assert.deepEqual(
    previewContent({
      pin: "right",
      splitOpen: true,
      focused: "b",
      pair: false,
      hasRight: false,
      leftText: "primary",
      rightText: "",
    }),
    { source: "a", text: "primary" },
  );
});

test("the editor page offers Auto, Left, and Right and routes through this module", () => {
  const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="preview-pin"[^>]*hidden/);
  assert.match(html, /data-pin="auto"/);
  assert.match(html, /data-pin="left"/);
  assert.match(html, /data-pin="right"/);
  assert.match(html, /id="publish-btn-b"/);
  assert.match(html, /id="export-x-article-btn-b"/);

  const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /previewContent\(/);
  assert.match(app, /PREVIEW_PIN_STORAGE_KEY/);
  assert.equal(app.includes('if (conversationPairOpen()) source = "b"'), false);
  assert.equal(app.includes('if (conversationPairOpen()) previewSource = "b"'), false);
});

test("pin labels exist in every UI language, including Korean", () => {
  const src = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
  for (const key of [
    "preview.pinTitle",
    "preview.pinAuto",
    "preview.pinLeft",
    "preview.pinRight",
    "preview.pinAutoTitle",
    "preview.pinLeftTitle",
    "preview.pinRightTitle",
  ]) {
    assert.equal(src.split(`"${key}"`).length - 1, 3, key);
  }
  assert.equal(src.includes('"preview.pinAuto": "자동"'), true);
  assert.equal(src.includes('"preview.pinLeft": "왼쪽"'), true);
  assert.equal(src.includes('"preview.pinRight": "오른쪽"'), true);
});

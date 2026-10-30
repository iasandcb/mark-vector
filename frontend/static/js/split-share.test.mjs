import test from "node:test";
import assert from "node:assert/strict";
import { conversationPair, paneShareState } from "./split-share.mjs";

const blockedRoles = new Set([
  "system",
  "project-system",
  "global-system",
  "global-custom-symbols",
  "global-spoken-math",
  "hermes-session",
]);

const left = {
  projectId: "p", sessionId: "s", filename: "notes.c.md", role: "draft", publishToken: "left-token",
};
const right = {
  projectId: "p", sessionId: "s", filename: "notes.md", role: "draft", publishToken: null,
};

function state(pane, extra = {}) {
  return paneShareState({
    pane, splitOpen: true, left, right, streaming: false, blockedRoles, ...extra,
  });
}

test("the split pair is a .c.md on the left and its .md sibling on the right", () => {
  assert.equal(conversationPair({ splitOpen: true, left, right }), true);
  assert.equal(conversationPair({ splitOpen: false, left, right }), false);
  assert.equal(conversationPair({ splitOpen: true, left, right: { ...right, filename: "other.md" } }), false);
  assert.equal(conversationPair({ splitOpen: true, left: { ...left, filename: "notes.md" }, right }), false);
  assert.equal(conversationPair({ splitOpen: true, left: { ...left, sessionId: "other" }, right }), false);
  assert.equal(conversationPair({ splitOpen: true, left, right: { ...right, filename: "notes.c.md" } }), false);
});

test("single pane keeps publish and X Article on the primary document only", () => {
  const primary = state("left", { splitOpen: false, right: null });
  const side = state("right", { splitOpen: false, right: null });
  assert.equal(primary.visible, true);
  assert.equal(primary.disabled, false);
  assert.equal(primary.target.filename, "notes.c.md");
  assert.equal(primary.target.publishToken, "left-token");
  assert.equal(primary.published, true);
  assert.equal(primary.labelKey, "editor.publishing");
  assert.equal(side.visible, false);
  assert.equal(side.target, null);
});

test("the right pane publishes and exports its own .md in the split pair", () => {
  const side = state("right", { right: { ...right, publishToken: "right-token" } });
  const primary = state("left", { right: { ...right, publishToken: "right-token" } });
  assert.equal(side.visible, true);
  assert.equal(side.disabled, false);
  assert.equal(side.published, true);
  assert.equal(side.labelKey, "editor.publishing");
  assert.deepEqual(side.target, {
    projectId: "p", sessionId: "s", filename: "notes.md", publishToken: "right-token",
  });
  assert.equal(primary.target.filename, "notes.c.md");
  assert.equal(primary.target.publishToken, "left-token");
  assert.notEqual(side.target.filename, primary.target.filename);
});

test("an unpublished right document stays actionable and unlabeled as published", () => {
  const side = state("right");
  assert.equal(side.visible, true);
  assert.equal(side.published, false);
  assert.equal(side.labelKey, "editor.publish");
  assert.equal(side.target.publishToken, null);
});

test("the right pane actions stay hidden unless this exact pair is open", () => {
  assert.equal(state("right", { splitOpen: false }).visible, false);
  assert.equal(state("right", { right: { ...right, filename: "draft.md" } }).visible, false);
  assert.equal(state("right", { left: { ...left, projectId: "other" } }).visible, false);
  assert.equal(state("right", { right: null }).visible, false);
  assert.equal(state("left", { splitOpen: false, right: null }).visible, true);
});

test("streaming disables both panes without moving the right pane onto the left document", () => {
  const side = state("right", { streaming: true, right: { ...right, publishToken: "right-token" } });
  const primary = state("left", { streaming: true });
  assert.equal(side.visible, true);
  assert.equal(side.disabled, true);
  assert.equal(side.target.filename, "notes.md");
  assert.equal(primary.visible, true);
  assert.equal(primary.disabled, true);
  assert.equal(primary.target.filename, "notes.c.md");
});

test("a non-sendable document does not gain publish or X Article in either pane", () => {
  assert.equal(state("right", { right: { ...right, role: "system" } }).visible, false);
  assert.equal(state("left", { left: { ...left, role: "hermes-session" } }).visible, false);
  assert.equal(state("right", { left: { ...left, role: "system" } }).visible, true);
  assert.equal(state("left", { left: null }).visible, false);
});

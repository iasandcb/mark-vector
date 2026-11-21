import assert from "node:assert/strict";
import test from "node:test";

import { cleanupDecision, deleteRequest, formatBytes, formatPercent, previewLines, usageWarning } from "./storage-model.mjs";

test("formatBytes uses binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatBytes(1024 * 1024), "1 MB");
  assert.equal(formatBytes(-1), "0 B");
});

test("formatPercent trims a trailing zero", () => {
  assert.equal(formatPercent(80), "80");
  assert.equal(formatPercent(83.82), "83.8");
  assert.equal(formatPercent(Number.NaN), "0");
});

test("the banner follows the API warning flag", () => {
  assert.equal(usageWarning({ percent_used: 90, warning: true }), true);
  assert.equal(usageWarning({ percent_used: 90, warning: false }), false);
  assert.equal(usageWarning(null), false);
});

test("a delete request sends only recording ids", () => {
  const recordings = [
    { project_id: "p", conv_id: "c", filename: "a.md", recording_id: "20261018-193012-ab12.webm", size: 9, path: "/data/secret" },
    { project_id: "p", conv_id: "c", filename: "b.md", recording_id: "20261019-090000-cd34.m4a", size: 4 },
  ];
  const body = deleteRequest(recordings, new Set([0]));
  assert.deepEqual(body.recordings, [
    { project_id: "p", conv_id: "c", filename: "a.md", recording_id: "20261018-193012-ab12.webm" },
  ]);
  assert.equal(JSON.stringify(body).includes("/data"), false);
  assert.deepEqual(deleteRequest(recordings, []), { recordings: [] });
});

test("cleanup runs only after an explicit confirm and a non-empty preview", () => {
  const preview = {
    originals: [{ recording_id: "20261018-193012-ab12.webm" }],
    play_copies: [{ name: "20261018-193012-ab12.webm.mono.m4a" }, { name: "other.mono.m4a" }],
    freed_bytes: 30,
  };
  assert.equal(cleanupDecision(preview, false).proceed, false);
  assert.equal(cleanupDecision(preview, true).proceed, true);
  assert.equal(cleanupDecision(preview, true).originals, 1);
  assert.equal(cleanupDecision(preview, true).plays, 2);
  assert.equal(cleanupDecision({ originals: [], play_copies: [], freed_bytes: 0 }, true).proceed, false);
});

test("preview lines name files without a filesystem path", () => {
  const lines = previewLines({
    originals: [{
      project_title: "강의", folder_title: "10월", filename: "note.md",
      recording_id: "20261018-193012-ab12.webm", size: 10, path: "/data/projects/x",
    }],
    play_copies: [{ filename: "note.md", name: "20261018-193012-ab12.webm.mono.m4a", size: 4 }],
  });
  assert.equal(lines[0].kind, "original");
  assert.match(lines[0].label, /강의/);
  assert.match(lines[0].label, /note\.md/);
  assert.equal(lines[1].kind, "play");
  assert.match(lines[1].label, /mono\.m4a/);
  assert.equal(JSON.stringify(lines).includes("/data"), false);
  assert.equal(JSON.stringify(lines).includes(".."), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MIME_TYPES,
  applyMismatch,
  createChunkQueue,
  describePending,
  describeStop,
  giveUpRetry,
  nextRetryDelay,
  pickMime,
  retryStoredRecording,
  sliceUnconfirmed,
} from "./recording-upload.mjs";

function blob(text) {
  return {
    size: text.length,
    text,
    slice(start, end = text.length) {
      return blob(text.slice(start, end));
    },
  };
}

function fakeApi() {
  const files = new Map();
  const calls = [];
  let n = 0;
  return {
    files,
    calls,
    async createRecording() {
      const id = `20261113-120000-ab0${n++}.m4a`;
      files.set(id, "");
      calls.push(["create", id]);
      return { id };
    },
    async appendRecording(_project, _session, _filename, id, offset, part) {
      const current = files.get(id);
      if (current == null) throw new Error("missing");
      calls.push(["append", id, offset, part.text]);
      if (offset > current.length) return { mismatch: current.length };
      if (offset + part.text.length <= current.length) return { size: current.length };
      const extra = part.text.slice(current.length - offset);
      const next = current + extra;
      files.set(id, next);
      return { size: next.length };
    },
    async setRecordingVideo(_project, _session, _filename, id, body) {
      calls.push(["enqueue", id, body.enqueue, body.duration_sec]);
      if (files.get(id) === "") throw new Error("Recording is empty");
      return { video: { status: "queued" } };
    },
  };
}

test("the failure notice is a full Korean sentence in every UI language", () => {
  const source = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
  for (const key of [
    "editor.recordingUploadFailed",
    "editor.recordingRetry",
    "editor.recordingDownload",
    "editor.recordingKeptMany",
  ]) {
    const found = source.split(`"${key}"`).length - 1;
    assert.equal(found, 3, key);
  }
  assert.match(source, /녹음이 서버에 닿지 않았습니다/);
  assert.match(source, /다시 시도/);
});

test("an Apple browser records mp4 and names it m4a, which the server accepts", () => {
  const supported = new Set(MIME_TYPES.map(([mime]) => mime));
  const picked = pickMime((mime) => supported.has(mime), "Apple Computer, Inc.");
  assert.equal(picked[0], "audio/mp4");
  assert.equal(picked[1], "m4a");
  assert.equal(pickMime((mime) => supported.has(mime), "Google Inc.")[1], "webm");
  assert.equal(pickMime(() => false, "Apple Computer, Inc."), null);
});

test("a failed upload is not described as saved, and it keeps a local copy", () => {
  const notice = describeStop({
    queued: false,
    videoError: null,
    uploadError: "Failed to fetch",
    bytes: 1200,
  });
  assert.equal(notice.noticeKey, "editor.recordingUploadFailed");
  assert.notEqual(notice.noticeKey, "editor.recordingSaved");
  assert.equal(notice.retry, true);
  assert.equal(notice.download, true);
  assert.equal(notice.keepLocal, true);
  assert.equal(notice.sticky, true);
  assert.equal(notice.error, "Failed to fetch");
});

test("a confirmed YouTube job drops the local copy", () => {
  const notice = describeStop({ queued: true, videoError: null, uploadError: null, bytes: 1200 });
  assert.equal(notice.noticeKey, "editor.recordingQueued");
  assert.equal(notice.keepLocal, false);
  assert.equal(notice.retry, false);
});

test("an upload that landed but was not queued stays retryable", () => {
  const notice = describeStop({
    queued: false,
    videoError: "Recording is empty",
    uploadError: null,
    bytes: 80,
  });
  assert.equal(notice.noticeKey, "editor.recordingVideoQueueFailed");
  assert.equal(notice.retry, true);
  assert.equal(notice.keepLocal, true);
  assert.equal(notice.error, "Recording is empty");
});

test("an empty stop is not reported as saved on the server", () => {
  const notice = describeStop({ queued: false, videoError: null, uploadError: null, bytes: 0 });
  assert.equal(notice.noticeKey, "editor.recordingEmpty");
  assert.equal(notice.keepLocal, false);
  assert.equal(notice.retry, false);
});

test("several leftovers share one notice and still offer retry and download", () => {
  const notice = describePending(2, "Failed to fetch");
  assert.equal(notice.noticeKey, "editor.recordingKeptMany");
  assert.equal(notice.count, 2);
  assert.equal(notice.retry, true);
  assert.equal(notice.download, true);
});

test("retries continue while recording and give up only after stop", () => {
  assert.equal(giveUpRetry({ stopped: false, retryDelay: 15000 }), false);
  assert.equal(giveUpRetry({ stopped: true, retryDelay: 8000 }), false);
  assert.equal(giveUpRetry({ stopped: true, retryDelay: 15000 }), true);
  assert.equal(nextRetryDelay(8000), 15000);
  assert.equal(nextRetryDelay(15000), 15000);
});

test("a mismatch skips bytes the server already has and rejects a shortfall", () => {
  assert.deepEqual(applyMismatch(0, 2, 5), { ok: true, skip: 2, offset: 2 });
  assert.equal(applyMismatch(4, 1, 5).ok, false);
  assert.equal(applyMismatch(0, 5, 5).ok, false);
  assert.equal(applyMismatch(2, 2, 5).ok, false);
});

test("after stop, a failing upload gives up and reports the error", async () => {
  let calls = 0;
  const queue = createChunkQueue({
    append: async () => {
      calls += 1;
      throw new Error("Failed to fetch");
    },
    sleep: async () => {},
    retryMin: 4,
    retryMax: 4,
  });
  queue.push(blob("abc"));
  const result = await queue.stop();
  assert.equal(result.uploaded, false);
  assert.equal(result.uploadError, "Failed to fetch");
  assert.equal(result.pendingBytes, 3);
  assert.equal(calls, 1);
  const notice = describeStop({
    queued: false,
    videoError: null,
    uploadError: result.uploadError,
    bytes: result.offset + result.pendingBytes,
  });
  assert.equal(notice.noticeKey, "editor.recordingUploadFailed");
  assert.equal(notice.retry, true);
});

test("a later piece failing after a success keeps the confirmed offset", async () => {
  const queue = createChunkQueue({
    append: async (offset, part) => {
      if (offset > 0) throw new Error("network down");
      return { size: offset + part.size };
    },
    sleep: async () => {},
    retryMin: 8,
    retryMax: 8,
  });
  queue.push(blob("abcd"));
  queue.push(blob("ef"));
  const result = await queue.stop();
  assert.equal(result.uploaded, false);
  assert.equal(result.offset, 4);
  assert.equal(result.pendingBytes, 2);
  assert.equal(result.uploadError, "network down");
});

test("a lost reply is picked up from the server's length", async () => {
  const seen = [];
  const queue = createChunkQueue({
    append: async (offset, part) => {
      seen.push([offset, part.text]);
      if (offset === 0) return { mismatch: 2 };
      return { size: offset + part.size };
    },
    sleep: async () => {},
  });
  queue.push(blob("abcdef"));
  const result = await queue.stop();
  assert.equal(result.uploaded, true);
  assert.equal(result.offset, 6);
  assert.deepEqual(seen, [
    [0, "abcdef"],
    [2, "cdef"],
  ]);
});

test("retry sends the missing tail and then asks for the YouTube queue", async () => {
  const api = fakeApi();
  const created = await api.createRecording();
  await api.appendRecording("p", "s", "notes.md", created.id, 0, blob("hello"));
  const record = {
    projectId: "p",
    sessionId: "s",
    filename: "notes.md",
    ext: "m4a",
    started: "2026-11-13T12:00:00",
    serverId: created.id,
    confirmed: 5,
    durationSec: 3,
  };
  const result = await retryStoredRecording(record, [blob("hello"), blob("!")], api);
  assert.equal(result.queued, true);
  assert.equal(api.files.get(created.id), "hello!");
  assert.deepEqual(api.calls.at(-1), ["enqueue", created.id, true, 3]);
  const appended = api.calls.filter((call) => call[0] === "append").map((call) => call[3]);
  assert.deepEqual(appended, ["hello", "!"]);
});

test("retry creates the server file when the first request never landed", async () => {
  const api = fakeApi();
  const record = {
    projectId: "p",
    sessionId: "s",
    filename: "lecture.md",
    ext: "m4a",
    started: "2026-11-13T09:00:00",
    serverId: null,
    confirmed: 0,
    durationSec: 12,
  };
  const result = await retryStoredRecording(record, [blob("audio")], api);
  assert.equal(result.queued, true);
  assert.equal(api.files.get(result.serverId), "audio");
  assert.equal(api.calls[0][0], "create");
  assert.equal(api.calls.at(-1)[0], "enqueue");
});

test("retry does not append audio the server already has", async () => {
  const api = fakeApi();
  const created = await api.createRecording();
  api.files.set(created.id, "hello!");
  const callsBefore = api.calls.length;
  const record = {
    projectId: "p",
    sessionId: "s",
    filename: "notes.md",
    ext: "m4a",
    started: "2026-11-13T12:00:00",
    serverId: created.id,
    confirmed: 0,
    durationSec: 3,
  };
  const result = await retryStoredRecording(record, [blob("hello"), blob("!")], api);
  assert.equal(result.queued, true);
  assert.equal(api.files.get(created.id), "hello!");
  const appended = api.calls.slice(callsBefore).filter((call) => call[0] === "append");
  assert.equal(appended.length, 1);
  assert.equal(appended[0][3], "hello");
});

test("the unconfirmed slice drops bytes the server already accepted", () => {
  const pending = sliceUnconfirmed([blob("abcd"), blob("efgh")], 6);
  assert.deepEqual(pending.map((part) => part.text), ["gh"]);
  assert.deepEqual(sliceUnconfirmed([blob("ab")], 2), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_STORE,
  RECORDING_STORE,
  createMemoryRecordingStore,
  installRecordingStores,
} from "./recording-store.mjs";
import { describeStop, retryStoredRecording } from "./recording-upload.mjs";

function blob(text) {
  return {
    size: text.length,
    text,
    slice(start, end = text.length) {
      return blob(text.slice(start, end));
    },
  };
}

test("a recording stays until the server confirms the job, then it is dropped", async () => {
  const store = createMemoryRecordingStore();
  const record = {
    localId: "local-1",
    projectId: "p",
    sessionId: "s",
    filename: "lecture.md",
    ext: "m4a",
    mime: "audio/mp4",
    started: "2026-11-13T09:15:00",
    startedAt: 1,
    serverId: null,
    confirmed: 0,
    error: "Failed to fetch",
    durationSec: 4,
  };
  await store.put(record);
  await store.appendChunk(record.localId, blob("one"));
  await store.appendChunk(record.localId, blob("two"));

  const kept = await store.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].error, "Failed to fetch");
  assert.deepEqual((await store.chunks(record.localId)).map((part) => part.text), ["one", "two"]);

  const notice = describeStop({ queued: false, videoError: null, uploadError: record.error, bytes: 6 });
  assert.equal(notice.keepLocal, true);

  const api = {
    files: new Map(),
    async createRecording() {
      const id = "20261113-091500-abcd.m4a";
      this.files.set(id, "");
      return { id };
    },
    async appendRecording(_p, _s, _f, id, offset, part) {
      const current = this.files.get(id);
      const next = current.slice(0, offset) + part.text;
      this.files.set(id, next);
      return { size: next.length };
    },
    async setRecordingVideo() {
      return { video: { status: "queued" } };
    },
  };
  const result = await retryStoredRecording(await store.get(record.localId), await store.chunks(record.localId), api);
  assert.equal(result.queued, true);
  assert.equal(api.files.get(result.serverId), "onetwo");
  const confirmed = describeStop({ queued: true, videoError: null, uploadError: null, bytes: 6 });
  assert.equal(confirmed.keepLocal, false);
  await store.forget(record.localId);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.chunks(record.localId), []);
});

test("forgetting one recording leaves another", async () => {
  const store = createMemoryRecordingStore();
  await store.put({ localId: "a", filename: "a.md", startedAt: 1 });
  await store.put({ localId: "b", filename: "b.md", startedAt: 2 });
  await store.appendChunk("a", blob("a"));
  await store.appendChunk("b", blob("b"));
  await store.patch("b", { error: "network" });
  assert.equal((await store.get("b")).error, "network");
  await store.forget("a");
  assert.equal((await store.list()).map((record) => record.localId).join(), "b");
  assert.equal((await store.chunks("b"))[0].text, "b");
  assert.equal(await store.get("missing"), null);
  assert.equal(await store.patch("missing", { error: "x" }), null);
});

test("IndexedDB install creates the recording and the chunk stores", () => {
  const names = new Set();
  const created = [];
  const db = {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore(name, options) {
      names.add(name);
      const indexes = [];
      const store = {
        name,
        options,
        indexes,
        createIndex(indexName, key) {
          indexes.push({ indexName, key });
        },
      };
      created.push(store);
      return store;
    },
  };
  installRecordingStores(db);
  installRecordingStores(db);
  assert.deepEqual(created.map((store) => store.name), [RECORDING_STORE, CHUNK_STORE]);
  assert.equal(created[0].options.keyPath, "localId");
  assert.equal(created[1].options.autoIncrement, true);
  assert.deepEqual(created[1].indexes, [{ indexName: "byRecording", key: "localId" }]);
});

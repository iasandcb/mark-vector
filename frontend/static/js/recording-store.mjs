// A dictation recording stays in IndexedDB until the server confirms the
// YouTube job. The tab can be killed (iOS does that when the page is
// hidden) without taking the audio with it. The next load offers a retry
// and a download. Tests use the memory store; the browser uses IndexedDB
// and falls back to memory if the browser refuses it (private mode).

export const RECORDING_DB = "mark-vector";
export const RECORDING_STORE = "pending-recordings";
export const CHUNK_STORE = "pending-recording-chunks";

export function installRecordingStores(db) {
  if (!db.objectStoreNames.contains(RECORDING_STORE)) {
    db.createObjectStore(RECORDING_STORE, { keyPath: "localId" });
  }
  if (!db.objectStoreNames.contains(CHUNK_STORE)) {
    const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: "id", autoIncrement: true });
    chunks.createIndex("byRecording", "localId");
  }
}

export function createMemoryRecordingStore() {
  const records = new Map();
  const chunks = new Map();
  return {
    kind: "memory",
    async put(record) {
      records.set(record.localId, { ...record });
    },
    async patch(localId, fields) {
      const current = records.get(localId);
      if (!current) return null;
      const next = { ...current, ...fields };
      records.set(localId, next);
      return next;
    },
    async get(localId) {
      const current = records.get(localId);
      return current ? { ...current } : null;
    },
    async list() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async appendChunk(localId, blob) {
      const list = chunks.get(localId) || [];
      list.push(blob);
      chunks.set(localId, list);
      return list.length;
    },
    async chunks(localId) {
      return (chunks.get(localId) || []).slice();
    },
    async forget(localId) {
      records.delete(localId);
      chunks.delete(localId);
    },
  };
}

function requestOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

export function wrapRecordingDatabase(db) {
  return {
    kind: "indexeddb",
    async put(record) {
      const tx = db.transaction(RECORDING_STORE, "readwrite");
      tx.objectStore(RECORDING_STORE).put(record);
      await transactionDone(tx);
    },
    async patch(localId, fields) {
      const tx = db.transaction(RECORDING_STORE, "readwrite");
      const store = tx.objectStore(RECORDING_STORE);
      const next = await new Promise((resolve, reject) => {
        const get = store.get(localId);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          if (!get.result) {
            resolve(null);
            return;
          }
          const value = { ...get.result, ...fields };
          const put = store.put(value);
          put.onerror = () => reject(put.error);
          put.onsuccess = () => resolve(value);
        };
      });
      await transactionDone(tx);
      return next;
    },
    async get(localId) {
      const tx = db.transaction(RECORDING_STORE, "readonly");
      const record = await requestOf(tx.objectStore(RECORDING_STORE).get(localId));
      await transactionDone(tx);
      return record || null;
    },
    async list() {
      const tx = db.transaction(RECORDING_STORE, "readonly");
      const records = await requestOf(tx.objectStore(RECORDING_STORE).getAll());
      await transactionDone(tx);
      return records || [];
    },
    async appendChunk(localId, blob) {
      const tx = db.transaction(CHUNK_STORE, "readwrite");
      tx.objectStore(CHUNK_STORE).add({ localId, blob });
      await transactionDone(tx);
    },
    async chunks(localId) {
      const tx = db.transaction(CHUNK_STORE, "readonly");
      const rows = await requestOf(tx.objectStore(CHUNK_STORE).index("byRecording").getAll(localId));
      await transactionDone(tx);
      return (rows || []).sort((a, b) => a.id - b.id).map((row) => row.blob);
    },
    async forget(localId) {
      const tx = db.transaction([RECORDING_STORE, CHUNK_STORE], "readwrite");
      tx.objectStore(RECORDING_STORE).delete(localId);
      const index = tx.objectStore(CHUNK_STORE).index("byRecording");
      const keys = await new Promise((resolve, reject) => {
        const get = index.getAllKeys(localId);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result || []);
      });
      for (const key of keys) tx.objectStore(CHUNK_STORE).delete(key);
      await transactionDone(tx);
    },
  };
}

export function openIndexedDbRecordingStore(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!idb) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    let request;
    try {
      request = idb.open(RECORDING_DB, 1);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => installRecordingStores(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(wrapRecordingDatabase(request.result));
  });
}

export async function openRecordingStore(idb = globalThis.indexedDB) {
  if (!idb) return createMemoryRecordingStore();
  try {
    return await openIndexedDbRecordingStore(idb);
  } catch {
    return createMemoryRecordingStore();
  }
}

let shared = null;

export function sharedRecordingStore() {
  if (!shared) {
    shared = openRecordingStore().catch(() => createMemoryRecordingStore());
  }
  return shared;
}

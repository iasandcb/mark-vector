// What happens to a dictation recording after MediaRecorder stops.
// The bytes are uploaded a few seconds at a time, then the finished file
// is opted into the YouTube queue. Until that opt-in succeeds the bytes
// stay on the device (see recording-store.mjs). A stop whose upload never
// landed used to be reported as "saved" — the queue flag was simply false
// and the upload error was dropped.

export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 15000;
// The server refuses a piece over 8MB. Stay under that, including an iOS
// recording that holds the whole file until stop and then hands it over
// as one blob.
export const MAX_PUT_BYTES = 4 * 1024 * 1024;

// [mime, extension, bits per second]. Opus at 64 kbps is close to
// transparent for one voice; iOS's AAC needs more for the same.
export const MIME_TYPES = [
  ["audio/webm;codecs=opus", "webm", 64000],
  ["audio/webm", "webm", 64000],
  ["audio/mp4", "m4a", 96000],
  ["audio/ogg;codecs=opus", "ogg", 64000],
];

// Apple's browsers (every iOS browser is one) record WebM now too, but
// Safari won't play it back, so MP4 is preferred there. The extension is
// m4a, which the recordings API accepts.
export function mimeTypesForVendor(vendor) {
  const apple = /Apple/.test(vendor || "");
  return apple
    ? [...MIME_TYPES].sort(([a], [b]) => (b === "audio/mp4") - (a === "audio/mp4"))
    : MIME_TYPES.slice();
}

export function pickMime(isTypeSupported, vendor) {
  return mimeTypesForVendor(vendor).find(([mime]) => isTypeSupported(mime)) || null;
}

export function localStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function newLocalId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function nextRetryDelay(delay, retryMax = RETRY_MAX_MS) {
  return Math.min(delay * 2, retryMax);
}

// A retry keeps going while the page is still recording. After stop, the
// wait tops out and the bytes are left on the device instead of pretending
// the upload finished.
export function giveUpRetry({ stopped, retryDelay, retryMax = RETRY_MAX_MS }) {
  return !!stopped && retryDelay >= retryMax;
}

// The server has a different amount than we think — an upload landed but
// its reply was lost. Bytes already there are skipped; a shortfall can't
// be filled from this piece.
export function applyMismatch(offset, have, chunkSize) {
  const skip = have - offset;
  if (!Number.isFinite(have) || skip <= 0 || skip >= chunkSize) {
    return { ok: false, error: "recording out of step" };
  }
  return { ok: true, skip, offset: have };
}

// `queued` is only true once the server has accepted the YouTube job.
// Anything short of that keeps the local copy and offers a retry.
export function describeStop({ queued, videoError, uploadError, bytes }) {
  if (queued) {
    return {
      noticeKey: "editor.recordingQueued",
      error: null,
      retry: false,
      download: false,
      keepLocal: false,
      sticky: false,
      count: 1,
    };
  }
  if (videoError) {
    return {
      noticeKey: "editor.recordingVideoQueueFailed",
      error: videoError,
      retry: true,
      download: bytes > 0,
      keepLocal: true,
      sticky: true,
      count: 1,
    };
  }
  if (bytes > 0) {
    return {
      noticeKey: "editor.recordingUploadFailed",
      error: uploadError || "upload did not finish",
      retry: true,
      download: true,
      keepLocal: true,
      sticky: true,
      count: 1,
    };
  }
  return {
    noticeKey: "editor.recordingEmpty",
    error: null,
    retry: false,
    download: false,
    keepLocal: false,
    sticky: true,
    count: 1,
  };
}

export function describePending(count, error) {
  const notice = describeStop({
    queued: false,
    videoError: null,
    uploadError: error || "upload did not finish",
    bytes: 1,
  });
  if (count > 1) return { ...notice, noticeKey: "editor.recordingKeptMany", count };
  return { ...notice, count: 1 };
}

// Pieces the server does not have yet, in order. `confirmed` is a byte
// offset into the concatenation of `chunks`.
export function sliceUnconfirmed(chunks, confirmed) {
  let skip = confirmed > 0 ? confirmed : 0;
  const pending = [];
  for (const chunk of chunks) {
    if (!chunk || !chunk.size) continue;
    if (skip >= chunk.size) {
      skip -= chunk.size;
      continue;
    }
    pending.push(skip ? chunk.slice(skip) : chunk);
    skip = 0;
  }
  return pending;
}

// Walks the local pieces from `confirmed`, uploading only what the server
// does not already have. A reply that says the server is further ahead
// skips that many local bytes instead of appending them again.
export async function uploadChunks(chunks, confirmed, append, serverId) {
  const parts = [];
  for (const chunk of chunks) {
    if (chunk && chunk.size) parts.push(chunk);
  }
  let index = 0;
  let into = 0;
  let skip = confirmed > 0 ? confirmed : 0;
  while (index < parts.length && skip > 0) {
    const available = parts[index].size - into;
    if (skip >= available) {
      skip -= available;
      index += 1;
      into = 0;
    } else {
      into += skip;
      skip = 0;
    }
  }
  let serverAt = confirmed > 0 ? confirmed : 0;
  let guard = 0;
  while (index < parts.length) {
    if (++guard > 100000) throw new Error("recording out of step");
    const blob = parts[index];
    const rest = into ? blob.slice(into) : blob;
    const part = rest.size > MAX_PUT_BYTES ? rest.slice(0, MAX_PUT_BYTES) : rest;
    const result = await append(serverId, serverAt, part);
    if (result && result.mismatch !== undefined) {
      const decision = applyMismatch(serverAt, result.mismatch, part.size);
      if (!decision.ok) throw new Error(decision.error);
      serverAt = decision.offset;
      let consume = decision.skip;
      while (consume > 0 && index < parts.length) {
        const available = parts[index].size - into;
        if (consume >= available) {
          consume -= available;
          index += 1;
          into = 0;
        } else {
          into += consume;
          consume = 0;
        }
      }
      continue;
    }
    const accepted = result && result.size != null ? result.size - serverAt : part.size;
    if (!(accepted > 0)) throw new Error("recording out of step");
    serverAt += accepted;
    let consume = accepted;
    while (consume > 0 && index < parts.length) {
      const available = parts[index].size - into;
      if (consume >= available) {
        consume -= available;
        index += 1;
        into = 0;
      } else {
        into += consume;
        consume = 0;
      }
    }
  }
  return serverAt;
}

// Send whatever the server is missing, then opt into the YouTube queue.
// A piece the server already has is a no-op on the server (same offset).
export async function retryStoredRecording(record, chunks, api) {
  let serverId = record.serverId || null;
  let offset = serverId ? record.confirmed || 0 : 0;
  if (!serverId) {
    const created = await api.createRecording(
      record.projectId,
      record.sessionId,
      record.filename,
      record.ext,
      record.started,
    );
    serverId = created.id;
    offset = 0;
  }
  offset = await uploadChunks(
    chunks,
    offset,
    (id, at, part) => api.appendRecording(record.projectId, record.sessionId, record.filename, id, at, part),
    serverId,
  );
  await api.setRecordingVideo(record.projectId, record.sessionId, record.filename, serverId, {
    enqueue: true,
    duration_sec: record.durationSec ?? null,
  });
  return { serverId, offset, queued: true };
}

// Ordered upload of pieces as they arrive. `append(offset, blob)` resolves
// to `{size}` or `{mismatch}`. Failures retry with a growing wait. After
// `stop()`, a wait that has reached the cap gives up and reports the error
// instead of resolving as a success.
export function createChunkQueue({
  append,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryMin = RETRY_MIN_MS,
  retryMax = RETRY_MAX_MS,
  onChange = () => {},
}) {
  const queue = [];
  let offset = 0;
  let uploading = false;
  let error = null;
  let retryDelay = retryMin;
  let stopped = false;
  let settled = false;
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const pendingBytes = () => queue.reduce((sum, blob) => sum + blob.size, 0);

  function snapshot() {
    return { pending: pendingBytes(), error, offset, stopped };
  }

  function report() {
    onChange(snapshot());
  }

  function settle() {
    if (settled || !stopped || uploading) return;
    const pending = pendingBytes();
    if (pending > 0 && !giveUpRetry({ stopped, retryDelay, retryMax })) return;
    settled = true;
    finish({
      uploaded: pending === 0 && offset > 0,
      offset,
      uploadError: pending === 0 ? null : error,
      pendingBytes: pending,
    });
  }

  async function pump() {
    if (uploading || settled) return;
    uploading = true;
    while (queue.length && !settled) {
      const blob = queue[0];
      const part = blob.size > MAX_PUT_BYTES ? blob.slice(0, MAX_PUT_BYTES) : blob;
      try {
        const result = await append(offset, part);
        if (result && result.mismatch !== undefined) {
          const decision = applyMismatch(offset, result.mismatch, blob.size);
          if (!decision.ok) throw new Error(decision.error);
          queue[0] = blob.slice(decision.skip);
          offset = decision.offset;
          continue;
        }
        const accepted = result && result.size != null ? result.size - offset : part.size;
        if (!(accepted > 0)) throw new Error("recording out of step");
        offset += accepted;
        // A reply can jump past this piece when the bytes were already
        // there (the previous response was lost). Skip that far in the
        // queue instead of appending the same audio again.
        let consume = accepted;
        while (queue.length && consume > 0) {
          if (consume >= queue[0].size) {
            consume -= queue[0].size;
            queue.shift();
          } else {
            queue[0] = queue[0].slice(consume);
            consume = 0;
          }
        }
        error = null;
        retryDelay = retryMin;
      } catch (err) {
        error = (err && err.message) || "upload failed";
        report();
        if (giveUpRetry({ stopped, retryDelay, retryMax })) break;
        await sleep(retryDelay);
        retryDelay = nextRetryDelay(retryDelay, retryMax);
      }
    }
    uploading = false;
    report();
    settle();
  }

  return {
    push(blob) {
      if (!blob || !blob.size || settled) return;
      queue.push(blob);
      pump();
    },
    stop() {
      stopped = true;
      if (!uploading) pump();
      return done;
    },
    snapshot,
    pending: pendingBytes,
    error: () => error,
    offset: () => offset,
  };
}

// Records the dictation microphone into the document's folder on the
// server, a few seconds at a time (see storage.append_recording) - so a tab
// that dies mid-lecture loses only its last few seconds that had not been
// flushed yet. Those pieces are also written to IndexedDB (see
// recording-store.mjs) and stay there until the server confirms the
// YouTube job. On iOS a web page and a recording app can't share the
// microphone, so this stands in for Voice Memos while dictating; and like
// everything in a web page it only runs while the page is on screen (see
// the wake lock in app.js).
//
// MediaRecorder's pieces, joined in order, are one playable file (WebM, or
// fragmented MP4 on iOS), so each is just appended as it comes. iOS often
// holds an MP4 until stop instead of honouring the 3s slice; hiding the
// page asks for a flush first, because iOS then takes the microphone and
// may freeze the tab. Uploads go one at a time, in order; a failed one is
// retried with growing waits while later pieces queue up behind it.

import * as api from "./api.js";
import {
  createChunkQueue,
  describeStop,
  localStamp,
  newLocalId,
  pickMime,
} from "./recording-upload.mjs";
import { sharedRecordingStore } from "./recording-store.mjs";

const SLICE_MS = 3000;
// The microphone as it is, for recording: the browser's call processing
// (echo cancelling, noise suppression, gain riding) is tuned for a video
// call and leaves a recording muffled and pumping - and on iOS turning it
// off also gets the full-band microphone instead of the phone-call one.
export const RECORDING_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

let activeLocalId = null;

export function currentRecordingId() {
  return activeLocalId;
}

export function recordingSupported() {
  return !!window.MediaRecorder && !!pickMime((mime) => MediaRecorder.isTypeSupported(mime), navigator.vendor || "");
}

function quiet(promise) {
  return promise.catch(() => {});
}

// `doc` is {projectId, sessionId, filename}. `onChange({ elapsedMs,
// pending, error })` reports progress: pending is bytes not yet on the
// server. Resolves to { stop() }. stop() ends the recording and resolves
// once the upload has been confirmed, given up, or left on the device.
// A create request that fails does not throw: the microphone still records
// into IndexedDB, and the error is reported so the page can offer a retry.
export async function startRecording(stream, doc, onChange = () => {}, deps = {}) {
  const apiClient = deps.api || api;
  const store = deps.store || (await sharedRecordingStore());
  const picked = pickMime(
    (mime) => window.MediaRecorder && MediaRecorder.isTypeSupported(mime),
    navigator.vendor || "",
  );
  if (!picked) throw new Error("This browser has no supported recording format");
  const [mimeType, ext, bitsPerSecond] = picked;
  const startedAt = new Date();
  const started = localStamp(startedAt);
  const localId = newLocalId();
  activeLocalId = localId;
  const box = { serverId: null };
  let persist = Promise.resolve();

  await quiet(store.put({
    localId,
    projectId: doc.projectId,
    sessionId: doc.sessionId,
    filename: doc.filename,
    ext,
    mime: mimeType,
    started,
    startedAt: startedAt.getTime(),
    serverId: null,
    confirmed: 0,
    error: null,
    durationSec: null,
  }));

  async function ensureServer() {
    if (box.serverId) return box.serverId;
    const created = await apiClient.createRecording(doc.projectId, doc.sessionId, doc.filename, ext, started);
    box.serverId = created.id;
    await quiet(store.patch(localId, { serverId: created.id, error: null }));
    return created.id;
  }

  let createError = null;
  try {
    await ensureServer();
  } catch (err) {
    createError = err.message || "upload failed";
    await quiet(store.patch(localId, { error: createError }));
  }

  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: bitsPerSecond });
  } catch (err) {
    if (activeLocalId === localId) activeLocalId = null;
    await quiet(store.forget(localId));
    throw err;
  }

  const queue = createChunkQueue({
    append: async (offset, blob) => {
      const id = await ensureServer();
      const result = await apiClient.appendRecording(doc.projectId, doc.sessionId, doc.filename, id, offset, blob);
      if (result && result.mismatch === undefined && result.size != null) {
        await quiet(store.patch(localId, { confirmed: result.size, serverId: id, error: null }));
      }
      return result;
    },
    sleep: deps.sleep,
    onChange: (progress) => onChange({
      elapsedMs: Date.now() - startedAt.getTime(),
      ...progress,
      error: progress.error || (box.serverId ? null : createError),
    }),
  });

  const flush = () => {
    if (recorder.state === "recording") {
      try {
        recorder.requestData();
      } catch {
        // already stopping
      }
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  const unhook = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", flush);
  };

  const copies = [];
  // dataavailable runs before the stop event, including the piece flushed
  // by stop() or by requestData() when the page hides. The queue must not
  // be told to finish before that piece is pushed: stop() schedules the
  // events, it does not deliver them inline on every browser.
  const recorderDone = new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || !event.data.size) return;
    const blob = event.data;
    copies.push(blob);
    queue.push(blob);
    persist = persist.then(() => store.appendChunk(localId, blob)).catch(() => {});
  });
  recorder.addEventListener("stop", () => {
    queue.stop();
  });
  // The microphone going away (iOS takes it back when the page is hidden)
  // ends the recording the same way. stop() flushes the last piece first.
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop();
    });
  });

  try {
    recorder.start(SLICE_MS);
  } catch (err) {
    unhook();
    if (activeLocalId === localId) activeLocalId = null;
    await quiet(store.forget(localId));
    throw err;
  }
  const snapshot = () => ({
    elapsedMs: Date.now() - startedAt.getTime(),
    pending: queue.pending(),
    offset: queue.offset(),
    error: queue.error() || (box.serverId ? null : createError),
  });
  onChange(snapshot());

  let stopping = null;
  function finish() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (recorder.state !== "inactive") recorder.stop();
      await recorderDone;
      const uploaded = await queue.stop();
      unhook();
      if (activeLocalId === localId) activeLocalId = null;
      await persist;
      const bytes = uploaded.offset + uploaded.pendingBytes;
      const durationSec = (Date.now() - startedAt.getTime()) / 1000;
      let queued = false;
      let videoError = null;
      if (uploaded.uploaded && box.serverId) {
        try {
          await apiClient.setRecordingVideo(doc.projectId, doc.sessionId, doc.filename, box.serverId, {
            enqueue: true,
            duration_sec: durationSec,
          });
          queued = true;
        } catch (err) {
          videoError = err.message || "enqueue failed";
        }
      }
      const notice = describeStop({
        queued,
        videoError,
        uploadError: uploaded.uploadError,
        bytes,
      });
      if (notice.keepLocal) {
        const saved = await store.chunks(localId).catch(() => []);
        const savedBytes = saved.reduce((sum, blob) => sum + (blob && blob.size ? blob.size : 0), 0);
        const copyBytes = copies.reduce((sum, blob) => sum + blob.size, 0);
        if (savedBytes !== copyBytes) {
          await quiet(store.forget(localId));
          await quiet(store.put({
            localId,
            projectId: doc.projectId,
            sessionId: doc.sessionId,
            filename: doc.filename,
            ext,
            mime: mimeType,
            started,
            startedAt: startedAt.getTime(),
            serverId: box.serverId,
            confirmed: uploaded.offset,
            error: notice.error,
            durationSec,
          }));
          for (const blob of copies) await quiet(store.appendChunk(localId, blob));
        }
        await quiet(store.patch(localId, {
          serverId: box.serverId,
          confirmed: uploaded.offset,
          error: notice.error,
          durationSec,
        }));
      } else {
        await quiet(store.forget(localId));
      }
      return {
        ...notice,
        queued,
        videoError,
        uploadError: uploaded.uploadError,
        localId,
        bytes,
        filename: doc.filename,
        projectId: doc.projectId,
        sessionId: doc.sessionId,
      };
    })();
    return stopping;
  }

  return {
    id: box.serverId,
    localId,
    snapshot,
    stop: finish,
  };
}

// Records the dictation microphone into the document's folder on the
// server, a few seconds at a time (see storage.append_recording) - so a tab
// that dies mid-lecture loses only its last few seconds. On iOS a web page
// and a recording app can't share the microphone, so this stands in for
// Voice Memos while dictating; and like everything in a web page it only
// runs while the page is on screen (see the wake lock in app.js).
//
// MediaRecorder's pieces, joined in order, are one playable file (WebM, or
// fragmented MP4 on iOS), so each is just appended as it comes. Uploads go
// one at a time, in order; a failed one is retried with growing waits while
// later pieces queue up behind it.

import * as api from "./api.js";

const SLICE_MS = 3000;
const BITS_PER_SECOND = 32000; // speech grade, ~14 MB an hour
const MIME_TYPES = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg;codecs=opus", "ogg"],
];
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export function recordingSupported() {
  return !!window.MediaRecorder && MIME_TYPES.some(([mime]) => MediaRecorder.isTypeSupported(mime));
}

function localStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// `doc` is {projectId, sessionId, filename}. `onChange({ elapsedMs,
// pending, error })` reports progress: pending is bytes not yet on the
// server. Resolves to { stop() } - stop() ends the recording and resolves
// once everything recorded is uploaded (or given up on).
export async function startRecording(stream, doc, onChange = () => {}) {
  const [mimeType, ext] = MIME_TYPES.find(([mime]) => MediaRecorder.isTypeSupported(mime));
  const startedAt = new Date();
  const { id } = await api.createRecording(doc.projectId, doc.sessionId, doc.filename, ext, localStamp(startedAt));
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITS_PER_SECOND });
  const queue = [];
  let offset = 0;
  let uploading = false;
  let error = null;
  let retryDelay = RETRY_MIN_MS;
  let stopped = false;
  let finish = null;
  const finished = new Promise((resolve) => (finish = resolve));

  const pending = () => queue.reduce((sum, blob) => sum + blob.size, 0);
  const report = () => onChange({ elapsedMs: Date.now() - startedAt, pending: pending(), error });
  const timer = setInterval(report, 1000);

  async function pump() {
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      try {
        const result = await api.appendRecording(doc.projectId, doc.sessionId, doc.filename, id, offset, queue[0]);
        if (result.mismatch !== undefined) {
          // The server has a different amount than we think - only
          // possible if an upload landed but its reply was lost. Bytes
          // already there are skipped; a shortfall can't be filled.
          const have = result.mismatch;
          const skip = have - offset;
          if (skip < 0 || skip >= queue[0].size) throw new Error("recording out of step");
          queue[0] = queue[0].slice(skip);
          offset = have;
          continue;
        }
        offset = result.size;
        queue.shift();
        error = null;
        retryDelay = RETRY_MIN_MS;
      } catch (err) {
        error = err.message;
        report();
        if (stopped && retryDelay >= RETRY_MAX_MS) break; // give up after stopping
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      }
    }
    uploading = false;
    report();
    if (stopped && (!queue.length || retryDelay >= RETRY_MAX_MS)) {
      clearInterval(timer);
      finish();
    }
  }

  recorder.addEventListener("dataavailable", (e) => {
    if (!e.data || !e.data.size) return;
    queue.push(e.data);
    pump();
  });
  recorder.addEventListener("stop", () => {
    stopped = true;
    if (!uploading) pump();
  });
  // The microphone going away (iOS takes it back when the page is hidden)
  // ends the recording the same way.
  stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => recorder.state !== "inactive" && recorder.stop()));
  recorder.start(SLICE_MS);
  report();

  return {
    id,
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      return finished;
    },
  };
}

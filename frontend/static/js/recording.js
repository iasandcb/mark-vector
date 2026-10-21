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
// [mime, extension, bits per second]. Opus at 64 kbps is close to
// transparent for one voice (~28 MB an hour); iOS's AAC needs more for the
// same (~43 MB an hour).
const MIME_TYPES = [
  ["audio/webm;codecs=opus", "webm", 64000],
  ["audio/webm", "webm", 64000],
  ["audio/mp4", "m4a", 96000],
  ["audio/ogg;codecs=opus", "ogg", 64000],
];
// The microphone as it is, for recording: the browser's call processing
// (echo cancelling, noise suppression, gain riding) is tuned for a video
// call and leaves a recording muffled and pumping - and on iOS turning it
// off also gets the full-band microphone instead of the phone-call one.
export const RECORDING_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

// Apple's browsers (every iOS browser is one) record WebM now too, but
// Safari won't play it back - MP4 there.
function mimeTypes() {
  const apple = /Apple/.test(navigator.vendor || "");
  return apple ? [...MIME_TYPES].sort(([a], [b]) => (b === "audio/mp4") - (a === "audio/mp4")) : MIME_TYPES;
}

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
  const [mimeType, ext, bitsPerSecond] = mimeTypes().find(([mime]) => MediaRecorder.isTypeSupported(mime));
  const startedAt = new Date();
  const { id } = await api.createRecording(doc.projectId, doc.sessionId, doc.filename, ext, localStamp(startedAt));
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: bitsPerSecond });
  const queue = [];
  let offset = 0;
  let uploading = false;
  let error = null;
  let retryDelay = RETRY_MIN_MS;
  let stopped = false;
  let settled = false;
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
    if (stopped && !settled && (!queue.length || retryDelay >= RETRY_MAX_MS)) {
      settled = true;
      clearInterval(timer);
      // Only a finished upload is a video. A tab that died mid-lecture, or
      // an upload that was given up on, leaves a partial file the user can
      // still opt in by hand — it is not offered to the worker on its own.
      const uploaded = queue.length === 0 && offset > 0;
      let queued = false;
      let videoError = null;
      if (uploaded) {
        try {
          await api.setRecordingVideo(doc.projectId, doc.sessionId, doc.filename, id, {
            enqueue: true,
            duration_sec: (Date.now() - startedAt) / 1000,
          });
          queued = true;
        } catch (err) {
          videoError = err.message;
        }
      }
      finish({ queued, videoError });
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

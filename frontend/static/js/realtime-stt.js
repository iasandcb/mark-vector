// Realtime speech-to-text over WebRTC (OpenAI's gpt-live-transcribe) - the
// dictation engine for browsers without a working Web Speech API, which is
// every non-Safari browser on iOS. See backend/app/routers/stt.py for the
// handshake, which keeps the API key on the server; audio goes from the
// microphone straight to OpenAI.
//
// The model streams transcript deltas while speech arrives and a final
// transcript per committed stretch of audio. It has no server-side turn
// detection, so commits come from here: a simple volume gate on the same
// microphone stream commits after a pause, and a long uninterrupted stretch
// is committed anyway so a final transcript never waits too long.
// Billed per minute streamed - callers stop it as soon as it isn't needed.

import { audioContextNeedsResume } from "./file-dictation.mjs";
import { captureAudio, mixToMono } from "./mic-capture.mjs";

const SPEECH_RMS = 0.012; // above this the microphone is taken to hear speech
const PAUSE_MS = 700; // this much quiet after speech ends a stretch
const MAX_STRETCH_MS = 15000; // commit at least this often while text arrives
const TICK_MS = 100;

// `audioContext` should be created synchronously in the click handler that
// starts dictation - iOS only lets an AudioContext run if it was created or
// resumed inside a user gesture, and getUserMedia's await ends the gesture.
// `onEvent(event)` gets every Realtime event from the data channel.
// `onIdle()` is called once nothing has been heard for `idleMs` (omit it
// for a file: silence in the recording is not a reason to hang up).
// `audio` - getUserMedia's audio constraints, for a caller that also
// records the stream. `stream` - transcribe this instead of opening the
// microphone (an audio file being played - see "audio file" in app.js);
// stop() ends its tracks too. Resolves to { stop(), commit(), clear(),
// setStream(), hold(), alive(), stream } once the session is live.
// `commit()` does nothing when no audio has arrived since the previous
// commit - an empty commit errors and the buffer can stop taking audio
// after that. `clear()` drops whatever the gap since then appended, so the
// next words are a new phrase. `hold()` keeps a paused file's session from
// being treated as idle. stop({ keepContext: true }) leaves the AudioContext
// up so a file can open another session on the same media element.
export async function startRealtimeTranscription({ language, audioContext, onEvent, onIdle, idleMs, audio, stream: source }) {
  const constraints = audio || captureAudio();
  let stream = source;
  try {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (err) {
    // The picked microphone went away - the default rather than nothing.
    // The processing flags stay off on that retry.
    if (!constraints.deviceId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
    const { deviceId, ...rest } = constraints;
    stream = await navigator.mediaDevices.getUserMedia({ audio: rest });
  }
  stream = await mixToMono(audioContext, stream);
  const pc = new RTCPeerConnection();
  let stopped = false;
  let timer = null;
  let current = stream;
  const stop = ({ keepContext = false } = {}) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    current.getTracks().forEach((track) => track.stop());
    try {
      pc.close();
    } catch (err) {
      // already closed
    }
    if (!keepContext) audioContext.close().catch(() => {});
  };

  try {
    pc.addTrack(stream.getAudioTracks()[0], stream);
    const channel = pc.createDataChannel("oai-events");
    let textSinceCommit = false;
    channel.addEventListener("message", (event) => {
      if (stopped) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.type === "conversation.item.input_audio_transcription.delta") textSinceCommit = true;
      onEvent(message);
    });
    // A file's peer dying is the same kind of drop as a Soniox timeout.
    // The microphone reports it through onIdle / its own resume path.
    if (source) {
      pc.addEventListener("connectionstatechange", () => {
        if (stopped) return;
        const state = pc.connectionState;
        if (state === "failed" || state === "disconnected" || state === "closed") {
          onEvent({ type: "error", error: { message: "connection closed" } });
        }
      });
    }
    const opened = new Promise((resolve, reject) => {
      channel.addEventListener("open", resolve, { once: true });
      setTimeout(() => reject(new Error("timed out connecting")), 15000);
    });

    await pc.setLocalDescription(await pc.createOffer());
    const query = language ? `?language=${encodeURIComponent(language)}` : "";
    const res = await fetch(`/api/stt/session${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `session failed (${res.status})`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    await opened;

    let lastCommit = performance.now();
    let heardSinceCommit = false;
    const commit = () => {
      if (!heardSinceCommit || channel.readyState !== "open") return;
      channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      lastCommit = performance.now();
      textSinceCommit = false;
      heardSinceCommit = false;
    };
    const clear = () => {
      if (channel.readyState !== "open") return;
      channel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      heardSinceCommit = false;
    };
    // WebRTC has no keepalive frame. Pausing still commits through the
    // caller; this only exists so the file session can ask uniformly.
    const hold = () => {};
    const alive = () =>
      !stopped &&
      channel.readyState === "open" &&
      pc.connectionState !== "failed" &&
      pc.connectionState !== "closed" &&
      pc.connectionState !== "disconnected";

    // Volume gate on the microphone (or the file stream) for pause detection.
    if (audioContextNeedsResume(audioContext.state)) audioContext.resume().catch(() => {});
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    let analyserSource = audioContext.createMediaStreamSource(current);
    analyserSource.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let speaking = false;
    let lastVoice = performance.now();
    let lastHeard = performance.now();
    // A pause can leave the capture track muted while the element itself
    // still plays. The caller builds a fresh stream and hands it here.
    const setStream = async (next) => {
      const mixed = await mixToMono(audioContext, next);
      const track = mixed.getAudioTracks()[0];
      if (!track) return;
      const sender = pc.getSenders().find((item) => !item.track || item.track.kind === "audio");
      if (sender) await sender.replaceTrack(track);
      try {
        analyserSource.disconnect();
      } catch (err) {
        // already disconnected
      }
      analyserSource = audioContext.createMediaStreamSource(mixed);
      analyserSource.connect(analyser);
      if (current !== mixed) current.getTracks().forEach((old) => old !== track && old.stop());
      current = mixed;
    };
    timer = setInterval(() => {
      const now = performance.now();
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      if (rms > SPEECH_RMS) {
        speaking = true;
        lastVoice = now;
        lastHeard = now;
        heardSinceCommit = true;
      } else if (speaking && now - lastVoice > PAUSE_MS) {
        speaking = false;
        commit();
      }
      // A long stretch with text coming in gets committed regardless - and
      // this also covers a volume gate that never opens (an AudioContext
      // the browser kept suspended), since text arriving means speech.
      if (textSinceCommit && now - lastCommit > MAX_STRETCH_MS) commit();
      if (textSinceCommit) lastHeard = Math.max(lastHeard, lastCommit);
      if (idleMs && now - lastHeard > idleMs) onIdle();
    }, TICK_MS);

    return { stop, commit, clear, setStream, hold, alive, get stream() { return current; } };
  } catch (err) {
    stop();
    throw err;
  }
}

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

const SPEECH_RMS = 0.012; // above this the microphone is taken to hear speech
const PAUSE_MS = 700; // this much quiet after speech ends a stretch
const MAX_STRETCH_MS = 15000; // commit at least this often while text arrives
const TICK_MS = 100;

// `audioContext` should be created synchronously in the click handler that
// starts dictation - iOS only lets an AudioContext run if it was created or
// resumed inside a user gesture, and getUserMedia's await ends the gesture.
// `onEvent(event)` gets every Realtime event from the data channel.
// `onIdle()` is called once nothing has been heard for `idleMs`.
// Resolves to { stop(), commit() } once the session is live.
export async function startRealtimeTranscription({ language, audioContext, onEvent, onIdle, idleMs }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const pc = new RTCPeerConnection();
  let stopped = false;
  let timer = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    try {
      pc.close();
    } catch (err) {
      // already closed
    }
    audioContext.close().catch(() => {});
  };

  try {
    pc.addTrack(stream.getAudioTracks()[0], stream);
    const channel = pc.createDataChannel("oai-events");
    let textSinceCommit = false;
    channel.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.type === "conversation.item.input_audio_transcription.delta") textSinceCommit = true;
      onEvent(message);
    });
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
    const commit = () => {
      if (channel.readyState !== "open") return;
      channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      lastCommit = performance.now();
      textSinceCommit = false;
    };

    // Volume gate on the microphone for pause detection.
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let speaking = false;
    let lastVoice = performance.now();
    let lastHeard = performance.now();
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

    return { stop, commit };
  } catch (err) {
    stop();
    throw err;
  }
}

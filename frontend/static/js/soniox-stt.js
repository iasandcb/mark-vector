// Soniox realtime speech-to-text (stt-rt-v5) over a raw WebSocket. The
// page has no build step, so this does not use @soniox/client. The
// long-lived key stays on the server; /api/stt/soniox/key mints a
// temporary one, sent as the websocket subprotocol
// ["soniox-api-key", key] (browsers cannot set an Authorization header).
// https://soniox.com/docs/guides/websocket-authentication
//
// Resolves to the same { stop, commit, clear, setStream, hold, alive, stream }
// shape as realtime-stt.js. commit() sends {type:"finalize"} when something
// was heard since the last one. clear() is a no-op on the wire: Soniox has
// no input buffer to drop, and finalize already closed the phrase. hold()
// sends keepalive immediately, without finalizing — a page about to freeze
// in the background cannot wait for the interval, and hiding a desktop tab
// must not cut the sentence. A file
// passes idleMs null. A microphone passes the three-minute cost guard.
// Keepalive covers a stretch where no audio frame goes out — Soniox closes
// a socket that is idle for about 40s. stop({ keepContext: true }) leaves
// the AudioContext up so a file can open a fresh socket on the same graph.

import { audioContextNeedsResume } from "./file-dictation.mjs";
import { floatToPcm16, sonioxStartConfig, SONIOX_WS_URL } from "./soniox-session.mjs";

const SPEECH_RMS = 0.012;
const PAUSE_MS = 700;
const MAX_STRETCH_MS = 15000;
const TICK_MS = 100;
const KEEPALIVE_MS = 15000;

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.target = Math.round(sampleRate / 10);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;
    const next = new Float32Array(this.pending.length + channel.length);
    next.set(this.pending);
    next.set(channel, this.pending.length);
    if (next.length >= this.target) {
      this.port.postMessage(next);
      this.pending = new Float32Array(0);
    } else {
      this.pending = next;
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

async function openCapture(audioContext, onSamples) {
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  sink.connect(audioContext.destination);
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await audioContext.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(audioContext, "pcm-capture");
    node.port.onmessage = (event) => onSamples(event.data);
    node.connect(sink);
    return {
      connect(source) {
        source.connect(node);
      },
      disconnect() {
        try {
          node.disconnect();
        } catch (err) {
          // already disconnected
        }
        try {
          sink.disconnect();
        } catch (err) {
          // already disconnected
        }
      },
    };
  } catch (err) {
    const node = audioContext.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0));
    node.connect(sink);
    return {
      connect(source) {
        source.connect(node);
      },
      disconnect() {
        try {
          node.disconnect();
        } catch (error) {
          // already disconnected
        }
        try {
          sink.disconnect();
        } catch (error) {
          // already disconnected
        }
      },
    };
  }
}

async function openMicrophone(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (err) {
    if (!constraints.deviceId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
    const { deviceId, ...rest } = constraints;
    return navigator.mediaDevices.getUserMedia({ audio: rest });
  }
}

export async function startSonioxTranscription({ language, audioContext, onTokens, onError, onIdle, idleMs, audio, stream: source, terms }) {
  const constraints = audio || { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream = source;
  let stopped = false;
  let failed = false;
  let timer = null;
  let keepalive = null;
  let ws = null;
  let capture = null;
  let captureSource = null;
  const stop = ({ keepContext = false } = {}) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(keepalive);
    try {
      captureSource && captureSource.disconnect();
    } catch (err) {
      // already disconnected
    }
    try {
      capture && capture.disconnect();
    } catch (err) {
      // already disconnected
    }
    try {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      // already stopped
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("");
      } catch (err) {
        // already closing
      }
    }
    try {
      ws && ws.close();
    } catch (err) {
      // already closed
    }
    // A file reconnects on this same context. Closing it would destroy the
    // MediaElementSource, which cannot be created again for that element.
    if (!keepContext) audioContext.close().catch(() => {});
  };
  const fail = (message) => {
    if (stopped || failed) return;
    failed = true;
    try {
      onError(message || { error_message: "connection closed" });
    } catch (err) {
      // the caller already tore the session down
    }
  };

  try {
    if (!stream) stream = await openMicrophone(constraints);
    const termsPromise = typeof terms === "function" ? Promise.resolve().then(() => terms()).catch(() => []) : Promise.resolve([]);
    const keyRes = await fetch("/api/stt/soniox/key", { method: "POST" });
    let termList = [];
    try {
      termList = (await termsPromise) || [];
    } catch (err) {
      termList = [];
    }
    if (!keyRes.ok) {
      const body = await keyRes.json().catch(() => ({}));
      throw new Error(body.detail || `session failed (${keyRes.status})`);
    }
    const minted = await keyRes.json();
    const temporaryKey = minted && minted.api_key;
    if (!temporaryKey) throw new Error("session failed");

    ws = new WebSocket(SONIOX_WS_URL, ["soniox-api-key", temporaryKey]);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out connecting")), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("timed out connecting"));
      }, { once: true });
    });
    if (stopped) {
      stop();
      return {
        stop,
        commit: () => {},
        clear: () => {},
        setStream: async () => {},
        hold: () => {},
        alive: () => false,
        get stream() { return stream; },
      };
    }

    let lastSend = performance.now();
    const sendJson = (payload) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
      lastSend = performance.now();
    };
    // A bad temporary key still fires open, then an error frame.
    ws.addEventListener("message", (event) => {
      if (stopped || typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.error_code) {
        fail(message);
        return;
      }
      if (message.tokens && message.tokens.length) onTokens(message);
    });
    ws.addEventListener("close", () => {
      if (stopped) return;
      fail({ error_message: "connection closed" });
    });
    sendJson(sonioxStartConfig({ language, terms: termList, sampleRate: 16000 }));

    let heardSinceCommit = false;
    let textSinceCommit = false;
    let lastCommit = performance.now();
    const commit = () => {
      if (!heardSinceCommit || !ws || ws.readyState !== WebSocket.OPEN) return;
      sendJson({ type: "finalize" });
      lastCommit = performance.now();
      heardSinceCommit = false;
      textSinceCommit = false;
    };
    const clear = () => {
      heardSinceCommit = false;
    };
    // Poke the socket so a pause — or the moment before iOS freezes timers —
    // is not an idle timeout. Finalizing is the caller's job: a hidden
    // desktop tab keeps playing and must not cut the phrase here.
    const hold = () => {
      sendJson({ type: "keepalive" });
    };
    const alive = () => !stopped && !failed && !!ws && ws.readyState === WebSocket.OPEN;
    const noteText = () => {
      textSinceCommit = true;
      heardSinceCommit = true;
    };
    const previousOnTokens = onTokens;
    onTokens = (message) => {
      noteText();
      previousOnTokens(message);
    };

    if (audioContextNeedsResume(audioContext.state)) audioContext.resume().catch(() => {});
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const samples = new Float32Array(analyser.fftSize);
    capture = await openCapture(audioContext, (floats) => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatToPcm16(floats, audioContext.sampleRate, 16000);
      if (!pcm.byteLength) return;
      ws.send(pcm);
      lastSend = performance.now();
    });
    const connectStream = (next) => {
      if (captureSource) {
        try {
          captureSource.disconnect();
        } catch (err) {
          // already disconnected
        }
      }
      captureSource = audioContext.createMediaStreamSource(next);
      captureSource.connect(analyser);
      capture.connect(captureSource);
    };
    connectStream(stream);
    const setStream = async (next) => {
      const track = next.getAudioTracks()[0];
      if (!track) return;
      connectStream(next);
      if (stream !== next) stream.getTracks().forEach((old) => old !== track && old.stop());
      stream = next;
    };

    let speaking = false;
    let lastVoice = performance.now();
    let lastHeard = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
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
      if (textSinceCommit && now - lastCommit > MAX_STRETCH_MS) commit();
      if (textSinceCommit) lastHeard = Math.max(lastHeard, lastCommit);
      if (idleMs && now - lastHeard > idleMs) onIdle();
    }, TICK_MS);
    keepalive = setInterval(() => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (performance.now() - lastSend < 20000) return;
      sendJson({ type: "keepalive" });
    }, KEEPALIVE_MS);

    return { stop, commit, clear, setStream, hold, alive, get stream() { return stream; } };
  } catch (err) {
    stop();
    throw err;
  }
}

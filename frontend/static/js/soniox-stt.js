// Soniox realtime speech-to-text (stt-rt-v5) over a raw WebSocket. The
// page has no build step, so this does not use @soniox/client. The
// long-lived key stays on the server; /api/stt/soniox/key mints a
// temporary one, sent as the websocket subprotocol
// ["soniox-api-key", key] (browsers cannot set an Authorization header).
// https://soniox.com/docs/guides/websocket-authentication
//
// Resolves to the same { stop, commit, clear, setStream, stream } shape as
// realtime-stt.js. commit() sends {type:"finalize"} when something was
// heard since the last one. clear() is a no-op on the wire: Soniox has no
// input buffer to drop, and finalize already closed the phrase. A file
// passes idleMs null. A microphone passes the three-minute cost guard.
// Keepalive covers a stretch where no audio frame goes out — Soniox closes
// a socket that is idle for about 40s.

import { applyDiscreteChannels, blockRms, captureAudio, downmixChannels, startChannelPump, trackChannelCount } from "./mic-capture.mjs";
import { floatToPcm16, sonioxStartConfig, SONIOX_WS_URL } from "./soniox-session.mjs";

const SPEECH_RMS = 0.012;
const PAUSE_MS = 700;
const MAX_STRETCH_MS = 15000;
const TICK_MS = 100;
const KEEPALIVE_MS = 15000;

// downmixChannels is inlined so the audio thread mixes every channel.
// Channel 0 alone is often empty on a 16-channel BlackHole.
const WORKLET = `
${downmixChannels.toString()}
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.target = Math.round(sampleRate / 10);
  }
  process(inputs) {
    const mixed = downmixChannels(inputs[0] || []);
    if (!mixed.length) return true;
    const next = new Float32Array(this.pending.length + mixed.length);
    next.set(this.pending);
    next.set(mixed, this.pending.length);
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
      // The source's default is a stereo fold. Widen it to the track before
      // connecting, or a later BlackHole channel never reaches process().
      connect(source, track) {
        const want = trackChannelCount(track) || source.channelCount;
        applyDiscreteChannels(source, want);
        applyDiscreteChannels(node, source.channelCount || want);
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
    let node = null;
    for (const inputs of [16, 2, 1]) {
      try {
        node = audioContext.createScriptProcessor(4096, inputs, 1);
        break;
      } catch (error) {
        node = null;
      }
    }
    if (!node) node = audioContext.createScriptProcessor(4096, 1, 1);
    try {
      node.channelInterpretation = "discrete";
    } catch (error) {
      // this node won't take a discrete interpretation
    }
    node.onaudioprocess = (event) => {
      const channels = [];
      for (let i = 0; i < event.inputBuffer.numberOfChannels; i++) channels.push(event.inputBuffer.getChannelData(i));
      onSamples(downmixChannels(channels));
    };
    node.connect(sink);
    return {
      connect(source, track) {
        const want = trackChannelCount(track) || source.channelCount;
        applyDiscreteChannels(source, want);
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
    // Only a device id the browser rejected is dropped. A BlackHole open
    // that succeeds is kept — silence from that open was the processor,
    // not the wrong device. Processing flags stay off on the retry.
    if (!constraints.deviceId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
    const { deviceId, ...rest } = constraints;
    return navigator.mediaDevices.getUserMedia({ audio: rest });
  }
}

export async function startSonioxTranscription({ language, audioContext, onTokens, onError, onIdle, idleMs, audio, stream: source, terms }) {
  const constraints = audio || captureAudio();
  let stream = source;
  let stopped = false;
  let failed = false;
  let timer = null;
  let keepalive = null;
  let ws = null;
  let capture = null;
  let captureSource = null;
  let pump = null;
  const stop = () => {
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
    if (pump) pump.stop();
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
    audioContext.close().catch(() => {});
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
      return { stop, commit: () => {}, clear: () => {}, setStream: async () => {}, get stream() { return stream; } };
    }

    let lastSend = performance.now();
    const sendJson = (payload) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
      lastSend = performance.now();
    };
    // A bad temporary key still fires open, then an error frame.
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
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
    ws.addEventListener("close", () => fail({ error_message: "connection closed" }));
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
    const noteText = () => {
      textSinceCommit = true;
      heardSinceCommit = true;
    };
    const previousOnTokens = onTokens;
    onTokens = (message) => {
      noteText();
      previousOnTokens(message);
    };

    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const samples = new Float32Array(analyser.fftSize);
    // The analyser hears the raw stream, which can be a different mix than
    // the PCM we send. The idle clock follows whichever is louder, so a
    // loopback that only shows up after the channel mix still counts.
    let captureRms = 0;
    let captureAt = 0;
    // `rate` is the rate of these samples. The track reader reports the
    // device rate; the worklet already runs at the AudioContext rate.
    // Downsampling with the wrong rate would send the wrong pitch.
    const onFloats = (floats, rate) => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      captureRms = blockRms(floats);
      captureAt = performance.now();
      const pcm = floatToPcm16(floats, rate || audioContext.sampleRate, 16000);
      if (!pcm.byteLength) return;
      ws.send(pcm);
      lastSend = performance.now();
    };
    let followGen = 0;
    const connectStream = async (next) => {
      const gen = ++followGen;
      if (pump) {
        const previous = pump;
        pump = null;
        await previous.stop();
      }
      if (gen !== followGen) return;
      if (captureSource) {
        try {
          captureSource.disconnect();
        } catch (err) {
          // already disconnected
        }
        captureSource = null;
      }
      const track = next.getAudioTracks()[0];
      if (!track) return;
      // The analyser is the Web Audio copy. It can be a silent fold of a
      // multichannel device while the track reader still has the signal,
      // so the idle clock also follows the samples we actually send.
      captureSource = audioContext.createMediaStreamSource(next);
      applyDiscreteChannels(captureSource, trackChannelCount(track) || captureSource.channelCount);
      captureSource.connect(analyser);
      // Prefer the track's own planes. createMediaStreamSource folds a
      // 16-channel BlackHole to two channels before the worklet runs, and
      // those two are often the empty ones. Chrome's mic meter still moves.
      const started = await startChannelPump(track, (floats, rate) => onFloats(floats, rate));
      if (gen !== followGen) {
        if (started) started.stop();
        return;
      }
      if (started) {
        pump = started;
        if (capture) {
          try {
            capture.disconnect();
          } catch (err) {
            // already disconnected
          }
          capture = null;
        }
        return;
      }
      if (!capture) capture = await openCapture(audioContext, (floats) => onFloats(floats, audioContext.sampleRate));
      if (gen !== followGen) return;
      capture.connect(captureSource, track);
    };
    await connectStream(stream);
    const setStream = async (next) => {
      const track = next.getAudioTracks()[0];
      if (!track) return;
      await connectStream(next);
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
      let rms = Math.sqrt(sum / samples.length);
      if (now - captureAt < 500) rms = Math.max(rms, captureRms);
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

    return { stop, commit, clear, setStream, get stream() { return stream; } };
  } catch (err) {
    stop();
    throw err;
  }
}

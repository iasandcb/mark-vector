// What getUserMedia asks for when Soniox or OpenAI listens to the microphone.
//
// Echo cancellation, noise suppression, and auto gain are the voice-call
// processor. On a real microphone that is optional. On a loopback device
// (BlackHole, and the same kind of virtual input) the "echo" is the audio
// we want, so the processor deletes it and the track looks open but is
// silent. Chrome still uses the microphone chosen for the site; these
// flags are what turn that signal into silence. Leave them off.

export const CAPTURE_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

// Constraints for one open. `channelCount` asks Chrome not to fold a
// 16-channel BlackHole down to a stereo pair before the page sees it
// (`ideal`, so a mono microphone still opens). `voiceIsolation` is the
// separate "keep the voice, drop the rest" pass; it is only sent when this
// browser lists it, because an unknown required flag would reject the open.
export function captureAudio(supported) {
  const audio = { ...CAPTURE_AUDIO };
  const flags = supported === undefined ? supportedCaptureFlags() : supported || {};
  if (flags.channelCount) audio.channelCount = { ideal: 16 };
  if (flags.voiceIsolation) audio.voiceIsolation = false;
  return audio;
}

function supportedCaptureFlags() {
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
  if (!devices || !devices.getSupportedConstraints) return { channelCount: true, voiceIsolation: true };
  return devices.getSupportedConstraints() || {};
}

// One mono buffer from every channel of a capture block. Channels that are
// silent are left out, so a 16-channel BlackHole with audio only on a
// later channel keeps that level instead of averaging it down by 16, and
// instead of keeping only channel 0 (which is often the empty one).
// The threshold lives inside the function: the worklet is this function's
// source text, and it cannot see module locals.
export function downmixChannels(channels) {
  const activeEnergy = 1e-8;
  const list = [];
  let length = 0;
  for (const ch of channels || []) {
    if (!ch || !ch.length) continue;
    if (ch.length > length) length = ch.length;
    list.push(ch);
  }
  const out = new Float32Array(length);
  if (!list.length || !length) return out;
  const active = [];
  for (const ch of list) {
    let energy = 0;
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) energy += ch[i] * ch[i];
    if (energy > activeEnergy) active.push(ch);
  }
  const use = active.length ? active : list;
  const nch = use.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of use) sum += i < ch.length ? ch[i] : 0;
    out[i] = sum / nch;
  }
  return out;
}

export function blockRms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function trackChannelCount(track) {
  const settings = track && typeof track.getSettings === "function" ? track.getSettings() : null;
  const count = settings && settings.channelCount;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// Web Audio's media-stream source defaults to two channels and folds the
// rest with a speaker layout. A 16-channel BlackHole then arrives as an
// empty pair even though the track itself still has the later channels.
// Ask this node for the track's own count, discrete, so nothing is mixed
// before `downmixChannels`. If the node refuses that count, keep its maximum.
export function applyDiscreteChannels(node, want) {
  if (!node) return 0;
  const requested = Math.max(1, Math.floor(Number(want) || node.channelCount || 1));
  const assign = (count) => {
    node.channelInterpretation = "discrete";
    node.channelCountMode = "explicit";
    node.channelCount = count;
    return node.channelCount || count;
  };
  try {
    return assign(requested);
  } catch (err) {
    const cap = node.maxChannelCount || node.channelCount || 1;
    const fallback = Math.max(1, Math.min(requested, cap));
    try {
      return assign(fallback);
    } catch (error) {
      return node.channelCount || 1;
    }
  }
}

// One Float32Array per channel, in order. Chrome hands the track over as
// planar f32; channel 0 is often the empty one on a 16-channel device.
export function audioDataToChannels(data) {
  const n = (data && data.numberOfChannels) || 0;
  const frames = (data && data.numberOfFrames) || 0;
  const channels = [];
  for (let c = 0; c < n; c++) {
    const buf = new Float32Array(frames);
    data.copyTo(buf, { planeIndex: c, format: "f32-planar" });
    channels.push(buf);
  }
  return channels;
}

// Average to `outRate` the same way floatToPcm16 does, without the int16 step.
// The OpenAI graph runs at the AudioContext rate; the track may not.
export function resampleFloat(input, inRate, outRate) {
  if (!input || !input.length) return new Float32Array(0);
  if (!inRate || !outRate || inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

// Read the track's own planes and hand the mixed block to `onSamples`.
// Returns null when this browser has no reader, or the first block cannot
// be copied — the caller then uses the Web Audio worklet. The reader is a
// tap: a recorder or an analyser on the same track still hears it.
export async function startChannelPump(track, onSamples) {
  if (!track || typeof MediaStreamTrackProcessor === "undefined") return null;
  let reader;
  try {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  } catch (err) {
    return null;
  }
  const deliver = (data) => {
    try {
      const mixed = downmixChannels(audioDataToChannels(data));
      const rate = data.sampleRate || 0;
      data.close();
      onSamples(mixed, rate);
    } catch (err) {
      try {
        data.close();
      } catch (error) {
        // already closed
      }
      throw err;
    }
  };
  let first;
  try {
    first = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
  } catch (err) {
    first = null;
  }
  if (!first || !first.value) {
    try {
      await reader.cancel();
    } catch (err) {
      // already cancelled
    }
    return null;
  }
  try {
    deliver(first.value);
  } catch (err) {
    try {
      await reader.cancel();
    } catch (error) {
      // already cancelled
    }
    return null;
  }
  let stopped = false;
  const task = (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done || !value || stopped) {
          if (value) {
            try {
              value.close();
            } catch (err) {
              // already closed
            }
          }
          break;
        }
        try {
          deliver(value);
        } catch (err) {
          break;
        }
      }
    } catch (err) {
      // the track ended under the reader
    }
  })();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await reader.cancel();
      } catch (err) {
        // already cancelled
      }
      try {
        await task;
      } catch (err) {
        // already finished
      }
    },
  };
}

// AudioWorklet that writes the same mix to its single output. OpenAI's
// WebRTC track has no PCM callback of its own, so the mix has to become
// the track. The Soniox worklet inlines downmixChannels the same way.
export function downmixWorkletSource() {
  return `${downmixChannels.toString()}
class ChannelDownmix extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const mixed = downmixChannels(inputs[0] || []);
    const n = Math.min(out.length, mixed.length);
    for (let i = 0; i < n; i++) out[i] = mixed[i];
    for (let i = n; i < out.length; i++) out[i] = 0;
    return true;
  }
}
registerProcessor("channel-downmix", ChannelDownmix);
`;
}

// Plays mixed samples into a one-channel stream. OpenAI has no PCM callback,
// so a multichannel track has to become a mono track. The queue is drained
// one render quantum at a time; the blocks are not the quantum length.
export function pcmInjectWorkletSource() {
  return `
class PcmInject extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.length) this.chunks.push(event.data);
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length && this.chunks.length) {
      const chunk = this.chunks[0];
      const take = Math.min(out.length - i, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + take), i);
      i += take;
      this.offset += take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    for (; i < out.length; i++) out[i] = 0;
    return true;
  }
}
registerProcessor("pcm-inject", PcmInject);
`;
}

const workletReady = new WeakMap();

async function ensureWorklet(audioContext, name, source) {
  let ready = workletReady.get(audioContext);
  if (!ready) {
    ready = new Map();
    workletReady.set(audioContext, ready);
  }
  let pending = ready.get(name);
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      try {
        await audioContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((err) => {
      ready.delete(name);
      throw err;
    });
    ready.set(name, pending);
  }
  await pending;
}

function stopTracks(tracks) {
  for (const track of tracks) {
    try {
      track.stop();
    } catch (err) {
      // already stopped
    }
  }
}

// A mono stream of the same audio. The original tracks stop when the mixed
// track stops, so the microphone light does not stay on after the session.
// More than two channels are read off the track itself: the Web Audio source
// would already have folded them. A stereo or mono track, and a reader that
// cannot start, go through the downmix worklet. If that cannot load either,
// the original stream is used as it is.
export async function mixToMono(audioContext, stream) {
  const original = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
  if (!audioContext || !original.length) return stream;
  const channels = trackChannelCount(original[0]);
  if (channels > 2) {
    const injected = await injectMixedTrack(audioContext, original);
    if (injected) return injected;
  }
  return mixWithWorklet(audioContext, stream, original);
}

async function injectMixedTrack(audioContext, original) {
  let node;
  try {
    await ensureWorklet(audioContext, "pcm-inject", pcmInjectWorkletSource());
    node = new AudioWorkletNode(audioContext, "pcm-inject", { outputChannelCount: [1] });
  } catch (err) {
    return null;
  }
  const dest = audioContext.createMediaStreamDestination();
  dest.channelCount = 1;
  dest.channelCountMode = "explicit";
  // A destination nothing has consumed yet is not pulled, and the mixed
  // samples would sit in the worklet forever. The silent branch keeps it running.
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  node.connect(dest);
  node.connect(sink);
  sink.connect(audioContext.destination);
  const outRate = audioContext.sampleRate;
  const pump = await startChannelPump(original[0], (mixed, rate) => {
    const samples = resampleFloat(mixed, rate, outRate);
    if (samples.length) node.port.postMessage(samples);
  });
  if (!pump) {
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
    return null;
  }
  const mixed = dest.stream;
  const out = mixed.getAudioTracks()[0];
  const release = () => {
    pump.stop();
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
  };
  if (out) out.addEventListener("ended", () => {
    release();
    stopTracks(original);
  });
  original[0].addEventListener("ended", () => {
    try {
      if (out) out.stop();
    } catch (err) {
      // already stopped
    }
    release();
  });
  return mixed;
}

async function mixWithWorklet(audioContext, stream, original) {
  let node;
  try {
    await ensureWorklet(audioContext, "channel-downmix", downmixWorkletSource());
    node = new AudioWorkletNode(audioContext, "channel-downmix", { outputChannelCount: [1] });
  } catch (err) {
    return stream;
  }
  const source = audioContext.createMediaStreamSource(stream);
  const want = trackChannelCount(original[0]) || source.channelCount;
  applyDiscreteChannels(source, want);
  applyDiscreteChannels(node, source.channelCount || want);
  const dest = audioContext.createMediaStreamDestination();
  dest.channelCount = 1;
  dest.channelCountMode = "explicit";
  source.connect(node);
  node.connect(dest);
  const mixed = dest.stream;
  const out = mixed.getAudioTracks()[0];
  if (out) out.addEventListener("ended", () => stopTracks(original));
  return mixed;
}

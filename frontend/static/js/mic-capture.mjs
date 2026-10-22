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

const downmixReady = new WeakMap();

async function ensureDownmix(audioContext) {
  let pending = downmixReady.get(audioContext);
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([downmixWorkletSource()], { type: "application/javascript" }));
      try {
        await audioContext.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((err) => {
      downmixReady.delete(audioContext);
      throw err;
    });
    downmixReady.set(audioContext, pending);
  }
  await pending;
}

// A mono stream of the same audio. The original tracks stop when the mixed
// track stops, so the microphone light does not stay on after the session.
// If the worklet cannot load, the original stream is used as it is.
export async function mixToMono(audioContext, stream) {
  const original = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
  if (!audioContext || !original.length) return stream;
  let node;
  try {
    await ensureDownmix(audioContext);
    node = new AudioWorkletNode(audioContext, "channel-downmix", { outputChannelCount: [1] });
  } catch (err) {
    return stream;
  }
  node.channelCountMode = "max";
  node.channelInterpretation = "discrete";
  const source = audioContext.createMediaStreamSource(stream);
  const dest = audioContext.createMediaStreamDestination();
  dest.channelCount = 1;
  dest.channelCountMode = "explicit";
  source.connect(node);
  node.connect(dest);
  const mixed = dest.stream;
  const out = mixed.getAudioTracks()[0];
  if (out) {
    out.addEventListener("ended", () => {
      for (const track of original) {
        try {
          track.stop();
        } catch (err) {
          // already stopped
        }
      }
    });
  }
  return mixed;
}

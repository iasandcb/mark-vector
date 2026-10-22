import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_AUDIO,
  applyDiscreteChannels,
  audioDataToChannels,
  blockRms,
  captureAudio,
  downmixChannels,
  downmixWorkletSource,
  pcmInjectWorkletSource,
  resampleFloat,
  trackChannelCount,
} from "./mic-capture.mjs";

function tone(length, amplitude) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * amplitude;
  return out;
}

test("dictation capture does not run the voice-call processor", () => {
  assert.equal(CAPTURE_AUDIO.echoCancellation, false);
  assert.equal(CAPTURE_AUDIO.noiseSuppression, false);
  assert.equal(CAPTURE_AUDIO.autoGainControl, false);
  const asked = captureAudio({ channelCount: true, voiceIsolation: true });
  assert.equal(asked.echoCancellation, false);
  assert.equal(asked.voiceIsolation, false);
  assert.deepEqual(asked.channelCount, { ideal: 16 });
  const stereoOnly = captureAudio({});
  assert.equal(stereoOnly.channelCount, undefined);
  assert.equal(stereoOnly.voiceIsolation, undefined);
});

test("a node that refuses 16 channels keeps the most it can", () => {
  const node = {
    _n: 2,
    maxChannelCount: 8,
    get channelCount() {
      return this._n;
    },
    set channelCount(value) {
      if (value > this.maxChannelCount) throw new Error("range");
      this._n = value;
    },
  };
  assert.equal(applyDiscreteChannels(node, 16), 8);
  assert.equal(node.channelCountMode, "explicit");
  assert.equal(node.channelInterpretation, "discrete");
  assert.equal(trackChannelCount({ getSettings: () => ({ channelCount: 16 }) }), 16);
  assert.equal(trackChannelCount(null), 0);
});

test("planar blocks keep a later channel and survive a rate change", () => {
  const data = {
    numberOfChannels: 8,
    numberOfFrames: 48,
    copyTo(buf, { planeIndex }) {
      for (let i = 0; i < buf.length; i++) buf[i] = planeIndex === 7 ? Math.sin((2 * Math.PI * i) / 12) * 0.4 : 0;
    },
  };
  const mixed = downmixChannels(audioDataToChannels(data));
  // Channel 0 is silence. The mix keeps channel 7 at the tone's own level.
  assert.ok(blockRms(mixed) > 0.2);
  const same = resampleFloat(mixed, 48000, 48000);
  assert.equal(same, mixed);
  const down = resampleFloat(mixed, 48000, 16000);
  assert.equal(down.length, 16);
  assert.ok(blockRms(down) > 0.012);
});

test("a signal that lives only on a later channel is kept at its own level", () => {
  const length = 480;
  const channels = Array.from({ length: 16 }, () => new Float32Array(length));
  const signal = tone(length, 0.4);
  channels[7].set(signal);
  const mixed = downmixChannels(channels);
  assert.equal(blockRms(channels[0]) < 0.001, true);
  assert.ok(Math.abs(blockRms(mixed) - blockRms(signal)) < 0.01);
  // The old capture kept channel 0 only, which is silence here, under the
  // level that counts as audio (0.012). The mix is well above it.
  assert.ok(blockRms(mixed) > 0.012);
  assert.ok(blockRms(channels[0]) < 0.012);
});

test("stereo loopback is not halved and is not left/right cancelled", () => {
  const left = tone(480, 0.4);
  const right = tone(480, 0.4);
  const mixed = downmixChannels([left, right]);
  assert.ok(Math.abs(blockRms(mixed) - blockRms(left)) < 0.01);
});

test("digital silence stays silence", () => {
  const mixed = downmixChannels([new Float32Array(128), new Float32Array(128)]);
  assert.equal(blockRms(mixed), 0);
});

test("the worklet source is the same mix, and it names the processor", () => {
  const source = downmixWorkletSource();
  assert.equal(source.includes("registerProcessor(\"channel-downmix\""), true);
  assert.equal(source.includes("function downmixChannels"), true);
  assert.equal(source.includes("echoCancellation"), false);
  assert.equal(pcmInjectWorkletSource().includes("registerProcessor(\"pcm-inject\""), true);
});

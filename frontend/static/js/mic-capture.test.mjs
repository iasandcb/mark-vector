import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_AUDIO, blockRms, downmixChannels, downmixWorkletSource } from "./mic-capture.mjs";

function tone(length, amplitude) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * amplitude;
  return out;
}

test("dictation capture does not run the voice-call processor", () => {
  assert.equal(CAPTURE_AUDIO.echoCancellation, false);
  assert.equal(CAPTURE_AUDIO.noiseSuppression, false);
  assert.equal(CAPTURE_AUDIO.autoGainControl, false);
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
});

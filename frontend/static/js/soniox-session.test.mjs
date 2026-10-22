import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSonioxTranscript,
  floatToPcm16,
  limitContextTerms,
  renderSonioxMessage,
  sonioxStartConfig,
  spokenPhrasesFromCsv,
  stripSonioxControlTokens,
} from "./soniox-session.mjs";

// The evolution from Soniox's realtime docs for "How are you doing?".
const HOW_ARE_YOU = [
  [
    { text: "How", is_final: false },
    { text: "'re", is_final: false },
  ],
  [
    { text: "How", is_final: false },
    { text: " ", is_final: false },
    { text: "are", is_final: false },
  ],
  [
    { text: "How", is_final: true },
    { text: " ", is_final: true },
    { text: "are", is_final: false },
    { text: " ", is_final: false },
    { text: "you", is_final: false },
  ],
  [
    { text: "are", is_final: true },
    { text: " ", is_final: true },
    { text: "you", is_final: true },
    { text: " ", is_final: false },
    { text: "do", is_final: false },
    { text: "ing", is_final: false },
    { text: "?", is_final: false },
  ],
  [
    { text: " ", is_final: true },
    { text: "do", is_final: true },
    { text: "ing", is_final: true },
    { text: "?", is_final: true },
  ],
];

test("final tokens append once and non-final tokens replace the interim", () => {
  let committed = "";
  let interim = "";
  const seenFinals = [];
  for (const tokens of HOW_ARE_YOU) {
    const rendered = renderSonioxMessage(tokens);
    committed += rendered.finals;
    interim = rendered.interim;
    if (rendered.finals) seenFinals.push(rendered.finals);
  }
  assert.equal(committed, "How are you doing?");
  assert.equal(interim, "");
  assert.equal(seenFinals.join(""), committed);
  // The first hypothesis is replaced, not kept beside the correction.
  const first = renderSonioxMessage(HOW_ARE_YOU[0]);
  const second = renderSonioxMessage(HOW_ARE_YOU[1]);
  assert.equal(first.finals, "");
  assert.equal(first.interim, "How're");
  assert.equal(second.interim, "How are");
});

test("endpoint and finalization markers never reach the document", () => {
  assert.equal(stripSonioxControlTokens("<fin>"), "");
  assert.equal(stripSonioxControlTokens("안녕<fin>"), "안녕");
  assert.equal(stripSonioxControlTokens("amen.<END>"), "amen.");
  assert.deepEqual(
    renderSonioxMessage([
      { text: "<end>", is_final: true },
      { text: "<fin>", is_final: true },
      { text: "<FIN>", is_final: false },
      { text: "", is_final: true },
      { text: "가", is_final: true },
      { text: "<end>", is_final: false },
    ]),
    { finals: "가", interim: "" },
  );
  assert.deepEqual(renderSonioxMessage([{ text: "안녕<fin>", is_final: true }, { text: "요<end>", is_final: false }]), {
    finals: "안녕",
    interim: "요",
  });
});

test("finals that only confirm the phrase already on screen are dropped once", () => {
  const ack = consumeSonioxTranscript(
    [
      { text: "삼", is_final: true },
      { text: " ", is_final: true },
    ],
    true,
  );
  assert.equal(ack.finals, "");
  assert.equal(ack.dropPendingFinals, false);
  const next = consumeSonioxTranscript([{ text: "다음", is_final: true }], ack.dropPendingFinals);
  assert.equal(next.finals, "다음");
  // A message that is still only a hypothesis does not consume the drop.
  const waiting = consumeSonioxTranscript([{ text: "아직", is_final: false }], true);
  assert.equal(waiting.dropPendingFinals, true);
  assert.equal(waiting.interim, "아직");
});

test("the start message hints Korean by default and never carries an api key", () => {
  const config = sonioxStartConfig({ language: "ko", terms: ["수식시작", "분의"] });
  assert.equal(config.model, "stt-rt-v5");
  assert.equal(config.audio_format, "pcm_s16le");
  assert.equal(config.sample_rate, 16000);
  assert.deepEqual(config.language_hints, ["ko"]);
  assert.equal(config.enable_endpoint_detection, true);
  assert.deepEqual(config.context.terms, ["수식시작", "분의"]);
  assert.equal("api_key" in config, false);
  assert.deepEqual(sonioxStartConfig({ language: "en" }).language_hints, ["en"]);
  assert.deepEqual(sonioxStartConfig({ language: "ja" }).language_hints, ["ja"]);
  assert.deepEqual(sonioxStartConfig({ language: "xx" }).language_hints, ["ko"]);
  assert.equal("context" in sonioxStartConfig({ language: "ko", terms: [] }), false);
  assert.equal("max_endpoint_delay_ms" in sonioxStartConfig({ language: "ko" }), false);
  assert.equal(sonioxStartConfig({ language: "ko", maxEndpointDelayMs: 800 }).max_endpoint_delay_ms, 800);
});

test("spoken-math terms are the spoken side, trimmed under the context cap", () => {
  const phrases = spokenPhrasesFromCsv("# comment\n수식시작, $$\n과, ,\n\n분의, {2} / {1}\n수식시작, $$\n");
  assert.deepEqual(phrases, ["수식시작", "과", "분의", "수식시작"]);
  assert.deepEqual(limitContextTerms(phrases), ["수식시작", "과", "분의"]);
  const limited = limitContextTerms(["하나", "둘", "셋"], 8);
  assert.deepEqual(limited, ["하나"]);
  assert.ok(limited.join("").length <= 8);
});

test("pcm16 clamps and downsamples 48 kHz to 16 kHz", () => {
  assert.equal(floatToPcm16(new Float32Array(), 48000).byteLength, 0);
  const unit = new Int16Array(floatToPcm16(Float32Array.of(1, -1, 0), 16000, 16000));
  assert.deepEqual([...unit], [32767, -32768, 0]);
  const input = new Float32Array(48);
  input.fill(0.5);
  const down = new Int16Array(floatToPcm16(input, 48000, 16000));
  assert.equal(down.length, 16);
  assert.ok(down.every((sample) => sample === Math.round(0.5 * 0x7fff)));
});

import assert from "node:assert/strict";
import test from "node:test";
import { enginesOffered, normalizeStoredEngine, resolveDictationEngine } from "./dictation-engine.mjs";

test("a stored realtime choice is OpenAI, and the default is built-in", () => {
  assert.equal(normalizeStoredEngine("realtime"), "openai");
  assert.equal(normalizeStoredEngine("openai"), "openai");
  assert.equal(normalizeStoredEngine("soniox"), "soniox");
  assert.equal(normalizeStoredEngine(null), "builtin");
  assert.equal(normalizeStoredEngine("nope"), "builtin");
});

test("Soniox is offered only when its key is configured", () => {
  assert.deepEqual(enginesOffered({ webSpeech: true, openai: true, soniox: false }), ["builtin", "openai"]);
  assert.deepEqual(enginesOffered({ webSpeech: true, openai: true, soniox: true }), ["builtin", "openai", "soniox"]);
  assert.deepEqual(enginesOffered({ webSpeech: false, openai: false, soniox: true }), ["soniox"]);
});

test("the microphone keeps Web Speech unless the user picked a realtime engine", () => {
  const both = { webSpeech: true, openai: true, soniox: true, kind: "mic" };
  assert.equal(resolveDictationEngine({ ...both, stored: "builtin" }), "builtin");
  assert.equal(resolveDictationEngine({ ...both, stored: null }), "builtin");
  assert.equal(resolveDictationEngine({ ...both, stored: "realtime" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "openai" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "soniox" }), "soniox");
});

test("without Web Speech the microphone falls through to OpenAI, then Soniox", () => {
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: false, openai: true, soniox: true, kind: "mic" }), "openai");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: false, openai: false, soniox: true, kind: "mic" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "soniox", webSpeech: true, openai: true, soniox: false, kind: "mic" }), "builtin");
  assert.equal(resolveDictationEngine({ stored: "openai", webSpeech: false, openai: false, soniox: true, kind: "mic" }), "soniox");
});

test("a file never uses Web Speech and stays on OpenAI unless Soniox was picked", () => {
  const both = { webSpeech: true, openai: true, soniox: true, kind: "file" };
  assert.equal(resolveDictationEngine({ ...both, stored: "builtin" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "realtime" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "soniox" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: true, openai: false, soniox: true, kind: "file" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: true, openai: false, soniox: false, kind: "file" }), null);
});

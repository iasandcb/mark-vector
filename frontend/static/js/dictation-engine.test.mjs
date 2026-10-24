import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  effectiveDictationEngine,
  enginesOffered,
  fileEngineDetailKey,
  fileEngineNoticeKey,
  normalizeStoredEngine,
  resolveDictationEngine,
} from "./dictation-engine.mjs";

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

test("without Web Speech the microphone uses Soniox, then OpenAI", () => {
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: false, openai: true, soniox: true, kind: "mic" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: false, openai: true, soniox: false, kind: "mic" }), "openai");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: false, openai: false, soniox: true, kind: "mic" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "soniox", webSpeech: true, openai: true, soniox: false, kind: "mic" }), "builtin");
  assert.equal(resolveDictationEngine({ stored: "openai", webSpeech: false, openai: false, soniox: true, kind: "mic" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "openai", webSpeech: false, openai: true, soniox: true, kind: "mic" }), "openai");
});

test("a file never uses Web Speech and prefers Soniox unless OpenAI was picked", () => {
  const both = { webSpeech: true, openai: true, soniox: true, kind: "file" };
  assert.equal(resolveDictationEngine({ ...both, stored: "builtin" }), "soniox");
  assert.equal(resolveDictationEngine({ ...both, stored: "realtime" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "openai" }), "openai");
  assert.equal(resolveDictationEngine({ ...both, stored: "soniox" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: true, openai: true, soniox: false, kind: "file" }), "openai");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: true, openai: false, soniox: true, kind: "file" }), "soniox");
  assert.equal(resolveDictationEngine({ stored: "builtin", webSpeech: true, openai: false, soniox: false, kind: "file" }), null);
});

test("the file bar names the paid engine a built-in choice will actually use", () => {
  const builtin = { stored: "builtin", webSpeech: true };
  assert.equal(fileEngineNoticeKey(resolveDictationEngine({ ...builtin, openai: true, soniox: true, kind: "file" })), "editor.audioFileEngineSoniox");
  assert.equal(fileEngineDetailKey(resolveDictationEngine({ ...builtin, openai: true, soniox: true, kind: "file" })), "editor.audioFileTitleSoniox");
  assert.equal(fileEngineNoticeKey(resolveDictationEngine({ ...builtin, openai: true, soniox: false, kind: "file" })), "editor.audioFileEngineOpenai");
  assert.equal(fileEngineDetailKey(resolveDictationEngine({ ...builtin, openai: true, soniox: false, kind: "file" })), "editor.audioFileTitle");
  assert.equal(fileEngineNoticeKey(resolveDictationEngine({ ...builtin, openai: false, soniox: false, kind: "file" })), "editor.audioFileEngineNone");
  assert.equal(fileEngineNoticeKey(resolveDictationEngine({ stored: "openai", webSpeech: true, openai: true, soniox: true, kind: "file" })), "editor.audioFileEngineOpenai");
  assert.equal(fileEngineNoticeKey(resolveDictationEngine({ stored: "soniox", webSpeech: true, openai: true, soniox: true, kind: "file" })), "editor.audioFileEngineSoniox");
});

test("file-engine notices exist in every UI language", () => {
  const src = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
  for (const key of ["editor.audioFileEngineSoniox", "editor.audioFileEngineOpenai", "editor.audioFileEngineNone"]) {
    assert.equal(src.split(`"${key}"`).length - 1, 3, key);
  }
  assert.equal(src.includes("파일 전사: Soniox (유료)"), true);
  assert.equal(src.includes("파일 전사: OpenAI (유료)"), true);
});

test("the engine icon is the provider that will actually run", () => {
  const both = { webSpeech: true, openai: true, soniox: true };
  assert.equal(effectiveDictationEngine({ ...both, stored: "builtin", fileRunning: false }), "builtin");
  assert.equal(effectiveDictationEngine({ ...both, stored: "builtin", fileRunning: true }), "soniox");
  assert.equal(effectiveDictationEngine({ stored: "builtin", webSpeech: false, openai: true, soniox: true, fileRunning: false }), "soniox");
  assert.equal(effectiveDictationEngine({ stored: "builtin", webSpeech: false, openai: true, soniox: false, fileRunning: false }), "openai");
  assert.equal(effectiveDictationEngine({ ...both, stored: "openai", fileRunning: true }), "openai");
  assert.equal(effectiveDictationEngine({ ...both, stored: "realtime", fileRunning: true }), "openai");
});

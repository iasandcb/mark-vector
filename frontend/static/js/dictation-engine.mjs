// Which dictation engine the 🎤 button and "재생하며 전사" use.
//
// `builtin` is the browser's Web Speech API. It only hears the microphone,
// so a file never uses it. `openai` is gpt-live-transcribe (the value
// previously stored as "realtime"). `soniox` is stt-rt-v5. Stored "realtime"
// still means OpenAI, so a browser that picked it before keeps that choice.
// The default stored value is builtin. Where Web Speech does not work, the
// microphone uses Soniox if that key exists, and OpenAI only otherwise.
// A file with the built-in choice does the same: Soniox, then OpenAI.
// An explicit OpenAI choice stays on OpenAI.

export function normalizeStoredEngine(stored) {
  if (stored === "realtime" || stored === "openai") return "openai";
  if (stored === "soniox") return "soniox";
  return "builtin";
}

export function enginesOffered({ webSpeech, openai, soniox }) {
  const offered = [];
  if (webSpeech) offered.push("builtin");
  if (openai) offered.push("openai");
  if (soniox) offered.push("soniox");
  return offered;
}

export function resolveDictationEngine({ stored, webSpeech, openai, soniox, kind }) {
  const choice = normalizeStoredEngine(stored);
  const file = kind === "file";
  if (choice === "openai" && openai) return "openai";
  if (choice === "soniox" && soniox) return "soniox";
  if (!file && choice === "builtin" && webSpeech) return "builtin";
  // The named engine cannot run: a file, no Web Speech, or that key is
  // unset. Soniox, then OpenAI. Web Speech still wins when an explicit
  // realtime engine is the one that is missing.
  const order = [];
  if (!file && webSpeech && choice !== "builtin") order.push("builtin");
  if (soniox && choice !== "soniox") order.push("soniox");
  if (openai && choice !== "openai") order.push("openai");
  return order[0] || null;
}

// The glyph next to the language select. `stored` is the remembered
// preference. While a file is being transcribed, the icon is that file's
// engine. Otherwise it is the microphone engine that would run now.
export function effectiveDictationEngine({ stored, webSpeech, openai, soniox, fileRunning = false }) {
  return resolveDictationEngine({ stored, webSpeech, openai, soniox, kind: fileRunning ? "file" : "mic" });
}

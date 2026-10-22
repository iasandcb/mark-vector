// Which dictation engine the 🎤 button and "재생하며 전사" use.
//
// `builtin` is the browser's Web Speech API. It only hears the microphone,
// so a file never uses it. `openai` is gpt-live-transcribe (the value
// previously stored as "realtime"). `soniox` is stt-rt-v5. Stored "realtime"
// still means OpenAI, so a browser that picked it before keeps that choice.
// The default stored value is builtin. Where Web Speech does not work, the
// microphone falls through to OpenAI, then Soniox. A file uses OpenAI
// unless the user picked Soniox (or OpenAI is unset and Soniox is set).

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
  if (kind === "file") {
    if (choice === "soniox" && soniox) return "soniox";
    if (openai) return "openai";
    if (soniox) return "soniox";
    return null;
  }
  if (choice === "builtin" && webSpeech) return "builtin";
  if (choice === "openai" && openai) return "openai";
  if (choice === "soniox" && soniox) return "soniox";
  if (webSpeech) return "builtin";
  if (openai) return "openai";
  if (soniox) return "soniox";
  return null;
}

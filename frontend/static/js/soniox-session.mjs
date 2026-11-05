// Pure pieces of the Soniox realtime session: token assembly, the start
// message, spoken-math terms, and PCM downsampling. The browser socket
// lives in soniox-stt.js. No DOM, so node --test can import this.
//
// Each websocket message carries only the new final tokens (once) plus the
// current non-final hypothesis (replaced every message). Joining token.text
// as-is keeps the space tokens Soniox sends on their own.

export const SONIOX_MODEL = "stt-rt-v6";
export const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_SAMPLE_RATE = 16000;
// Stay under Soniox's context cap (~10k characters / ~8k tokens).
export const SONIOX_TERMS_CHAR_LIMIT = 8000;
const LANGUAGE_HINTS = new Set(["ko", "en", "ja"]);
// Stream markers, not speech. `<end>` is endpoint detection and `<fin>`
// is manual finalization. They sometimes arrive glued to a word.
export function stripSonioxControlTokens(text) {
  if (typeof text !== "string" || text === "") return "";
  return text.replace(/<(?:fin|end)>/gi, "");
}

export function renderSonioxMessage(tokens) {
  let finals = "";
  let interim = "";
  for (const token of tokens || []) {
    if (!token || typeof token.text !== "string") continue;
    const text = stripSonioxControlTokens(token.text);
    if (text === "") continue;
    if (token.is_final) finals += text;
    else interim += text;
  }
  return { finals, interim };
}

// After a caret move, the phrase already on screen must not be written
// again when manual finalize turns it into final tokens. The first message
// that carries finals is that ack; later finals are new speech.
export function consumeSonioxTranscript(tokens, dropPendingFinals) {
  const rendered = renderSonioxMessage(tokens);
  if (dropPendingFinals && rendered.finals) {
    return { finals: "", interim: rendered.interim, dropPendingFinals: false };
  }
  return { finals: rendered.finals, interim: rendered.interim, dropPendingFinals: !!dropPendingFinals };
}

export function sonioxStartConfig({ language, terms, sampleRate = SONIOX_SAMPLE_RATE, maxEndpointDelayMs } = {}) {
  const hint = LANGUAGE_HINTS.has(language) ? language : "ko";
  const config = {
    model: SONIOX_MODEL,
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
    language_hints: [hint],
    enable_endpoint_detection: true,
  };
  // Dictation leaves Soniox's default (2000ms). A discussion can ask for a
  // shorter cap so `<end>` usually arrives before the silence fallback.
  if (maxEndpointDelayMs) config.max_endpoint_delay_ms = maxEndpointDelayMs;
  if (terms && terms.length) config.context = { terms };
  return config;
}

// Left column of spoken-math.csv ("말, 기호"). The symbol side is applied
// after transcription, so it is not sent as a recognizer term.
export function spokenPhrasesFromCsv(csv) {
  const phrases = [];
  for (const line of String(csv || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const comma = trimmed.indexOf(",");
    const phrase = (comma < 0 ? trimmed : trimmed.slice(0, comma)).trim();
    if (phrase) phrases.push(phrase);
  }
  return phrases;
}

export function limitContextTerms(phrases, maxChars = SONIOX_TERMS_CHAR_LIMIT) {
  const terms = [];
  const seen = new Set();
  let used = 0;
  for (const raw of phrases || []) {
    const term = String(raw ?? "").trim();
    if (!term || seen.has(term)) continue;
    const cost = term.length + 3;
    if (terms.length && used + cost > maxChars) break;
    if (!terms.length && term.length > maxChars) break;
    seen.add(term);
    terms.push(term);
    used += cost;
  }
  return terms;
}

// Average groups of samples down to 16 kHz and clamp to signed 16-bit.
export function floatToPcm16(float32, inRate, outRate = SONIOX_SAMPLE_RATE) {
  const input = float32 || [];
  if (!input.length || !inRate || !outRate) return new ArrayBuffer(0);
  const ratio = inRate / outRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    const sample = count ? sum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out.buffer;
}

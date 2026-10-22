// When a spoken discussion turn is ready to send to the text model.
// Soniox already runs with endpoint detection (soniox-session.mjs). `<end>`
// is that signal: it is stripped from the words the person sees, and it
// sends the turn immediately. `<fin>` is manual finalization — logged, not
// a send. A period is not a send. If `<end>` never arrives, the turn goes
// out after `silenceMs` with no new final tokens and no revised hypothesis.
//
// No DOM and no socket, so a test can feed token messages and a clock.

import { renderSonioxMessage } from "./soniox-session.mjs";

export const DEFAULT_SILENCE_MS = 1500;

const END_RE = /<end>/i;
const FIN_RE = /<fin>/i;

export function sonioxMarkerInfo(tokens) {
  let end = false;
  let fin = false;
  const raw = [];
  for (const token of tokens || []) {
    const text = token && typeof token.text === "string" ? token.text : "";
    if (!text) continue;
    const hasEnd = END_RE.test(text);
    const hasFin = FIN_RE.test(text);
    if (hasEnd) end = true;
    if (hasFin) fin = true;
    if (hasEnd || hasFin) raw.push(text);
  }
  return { end, fin, raw };
}

function joinUtterance(left, right) {
  const a = left || "";
  const b = right || "";
  if (!a) return b.trim();
  if (!b) return a.trim();
  if (/\s$/.test(a) || /^\s/.test(b)) return `${a}${b}`.trim();
  return `${a} ${b}`.trim();
}

// Finals that only confirm the tail already sent (the hypothesis we included
// on a silence send) are not a new utterance. Soniox often finalizes that
// tail a moment later, together with `<end>`.
// `matched` means `incoming` is the echo, a prefix of it, or an extension of it.
// A mismatch leaves `echo` untouched so the caller can ignore a stray
// hypothesis without forgetting the tail the finals still have to confirm.
export function absorbEcho(echo, incoming) {
  const pending = echo || "";
  const text = incoming || "";
  if (!text) return { echo: pending, extra: "", matched: true };
  if (!pending) return { echo: "", extra: text, matched: false };
  if (pending.startsWith(text)) return { echo: pending.slice(text.length), extra: "", matched: true };
  if (text.startsWith(pending)) return { echo: "", extra: text.slice(pending.length), matched: true };
  return { echo: pending, extra: text, matched: false };
}

function createBuffer() {
  let finals = "";
  let interim = "";
  let armedAt = null;
  return {
    push(finalText, interimText, at) {
      const interimBefore = interim;
      if (finalText) {
        finals += finalText;
        armedAt = at;
      }
      interim = interimText || "";
      // A hypothesis that is still changing means the phrase is not over.
      if (!finalText && interim && interim !== interimBefore) armedAt = at;
      if (!this.text()) armedAt = null;
    },
    due(at, silenceMs) {
      return armedAt != null && at - armedAt >= silenceMs;
    },
    take() {
      const value = this.text();
      const echoedInterim = interim;
      finals = "";
      interim = "";
      armedAt = null;
      return { value, echoedInterim };
    },
    text() {
      return `${finals}${interim}`.trim();
    },
  };
}

// `push(tokens, at)` / `tick(at)` / `sendNow()` return events:
//   { type: "partial", text }
//   { type: "abort", requestId }
//   { type: "send", text, reason, requestId, merged }
// `settle(requestId)` marks a request finished so the next phrase is its own turn.
// `log` receives `{ kind: "marker"|"turn", ... }` — the pane prints these so a
// live session can show whether `<end>` actually arrived.
export function createDiscussionController({ silenceMs = DEFAULT_SILENCE_MS, log = () => {} } = {}) {
  const buffer = createBuffer();
  let silence = silenceMs;
  let phase = "idle";
  let requestId = 0;
  let sentText = "";
  let pendingEcho = "";
  const stats = { end: 0, fin: 0, endpointSends: 0, silenceSends: 0, manualSends: 0 };

  function noteMarkers(markers, at) {
    if (!markers.end && !markers.fin) return;
    if (markers.end) stats.end += 1;
    if (markers.fin) stats.fin += 1;
    log({ kind: "marker", at, end: markers.end, fin: markers.fin, raw: markers.raw, stats: { ...stats } });
  }

  function partialEvent() {
    if (phase === "sending") return { type: "partial", text: "" };
    const live = phase === "hearing" ? joinUtterance(sentText, buffer.text()) : buffer.text();
    return { type: "partial", text: live };
  }

  function beginSend(text, reason, merged) {
    requestId += 1;
    phase = "sending";
    sentText = text;
    if (reason === "endpoint") stats.endpointSends += 1;
    if (reason === "silence") stats.silenceSends += 1;
    if (reason === "manual") stats.manualSends += 1;
    log({ kind: "turn", reason, chars: text.length, merged: !!merged, stats: { ...stats } });
    return { type: "send", text, reason, requestId, merged: !!merged };
  }

  function flush(reason, echoedInterim) {
    const spoken = buffer.take();
    const merge = phase === "hearing" ? sentText : "";
    const text = joinUtterance(merge, spoken.value);
    pendingEcho = spoken.echoedInterim || echoedInterim || "";
    if (!text) {
      if (phase !== "sending") phase = buffer.text() ? "hearing" : "idle";
      return [];
    }
    return [beginSend(text, reason, !!merge)];
  }

  return {
    setSilenceMs(ms) {
      if (Number.isFinite(ms) && ms > 0) silence = ms;
    },
    silenceMs() {
      return silence;
    },
    stats() {
      return { ...stats };
    },
    settle(id) {
      if (id !== requestId || phase !== "sending") return;
      phase = "idle";
      sentText = "";
      // Keep pendingEcho. The recognizer may still finalize the tail we
      // already sent; dropping it here would send that tail again.
    },
    push(tokens, at) {
      const markers = sonioxMarkerInfo(tokens);
      noteMarkers(markers, at);
      const rendered = renderSonioxMessage(tokens);
      const eatenFinals = absorbEcho(pendingEcho, rendered.finals);
      if (rendered.finals) pendingEcho = eatenFinals.matched ? eatenFinals.echo : "";
      // Interim never consumes the echo. Finals still have to confirm it,
      // and a later `<end>` often arrives in that same breath.
      const eatenInterim = absorbEcho(pendingEcho, rendered.interim);
      const interimExtra = eatenInterim.matched ? eatenInterim.extra : rendered.interim;
      const before = buffer.text();
      buffer.push(eatenFinals.extra, interimExtra, at);
      const speech = buffer.text();
      const grew = speech !== before && speech.length > 0;
      const events = [];
      if (phase === "sending" && grew) {
        events.push({ type: "abort", requestId });
        phase = "hearing";
      } else if (phase === "idle" && speech) {
        phase = "hearing";
      }
      if (markers.end) {
        if (!(phase === "sending" && !speech)) events.push(...flush("endpoint"));
        events.push({ type: "partial", text: "" });
        return events;
      }
      events.push(partialEvent());
      return events;
    },
    tick(at) {
      if (!buffer.due(at, silence)) return [];
      if (phase === "sending" && !buffer.text()) return [];
      const events = flush("silence");
      if (!events.length) return [];
      events.push({ type: "partial", text: "" });
      return events;
    },
    sendNow() {
      if (!buffer.text()) return [];
      const events = flush("manual");
      if (!events.length) return [];
      events.push({ type: "partial", text: "" });
      return events;
    },
  };
}

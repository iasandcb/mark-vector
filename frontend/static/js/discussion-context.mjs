// What a voice-discussion turn sends instead of the whole document and the
// whole chat. The document edit protocol still has to see the text it is
// allowed to change, so a short document goes in full and a long one goes
// as an outline plus the passage nearest the latest remark.

export const FULL_DOCUMENT_CHARS = 8000;
export const EXCERPT_CHARS = 3500;
export const HISTORY_RECENT_TURNS = 6;
export const HISTORY_CHAR_BUDGET = 8000;
// Soniox realtime, about $0.12 per hour of audio sent. The text model's own
// price is whatever is selected in the toolbar and is not included.
export const SONIOX_HOURLY_USD = 0.12;
// A forgotten microphone. The temporary key itself allows three hours.
export const DISCUSS_MAX_MS = 60 * 60 * 1000;

export function documentOutline(content, limit = 40) {
  const lines = [];
  for (const line of String(content || "").split("\n")) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    lines.push(`${"  ".repeat(match[1].length - 1)}${match[2].trim()}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

function windowAround(content, index, size) {
  const half = Math.floor(size / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(content.length, start + size);
  start = Math.max(0, end - size);
  if (start > 0) {
    const nl = content.lastIndexOf("\n", start);
    if (nl !== -1 && start - nl < 120) start = nl + 1;
  }
  if (end < content.length) {
    const nl = content.indexOf("\n", end);
    if (nl !== -1 && nl - end < 120) end = nl;
  }
  return content.slice(start, end);
}

export function discussionDocumentView(content, utterance = "") {
  const text = String(content || "");
  const outline = documentOutline(text);
  if (text.length <= FULL_DOCUMENT_CHARS) return { mode: "full", outline, body: text };
  const words = String(utterance || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const lower = text.toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = lower.indexOf(word);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at < 0) at = 0;
  return { mode: "excerpt", outline, body: windowAround(text, at, EXCERPT_CHARS) };
}

export function formatDocumentContext(view) {
  const outline = view.outline.length ? view.outline.map((line) => `- ${line}`).join("\n") : "(no headings)";
  if (view.mode === "full") return `Outline:\n${outline}\n\n${view.body}`;
  return (
    `Outline:\n${outline}\n\n` +
    "The passage below is only part of a longer document. Edit only text that appears in the passage.\n\n" +
    view.body
  );
}

function summaryLine(turn) {
  const who = turn.role === "user" ? "User" : "Assistant";
  const text = String(turn.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
  return `${who}: ${text}`;
}

// Recent turns stay verbatim. Older ones become a short extractive summary
// so a long talk does not resend every sentence. Not a second model call.
export function boundDiscussionHistory(turns, { recent = HISTORY_RECENT_TURNS, budget = HISTORY_CHAR_BUDGET } = {}) {
  const clean = (turns || []).filter(
    (turn) => turn && (turn.role === "user" || turn.role === "assistant") && String(turn.content || "").trim(),
  );
  const older = clean.slice(0, Math.max(0, clean.length - recent));
  let history = clean.slice(Math.max(0, clean.length - recent)).map((turn) => ({
    role: turn.role,
    content: String(turn.content).trim(),
  }));
  let summary = older.map(summaryLine).join("\n");
  while (history.reduce((sum, turn) => sum + turn.content.length, 0) > budget && history.length > 1) {
    summary = summary ? `${summary}\n${summaryLine(history[0])}` : summaryLine(history[0]);
    history = history.slice(1);
  }
  if (summary.length > 4000) summary = summary.slice(summary.length - 4000);
  return { history, summary };
}

export function formatDiscussMeter(elapsedMs, hourly = SONIOX_HOURLY_USD) {
  const elapsed = Math.max(0, elapsedMs || 0);
  const total = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  const usd = (elapsed / 3600000) * hourly;
  const cost = usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
  return { time: `${mm}:${ss}`, cost };
}

export function discussExpired(elapsedMs, maxMs = DISCUSS_MAX_MS) {
  return (elapsedMs || 0) >= maxMs;
}

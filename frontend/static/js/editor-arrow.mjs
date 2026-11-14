// Caret motion for an arrow that never reached the editor as a keydown.
// Android Chrome eats DPAD keys once the Gamepad API is active (see
// gamepad-arrows.mjs) and sometimes delivers the same press with keyCode
// 19-22 and key "Unidentified", which CodeMirror does not treat as an arrow.
// Horizontal steps follow UTF-16 code points. Vertical steps follow logical
// lines, keeping the column; CodeMirror's own keymap still handles a normal
// Arrow* key, including wrapped visual lines.

const DPAD_KEYCODES = { 19: "ArrowUp", 20: "ArrowDown", 21: "ArrowLeft", 22: "ArrowRight" };

// Long enough that the gamepad sample of one physical press (the next
// animation frame) does not move the caret a second time, and shorter than
// the hold-to-repeat delay in gamepad-arrows.mjs.
export const ARROW_ECHO_MS = 150;

export function arrowFromKeyEvent(event) {
  if (!event || event.altKey || event.metaKey || event.ctrlKey) return null;
  if (/^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) return event.key;
  return DPAD_KEYCODES[event.keyCode] || null;
}

function clamp(text, pos) {
  const n = Number.isFinite(pos) ? pos : 0;
  return Math.max(0, Math.min(text.length, n));
}

function stepCodePoint(text, pos, dir) {
  if (dir < 0) {
    if (pos <= 0) return 0;
    const prev = pos - 1;
    const prevCode = text.charCodeAt(prev);
    if (prevCode >= 0xdc00 && prevCode <= 0xdfff && prev > 0) {
      const high = text.charCodeAt(prev - 1);
      if (high >= 0xd800 && high <= 0xdbff) return pos - 2;
    }
    return prev;
  }
  if (pos >= text.length) return text.length;
  const code = text.charCodeAt(pos);
  if (code >= 0xd800 && code <= 0xdbff && pos + 1 < text.length) return pos + 2;
  return pos + 1;
}

function stepLine(text, pos, dir) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = text.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = text.length;
  const column = pos - lineStart;
  if (dir < 0) {
    if (lineStart === 0) return 0;
    const prevEnd = lineStart - 1;
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    return Math.min(prevStart + column, prevEnd);
  }
  if (lineEnd === text.length) return text.length;
  const nextStart = lineEnd + 1;
  let nextEnd = text.indexOf("\n", nextStart);
  if (nextEnd === -1) nextEnd = text.length;
  return Math.min(nextStart + column, nextEnd);
}

// Collapses onto `head` and steps once. `head` is the caret CodeMirror
// keeps (not the min of the selection).
export function moveCaret(text, anchor, head, key) {
  const doc = String(text ?? "");
  const caret = clamp(doc, head);
  let next = caret;
  if (key === "ArrowLeft") next = stepCodePoint(doc, caret, -1);
  else if (key === "ArrowRight") next = stepCodePoint(doc, caret, 1);
  else if (key === "ArrowUp") next = stepLine(doc, caret, -1);
  else if (key === "ArrowDown") next = stepLine(doc, caret, 1);
  else next = clamp(doc, anchor);
  return { anchor: next, head: next };
}

// One physical arrow can arrive twice: as a keydown and, a frame later, as
// a gamepad D-pad sample. The first one moves the caret; the other is dropped.
// A later repeat is a new move because the hold delay is longer than the window.
export function createArrowEcho() {
  let last = null;
  return {
    claimKey(key, now) {
      if (last && last.key === key && last.source === "pad" && now - last.at < ARROW_ECHO_MS) return false;
      last = { key, at: now, source: "key" };
      return true;
    },
    claimPad(key, now) {
      if (last && last.key === key && last.source === "key" && now - last.at < ARROW_ECHO_MS) return false;
      last = { key, at: now, source: "pad" };
      return true;
    },
  };
}

// "native": the event is already Arrow*, so the editor's keymap moves the caret.
// "move": a DPAD keyCode the keymap will not recognize.
// "swallow": the gamepad path already moved for this press.
export function editorArrowPlan(event, echo, now) {
  // nudgeCaret dispatches an untrusted Arrow key so CodeMirror can do the
  // move (wrapped lines included). That event must not be claimed as a
  // second press, and must not be cancelled before the keymap sees it.
  if (event && event.isTrusted === false) return { type: "ignore" };
  const key = arrowFromKeyEvent(event);
  if (!key) return { type: "ignore" };
  if (!echo.claimKey(key, now)) return { type: "swallow", key };
  if (event.key === key) return { type: "native", key };
  return { type: "move", key };
}

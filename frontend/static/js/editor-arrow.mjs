// Caret motion for an arrow that never reached the editor as a keydown.
// Android Chrome eats DPAD keys once the Gamepad API is active (see
// gamepad-arrows.mjs), including Shift/Ctrl/Alt+arrow, and sometimes
// delivers the same press as keyCode 19-22 with key "Unidentified".
// The Shift key itself still arrives, so a latch remembers it and the
// gamepad sample extends the selection the way CodeMirror's keymap does.
// Horizontal steps follow UTF-16 code points. Vertical steps follow logical
// lines. A normal Arrow* keydown is left to CodeMirror, which also handles
// wrapped visual lines.

const DPAD_KEYCODES = { 19: "ArrowUp", 20: "ArrowDown", 21: "ArrowLeft", 22: "ArrowRight" };
// Android's keyboard Home/End. KEYCODE_HOME (3) is the system Home button
// and never reaches the page; MOVE_HOME/MOVE_END are the editing keys.
const NAV_KEYCODES = { 122: "Home", 123: "End" };
const MODIFIER_KEYS = { Shift: "shift", Control: "ctrl", Alt: "alt", Meta: "meta" };
const MODIFIER_KEYCODES = { 16: "shift", 17: "ctrl", 18: "alt", 91: "meta", 92: "meta" };

// Long enough that the gamepad sample of one physical press (the next
// animation frame) does not move the caret a second time, and shorter than
// the hold-to-repeat delay in gamepad-arrows.mjs.
export const ARROW_ECHO_MS = 150;

const EMPTY_MODIFIERS = Object.freeze({ shift: false, ctrl: false, alt: false, meta: false });

export function eventModifiers(event) {
  return {
    shift: !!event?.shiftKey,
    ctrl: !!event?.ctrlKey,
    alt: !!event?.altKey,
    meta: !!event?.metaKey,
  };
}

export function arrowFromKeyEvent(event) {
  if (!event) return null;
  if (/^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) return event.key;
  if (event.key === "Home" || event.key === "End") return event.key;
  return DPAD_KEYCODES[event.keyCode] || NAV_KEYCODES[event.keyCode] || null;
}

// Shift/Ctrl/Alt are not DPAD keys, so Chrome still delivers them while it
// swallows the arrow they modify. The arrow sample then reads the latch.
export function createModifierLatch() {
  const down = { shift: false, ctrl: false, alt: false, meta: false };
  return {
    note(event) {
      if (!event || event.isTrusted === false) return;
      const named = MODIFIER_KEYS[event.key] || (event.key === "Unidentified" ? MODIFIER_KEYCODES[event.keyCode] : null);
      if (named) {
        down[named] = event.type !== "keyup";
        return;
      }
      if (event.type !== "keydown" && event.type !== "keyup") return;
      down.shift = !!event.shiftKey;
      down.ctrl = !!event.ctrlKey;
      down.alt = !!event.altKey;
      down.meta = !!event.metaKey;
    },
    snapshot() {
      return { shift: down.shift, ctrl: down.ctrl, alt: down.alt, meta: down.meta };
    },
    clear() {
      down.shift = down.ctrl = down.alt = down.meta = false;
    },
  };
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

function categoryAt(text, pos) {
  const cp = text.codePointAt(pos);
  if (cp === 9 || cp === 10 || cp === 11 || cp === 12 || cp === 13 || cp === 32 || cp === 160) return "space";
  if (/[\p{L}\p{N}_]/u.test(String.fromCodePoint(cp))) return "word";
  return "other";
}

// CodeMirror's group motion: a run of one category, and a space run is
// taken together with the group on its far side.
function stepGroup(text, pos, dir) {
  if (dir < 0) {
    if (pos <= 0) return 0;
    let i = stepCodePoint(text, pos, -1);
    let cat = categoryAt(text, i);
    while (i > 0) {
      const prev = stepCodePoint(text, i, -1);
      if (categoryAt(text, prev) !== cat) break;
      i = prev;
    }
    if (cat === "space" && i > 0) {
      i = stepCodePoint(text, i, -1);
      cat = categoryAt(text, i);
      while (i > 0) {
        const prev = stepCodePoint(text, i, -1);
        if (categoryAt(text, prev) !== cat) break;
        i = prev;
      }
    }
    return i;
  }
  if (pos >= text.length) return text.length;
  let cat = categoryAt(text, pos);
  let i = stepCodePoint(text, pos, 1);
  if (cat === "space") {
    while (i < text.length && categoryAt(text, i) === "space") i = stepCodePoint(text, i, 1);
    if (i >= text.length) return text.length;
    cat = categoryAt(text, i);
    i = stepCodePoint(text, i, 1);
  }
  while (i < text.length && categoryAt(text, i) === cat) i = stepCodePoint(text, i, 1);
  return i;
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

function lineEdge(text, pos, end) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  if (!end) {
    const indent = text.slice(lineStart).match(/^[ \t]*/)[0].length;
    if (indent && pos !== lineStart + indent) return lineStart + indent;
    return lineStart;
  }
  const lineEnd = text.indexOf("\n", pos);
  return lineEnd === -1 ? text.length : lineEnd;
}

// Lines touched by the selection. A caret sitting on the newline at the
// start of a line does not include that line when the selection is wider.
function lineBlock(text, anchor, head) {
  const from = Math.min(anchor, head);
  let to = Math.max(anchor, head);
  if (from !== to && to > 0 && text.lastIndexOf("\n", to - 1) + 1 === to) to -= 1;
  const start = text.lastIndexOf("\n", from - 1) + 1;
  let end = text.indexOf("\n", to);
  if (end === -1) end = text.length;
  return { from: start, to: end };
}

function place(anchor, head, shift, next) {
  return shift ? { anchor, head: next } : { anchor: next, head: next };
}

// Alt+Up/Down is CodeMirror's move/copy line. `copy` is Shift+Alt.
function moveLines(text, anchor, head, forward, copy) {
  const block = lineBlock(text, anchor, head);
  if (copy) {
    const chunk = text.slice(block.from, block.to);
    if (forward) {
      const insert = `${chunk}\n`;
      return { anchor: anchor + insert.length, head: head + insert.length, changes: [{ from: block.from, insert }] };
    }
    return { anchor, head, changes: [{ from: block.to, insert: `\n${chunk}` }] };
  }
  if (forward) {
    if (block.to === text.length) return { anchor, head };
    const nextStart = block.to + 1;
    let nextTo = text.indexOf("\n", nextStart);
    if (nextTo === -1) nextTo = text.length;
    const nextText = text.slice(nextStart, nextTo);
    const size = nextText.length + 1;
    const map = (pos) => Math.min(text.length, pos + size);
    return {
      anchor: map(anchor),
      head: map(head),
      changes: [
        { from: block.to, to: nextTo },
        { from: block.from, insert: `${nextText}\n` },
      ],
    };
  }
  if (block.from === 0) return { anchor, head };
  const prevEnd = block.from - 1;
  const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
  const prevText = text.slice(prevStart, prevEnd);
  const size = prevText.length + 1;
  return {
    anchor: anchor - size,
    head: head - size,
    changes: [
      { from: prevStart, to: block.from },
      { from: block.to, insert: `\n${prevText}` },
    ],
  };
}

// `head` is the caret CodeMirror keeps. Without Shift, a horizontal move
// on a selection collapses to that edge (CodeMirror's cursorByChar). With
// Shift, the anchor stays and the head moves. Ctrl/Meta+Left/Right moves
// by group; Ctrl/Meta+Up/Down and Ctrl/Meta+Home/End go to the document
// edge. Alt+Up/Down moves or copies the line and returns `changes`.
export function moveCaret(text, anchor, head, key, modifiers = EMPTY_MODIFIERS) {
  const doc = String(text ?? "");
  const a = clamp(doc, anchor);
  const h = clamp(doc, head);
  const shift = !!modifiers.shift;
  const alt = !!modifiers.alt;
  const docEdge = !!modifiers.ctrl || !!modifiers.meta;
  const from = Math.min(a, h);
  const to = Math.max(a, h);
  if (alt && !docEdge && (key === "ArrowUp" || key === "ArrowDown")) {
    return moveLines(doc, a, h, key === "ArrowDown", shift);
  }
  if (!shift && a !== h && (key === "ArrowLeft" || key === "ArrowRight")) {
    const edge = key === "ArrowLeft" ? from : to;
    return { anchor: edge, head: edge };
  }
  let next = h;
  if (key === "ArrowLeft") next = docEdge || alt ? stepGroup(doc, h, -1) : stepCodePoint(doc, h, -1);
  else if (key === "ArrowRight") next = docEdge || alt ? stepGroup(doc, h, 1) : stepCodePoint(doc, h, 1);
  else if (key === "ArrowUp") next = docEdge ? 0 : stepLine(doc, h, -1);
  else if (key === "ArrowDown") next = docEdge ? doc.length : stepLine(doc, h, 1);
  else if (key === "Home") next = docEdge ? 0 : lineEdge(doc, h, false);
  else if (key === "End") next = docEdge ? doc.length : lineEdge(doc, h, true);
  else return { anchor: a, head: h };
  return place(a, h, shift, next);
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

// "native": the event is already a key CodeMirror's keymap understands.
// "move": a DPAD/Home/End keyCode the keymap will not recognize.
// "swallow": the gamepad path already moved for this press.
export function editorArrowPlan(event, echo, now) {
  // nudgeCaret dispatches an untrusted Arrow key so CodeMirror can do the
  // move (wrapped lines, modifiers, move-line). That event must not be
  // claimed as a second press, and must not be cancelled before the keymap.
  if (event && event.isTrusted === false) return { type: "ignore" };
  const key = arrowFromKeyEvent(event);
  if (!key) return { type: "ignore" };
  if (!echo.claimKey(key, now)) return { type: "swallow", key };
  if (event.key === key) return { type: "native", key };
  return { type: "move", key, modifiers: eventModifiers(event) };
}

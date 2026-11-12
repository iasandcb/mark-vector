// What a plain Enter does in the editor.
//
// macOS Korean IME (한글) reports the Enter that should break the line as a
// composition key: `isComposing` and/or `keyCode` 229. CodeMirror drops those
// keys (it is still composing, and on Safari it also drops the Enter that
// arrives just after compositionend). A plain textarea still breaks the line,
// because Hangul does not use Enter to pick a conversion candidate the way
// Japanese does. Claiming that key with preventDefault and insertText makes
// it worse: during composition execCommand reports success and inserts
// nothing, and the editor then stops the event before CodeMirror sees it.
//
// Japanese/Chinese confirmation is left alone. Only a composition that is
// Hangul, or a line that already contains Hangul before the caret, becomes a
// newline. The second keydown macOS Chrome fires for the same physical Enter
// is swallowed for a few milliseconds so the line breaks once.

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;

// Long enough for the echo keydown of one physical Enter, short enough that
// a deliberate second press still breaks the line.
export const IME_ENTER_ECHO_MS = 80;

// Safari delivers compositionend, then the Enter keydown, a few milliseconds
// apart. The committed syllable is sometimes not in the document yet.
const RECENT_COMPOSITION_MS = 100;

export function lineIndentAt(value, cursorPos) {
  const text = String(value ?? "");
  const cursor = Math.max(0, Math.min(cursorPos ?? 0, text.length));
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  let lineEnd = text.indexOf("\n", cursor);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).match(/^[ \t]*/)[0];
}

export function lineHasHangulBeforeCursor(value, cursorPos) {
  const text = String(value ?? "");
  const cursor = Math.max(0, Math.min(cursorPos ?? 0, text.length));
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  return HANGUL.test(text.slice(lineStart, cursor));
}

export function isKoreanEnterContext(value, cursorPos, compositionData) {
  const data = compositionData || "";
  if (data.includes("\n") || data.includes("\r")) return false;
  if (HANGUL.test(data)) return true;
  return lineHasHangulBeforeCursor(value, cursorPos);
}

// The newline to insert after a Korean composition, including the line's
// indent, or null when this composition should not break the line.
export function newlineAfterKoreanComposition(value, cursorPos, compositionData) {
  if (!isKoreanEnterContext(value, cursorPos, compositionData)) return null;
  return "\n" + lineIndentAt(value, cursorPos);
}

// True when nothing since `beforeValue` has already broken the line, so the
// deferred Korean Enter still needs to insert one.
export function imeNewlineStillNeeded(beforeValue, afterValue) {
  const lines = (text) => String(text ?? "").split("\n").length;
  return lines(afterValue) <= lines(beforeValue);
}

function isImeEvent(event) {
  return !!(event.isComposing || event.keyCode === 229);
}

function isNewlineKey(event) {
  if (!event || event.metaKey || event.ctrlKey) return false;
  if (event.key === "Enter") return true;
  // macOS sometimes reports the confirming Enter as "Process" while `code`
  // stays Enter and keyCode stays 229.
  return (event.code === "Enter" || event.code === "NumpadEnter") && isImeEvent(event);
}

export function editorEnterPlan(event, { value = "", selectionStart = 0, compositionData = "", pendingIme = false } = {}, now = 0, echoUntil = 0) {
  if (!isNewlineKey(event)) return { type: "passthrough", prevent: false };
  if (echoUntil && now < echoUntil) return { type: "swallow", prevent: true };
  // The extra Enter macOS delivers before compositionend. Indent carry-over
  // must not grab it: execCommand during composition reports success and
  // inserts nothing, and preventDefault then leaves no newline at all.
  if (pendingIme && !event.isComposing) return { type: "swallow", prevent: true };

  const indent = lineIndentAt(value, selectionStart);
  const text = "\n" + indent;
  const ime = isImeEvent(event);
  if (ime && event.isComposing) return { type: "ime-defer", prevent: false };
  if (ime && isKoreanEnterContext(value, selectionStart, compositionData)) {
    return { type: "insert", prevent: true, text, direct: true };
  }
  if (ime) return { type: "passthrough", prevent: false };
  if (indent) return { type: "insert", prevent: true, text, direct: false };
  return { type: "native", prevent: false };
}

export function createEditorEnterController({ read, insert, now = () => 0, schedule = (fn) => fn(), hold = () => () => {} }) {
  let deferred = false;
  let deferredValue = "";
  let echoUntil = 0;
  let recentData = "";
  let recentAt = -1e15;
  let cancelDefer = () => {};

  const compositionData = () => (now() - recentAt < RECENT_COMPOSITION_MS ? recentData : "");

  return {
    keydown(event) {
      const doc = read();
      if (doc.disabled) return { type: "passthrough", prevent: false };
      const plan = editorEnterPlan(event, {
        value: doc.value,
        selectionStart: doc.selectionStart,
        compositionData: compositionData(),
        pendingIme: deferred,
      }, now(), echoUntil);
      if (plan.type === "ime-defer") {
        cancelDefer();
        deferred = true;
        deferredValue = doc.value;
        // If compositionend never arrives, forget this Enter before the next
        // syllable's compositionend can turn it into a surprise newline.
        cancelDefer = hold(() => {
          deferred = false;
        }, 500) || (() => {});
        return plan;
      }
      if (plan.type === "insert" && plan.direct) {
        insert(plan.text);
        echoUntil = now() + IME_ENTER_ECHO_MS;
      }
      return plan;
    },
    compositionend(event) {
      const data = (event && event.data) || "";
      recentData = data;
      recentAt = now();
      if (!deferred) return;
      cancelDefer();
      cancelDefer = () => {};
      deferred = false;
      const pendingValue = deferredValue;
      const doc = read();
      if (doc.disabled) return;
      if (newlineAfterKoreanComposition(doc.value, doc.selectionStart, data) != null) {
        echoUntil = now() + IME_ENTER_ECHO_MS;
      }
      schedule(() => {
        const current = read();
        if (current.disabled) return;
        if (!imeNewlineStillNeeded(pendingValue, current.value)) return;
        const text = newlineAfterKoreanComposition(current.value, current.selectionStart, data);
        if (text == null) return;
        echoUntil = now() + IME_ENTER_ECHO_MS;
        insert(text);
      });
    },
  };
}

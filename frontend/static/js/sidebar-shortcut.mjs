// ⌘/Ctrl+B toggles the navigation tree. ⌥⌘/Ctrl+Alt+B toggles the preview.
//
// Desktop browsers set `code` to "KeyB", which is what the chord matches,
// because Mac Option turns the key into "∫". Android Chrome leaves `code`
// empty (KeyboardEvent.code is disabled there). The letter is "b"/"B", or
// key "Unidentified" with the legacy keyCode 66 (DOM VK_B — the same value
// CodeMirror uses to recover a letter). ctrlKey on that letter is sometimes
// false even though the Control keydown was delivered; the caller passes
// the modifier latch for that. keyCode 229 with no letter is an IME
// composition key and is not this chord.
//
// Shift is excluded: Ctrl+Shift+B is the browser's bookmarks bar.

const DOM_VK_B = 66;

function isLetterB(event) {
  if (!event) return false;
  if (event.code === "KeyB") return true;
  // A different physical key, when the browser named it.
  if (event.code && event.code !== "Unidentified") return false;
  const key = event.key;
  if (key === "b" || key === "B") return true;
  const unnamed = key == null || key === "" || key === "Unidentified" || key === "Process";
  return unnamed && event.keyCode === DOM_VK_B;
}

// `held` is the modifier latch (modifiers still down when this event omitted
// them). Returns "tree", "preview", or null.
export function sidebarShortcutAction(event, held = {}) {
  if (!event || (event.type && event.type !== "keydown")) return null;
  const shift = !!(event.shiftKey || held.shift);
  const alt = !!(event.altKey || held.alt);
  const ctrl = !!(event.ctrlKey || held.ctrl || event.metaKey || held.meta);
  if (!ctrl || shift || !isLetterB(event)) return null;
  return alt ? "preview" : "tree";
}

// Which editor the shared preview renders while split view is open.
//
// Auto is the behavior the editor already had: follow the pane that was
// focused last, except a conversation pair (left `name.c.md`, right
// `name.md`) stays on the right document no matter which pane is focused.
// Left and Right ignore focus and the other pane's edits. The text is the
// pane's current buffer, so unsaved edits show up live.
//
// With the split closed there is only the primary editor, and a right pin
// with no document loaded has nothing of its own to show. Both fall back
// to the left buffer; the stored pin is left alone for the next time.

export const PREVIEW_PIN_STORAGE_KEY = "mark-vector:preview-pin";

export function normalizePreviewPin(value) {
  return value === "left" || value === "right" || value === "auto" ? value : "auto";
}

export function resolvePreviewSource({
  pin = "auto",
  splitOpen = false,
  focused = "a",
  pair = false,
  hasRight = false,
} = {}) {
  const choice = normalizePreviewPin(pin);
  if (!splitOpen || !hasRight) return "a";
  if (choice === "left") return "a";
  if (choice === "right") return "b";
  if (pair) return "b";
  return focused === "b" ? "b" : "a";
}

export function previewContent({
  pin,
  splitOpen,
  focused,
  pair,
  hasRight,
  leftText = "",
  rightText = "",
} = {}) {
  const source = resolvePreviewSource({ pin, splitOpen, focused, pair, hasRight });
  return { source, text: source === "b" ? rightText : leftText };
}

// The Markdown "Download as MD" writes out, and "Copy to clipboard" copies.
// It is the buffer the preview is showing: the pinned pane while split view
// is open, otherwise the primary editor. The text is that buffer as it
// stands, so unsaved edits are included. `open` is false when no document
// is loaded, which is also when those buttons are disabled. The filename
// follows the same pane, so a right pin does not save the right buffer
// under the left document's name.
export function previewMarkdownDownload({
  open = false,
  leftFilename = "",
  rightFilename = "",
  ...source
} = {}) {
  if (!open) return null;
  const resolved = previewContent(source);
  const filename = resolved.source === "b" && rightFilename ? rightFilename : leftFilename;
  return { source: resolved.source, text: resolved.text, filename: filename || "" };
}

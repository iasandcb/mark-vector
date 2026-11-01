// Copy text from a click handler.
//
// navigator.clipboard.writeText is the primary path, but it only exists in
// a secure context (https:// or localhost). This app is often opened over
// plain http on Tailscale, where that API is missing. The fallback is a
// temporary textarea plus document.execCommand("copy").
//
// iPhone Safari and Orion (WebKit) ignore a selection that sits off-screen
// (left: -9999px) and often ignore textarea.select() unless
// setSelectionRange covers the value. The textarea is therefore readonly,
// focused, and fixed at the top-left of the viewport. 16px type stops iOS
// from zooming the page when the field is focused. Call this directly from
// the click so the user gesture is still active; awaiting something else
// first makes both paths fail on iOS.

export async function copyText(text, env = defaultEnv()) {
  const clipboard = env.clipboard;
  if (clipboard && typeof clipboard.writeText === "function" && env.isSecureContext) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch (err) {
      // Permission denied or a broken async clipboard: try execCommand.
    }
  }
  return copyWithExecCommand(text, env.document);
}

function copyWithExecCommand(text, document) {
  if (!document || typeof document.createElement !== "function" || typeof document.execCommand !== "function" || !document.body) {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  // In the viewport. Off-screen fields copy as empty on iPhone Safari/Orion.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "2em";
  textarea.style.height = "2em";
  textarea.style.padding = "0";
  textarea.style.border = "none";
  textarea.style.outline = "none";
  textarea.style.boxShadow = "none";
  textarea.style.background = "transparent";
  textarea.style.fontSize = "16px";
  textarea.style.opacity = "0";

  const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  document.body.appendChild(textarea);
  let copied = false;
  try {
    if (typeof textarea.focus === "function") textarea.focus();
    if (typeof textarea.select === "function") textarea.select();
    selectTextareaValue(textarea);
    if (selection && typeof document.createRange === "function") {
      const range = document.createRange();
      range.selectNodeContents(textarea);
      selection.removeAllRanges();
      selection.addRange(range);
      // Adding a range can clear the textarea selection on iOS. Set the
      // value range last so execCommand("copy") sees the whole string.
      selectTextareaValue(textarea);
    }
    copied = document.execCommand("copy") === true;
  } catch (err) {
    copied = false;
  } finally {
    try {
      document.body.removeChild(textarea);
    } catch (err) {
      // already detached
    }
    if (selection && saved) {
      try {
        selection.removeAllRanges();
        selection.addRange(saved);
      } catch (err) {
        // restoring the editor selection is best-effort
      }
    }
  }
  return copied;
}

function selectTextareaValue(textarea) {
  if (typeof textarea.setSelectionRange === "function") {
    textarea.setSelectionRange(0, textarea.value.length);
  }
}

function defaultEnv() {
  return {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    document: typeof document !== "undefined" ? document : undefined,
  };
}

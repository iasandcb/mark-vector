// "재생하며 전사" plays a saved recording into a realtime engine.
// Web Speech can only hear the microphone, so a file never uses it.
// The file uses OpenAI unless the engine select says Soniox (or only
// Soniox is configured). See dictation-engine.mjs.
//
// Both the file and the microphone keep going when the browser tab is
// hidden or another mark-vector document is on screen, and both keep
// writing into the document they started in. The billed microphone still
// hangs up after three quiet minutes. A file does not: a lecture can be
// quiet for longer, and the file's length bounds the cost. A browser that
// takes the microphone away while hidden is resumed when the page shows
// again (see captureInterrupted), not treated as the user pressing stop.

// What to send around a gap so the phrase already heard is finalized once
// and audio after the gap starts a new phrase. `commit` with nothing new
// since the last one is a no-op in realtime-stt.js (an empty commit errors
// and can stall the buffer). `clear` drops the silence the gap appended.
export function bufferSteps(kind) {
  if (kind === "pause") return ["commit"];
  if (kind === "resume") return ["clear"];
  if (kind === "seek") return ["commit", "clear"];
  return [];
}

// A capture track that pause/interruption left muted or ended does not
// carry the file to the engine anymore, even if the element itself plays.
export function uplinkNeedsRebuild(track) {
  return !track || track.readyState === "ended" || track.muted;
}

// `reason` is why the caller is considering stopping.
// Both kinds stop when the document they write into is gone, or when that
// document is on screen and its editor is busy (a send). Neither stops
// for a hidden browser tab, a muted or ended capture, or another document
// being on screen. Only the microphone stops for a long silence: that is
// the cost guard for a session that would otherwise stay billed.
export function sessionStops(kind, reason) {
  if (!reason || reason === "none") return false;
  if (reason === "closed" || reason === "editor-busy") return true;
  return kind === "mic" && reason === "idle";
}

// The browser may suspend the microphone or the speech recognizer while
// the tab is hidden (iOS Safari does). Keep the session and open the
// capture again when the page is visible. A track that ends in view is
// the microphone actually going away.
export function captureInterrupted(hidden) {
  return hidden ? "resume-when-visible" : "stop";
}

// Which open document receives the next phrase. `same(a, b)` compares refs.
// Missing tab → stop. On screen → the editor. Anywhere else → that tab's
// stashed text, never the document the user just opened.
export function transcriptDestination({ tabs, activeRef, targetRef, same }) {
  const index = tabs.findIndex((tab) => same(tab.ref, targetRef));
  if (index < 0) return { stop: true, where: null, index: -1 };
  const onScreen = same(activeRef, targetRef);
  return { stop: false, where: onScreen ? "editor" : "stash", index };
}

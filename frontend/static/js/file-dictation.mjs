// "재생하며 전사" plays a saved recording into a realtime engine.
// Web Speech can only hear the microphone, so a file never uses it.
// With the built-in choice the file uses Soniox when that key exists,
// and OpenAI otherwise. An explicit OpenAI choice stays on OpenAI.
// See dictation-engine.mjs.
//
// Both the file and the microphone keep going when the browser tab is
// hidden or another mark-vector document is on screen, and both keep
// writing into the document they started in. The billed microphone still
// hangs up after three quiet minutes. A file does not: a lecture can be
// quiet for longer, and the file's length bounds the cost. A browser that
// takes the microphone away while hidden is resumed when the page shows
// again (see captureInterrupted), not treated as the user pressing stop.
//
// iOS takes the audio session when another app wants the microphone.
// WebKit then sets AudioContext.state to "interrupted" (sometimes
// "suspended") and AudioSession.state to "interrupted", and may pause the
// element. That is not the user pressing pause, and it is not the page
// becoming hidden: background playback keeps the "playback" session.
// The file player releases the session (suspend, type "auto") so the other
// app can record, and takes it back when the interruption ends or the page
// is visible again. A user pause keeps the socket and asks it to wait.

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
// How many fresh sessions a file may open after the provider drops it
// before the stop alert is actually shown.
export const FILE_RECONNECT_CAP = 3;

// "running" plays. "closed" is gone. Everything else — including WebKit's
// non-standard "interrupted" — is silent until resume() inside a gesture.
export function audioContextNeedsResume(state) {
  return !!state && state !== "running" && state !== "closed";
}

export function fileErrorText(message) {
  if (message == null) return "";
  if (typeof message === "string") return message;
  return String(message.error_message || message.error_type || message.message || "");
}

// "fatal" needs the user (a bad key). "recoverable" is a socket that died
// because audio stopped flowing. Anything else is shown and left alone.
export function fileErrorClass(message) {
  const text = fileErrorText(message).toLowerCase();
  if (!text) return "status";
  if (/invalid api key|api[_ ]key|unauthorized|permission denied|not allowed|forbidden|\b401\b|\b403\b/.test(text)) return "fatal";
  if (/request timeout|connection closed|timed out|timeout|network|socket|disconnect|websocket|idle/.test(text)) return "recoverable";
  return "status";
}

export function shouldReconnectFileSession(message) {
  return fileErrorClass(message) === "recoverable";
}

// The pause button sets userPaused before the element pauses. Any other
// pause (iOS stealing the audio session) is an interruption.
export function filePauseKind(userPaused) {
  return userPaused ? "user" : "interrupted";
}

// What a context that just left "running" should do to a file session.
export function fileContextAction(state, { userPaused = false, audioEnded = false, started = false, audioPaused = false } = {}) {
  if (!audioContextNeedsResume(state) || userPaused || audioEnded) {
    return { resumeContext: false, pauseMedia: false, hold: false, commit: false };
  }
  // Before the first play, a desktop suspend is just resumed. Nothing has
  // been heard, so there is nothing to commit, and the setup pause must
  // not be treated as an interruption.
  if (!started) {
    return { resumeContext: state !== "interrupted", pauseMedia: false, hold: false, commit: false };
  }
  // Interrupted output is silence. Stop the clock with it and hold the
  // socket. resume() is still attempted; WebKit often ignores it until the
  // play gesture, which tries again. A plain suspend (a desktop tab) just
  // tries resume(), without cutting the sentence.
  if (state === "interrupted") {
    return { resumeContext: true, pauseMedia: !audioPaused, hold: true, commit: true };
  }
  return { resumeContext: true, pauseMedia: false, hold: false, commit: false };
}

// "reconnect" opens a new session now. "wait" remembers the drop until the
// user plays again (a socket opened while the graph is paused dies the
// same way). "popup" is the alert. "status" leaves playback up.
export function fileProviderFailureAction({
  message,
  hidden = false,
  userPaused = false,
  audioPaused = false,
  reconnects = 0,
  reconnecting = false,
} = {}) {
  if (reconnecting) return "ignore";
  const kind = fileErrorClass(message);
  if (kind === "status") return "status";
  if (kind === "fatal") return "popup";
  if (reconnects >= FILE_RECONNECT_CAP) return "popup";
  if (hidden || userPaused || audioPaused) return "wait";
  return "reconnect";
}

// The play button, and coming back to a file the user did not pause.
// clearBuffer is the resume half of bufferSteps: the phrase was committed
// when the gap started, so it must not be committed again.
export function fileResumeAction({
  contextState = "running",
  userPaused = false,
  interrupted = false,
  sttOpen = true,
  reconnects = 0,
  reconnecting = false,
  started = false,
} = {}) {
  const dead = !sttOpen;
  return {
    resumeContext: audioContextNeedsResume(contextState),
    clearBuffer: !!(started && (userPaused || interrupted)),
    reconnect: dead && !reconnecting && reconnects < FILE_RECONNECT_CAP,
    popup: dead && !reconnecting && reconnects >= FILE_RECONNECT_CAP,
  };
}

// Another app took the output. "suspended" while the page is hidden is the
// browser parking a background tab, not an interruption — playback keeps
// the session. "suspended" counts only where AudioSession exists (WebKit)
// and we did not suspend ourselves. A system pause counts only on that
// same WebKit session: a desktop pause is not one, and a pause while the
// page is hidden is not one unless the session actually reports interrupted.
export function fileOsInterruption({
  started = false,
  userPaused = false,
  audioEnded = false,
  contextState = "",
  audioSessionState = "",
  systemPause = false,
  causedByUs = false,
  weSuspended = false,
  hidden = false,
  hasAudioSession = false,
} = {}) {
  if (!started || userPaused || audioEnded || causedByUs) return false;
  if (audioSessionState === "interrupted" || contextState === "interrupted") return true;
  if (contextState === "suspended" && !weSuspended && !hidden && hasAudioSession) return true;
  if (!systemPause || !hasAudioSession) return false;
  if (hidden && audioSessionState !== "interrupted" && contextState !== "interrupted") return false;
  return true;
}

// The other app let go, or the user came back. A failed automatic play
// waits for a tap or the next time the page is shown, so a stuck "active"
// does not retry forever. resumeSuppressed ignores the statechange that
// setting type back to "auto" can fire in the same turn. A user pause
// stays paused. Becoming visible still tries, including after a failed play.
export function fileOsResumeCue({
  osReleased = false,
  userPaused = false,
  audioEnded = false,
  contextState = "",
  audioSessionState = "",
  becameVisible = false,
  resumeFailed = false,
  resumeSuppressed = false,
} = {}) {
  if (!osReleased || userPaused || audioEnded) return false;
  if (becameVisible) return true;
  if (resumeSuppressed || resumeFailed) return false;
  if (audioSessionState === "active" || contextState === "running") return true;
  return false;
}

export function transcriptDestination({ tabs, activeRef, targetRef, same }) {
  const index = tabs.findIndex((tab) => same(tab.ref, targetRef));
  if (index < 0) return { stop: true, where: null, index: -1 };
  const onScreen = same(activeRef, targetRef);
  return { stop: false, where: onScreen ? "editor" : "stash", index };
}

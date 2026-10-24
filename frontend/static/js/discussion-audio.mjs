// iOS / WebKit can suspend the capture graph (`interrupted`) without the
// user pressing stop. This is a microphone (play-and-record), not the
// ducked file player: hold the socket and resume the context. A file keeps
// playing through a graph flinch and only holds if its element pauses.

import {
  FILE_RECONNECT_CAP,
  audioContextNeedsResume,
  fileContextAction,
  fileProviderFailureAction,
  fileResumeAction,
} from "./file-dictation.mjs";

export { FILE_RECONNECT_CAP, audioContextNeedsResume };

export function discussCaptureAction(state, { userStopped = false, started = false } = {}) {
  if (userStopped) return { stop: true, hold: false, resumeContext: false };
  const action = fileContextAction(state, {
    userPaused: false,
    audioEnded: false,
    started,
    audioPaused: false,
  });
  // fileContextAction no longer holds on a graph interruption, so a playing
  // file is not cut. A discussion mic still finalizes the open phrase.
  return {
    stop: false,
    hold: state === "interrupted" && started,
    resumeContext: action.resumeContext,
  };
}

export function discussSocketAction(args) {
  return fileProviderFailureAction(args);
}

// Coming back to the page, or tapping Resume. The transcript is kept either way.
export function discussResumeAction(args) {
  const action = fileResumeAction(args);
  return {
    resumeContext: action.resumeContext,
    reconnect: action.reconnect,
    giveUp: action.popup,
  };
}

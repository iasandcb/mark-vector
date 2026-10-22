// iOS / WebKit can suspend the capture graph (`interrupted`) without the
// user pressing stop. Same decisions as file transcription: resume the
// context, hold the socket, and reconnect a dead one — don't treat the
// interruption as hang-up.

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
  return { stop: false, hold: action.hold, resumeContext: action.resumeContext };
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

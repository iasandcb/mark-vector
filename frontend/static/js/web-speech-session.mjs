// Chrome ends a "continuous" Web Speech session by itself: after a quiet
// stretch ("no-speech"), when its speech socket blips ("network"), and
// about once a minute even while someone is still talking. The dictation
// session is still on, so those endings start a new recognizer. Calling
// start() inside the end event throws InvalidStateError and, if that is
// ignored, the recognizer stays dead with no message. A phrase that was
// already written is not written again when the new recognizer repeats it.
// Anything else (permission, a capture the browser gave up on, a start
// that keeps failing) stops dictation and is shown.

export const WEB_SPEECH_RESTART_MS = 200;
export const WEB_SPEECH_MAX_START_FAILURES = 3;
export const WEB_SPEECH_REPEAT_MS = 1200;

const QUIET = new Set(["", "no-speech", "aborted"]);

export function webSpeechAfterEnd({ stopped, hidden, error, networkRetries, maxNetworkRetries }) {
  if (stopped) return { action: "ignore" };
  const code = error || "";
  if (!QUIET.has(code)) {
    if (code === "network" && networkRetries < maxNetworkRetries) {
      return {
        action: "restart",
        delayMs: 500 * (networkRetries + 1),
        clearError: true,
        countNetwork: true,
        reconnecting: true,
      };
    }
    if (code === "not-allowed" || code === "service-not-allowed") return { action: "fail", denied: true, message: code };
    return { action: "fail", message: code };
  }
  if (hidden) return { action: "wait-until-visible" };
  return { action: "restart", delayMs: WEB_SPEECH_RESTART_MS, clearError: true };
}

// start() threw. InvalidStateError right after the previous recognizer
// ended means Chrome has not finished stopping it — try again shortly.
// A new recognizer that still cannot start is a failure and must be shown.
export function webSpeechAfterStartError({ name, message, startFailures, maxStartFailures = WEB_SPEECH_MAX_START_FAILURES }) {
  if (name === "InvalidStateError" && startFailures < maxStartFailures) {
    return { action: "restart", delayMs: WEB_SPEECH_RESTART_MS };
  }
  return { action: "fail", message: message || name || "start failed" };
}

function norm(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Chrome can hand the restarted recognizer the phrase the previous one
// already finalized, immediately. That one copy is dropped. The same words
// said again after the window are a new phrase and are kept.
export function createWebSpeechTranscript({ repeatWindowMs = WEB_SPEECH_REPEAT_MS } = {}) {
  let lastFinal = "";
  let skipUntil = 0;
  return {
    expectPossibleRepeat(now) {
      if (lastFinal) skipUntil = now + repeatWindowMs;
    },
    accept(finalText, interimText, now) {
      const finalNorm = norm(finalText);
      const interimNorm = norm(interimText);
      if (now < skipUntil && lastFinal) {
        const finalIsRepeat = !!finalNorm && finalNorm === lastFinal;
        const interimIsPrefix = !finalNorm && !!interimNorm && lastFinal.startsWith(interimNorm);
        if (finalIsRepeat || interimIsPrefix) {
          if (finalIsRepeat) skipUntil = 0;
          return { finalText: "", interimText: "" };
        }
        skipUntil = 0;
      }
      if (finalNorm) lastFinal = finalNorm;
      return { finalText, interimText };
    },
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebSpeechTranscript,
  WEB_SPEECH_REPEAT_MS,
  webSpeechAfterEnd,
  webSpeechAfterStartError,
} from "./web-speech-session.mjs";

const open = { stopped: false, hidden: false, networkRetries: 0, maxNetworkRetries: 5 };

test("a quiet end restarts, and a real error is shown", () => {
  for (const error of ["", "no-speech", "aborted"]) {
    const step = webSpeechAfterEnd({ ...open, error });
    assert.equal(step.action, "restart", error || "clean");
    assert.equal(step.clearError, true);
  }
  assert.equal(webSpeechAfterEnd({ ...open, stopped: true, error: "no-speech" }).action, "ignore");
  assert.equal(webSpeechAfterEnd({ ...open, hidden: true, error: "no-speech" }).action, "wait-until-visible");
  const denied = webSpeechAfterEnd({ ...open, error: "not-allowed" });
  assert.equal(denied.action, "fail");
  assert.equal(denied.denied, true);
  const capture = webSpeechAfterEnd({ ...open, hidden: true, error: "audio-capture" });
  assert.equal(capture.action, "fail");
  assert.equal(capture.message, "audio-capture");
});

test("network retries, then the error is shown", () => {
  const again = webSpeechAfterEnd({ ...open, error: "network", networkRetries: 1 });
  assert.equal(again.action, "restart");
  assert.equal(again.reconnecting, true);
  assert.equal(again.countNetwork, true);
  assert.equal(again.delayMs, 1000);
  const done = webSpeechAfterEnd({ ...open, error: "network", networkRetries: 5 });
  assert.equal(done.action, "fail");
  assert.equal(done.message, "network");
});

test("InvalidStateError is retried, then shown", () => {
  assert.equal(webSpeechAfterStartError({ name: "InvalidStateError", startFailures: 0 }).action, "restart");
  assert.equal(webSpeechAfterStartError({ name: "InvalidStateError", startFailures: 2 }).action, "restart");
  const fail = webSpeechAfterStartError({ name: "InvalidStateError", message: "still starting", startFailures: 3 });
  assert.equal(fail.action, "fail");
  assert.equal(fail.message, "still starting");
  assert.equal(webSpeechAfterStartError({ name: "NotAllowedError", message: "blocked", startFailures: 0 }).action, "fail");
});

test("the phrase Chrome repeats at the restart boundary is written once", () => {
  const transcript = createWebSpeechTranscript();
  assert.deepEqual(transcript.accept("Hello there", "", 0), { finalText: "Hello there", interimText: "" });
  transcript.expectPossibleRepeat(1000);
  assert.deepEqual(transcript.accept("", "Hello", 1100), { finalText: "", interimText: "" });
  assert.deepEqual(transcript.accept("Hello there", "", 1200), { finalText: "", interimText: "" });
  // The repeat window is closed by that final. Saying it again keeps it.
  assert.deepEqual(transcript.accept("Hello there", "", 1300), { finalText: "Hello there", interimText: "" });
  transcript.expectPossibleRepeat(2000);
  // A different phrase inside the window is new speech, not a repeat.
  const fresh = transcript.accept("next sentence", "", 2100);
  assert.equal(fresh.finalText, "next sentence");
  // And an identical phrase after the window, with no closer in between, is kept.
  transcript.expectPossibleRepeat(3000);
  const later = transcript.accept("next sentence", "", 3000 + WEB_SPEECH_REPEAT_MS + 1);
  assert.equal(later.finalText, "next sentence");
});

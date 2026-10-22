import assert from "node:assert/strict";
import test from "node:test";
import { FILE_RECONNECT_CAP, discussCaptureAction, discussResumeAction, discussSocketAction } from "./discussion-audio.mjs";

test("an interrupted capture is held and resumed, not stopped", () => {
  const interrupted = discussCaptureAction("interrupted", { started: true });
  assert.equal(interrupted.stop, false);
  assert.equal(interrupted.hold, true);
  assert.equal(interrupted.resumeContext, true);
  assert.deepEqual(discussCaptureAction("running", { started: true }), { stop: false, hold: false, resumeContext: false });
  assert.equal(discussCaptureAction("interrupted", { userStopped: true }).stop, true);
});

test("a dropped socket reconnects until the cap, and waits while the page is hidden", () => {
  assert.equal(discussSocketAction({ message: "Request timeout", reconnects: 0 }), "reconnect");
  assert.equal(discussSocketAction({ message: "Request timeout", hidden: true, reconnects: 0 }), "wait");
  assert.equal(discussSocketAction({ message: "connection closed", reconnects: FILE_RECONNECT_CAP }), "popup");
  assert.equal(discussSocketAction({ message: "invalid api key", reconnects: 0 }), "popup");
  const back = discussResumeAction({
    contextState: "interrupted",
    interrupted: true,
    sttOpen: false,
    reconnects: 1,
    started: true,
  });
  assert.equal(back.resumeContext, true);
  assert.equal(back.reconnect, true);
  assert.equal(back.giveUp, false);
});

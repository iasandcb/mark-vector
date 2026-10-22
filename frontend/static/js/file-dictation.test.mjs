import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_RECONNECT_CAP,
  audioContextNeedsResume,
  bufferSteps,
  captureInterrupted,
  fileContextAction,
  filePauseKind,
  fileProviderFailureAction,
  fileResumeAction,
  sessionStops,
  shouldReconnectFileSession,
  transcriptDestination,
  uplinkNeedsRebuild,
} from "./file-dictation.mjs";

const same = (a, b) => a && b && a.id === b.id;
const tabs = [{ ref: { id: "original" } }, { ref: { id: "other" } }];

test("pause finalizes, resume starts a fresh phrase, seek does both", () => {
  assert.deepEqual(bufferSteps("pause"), ["commit"]);
  assert.deepEqual(bufferSteps("resume"), ["clear"]);
  assert.deepEqual(bufferSteps("seek"), ["commit", "clear"]);
  // Resume does not commit again, so a phrase finalized on pause is not
  // sent twice. Seek commits before the jump, then clears, so the words
  // before the jump stay once and the words after append.
  assert.equal(bufferSteps("resume").includes("commit"), false);
});

test("a dead or muted uplink is rebuilt and a live one is kept", () => {
  assert.equal(uplinkNeedsRebuild(null), true);
  assert.equal(uplinkNeedsRebuild({ readyState: "ended", muted: false }), true);
  assert.equal(uplinkNeedsRebuild({ readyState: "live", muted: true }), true);
  assert.equal(uplinkNeedsRebuild({ readyState: "live", muted: false }), false);
});

test("file playback ignores silence, a hidden tab, and a document switch", () => {
  for (const reason of ["hidden", "idle", "track-ended", "track-muted", "document-switch", "none"]) {
    assert.equal(sessionStops("file", reason), false, reason);
  }
  assert.equal(sessionStops("file", "closed"), true);
  assert.equal(sessionStops("file", "editor-busy"), true);
});

test("mic dictation keeps the 3-minute silence guard and survives a hidden tab", () => {
  assert.equal(sessionStops("mic", "idle"), true);
  assert.equal(sessionStops("mic", "editor-busy"), true);
  assert.equal(sessionStops("mic", "closed"), true);
  for (const reason of ["hidden", "track-ended", "track-muted", "document-switch", "none"]) {
    assert.equal(sessionStops("mic", reason), false, reason);
  }
});

test("a hidden tab's dead microphone resumes later; one that dies in view stops", () => {
  assert.equal(captureInterrupted(true), "resume-when-visible");
  assert.equal(captureInterrupted(false), "stop");
});

test("another mark-vector tab keeps the transcript on the original document", () => {
  const away = transcriptDestination({
    tabs,
    activeRef: { id: "other" },
    targetRef: { id: "original" },
    same,
  });
  assert.equal(away.stop, false);
  assert.equal(away.where, "stash");
  assert.equal(away.index, 0);

  const home = transcriptDestination({
    tabs,
    activeRef: { id: "original" },
    targetRef: { id: "original" },
    same,
  });
  assert.equal(home.where, "editor");

  const closed = transcriptDestination({
    tabs: [{ ref: { id: "other" } }],
    activeRef: { id: "other" },
    targetRef: { id: "original" },
    same,
  });
  assert.equal(closed.stop, true);
});

test("pause then resume appends the next phrase without repeating the first", () => {
  // The editor does this with writeDictationText. The steps above are what
  // make the server send phrase one as a final (on pause) and phrase two as
  // a new item (after clear), so the second write starts after the first.
  const doc = { text: "", from: 0, interim: "" };
  const place = (finalText) => {
    const end = doc.from + doc.interim.length;
    const gap = doc.from > 0 && doc.text[doc.from - 1] && !/\s/.test(doc.text[doc.from - 1]) ? " " : "";
    const insert = finalText ? gap + finalText : "";
    doc.text = doc.text.slice(0, doc.from) + insert + doc.text.slice(end);
    doc.from += insert.length;
    doc.interim = "";
  };
  assert.deepEqual(bufferSteps("pause"), ["commit"]);
  place("Alpha sentence about the harbor.");
  assert.deepEqual(bufferSteps("resume"), ["clear"]);
  place("Bravo sentence about the mountain.");
  assert.equal(doc.text, "Alpha sentence about the harbor. Bravo sentence about the mountain.");
  // Seeking back transcribes that part again, after what was already kept.
  assert.deepEqual(bufferSteps("seek"), ["commit", "clear"]);
  place("Alpha sentence about the harbor.");
  assert.equal(
    doc.text,
    "Alpha sentence about the harbor. Bravo sentence about the mountain. Alpha sentence about the harbor.",
  );
});

test("an interrupted or suspended audio graph needs resume; a running one does not", () => {
  assert.equal(audioContextNeedsResume("interrupted"), true);
  assert.equal(audioContextNeedsResume("suspended"), true);
  assert.equal(audioContextNeedsResume("running"), false);
  assert.equal(audioContextNeedsResume("closed"), false);
  assert.equal(audioContextNeedsResume(""), false);
  assert.equal(audioContextNeedsResume(null), false);
});

test("a file provider timeout reconnects; a bad key does not", () => {
  assert.equal(shouldReconnectFileSession({ error_message: "Request timeout" }), true);
  assert.equal(shouldReconnectFileSession("Request timeout"), true);
  assert.equal(shouldReconnectFileSession({ error_message: "connection closed" }), true);
  assert.equal(shouldReconnectFileSession("timed out connecting"), true);
  assert.equal(shouldReconnectFileSession("invalid api key"), false);
  assert.equal(shouldReconnectFileSession("session failed (401)"), false);
  assert.equal(shouldReconnectFileSession("session failed (403)"), false);
  assert.equal(shouldReconnectFileSession("buffer is empty"), false);
  assert.equal(shouldReconnectFileSession(""), false);
});

test("iOS interruption pauses the clock and holds the socket; a user pause is not one", () => {
  assert.equal(filePauseKind(true), "user");
  assert.equal(filePauseKind(false), "interrupted");
  const stolen = fileContextAction("interrupted", { started: true, audioPaused: false });
  assert.equal(stolen.pauseMedia, true);
  assert.equal(stolen.hold, true);
  assert.equal(stolen.commit, true);
  assert.equal(stolen.resumeContext, true);
  const suspended = fileContextAction("suspended", { started: true });
  assert.equal(suspended.resumeContext, true);
  assert.equal(suspended.pauseMedia, false);
  assert.equal(suspended.commit, false);
  assert.deepEqual(fileContextAction("running", { started: true }), {
    resumeContext: false,
    pauseMedia: false,
    hold: false,
    commit: false,
  });
  assert.equal(fileContextAction("interrupted", { started: true, userPaused: true }).pauseMedia, false);
  assert.equal(fileContextAction("suspended", { started: false }).resumeContext, true);
  assert.equal(fileContextAction("interrupted", { started: false }).pauseMedia, false);
});

test("Request timeout during playback reconnects; after the cap it alerts; it does not write the phrase twice", () => {
  assert.equal(
    fileProviderFailureAction({ message: { error_message: "Request timeout" }, reconnects: 0 }),
    "reconnect",
  );
  // The error is delivered when the page wakes, while the element is still
  // paused. Opening a socket then would time out again, so wait for play.
  assert.equal(
    fileProviderFailureAction({
      message: { error_message: "Request timeout" },
      audioPaused: true,
      reconnects: 0,
    }),
    "wait",
  );
  assert.equal(
    fileProviderFailureAction({ message: "Request timeout", hidden: true, reconnects: 0 }),
    "wait",
  );
  assert.equal(
    fileProviderFailureAction({ message: "Request timeout", reconnects: FILE_RECONNECT_CAP }),
    "popup",
  );
  assert.equal(fileProviderFailureAction({ message: "invalid api key" }), "popup");
  assert.equal(fileProviderFailureAction({ message: "buffer is empty" }), "status");
  assert.equal(fileProviderFailureAction({ message: "Request timeout", reconnecting: true }), "ignore");

  const resume = fileResumeAction({
    contextState: "interrupted",
    interrupted: true,
    started: true,
    sttOpen: false,
    reconnects: 0,
  });
  assert.equal(resume.resumeContext, true);
  assert.equal(resume.reconnect, true);
  assert.equal(resume.popup, false);
  assert.equal(resume.clearBuffer, true);
  assert.equal(bufferSteps("resume").includes("commit"), false);
  assert.deepEqual(bufferSteps("pause"), ["commit"]);

  const userResume = fileResumeAction({
    contextState: "running",
    userPaused: true,
    started: true,
    sttOpen: true,
  });
  assert.equal(userResume.reconnect, false);
  assert.equal(userResume.clearBuffer, true);
  assert.equal(
    fileResumeAction({
      contextState: "interrupted",
      interrupted: true,
      started: true,
      sttOpen: false,
      reconnects: FILE_RECONNECT_CAP,
    }).popup,
    true,
  );
});

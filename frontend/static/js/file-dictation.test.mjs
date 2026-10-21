import assert from "node:assert/strict";
import test from "node:test";
import { bufferSteps, captureInterrupted, sessionStops, transcriptDestination, uplinkNeedsRebuild } from "./file-dictation.mjs";

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

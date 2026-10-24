import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { dictationControlState, recordControlState, FILE_ICON, MIC_ICON } from "./dictation-button.mjs";

test("an idle dictation button looks like a microphone that is off", () => {
  const view = dictationControlState({ active: false, file: false });
  assert.equal(view.listening, false);
  assert.equal(view.transcribingFile, false);
  assert.equal(view.pressed, false);
  assert.equal(view.icon, MIC_ICON);
  assert.equal(view.labelKey, "editor.dictation");
  assert.equal(view.titleKey, null);
});

test("microphone dictation keeps the red listening treatment", () => {
  const view = dictationControlState({ active: true, file: false });
  assert.equal(view.listening, true);
  assert.equal(view.transcribingFile, false);
  assert.equal(view.pressed, true);
  assert.equal(view.icon, MIC_ICON);
  assert.equal(view.labelKey, "editor.dictationStop");
});

test("a file session is not painted as a live microphone", () => {
  const view = dictationControlState({ active: true, file: true });
  assert.equal(view.listening, false);
  assert.equal(view.transcribingFile, true);
  assert.equal(view.pressed, true);
  assert.equal(view.icon, FILE_ICON);
  assert.equal(view.icon, "🎵");
  assert.equal(view.labelKey, "editor.dictationTranscribingFile");
  assert.equal(view.titleKey, "editor.dictationTranscribingFile");
});

test("the record dot stays off and disabled during a file session", () => {
  const savedOn = recordControlState({ fileSession: true, recordWithDictation: true, recording: true });
  assert.equal(savedOn.ariaDisabled, true);
  assert.equal(savedOn.pressed, false);
  assert.equal(savedOn.showRecording, false);
  assert.equal(savedOn.titleKey, "editor.dictationRecordFileTitle");

  const savedOff = recordControlState({ fileSession: true, recordWithDictation: false, recording: false });
  assert.equal(savedOff.ariaDisabled, true);
  assert.equal(savedOff.pressed, false);
});

test("leaving the file session restores the record preference visually", () => {
  const on = recordControlState({ fileSession: false, recordWithDictation: true, recording: false });
  assert.equal(on.ariaDisabled, false);
  assert.equal(on.pressed, true);
  assert.equal(on.showRecording, false);
  assert.equal(on.titleKey, "editor.dictationRecordTitle");

  const recording = recordControlState({ fileSession: false, recordWithDictation: true, recording: true });
  assert.equal(recording.ariaDisabled, false);
  assert.equal(recording.pressed, true);
  assert.equal(recording.showRecording, true);
  assert.equal(recording.titleKey, null);
});

test("file-session strings exist in every UI language", () => {
  const src = fs.readFileSync(new URL("./i18n.js", import.meta.url), "utf8");
  for (const key of ["editor.dictationTranscribingFile", "editor.dictationRecordFileTitle"]) {
    const count = src.split(`"${key}"`).length - 1;
    assert.equal(count, 3, key);
  }
  assert.equal(src.includes("파일 전사 중"), true);
});

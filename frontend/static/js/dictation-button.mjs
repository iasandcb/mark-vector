// What the dictation button and the record dot should look like.
// A file being transcribed never opens the microphone, so it must not wear
// the red listening treatment. The saved "record while dictating"
// preference is not an input here: callers leave localStorage alone and
// only paint the dot as off while a file session is running.

export const MIC_ICON = "🎤";
export const FILE_ICON = "🎵";

export function dictationControlState({ active, file }) {
  if (active && file) {
    return {
      listening: false,
      transcribingFile: true,
      pressed: true,
      icon: FILE_ICON,
      labelKey: "editor.dictationTranscribingFile",
      titleKey: "editor.dictationTranscribingFile",
    };
  }
  if (active) {
    return {
      listening: true,
      transcribingFile: false,
      pressed: true,
      icon: MIC_ICON,
      labelKey: "editor.dictationStop",
      titleKey: null,
    };
  }
  return {
    listening: false,
    transcribingFile: false,
    pressed: false,
    icon: MIC_ICON,
    labelKey: "editor.dictation",
    titleKey: null,
  };
}

// `recordWithDictation` is the in-memory preference (mirroring localStorage).
// During a file session the dot is not shown as on, and the control is
// aria-disabled, but this does not write the preference.
export function recordControlState({ fileSession, recordWithDictation, recording }) {
  if (fileSession) {
    return {
      ariaDisabled: true,
      pressed: false,
      showRecording: false,
      titleKey: "editor.dictationRecordFileTitle",
    };
  }
  return {
    ariaDisabled: false,
    pressed: !!recordWithDictation,
    showRecording: !!recording,
    titleKey: recording ? null : "editor.dictationRecordTitle",
  };
}

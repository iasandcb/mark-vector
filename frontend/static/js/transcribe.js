// "Transcribe audio" dialog for a folder: pick an audio file or record one
// in the browser, upload it, and get back a speaker-labelled Markdown
// document in that folder (see routers/transcribe.py). Built on demand and
// styled with the same overlay/panel classes as quick-open, so it needs no
// markup of its own in index.html.

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";

// Speech-grade bitrate: ~14 MB/hour, so even a long in-browser recording
// stays under the API's 25 MB cap without server-side re-encoding.
const RECORD_BITS_PER_SECOND = 32000;
const RECORD_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
// What's spoken in the recording - a hint the model otherwise lacks, and
// without which it can drift into another language partway through.
// Defaults to the UI language, then remembers the last pick.
const AUDIO_LANGUAGES = [
  ["", "transcribe.langAuto"],
  ["ko", "한국어"],
  ["en", "English"],
  ["ja", "日本語"],
];
const AUDIO_LANGUAGE_KEY = "mv-transcribe-audio-language";

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function recordingFilename(mimeType) {
  const ext = mimeType.includes("mp4") ? "m4a" : "webm";
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `recording-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export async function openTranscribeDialog({ projectId, sessionId, onDone }) {
  const overlay = document.createElement("div");
  overlay.className = "quick-open-overlay";
  overlay.innerHTML = `
    <div class="quick-open-panel transcribe-panel" role="dialog" aria-modal="true">
      <div class="shortcuts-header">
        <span></span>
        <button class="icon-btn" type="button" data-close>×</button>
      </div>
      <div class="transcribe-body">
        <p class="transcribe-note" data-note></p>
        <label class="transcribe-drop" data-drop>
          <input type="file" accept="audio/*,video/mp4,video/webm" hidden data-file>
          <span data-drop-label></span>
        </label>
        <div class="transcribe-or" data-or></div>
        <button type="button" class="transcribe-record" data-record></button>
        <div class="transcribe-row">
          <input type="text" class="transcribe-title" data-title autocomplete="off">
          <select class="transcribe-lang" data-lang></select>
        </div>
        <div class="transcribe-status" data-status aria-live="polite"></div>
        <div class="transcribe-actions">
          <button type="button" class="transcribe-start" data-start disabled></button>
        </div>
      </div>
    </div>`;
  const $ = (sel) => overlay.querySelector(sel);
  $(".shortcuts-header span").textContent = t("transcribe.title");
  $("[data-close]").title = t("ui.close");
  $("[data-note]").textContent = t("transcribe.note");
  $("[data-drop-label]").textContent = t("transcribe.pickFile");
  $("[data-or]").textContent = t("transcribe.or");
  $("[data-record]").textContent = "● " + t("transcribe.record");
  $("[data-title]").placeholder = t("transcribe.titlePlaceholder");
  $("[data-start]").textContent = t("transcribe.start");
  const langSelect = $("[data-lang]");
  langSelect.title = t("transcribe.audioLanguage");
  for (const [code, label] of AUDIO_LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = code ? label : t(label);
    langSelect.appendChild(opt);
  }
  let storedLang = null;
  try {
    storedLang = localStorage.getItem(AUDIO_LANGUAGE_KEY);
  } catch {}
  langSelect.value = storedLang ?? (AUDIO_LANGUAGES.some(([c]) => c === getLanguage()) ? getLanguage() : "");
  langSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(AUDIO_LANGUAGE_KEY, langSelect.value);
    } catch {}
  });
  document.body.appendChild(overlay);

  let file = null;
  let recorder = null;
  let stream = null;
  let timer = null;
  let busy = false;

  const status = (text, isError = false) => {
    $("[data-status]").textContent = text;
    $("[data-status]").classList.toggle("error", isError);
  };
  const setFile = (f) => {
    file = f;
    $("[data-drop-label]").textContent = f
      ? `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB`
      : t("transcribe.pickFile");
    $("[data-start]").disabled = !f || busy;
    if (f && !$("[data-title]").value) $("[data-title]").value = f.name.replace(/\.[^.]+$/, "");
  };
  const stopTracks = () => {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    clearInterval(timer);
  };
  const close = () => {
    if (busy) return;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    stopTracks();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  $("[data-close]").addEventListener("click", close);

  const config = await api.getTranscribeConfig().catch(() => ({ available: false }));
  if (!config.available) {
    status(t("transcribe.unavailable"), true);
    $("[data-record]").disabled = true;
    $("[data-file]").disabled = true;
  }

  $("[data-file]").addEventListener("change", (e) => setFile(e.target.files[0] || null));
  const drop = $("[data-drop]");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (config.available && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  $("[data-record]").addEventListener("click", async () => {
    const btn = $("[data-record]");
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      status(t("transcribe.micDenied"), true);
      return;
    }
    const mimeType = RECORD_MIME_TYPES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: RECORD_BITS_PER_SECOND });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stopTracks();
      const type = recorder.mimeType || mimeType || "audio/webm";
      setFile(new File(chunks, recordingFilename(type), { type }));
      btn.classList.remove("recording");
      btn.textContent = "● " + t("transcribe.recordAgain");
      status("");
    };
    recorder.start(1000);
    const startedAt = Date.now();
    setFile(null);
    btn.classList.add("recording");
    btn.textContent = "■ " + t("transcribe.stop") + " · 00:00";
    timer = setInterval(() => {
      btn.textContent = "■ " + t("transcribe.stop") + " · " + formatElapsed(Date.now() - startedAt);
    }, 500);
    status(t("transcribe.recording"));
  });

  $("[data-start]").addEventListener("click", async () => {
    if (!file || busy) return;
    busy = true;
    for (const sel of ["[data-start]", "[data-record]", "[data-file]", "[data-title]", "[data-lang]"]) $(sel).disabled = true;
    overlay.classList.add("busy");
    let doc = null;
    let failed = null;
    try {
      status(t("transcribe.uploading", { pct: 0 }));
      await api.transcribeAudio(
        projectId,
        sessionId,
        file,
        { title: $("[data-title]").value.trim(), language: getLanguage(), audioLanguage: langSelect.value },
        (event) => {
          if (event.type === "status") status(t(`transcribe.stage.${event.stage}`));
          else if (event.type === "document") doc = event.document;
          else if (event.type === "error") failed = event.message;
        },
        (fraction) => {
          if (fraction < 1) status(t("transcribe.uploading", { pct: Math.round(fraction * 100) }));
        },
      );
    } catch (err) {
      failed = err.message;
    }
    busy = false;
    overlay.classList.remove("busy");
    if (doc) {
      close();
      await onDone(doc);
      return;
    }
    status(failed || t("transcribe.failed"), true);
    for (const sel of ["[data-record]", "[data-file]", "[data-title]", "[data-lang]"]) $(sel).disabled = false;
    $("[data-start]").disabled = !file;
  });
}

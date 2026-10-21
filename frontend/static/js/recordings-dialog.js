// A document's recordings (made while dictating - see recording.js): play,
// download or delete each. Built on demand with the quick-open overlay
// classes, like transcribe.js.

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// What the recordings-list upload accepts. Kept in step with
// storage.RECORDING_EXTS (plus "wave", stored as wav).
const UPLOAD_EXTS = new Set(["m4a", "mp3", "wav", "wave", "webm", "ogg", "opus", "aac", "flac", "mp4"]);
const UPLOAD_ACCEPT = "audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.webm,.mp4";

function fileExt(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function localStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Length when the browser can see it, otherwise null. A file the player
// can't sniff still uploads; the queue just won't know the duration.
function fileDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    const finish = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      finish(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    audio.src = url;
  });
}

// "20261018-193012-ab12.m4a" -> a Date for 2026-10-18 19:30:12 local.
function startedAt(id) {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// The download, fetched here rather than left to the link: the server
// converts the recording before the first byte goes out (a long one takes
// a while), and the browser shows nothing meanwhile. `onProgress(text)`
// says where it's got to; the file is then saved under `name`.
async function downloadWithProgress(url, name, onProgress) {
  onProgress(t("recordings.preparing"));
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const mb = (received / 1024 / 1024).toFixed(1);
    onProgress(total ? t("recordings.downloadingPercent", { percent: Math.floor((received / total) * 100), mb }) : t("recordings.downloadingMb", { mb }));
  }
  const blobUrl = URL.createObjectURL(new Blob(chunks, { type: res.headers.get("content-type") || "audio/mp4" }));
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

// `onChange()` is called after a delete, so the tree's count can follow.
// `onTranscribe(name, url)`, when given, gets a recording to play and write
// down (the editor's audio-file bar); the dialog closes for it.
export async function openRecordingsDialog({ projectId, sessionId, filename, onChange = () => {}, onTranscribe = null }) {
  const overlay = document.createElement("div");
  overlay.className = "quick-open-overlay";
  overlay.innerHTML = `
    <div class="quick-open-panel recordings-panel" role="dialog" aria-modal="true">
      <div class="shortcuts-header">
        <span></span>
        <button class="icon-btn" type="button" data-close>×</button>
      </div>
      <div class="recordings-body" data-body></div>
    </div>`;
  const $ = (sel) => overlay.querySelector(sel);
  $(".shortcuts-header span").textContent = t("recordings.title", { filename });
  $("[data-close]").title = t("ui.close");
  const body = $("[data-body]");
  body.innerHTML = `<p class="recordings-empty">${escapeHtml(t("recordings.loading"))}</p>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.querySelectorAll("audio").forEach((audio) => audio.pause());
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

  // Always there, including when the list is empty: the empty state is
  // how a file gets onto a document that has no recording yet.
  function mountUpload(parent) {
    const bar = document.createElement("div");
    bar.className = "recordings-upload";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-btn";
    button.textContent = t("recordings.upload");
    button.title = t("recordings.uploadType");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = UPLOAD_ACCEPT;
    input.hidden = true;
    const progress = document.createElement("span");
    progress.className = "recordings-progress";
    progress.hidden = true;
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (file) send(file);
    });

    async function send(file) {
      progress.hidden = false;
      progress.classList.remove("error");
      if (!UPLOAD_EXTS.has(fileExt(file.name))) {
        progress.textContent = t("recordings.uploadFailed", { message: t("recordings.uploadType") });
        return;
      }
      button.disabled = true;
      progress.textContent = t("recordings.uploading");
      try {
        const duration = await fileDuration(file);
        await api.uploadRecording(projectId, sessionId, filename, file, {
          started: localStamp(new Date()),
          durationSec: duration,
          onProgress: (ratio) => {
            progress.textContent = t("recordings.uploadingPercent", { percent: Math.floor(ratio * 100) });
          },
        });
      } catch (err) {
        progress.classList.add("error");
        progress.textContent = t("recordings.uploadFailed", { message: err.message });
        button.disabled = false;
        return;
      }
      await onChange();
      render();
    }

    bar.append(button, input, progress);
    parent.appendChild(bar);
  }

  async function render() {
    let recordings;
    try {
      recordings = await api.listRecordings(projectId, sessionId, filename);
    } catch (err) {
      body.innerHTML = `<p class="recordings-empty error">${escapeHtml(err.message)}</p>`;
      return;
    }
    body.innerHTML = "";
    mountUpload(body);
    if (!recordings.length) {
      const empty = document.createElement("p");
      empty.className = "recordings-empty";
      empty.textContent = t("recordings.none");
      body.appendChild(empty);
      return;
    }
    for (const rec of [...recordings].reverse()) {
      const url = api.recordingsUrl(projectId, sessionId, filename, rec.id);
      // Played and downloaded as the server's mono AAC copy: it plays
      // anywhere (Safari won't play a MediaRecorder WebM), and iOS records
      // some microphones with one side silent, which the copy fixes.
      const m4a = `${url}?format=m4a`;
      const src = m4a;
      const when = startedAt(rec.id);
      const item = document.createElement("div");
      item.className = "recordings-item";
      item.innerHTML = `
        <div class="recordings-meta">
          <span>${escapeHtml(when ? when.toLocaleString(getLanguage()) : rec.id)}</span>
          <span class="recordings-size">${rec.size >= 1024 * 1024 ? `${(rec.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(rec.size / 1024)} KB`}</span>
          <span class="recordings-progress" data-progress hidden></span>
          <a class="icon-btn" href="${m4a}" download data-download title="${escapeHtml(t("recordings.download"))}">⤓</a>
          <button class="icon-btn" type="button" data-delete title="${escapeHtml(t("recordings.delete"))}">×</button>
        </div>
        <audio controls preload="none" src="${src}"></audio>
        <div class="recordings-skip">
          <button class="secondary-btn" type="button" data-skip="-10" title="${escapeHtml(t("audio.back10"))}">↺10</button>
          <button class="secondary-btn" type="button" data-skip="10" title="${escapeHtml(t("audio.forward10"))}">10↻</button>
          ${onTranscribe ? `<button class="secondary-btn recordings-transcribe" type="button" data-transcribe title="${escapeHtml(t("recordings.transcribeTitle"))}">🎤 ${escapeHtml(t("recordings.transcribe"))}</button>` : ""}
        </div>
        <div class="recordings-video" data-video></div>`;
      // preload="none": nothing is fetched (or converted) until its own
      // play button is pressed.
      // No copy to be had (the server couldn't convert) - the original.
      const audio = item.querySelector("audio");
      audio.addEventListener("error", () => (audio.src = url), { once: true });
      const downloadLink = item.querySelector("[data-download]");
      const progress = item.querySelector("[data-progress]");
      let downloading = false;
      // The first play waits on the server's copy (see downloadWithProgress) -
      // said beside ⤓ like a download's progress, until it plays.
      const preparing = (text) => {
        if (downloading) return;
        progress.hidden = !text;
        progress.textContent = text || "";
      };
      audio.addEventListener("play", () => audio.readyState < 3 && preparing(t(audio.readyState ? "recordings.buffering" : "recordings.preparing")));
      audio.addEventListener("waiting", () => preparing(t(audio.readyState ? "recordings.buffering" : "recordings.preparing")));
      for (const type of ["playing", "pause", "error"]) audio.addEventListener(type, () => preparing(null));
      downloadLink.addEventListener("click", async (e) => {
        e.preventDefault();
        if (downloading) return;
        downloading = true;
        downloadLink.classList.add("busy");
        progress.hidden = false;
        try {
          const base = filename.replace(/\.md$/, "");
          await downloadWithProgress(m4a, `${base}-${rec.id.replace(/\.[^.]+$/, "")}.m4a`, (text) => (progress.textContent = text));
          progress.textContent = t("recordings.downloaded");
          setTimeout(() => (progress.hidden = true), 3000);
        } catch (err) {
          progress.textContent = t("recordings.downloadFailed", { message: err.message });
        } finally {
          downloading = false;
          downloadLink.classList.remove("busy");
        }
      });
      const transcribeBtn = item.querySelector("[data-transcribe]");
      if (transcribeBtn)
        transcribeBtn.addEventListener("click", () => {
          close();
          onTranscribe(when ? when.toLocaleString(getLanguage()) : rec.id, m4a);
        });
      item.querySelectorAll("[data-skip]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const end = Number.isFinite(audio.duration) ? audio.duration : Infinity;
          audio.currentTime = Math.min(Math.max(0, audio.currentTime + Number(btn.dataset.skip)), end);
        })
      );
      item.querySelector("[data-delete]").addEventListener("click", async () => {
        if (!confirm(t("recordings.deleteConfirm"))) return;
        try {
          await api.deleteRecording(projectId, sessionId, filename, rec.id);
        } catch (err) {
          alert(err.message);
          return;
        }
        onChange();
        render();
      });
      fillVideoRow(item.querySelector("[data-video]"), rec);
      body.appendChild(item);
    }
  }
  // YouTube queue: new recordings are opted in when the upload finishes
  // (recording.js). This row is how an older one is added, or a queued
  // one is taken back, and where the worker's progress shows up.
  function fillVideoRow(row, rec) {
    const video = rec.video;
    const status = video && video.status;

    const span = (text, className) => {
      const el = document.createElement("span");
      if (className) el.className = className;
      el.textContent = text;
      return el;
    };
    const button = (label, title) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "secondary-btn";
      el.textContent = label;
      if (title) el.title = title;
      return el;
    };
    async function setEnqueue(enqueue) {
      try {
        await api.setRecordingVideo(projectId, sessionId, filename, rec.id, { enqueue });
      } catch (err) {
        alert(err.message);
        return;
      }
      render();
    }

    if (!video || status === "cancelled") {
      const btn = button(t("recordings.videoQueue"), t("recordings.videoQueueTitle"));
      btn.addEventListener("click", () => setEnqueue(true));
      row.appendChild(btn);
      return;
    }
    if (video.attempt > 0 && (status === "queued" || status === "failed")) {
      row.appendChild(span(t("recordings.videoAttempt", { attempt: video.attempt }), "recordings-size"));
    }
    if (status === "queued") {
      row.appendChild(span(t("recordings.videoQueued")));
      const btn = button(t("recordings.videoRemove"));
      btn.addEventListener("click", () => setEnqueue(false));
      row.appendChild(btn);
    } else if (status === "claimed") {
      const prog = video.progress;
      const text =
        prog && prog.percent != null
          ? t("recordings.videoWorkingPercent", { percent: prog.percent })
          : prog && prog.message
            ? t("recordings.videoWorkingDetail", { message: prog.message })
            : t("recordings.videoWorking");
      row.appendChild(span(text));
    } else if (status === "succeeded") {
      const link = document.createElement("a");
      link.href = video.youtube_url || `https://www.youtube.com/watch?v=${encodeURIComponent(video.youtube_video_id || "")}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = t("recordings.videoDone");
      row.appendChild(link);
    } else if (status === "failed") {
      row.appendChild(span(t("recordings.videoFailed", { message: video.error || "" }), "recordings-video-error"));
      const again = button(t("recordings.videoRetry"));
      again.addEventListener("click", () => setEnqueue(true));
      const drop = button(t("recordings.videoRemove"));
      drop.addEventListener("click", () => setEnqueue(false));
      row.append(again, drop);
    }
    if (video.transcript) {
      const details = document.createElement("details");
      details.className = "recordings-video-transcript";
      const summary = document.createElement("summary");
      summary.textContent = t("recordings.videoTranscript");
      const pre = document.createElement("pre");
      pre.textContent = video.transcript;
      details.append(summary, pre);
      row.appendChild(details);
    }
  }

  render();
}

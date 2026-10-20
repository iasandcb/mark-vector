// A document's recordings (made while dictating - see recording.js): play,
// download or delete each. Built on demand with the quick-open overlay
// classes, like transcribe.js.

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// "20261018-193012-ab12.m4a" -> a Date for 2026-10-18 19:30:12 local.
function startedAt(id) {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
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

  async function render() {
    let recordings;
    try {
      recordings = await api.listRecordings(projectId, sessionId, filename);
    } catch (err) {
      body.innerHTML = `<p class="recordings-empty error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!recordings.length) {
      body.innerHTML = `<p class="recordings-empty">${escapeHtml(t("recordings.none"))}</p>`;
      return;
    }
    body.innerHTML = "";
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
          <a class="icon-btn" href="${m4a}" download title="${escapeHtml(t("recordings.download"))}">⤓</a>
          <button class="icon-btn" type="button" data-delete title="${escapeHtml(t("recordings.delete"))}">×</button>
        </div>
        <audio controls preload="none" src="${src}"></audio>
        <div class="recordings-skip">
          <button class="secondary-btn" type="button" data-skip="-10" title="${escapeHtml(t("audio.back10"))}">↺10</button>
          <button class="secondary-btn" type="button" data-skip="10" title="${escapeHtml(t("audio.forward10"))}">10↻</button>
          ${onTranscribe ? `<button class="secondary-btn recordings-transcribe" type="button" data-transcribe title="${escapeHtml(t("recordings.transcribeTitle"))}">🎤 ${escapeHtml(t("recordings.transcribe"))}</button>` : ""}
        </div>`;
      // preload="none": nothing is fetched (or converted) until its own
      // play button is pressed.
      // No copy to be had (the server couldn't convert) - the original.
      const audio = item.querySelector("audio");
      audio.addEventListener("error", () => (audio.src = url), { once: true });
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
      body.appendChild(item);
    }
  }
  render();
}

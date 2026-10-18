// A document's recordings (made while dictating - see recording.js): play,
// download or delete each. Built on demand with the quick-open overlay
// classes, like transcribe.js.

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";

const APPLE = /Apple/.test(navigator.vendor || "");

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// "20261018-193012-ab12.m4a" -> a Date for 2026-10-18 19:30:12 local.
function startedAt(id) {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// `onChange()` is called after a delete, so the tree's count can follow.
export async function openRecordingsDialog({ projectId, sessionId, filename, onChange = () => {} }) {
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
      // Downloads are always the server's AAC copy, which plays anywhere.
      // Safari says it might play a WebM, then doesn't - the copy there too.
      const m4a = rec.id.endsWith(".m4a") ? url : `${url}?format=m4a`;
      const src = APPLE ? m4a : url;
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
        <audio controls preload="none" src="${src}"></audio>`;
      // preload="none": nothing is fetched (or converted) until its own
      // play button is pressed.
      // A recording made in another browser may not play here (iOS won't
      // play WebM from MediaRecorder) - then the server's AAC copy.
      const audio = item.querySelector("audio");
      audio.addEventListener(
        "error",
        () => {
          if (src !== m4a) audio.src = m4a;
        },
        { once: true },
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

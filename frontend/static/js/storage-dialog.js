// Volume usage and recording cleanup. Opened from the editor icon bar and
// from workspace settings. Text comes from i18n.js (Korean when the UI is).

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";
import { cleanupDecision, deleteRequest, formatBytes, formatPercent, previewLines, usageWarning } from "./storage-model.mjs";

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = getLanguage() === "ko" ? "ko-KR" : getLanguage() === "ja" ? "ja-JP" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function ask({ title, message, confirmLabel, lines = [], allowConfirm = true }) {
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-dialog storage-confirm";
  dialog.setAttribute("aria-labelledby", "storage-confirm-title");
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.id = "storage-confirm-title";
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.className = "storage-confirm-message";
  copy.textContent = message;
  form.append(heading, copy);
  if (lines.length) {
    const list = document.createElement("ul");
    list.className = "storage-preview-list";
    for (const line of lines) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = line.label;
      const size = document.createElement("span");
      size.textContent = formatBytes(line.size);
      item.append(name, size);
      list.append(item);
    }
    form.append(list);
  }
  const actions = document.createElement("div");
  actions.className = "workspace-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "submit";
  cancel.className = "secondary-btn";
  cancel.value = "cancel";
  cancel.textContent = t("storage.cancel");
  actions.append(cancel);
  if (allowConfirm) {
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "primary-btn";
    ok.value = "confirm";
    ok.textContent = confirmLabel;
    actions.append(ok);
  }
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    dialog.close(event.submitter?.value === "confirm" ? "confirm" : "cancel");
  });
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        dialog.close("cancel");
      }
    });
    dialog.showModal();
    (allowConfirm ? form.querySelector("[value=confirm]") : cancel).focus();
  });
}

export async function refreshStorageWarning() {
  const banner = document.getElementById("storage-warning");
  const badge = document.getElementById("storage-settings-badge");
  if (!banner && !badge) return;
  let usage = null;
  try {
    usage = await api.getStorageUsage();
  } catch {
    usage = null;
  }
  const warn = usageWarning(usage);
  if (banner) {
    banner.hidden = !warn;
    if (warn) {
      const percent = formatPercent(usage.percent_used);
      banner.textContent = t("storage.warning", { percent });
    }
  }
  if (badge) {
    badge.hidden = !warn;
    badge.textContent = warn ? `${formatPercent(usage.percent_used)}%` : "";
  }
}

export async function openStorageDialog({ onChanged = null } = {}) {
  if (document.querySelector(".storage-overlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "quick-open-overlay storage-overlay";
  overlay.innerHTML = `
    <div class="quick-open-panel storage-panel" role="dialog" aria-modal="true" aria-labelledby="storage-title">
      <div class="shortcuts-header">
        <span id="storage-title"></span>
        <button class="icon-btn" type="button" data-close>×</button>
      </div>
      <div class="storage-summary" data-summary></div>
      <div class="storage-actions">
        <label class="storage-select-all"><input type="checkbox" data-all><span data-all-label></span></label>
        <button class="secondary-btn" type="button" data-delete></button>
        <button class="secondary-btn" type="button" data-cleanup></button>
      </div>
      <div class="storage-list" data-list></div>
    </div>`;
  const $ = (sel) => overlay.querySelector(sel);
  $("#storage-title").textContent = t("storage.title");
  $("[data-close]").title = t("storage.close");
  $("[data-close]").setAttribute("aria-label", t("storage.close"));
  $("[data-all-label]").textContent = t("storage.selectAll");
  $("[data-delete]").textContent = t("storage.deleteSelected");
  $("[data-cleanup]").textContent = t("storage.cleanup");
  document.body.append(overlay);

  let recordings = [];
  let loose = [];
  const selected = new Set();
  let busy = false;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    if (document.querySelector("dialog.storage-confirm")) return;
    close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  $("[data-close]").addEventListener("click", close);

  function showError(err) {
    const list = $("[data-list]");
    const note = document.createElement("p");
    note.className = "storage-empty error";
    note.textContent = t("storage.error", { message: err.message || String(err) });
    list.prepend(note);
  }

  function paintUsage(usage) {
    const summary = $("[data-summary]");
    summary.replaceChildren();
    const text = document.createElement("p");
    text.className = "storage-usage";
    text.textContent = t("storage.usage", {
      used: formatBytes(usage.used_bytes),
      total: formatBytes(usage.total_bytes),
      free: formatBytes(usage.free_bytes),
      percent: formatPercent(usage.percent_used),
    });
    const meter = document.createElement("div");
    meter.className = "storage-meter";
    meter.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    const percent = Math.max(0, Math.min(100, Number(usage.percent_used) || 0));
    fill.style.width = `${percent}%`;
    if (usageWarning(usage)) fill.classList.add("warn");
    meter.append(fill);
    summary.append(text, meter);
    if (usageWarning(usage)) {
      const warn = document.createElement("p");
      warn.className = "storage-inline-warn";
      warn.textContent = t("storage.warning", { percent: formatPercent(usage.percent_used) });
      summary.append(warn);
    }
  }

  function paintList() {
    const list = $("[data-list]");
    list.replaceChildren();
    if (!recordings.length && !loose.length) {
      const empty = document.createElement("p");
      empty.className = "storage-empty";
      empty.textContent = t("storage.empty");
      list.append(empty);
    }
    recordings.forEach((row, index) => {
      const label = document.createElement("label");
      label.className = "storage-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(index);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(index);
        else selected.delete(index);
        syncActions();
      });
      const main = document.createElement("span");
      main.className = "storage-row-main";
      const title = document.createElement("span");
      title.className = "storage-row-title";
      title.textContent = row.filename;
      const meta = document.createElement("span");
      meta.className = "storage-row-meta";
      const where = [row.project_title || row.project_id, row.folder_title || row.conv_id].filter(Boolean).join(" · ");
      meta.textContent = [where, formatWhen(row.date), formatBytes(row.size)].filter(Boolean).join(" · ");
      const yt = document.createElement("span");
      yt.className = row.youtube_uploaded ? "storage-row-yt done" : "storage-row-yt";
      yt.textContent = row.youtube_uploaded
        ? [t("storage.youtubeDone"), row.youtube_video_id].filter(Boolean).join(" · ")
        : t("storage.youtubePending");
      main.append(title, meta, yt);
      for (const copy of row.play_copies || []) {
        const play = document.createElement("span");
        play.className = "storage-row-play";
        play.textContent = t("storage.playCopy", { size: formatBytes(copy.size) });
        main.append(play);
      }
      label.append(box, main);
      list.append(label);
    });
    for (const copy of loose) {
      const row = document.createElement("div");
      row.className = "storage-row storage-row-loose";
      const main = document.createElement("span");
      main.className = "storage-row-main";
      const title = document.createElement("span");
      title.className = "storage-row-title";
      title.textContent = t("storage.loosePlay");
      const meta = document.createElement("span");
      meta.className = "storage-row-meta";
      const where = [copy.project_title || copy.project_id, copy.filename, copy.name].filter(Boolean).join(" · ");
      meta.textContent = `${where} · ${formatBytes(copy.size)}`;
      main.append(title, meta);
      row.append(main);
      list.append(row);
    }
    syncActions();
  }

  function syncActions() {
    const all = $("[data-all]");
    all.checked = recordings.length > 0 && selected.size === recordings.length;
    all.indeterminate = selected.size > 0 && selected.size < recordings.length;
    all.disabled = busy || recordings.length === 0;
    $("[data-delete]").disabled = busy || selected.size === 0;
    $("[data-cleanup]").disabled = busy;
  }

  async function load() {
    const list = $("[data-list]");
    list.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "storage-empty";
    loading.textContent = t("storage.loading");
    list.append(loading);
    try {
      const [usage, inventory] = await Promise.all([api.getStorageUsage(), api.listStorageRecordings()]);
      if (!overlay.isConnected) return;
      recordings = inventory.recordings || [];
      loose = inventory.loose_play_copies || [];
      selected.clear();
      paintUsage(usage);
      paintList();
    } catch (err) {
      if (!overlay.isConnected) return;
      list.replaceChildren();
      showError(err);
    }
  }

  async function afterChange(refs) {
    try {
      if (onChanged) await onChanged(refs);
    } finally {
      await refreshStorageWarning();
    }
    if (overlay.isConnected) await load();
  }

  $("[data-all]").addEventListener("change", (event) => {
    selected.clear();
    if (event.target.checked) recordings.forEach((_, index) => selected.add(index));
    paintList();
  });

  $("[data-delete]").addEventListener("click", async () => {
    const body = deleteRequest(recordings, selected);
    if (!body.recordings.length || busy) return;
    const ok = await ask({
      title: t("storage.deleteConfirmTitle"),
      message: t("storage.deleteConfirm", { count: body.recordings.length }),
      confirmLabel: t("storage.deleteSelected"),
    });
    if (!ok || !overlay.isConnected) return;
    busy = true;
    syncActions();
    try {
      const result = await api.deleteStorageRecordings(body.recordings);
      await afterChange(result.recordings || body.recordings);
    } catch (err) {
      if (overlay.isConnected) showError(err);
    } finally {
      busy = false;
      if (overlay.isConnected) syncActions();
    }
  });

  $("[data-cleanup]").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    syncActions();
    try {
      const preview = await api.previewStorageCleanup();
      if (!overlay.isConnected) return;
      const decision = cleanupDecision(preview, false);
      const ok = await ask({
        title: t("storage.cleanupTitle"),
        message: decision.empty
          ? t("storage.cleanupEmpty")
          : t("storage.cleanupPreview", {
            originals: decision.originals,
            plays: decision.plays,
            freed: formatBytes(decision.freedBytes),
          }),
        confirmLabel: t("storage.cleanupConfirm"),
        lines: previewLines(preview),
        allowConfirm: !decision.empty,
      });
      if (!cleanupDecision(preview, ok).proceed || !overlay.isConnected) return;
      const result = await api.runStorageCleanup();
      await afterChange(result.originals || []);
    } catch (err) {
      if (overlay.isConnected) showError(err);
    } finally {
      busy = false;
      if (overlay.isConnected) syncActions();
    }
  });

  load();
}

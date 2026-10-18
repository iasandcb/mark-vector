// The preview pane's Evaluate and Formalize tabs: an LLM's reading of the
// document the preview is showing - how sound it is (and where it goes
// wrong) under one of three lenses (its mathematics, its facts and
// reasoning, its writing), or its mathematical argument as Lean 4. A fourth
// lens, "live", checks a lecture as it's being written down - see the
// live-mode section below. See
// backend/app/analysis.py for the prompts and routers/analysis.py for the
// endpoint. A run is started by hand and its result saved beside the
// document, so it comes back when the document is opened again; it's
// marked stale once the text has changed since.
//
// app.js owns the pane and the documents; this owns what the two tabs show.
// `deps`:
//   body, toolbar elements (see index.html's #analysis-view), lensSelect
//   alert(on) - mark the Evaluate tab: live mode found something unseen
//   getTarget() -> { projectId, sessionId, filename, content, dialect } | null
//                  (null: nothing open, or a document that can't be analyzed)
//   getSettings() -> { provider, model, reasoningEffort }
//   reveal(start, end) - select that range in the editor showing the target
//   renderMarkdown(text, dialect)

import * as api from "./api.js";
import { t, getLanguage } from "./i18n.js";
import { findText } from "./doc-edits.js";

const LEAN_WEB = "https://live.lean-lang.org/#code=";

// Evaluate's lenses -> the analysis kind each is run and saved as.
const LENS_KINDS = { math: "evaluate", logic: "evaluate-logic", writing: "evaluate-writing", live: "evaluate-live" };

// Live mode: when a changed passage is sent. Dictation rarely pauses, so a
// long enough run of new text goes without waiting for one.
const LIVE_TICK_MS = 1000;
const LIVE_BURST_CHARS = 200; // sent as soon as this much is new
const LIVE_PAUSE_MS = 2000; // or after a pause this long...
const LIVE_PAUSE_CHARS = 80; // ...with at least this much new
const LIVE_IDLE_MS = 15000; // or after a long pause, with any real change
const LIVE_IDLE_CHARS = 20;
const LIVE_RETRY_MS = 10000;
const LIVE_LOOKBACK_CHARS = 400; // how far a passage reaches back to its line's start

// What changed between the text last checked and the text now, as a range
// of `now` widened to whole lines (an addition at the end of a line brings
// the line's start along, so the model reads whole sentences). null when
// nothing was added - a pure deletion has nothing new to check.
export function changedRegion(old, now) {
  const max = Math.min(old.length, now.length);
  let p = 0;
  while (p < max && old[p] === now[p]) p++;
  let s = 0;
  while (s < max - p && old[old.length - 1 - s] === now[now.length - 1 - s]) s++;
  const end = now.length - s;
  if (end <= p) return null;
  const start = Math.max(p > 0 ? now.lastIndexOf("\n", p - 1) + 1 : 0, p - LIVE_LOOKBACK_CHARS);
  let stop = now.indexOf("\n", end);
  if (stop === -1) stop = now.length;
  return { start, end: stop, size: end - p };
}
const LENS_KEY = "markvector.evaluateLens";

function loadLens() {
  try {
    const lens = localStorage.getItem(LENS_KEY);
    if (lens in LENS_KINDS) return lens;
  } catch (err) {
    // storage blocked - the default lens
  }
  return "math";
}

export function createAnalysisPanel(deps) {
  const { body, runBtn, status, copyBtn, leanLink, lensSelect, clearBtn, nowBtn } = deps;
  let view = null; // "evaluate" | "formalize" while one of the tabs is shown
  let lens = loadLens();
  lensSelect.value = lens;
  // What's run, saved and shown: the tab, and for Evaluate its lens.
  const kindOf = () => (view === "evaluate" ? LENS_KINDS[lens] : view);
  // `${projectId}/${sessionId}/${filename}` -> { [kind]: record }:
  // undefined = not fetched yet, null = none saved, else the saved record.
  const results = new Map();
  // `${key}:${kind}` -> { text, startedAt } for a run still streaming in.
  const running = new Map();
  let timer = null;
  let hashJob = 0;
  let currentHash = null;

  const keyOf = (target) => `${target.projectId}/${target.sessionId}/${target.filename}`;

  async function sha256(text) {
    if (!crypto.subtle) return null; // not a secure context - staleness just isn't shown
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function load(target) {
    const key = keyOf(target);
    const entry = results.get(key) || {};
    const loadingKind = kindOf();
    if (entry[loadingKind] !== undefined) return;
    entry[loadingKind] = null;
    results.set(key, entry);
    try {
      entry[loadingKind] = await api.getAnalysis(target.projectId, target.sessionId, target.filename, loadingKind);
    } catch (err) {
      entry[loadingKind] = undefined; // try again next time it's shown
      return;
    }
    render();
  }

  async function run() {
    if (kindOf() === "evaluate-live") return toggleLive();
    const target = deps.getTarget();
    if (!target || !view) return;
    const settings = deps.getSettings();
    if (!settings.provider || !settings.model) {
      status.textContent = t("analysis.noModel");
      return;
    }
    const runKind = kindOf();
    const key = keyOf(target);
    const job = { text: "", startedAt: Date.now(), error: null, dialect: target.dialect };
    running.set(`${key}:${runKind}`, job);
    render();
    try {
      const request = { ...settings, language: getLanguage(), mathDialect: target.dialect };
      await api.runAnalysis(target.projectId, target.sessionId, target.filename, runKind, target.content, request, (event) => {
        if (event.type === "delta") {
          job.text += event.text;
          if (kindOf() === runKind) renderRunning(job);
        } else if (event.type === "done") {
          const entry = results.get(key) || {};
          entry[runKind] = event.result;
          results.set(key, entry);
        } else if (event.type === "error") {
          job.error = event.message;
        }
      });
    } catch (err) {
      job.error = err.message;
    }
    running.delete(`${key}:${runKind}`);
    if (job.error) {
      // Kept on screen until the next render that isn't this one.
      const entry = results.get(key) || {};
      entry[`${runKind}Error`] = job.error;
      results.set(key, entry);
    }
    render();
  }

  function renderRunning(job) {
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    status.textContent = `${t("analysis.running", { seconds })}${job.text ? ` · ${t("analysis.received", { count: job.text.length })}` : ""}`;
    if (view === "formalize" && job.text) {
      body.innerHTML = deps.renderMarkdown(job.text, job.dialect);
    } else if (!body.querySelector(".analysis-spinner")) {
      body.innerHTML = `<div class="analysis-spinner" aria-hidden="true"></div>`;
    }
  }

  function setToolbar({ runLabel, runDisabled, code }) {
    runBtn.textContent = runLabel;
    runBtn.disabled = runDisabled;
    copyBtn.hidden = !code;
    leanLink.hidden = !code;
    if (code) leanLink.href = LEAN_WEB + encodeURIComponent(code);
  }

  function metaLine(record) {
    const when = record.created_at ? new Date(record.created_at).toLocaleString(getLanguage()) : "";
    return [when, record.model].filter(Boolean).join(" · ");
  }

  function render() {
    clearInterval(timer);
    timer = null;
    if (!view) return;
    lensSelect.hidden = view !== "evaluate";
    const kind = kindOf();
    clearBtn.hidden = true;
    nowBtn.hidden = true;
    if (kind === "evaluate-live") return renderLive();
    const target = deps.getTarget();
    if (!target) {
      setToolbar({ runLabel: t(view === "evaluate" ? "analysis.runEvaluate" : "analysis.runFormalize"), runDisabled: true });
      status.textContent = "";
      body.innerHTML = `<p class="analysis-empty">${escapeHtml(t("analysis.noDocument"))}</p>`;
      return;
    }
    const key = keyOf(target);
    const entry = results.get(key) || {};
    const record = entry[kind];
    const job = running.get(`${key}:${kind}`);
    const runLabel = t(record ? "analysis.rerun" : view === "evaluate" ? "analysis.runEvaluate" : "analysis.runFormalize");
    setToolbar({ runLabel, runDisabled: !!job, code: !job && view === "formalize" && record && record.code });

    if (job) {
      renderRunning(job);
      timer = setInterval(() => renderRunning(job), 1000);
      return;
    }
    if (record === undefined) load(target);

    const error = entry[`${kind}Error`];
    if (error) delete entry[`${kind}Error`];
    status.textContent = error ? t("analysis.failed", { message: error }) : record ? metaLine(record) : "";
    if (record && currentHash && record.content_sha256 && record.content_sha256 !== currentHash) {
      status.insertAdjacentHTML("beforeend", ` <span class="analysis-stale">${escapeHtml(t("analysis.stale"))}</span>`);
    }

    if (!record) {
      const empty = view === "evaluate" ? `analysis.empty.${lens}` : "analysis.emptyFormalize";
      body.innerHTML = `<p class="analysis-empty">${escapeHtml(t(empty))}</p>`;
      return;
    }
    body.innerHTML = "";
    if (view === "evaluate") renderEvaluation(record, target);
    else renderFormalization(record, target);
  }

  function renderEvaluation(record, target) {
    const md = (text) => deps.renderMarkdown(text, target.dialect);
    if (record.raw !== undefined) {
      body.insertAdjacentHTML("beforeend", `<p class="analysis-note">${escapeHtml(t("analysis.unparsed"))}</p>${md(record.raw)}`);
      return;
    }
    const head = document.createElement("div");
    head.className = `analysis-verdict verdict-${record.verdict || "unknown"}`;
    // The writing lens has its own words for the same three verdicts.
    const label = record.verdict
      ? t(lens === "writing" ? `analysis.verdictWriting.${record.verdict}` : `analysis.verdict.${record.verdict}`)
      : "";
    head.innerHTML = `
      <div class="analysis-verdict-line">
        ${label ? `<span class="analysis-verdict-badge">${escapeHtml(label)}</span>` : ""}
        ${record.score != null ? `<span class="analysis-score">${record.score}<small>/100</small></span>` : ""}
      </div>
      <div class="analysis-summary">${md(record.summary || "")}</div>`;
    body.appendChild(head);

    if (!record.issues.length) {
      if (record.verdict !== "no_math" && record.verdict !== "no_claims") {
        body.insertAdjacentHTML("beforeend", `<p class="analysis-empty">${escapeHtml(t("analysis.noIssues"))}</p>`);
      }
      return;
    }
    body.appendChild(issueList(record.issues, target));
  }

  // The issues as a list whose items, when their quote is still in the
  // text, select it in the editor on a click.
  function issueList(issues, target, { withTime = false } = {}) {
    const md = (text) => deps.renderMarkdown(text, target.dialect);
    const list = document.createElement("ol");
    list.className = "analysis-issues";
    for (const issue of issues) {
      const item = document.createElement("li");
      item.className = `analysis-issue severity-${issue.severity}`;
      const found = issue.quote ? findText(target.content, issue.quote) : null;
      item.innerHTML = `
        <div class="analysis-issue-head">
          <span class="analysis-severity">${escapeHtml(t(lens === "writing" && issue.severity === "warning" ? "analysis.severityWriting.warning" : `analysis.severity.${issue.severity}`))}</span>
          ${issue.quote ? `<div class="analysis-quote">${md(found ? quoteSource(target.content, issue.quote, found[0]) : issue.quote)}</div>` : ""}
          ${withTime && issue.at ? `<span class="analysis-time">${escapeHtml(new Date(issue.at).toLocaleTimeString(getLanguage()))}</span>` : ""}
        </div>
        <div class="analysis-problem">${md(issue.problem)}</div>
        ${issue.correction ? `<div class="analysis-correction"><strong>${escapeHtml(t("analysis.correction"))}</strong> ${md(issue.correction)}</div>` : ""}`;
      if (found) {
        item.classList.add("locatable");
        item.title = t("analysis.showInEditor");
        item.addEventListener("click", (e) => {
          if (e.target.closest("a")) return;
          // Looked up again: the text may have moved since this was drawn.
          const now = deps.getTarget();
          const at = now ? findText(now.content, issue.quote) : null;
          if (at) deps.reveal(at[0], at[1]);
        });
      } else if (issue.quote) {
        item.querySelector(".analysis-issue-head").insertAdjacentHTML(
          "beforeend",
          `<span class="analysis-missing">${escapeHtml(t("analysis.quoteNotFound"))}</span>`
        );
      }
      list.appendChild(item);
    }
    return list;
  }

  function renderFormalization(record, target) {
    if (record.code) {
      const pre = document.createElement("pre");
      pre.className = "analysis-lean";
      const code = document.createElement("code");
      code.className = "language-lean";
      code.textContent = record.code;
      pre.appendChild(code);
      body.appendChild(pre);
    } else {
      body.insertAdjacentHTML("beforeend", `<p class="analysis-note">${escapeHtml(t("analysis.noCode"))}</p>`);
    }
    if (record.notes) {
      const notes = document.createElement("div");
      notes.className = "analysis-notes";
      notes.innerHTML = deps.renderMarkdown(record.notes, target.dialect);
      body.appendChild(notes);
    }
  }

  // ---------- live mode ----------
  // While it's on, every second: if the document it was started on is the
  // one being shown and enough has changed since the last check (see the
  // LIVE_ constants), the changed passage goes off to be checked - one at a
  // time, whatever came in meanwhile waits for the next. Issues pile up in
  // the saved "evaluate-live" record, newest shown first. Text already in
  // the document when it starts isn't checked: the other lenses are for
  // that.
  let live = null; // { key, baseline, lastChange, inFlight, retryAt, error, lastCheckAt }
  let liveTimer = null;

  function toggleLive() {
    if (live) return stopLive();
    const target = deps.getTarget();
    if (!target) return;
    const settings = deps.getSettings();
    if (!settings.provider || !settings.model) {
      status.textContent = t("analysis.noModel");
      return;
    }
    live = { key: keyOf(target), baseline: target.content, lastChange: Date.now(), inFlight: false, retryAt: 0, error: null, lastCheckAt: null };
    liveTimer = setInterval(liveTick, LIVE_TICK_MS);
    render();
  }

  function stopLive() {
    clearInterval(liveTimer);
    liveTimer = null;
    live = null;
    render();
  }

  async function liveTick() {
    if (!live || live.inFlight) return;
    const target = deps.getTarget();
    const showing = isLiveShown();
    if (!target || keyOf(target) !== live.key) {
      if (showing) liveStatus();
      return;
    }
    const now = Date.now();
    const region = now >= live.retryAt ? changedRegion(live.baseline, target.content) : null;
    const quiet = now - live.lastChange;
    const due =
      region &&
      (live.force ||
        region.size >= LIVE_BURST_CHARS ||
        (quiet >= LIVE_PAUSE_MS && region.size >= LIVE_PAUSE_CHARS) ||
        (quiet >= LIVE_IDLE_MS && region.size >= LIVE_IDLE_CHARS));
    if (!due) {
      if (showing) liveStatus();
      return;
    }
    const session = live;
    session.force = false;
    session.inFlight = true;
    session.sentSize = region.size;
    if (showing) liveStatus();
    const sent = target.content;
    const settings = { ...deps.getSettings(), language: getLanguage(), mathDialect: target.dialect };
    try {
      const { record, added } = await api.liveCheck(target.projectId, target.sessionId, target.filename, sent, region.start, region.end, settings);
      session.baseline = sent;
      session.error = null;
      session.lastCheckAt = Date.now();
      const entry = results.get(session.key) || {};
      entry["evaluate-live"] = record;
      results.set(session.key, entry);
      if (added.length && !isLiveShown()) deps.alert(true);
    } catch (err) {
      session.error = err.message;
      session.retryAt = Date.now() + LIVE_RETRY_MS;
    }
    session.inFlight = false;
    if (live === session && isLiveShown()) render();
  }

  const isLiveShown = () => view === "evaluate" && lens === "live" && !document.hidden;

  function liveStatus() {
    if (!live) return;
    const target = deps.getTarget();
    const parts = [];
    nowBtn.disabled = true;
    if (!target || keyOf(target) !== live.key) parts.push(t("analysis.live.otherDoc"));
    else if (live.inFlight) parts.push(t("analysis.live.checkingChars", { count: live.sentSize }));
    else {
      parts.push(t("analysis.live.listening"));
      // How much is waiting to be checked, against the burst size.
      const region = changedRegion(live.baseline, target.content);
      nowBtn.disabled = !region;
      parts.push(t("analysis.live.newChars", { count: region ? region.size : 0, burst: LIVE_BURST_CHARS }));
    }
    const record = (results.get(live.key) || {})["evaluate-live"];
    if (record) parts.push(t("analysis.live.checks", { count: record.checks || 0 }));
    if (live.lastCheckAt) parts.push(t("analysis.live.ago", { seconds: Math.round((Date.now() - live.lastCheckAt) / 1000) }));
    status.textContent = parts.join(" · ");
    status.title = t("analysis.live.newCharsTitle", { burst: LIVE_BURST_CHARS, pause: LIVE_PAUSE_MS / 1000, pauseChars: LIVE_PAUSE_CHARS, idle: LIVE_IDLE_MS / 1000, idleChars: LIVE_IDLE_CHARS });
    if (live.error) status.insertAdjacentHTML("beforeend", ` <span class="analysis-stale">${escapeHtml(t("analysis.failed", { message: live.error }))}</span>`);
  }

  function renderLive() {
    deps.alert(false);
    const target = deps.getTarget();
    const key = target && keyOf(target);
    const on = !!live && live.key === key;
    runBtn.textContent = t(live ? "analysis.live.stop" : "analysis.live.start");
    // Stopping works from any document; starting needs one open.
    runBtn.disabled = !live && !target;
    runBtn.classList.toggle("live-on", !!live);
    copyBtn.hidden = true;
    leanLink.hidden = true;
    if (!target) {
      status.textContent = "";
      if (live) liveStatus();
      body.innerHTML = `<p class="analysis-empty">${escapeHtml(t("analysis.noDocument"))}</p>`;
      return;
    }
    const entry = results.get(key) || {};
    const record = entry["evaluate-live"];
    if (record === undefined) load(target);
    clearBtn.hidden = !record || on;
    nowBtn.hidden = !on;
    if (live) liveStatus();
    else status.textContent = record ? metaLine(record) : "";
    if (!record || (!record.issues.length && !on)) {
      body.innerHTML = `<p class="analysis-empty">${escapeHtml(t("analysis.empty.live"))}</p>`;
      return;
    }
    body.innerHTML = "";
    if (!record.issues.length) {
      body.insertAdjacentHTML("beforeend", `<p class="analysis-empty">${escapeHtml(t("analysis.live.none"))}</p>`);
      return;
    }
    body.appendChild(issueList([...record.issues].reverse(), target, { withTime: true }));
  }

  // Sends what's new right away instead of waiting for the size or pause
  // (or for a failed check's retry).
  nowBtn.addEventListener("click", () => {
    if (!live || live.inFlight) return;
    live.force = true;
    live.retryAt = 0;
    liveTick();
  });

  clearBtn.addEventListener("click", async () => {
    const target = deps.getTarget();
    if (!target || (live && live.key === keyOf(target))) return;
    if (!confirm(t("analysis.live.clearConfirm"))) return;
    try {
      await api.deleteAnalysis(target.projectId, target.sessionId, target.filename, "evaluate-live");
      (results.get(keyOf(target)) || {})["evaluate-live"] = null;
    } catch (err) {
      status.textContent = t("analysis.failed", { message: err.message });
      return;
    }
    render();
  });

  // The text changed, or the preview now follows another document: the
  // stale mark is worked out again once typing pauses.
  let debounce = null;
  function contentChanged() {
    if (live) live.lastChange = Date.now();
    if (!view) return;
    clearTimeout(debounce);
    debounce = setTimeout(refreshHash, 400);
  }

  async function refreshHash() {
    const target = deps.getTarget();
    const job = ++hashJob;
    const hash = target ? await sha256(target.content) : null;
    if (job !== hashJob) return;
    currentHash = hash;
    render();
  }

  runBtn.addEventListener("click", run);
  lensSelect.addEventListener("change", () => {
    lens = lensSelect.value in LENS_KINDS ? lensSelect.value : "math";
    try {
      localStorage.setItem(LENS_KEY, lens);
    } catch (err) {
      // storage blocked - kept for this page only
    }
    render();
  });
  copyBtn.addEventListener("click", async () => {
    const target = deps.getTarget();
    const record = target && (results.get(keyOf(target)) || {}).formalize;
    if (!record || !record.code) return;
    try {
      await navigator.clipboard.writeText(record.code);
      copyBtn.textContent = "✓";
      setTimeout(() => (copyBtn.textContent = "⧉"), 1200);
    } catch (err) {
      // clipboard blocked - the code is on screen to select by hand
    }
  });

  return {
    // null hides the analysis (the Preview tab is showing).
    show(nextView) {
      view = nextView;
      if (!view) {
        clearInterval(timer);
        return;
      }
      render();
      refreshHash();
    },
    contentChanged,
    // A document went away or was renamed - its cached results with it.
    forget(projectId, sessionId, filename) {
      const key = `${projectId}/${sessionId}/${filename}`;
      results.delete(key);
      if (live && live.key === key) stopLive();
    },
  };
}

// A quote as Markdown that renders the way it does in the document. A line
// quoted from inside a $$ block, or a piece of an inline $...$, carries no
// delimiters of its own and would show as plain text - so it gets the "$"
// it sits inside of (inline, to fit the grey box), and a closing one if it
// doesn't already end the span.
export function quoteSource(content, quote, at) {
  const before = content.slice(0, at);
  const dollars = (text) => (text.replace(/\\\$/g, "").match(/\$/g) || []).length;
  const inDisplay = (before.match(/\$\$/g) || []).length % 2 === 1;
  const line = before.slice(before.lastIndexOf("\n") + 1).replace(/\$\$/g, "");
  const inInline = !inDisplay && dollars(line) % 2 === 1;
  // Outside math, a quote that stops partway into a span gets it closed.
  if (!inDisplay && !inInline) return dollars(quote) % 2 === 1 ? quote + "$" : quote;
  const body = inDisplay ? quote.replace(/\$\$/g, "") : quote;
  const opened = "$" + body;
  return dollars(opened) % 2 === 1 ? opened + "$" : opened;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

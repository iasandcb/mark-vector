import * as api from "./api.js";
import { createDocumentFollower } from "./document-sync.mjs";
import {
  renderMarkdown,
  detectMathDirective,
  convertAsciiMathToLatex,
  setCustomAsciiMathSymbols,
  spokenMathToAsciiMath,
  parseSpokenMathCsv,
  setSpokenMathVocabulary,
  splitMathBlockCommands,
  parseCustomSymbolsCsv,
  firstH1Heading,
} from "./markdown.js";
import { t, getLanguage, applyStaticTranslations, createLanguageSelect, exchangeHeadingRole } from "./i18n.js";
import { createEditor } from "./editor.js";
import { openTranscribeDialog } from "./transcribe.js";
import { openRecordingsDialog } from "./recordings-dialog.js";
import { createGamepadRemote } from "./remote.js";
import { splitSlides, lastSlideStart } from "./slides.js";
import { startRealtimeTranscription } from "./realtime-stt.js";
import { startSonioxTranscription } from "./soniox-stt.js";
import { effectiveDictationEngine, enginesOffered, fileEngineDetailKey, fileEngineNoticeKey, normalizeStoredEngine, resolveDictationEngine } from "./dictation-engine.mjs";
import { dictationControlState, recordControlState } from "./dictation-button.mjs";
import { consumeSonioxTranscript, limitContextTerms, spokenPhrasesFromCsv } from "./soniox-session.mjs";
import {
  FILE_RECONNECT_CAP,
  audioContextNeedsResume,
  bufferSteps,
  captureInterrupted,
  fileContextAction,
  fileErrorText,
  filePauseKind,
  fileProviderFailureAction,
  fileResumeAction,
  sessionStops,
  shouldReconnectFileSession,
  transcriptDestination,
  uplinkNeedsRebuild,
} from "./file-dictation.mjs";
import { formatPlaybackClock, parsePlaybackTime, playbackJump, PLAYBACK_JUMP_MESSAGE } from "./audio-time.mjs";
import {
  beginMicSession,
  claimPlaybackSession,
  clearMediaSession,
  createDuckRetry,
  endMicSession,
  publishMediaSession,
  releasePlaybackSession,
  setMediaPlaybackState,
  tapSyncAction,
} from "./playback-session.mjs";
import { captureAudio } from "./mic-capture.mjs";
import { createWebSpeechTranscript, webSpeechAfterEnd, webSpeechAfterStartError } from "./web-speech-session.mjs";
import { recordingSupported, startRecording, RECORDING_AUDIO } from "./recording.js";
import { parseEditBlocks, applyEditBlock, collapseEditBlocks } from "./doc-edits.js";
import { createAnalysisPanel } from "./analysis.js";
import { punctuateSpeech } from "./punctuation.js";
import { expectsText } from "./glasses-link.mjs";
import { mountDiscussion } from "./discussion-pane.js";

// Inline-thread markers. Declared up here, away from the rest of the
// inline-thread code further down, because `el` below builds the editor,
// and the editor asks what's foldable before this module has finished
// evaluating - a `const` declared after `el` is still in its temporal dead
// zone at that point. The opening marker carries the thread's own
// collapsed/expanded state, so it travels with the document instead of
// living in per-browser view state; expanded means "render this in the
// preview" (see renderDocumentWithThreads), while a published page strips
// every thread either way. Kept in sync with storage.py's
// _INLINE_THREAD_RE, which strips the same two spellings server-side.
const INLINE_THREAD_OPEN = "<!-- inline -->";
const INLINE_THREAD_OPEN_SHOWN = "<!-- inline: show -->";
const INLINE_THREAD_CLOSE = "<!-- /inline -->";
const INLINE_OPEN_RE = /^<!--\s*inline\s*(?::\s*(show)\s*)?-->$/i;
const INLINE_CLOSE_RE = /^<!--\s*\/inline\s*-->$/i;

const el = {
  layout: document.getElementById("layout"),
  treePane: document.getElementById("tree-pane"),
  previewPane: document.getElementById("preview-pane"),
  previewTabs: document.getElementById("preview-tabs"),
  analysisView: document.getElementById("analysis-view"),
  analysisRunBtn: document.getElementById("analysis-run-btn"),
  analysisStatus: document.getElementById("analysis-status"),
  analysisCopyBtn: document.getElementById("analysis-copy-btn"),
  analysisLeanLink: document.getElementById("analysis-lean-link"),
  analysisLensSelect: document.getElementById("analysis-lens-select"),
  analysisClearBtn: document.getElementById("analysis-clear-btn"),
  analysisNowBtn: document.getElementById("analysis-now-btn"),
  analysisBody: document.getElementById("analysis-body"),
  treeResizer: document.getElementById("tree-resizer"),
  previewResizer: document.getElementById("preview-resizer"),
  treeCollapseBtn: document.getElementById("tree-collapse-btn"),
  treeExpandBtn: document.getElementById("tree-expand-btn"),
  previewCollapseBtn: document.getElementById("preview-collapse-btn"),
  previewExpandBtn: document.getElementById("preview-expand-btn"),
  authInfo: document.getElementById("auth-info"),
  langSelectSlot: document.getElementById("lang-select-slot"),
  globalCustomSymbolsRow: document.getElementById("global-custom-symbols-row"),
  globalSpokenMathRow: document.getElementById("global-spoken-math-row"),
  sessionTree: document.getElementById("session-tree"),
  newProjectBtn: document.getElementById("new-project-btn"),
  providerSelect: document.getElementById("provider-select"),
  modelSelect: document.getElementById("model-select"),
  setDefaultModelBtn: document.getElementById("set-default-model-btn"),
  reasoningSelect: document.getElementById("reasoning-select"),
  contextScopeSelect: document.getElementById("context-scope-select"),
  formatSelect: document.getElementById("format-select"),
  providerWarning: document.getElementById("provider-warning"),
  editorToolbar: document.getElementById("editor-toolbar"),
  toolbarToggleBtn: document.getElementById("toolbar-toggle-btn"),
  // A textarea-shaped adapter over CodeMirror (see editor.js) - every
  // `el.editor.*` below is the same API a <textarea> would have offered,
  // which is why nothing else in this file had to change to gain folding.
  editor: createEditor(document.getElementById("editor"), {
    foldRanges: (text) => editorFoldRanges(text),
    onFoldToggle: (markerLineStart) => toggleInlineThreadAt(markerLineStart),
  }),
  preview: document.getElementById("preview"),
  printTarget: document.getElementById("print-target"),
  exportPdfBtn: document.getElementById("export-pdf-btn"),
  downloadMdBtn: document.getElementById("download-md-btn"),
  syncScrollCheckbox: document.getElementById("sync-scroll-checkbox"),
  glassesCheckbox: document.getElementById("glasses-checkbox"),
  glassesToolbar: document.getElementById("glasses-toolbar"),
  glassesStatusDot: document.getElementById("glasses-status-dot"),
  glassesUrlInput: document.getElementById("glasses-url-input"),
  glassesCopyBtn: document.getElementById("glasses-copy-btn"),
  livePublicRow: document.getElementById("live-public-row"),
  livePublicCheckbox: document.getElementById("live-public-checkbox"),
  livePublicStatusDot: document.getElementById("live-public-status-dot"),
  publishSlidesRow: document.getElementById("publish-slides-row"),
  publishSlidesCheckbox: document.getElementById("publish-slides-checkbox"),
  editorScrollTopBtn: document.getElementById("editor-scroll-top-btn"),
  editorScrollBottomBtn: document.getElementById("editor-scroll-bottom-btn"),
  previewScrollTopBtn: document.getElementById("preview-scroll-top-btn"),
  previewScrollBottomBtn: document.getElementById("preview-scroll-bottom-btn"),
  editorFilename: document.getElementById("editor-filename"),
  tabStrip: document.getElementById("tab-strip"),
  editTargetBtn: document.getElementById("edit-target-btn"),
  docEditStrip: document.getElementById("doc-edit-strip"),
  docEditSummary: document.getElementById("doc-edit-summary"),
  docEditUndoBtn: document.getElementById("doc-edit-undo-btn"),
  docEditDismissBtn: document.getElementById("doc-edit-dismiss-btn"),
  toolStatus: document.getElementById("tool-status"),
  remoteBtn: document.getElementById("remote-btn"),
  syncConflict: document.getElementById("sync-conflict"),
  updateBanner: document.getElementById("update-banner"),
  updateReloadBtn: document.getElementById("update-reload-btn"),
  syncLoadBtn: document.getElementById("sync-load-btn"),
  syncKeepBtn: document.getElementById("sync-keep-btn"),
  saveBtn: document.getElementById("save-btn"),
  splitToggleBtn: document.getElementById("split-toggle-btn"),
  splitResizer: document.getElementById("split-resizer"),
  editorPaneB: document.getElementById("editor-pane-b"),
  editorFilenameB: document.getElementById("editor-filename-b"),
  saveBtnB: document.getElementById("save-btn-b"),
  closeSplitBtn: document.getElementById("close-split-btn"),
  // The split-view pane's own CodeMirror instance (see editorB below) -
  // view/edit/save only, so unlike the primary editor it gets no thread
  // folding (nothing there ever flips a thread's marker) and no AI-toolbar
  // wiring at all.
  editorB: createEditor(document.getElementById("editor-b"), {
    foldRanges: (text) => headingFoldRanges(text),
    onFoldToggle: () => false,
  }),
  editorScrollTopBtnB: document.getElementById("editor-scroll-top-btn-b"),
  editorScrollBottomBtnB: document.getElementById("editor-scroll-bottom-btn-b"),
  publishBtn: document.getElementById("publish-btn"),
  publishLabel: document.getElementById("publish-label"),
  publishIcon: document.getElementById("publish-icon"),
  inlineCompleteBtn: document.getElementById("inline-complete-btn"),
  dictationGroup: document.getElementById("dictation-group"),
  dictationBtn: document.getElementById("dictation-btn"),
  dictationLabel: document.getElementById("dictation-label"),
  dictationLang: document.getElementById("dictation-lang"),
  dictationEngine: document.getElementById("dictation-engine"),
  dictationRecordBtn: document.getElementById("dictation-record-btn"),
  audioFileBar: document.getElementById("audio-file-bar"),
  audioFilePlayBtn: document.getElementById("audio-file-play-btn"),
  audioFileEngine: document.getElementById("audio-file-engine"),
  audioFileBackBtn: document.getElementById("audio-file-back-btn"),
  audioFileForwardBtn: document.getElementById("audio-file-forward-btn"),
  audioFileName: document.getElementById("audio-file-name"),
  audioFileSeek: document.getElementById("audio-file-seek"),
  audioFileTime: document.getElementById("audio-file-time"),
  audioFileGotoForm: document.getElementById("audio-file-goto-form"),
  audioFileGoto: document.getElementById("audio-file-goto"),
  audioFileGotoError: document.getElementById("audio-file-goto-error"),
  audioFileRateBtn: document.getElementById("audio-file-rate-btn"),
  audioFileCloseBtn: document.getElementById("audio-file-close-btn"),
  dictationMicBtn: document.getElementById("dictation-mic-btn"),
  threadToggleBtn: document.getElementById("thread-toggle-btn"),
  sendBtn: document.getElementById("send-btn"),
  viewModeBtn: document.getElementById("view-mode-btn"),
  viewModeLabel: document.getElementById("view-mode-label"),
  editorRendered: document.getElementById("editor-rendered"),
  globalSystemRow: document.getElementById("global-system-row"),
  mobileTabs: document.getElementById("mobile-tabs"),
  hermesSection: document.getElementById("hermes-section"),
  hermesHeader: document.getElementById("hermes-header"),
  hermesDisclosure: document.getElementById("hermes-disclosure"),
  hermesList: document.getElementById("hermes-list"),
  quickOpenBtn: document.getElementById("quick-open-btn"),
  quickOpenOverlay: document.getElementById("quick-open-overlay"),
  quickOpenInput: document.getElementById("quick-open-input"),
  quickOpenResults: document.getElementById("quick-open-results"),
  quickOpenEmpty: document.getElementById("quick-open-empty"),
  shortcutsBtn: document.getElementById("shortcuts-btn"),
  shortcutsOverlay: document.getElementById("shortcuts-overlay"),
  shortcutsGroups: document.getElementById("shortcuts-groups"),
  shortcutsCloseBtn: document.getElementById("shortcuts-close-btn"),
};

// ---------- resizable / collapsible side panes ----------
// Purely UI chrome - doesn't touch `active`/`projects`/any server state, so
// it's initialized independently of the rest of the app (see the
// restorePanelLayout() call at the bottom of this file).

const PANEL_LAYOUT_KEY = "mark-vector:panel-layout";
const TREE_WIDTH_RANGE = [160, 480];
const PREVIEW_WIDTH_RANGE = [240, 720];
const SPLIT_WIDTH_RANGE = [240, 720];

function savePanelLayout() {
  try {
    localStorage.setItem(
      PANEL_LAYOUT_KEY,
      JSON.stringify({
        treeWidth: el.layout.style.getPropertyValue("--tree-width") || null,
        previewWidth: el.layout.style.getPropertyValue("--preview-width") || null,
        splitWidth: el.layout.style.getPropertyValue("--split-width") || null,
        treeCollapsed: el.layout.classList.contains("tree-collapsed"),
        previewCollapsed: el.layout.classList.contains("preview-collapsed"),
        splitView: splitViewOpen(),
      })
    );
  } catch (err) {
    // localStorage unavailable (private browsing, storage full, ...) - the
    // layout just won't persist across reloads; not worth surfacing.
  }
}

function splitViewOpen() {
  return el.layout.classList.contains("split-view");
}

// A dumb toggle - shows/hides the chrome (pane, resizer, toolbar button,
// grid columns) without touching activeB/its content either way. Reused by
// selectDocumentB (force-open, nothing to lose) and by restorePanelLayout
// (force to whatever was saved); closeSplitView below is the one place that
// also has to ask about unsaved changes first, since it's the one path that
// actually discards activeB.
function setSplitView(open) {
  el.layout.classList.toggle("split-view", open);
  el.editorPaneB.hidden = !open;
  el.splitResizer.hidden = !open;
  el.splitToggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
  savePanelLayout();
}

function setTreeCollapsed(collapsed) {
  el.layout.classList.toggle("tree-collapsed", collapsed);
  el.treePane.classList.toggle("collapsed", collapsed);
  el.treeExpandBtn.hidden = !collapsed;
  savePanelLayout();
}

function setPreviewCollapsed(collapsed) {
  el.layout.classList.toggle("preview-collapsed", collapsed);
  el.previewPane.classList.toggle("collapsed", collapsed);
  el.previewExpandBtn.hidden = !collapsed;
  savePanelLayout();
}

// Shared drag loop for both resizers - `side` picks which CSS custom
// property/pane rect/clamp range to drive, everything else about dragging
// a column boundary is identical between them.
// `side` is "tree" (left edge, grid column 1), "preview" (right edge, grid
// column 7) or "split" (pane B, grid column 5 - right edge of its own two-
// column group, the same shape as "preview" one group to its left). Each
// drives its own `--<side>-width` custom property, which is all
// updateGridColumns/the CSS itself actually reads.
const RESIZE_TARGETS = {
  tree: { resizer: () => el.treeResizer, pane: () => el.treePane, range: TREE_WIDTH_RANGE },
  preview: { resizer: () => el.previewResizer, pane: () => el.previewPane, range: PREVIEW_WIDTH_RANGE },
  split: { resizer: () => el.splitResizer, pane: () => el.editorPaneB, range: SPLIT_WIDTH_RANGE },
};

function startPaneResize(startEvent, side) {
  startEvent.preventDefault();
  const { resizer, pane, range } = RESIZE_TARGETS[side];
  const resizerEl = resizer();
  const [min, max] = range;
  const startX = startEvent.clientX;
  const startWidth = pane().getBoundingClientRect().width;

  resizerEl.classList.add("dragging");

  function onMove(moveEvent) {
    const dx = moveEvent.clientX - startX;
    // The tree pane is anchored to the left edge, so dragging its handle
    // right (positive dx) should grow it; preview and split are each
    // anchored to their own right edge, so growing either means dragging
    // its handle left (negative dx) - the sign is flipped relative to tree.
    const rawWidth = side === "tree" ? startWidth + dx : startWidth - dx;
    const width = Math.min(max, Math.max(min, rawWidth));
    el.layout.style.setProperty(`--${side}-width`, `${width}px`);
  }
  function onUp() {
    resizerEl.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    savePanelLayout();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function restorePanelLayout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || "null");
  } catch (err) {
    saved = null;
  }
  if (saved) {
    if (saved.treeWidth) el.layout.style.setProperty("--tree-width", saved.treeWidth);
    if (saved.previewWidth) el.layout.style.setProperty("--preview-width", saved.previewWidth);
    if (saved.splitWidth) el.layout.style.setProperty("--split-width", saved.splitWidth);
  }
  // Re-applies unconditionally (not just `if (saved.treeCollapsed)`) so the
  // expand buttons/classes start in sync even with nothing saved yet.
  setTreeCollapsed(!!(saved && saved.treeCollapsed));
  setPreviewCollapsed(!!(saved && saved.previewCollapsed));
  setSplitView(!!(saved && saved.splitView));
}

el.treeResizer.addEventListener("mousedown", (e) => startPaneResize(e, "tree"));
el.previewResizer.addEventListener("mousedown", (e) => startPaneResize(e, "preview"));
el.treeCollapseBtn.addEventListener("click", () => setTreeCollapsed(true));
el.treeExpandBtn.addEventListener("click", () => setTreeCollapsed(false));
el.previewCollapseBtn.addEventListener("click", () => setPreviewCollapsed(true));
el.previewExpandBtn.addEventListener("click", () => setPreviewCollapsed(false));
restorePanelLayout();

// "exchange" = one file holding a full question+answer pair (current format).
// "user"/"assistant" only show up on turns from before they were merged.
const ROLE_LABEL = { exchange: "E", user: "U", assistant: "A", draft: "D", system: "S" };
const ROLE_TITLE_KEYS = {
  exchange: "role.exchange",
  user: "role.user",
  assistant: "role.assistant",
  draft: "role.draft",
  system: "role.system",
};
function roleTitle(role) {
  return ROLE_TITLE_KEYS[role] ? t(ROLE_TITLE_KEYS[role]) : role;
}
// A document with no saved provider/model of its own starts on the one set
// with ☆ in the toolbar (llmDefaults, kept on the server so every device
// agrees) - or, until one is set or if it's no longer on offer, on OpenAI.
// The model is that provider's default_model, which the registry sets to
// gpt-6.1-sol when the live list includes it. If OpenAI isn't configured,
// the first configured provider is used. A turn, or a draft the user has
// already chosen for, keeps that document's own choice.
const DEFAULT_PROVIDER_ID = "openai";
// "system"/"project-system" = per-session/per-project system.md,
// "global-system" = the app-wide prompt at the very top, "global-custom-
// symbols" = the app-wide custom-symbols.csv right below it, "global-
// spoken-math" = the app-wide spoken-math.csv below that, "hermes-
// session" = a read-only transcript pulled from the local Hermes agent
// gateway (see selectHermesSession below). None of these is a conversation
// turn mark-vector itself owns, so none can be sent to the LLM directly.
const NON_SENDABLE_ROLES = new Set([
  "system",
  "project-system",
  "global-system",
  "global-custom-symbols",
  "global-spoken-math",
  "hermes-session",
]);

let providers = [];
// The user's default provider/model/reasoning (see /api/providers/defaults).
let llmDefaults = {};
// id -> { meta, sessions: Map|null, expanded, systemPromptContent }
// `sessions` mirrors the old top-level `sessions` Map, just nested one
// level under its project now. `systemPromptContent` is fetched alongside
// a project's sessions (see refreshProjectSessions) so sessionMathDialect
// can look at it synchronously, the same way globalSystemPromptContent
// already works.
let projects = new Map();
let active = null; // { projectId, sessionId, filename, role, savedContent }
// The split-view pane's own, much smaller version of `active` - only ever a
// plain document (draft/exchange/user/assistant), never a system prompt or
// Hermes transcript (see selectDocumentB), and with no turnId/publishToken
// because nothing here ever sends or publishes. Independent of `streaming`
// too: pane B never generates anything, so nothing about it needs to lock
// while pane A is mid-send.
let activeB = null; // { projectId, sessionId, filename, role, savedContent }
// Whether a message sent from pane A carries pane B's document and may
// edit it, and the last send's edits to it - see the "document editing from
// the conversation" section. Declared up here, next to the pane state the
// functions reading them (updateEditTargetButton & co.) also read.
const EDIT_TARGET_KEY = "mark-vector:edit-target";
let editTargetOn = (() => {
  try {
    return localStorage.getItem(EDIT_TARGET_KEY) !== "0";
  } catch (err) {
    return true;
  }
})();
let docEdit = null; // { doc, before, reply, seen, applied, failed }
let streaming = false;
let globalSystemPromptContent = "";
let globalCustomSymbolsContent = "";

// Drag-and-drop in the left tree (moving a document or folder onto another
// folder, or a folder back to its project's top level) is built from raw
// pointer events (see startRowDrag et al., further below) rather than the
// native HTML5 draggable/dragover/drop API - WebKit's hit-testing during a
// native drag doesn't line up correctly with a *scrolled* drop target
// (this tree scrolls - see .session-tree's overflow-y), a long-standing
// Safari engine bug with no application-level fix, so a plain drop onto an
// off-screen-until-scrolled folder silently does nothing there. Pointer
// events don't go through that native drag machinery at all, so they're
// unaffected and work identically in every browser.
//
// `dragPayload` is what's being dragged - set once a real drag starts,
// cleared once it ends (drop or cancel either way). `rowDrag` is this
// pointer gesture's own transient bookkeeping (which pointer, where it
// started, whether it's moved enough to count as a drag yet, and which row
// is currently the drop candidate) - kept separate from `dragPayload` so
// canDropOnFolder/handleDropOnFolder below don't have to know or care that
// pointer events are what's driving them now, same as when a native
// dragover/drop fed them before.
let dragPayload = null;
let rowDrag = null;

// Remembers which document was open so a page reload can reopen it (see
// restoreActiveDocument, called once from init()) - purely a convenience,
// so a stale/unreadable value or a localStorage failure just means landing
// on the empty editor like before, never an error.
const ACTIVE_DOC_KEY = "mark-vector:active-doc";

// A stable identity for whatever's currently open, shared by
// saveActiveDocRef below (which document to reopen on a fresh page load)
// and the autosave safety net further down (which document a recovered
// draft belongs to) - both need to key off the exact same notion of "this
// document" for the exact same set of roles. Most roles (draft/exchange/
// user/assistant/system) all reopen identically via selectDocument, so they
// share one "document" case; only the roles selectDocument can't reach get
// their own.
function activeDocRef() {
  if (!active) return null;
  if (active.role === "global-system") return { role: "global-system" };
  if (active.role === "global-custom-symbols") return { role: "global-custom-symbols" };
  if (active.role === "global-spoken-math") return { role: "global-spoken-math" };
  if (active.role === "project-system") return { role: "project-system", projectId: active.projectId };
  if (active.role === "hermes-session") {
    return { role: "hermes-session", hermesSessionId: active.hermesSessionId, hermesTitle: active.filename };
  }
  if (active.projectId && active.sessionId && active.filename) {
    return { role: "document", projectId: active.projectId, sessionId: active.sessionId, filename: active.filename };
  }
  return null;
}

// Called after every `active` assignment that represents a real navigation
// (not the mid-stream partial states inside sendActive) - see the call
// sites below.
function saveActiveDocRef() {
  const ref = activeDocRef();
  // The tab on screen follows its document through renames, and through
  // flows that put another document in its place (a send landing on the
  // next draft) - except while openInTab/switchToTab is filling a tab,
  // which do their own bookkeeping.
  if (!openingTab && currentTab >= 0 && ref) {
    tabs[currentTab].ref = ref;
    tabs[currentTab].title = active.filename;
    saveTabs();
    renderTabs();
  }
  try {
    if (ref) localStorage.setItem(ACTIVE_DOC_KEY, JSON.stringify(ref));
    else localStorage.removeItem(ACTIVE_DOC_KEY);
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function loadActiveDocRef() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_DOC_KEY) || "null");
  } catch (err) {
    return null;
  }
}

// ---------- tabs ----------
//
// Pane A keeps several documents open as tabs. Only the one on screen is
// `active`; any other tab is just its ref (see activeDocRef), reopened
// from the server when switched back to - so an edit saved elsewhere in
// the meantime shows up - except a tab left with unsaved edits, which
// keeps them (with its `active` object, caret and scroll) in `stash` until
// it's switched back to or closed. Opening a document from anywhere - the
// tree, quick open, a link, a new draft - goes through openInTab: a tab of
// its own, or the one it already has. Split view's pane B has no tabs.
// The list of tabs (not their unsaved contents - autosave already keeps
// those per document) survives a reload.
const TABS_KEY = "mark-vector:tabs";
let tabs = []; // [{ ref, title, stash }]
let currentTab = -1;
// True while openInTab/switchToTab has a loader (selectDocument & co.)
// filling a tab: the document being left is safe in its own tab, so the
// loader's "unsaved changes, leave anyway?" doesn't apply.
let openingTab = false;

function docRef(projectId, sessionId, filename) {
  return { role: "document", projectId, sessionId, filename };
}

// A session's system.md is an ordinary document under the hood (see
// selectDocument's "system" role), so its tab is that document's.
async function openSessionSystemPrompt(projectId, sessionId) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) session.documents = await api.listDocuments(projectId, sessionId);
  const doc = session.documents.find((d) => d.role === "system");
  if (doc) await openInTab(docRef(projectId, sessionId, doc.filename));
}

function sameDocRef(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.filename === b.filename &&
    a.hermesSessionId === b.hermesSessionId;
}

function saveTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: tabs.map(({ ref, title }) => ({ ref, title })), current: currentTab }));
  } catch (err) {
    // localStorage unavailable - the tabs just won't survive a reload
  }
}

function loadTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    if (saved && Array.isArray(saved.tabs)) return saved;
  } catch (err) {
    // fall through
  }
  return null;
}

function stashDirty(stash) {
  return !!stash && stash.content !== stash.active.savedContent;
}

function tabDirty(index) {
  return index === currentTab ? isDirty() : stashDirty(tabs[index] && tabs[index].stash);
}

// Snapshot of the tab being left: its document state, unsaved text, caret
// and scroll - restored as-is if it had unsaved edits, otherwise just the
// caret and scroll over a fresh copy from the server.
function stashCurrentTab() {
  if (currentTab < 0 || !active) return;
  tabs[currentTab].ref = activeDocRef();
  tabs[currentTab].title = active.filename;
  tabs[currentTab].stash = {
    active: { ...active },
    content: el.editor.value,
    selectionStart: el.editor.selectionStart,
    selectionEnd: el.editor.selectionEnd,
    scrollTop: el.editor.scrollElement.scrollTop,
  };
}

function restoreTabView(stash) {
  if (!stash) return;
  const length = el.editor.value.length;
  el.editor.setSelectionRange(Math.min(stash.selectionStart, length), Math.min(stash.selectionEnd, length));
  el.editor.scrollElement.scrollTop = stash.scrollTop;
  if (!PHONE_LAYOUT.matches && editorViewMode !== "rendered") el.editor.focus();
}

// A tab with unsaved edits coming back: its text from memory rather than
// the server - the same screen updates selectDocument makes.
function showStashedTab(stash) {
  const previous = active;
  active = stash.active;
  hideSyncConflict();
  saveActiveDocRef();
  el.editor.value = stash.content;
  // The transcript's document is on screen again, and the editor now holds
  // its text - later phrases go here, not into the stash we just copied.
  if (dictation && dictation.targetRef && sameDocRef(dictation.targetRef, activeDocRef())) dictation.writeStash = false;
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  const documentChanged =
    !previous ||
    previous.sessionId !== active.sessionId ||
    previous.projectId !== active.projectId ||
    previous.filename !== active.filename;
  if (documentChanged && active.sessionId && !NON_SENDABLE_ROLES.has(active.role)) {
    applyDocumentSettings(cachedDocument(active.projectId, active.sessionId, active.filename));
  }
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
  restoreTabView(stash);
}

async function loadIntoTab(ref) {
  ref = await pairedDocumentRef(ref);
  openingTab = true;
  try {
    await restoreActiveDocument(ref);
  } finally {
    openingTab = false;
  }
  return sameDocRef(activeDocRef(), ref);
}

// Opens `ref` in a new tab right after the current one, or switches to the
// tab it already has. The same document again just reloads it, as before.
async function openInTab(ref) {
  if (streaming || !ref) return;
  ref = await pairedDocumentRef(ref);
  const at = tabs.findIndex((tab) => sameDocRef(tab.ref, ref));
  if (at >= 0 && at === currentTab && active) {
    await restoreActiveDocument(ref);
    return;
  }
  if (at >= 0) {
    await switchToTab(at);
    return;
  }
  const previous = currentTab;
  stashCurrentTab();
  // Before the await: a phrase that arrives while the new document loads
  // must still land in the one dictation started in.
  holdDictationOn(ref);
  if (await loadIntoTab(ref)) {
    tabs.splice(previous + 1, 0, { ref: activeDocRef(), title: active.filename, stash: null });
    currentTab = previous + 1;
  } else if (previous >= 0) {
    // Didn't open (gone, or a fetch failed): the screen never changed.
    tabs[previous].stash = null;
  }
  releaseDictationIfHome();
  stopDictationIfDocumentGone();
  saveTabs();
  renderTabs();
}

async function switchToTab(index, { keepCurrent = true } = {}) {
  if (streaming || index < 0 || index >= tabs.length || (index === currentTab && active)) return;
  if (keepCurrent) stashCurrentTab();
  const arriving = tabs[index].ref;
  holdDictationOn(arriving);
  currentTab = index;
  const tab = tabs[index];
  const stash = tab.stash;
  const arrivingHome = !!(dictation && dictation.targetRef && sameDocRef(dictation.targetRef, arriving));
  // Keep the home tab's stash until its text is back in the editor, so a
  // phrase that arrives mid-switch still has somewhere to go. Every other
  // tab's stash has already been copied onto the screen or isn't needed.
  if (!arrivingHome) tab.stash = null;
  if (arrivingHome && stash) {
    showStashedTab(stash);
    tab.stash = null;
  } else if (stashDirty(stash)) {
    showStashedTab(stash);
  } else if (await loadIntoTab(tab.ref)) {
    if (arrivingHome) tab.stash = null;
    restoreTabView(stash);
  } else {
    // Its document is gone - drop the tab and show a neighbor instead.
    tabs.splice(index, 1);
    currentTab = -1;
    if (tabs.length) {
      await switchToTab(Math.min(index, tabs.length - 1), { keepCurrent: false });
      return;
    }
    clearEditor();
  }
  releaseDictationIfHome();
  stopDictationIfDocumentGone();
  saveTabs();
  renderTabs();
}

async function closeTab(index, { force = false, keepDraft = false } = {}) {
  if (streaming || index < 0 || index >= tabs.length) return;
  const tab = tabs[index];
  if (!force && tabDirty(index) && !confirm(t("tabs.confirmClose", { name: tab.title || "" }))) return;
  // The transcript has nowhere to go once this tab is gone.
  if (dictation && dictation.targetRef && sameDocRef(dictation.targetRef, tab.ref)) stopDictation();
  const wasCurrent = index === currentTab;
  // Closing means discarding: don't offer the edits back next time it opens.
  if (wasCurrent && isDirty() && !keepDraft) clearAutosave();
  tabs.splice(index, 1);
  if (!wasCurrent) {
    if (index < currentTab) currentTab -= 1;
  } else {
    currentTab = -1;
    if (tabs.length) {
      await switchToTab(Math.min(index, tabs.length - 1), { keepCurrent: false });
      return;
    }
    clearEditor();
  }
  saveTabs();
  renderTabs();
}

// The tab's document moves to the split-view pane (opening it), unsaved
// edits and all, and the tab closes. Only a plain document can go - pane B
// takes nothing else (see selectDocumentB).
function canMoveTabToSplit(index) {
  const ref = index === currentTab ? activeDocRef() : tabs[index] && tabs[index].ref;
  return !!ref && ref.role === "document";
}

async function moveTabToSplit(index) {
  if (streaming || index < 0 || index >= tabs.length || !canMoveTabToSplit(index)) return;
  const isCurrent = index === currentTab;
  const ref = isCurrent ? activeDocRef() : tabs[index].ref;
  const stash = tabs[index].stash;
  const unsaved = isCurrent ? (isDirty() ? el.editor.value : null) : stashDirty(stash) ? stash.content : null;
  await selectDocumentB(ref.projectId, ref.sessionId, ref.filename);
  // Declined (pane B's own unsaved changes) or the document is gone.
  if (!activeB || activeB.projectId !== ref.projectId || activeB.sessionId !== ref.sessionId || activeB.filename !== ref.filename) return;
  if (unsaved !== null) {
    el.editorB.value = unsaved;
    updateFilenameLabelB();
    renderPreviewB();
  }
  // Its edits live on in pane B - and in the draft kept for them.
  await closeTab(tabs.findIndex((tab) => sameDocRef(tab.ref, ref)), { force: true, keepDraft: true });
  // Pane A's next tab took focus on the way - the moved document is the
  // one being looked at, so it gets it back (and the preview with it).
  el.editorB.focus();
}

// Closes every tab but `keep` (the current one unless told otherwise) -
// one question for all the unsaved ones among them rather than one each.
async function closeOtherTabs(keep = currentTab) {
  if (streaming || keep < 0 || keep >= tabs.length || tabs.length < 2) return;
  if (keep !== currentTab) {
    await switchToTab(keep);
    if (currentTab < 0 || !sameDocRef(tabs[currentTab].ref, activeDocRef())) return;
    keep = currentTab;
  }
  const unsaved = tabs.filter((tab, i) => i !== keep && stashDirty(tab.stash)).length;
  if (unsaved && !confirm(t("tabs.confirmCloseOthers", { count: unsaved }))) return;
  tabs = [tabs[keep]];
  currentTab = 0;
  stopDictationIfDocumentGone();
  saveTabs();
  renderTabs();
}

// Closes every tab whose document `matches` (deleted, or inside something
// deleted) - no questions asked, there's nothing left to save to.
async function dropTabs(matches) {
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (i !== currentTab && tabs[i].ref && matches(tabs[i].ref)) {
      tabs.splice(i, 1);
      if (i < currentTab) currentTab -= 1;
    }
  }
  if (currentTab >= 0 && tabs[currentTab].ref && matches(tabs[currentTab].ref)) {
    await closeTab(currentTab, { force: true });
    return;
  }
  stopDictationIfDocumentGone();
  saveTabs();
  renderTabs();
}

function tabTooltip(tab) {
  const ref = tab.ref || {};
  const project = ref.projectId && projects.get(ref.projectId);
  const session = project && ref.sessionId && project.sessions && project.sessions.get(ref.sessionId);
  const where = [project && project.meta && project.meta.title, session && session.meta && session.meta.title].filter(Boolean);
  return [...where, tab.title].filter(Boolean).join(" / ");
}

// Shown once there's more than one tab - a single document is already
// named in the header below.
function renderTabs() {
  const strip = el.tabStrip;
  strip.hidden = tabs.length < 2;
  // With tabs showing, the current one already names the document - the
  // header's own filename would just take room from its buttons.
  el.editorFilename.hidden = !strip.hidden;
  if (strip.hidden) {
    strip.replaceChildren();
    return;
  }
  strip.replaceChildren(
    ...tabs.map((tab, index) => {
      const item = document.createElement("div");
      item.className = "editor-tab" + (index === currentTab ? " current" : "") + (tabDirty(index) ? " dirty" : "");
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", index === currentTab ? "true" : "false");
      item.title = tabTooltip(tab);
      const label = document.createElement("span");
      label.className = "editor-tab-label";
      label.textContent = tab.title || "…";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "editor-tab-close";
      close.textContent = "×";
      close.title = t("tabs.close");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(index);
      });
      item.append(label, close);
      item.addEventListener("click", () => switchToTab(index));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openRowMenu({ x: e.clientX, y: e.clientY }, [
          { icon: "×", label: t("tabs.close"), onSelect: () => closeTab(index) },
          { icon: "⊗", label: t("tabs.closeOthers"), onSelect: () => closeOtherTabs(index) },
          ...(canMoveTabToSplit(index) ? [{ icon: "◫", label: t("tabs.moveToSplit"), onSelect: () => moveTabToSplit(index) }] : []),
        ]);
      });
      // Middle click closes, as in a browser.
      item.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(index);
        }
      });
      return item;
    })
  );
  const current = strip.children[currentTab];
  if (current) current.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Cheap per-keystroke update of the current tab's unsaved marker (see
// updateFilenameLabel).
function updateCurrentTabMarker() {
  const item = el.tabStrip.children[currentTab];
  if (item) item.classList.toggle("dirty", isDirty());
}

// activeB's own, much smaller counterpart to the above - only ever a plain
// document (see activeB's own comment), so there's no per-role branching to
// do here at all.
const ACTIVE_DOC_KEY_B = "mark-vector:active-doc-b";

function saveActiveDocRefB() {
  try {
    if (activeB) {
      localStorage.setItem(
        ACTIVE_DOC_KEY_B,
        JSON.stringify({ projectId: activeB.projectId, sessionId: activeB.sessionId, filename: activeB.filename })
      );
    } else {
      localStorage.removeItem(ACTIVE_DOC_KEY_B);
    }
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function loadActiveDocRefB() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_DOC_KEY_B) || "null");
  } catch (err) {
    return null;
  }
}

// The documents opened most recently, newest first - what the jump keys'
// first three slots point at (see buildAltHintEntries). Kept across reloads
// like the active document itself, and capped well above the three slots so
// that skipping the open document and any since-deleted ones still leaves
// three to show.
const RECENT_DOCS_KEY = "mark-vector:recent-docs";
const RECENT_DOCS_MAX = 12;
let recentDocs = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_DOCS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((r) => r && r.projectId && r.sessionId && r.filename) : [];
  } catch (err) {
    return [];
  }
})();

function rememberRecentDoc(projectId, sessionId, filename) {
  recentDocs = [
    { projectId, sessionId, filename },
    ...recentDocs.filter((r) => !(r.projectId === projectId && r.sessionId === sessionId && r.filename === filename)),
  ].slice(0, RECENT_DOCS_MAX);
  try {
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(recentDocs));
  } catch (err) {
    // localStorage unavailable - the list just won't survive a reload
  }
}

// Reopens whatever `ref` (from loadActiveDocRef, captured before init()'s
// own clearEditor() call would otherwise wipe it - see init() below) points
// to - a no-op if there's nothing saved, or if what it points to was
// deleted/renamed since (a stale project/session/filename just fails the
// lookup below and leaves the editor on its normal empty starting state,
// same as api.listDocuments 404ing would).
async function restoreActiveDocument(ref) {
  if (!ref) return;
  try {
    if (ref.role === "global-system") {
      await selectGlobalPrompt();
    } else if (ref.role === "global-custom-symbols") {
      await selectGlobalCustomSymbols();
    } else if (ref.role === "global-spoken-math") {
      await selectGlobalSpokenMath();
    } else if (ref.role === "project-system") {
      if (!projects.has(ref.projectId)) return;
      await selectProjectSystemPrompt(ref.projectId);
    } else if (ref.role === "hermes-session") {
      await selectHermesSession({ id: ref.hermesSessionId, title: ref.hermesTitle });
    } else if (ref.role === "document") {
      const project = projects.get(ref.projectId);
      if (!project) return;
      if (project.sessions === null) await refreshProjectSessions(ref.projectId);
      if (!project.sessions.has(ref.sessionId)) return;
      project.expanded = true;
      project.sessions.get(ref.sessionId).expanded = true;
      saveExpandedTreeState();
      await selectDocument(ref.projectId, ref.sessionId, ref.filename);
    }
  } catch (err) {
    // Any failed fetch along the way (deleted project/session/document,
    // network hiccup) - leave the editor empty rather than surfacing an
    // error for something this unimportant.
  }
}

// restoreActiveDocument's split-view counterpart - only ever a "document"
// ref (see saveActiveDocRefB), so no per-role branching, and it doesn't
// steal focus into pane B on load (see selectDocumentB's `focus` option).
async function restoreActiveDocumentB(ref) {
  if (!ref) return;
  try {
    const project = projects.get(ref.projectId);
    if (!project) return;
    if (project.sessions === null) await refreshProjectSessions(ref.projectId);
    if (!project.sessions.has(ref.sessionId)) return;
    await selectDocumentB(ref.projectId, ref.sessionId, ref.filename, { focus: false });
  } catch (err) {
    // leave pane B closed - see restoreActiveDocument's own comment above
  }
}

// Remembers which projects/folders were expanded, independent of
// restoreActiveDocument above (which only ever reveals the one open
// document's own chain) - so a reload puts the whole tree back the way it
// was left, not just the branch leading to whatever's in the editor.
const EXPANDED_TREE_KEY = "mark-vector:expanded-tree";

// Read once at init() and consulted from then on by loadProjects/
// refreshProjectSessions' own `expanded` fallback (see their `prev ? ... :
// expandedTreeState...` lines) - never mutated afterward, so a project or
// folder collapsed/expanded later this session naturally stops depending
// on it (its own `prev.expanded` takes over instead).
let expandedTreeState = { projects: new Set(), sessions: new Set() };

function loadExpandedTreeState() {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_TREE_KEY) || "null");
    return {
      projects: new Set((raw && raw.projects) || []),
      sessions: new Set((raw && raw.sessions) || []),
    };
  } catch (err) {
    return { projects: new Set(), sessions: new Set() };
  }
}

// Called after every place `expanded` actually changes (toggleProject/
// toggleSession, and the few spots that expand a folder programmatically -
// creating a project/folder, or restoreActiveDocument revealing whatever's
// open) - cheap enough to just recompute from scratch each time rather
// than track incremental diffs.
function saveExpandedTreeState() {
  const state = { projects: [], sessions: [] };
  for (const [projectId, project] of projects) {
    if (project.expanded) state.projects.push(projectId);
    if (project.sessions) {
      for (const [sessionId, session] of project.sessions) {
        if (session.expanded) state.sessions.push(sessionId);
      }
    }
  }
  try {
    localStorage.setItem(EXPANDED_TREE_KEY, JSON.stringify(state));
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

// Fetches whatever a saved-expanded project/folder needs to actually show
// its contents on the next render (loadProjects/refreshProjectSessions'
// `expanded` fallback only sets the flag - same lazy-fetch split as every
// other place in this file that keeps `sessions`/`documents` null until
// something needs them). Best-effort: a project or folder that no longer
// exists, or a network hiccup, just leaves that one branch looking
// collapsed instead of failing the whole restore.
async function hydrateExpandedTree() {
  for (const [projectId, project] of projects) {
    if (!project.expanded || project.sessions !== null) continue;
    try {
      await refreshProjectSessions(projectId);
    } catch (err) {
      // leave it - see docstring above
    }
  }
  for (const [projectId, project] of projects) {
    if (!project.sessions) continue;
    for (const [sessionId, session] of project.sessions) {
      if (!session.expanded || session.documents !== null) continue;
      try {
        session.documents = await api.listDocuments(projectId, sessionId);
      } catch (err) {
        // leave it - see docstring above
      }
    }
  }
}

// Hermes agent sessions (see routers/hermes.py) - a separate, read-only
// tree section, entirely independent of mark-vector's own project/session
// data. `hermesSessions` is null until first expanded (same "null = not
// fetched yet" convention as `project.sessions`/`session.documents`).
let hermesExpanded = false;
let hermesSessions = null;
let hermesOffset = 0;
let hermesHasMore = false;
let hermesError = null;

// On phones (see the CSS breakpoint), only one pane shows at a time,
// switched via the bottom tab bar. This is a no-op visually on wider
// screens, where the CSS media query keeps all three panes shown regardless.
function setMobileView(view) {
  document.body.dataset.mobileView = view;
  for (const btn of el.mobileTabs.querySelectorAll(".mobile-tab")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
}

function iconButton(label, title) {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = label;
  btn.title = title;
  return btn;
}

// ---------- tree row "⋯" menu ----------
//
// Every tree row keeps at most one inline action (a folder's/project's "+")
// plus a "⋯" button; everything else lives in this one shared popup, also
// opened by right-clicking the row itself. `items` is a list of
// {icon, label, onSelect, danger} entries, or the string "-" for a separator.
// Only one menu exists at a time - opening another replaces it.
let rowMenuEl = null;
let rowMenuAnchor = null;

function closeRowMenu() {
  if (!rowMenuEl) return;
  rowMenuEl.remove();
  rowMenuEl = null;
  if (rowMenuAnchor) rowMenuAnchor.classList.remove("menu-open");
  rowMenuAnchor = null;
  document.removeEventListener("pointerdown", onRowMenuOutsidePointer, true);
  document.removeEventListener("keydown", onRowMenuKeydown, true);
  window.removeEventListener("resize", closeRowMenu);
  el.sessionTree.removeEventListener("scroll", closeRowMenu);
}

function onRowMenuOutsidePointer(e) {
  // A press on the anchoring "⋯" itself is left to its own click handler,
  // which closes the menu - closing here too would just reopen it.
  if (!rowMenuEl || rowMenuEl.contains(e.target) || (rowMenuAnchor && rowMenuAnchor.contains(e.target))) return;
  closeRowMenu();
}

function onRowMenuKeydown(e) {
  if (!rowMenuEl) return;
  const items = [...rowMenuEl.querySelectorAll(".row-menu-item")];
  const index = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    closeRowMenu();
  } else if (e.key === "ArrowDown") {
    items[(index + 1) % items.length].focus();
  } else if (e.key === "ArrowUp") {
    items[(index - 1 + items.length) % items.length].focus();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// `at` is either the "⋯" button (menu drops below it, right-aligned) or a
// {x, y} point (right-click). Flipped up/left when it would run off-screen.
function openRowMenu(at, items) {
  closeRowMenu();
  const menu = document.createElement("div");
  menu.className = "row-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "row-menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-menu-item" + (item.danger ? " danger" : "");
    btn.setAttribute("role", "menuitem");
    const icon = document.createElement("span");
    icon.className = "row-menu-icon";
    icon.textContent = item.icon;
    const label = document.createElement("span");
    label.textContent = item.label;
    btn.append(icon, label);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRowMenu();
      item.onSelect();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  rowMenuEl = menu;
  if (at instanceof Element) {
    rowMenuAnchor = at;
    at.classList.add("menu-open");
  }

  const rect = at instanceof Element ? at.getBoundingClientRect() : null;
  const menuRect = menu.getBoundingClientRect();
  let x = rect ? rect.right - menuRect.width : at.x;
  let y = rect ? rect.bottom + 2 : at.y;
  if (x + menuRect.width > window.innerWidth - 8) x = window.innerWidth - 8 - menuRect.width;
  if (y + menuRect.height > window.innerHeight - 8) y = (rect ? rect.top - 2 : at.y) - menuRect.height;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  document.addEventListener("pointerdown", onRowMenuOutsidePointer, true);
  document.addEventListener("keydown", onRowMenuKeydown, true);
  window.addEventListener("resize", closeRowMenu);
  el.sessionTree.addEventListener("scroll", closeRowMenu);
  const first = menu.querySelector(".row-menu-item");
  if (first) first.focus({ preventScroll: true });
}

// Wires `row` up to open the menu on right-click, or on a long press for
// touch (iOS Safari never fires "contextmenu" for one; Android does, which
// is why the handler below skips a contextmenu right after a long press
// already opened the menu). Unless `button: false`, also adds a "⋯" button
// to `container`. `getItems(feedbackEl)` is called on each open, so the menu
// always reflects the row's current state - `feedbackEl` is where a
// "copied" tick can be flashed (the "⋯" itself, or `feedbackEl` passed in).
const LONG_PRESS_MS = 500;

function attachRowMenu(row, container, getItems, { button = true, feedbackEl = null } = {}) {
  let moreBtn = null;
  if (button) {
    moreBtn = iconButton("⋯", t("tree.moreActions"));
    moreBtn.classList.add("row-more-btn");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (rowMenuAnchor === moreBtn) {
        closeRowMenu();
        return;
      }
      openRowMenu(moreBtn, getItems(moreBtn));
    });
    container.appendChild(moreBtn);
  }
  const feedback = feedbackEl || moreBtn;

  let longPressedAt = 0;
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (Date.now() - longPressedAt < 1000) return;
    openRowMenu({ x: e.clientX, y: e.clientY }, getItems(feedback));
  });

  let pressTimer = null;
  let pressStart = null;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    pressStart = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressedAt = Date.now();
      openRowMenu(pressStart, getItems(feedback));
      // The finger lifting off would otherwise "click" the row (selecting
      // the document / toggling the folder) under the menu just opened.
      suppressClickBriefly();
    }, LONG_PRESS_MS);
  });
  row.addEventListener("pointermove", (e) => {
    if (pressTimer && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
  });
  row.addEventListener("pointerup", cancelPress);
  row.addEventListener("pointercancel", cancelPress);
  return moreBtn;
}

// Like suppressNextClick below, but expires on its own - after a long press
// the browser may or may not follow up with a click, and a permanent
// one-shot swallow would then eat the user's next tap on a menu item.
function suppressClickBriefly() {
  const swallow = (e) => {
    if (rowMenuEl && rowMenuEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("click", swallow, true);
  setTimeout(() => document.removeEventListener("click", swallow, true), 700);
}

function isDirty() {
  return !!active && el.editor.value !== active.savedContent;
}

// Also toggles the save button's "dirty" styling (see .secondary-btn.dirty
// in style.css) - called from every place dirty state can change (typing,
// selecting a different document, saving, a send completing), so it's
// simplest to fold that in here rather than repeat it at each call site.
function updateFilenameLabel() {
  updateViewModeButton();
  if (!active) {
    el.editorFilename.textContent = t("editor.selectDocument");
    el.editorFilename.title = "";
    el.saveBtn.classList.remove("dirty");
    document.title = "mark-vector";
    return;
  }
  const dirty = isDirty();
  updateCurrentTabMarker();
  el.editorFilename.textContent = active.filename + (dirty ? " •" : "");
  el.editorFilename.title = active.sessionId ? t("doc.altHintTooltip", { hintKey: HINT_KEY_NAME, hintSymbol: HINT_KEY_SYMBOL }) : "";
  el.saveBtn.classList.toggle("dirty", dirty);
  const baseName = active.filename.replace(/\.md$/i, "");
  const heading = firstH1Heading(el.editor.value);
  document.title = (dirty ? "• " : "") + (heading || baseName);
}

function isDirtyB() {
  return !!activeB && el.editorB.value !== activeB.savedContent;
}

// activeB's own version of updateFilenameLabel - no document.title (that's
// still pane A's alone, see above), and no alt-hint tooltip (that shortcut
// only ever jumps within pane A).
function updateFilenameLabelB() {
  if (!activeB) {
    el.editorFilenameB.textContent = t("editor.selectDocument");
    el.saveBtnB.classList.remove("dirty");
    updateEditTargetButton();
    hideDocEditStrip();
    return;
  }
  const dirty = isDirtyB();
  el.editorFilenameB.textContent = activeB.filename + (dirty ? " •" : "");
  el.saveBtnB.classList.toggle("dirty", dirty);
  updateEditTargetButton();
  // The strip is about one document - gone once pane B shows another.
  if (docEdit && docEdit.doc !== activeB) hideDocEditStrip();
}

// A document with no math directive of its own inherits one, in order:
// its own session's system.md directive, then its project's system.md
// directive, then the common (global) system prompt's directive, then
// "latex". So an assistant reply that never mentions math syntax itself
// still renders in whatever dialect the nearest ancestor prompt declared.
function sessionMathDialect(projectId, sessionId) {
  const project = projectId && projects.get(projectId);
  const session = project && sessionId && project.sessions && project.sessions.get(sessionId);
  const sessionDoc = session && session.documents && session.documents.find((d) => d.role === "system");
  const sessionDialect = sessionDoc && detectMathDirective(sessionDoc.content);
  if (sessionDialect) return sessionDialect;
  const projectDialect = project && detectMathDirective(project.systemPromptContent || "");
  if (projectDialect) return projectDialect;
  return detectMathDirective(globalSystemPromptContent) || "latex";
}

// Shows/hides one pane's pair of floating scroll buttons: "to top" only
// once scrolled down past `THRESHOLD`, "to bottom" only while there's still
// that much left below - so a document short enough to need neither just
// shows neither, instead of two buttons that would always be no-ops.
const SCROLL_NAV_THRESHOLD = 40;
function updateScrollNavFor(scrollEl, topBtn, bottomBtn) {
  const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight > SCROLL_NAV_THRESHOLD;
  topBtn.classList.toggle("visible", scrollable && scrollEl.scrollTop > SCROLL_NAV_THRESHOLD);
  bottomBtn.classList.toggle(
    "visible",
    scrollable && scrollEl.scrollTop < scrollEl.scrollHeight - scrollEl.clientHeight - SCROLL_NAV_THRESHOLD
  );
}
function updateScrollNavVisibility() {
  updateScrollNavFor(el.editor, el.editorScrollTopBtn, el.editorScrollBottomBtn);
  updateScrollNavFor(el.preview, el.previewScrollTopBtn, el.previewScrollBottomBtn);
  // el.preview's own scrollability is what it is regardless of which pane
  // is currently feeding it (see previewSource) - always kept current, same
  // as el.editor's own nav above. Pane B's nav is conditional simply because
  // the buttons don't exist as a scrollable target at all while the pane is
  // closed (0-height, hidden).
  if (splitViewOpen()) updateScrollNavFor(el.editorB, el.editorScrollTopBtnB, el.editorScrollBottomBtnB);
}

// Whether each pane rides a streaming reply down to its newest line. Only
// the *user* scrolling a pane changes this - a wheel/touch/scrollbar/key
// scroll that leaves it away from the bottom stops following, one that
// brings it back to the bottom resumes. The stream's own scrolling never
// does: deciding from every "scroll" event used to switch following off by
// itself, because the event fires a frame after our scrollTop write, by
// which time the next deltas have already grown the content past the
// threshold - so the pane looked "not at the bottom" and froze mid-stream.
//
// The streaming loop only ever *writes* scroll positions (followStream),
// never reads them: a layout read right after each delta's DOM change
// forces a synchronous layout flush, and doing that per delta visibly
// turned both panes' smooth streaming into stuttering bursts.
const USER_SCROLL_WINDOW_MS = 300;
const streamFollow = { editor: true, preview: true };
const lastUserScrollIntent = { editor: 0, preview: 0 };

function isScrolledToBottom(scroller) {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - SCROLL_NAV_THRESHOLD;
}

function watchUserScroll(pane, scrollers) {
  const markIntent = () => {
    lastUserScrollIntent[pane] = performance.now();
  };
  for (const scroller of scrollers) {
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
      scroller.addEventListener(type, markIntent, { passive: true });
    }
    scroller.addEventListener("scroll", () => {
      if (performance.now() - lastUserScrollIntent[pane] < USER_SCROLL_WINDOW_MS) {
        streamFollow[pane] = isScrolledToBottom(scroller);
      }
    });
  }
}

// Pane A's editor scrolls in one of two elements depending on the
// source/rendered toggle (see renderEditorView).
function followStream() {
  if (streamFollow.editor) {
    if (editorViewMode === "rendered") el.editorRendered.scrollTop = 1e9;
    else el.editor.scrollToEnd();
  }
  if (streamFollow.preview) el.preview.scrollTop = 1e9;
}

// Opt-in (checkbox, off by default - see restoreSyncScrollPref below), so it
// never fights someone who wants to scroll the two panes independently.
// One-directional (editor -> preview) as asked: scrolling the preview itself
// never moves the editor back. There's no reliable source-line mapping from
// the raw markdown to the rendered HTML (the renderer is a plain string ->
// string renderer, no position tracking), so this matches by proportion of
// the scrollable range instead of by line - close enough to "show what I'm
// editing" without needing to instrument the renderer.
const SYNC_SCROLL_KEY = "mark-vector:sync-scroll";

function saveSyncScrollPref() {
  try {
    localStorage.setItem(SYNC_SCROLL_KEY, el.syncScrollCheckbox.checked ? "1" : "0");
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function restoreSyncScrollPref() {
  let stored = null;
  try {
    stored = localStorage.getItem(SYNC_SCROLL_KEY);
  } catch (err) {
    stored = null;
  }
  el.syncScrollCheckbox.checked = stored === "1";
}

// `which` is "a" or "b" - the pane whose scroll (or whose content just
// changed) prompted this call. Applied only when it matches previewSource:
// otherwise it's pane A scrolling while the preview is currently showing
// pane B (or vice versa), which has nothing to sync against.
function syncPreviewScrollFromSource(which) {
  if (!el.syncScrollCheckbox.checked || which !== previewSource) return;
  const sourceEditor = which === "b" ? el.editorB : el.editor;
  const editorRange = sourceEditor.scrollHeight - sourceEditor.clientHeight;
  const previewRange = el.preview.scrollHeight - el.preview.clientHeight;
  if (editorRange <= 0 || previewRange <= 0) return;
  el.preview.scrollTop = (sourceEditor.scrollTop / editorRange) * previewRange;
}

// ---------- live sockets (shared plumbing for "glasses" and "live") ----------
// Two independent features below push the same {type:"update", filename,
// content, dialect} payload (currentLiveState) over a WebSocket to
// backend/app/routers/live.py, which relays it to whatever else is
// connected to that same channel: a glasses/app.js screen for the "glasses"
// feature, or a visitor's public.js page for the "live" (live-to-public)
// feature. They have their own channel, their own on/off state and their
// own socket - createLiveSocket just gives each one the same throttled-
// send/auto-reconnect plumbing without writing it twice.
const LIVE_SEND_INTERVAL_MS = 200;
const LIVE_RETRY_MIN_MS = 1000;
const LIVE_RETRY_MAX_MS = 10000;
// A socket can go dead without ever closing - iOS drops the connection of
// a page sent to the background, and the page finds out only when it
// tries to read. Every so often the server is asked for a "pong"; one that
// hasn't come by the next ask means start over.
const LIVE_HEARTBEAT_MS = 10000;

function currentLiveState() {
  return active
    ? {
        type: "update",
        filename: active.filename,
        // Stripped here rather than at either receiver: this same payload is
        // what a published page renders live (see livePublicSocket), and a
        // reader must not be sent the thread at all - the same reasoning as
        // storage.resolve_published's own stripping.
        content: stripInlineThreads(el.editor.value),
        dialect: sessionMathDialect(active.projectId, active.sessionId),
        // The document's own "view as slideshow" publish option - the
        // glasses screen shows slides when it's on (public pages already
        // know it from the share link itself).
        slides: !!active.publishSlides,
        // The presenter remote's slide (see the presenter section) - left
        // out entirely until the remote has been used, so a plain Live
        // session never moves anyone's slideshow.
        ...(presenter.slide !== null ? { slide: presenter.slide } : {}),
      }
    : { type: "update", filename: null, content: "" };
}

// `onConnectedChange(connected)` is called on every open/close so each
// caller can drive its own status dot. `connect(channel)` is safe to call
// again with a different channel while already connected - it tears down
// the old socket first, which is how switching documents re-targets the
// "live" feature below without a separate disconnect step.
// `belongsHere(channel)` (optional) is asked right before every send: a
// socket tied to one document's channel must never carry another
// document's content, even for the moment between `active` switching and
// the socket being re-targeted (see livePublicSocket below).
// `onCommand(message)` (optional) receives a command a screen sent back on
// the channel (see live.py's _COMMAND_ACTIONS) - e.g. the glasses D-pad
// asking for a new slide.
function createLiveSocket(onConnectedChange, { belongsHere = () => true, onCommand = () => {}, state = currentLiveState } = {}) {
  let channel = null;
  let socket = null;
  let sendTimer = null;
  let lastSentAt = 0;
  let retryDelay = LIVE_RETRY_MIN_MS;
  let retryTimer = null;
  let wantConnected = false;
  let heartbeat = null;
  let awaitingPong = false;

  // Throttled, not debounced: an LLM reply streams in as a steady run of
  // "delta" events (see sendActive below), each calling renderPreview() ->
  // here - a trailing *debounce* would keep pushing the send back on every
  // one of those and never actually flush until the stream paused, so the
  // receiving end would jump straight to the finished reply instead of
  // visibly streaming. Throttling sends at most once per
  // LIVE_SEND_INTERVAL_MS during a burst - immediately if enough time has
  // already passed, otherwise via exactly one trailing flush already
  // scheduled for whenever the current window closes - which keeps typing
  // just as cheap as before while still reading as "live" during a stream.
  function sendNow() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !belongsHere(channel)) return;
    lastSentAt = Date.now();
    let message;
    try {
      message = state();
    } catch (err) {
      console.error("live state failed", err);
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function beat() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (awaitingPong) {
      connect(channel); // dead - a fresh socket sends the state on open
      return;
    }
    awaitingPong = true;
    socket.send(JSON.stringify({ type: "ping" }));
  }

  function send(immediate) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (immediate) {
      clearTimeout(sendTimer);
      sendTimer = null;
      sendNow();
      return;
    }
    const elapsed = Date.now() - lastSentAt;
    if (elapsed >= LIVE_SEND_INTERVAL_MS) {
      sendNow();
      return;
    }
    if (sendTimer) return; // a trailing flush for this window is already queued
    sendTimer = setTimeout(() => {
      sendTimer = null;
      sendNow();
    }, LIVE_SEND_INTERVAL_MS - elapsed);
  }

  function connect(newChannel) {
    channel = newChannel;
    wantConnected = true;
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    awaitingPong = false;
    if (socket) {
      socket.close();
      socket = null;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(channel)}`);
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      onConnectedChange(true);
      retryDelay = LIVE_RETRY_MIN_MS;
      heartbeat = setInterval(beat, LIVE_HEARTBEAT_MS);
      send(true);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(heartbeat);
      onConnectedChange(false);
      // Only auto-reconnect while this connection is still wanted - a
      // deliberate disconnect() clears wantConnected first (which normally
      // reaches here via a clean close before this fires), but it's
      // rechecked here too as a belt-and-suspenders guard against a race
      // between that and an in-flight close event.
      if (wantConnected) {
        retryTimer = setTimeout(() => connect(channel), retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, LIVE_RETRY_MAX_MS);
      }
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message && message.type === "pong") awaitingPong = false;
      else if (message && message.type === "command") onCommand(message);
    });
    ws.addEventListener("error", () => ws.close());
  }

  function disconnect() {
    wantConnected = false;
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    clearTimeout(sendTimer);
    if (socket) {
      const ws = socket;
      socket = null;
      ws.close();
    }
    onConnectedChange(false);
  }

  // Back on screen after a spell in the background: check right away
  // rather than at the next beat.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !socket || socket.readyState !== WebSocket.OPEN) return;
    awaitingPong = false;
    beat();
    clearInterval(heartbeat);
    heartbeat = setInterval(beat, LIVE_HEARTBEAT_MS);
  });

  return {
    connect,
    disconnect,
    send,
    currentChannel: () => channel,
  };
}

// ---------- glasses (Meta Ray-Ban Display live mirror) ----------
// Opt-in (checkbox, off by default), same persistence pattern as sync-scroll
// above. While on, every renderPreview() call (see the hook at the bottom of
// that function) also pushes the current buffer through the shared live
// socket above, which backend/app/routers/live.py relays to any
// glasses/app.js screens listening on the same channel - see
// glasses/index.html. The channel id is a random, unguessable string minted
// once per browser and reused across reloads (same role a publish token
// plays for routers/public.py): whoever has the URL can watch, so it's
// never sent anywhere but into that URL.
const GLASSES_CHANNEL_KEY = "mark-vector:live-channel";
const GLASSES_ENABLED_KEY = "mark-vector:live-enabled";

// Only the glasses get the Evaluate tab's live check findings (see
// analysis.js's liveSnapshot) - for the speaker's eyes, never a public page.
// `producing` tells that screen a quiet stretch is a stall rather than an
// idle document: dictation writing into this buffer, or a reply streaming
// in. Dictation aimed at another tab (writeStash) is not this document.
function glassesExpectsText() {
  return expectsText({ dictatingHere: !!(dictation && !dictation.writeStash), streaming });
}
const glassesSocket = createLiveSocket((connected) => el.glassesStatusDot.classList.toggle("connected", connected), {
  onCommand: handleScreenCommand,
  state: () => ({ ...currentLiveState(), liveCheck: analysisPanel.liveSnapshot(), producing: glassesExpectsText() }),
});

// Starting and stopping a session doesn't always edit the document in the
// same turn (the pause before the first word, the moment listening ends).
// Push once when the flag flips so the glasses stall clock tracks the
// session, not only the keystrokes. Kept off the dictation button path.
let glassesProducingSent = null;
setInterval(() => {
  if (!el.glassesCheckbox.checked) {
    glassesProducingSent = null;
    return;
  }
  const producing = glassesExpectsText();
  if (producing === glassesProducingSent) return;
  glassesProducingSent = producing;
  glassesSocket.send(true);
}, 1000);

function getOrCreateGlassesChannel() {
  let channel = null;
  try {
    channel = localStorage.getItem(GLASSES_CHANNEL_KEY);
  } catch (err) {
    channel = null;
  }
  if (!channel) {
    channel = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random()}`.replace(/\./g, "");
    try {
      localStorage.setItem(GLASSES_CHANNEL_KEY, channel);
    } catch (err) {
      // localStorage unavailable - the channel just won't survive a reload;
      // glasses mirroring still works for the rest of this tab's lifetime.
    }
  }
  return channel;
}

// From the stored channel id, not the socket's current one: the toolbar
// shows this URL before the socket has connected (page load with Glasses
// already on), when the socket has no channel yet - which used to put
// "?c=null" in the URL, a channel nothing ever sends to.
function glassesUrl() {
  const params = new URLSearchParams();
  params.set("c", getOrCreateGlassesChannel());
  // The glasses page has no language control. Carry the editor's choice so
  // an iPhone (or the glasses) opened from this link shows the connection
  // status in the same language. English stays the bare URL it always was.
  const lang = getLanguage();
  if (lang && lang !== "en") params.set("lang", lang);
  return `${location.origin}/glasses/?${params.toString()}`;
}

function saveGlassesEnabledPref() {
  try {
    localStorage.setItem(GLASSES_ENABLED_KEY, el.glassesCheckbox.checked ? "1" : "0");
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function restoreGlassesEnabledPref() {
  let stored = null;
  try {
    stored = localStorage.getItem(GLASSES_ENABLED_KEY);
  } catch (err) {
    stored = null;
  }
  el.glassesCheckbox.checked = stored === "1";
}

function updateGlassesToolbarVisibility() {
  const on = el.glassesCheckbox.checked;
  el.glassesToolbar.hidden = !on;
  if (on) el.glassesUrlInput.value = glassesUrl();
}

function connectGlasses() {
  glassesSocket.connect(getOrCreateGlassesChannel());
}

async function copyGlassesUrl() {
  const url = glassesUrl();
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    // Clipboard API unavailable/denied - the URL is still selected in the
    // (readonly) input below for a manual copy.
    el.glassesUrlInput.select();
    return;
  }
  const original = el.glassesCopyBtn.textContent;
  el.glassesCopyBtn.textContent = "✅";
  setTimeout(() => {
    el.glassesCopyBtn.textContent = original;
  }, 1200);
}

// ---------- live (editor -> public share page) ----------
// A second, independent use of the live-socket plumbing above: while on,
// pushes the same {filename, content, dialect} the glasses feature does,
// but to a channel derived from *this document's own publish token*
// instead of a per-browser id - see routers/public.py's GET
// /api/public/{token} (a plain re-read-from-disk on every page load) and
// static/js/public.js's WebSocket connection to that same channel, which is
// what makes that page update without a reload while this is on. The
// channel is prefixed ("pub-") only so it can never collide with a glasses
// channel in routers/live.py's shared _channels dict - both are 32 hex
// chars so the chance was already negligible, this just makes it zero and
// keeps the two kinds of channel visually distinguishable server-side.
//
// Only meaningful for a *published* document (no publish token, no public
// page to update) - updateLivePublicTarget(), called from
// updatePublishButton() below, shows/hides the checkbox and points this at
// the active document's current token, reconnecting whenever that token
// changes (publish, unpublish, switching documents). Same trust model as
// the glasses channel: the channel id is the only access control, and here
// it's not even a private one - anyone with the public share link already
// knows it, so (like the glasses channel already does today) this trusts
// that nobody with the link opens a raw WebSocket to it and injects fake
// updates for other visitors to see.
const LIVE_PUBLIC_ENABLED_KEY = "mark-vector:live-public-enabled";

// A published page's channel only ever gets *that* document. Opening
// another document swaps `active` (and the editor's content, which triggers
// a send) before updateLivePublicTarget re-targets or drops this socket -
// without the check, that one send pushed the newly opened document onto
// the old document's public page, where the server then kept it as the
// channel's latest state for every new visitor.
const livePublicSocket = createLiveSocket((connected) => el.livePublicStatusDot.classList.toggle("connected", connected), {
  belongsHere: (channel) => !!(active && active.publishToken) && channel === livePublicChannel(active.publishToken),
  // An ambient glasses screen sends its commands to whichever channel it's
  // showing, which can be this one.
  onCommand: handleScreenCommand,
});

function livePublicChannel(token) {
  return `pub-${token}`;
}

function saveLivePublicEnabledPref() {
  try {
    localStorage.setItem(LIVE_PUBLIC_ENABLED_KEY, el.livePublicCheckbox.checked ? "1" : "0");
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function restoreLivePublicEnabledPref() {
  let stored = null;
  try {
    stored = localStorage.getItem(LIVE_PUBLIC_ENABLED_KEY);
  } catch (err) {
    stored = null;
  }
  el.livePublicCheckbox.checked = stored === "1";
}

function updateLivePublicTarget() {
  const token = active && active.publishToken;
  el.livePublicRow.hidden = !token;
  el.publishSlidesRow.hidden = !token;
  el.publishSlidesCheckbox.checked = !!(token && active.publishSlides);
  if (!token) {
    livePublicSocket.disconnect();
    return;
  }
  if (el.livePublicCheckbox.checked && livePublicSocket.currentChannel() !== livePublicChannel(token)) {
    livePublicSocket.connect(livePublicChannel(token));
  }
}

// ---------- autosave (crash/close recovery, not a substitute for Save) ----------
// A safety net under the Save button, not a replacement for it: this never
// touches the real document on disk (only the Save button's own
// api.saveDocument call does that), and it's never exposed through a
// publish link - it only ever writes to this browser's localStorage, keyed
// by activeDocRef() so a draft can be matched back to the right document
// the next time it's opened. Deliberately client-side-only rather than a
// server-side draft endpoint: it exists purely to survive a crashed tab/
// browser, not to protect against a lost laptop, and keeping it out of the
// backend means it can never leak into a share link or a second device.
const AUTOSAVE_DEBOUNCE_MS = 1000;
let autosaveTimer = null;

function autosaveKey() {
  const ref = activeDocRef();
  // hermes-session's editor is always disabled (read-only transcript) - it
  // can never actually go dirty, so it never needs a key at all.
  if (!ref || ref.role === "hermes-session") return null;
  return `mark-vector:autosave:${JSON.stringify(ref)}`;
}

function writeAutosave() {
  const key = autosaveKey();
  if (!key) return;
  try {
    if (!isDirty()) {
      // Caught back up to the saved content (Save was clicked, or the edit
      // was undone by hand) - nothing left worth recovering.
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ content: el.editor.value, savedAt: Date.now() }));
  } catch (err) {
    // localStorage unavailable/full - this save's recovery net just doesn't
    // apply; Save itself is completely unaffected.
  }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE_MS);
}

// Clears whatever draft belongs to the document about to be *loaded* -
// called from saveActive() right after a real save succeeds, since that
// document's dirty gap has just closed for real and writeAutosave() above
// won't get another chance to notice until the next edit (which may be a
// while, or never, if the user navigates away right after saving).
function clearAutosave() {
  const key = autosaveKey();
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (err) {
    // localStorage unavailable - nothing to clear anyway
  }
}

// Called right after a document's on-disk content is loaded into the editor
// (before renderPreview()/updateFilenameLabel(), so a restored draft is
// reflected in both immediately) - offers to restore a recovered draft if
// one exists for this exact document and actually differs from what was
// just loaded. Declining discards it outright rather than asking again next
// time this document is opened.
function maybeRestoreAutosave() {
  const key = autosaveKey();
  if (!key) return;
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch (err) {
    raw = null;
  }
  if (!raw) return;
  let draft = null;
  try {
    draft = JSON.parse(raw);
  } catch (err) {
    draft = null;
  }
  if (!draft || typeof draft.content !== "string" || draft.content === el.editor.value) {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      // localStorage unavailable - nothing to clear anyway
    }
    return;
  }
  const when = draft.savedAt ? new Date(draft.savedAt).toLocaleString(getLanguage()) : "";
  if (confirm(t("confirm.restoreAutosave", { when }))) {
    el.editor.value = draft.content;
  } else {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      // localStorage unavailable - nothing to clear anyway
    }
  }
}

// Which pane the shared preview is currently rendering - "a" (the primary
// editor) unless split view is open and pane B was the one last focused
// (see the "focus" listeners below). Whichever pane isn't the source still
// keeps its *own* nav buttons/autosave/etc. current (see renderPreview/
// renderPreviewB below) - only the shared #preview element itself, and the
// sync-scroll it drives, follow the source.
let previewSource = "a";
let focusedEditorPane = "a";

function conversationPairOpen() {
  return splitViewOpen() && !!active && !!activeB &&
    active.projectId === activeB.projectId && active.sessionId === activeB.sessionId &&
    activeB.filename?.endsWith(".md") &&
    active.filename === activeB.filename.slice(0, -3) + ".c.md";
}

function setPreviewSource(source) {
  if (conversationPairOpen()) source = "b";
  if (previewSource === source) return;
  previewSource = source;
  if (source === "a") renderPreview();
  else renderPreviewB();
}

// ---------- preview pane tabs (Preview / Evaluate / Formalize) ----------
// Evaluate and Formalize read the same document the preview shows (see
// previewSource) - see analysis.js. Every content change already passes
// through renderPreview/renderPreviewB, which tell the panel so it can mark
// a saved result stale.

function analysisTarget() {
  const useB = previewSource === "b" && !!activeB;
  const doc = useB ? activeB : active;
  if (!doc || !doc.filename || NON_SENDABLE_ROLES.has(doc.role)) return null;
  return {
    projectId: doc.projectId,
    sessionId: doc.sessionId,
    filename: doc.filename,
    content: (useB ? el.editorB : el.editor).value,
    // The document's own directive first, as its preview reads it - the
    // reply's math is written in the same notation (see analysis.py).
    dialect: detectMathDirective((useB ? el.editorB : el.editor).value) || sessionMathDialect(doc.projectId, doc.sessionId),
    pane: useB ? "b" : "a",
  };
}

const analysisPanel = createAnalysisPanel({
  body: el.analysisBody,
  runBtn: el.analysisRunBtn,
  status: el.analysisStatus,
  copyBtn: el.analysisCopyBtn,
  leanLink: el.analysisLeanLink,
  lensSelect: el.analysisLensSelect,
  clearBtn: el.analysisClearBtn,
  nowBtn: el.analysisNowBtn,
  onLiveChange() {
    if (el.glassesCheckbox.checked) glassesSocket.send(false);
  },
  alert(on) {
    el.previewTabs.querySelector('[data-view="evaluate"]').classList.toggle("has-alert", on);
  },
  getTarget: analysisTarget,
  getSettings: () => ({
    provider: el.providerSelect.value,
    model: el.modelSelect.value,
    reasoningEffort: el.reasoningSelect.value,
  }),
  reveal(start, end) {
    const target = analysisTarget();
    if (!target) return;
    setMobileView("editor");
    if (target.pane === "a" && editorViewMode === "rendered") toggleEditorViewMode();
    (target.pane === "b" ? el.editorB : el.editor).revealRange(start, end);
  },
  renderMarkdown,
});

function setPreviewView(view) {
  el.previewPane.dataset.view = view;
  for (const tab of el.previewTabs.querySelectorAll(".preview-tab")) {
    const on = tab.dataset.view === view;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  }
  el.analysisView.hidden = view === "preview";
  analysisPanel.show(view === "preview" ? null : view);
  if (view === "preview") updateScrollNavVisibility();
}

el.previewTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".preview-tab");
  if (tab) setPreviewView(tab.dataset.view);
});

// ⌥1 / ⌥2 / ⌥3 (Alt+Shift+1/2/3 off a Mac, where Alt+digit is the document
// jump - see hintModifierHeld): Preview / Evaluate / Formalize, bringing the
// pane out if it's collapsed (or, on a phone, switching to it). Matched on
// e.code - Option turns the digits into ¡ ™ £.
const PREVIEW_VIEW_KEYS = { Digit1: "preview", Digit2: "evaluate", Digit3: "formalize" };
document.addEventListener("keydown", (e) => {
  const view = PREVIEW_VIEW_KEYS[e.code];
  if (!view || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey !== !IS_MAC) return;
  if (!el.quickOpenOverlay.hidden || !el.shortcutsOverlay.hidden) return;
  e.preventDefault();
  if (el.layout.classList.contains("preview-collapsed")) setPreviewCollapsed(false);
  setMobileView("preview");
  setPreviewView(view);
});

// ⌥R (Alt+R): the Evaluate / Formalize tab's run button - run, run again,
// or start/stop the live check - when one of those tabs is the pane's view.
document.addEventListener("keydown", (e) => {
  if (e.code !== "KeyR" || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (!el.quickOpenOverlay.hidden || !el.shortcutsOverlay.hidden) return;
  if (el.previewPane.dataset.view === "preview" || !el.previewPane.dataset.view) return;
  e.preventDefault();
  if (el.layout.classList.contains("preview-collapsed")) setPreviewCollapsed(false);
  if (!el.analysisRunBtn.disabled) el.analysisRunBtn.click();
});

function paintSharedPreview(text, dialect) {
  // Threads are scratch conversation: collapsed ones are left out, expanded
  // ones are rendered in their own box (see renderDocumentWithThreads). The
  // buffer keeps all of them either way, and a published page gets none.
  el.preview.innerHTML = renderDocumentWithThreads(text, dialect);
}

function renderPreview() {
  syncDocumentFollowers();
  if (conversationPairOpen()) {
    previewSource = "b";
    renderPreviewB();
  }
  // renderPreview() is already the one function every pane-A content change
  // in this file calls right afterward (new document, streaming delta,
  // Tab/Enter, format conversion, ...), so hooking the nav/sync/autosave/
  // live-socket updates in here covers all of them without a call at each
  // site individually. Those last three (autosave, glasses, live-public)
  // reflect pane A regardless of which pane the shared preview is currently
  // showing - they're about the *document*, not the screen - so they always
  // run; only the shared #preview element's own content is conditional.
  if (previewSource === "a") {
    paintSharedPreview(el.editor.value, sessionMathDialect(active && active.projectId, active && active.sessionId));
    // Has to run here too (not just on the editor's own "scroll" event)
    // because typing/streaming changes the preview's scrollHeight without
    // necessarily scrolling the editor at all, which would otherwise leave
    // the two ranges' proportions mismatched.
    syncPreviewScrollFromSource("a");
  }
  renderEditorView();
  updateScrollNavVisibility();
  syncInlineFolds();
  if (el.glassesCheckbox.checked) glassesSocket.send(false);
  if (el.livePublicCheckbox.checked) livePublicSocket.send(false);
  scheduleAutosave();
  analysisPanel.contentChanged();
}

// Pane B's counterpart - deliberately thin: no thread-fold sync (pane B's
// folds are plain view state, nothing in the document to reconcile - see
// el.editorB's foldRanges), no autosave, no glasses/live-public (those
// follow pane A's own document regardless of what's on screen - see
// renderPreview above).
function renderPreviewB() {
  syncDocumentFollowers();
  if (conversationPairOpen()) previewSource = "b";
  if (previewSource === "b" && activeB) {
    paintSharedPreview(el.editorB.value, sessionMathDialect(activeB.projectId, activeB.sessionId));
    syncPreviewScrollFromSource("b");
  }
  updateScrollNavVisibility();
  analysisPanel.contentChanged();
}

// ---------- editor view mode (source / rendered) ----------
// The pane-A editor's own toggle between the raw Markdown (CodeMirror,
// editable) and the same rendering the preview shows (read-only) - see
// #view-mode-btn. Sticky across document switches within the session (like
// the sync-scroll checkbox) rather than reset per-document: browsing several
// exchanges while reading is the case this exists for, and resetting to
// source on every click would fight that. Not persisted across reloads.
let editorViewMode = "source";

function toggleEditorViewMode() {
  if (!active) return;
  editorViewMode = editorViewMode === "source" ? "rendered" : "source";
  updateViewModeButton();
  renderEditorView();
  if (editorViewMode === "source") el.editor.focus();
}

function updateViewModeButton() {
  el.viewModeBtn.disabled = !active;
  const rendered = editorViewMode === "rendered";
  el.viewModeBtn.setAttribute("aria-pressed", rendered ? "true" : "false");
  el.viewModeLabel.textContent = t(rendered ? "editor.viewModeRendered" : "editor.viewModeSource");
}

// Called from renderPreview() below - already the one place every pane-A
// content change (typing, streaming, a document switch, a format
// conversion, ...) runs through, so this stays in sync without a separate
// call at each of those sites. A no-op paint when not actually in rendered
// mode; hiding/showing the two elements still has to run unconditionally
// (through every path that can flip `active`, not just renderPreview's own
// pane-A-content ones - clearEditor in particular never touches the
// document's text at all) so an emptied-out editor doesn't leave the
// rendered view showing a stale render of whatever used to be open.
function renderEditorView() {
  const rendered = editorViewMode === "rendered" && !!active;
  el.editor.rootElement.hidden = rendered;
  el.editorRendered.hidden = !rendered;
  if (!rendered) return;
  el.editorRendered.innerHTML = renderDocumentWithThreads(
    el.editor.value,
    sessionMathDialect(active.projectId, active.sessionId)
  );
}

// The currently open document's own math format if it declares one, else
// whatever it would inherit (see sessionMathDialect) - same resolution
// renderPreview() already uses, just exposed so the format selector can
// reflect and act on it.
function currentDocumentFormat() {
  if (!active) return "latex";
  return detectMathDirective(el.editor.value) || sessionMathDialect(active.projectId, active.sessionId);
}

// The format selector shows/converts the *current buffer's* math notation for
// ANY open document mark-vector itself owns (system prompts included) - not
// gated to sendable turns, unlike the provider/model/reasoning controls
// below. A Hermes transcript isn't mark-vector's to convert or save, so it
// stays out of this entirely.
// A CSV isn't a math document - no LaTeX/AsciiMath dialect applies to it,
// so the toolbar has nothing meaningful to show or convert (same reasoning
// as "hermes-session", a read-only transcript that isn't mark-vector's to
// convert either).
function updateFormatToolbar() {
  const noFormat = !active || active.role === "hermes-session" || active.role === "global-custom-symbols" || active.role === "global-spoken-math";
  el.formatSelect.hidden = noFormat;
  updateEditorToolbarVisibility();
  if (noFormat) return;
  el.formatSelect.value = currentDocumentFormat();
}

// Converts the open buffer to `target` format in place (editor only - not
// auto-saved, same as any other unsaved edit) when it isn't already that
// format. AsciiMath2 -> LaTeX runs client-side (asciimath-markdown already has the
// asciimath-parser instance loaded for rendering) regardless of whether the
// source was "asciimath" or "hybrid" - it only ever touches $/$$ spans
// either way, which is also exactly hybrid's own \(...\)/\[...\]-untouched
// contract, so no separate hybrid case is needed there. LaTeX -> AsciiMath2/
// Hybrid goes through the backend either way, since that direction needs
// asciimath2's pylatexenc-based parser - `hybrid: target === "hybrid"`
// is the only difference, telling it to leave \(...\)/\[...\] spans alone.
async function convertActiveFormat(target) {
  if (!active || streaming) return;
  if (currentDocumentFormat() === target) return;
  const content = el.editor.value;
  try {
    el.editor.value =
      target === "latex" ? convertAsciiMathToLatex(content) : (await api.convertToAsciiMath(content, target === "hybrid")).content;
    updateFilenameLabel();
    renderPreview();
  } catch (err) {
    alert(t("action.convertFailed", { message: err.message }));
  } finally {
    updateFormatToolbar();
  }
}

// Some gateways expose an agent's tool calls as extra "tool_status" stream
// events (not every provider sends these - most never will). Shown as a
// transient status line above the editor while a message is being sent.
function setToolStatus(text) {
  el.toolStatus.textContent = text || "";
  el.toolStatus.hidden = !text;
}

function clearEditor() {
  active = null;
  saveActiveDocRef();
  el.editor.value = "";
  el.editor.disabled = true;
  el.saveBtn.disabled = true;
  el.sendBtn.disabled = true;
  updateInlineCompleteButton();
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateFilenameLabel();
  renderPreview();
}

// The send-only half of the editor toolbar (provider/model/사고 수준/맥락)
// only matters when the open document could actually be sent - hidden for
// system.md (session or project) and the global prompt, which aren't
// conversation turns. The math format selector sharing that row is *not*
// gated on this (see updateFormatToolbar), so each control is hidden
// individually rather than by hiding the row out from under the other.
const SEND_ONLY_CONTROLS = ["providerSelect", "modelSelect", "reasoningSelect", "contextScopeSelect"];

function updateSendToolbarVisibility() {
  const sendable = !!active && !NON_SENDABLE_ROLES.has(active.role);
  for (const key of SEND_ONLY_CONTROLS) el[key].hidden = !sendable;
  updateEditorToolbarVisibility();
}

// The row itself is worth showing as long as *something* in it is - it's
// otherwise an empty bordered strip above the editor.
function updateEditorToolbarVisibility() {
  const visible = [...el.editorToolbar.children].some((child) => !child.hidden);
  el.editorToolbar.hidden = !visible;
  // Nothing in the row means nothing to open, so the ⚙ goes with
  // it rather than opening an empty strip.
  el.toolbarToggleBtn.hidden = !visible;
}

// The row is folded behind this ⚙ at every width (see
// .editor-toolbar:not(.open) in style.css). Deliberately not persisted - "collapsed" is the point of the default, and
// the class survives switching documents within a session anyway.
function toggleEditorToolbar() {
  const open = el.editorToolbar.classList.toggle("open");
  el.toolbarToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  // Same highlight the save/publish buttons use for "this is switched on".
  el.toolbarToggleBtn.classList.toggle("dirty", open);
}

// provider/model/reasoning_effort/context_scope belong to the open document.
// A turn stores them when it is sent. A draft stores them only after the
// user changes the toolbar (see persistDraftChoice). Anything else - a new
// document, a draft nobody has chosen for - uses the app default below,
// never the folder's last send. convert_math isn't part of this: the format
// selector follows the open document's directive.

// Set while applyDocumentSettings is writing the selects, so those
// assignments are not saved back as an explicit draft choice.
let applyingDocumentSettings = false;

function cachedDocument(projectId, sessionId, filename) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(sessionId);
  return session && session.documents && session.documents.find((d) => d.filename === filename);
}

function appDefaultSettings() {
  const chosen = providers.find((p) => p.id === llmDefaults.provider);
  if (chosen) {
    return {
      provider: chosen.id,
      model: chosen.models.includes(llmDefaults.model) ? llmDefaults.model : chosen.default_model,
      reasoningEffort: llmDefaults.reasoning_effort || "off",
      contextScope: "default",
    };
  }
  const fallback = providers.find((p) => p.id === DEFAULT_PROVIDER_ID) || providers[0];
  return {
    provider: fallback ? fallback.id : "",
    model: fallback ? fallback.default_model : "",
    reasoningEffort: "off",
    contextScope: "default",
  };
}

// ★ when the toolbar shows the default; ☆ makes what it shows the default.
function updateDefaultModelButton() {
  const btn = el.setDefaultModelBtn;
  const provider = el.providerSelect.value;
  const model = el.modelSelect.value;
  const reasoning = el.reasoningSelect.value || "off";
  const isDefault =
    !!provider &&
    provider === llmDefaults.provider &&
    model === llmDefaults.model &&
    reasoning === (llmDefaults.reasoning_effort || "off");
  btn.textContent = isDefault ? "★" : "☆";
  btn.classList.toggle("dirty", isDefault);
  btn.disabled = !provider || !model;
  btn.title = isDefault ? t("editor.defaultModelIs") : t("editor.defaultModelSet");
}

async function setDefaultModel() {
  const provider = el.providerSelect.value;
  const model = el.modelSelect.value;
  if (!provider || !model) return;
  const reasoning = el.reasoningSelect.value || "off";
  try {
    llmDefaults = await api.saveLlmDefaults({ provider, model, reasoning_effort: reasoning === "off" ? null : reasoning });
  } catch (err) {
    alert(t("editor.defaultModelFailed", { message: err.message }));
    return;
  }
  updateDefaultModelButton();
  const label = el.providerSelect.selectedOptions[0] ? el.providerSelect.selectedOptions[0].textContent : provider;
  showRemoteStatus(t("editor.defaultModelSaved", { provider: label, model }));
}

function settingsForDocument(doc) {
  if (doc && doc.provider) {
    return {
      provider: doc.provider,
      model: doc.model || "",
      reasoningEffort: doc.reasoning_effort || "off",
      contextScope: doc.context_scope || "default",
    };
  }
  return appDefaultSettings();
}

function applyDocumentSettings(doc) {
  const defaults = settingsForDocument(doc);
  applyingDocumentSettings = true;
  try {
    if (defaults.provider) el.providerSelect.value = defaults.provider;
    populateModelOptions();
    // Only override the provider's own default_model (already selected by
    // populateModelOptions above) if this document's model is still
    // offered - a provider's live model list can change over time (a model
    // gets deprecated/renamed), and setting .value to something with no
    // matching <option> just silently leaves the dropdown on no selection
    // at all, which would then block sending entirely.
    const stillOffered = [...el.modelSelect.options].some((o) => o.value === defaults.model);
    if (defaults.model && stillOffered) el.modelSelect.value = defaults.model;
    el.contextScopeSelect.value = defaults.contextScope;
    // Before the remembered reasoning level, not after: this rebuilds the
    // reasoning options for the model settled on just above (see
    // updateReasoningAvailability), and a level only exists as an <option>
    // once that's run for the right model - assigning it any earlier would
    // just leave the selector on "".
    updateSendAvailability();
    el.reasoningSelect.value = defaults.reasoningEffort;
    // The remembered level isn't one this model takes (or it's gone from the
    // provider's list entirely) - fall back rather than leave the selector
    // blank, same reasoning as the `stillOffered` guard above.
    if (!el.reasoningSelect.value) el.reasoningSelect.value = "off";
  } finally {
    applyingDocumentSettings = false;
  }
  updateDefaultModelButton();
}

// A draft the user has actually picked a provider/model for. Not called
// when the selects are filled in programmatically, and not for a turn:
// a turn's choice is whatever the last send recorded.
function persistDraftChoice() {
  if (applyingDocumentSettings || streaming || !active || active.role !== "draft") return;
  const provider = el.providerSelect.value;
  const model = el.modelSelect.value;
  if (!provider || !model) return;
  const choice = {
    provider,
    model,
    reasoningEffort: el.reasoningSelect.value || "off",
    contextScope: el.contextScopeSelect.value || "default",
  };
  const doc = cachedDocument(active.projectId, active.sessionId, active.filename);
  if (doc) {
    doc.provider = choice.provider;
    doc.model = choice.model;
    doc.reasoning_effort = choice.reasoningEffort;
    doc.context_scope = choice.contextScope;
  }
  const projectId = active.projectId;
  const sessionId = active.sessionId;
  const filename = active.filename;
  api.saveDraftSettings(projectId, sessionId, filename, choice).catch((err) => {
    console.error("Failed to save draft settings", err);
  });
}

function updateSendAvailability() {
  const provider = providers.find((p) => p.id === el.providerSelect.value);
  const usable = !!provider && !!el.modelSelect.value;
  // list_providers() only ever returns configured providers now, so this
  // can only ever mean "there aren't any at all" - not "this one lacks a
  // key", which used to be the other way this warning could show.
  el.providerWarning.hidden = providers.length > 0;
  el.sendBtn.disabled = !active || streaming || NON_SENDABLE_ROLES.has(active.role) || !usable;
  updateEditTargetButton();
  updateDictationButton();
  // Skip while a send is in flight - sendActive/sendInlineCompletion force
  // reasoningSelect.disabled = true themselves for the duration and restore
  // it (via this same function) once streaming ends; touching it here too
  // would just re-enable it mid-stream.
  if (!streaming) updateReasoningAvailability(provider);
  updatePublishButton();
  updateInlineCompleteButton();
  updateInlineThreadButton();
  updateExportPdfButton();
  updateDefaultModelButton();
  // The "no provider configured" warning lives in the toolbar row too, and
  // it's this function that shows/hides it - so the row's own visibility has
  // to be re-evaluated here as well, not just when the document changes.
  updateEditorToolbarVisibility();
}

const REASONING_LEVEL_KEYS = {
  none: "editor.reasoningNone",
  minimal: "editor.reasoningMinimal",
  low: "editor.reasoningLow",
  medium: "editor.reasoningMedium",
  high: "editor.reasoningHigh",
  xhigh: "editor.reasoningXhigh",
  max: "editor.reasoningMax",
};

// Only some models honor a reasoning level at all, and the ones that do
// don't all take the same levels (gpt-5 has "minimal" where gpt-5.1 has
// "none"; only newer models take "xhigh"/"max"; gpt-5.2-pro starts at
// "medium") - sending one a model doesn't have is a 400, not a silently
// ignored parameter. So the options are rebuilt from whatever the backend
// says this exact model accepts (see LLMProvider.reasoning_efforts: real
// capability lookup for Anthropic, a per-model-id table for OpenAI), with
// the selector disabled entirely for a model that doesn't reason.
//
// "Off" is always offered and is this app's own choice, not a level: it
// sends no reasoning setting at all, leaving the model on its own default
// (which is *not* always "don't think" - gpt-5.6's default is medium,
// which is exactly why "none" is offered separately where it exists).
function updateReasoningAvailability(provider) {
  const levels = (provider && provider.reasoning_efforts && provider.reasoning_efforts[el.modelSelect.value]) || null;
  // Rebuilding drops the current selection, so it's restored below if this
  // model offers it too - switching between two models that both support
  // "high" shouldn't silently reset the level that's already chosen.
  const previous = el.reasoningSelect.value;
  el.reasoningSelect.replaceChildren();
  // A level the backend knows about but this build's dictionary doesn't
  // (a new one added server-side) still shows up, just unlocalized,
  // rather than silently disappearing from the selector.
  const levelLabel = (level) => (REASONING_LEVEL_KEYS[level] ? t(REASONING_LEVEL_KEYS[level]) : level);
  // "off" sends no setting, so the model runs at its own default - named
  // here when the backend knows it ("Default (Medium)").
  const fallback = provider && provider.reasoning_defaults && provider.reasoning_defaults[el.modelSelect.value];
  for (const level of ["off", ...(levels || [])]) {
    const option = document.createElement("option");
    option.value = level;
    if (level !== "off") option.textContent = levelLabel(level);
    else option.textContent = fallback ? t("editor.reasoningDefaultIs", { level: levelLabel(fallback) }) : t("editor.reasoningDefault");
    el.reasoningSelect.appendChild(option);
  }
  el.reasoningSelect.disabled = !levels;
  // Assigning a value with no matching <option> leaves .value as "" rather
  // than throwing - which is exactly the "this model doesn't have that
  // level" case, and falls back to "off".
  el.reasoningSelect.value = previous;
  if (!el.reasoningSelect.value) el.reasoningSelect.value = "off";
}

// Publishing shares the same "is this a real document, not a system prompt
// or read-only Hermes transcript" gate as sending (NON_SENDABLE_ROLES) -
// always refreshed alongside it (see updateSendAvailability's call above)
// since both only ever change together with `active`/`streaming`.
function updatePublishButton() {
  const publishable = !!active && !NON_SENDABLE_ROLES.has(active.role);
  el.publishBtn.hidden = !publishable;
  el.publishBtn.disabled = !publishable || streaming;
  const published = !!(active && active.publishToken);
  el.publishLabel.textContent = published ? t("editor.publishing") : t("editor.publish");
  // Also the "copied" tick's way back (see copyLinkWithFeedback, which
  // restores through this function on a timer).
  el.publishIcon.textContent = "🔗";
  // Tooltip on the button itself, so the wording survives on a phone, where
  // the label span is hidden and only the 🔗 icon is left (see .btn-label).
  el.publishBtn.title = el.publishLabel.textContent;
  // Highlighted the same way the save button marks unsaved changes - without
  // it "published" and "not published" look identical in icon-only mode.
  el.publishBtn.classList.toggle("dirty", published);
  // Keeps the "live" checkbox's row visibility and its socket's target
  // channel in sync with whichever document is active and whether it's
  // published - see updateLivePublicTarget's own comment above. Piggy-
  // backing on updatePublishButton (rather than a separate call at every
  // `active = {...}` site) works because both only ever need to change
  // together with `active`/its publishToken.
  updateLivePublicTarget();
}

// Inline completion only makes sense in a draft: an exchange is a finished
// question/answer pair with its own editing story (see detectPendingQuestion),
// and a system prompt or read-only Hermes transcript isn't a place to splice
// generated text into at all. Shown only there, rather than shown-but-disabled
// everywhere, so the editor header stays quiet for every other document.
function updateInlineCompleteButton() {
  const available = !!active && active.role === "draft";
  el.inlineCompleteBtn.hidden = !available;
  el.inlineCompleteBtn.disabled = !available || streaming;
  updateDictationButton();
}

// ---------- dictation (live speech-to-text into the editor) ----------
//
// Engines behind the one 🎤 button:
//   - the browser's own Web Speech API wherever it works - no server round
//     trip, no API key, free, interim results arriving continuously. The
//     audio goes to the browser vendor's recognizer, not to this app.
//     This stays the default. It only hears the microphone, so a file
//     never uses it.
//   - Soniox realtime (soniox-stt.js, stt-rt-v5) when Web Speech does not
//     work, when a file is played with the built-in choice, and whenever
//     the select says so. Needs SONIOX_API_KEY. About $0.12 per hour.
//     The long-lived key stays on the server; the page gets a temporary one.
//   - OpenAI realtime (realtime-stt.js, gpt-live-transcribe) when the
//     select says so, and when Soniox is not configured. About $0.017
//     per minute streamed. Needs OPENAI_API_KEY.
// The icon shows the engine that will actually run, which can differ from
// the remembered choice (built-in on a browser without Web Speech shows
// Soniox). While a file is being transcribed, the icon is that file's engine.
// A quiet microphone hangs up after REALTIME_IDLE_MS on either billed
// engine. Hiding the tab does not: if the browser itself suspends the
// capture, it is opened again when the page is visible. A played file is
// not hung up for silence. The select is shown when more than one engine
// is actually available. The control is hidden only when none is.
//
// Text is written straight into the document at the caret: finalized
// phrases stay, and the phrase still being spoken is shown in place and
// rewritten on every update (dictation.from/interim track that span).
// If the caret moves or the text under that span changes while listening
// *in that document*, the span is abandoned and dictation picks up again
// at the new caret. Another document on screen, or the browser tab being
// hidden, does not stop the session and does not move the caret: the
// words keep landing in the document dictation started in.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
const IOS_NON_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
const WEB_SPEECH_USABLE = !!SpeechRecognitionImpl && !IOS_NON_SAFARI;
// Set from /api/stt/config at startup (see loadRealtimeSttConfig below).
let realtimeSttAvailable = false;
let sonioxSttAvailable = false;
// Until /api/stt/config returns, a remembered Soniox/OpenAI choice must
// stay in the select. Hiding an engine before we know it exists would
// rewrite the value and the next save would forget it.
let sttConfigLoaded = false;
// Remembered choice. The select's value is the engine actually in use,
// which is not always this (a built-in choice with no Web Speech shows Soniox).
let dictationEnginePreference = "builtin";
// Realtime *microphone* dictation stops itself after this long without
// hearing anything - the cost guard. A file being played does not use it.
const REALTIME_IDLE_MS = 3 * 60 * 1000;

function dictationSupported() {
  return WEB_SPEECH_USABLE || realtimeSttAvailable || sonioxSttAvailable;
}

function dictationEngineArgs(kind) {
  return {
    stored: dictationEnginePreference,
    webSpeech: WEB_SPEECH_USABLE,
    openai: realtimeSttAvailable,
    soniox: sonioxSttAvailable,
    kind,
  };
}

// Microphone: the remembered choice, with Web Speech as the default where
// it works. A file never uses Web Speech — a built-in choice uses Soniox
// when that key exists, and OpenAI otherwise.
function chosenEngine(kind = "mic") {
  return resolveDictationEngine(dictationEngineArgs(kind));
}

function effectiveEngine() {
  return effectiveDictationEngine({
    stored: dictationEnginePreference,
    webSpeech: WEB_SPEECH_USABLE,
    openai: realtimeSttAvailable,
    soniox: sonioxSttAvailable,
    fileRunning: !!(dictation && dictation.file),
  });
}

function engineHintKey(engine, button) {
  if (engine === "soniox") return button ? "editor.dictationSonioxTitle" : "editor.dictationEngineSoniox";
  if (engine === "openai") return button ? "editor.dictationRealtimeTitle" : "editor.dictationEngineRealtime";
  return button ? "editor.dictationTitle" : "editor.dictationEngineBuiltin";
}

function fileDictationAvailable() {
  return !!chosenEngine("file");
}

function dictationTitleKey() {
  return engineHintKey(effectiveEngine(), true);
}

// Hide engines whose key (or Web Speech) is missing. A remembered Soniox
// choice is left in localStorage when Soniox isn't configured; the select
// shows the engine that will actually run, without saving over the memory.
function syncDictationEngineOptions() {
  if (!sttConfigLoaded) {
    el.dictationEngine.hidden = true;
    return;
  }
  const offered = enginesOffered({ webSpeech: WEB_SPEECH_USABLE, openai: realtimeSttAvailable, soniox: sonioxSttAvailable });
  for (const opt of el.dictationEngine.options) {
    const on = offered.includes(opt.value);
    opt.hidden = !on;
    opt.disabled = !on;
  }
  const shown = effectiveEngine();
  if (shown && offered.includes(shown)) el.dictationEngine.value = shown;
  el.dictationEngine.title = t(shown ? engineHintKey(shown, false) : "editor.dictationEngineTitle");
  el.dictationEngine.hidden = offered.length < 2;
}

async function loadRealtimeSttConfig() {
  try {
    const res = await fetch("/api/stt/config");
    if (res.ok) {
      const body = await res.json();
      realtimeSttAvailable = !!(body.openai ?? body.available);
      sonioxSttAvailable = !!body.soniox;
    }
  } catch (err) {
    realtimeSttAvailable = false;
    sonioxSttAvailable = false;
  }
  sttConfigLoaded = true;
  updateDictationButton();
}

// Spoken phrases (the left column) go to Soniox as context terms so the
// recognizer expects them. The symbol column is still applied afterwards.
async function spokenMathTerms() {
  try {
    const { content } = await api.getSpokenMath();
    return limitContextTerms(spokenPhrasesFromCsv(content));
  } catch (err) {
    return [];
  }
}
const DICTATION_LANG_KEY = "mark-vector:dictation-lang";
const DICTATION_NETWORK_RETRIES = 5;
const DICTATION_LANG_BY_UI = { ko: "ko-KR", en: "en-US", ja: "ja-JP" };
const DICTATION_ENGINE_KEY = "mark-vector:dictation-engine";
const DICTATION_RECORD_KEY = "mark-vector:dictation-record";

// null while idle. `target` is the `active` object dictation started on -
// switching documents (a new `active`) stops it rather than typing into
// whatever document happens to be open next.
let dictation = null;
let discussionPane = null;
let discussAwake = false;

function setDiscussAwake(on) {
  discussAwake = on;
  if (on) keepScreenOn(true);
  else if (!dictation) keepScreenOn(false);
}

function restoreDictationLang() {
  let stored = null;
  try {
    stored = localStorage.getItem(DICTATION_LANG_KEY);
  } catch (err) {
    stored = null;
  }
  const options = [...el.dictationLang.options].map((o) => o.value);
  el.dictationLang.value = options.includes(stored) ? stored : DICTATION_LANG_BY_UI[getLanguage()] || "en-US";
}

function restoreDictationEngine() {
  let stored = null;
  try {
    stored = localStorage.getItem(DICTATION_ENGINE_KEY);
  } catch (err) {
    stored = null;
  }
  dictationEnginePreference = normalizeStoredEngine(stored);
}

function saveDictationEngine() {
  try {
    localStorage.setItem(DICTATION_ENGINE_KEY, dictationEnginePreference);
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function saveDictationLang() {
  try {
    localStorage.setItem(DICTATION_LANG_KEY, el.dictationLang.value);
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

// ---------- recording while dictating (see recording.js) ----------
// The ⏺ toggle beside the dictation controls (remembered per browser):
// while it's on, dictating also records the microphone into the document's
// folder on the server. The realtime engine's own microphone stream is
// recorded; the built-in engine listens on its own, so a second stream is
// opened for the recorder. While dictating, the screen is kept on (a
// locked phone stops the page, its microphone and with it the recording).
// ---------- microphone choice ----------
// Which microphone dictation and recording open - the system default
// unless one is picked from the 🎙 menu (in the ⚙ row). Kept per browser by label as well
// as id: Safari hands out a fresh device id now and then, while "DJI Mic
// Mini" stays "DJI Mic Mini". The built-in (Web Speech) engine can't be
// pointed at a microphone - it always hears the system default - so there
// the choice reaches only the recording.
const DICTATION_MIC_KEY = "mark-vector:dictation-mic";
// The billed engines' microphone. Processing stays off, and a multichannel
// device is asked for all of its channels: echo cancellation deletes a
// BlackHole loopback, and the default stereo fold then keeps an empty pair.
// See mic-capture.mjs. Called per open so the browser's supported
// constraints (voice isolation) are known.
let micChoice = null; // { deviceId, label } | null for the system default
let micDevices = []; // the last enumerateDevices() audio inputs

function restoreMicChoice() {
  try {
    const stored = JSON.parse(localStorage.getItem(DICTATION_MIC_KEY) || "null");
    micChoice = stored && stored.deviceId ? stored : null;
  } catch (err) {
    micChoice = null;
  }
}

function saveMicChoice() {
  try {
    if (micChoice) localStorage.setItem(DICTATION_MIC_KEY, JSON.stringify(micChoice));
    else localStorage.removeItem(DICTATION_MIC_KEY);
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

// The picked microphone as it's connected now - by id, else by label -
// or null (none picked, or it isn't plugged in).
function chosenMic() {
  if (!micChoice) return null;
  return micDevices.find((d) => d.deviceId === micChoice.deviceId) || micDevices.find((d) => d.label && d.label === micChoice.label) || null;
}

// getUserMedia's audio constraints: `base` plus the picked microphone.
function micConstraints(base) {
  const mic = chosenMic();
  return mic ? { ...base, deviceId: { exact: mic.deviceId } } : base;
}

async function refreshMicDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    micDevices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  } catch (err) {
    micDevices = [];
  }
  updateMicButton();
}

function updateMicButton() {
  const btn = el.dictationMicBtn;
  btn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) || !dictationSupported();
  const mic = chosenMic();
  btn.classList.toggle("chosen", !!micChoice);
  btn.classList.toggle("missing", !!micChoice && !mic);
  const name = micChoice ? micChoice.label || "?" : t("editor.micDefault");
  btn.textContent = `🎙 ${name}`;
  btn.title = t(micChoice && !mic ? "editor.micMissingTitle" : "editor.micTitle", { name });
}

async function openMicMenu() {
  // Until the page has been allowed the microphone, the browser lists
  // devices without names - ask once, briefly, so the menu can say which is which.
  if (!micDevices.length || micDevices.every((d) => !d.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      // denied - the menu still offers the default
    }
  }
  await refreshMicDevices();
  const current = chosenMic();
  const pick = (device) => {
    micChoice = device ? { deviceId: device.deviceId, label: device.label } : null;
    saveMicChoice();
    updateMicButton();
    if (device && chosenEngine("mic") === "builtin") showRemoteStatus(t("editor.micBuiltinNote"));
    // Like a language change: a running dictation starts over on the new one.
    if (dictation) {
      stopDictation();
      startDictation();
    }
  };
  openRowMenu(el.dictationMicBtn, [
    { icon: current || micChoice ? "" : "✓", label: t("editor.micDefault"), onSelect: () => pick(null) },
    ...micDevices.map((device, i) => ({
      icon: current && current.deviceId === device.deviceId ? "✓" : "",
      label: device.label || t("editor.micUnnamed", { n: i + 1 }),
      onSelect: () => pick(device),
    })),
    ...(fileDictationAvailable() ? ["-", { icon: "🎵", label: t("editor.audioFile"), onSelect: pickAudioFile }] : []),
  ]);
}

// ---------- audio file ----------
// 🎙 menu > "Play an audio file…": the file plays on the page, and what it
// plays is what the realtime engine transcribes instead of the microphone -
// heard and written down at the caret as it goes, so Evaluate's live mode
// checks it like any lecture. ▶ starts a dictation session on the file
// (the click is the gesture iOS wants for both the AudioContext and the
// player). ⏸ pauses the player and finalizes the phrase heard so far;
// ▶ again clears the gap and keeps the same session, so the next words
// append. Seeking does both. Nothing about a file uses the microphone's
// three-minute silence hangup. Nothing is recorded: the file is the recording.
const AUDIO_FILE_RATES = [1, 1.25, 1.5];
// Once the file ends, how long the last phrase gets to come back written.
const AUDIO_FILE_TAIL_MS = 4000;
let audioFile = null; // { name, url, position, duration, rate } while one is loaded
// A typed time submitted before the file's length is known. Applied once
// the probe learns the duration, still through seekFileTo.
let audioGotoPending = null;

function pickAudioFile() {
  const input = document.createElement("input");
  input.type = "file";
  // iOS greys some audio files out of the Files picker under a bare
  // "audio/*" (an .m4a among them), so the extensions are named as well.
  input.accept = "audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac,.webm,.mp4,.mov";
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    loadAudioFile(file.name, URL.createObjectURL(file), true);
  });
  input.click();
}

// `owned`: a blob URL made for it, released with it. A recording's URL
// (see the recordings list's "transcribe while playing") isn't.
function loadAudioFile(name, url, owned) {
  closeAudioFile();
  // `loading`: the length isn't known yet - for a recording, the server is
  // still making its playable copy (a long one takes a while), so the bar
  // says so. `buffering`: playing, but waiting on data.
  audioFile = { name, url, owned, position: 0, duration: 0, rate: 1, loading: true, buffering: false, error: null };
  const current = audioFile;
  // Just for its length, before anything plays.
  const probe = new Audio();
  probe.preload = "metadata";
  probe.addEventListener("loadedmetadata", () => {
    current.loading = false;
    if (Number.isFinite(probe.duration)) current.duration = probe.duration;
    if (audioFile !== current) return;
    updateAudioFileBar();
    // A "go to" typed before the length arrived jumps now, through the
    // same seek as the slider.
    if (audioGotoPending == null) return;
    const pending = audioGotoPending;
    audioGotoPending = null;
    finishAudioFileGoto(pending);
  }, { once: true });
  probe.addEventListener("error", () => {
    current.loading = false;
    current.error = t("editor.audioFileLoadFailed");
    const waiting = audioGotoPending != null;
    audioGotoPending = null;
    if (audioFile !== current) return;
    updateAudioFileBar();
    if (!waiting) return;
    el.audioFileGotoError.hidden = false;
    el.audioFileGotoError.textContent = current.error;
    el.audioFileGoto.setAttribute("aria-invalid", "true");
  }, { once: true });
  probe.src = url;
  updateAudioFileBar();
}

function closeAudioFile() {
  if (dictation && dictation.file) stopDictation();
  if (audioFile && audioFile.owned) URL.revokeObjectURL(audioFile.url);
  audioFile = null;
  audioGotoPending = null;
  el.audioFileGoto.value = "";
  clearAudioGotoError();
  updateAudioFileBar();
}

// The player of the dictation session on the file, if one is running.
const audioFilePlayer = () => (dictation && dictation.file ? dictation.file.audio : null);

function updateAudioFileBar() {
  el.audioFileBar.hidden = !audioFile || !active;
  if (!audioFile) return;
  const player = audioFilePlayer();
  const playing = !!player && !player.paused;
  const osReleased = !!(dictation && dictation.file && dictation.file.osReleased) && !playing;
  el.audioFilePlayBtn.textContent = playing ? "⏸" : "▶";
  el.audioFilePlayBtn.classList.toggle("resume-needed", osReleased);
  // What ▶ will use, including a built-in choice that falls through to a
  // paid engine. Follows the select and which keys the server reported.
  const fileEngine = chosenEngine("file");
  const notice = t(fileEngineNoticeKey(fileEngine));
  const detail = t(fileEngineDetailKey(fileEngine));
  if (el.audioFileEngine.textContent !== notice) el.audioFileEngine.textContent = notice;
  el.audioFileEngine.title = detail;
  el.audioFilePlayBtn.title = playing ? t("editor.audioFilePause") : osReleased ? t("editor.audioFileInterrupted") : detail;
  el.audioFilePlayBtn.disabled = !playing && !dictationUsable() && !player;
  el.audioFileName.textContent = audioFile.name;
  el.audioFileName.title = detail;
  el.audioFileSeek.max = String(audioFile.duration || 0);
  el.audioFileSeek.value = String(audioFile.position);
  el.audioFileSeek.disabled = !audioFile.duration;
  const clock = `${formatPlaybackClock(audioFile.position)} / ${audioFile.duration ? formatPlaybackClock(audioFile.duration) : "--:--"}`;
  const withResume = osReleased ? `${clock} · ${t("editor.audioFileResume")}` : clock;
  el.audioFileGoto.setAttribute("aria-label", t("audio.gotoTitle"));
  el.audioFileTime.textContent = audioFile.error
    ? audioFile.error
    : audioFile.loading
      ? t("recordings.preparing")
      : audioFile.buffering
        ? `${clock} · ${t("editor.audioFileBuffering")}`
        : withResume;
  el.audioFileRateBtn.textContent = `${audioFile.rate}×`;
}

el.audioFilePlayBtn.addEventListener("click", () => {
  if (!audioFile) return;
  const player = audioFilePlayer();
  if (player) {
    const ctx = dictation && dictation.audioContext;
    // Playing, but the graph is still interrupted: this tap is the gesture
    // that makes sound come back. Pausing would leave it silent.
    if (!player.paused && ctx && audioContextNeedsResume(ctx.state)) {
      // The file is still playing; only the tap graph went quiet. Waking
      // it while the platform has the session would take the mic back.
      if (readAudioSessionState() === "interrupted") return;
      ctx.resume().catch(() => {});
      ensureSilentKeeper(dictation);
      syncFileTap(dictation);
      return;
    }
    if (player.paused) resumeFilePlayback(dictation);
    else pauseFilePlayback(dictation);
    return;
  }
  // Dictating from the microphone: the file takes over.
  if (dictation) stopDictation();
  const fileEngine = chosenEngine("file");
  if (!fileEngine || !dictationUsable()) return;
  startBilledDictation(audioFile, fileEngine);
  if (dictation) keepScreenOn(true);
});
el.audioFileSeek.addEventListener("input", () => {
  if (!audioFile) return;
  seekFileTo(Number(el.audioFileSeek.value));
});
// ↺10 / 10↻: ten seconds back or ahead - playing or not.
const AUDIO_FILE_SKIP_S = 10;
function skipAudioFile(seconds) {
  if (!audioFile) return;
  const end = audioFile.duration || Infinity;
  seekFileTo(Math.min(Math.max(0, audioFile.position + seconds), end));
}
el.audioFileBackBtn.addEventListener("click", () => skipAudioFile(-AUDIO_FILE_SKIP_S));
el.audioFileForwardBtn.addEventListener("click", () => skipAudioFile(AUDIO_FILE_SKIP_S));
// Typed time. Same seekFileTo as the slider and the 10-second skips, so a
// transcription in progress commits the phrase and does not write the gap.
function clearAudioGotoError() {
  el.audioFileGotoError.hidden = true;
  el.audioFileGotoError.textContent = "";
  el.audioFileGotoError.classList.remove("waiting");
  el.audioFileGoto.removeAttribute("aria-invalid");
}
function showAudioGotoError(reason) {
  el.audioFileGotoError.hidden = false;
  el.audioFileGotoError.textContent = t(PLAYBACK_JUMP_MESSAGE[reason] || PLAYBACK_JUMP_MESSAGE.invalid);
  const waiting = reason === "loading";
  el.audioFileGotoError.classList.toggle("waiting", waiting);
  if (waiting) el.audioFileGoto.removeAttribute("aria-invalid");
  else el.audioFileGoto.setAttribute("aria-invalid", "true");
}
function finishAudioFileGoto(seconds) {
  if (!audioFile) return;
  if (audioFile.error) {
    el.audioFileGotoError.hidden = false;
    el.audioFileGotoError.textContent = audioFile.error;
    el.audioFileGoto.setAttribute("aria-invalid", "true");
    return;
  }
  const duration = audioFile.duration > 0 ? audioFile.duration : null;
  const jump = playbackJump(seconds, duration);
  if (!jump.ok) {
    audioGotoPending = jump.reason === "loading" ? seconds : null;
    showAudioGotoError(jump.reason);
    return;
  }
  audioGotoPending = null;
  clearAudioGotoError();
  seekFileTo(jump.seconds);
  el.audioFileGoto.blur();
}
el.audioFileGoto.addEventListener("input", () => {
  audioGotoPending = null;
  clearAudioGotoError();
});
el.audioFileGotoForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = parsePlaybackTime(el.audioFileGoto.value);
  if (parsed == null) {
    audioGotoPending = null;
    showAudioGotoError("invalid");
    return;
  }
  finishAudioFileGoto(parsed);
});
el.audioFileRateBtn.addEventListener("click", () => {
  if (!audioFile) return;
  audioFile.rate = AUDIO_FILE_RATES[(AUDIO_FILE_RATES.indexOf(audioFile.rate) + 1) % AUDIO_FILE_RATES.length];
  const player = audioFilePlayer();
  if (player) player.playbackRate = audioFile.rate;
  if (dictation && dictation.file) syncFileTap(dictation);
  updateAudioFileBar();
});
el.audioFileCloseBtn.addEventListener("click", closeAudioFile);

let recordWithDictation = false;

function restoreDictationRecord() {
  try {
    recordWithDictation = localStorage.getItem(DICTATION_RECORD_KEY) === "1";
  } catch (err) {
    recordWithDictation = false;
  }
}

function formatClock(ms) {
  return formatPlaybackClock(ms / 1000);
}

function updateRecordButton(progress) {
  const btn = el.dictationRecordBtn;
  btn.hidden = !recordingSupported();
  const fileSession = !!(dictation && dictation.file);
  const recording = !!(dictation && dictation.recording);
  // A file session never records. The saved preference stays as it is;
  // only the dot is painted off, and the control won't take a click.
  const view = recordControlState({ fileSession, recordWithDictation, recording });
  if (view.ariaDisabled) btn.setAttribute("aria-disabled", "true");
  else btn.removeAttribute("aria-disabled");
  btn.setAttribute("aria-pressed", view.pressed ? "true" : "false");
  btn.classList.toggle("recording", view.showRecording);
  if (!view.showRecording) {
    btn.innerHTML = '<span class="rec-dot"></span>';
    btn.classList.remove("behind");
    btn.title = t(view.titleKey);
    return;
  }
  if (!progress) return;
  // Behind: pieces waiting on a failed upload (they're retried).
  const behind = !!progress.error && progress.pending > 0;
  btn.classList.toggle("behind", behind);
  // Just the time - the red button already says it's recording, and the
  // header row has no room to spare on a phone.
  btn.textContent = formatClock(progress.elapsedMs);
  btn.title = behind ? t("editor.recordingBehind", { kb: Math.round(progress.pending / 1024), message: progress.error }) : t("editor.recordingOn");
}

// `ownsStream`: the stream was opened just for this, and goes with it.
async function startDictationRecording(session, stream, ownsStream) {
  const doc = { projectId: session.target.projectId, sessionId: session.target.sessionId, filename: session.target.filename };
  try {
    const handle = await startRecording(stream, doc, (progress) => dictation === session && updateRecordButton(progress));
    if (dictation !== session) {
      handle.stop().finally(() => ownsStream && stream.getTracks().forEach((track) => track.stop()));
      return;
    }
    session.recording = { handle, stream, ownsStream, doc };
    updateRecordButton({ elapsedMs: 0, pending: 0, error: null });
  } catch (err) {
    if (ownsStream) stream.getTracks().forEach((track) => track.stop());
    showRemoteStatus(t("editor.recordingFailed", { message: err.message }));
  }
}

function stopDictationRecording(session) {
  const recording = session.recording;
  if (!recording) return;
  session.recording = null;
  recording.handle.stop().then(async (result) => {
    if (recording.ownsStream) recording.stream.getTracks().forEach((track) => track.stop());
    showRemoteStatus(
      result && result.videoError
        ? t("editor.recordingVideoQueueFailed", { message: result.videoError })
        : result && result.queued
          ? t("editor.recordingQueued")
          : t("editor.recordingSaved")
    );
    const { projectId, sessionId } = recording.doc;
    await refreshSessionDocs(projectId, sessionId).catch(() => {});
    renderTree();
  });
}

let wakeLock = null;
async function keepScreenOn(on) {
  if (!on) {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) lock.release().catch(() => {});
    return;
  }
    if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
    if (!dictation && !discussAwake) keepScreenOn(false);
  } catch (err) {
    // not allowed right now (page hidden, low battery) - tried again on return
  }
}

function dictationUsable() {
  return !!active && !streaming && !el.editor.disabled;
}

// Where the running session is allowed to write. Compared by document ref:
// stashing a tab copies `active`, so object identity would look like a
// different document even after coming back.
function dictationDestination() {
  if (!dictation || !dictation.targetRef) return { stop: false, where: "editor", index: currentTab };
  return transcriptDestination({
    tabs,
    activeRef: activeDocRef(),
    targetRef: dictation.targetRef,
    same: sameDocRef,
  });
}

function dictationStopReason() {
  if (!dictation || !dictation.targetRef) return "none";
  const dest = dictationDestination();
  if (dest.stop) return "closed";
  // Busy only counts for the document on screen. A send in some other tab
  // must not hang up a transcript that's landing in a stash.
  if (dest.where === "editor" && !dictationUsable()) return "editor-busy";
  return "none";
}

function dictationKind() {
  return dictation && dictation.file ? "file" : "mic";
}

// Called synchronously when a tab switch starts, before any await, so a
// phrase that arrives while the next document loads stays on the original.
function holdDictationOn(nextRef) {
  if (!dictation || !dictation.targetRef) return;
  if (!sameDocRef(dictation.targetRef, nextRef)) dictation.writeStash = true;
}

function releaseDictationIfHome() {
  if (!dictation || !dictation.targetRef) return;
  if (sameDocRef(dictation.targetRef, activeDocRef())) dictation.writeStash = false;
}

function stopDictationIfDocumentGone() {
  if (!dictation || !dictation.targetRef) return;
  if (sessionStops(dictationKind(), dictationDestination().stop ? "closed" : "none")) stopDictation();
}

function syncDictationWriteTarget() {
  if (!dictation || !dictation.targetRef || openingTab) return;
  const dest = dictationDestination();
  if (!dest.stop) dictation.writeStash = dest.where === "stash";
}

function dictationStillRunning(session) {
  if (dictation !== session) return false;
  if (sessionStops(dictationKind(), dictationStopReason())) {
    stopDictation();
    return false;
  }
  syncDictationWriteTarget();
  return true;
}

function updateDictationButton() {
  el.dictationGroup.hidden = !dictationSupported() || !active;
  updateMicButton();
  syncDictationEngineOptions();
  el.dictationBtn.disabled = !dictationUsable() && !dictation;
  if (dictation && sessionStops(dictationKind(), dictationStopReason())) stopDictation();
  else syncDictationWriteTarget();
  // A file session is still "on" (click stops it) but the microphone is
  // closed, so it does not get the red pulsing mic.
  const view = dictationControlState({ active: !!dictation, file: !!(dictation && dictation.file) });
  el.dictationBtn.title = t(view.titleKey || dictationTitleKey());
  el.dictationBtn.classList.toggle("listening", view.listening);
  el.dictationBtn.classList.toggle("transcribing-file", view.transcribingFile);
  el.dictationBtn.setAttribute("aria-pressed", view.pressed ? "true" : "false");
  const icon = el.dictationBtn.querySelector(".btn-icon");
  if (icon) icon.textContent = view.icon;
  el.dictationLabel.textContent = t(view.labelKey);
  updateRecordButton();
  updateAudioFileBar();
}

// The document dictation is writing into. On screen that's the editor.
// Anywhere else it's that tab's stash - never the document the user just opened.
let stashAutosaveTimer = null;

function scheduleStashAutosave(ref, stash) {
  clearTimeout(stashAutosaveTimer);
  stashAutosaveTimer = setTimeout(() => {
    if (!ref || ref.role === "hermes-session") return;
    const key = `mark-vector:autosave:${JSON.stringify(ref)}`;
    try {
      if (stash.content === stash.active.savedContent) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ content: stash.content, savedAt: Date.now() }));
    } catch (err) {
      // localStorage unavailable - the on-screen draft's own net is unaffected
    }
  }, AUTOSAVE_DEBOUNCE_MS);
}

function dictationBuffer() {
  if (!dictation || !dictation.writeStash) return editorDictationBuffer();
  const dest = dictationDestination();
  const tab = dest.index >= 0 ? tabs[dest.index] : null;
  if (!tab || !tab.stash) return null;
  return stashDictationBuffer(tab.stash, tab.ref);
}

function editorDictationBuffer() {
  return {
    detached: false,
    get value() {
      return el.editor.value;
    },
    get selectionStart() {
      return el.editor.selectionStart;
    },
    get selectionEnd() {
      return el.editor.selectionEnd;
    },
    replaceRange(from, to, text) {
      replaceEditorRange(from, to, text);
    },
    replaceRangeKeepingSelection(from, to, text) {
      el.editor.replaceRangeKeepingSelection(from, to, text);
      updateFilenameLabel();
      updateFormatToolbar();
      renderPreview();
    },
    setSelectionRange(start, end) {
      el.editor.setSelectionRange(start, end);
    },
  };
}

function stashDictationBuffer(stash, ref) {
  const mapSelection = (from, to, text) => {
    const delta = text.length - (to - from);
    const map = (pos) => (pos <= from ? pos : pos >= to ? pos + delta : from + text.length);
    stash.selectionStart = map(stash.selectionStart);
    stash.selectionEnd = map(stash.selectionEnd);
  };
  return {
    detached: true,
    get value() {
      return stash.content;
    },
    get selectionStart() {
      return stash.selectionStart;
    },
    get selectionEnd() {
      return stash.selectionEnd;
    },
    replaceRange(from, to, text) {
      stash.content = stash.content.slice(0, from) + text + stash.content.slice(to);
      stash.selectionStart = stash.selectionEnd = from + text.length;
      scheduleStashAutosave(ref, stash);
      renderTabs();
    },
    replaceRangeKeepingSelection(from, to, text) {
      mapSelection(from, to, text);
      stash.content = stash.content.slice(0, from) + text + stash.content.slice(to);
      scheduleStashAutosave(ref, stash);
      renderTabs();
    },
    setSelectionRange(start, end) {
      stash.selectionStart = start;
      stash.selectionEnd = end;
    },
  };
}

// A space between the new text and whatever precedes it, unless it starts
// a line or already follows whitespace. Japanese isn't space-separated, so
// it never gets one.
function dictationSeparator(pos, value) {
  if (pos === 0 || el.dictationLang.value.startsWith("ja")) return "";
  const prev = value[pos - 1];
  return /\s/.test(prev) ? "" : " ";
}

// Keeps dictation.from/interim honest against edits made while listening
// in the document being dictated. Edits in some other document on screen
// don't move the anchor - that text isn't this transcript.
function reanchorDictation(buf) {
  const d = dictation;
  if (!buf || buf.detached) return;
  const value = buf.value;
  const { selectionStart, selectionEnd } = buf;
  const end = d.from + d.interim.length;
  const intact = value.slice(d.from, end) === d.interim;
  if (intact && selectionStart === end && selectionEnd === end) return;
  if (intact && d.interim) {
    // Drop the half-spoken phrase from where it was; its final version
    // will be written at the new caret instead.
    buf.replaceRange(d.from, end, "");
    const shift = selectionStart >= end ? d.interim.length : 0;
    d.from = Math.max(0, selectionStart - shift);
    buf.setSelectionRange(d.from, d.from);
  } else {
    d.from = selectionStart;
  }
  d.interim = "";
}

// Inside a $$ block, dictation is a formula: spoken Korean math becomes
// AsciiMath (see asciimath-markdown's spoken-math.js). AsciiMath only renders as such in a document
// whose math is AsciiMath, so a document that would read it as LaTeX gets
// the directive added at the top - as long as nothing else in it is math
// yet. One that already holds LaTeX math (or says so explicitly) gets plain
// dictation instead. Returns whether this position takes a formula.
const ASCIIMATH_DIRECTIVE = "<!-- math: asciimath -->\n\n";

function prepareMathDictation(pos, buf) {
  const value = buf.value;
  const before = value.slice(0, pos);
  if (!insideMathBlock(pos, value)) return false;
  const target = dictation && dictation.target;
  const format = buf.detached
    ? detectMathDirective(value) || sessionMathDialect(target && target.projectId, target && target.sessionId)
    : currentDocumentFormat();
  if (format !== "latex") return true;
  if (detectMathDirective(value)) return false;
  const close = value.indexOf("$$", pos);
  const elsewhere = value.slice(0, before.lastIndexOf("$$")) + (close === -1 ? "" : value.slice(close + 2));
  if (/\$|\\\(|\\\[/.test(elsewhere)) return false;
  if (buf.detached) {
    buf.replaceRangeKeepingSelection(0, 0, ASCIIMATH_DIRECTIVE);
    if (dictation) dictation.from += ASCIIMATH_DIRECTIVE.length;
  } else {
    spliceKeepingCaret(0, 0, ASCIIMATH_DIRECTIVE);
  }
  return true;
}

// Spoken block commands ("수식시작" / "수식끝" - rules whose symbol is $$,
// see asciimath-markdown's spoken-math.js) split a finished phrase: what came before is written
// where dictation was, the block is opened or left, and the rest is written
// at the new position. A command still being spoken isn't shown at all.
function writeDictation(finalText, interimText) {
  const d = dictation;
  const buf = dictationBuffer();
  if (!buf) return;
  reanchorDictation(buf);
  interimText = splitMathBlockCommands(interimText).join(" ");
  const parts = splitMathBlockCommands(finalText);
  if (parts.length === 1) {
    writeDictationText(finalText, interimText, buf);
    return;
  }
  // Drop the phrase-in-progress span first; the pieces are written fresh.
  if (d.interim) {
    buf.replaceRange(d.from, d.from + d.interim.length, "");
    d.interim = "";
  }
  parts.forEach((part, i) => {
    if (i > 0) {
      d.from = toggleMathBlockAt(d.from, buf);
      buf.setSelectionRange(d.from, d.from);
    }
    writeDictationText(part, "", buf);
  });
  writeDictationText("", interimText, buf);
}

function writeDictationText(finalText, interimText, buf) {
  const d = dictation;
  if (!buf) return;
  // A formula can say "next line" (a rule whose symbol is \n), so there
  // only spaces are trimmed - a line break at either end is kept, and needs
  // no space in front of it.
  const math = prepareMathDictation(d.from, buf);
  if (math) {
    finalText = spokenMathToAsciiMath(finalText);
    interimText = spokenMathToAsciiMath(interimText);
  } else if (d.engine === "webspeech") {
    // The realtime engine punctuates on its own; the built-in one doesn't.
    finalText = punctuateSpeech(finalText, el.dictationLang.value);
    interimText = punctuateSpeech(interimText, el.dictationLang.value, { final: false });
  }
  const tidy = (text) => (math ? text.replace(/^ +| +$/g, "") : text.trim());
  const end = d.from + d.interim.length;
  const value = buf.value;
  let insert = "";
  if (tidy(finalText)) {
    const text = tidy(finalText);
    insert += (/^[\n.,?!。、？！]/.test(text) ? "" : dictationSeparator(d.from, value)) + text;
  }
  const committedEnd = d.from + insert.length;
  let interim = "";
  if (tidy(interimText)) {
    const text = tidy(interimText);
    // Separator judged against what the final text above will leave behind.
    const before = insert ? insert[insert.length - 1] : committedEnd > 0 ? value[d.from - 1] : "\n";
    const sep = el.dictationLang.value.startsWith("ja") || /\s/.test(before) || committedEnd === 0 || /^[\n.,?!。、？！]/.test(text) ? "" : " ";
    interim = sep + text;
  }
  if (!insert && !interim && !d.interim) return;
  // Dictating in front of existing text: keep a space between the two. The
  // space sits after `committedEnd`, so the next phrase still goes before it.
  const next = value[end];
  const trailing = insert && !interim && next && !/\s/.test(next) && !el.dictationLang.value.startsWith("ja") ? " " : "";
  buf.replaceRange(d.from, end, insert + interim + trailing);
  if (trailing) buf.setSelectionRange(committedEnd, committedEnd);
  d.from = committedEnd;
  d.interim = interim;
}

function startDictation() {
  if (dictation || !dictationUsable() || !dictationSupported()) return;
  if (discussionPane && discussionPane.listening()) discussionPane.stop();
  // Picks up math vocabulary saved from another browser since this page
  // loaded - in the background, the first phrase won't wait for it.
  api.getSpokenMath().then(({ content }) => setSpokenMathVocabulary(parseSpokenMathCsv(content))).catch(() => {});
  const engine = chosenEngine("mic");
  if (engine === "openai" || engine === "soniox") startBilledDictation(null, engine);
  else startWebSpeechDictation();
  if (!dictation) return;
  keepScreenOn(true);
  // The built-in engine doesn't share its microphone - the recorder gets
  // its own stream. (The realtime engine's comes once it's connected.)
  const session = dictation;
  if (recordWithDictation && recordingSupported() && session.engine === "webspeech") {
    navigator.mediaDevices
      .getUserMedia({ audio: micConstraints(RECORDING_AUDIO) })
      .then((stream) => {
        if (dictation !== session) stream.getTracks().forEach((track) => track.stop());
        else startDictationRecording(session, stream, true);
      })
      .catch((err) => showRemoteStatus(t("editor.recordingFailed", { message: err.message })));
  }
}

function startWebSpeechDictation() {
  const transcript = createWebSpeechTranscript();
  const session = {
    engine: "webspeech",
    recognition: null,
    target: active,
    targetRef: activeDocRef(),
    writeStash: false,
    from: el.editor.selectionStart,
    interim: "",
    error: null,
    networkRetries: 0,
    startFailures: 0,
    recognitionSuspended: false,
    userStopped: false,
    restartTimer: null,
    // abort(), not stop(): stop() would still deliver one last "result"
    // after this point, into a session that's already been let go.
    stop: () => {},
  };
  session.stop = () => {
    session.userStopped = true;
    clearTimeout(session.restartTimer);
    session.restartTimer = null;
    try {
      session.recognition && session.recognition.abort();
    } catch (err) {
      // already ended
    }
  };
  dictation = session;
  session.micOwned = true;
  beginMicSession();
  // Replace a selection, the way typing would.
  if (el.editor.selectionEnd > el.editor.selectionStart) {
    replaceEditorRange(el.editor.selectionStart, el.editor.selectionEnd, "");
  }

  // The half-spoken phrase is still in the editor, tracked by session.interim.
  // Leaving that span in place and clearing the tracker makes the next
  // result land after it, so the words appear twice. Drop the span; a final
  // that already landed stays.
  const discardInterim = () => {
    if (dictation !== session || !session.interim) return;
    writeDictation("", "");
  };

  const failDictation = (decision) => {
    const denied = decision && decision.denied;
    const message = (decision && decision.message) || "error";
    stopDictation();
    alert(denied ? t("editor.dictationDenied") : t("editor.dictationFailed", { message }));
  };

  const arm = (recognition) => {
    recognition.lang = el.dictationLang.value;
    recognition.continuous = true;
    recognition.interimResults = true;
    let settled = false;
    const finish = () => {
      if (settled || dictation !== session || session.recognition !== recognition || session.userStopped) return;
      settled = true;
      const decision = webSpeechAfterEnd({
        stopped: false,
        hidden: captureInterrupted(document.hidden) === "resume-when-visible",
        error: session.error,
        networkRetries: session.networkRetries,
        maxNetworkRetries: DICTATION_NETWORK_RETRIES,
      });
      if (decision.action === "ignore") return;
      if (decision.action === "wait-until-visible") {
        session.error = null;
        session.recognitionSuspended = true;
        discardInterim();
        showRemoteStatus(t("editor.dictationBackground"));
        return;
      }
      if (decision.action === "fail") {
        failDictation(decision);
        return;
      }
      if (session.restartTimer) return;
      discardInterim();
      session.restartTimer = setTimeout(() => {
        session.restartTimer = null;
        if (dictation !== session || session.userStopped) return;
        if (decision.countNetwork) session.networkRetries++;
        if (decision.clearError) session.error = null;
        if (decision.reconnecting) showRemoteStatus(t("editor.dictationReconnecting"));
        beginRecognition(0);
      }, decision.delayMs || 0);
    };
    recognition.addEventListener("result", (e) => {
      if (!dictationStillRunning(session) || session.recognition !== recognition) return;
      session.networkRetries = 0;
      session.startFailures = 0;
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += text;
        else interimText += text;
      }
      const accepted = transcript.accept(finalText, interimText, performance.now());
      if (!accepted.finalText && !accepted.interimText) return;
      writeDictation(accepted.finalText, accepted.interimText);
    });
    recognition.addEventListener("error", (e) => {
      if (dictation !== session || session.recognition !== recognition) return;
      // "no-speech" is a quiet stretch and "aborted" is our own restart.
      // Both end the recognizer; finish() starts another while dictation is on.
      if (e.error === "no-speech" || e.error === "aborted") {
        if (!session.error || session.error === "aborted" || session.error === "no-speech") session.error = e.error;
      } else {
        session.error = e.error;
      }
      // end usually follows. If it doesn't, don't leave the session hung.
      setTimeout(finish, e.error === "no-speech" || e.error === "aborted" ? 400 : 800);
    });
    recognition.addEventListener("end", finish);
  };

  // A fresh recognizer each time. Reusing the one Chrome just ended throws
  // InvalidStateError from inside the end event, and swallowing that leaves
  // dictation looking on while nothing is listening.
  const beginRecognition = (startFailures) => {
    if (dictation !== session || session.userStopped) return;
    const previous = session.recognition;
    // Drop the old recognizer before aborting it. abort() can deliver
    // "end" before it returns, and that must not schedule a second restart.
    session.recognition = null;
    if (previous) {
      try {
        previous.abort();
      } catch (err) {
        // already ended
      }
    }
    const recognition = new SpeechRecognitionImpl();
    arm(recognition);
    session.recognition = recognition;
    session.recognitionSuspended = false;
    transcript.expectPossibleRepeat(performance.now());
    try {
      recognition.start();
      session.startFailures = 0;
    } catch (err) {
      const again = webSpeechAfterStartError({
        name: err && err.name,
        message: err && (err.message || err.name),
        startFailures,
      });
      if (again.action === "restart") {
        session.restartTimer = setTimeout(() => {
          session.restartTimer = null;
          if (dictation !== session || session.userStopped) return;
          beginRecognition(startFailures + 1);
        }, again.delayMs || 0);
        return;
      }
      failDictation(again);
    }
  };
  session.startRecognition = () => beginRecognition(0);

  beginRecognition(0);
  if (dictation !== session) return;
  updateDictationButton();
  el.editor.focus();
}

// The realtime engine (see the section comment). Pending transcript items
// are shown as interim text in arrival order; a completed one becomes final
// text. Items started before a rebase (see rebaseDictation) are abandoned:
// their text stays where it was typed and their final version is dropped.
// iOS (WebKit's Audio Session API): a file is plain playback - no
// microphone - and "playback" is the session a music app uses. A short
// voice alert ducks that session instead of stopping it. "auto" afterwards
// lets the microphone take "play-and-record". Claiming playback while a
// mic is live would end that track, so the claim is refused then.
function setAudioSessionType(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch (err) {
    // not settable here - the browser's own choice stands
  }
}

function readAudioSessionState() {
  try {
    const audioSession = navigator.audioSession;
    return audioSession && typeof audioSession.state === "string" ? audioSession.state : "";
  } catch (err) {
    return "";
  }
}

// Automatic replay gave up. The playback session stays "playback" — dropping
// it to "auto" is what made a duck into a stop — and ▶ is the way back.
function markFileNeedsTap(session) {
  const file = session && session.file;
  if (!file || file.userPaused || file.audio.ended) return;
  file.osReleased = true;
  showRemoteStatus(t("editor.audioFileInterrupted"), { sticky: true });
  updateAudioFileBar();
}

function bindFileAudioSession(session) {
  let audioSession;
  try {
    audioSession = navigator.audioSession;
  } catch (err) {
    return () => {};
  }
  if (!audioSession) return () => {};
  const onState = () => {
    if (dictation !== session || !session.file || !session.file.duck || session.file.userPaused) return;
    // Interrupted → anything else is the alert ending. Replay only if the
    // element was actually paused; a duck leaves it playing.
    session.file.duck.onSession(readAudioSessionState());
  };
  try {
    if (typeof audioSession.addEventListener === "function") {
      audioSession.addEventListener("statechange", onState);
      return () => {
        try {
          audioSession.removeEventListener("statechange", onState);
        } catch (err) {
          // already gone
        }
      };
    }
  } catch (err) {
    // property-only implementation below
  }
  let previous = null;
  try {
    previous = audioSession.onstatechange || null;
    audioSession.onstatechange = (event) => {
      if (typeof previous === "function") {
        try {
          previous.call(audioSession, event);
        } catch (err) {
          // the previous handler failed
        }
      }
      onState();
    };
  } catch (err) {
    return () => {};
  }
  return () => {
    try {
      audioSession.onstatechange = previous;
    } catch (err) {
      // not settable
    }
  };
}

// The lock screen's and Control Center's player: the file's name, and
// play/pause/seek that reach the player while the page is hidden.
// Ownership is shared with the recordings list, so stopping one does not
// clear the other's metadata.
function setAudioFileMediaSession(file, playbackState) {
  const playing = () => dictation && dictation.file && dictation.file.audio;
  publishMediaSession("file", {
    title: file.name,
    playbackState,
    handlers: {
      play: () => resumeFilePlayback(dictation),
      pause: () => pauseFilePlayback(dictation),
      seekbackward: (d) => {
        const audio = playing();
        if (audio) seekFileTo(audio.currentTime - ((d && d.seekOffset) || 10));
      },
      seekforward: (d) => {
        const audio = playing();
        if (audio) seekFileTo(audio.currentTime + ((d && d.seekOffset) || 10));
      },
      seekto: (d) => d && Number.isFinite(d.seekTime) && seekFileTo(d.seekTime),
    },
  });
}

function clearAudioFileMediaSession() {
  clearMediaSession("file");
}

function applyBufferSteps(session, kind) {
  if (!session) return;
  for (const step of bufferSteps(kind)) {
    if (step === "commit" && session.commit) session.commit();
    else if (step === "clear" && session.clear) session.clear();
  }
}

// The user pressed pause (or the lock-screen pause). The phrase heard so
// far is finalized by the pause listener, once, because this sets userPaused
// before the element actually pauses. userPaused is how that listener tells
// a button press from iOS pausing the element for us.
function pauseFilePlayback(session) {
  if (!session || !session.file) return;
  session.file.userPaused = true;
  if (session.file.duck) session.file.duck.reset();
  const audio = session.file.audio;
  if (!audio.paused) audio.pause();
  else if (session.file.started) {
    applyBufferSteps(session, "pause");
    if (typeof session.hold === "function") session.hold();
  }
  setMediaPlaybackState("file", "paused");
  syncFileTap(session);
  updateAudioFileBar();
}

// The transcription tap has to be pulled or Safari never moves samples
// into the stream. The pull is a zero gain into the graph's destination,
// so the graph is not the thing the user hears — iOS ducks the plain
// element and interrupts a graph that is actually playing.
function ensureSilentKeeper(session) {
  const file = session && session.file;
  const ctx = session && session.audioContext;
  if (!file || !file.source || !ctx || ctx.state === "closed") return;
  if (!file.keeper) {
    try {
      const keeper = ctx.createGain();
      keeper.gain.value = 0;
      file.keeper = keeper;
    } catch (err) {
      return;
    }
  }
  try {
    file.source.disconnect(ctx.destination);
  } catch (err) {
    // the tap was never the speaker
  }
  try {
    file.source.disconnect(file.keeper);
  } catch (err) {
    // not connected yet
  }
  try {
    file.keeper.disconnect(ctx.destination);
  } catch (err) {
    // not connected yet
  }
  try {
    file.source.connect(file.keeper);
    file.keeper.connect(ctx.destination);
  } catch (err) {
    // the graph is already closed
  }
}

// The audible element leads. The tap only exists so transcription can
// hear the file without taking its output away from the media element.
function syncFileTap(session) {
  const file = session && session.file;
  const tap = file && file.tap;
  const audio = file && file.audio;
  if (!tap || !audio) return;
  try {
    tap.playbackRate = audio.playbackRate;
  } catch (err) {
    // the tap is already gone
  }
  const action = tapSyncAction({
    audiblePaused: audio.paused,
    tapPaused: tap.paused,
    audibleTime: audio.currentTime,
    tapTime: tap.currentTime,
  });
  if (action === "pause" || action === "play" || action === "seek") {
    try {
      if (Number.isFinite(audio.currentTime)) tap.currentTime = audio.currentTime;
    } catch (err) {
      // metadata not in yet
    }
  }
  if (action === "pause") tap.pause();
  else if (action === "play") {
    const pending = tap.play();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  }
}

// iOS paused the element, or the audio graph went silent. Finalize once and
// tell the provider to wait. Resume clears instead of committing again.
function noteFileInterrupted(session) {
  if (!session || !session.file || session.file.userPaused || !session.file.started) return;
  if (!session.file.interrupted) {
    session.file.interrupted = true;
    applyBufferSteps(session, "pause");
  }
  if (typeof session.hold === "function") session.hold();
}

// Keep the words already on screen, and aim the next phrase after them.
// The socket that was about to confirm them is about to be replaced.
function sealFileTranscript(session) {
  if (!session) return;
  try {
    if (session.commit) session.commit();
  } catch (err) {
    // the socket is already gone
  }
  if (session.interim) {
    session.from += session.interim.length;
    session.interim = "";
  }
  if (session.items) {
    for (const id of session.items.keys()) session.abandoned.add(id);
    session.items.clear();
  }
}

function adoptTranscriptionHandle(session, handle) {
  session.stop = handle.stop;
  session.commit = handle.commit;
  session.clear = handle.clear;
  session.setStream = handle.setStream;
  session.hold = typeof handle.hold === "function" ? handle.hold : () => {};
  session.alive = typeof handle.alive === "function" ? handle.alive : () => true;
  session.stream = handle.stream;
  if (!session.file) return;
  session.file.reconnecting = false;
  session.file.sttDropped = false;
  const track = handle.stream && handle.stream.getAudioTracks()[0];
  if (track) watchFileTrack(session, track);
}

// The provider closed the file session (Request timeout, a dead socket).
// Open another one on the same AudioContext, from the current position.
async function reconnectFileTranscription(session, reasonText) {
  if (dictation !== session || !session.file || session.file.reconnecting) return;
  if (typeof session.openEngine !== "function") return;
  const reconnects = session.file.reconnects || 0;
  if (reconnects >= FILE_RECONNECT_CAP) {
    const text = reasonText || session.file.dropReason || "error";
    stopDictation();
    alert(t("editor.dictationFailed", { message: text }));
    return;
  }
  session.file.reconnecting = true;
  session.file.reconnects = reconnects + 1;
  session.file.sttDropped = false;
  sealFileTranscript(session);
  session.sttEpoch = (session.sttEpoch || 0) + 1;
  const ctx = session.audioContext;
  try {
    session.stop({ keepContext: true });
  } catch (err) {
    // already ended
  }
  // A released session stays suspended until playback itself resumes.
  if (ctx && audioContextNeedsResume(ctx.state) && !(session.file.osReleased && !session.file.resuming)) ctx.resume().catch(() => {});
  let stream = null;
  try {
    ensureSilentKeeper(session);
    const dest = ctx.createMediaStreamDestination();
    try {
      session.file.source.disconnect(session.file.dest);
    } catch (err) {
      // already disconnected
    }
    session.file.source.connect(dest);
    session.file.dest = dest;
    stream = dest.stream;
  } catch (err) {
    session.file.reconnecting = false;
    session.file.sttDropped = true;
    session.file.dropReason = (err && err.message) || reasonText || "error";
    if (session.file.reconnects >= FILE_RECONNECT_CAP || !shouldReconnectFileSession(session.file.dropReason)) {
      stopDictation();
      alert(t("editor.dictationFailed", { message: session.file.dropReason }));
    }
    return;
  }
  showRemoteStatus(t("editor.dictationReconnecting"), { sticky: true });
  try {
    const handle = await session.openEngine(stream);
    if (dictation !== session) {
      try {
        handle.stop();
      } catch (err) {
        // already ended
      }
      return;
    }
    adoptTranscriptionHandle(session, handle);
    if (!session.alive()) {
      try {
        session.stop({ keepContext: true });
      } catch (err) {
        // already ended
      }
      throw new Error(session.file.dropReason || reasonText || "connection closed");
    }
    session.file.reconnecting = false;
    session.file.sttDropped = false;
    if (!session.file.userPaused && session.file.audio.paused && !session.file.audio.ended) {
      session.file.audio.play().catch(() => {});
    }
    showRemoteStatus(t("editor.dictationListening"));
  } catch (err) {
    if (dictation !== session) return;
    const text = (err && err.message) || reasonText || "error";
    session.file.reconnecting = false;
    session.file.sttDropped = true;
    session.file.dropReason = text;
    if (!shouldReconnectFileSession(text) || session.file.reconnects >= FILE_RECONNECT_CAP) {
      stopDictation();
      alert(t("editor.dictationFailed", { message: text }));
      return;
    }
    if (!session.file.userPaused && !session.file.audio.paused && !document.hidden) {
      reconnectFileTranscription(session, text);
      return;
    }
    showRemoteStatus(t("editor.dictationReconnecting"), { sticky: true });
  }
}

// Soniox "Request timeout" lands here, and so does a file peer that died.
function handleProviderError(session, message) {
  if (dictation !== session) return;
  const text = fileErrorText(message) || "error";
  if (!session.file) {
    stopDictation();
    alert(t("editor.dictationFailed", { message: text }));
    return;
  }
  const action = fileProviderFailureAction({
    message,
    hidden: document.hidden,
    userPaused: session.file.userPaused,
    audioPaused: session.file.audio.paused,
    reconnects: session.file.reconnects || 0,
    reconnecting: session.file.reconnecting,
  });
  if (action === "ignore") {
    session.file.sttDropped = true;
    session.file.dropReason = text;
    return;
  }
  if (action === "status") {
    showRemoteStatus(t("editor.dictationFailed", { message: text }));
    return;
  }
  if (action === "popup") {
    stopDictation();
    alert(t("editor.dictationFailed", { message: text }));
    return;
  }
  session.file.sttDropped = true;
  session.file.dropReason = text;
  if (action === "wait") {
    showRemoteStatus(t("editor.dictationReconnecting"), { sticky: true });
    noteFileInterrupted(session);
    return;
  }
  reconnectFileTranscription(session, text);
}

// ▶ again, or the lock-screen play. Called synchronously from that click so
// resume() still counts as the gesture. The first play after connect does
// not clear: nothing has been committed yet. A play after a pause or an
// interruption clears the silent gap so the next words are a new phrase.
function resumeFilePlayback(session, { announce = true, automatic = false } = {}) {
  if (!session || !session.file || session.file.resuming) return;
  const file = session.file;
  const wasReleased = !!file.osReleased;
  // A finger on ▶ cancels a pending automatic replay. The replay itself
  // must not, or a pause that comes right back would loop.
  if (!automatic && file.duck) file.duck.reset();
  file.resuming = true;
  file.resumeFailed = false;
  // Stay on playback. Refusing this while a microphone is live is what
  // keeps play-and-record from being overwritten.
  claimPlaybackSession("file");
  if (wasReleased) {
    file.uplinkHeld = false;
    const track = session.stream && session.stream.getAudioTracks()[0];
    if (track && track.readyState !== "ended") {
      try {
        track.enabled = true;
      } catch (err) {
        // the track is already gone
      }
    }
  }
  const audio = file.audio;
  const ctx = session.audioContext;
  const sttOpen = !file.sttDropped && (typeof session.alive !== "function" || session.alive());
  const action = fileResumeAction({
    contextState: ctx ? ctx.state : "closed",
    userPaused: file.userPaused,
    interrupted: file.interrupted,
    sttOpen,
    reconnects: file.reconnects || 0,
    reconnecting: file.reconnecting,
    started: file.started,
  });
  const finishResume = (ok) => {
    if (!session.file) return;
    session.file.resuming = false;
    session.file.causedByUs = false;
    const stuck = !ok || session.file.audio.paused;
    if (!stuck) {
      session.file.osReleased = false;
      session.file.weSuspended = false;
      session.file.resumeFailed = false;
      session.file.uplinkHeld = false;
      setMediaPlaybackState("file", "playing");
      syncFileTap(session);
      if (wasReleased) showRemoteStatus(t("editor.dictationListening"));
      updateAudioFileBar();
      return;
    }
    session.file.resumeFailed = true;
    // The platform paused us again, or play() was rejected. Schedule the
    // next try without leaving the playback session.
    if (session.file.duck && !session.file.userPaused && session.file.audio.paused && !session.file.audio.ended) {
      session.file.duck.onSystemPause();
    }
    updateAudioFileBar();
  };
  // resume() has to be invoked before any await. "interrupted" is not
  // "suspended", and leaving it there is why the clock moved with no sound.
  if (wasReleased) file.weSuspended = false;
  if (ctx && ctx.state !== "closed" && action.resumeContext && readAudioSessionState() !== "interrupted") {
    ctx.resume().catch(() => {});
  }
  ensureSilentKeeper(session);
  if (action.popup) {
    file.resuming = false;
    file.causedByUs = false;
    const text = file.dropReason || "error";
    stopDictation();
    alert(t("editor.dictationFailed", { message: text }));
    return;
  }
  if (action.clearBuffer) applyBufferSteps(session, "resume");
  file.userPaused = false;
  file.interrupted = false;
  file.started = true;
  if (action.reconnect) reconnectFileTranscription(session, file.dropReason);
  else if (!file.reconnecting) ensureFileUplink(session);
  let played;
  try {
    played = audio.play();
  } catch (err) {
    finishResume(false);
    if (!automatic && announce && dictation === session) showRemoteStatus(t("editor.dictationFailed", { message: err.message }));
    return;
  }
  syncFileTap(session);
  if (!played || typeof played.then !== "function") {
    finishResume(true);
    return;
  }
  played.then(() => {
    if (dictation !== session) return;
    finishResume(true);
  }).catch((err) => {
    if (dictation !== session) return;
    finishResume(false);
    if (!automatic && announce) showRemoteStatus(t("editor.dictationFailed", { message: err.message }));
  });
}

// Slider, 10-second skips, lock-screen seek, and the typed time all come
// through here. A running transcription commits once and drops the gap.
function seekFileTo(position) {
  if (!audioFile) return;
  const end = audioFile.duration || Infinity;
  const next = Math.min(Math.max(0, position), end);
  audioFile.position = next;
  const session = dictation && dictation.file ? dictation : null;
  if (session && session.file.started) {
    const now = performance.now();
    // A drag fires this continuously; one commit+clear per gesture is enough.
    if (now - session.file.seekedAt > 200) {
      applyBufferSteps(session, "seek");
      session.file.seekedAt = now;
    }
  }
  if (session) {
    session.file.audio.currentTime = next;
    syncFileTap(session);
  }
  updateAudioFileBar();
}

// Pause or an interruption can leave the capture track muted or ended
// while the element itself still plays. A fresh destination is a live track.
function ensureFileUplink(session) {
  const file = session && session.file;
  if (!file || !session.setStream || !file.source || file.rebuilding || file.reconnecting) return;
  if (file.rebuiltAt && performance.now() - file.rebuiltAt < 500) return;
  const track = session.stream && session.stream.getAudioTracks()[0];
  if (!uplinkNeedsRebuild(track)) return;
  if (!session.audioContext || session.audioContext.state === "closed") return;
  file.rebuilding = true;
  file.rebuiltAt = performance.now();
  try {
    const dest = session.audioContext.createMediaStreamDestination();
    try {
      file.source.disconnect(file.dest);
    } catch (err) {
      // already disconnected
    }
    file.source.connect(dest);
    file.dest = dest;
    const next = dest.stream;
    // Before setStream stops the old track, so its "ended" handler sees
    // this stream and doesn't rebuild a second time.
    session.stream = next;
    const fresh = next.getAudioTracks()[0];
    if (fresh) watchFileTrack(session, fresh);
    session.setStream(next).finally(() => {
      file.rebuilding = false;
    });
  } catch (err) {
    file.rebuilding = false;
  }
}

function watchFileTrack(session, track) {
  const rebuild = () => {
    if (dictation !== session || !session.file || session.file.reconnecting || session.file.audio.paused || session.file.osReleased || session.file.uplinkHeld) return;
    const current = session.stream && session.stream.getAudioTracks()[0];
    if (current && current !== track) return;
    ensureFileUplink(session);
  };
  track.addEventListener("ended", rebuild);
  track.addEventListener("mute", rebuild);
}

function watchMicTracks(session, stream) {
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (dictation !== session) return;
      const current = session.stream && session.stream.getAudioTracks()[0];
      if (current && current !== track) return;
      if (captureInterrupted(document.hidden) === "resume-when-visible") {
        session.micSuspended = true;
        showRemoteStatus(t("editor.dictationBackground"));
        return;
      }
      stopDictation();
    });
    let mutedAt = 0;
    track.addEventListener("mute", () => {
      if (dictation !== session) return;
      mutedAt = Date.now();
    });
    track.addEventListener("unmute", () => {
      if (dictation !== session || !mutedAt) return;
      const seconds = Math.round((Date.now() - mutedAt) / 1000);
      mutedAt = 0;
      if (seconds > 0) showRemoteStatus(t("editor.micWasMuted", { seconds }));
    });
  });
}

// iOS Safari (and sometimes Chrome) drop the microphone or the speech
// recognizer while the tab is hidden. The session is still the same one,
// still aimed at the original document; only the capture is opened again.
async function resumeMicCapture(session) {
  if (dictation !== session || session.file) return;
  if (session.engine === "webspeech") {
    if (!session.recognitionSuspended || !session.startRecognition) return;
    session.error = null;
    session.startRecognition();
    if (dictation === session) showRemoteStatus(t("editor.dictationListening"));
    return;
  }
  if (!session.micSuspended || !session.setStream) return;
  try {
    showRemoteStatus(t("editor.dictationReconnecting"));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(captureAudio()),
    });
    if (dictation !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    await session.setStream(stream);
    watchMicTracks(session, stream);
    session.micSuspended = false;
    showRemoteStatus(t("editor.dictationListening"));
  } catch (err) {
    session.micSuspended = true;
    showRemoteStatus(t("editor.dictationResumeFailed", { message: (err && err.message) || "error" }));
  }
}

function startBilledDictation(file, engine) {
  // Before the AudioContext, so iOS classifies the page as playback (ducked
  // by a voice alert) rather than whatever the graph would imply. A mic
  // session claims "auto" instead, which becomes play-and-record.
  if (file) claimPlaybackSession("file");
  else beginMicSession();
  // Created here, inside the click, for iOS - see realtime-stt.js.
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const session = {
    engine,
    target: active,
    targetRef: activeDocRef(),
    writeStash: false,
    audioContext,
    from: el.editor.selectionStart,
    interim: "",
    items: new Map(), // item_id -> text so far, in arrival order (OpenAI)
    abandoned: new Set(),
    dropPendingFinals: false,
    stop: ({ keepContext = false } = {}) => {
      if (!keepContext) audioContext.close().catch(() => {});
    },
    commit: () => {},
    clear: () => {},
    setStream: null,
    hold: () => {},
    alive: () => true,
    sttEpoch: 1,
    micSuspended: false,
    micOwned: !file,
  };
  dictation = session;
  // An audio file (see "audio file" above). The element the user hears is
  // never a MediaElementSource: iOS ducks a media element in a playback
  // session and interrupts a Web Audio graph that is the speaker. A second
  // element is tapped for the engine and pulled with a zero gain, so the
  // graph stays silent. Closing the context at the end drops the tap.
  let fileStream = null;
  if (file) {
    const audio = new Audio(file.url);
    audio.playbackRate = file.rate;
    const tap = new Audio(file.url);
    tap.playbackRate = file.rate;
    const source = audioContext.createMediaElementSource(tap);
    const out = audioContext.createMediaStreamDestination();
    source.connect(out);
    fileStream = out.stream;
    // Both unlocked inside the click, so iOS lets them play once connected.
    // The tap is hijacked by the source node before it plays, so it is silent.
    audio.play().catch(() => {});
    tap.play().catch(() => {});
    audio.pause();
    tap.pause();
    audio.addEventListener("timeupdate", () => {
      if (dictation !== session) return;
      file.position = audio.currentTime;
      syncFileTap(session);
      updateAudioFileBar();
    });
    audio.addEventListener("play", () => {
      if (dictation === session) {
        setMediaPlaybackState("file", "playing");
        syncFileTap(session);
      }
      updateAudioFileBar();
    });
    audio.addEventListener("pause", () => {
      file.buffering = false;
      if (dictation !== session || !session.file) {
        updateAudioFileBar();
        return;
      }
      syncFileTap(session);
      setMediaPlaybackState("file", "paused");
      // The button sets userPaused first. A pause while play() is in flight
      // is finished by that call. Any other pause of a started file is the
      // platform: keep the playback session and resume when it lets go.
      if (filePauseKind(session.file.userPaused) === "user") {
        applyBufferSteps(session, "pause");
        if (typeof session.hold === "function") session.hold();
      } else if (session.file.started && !audio.ended && !session.file.resuming) {
        noteFileInterrupted(session);
        if (session.file.duck) session.file.duck.onSystemPause();
      }
      updateAudioFileBar();
    });
    audio.addEventListener("waiting", () => {
      file.buffering = true;
      updateAudioFileBar();
    });
    audio.addEventListener("playing", () => {
      file.buffering = false;
      updateAudioFileBar();
    });
    audio.addEventListener("ended", () => {
      if (dictation !== session) return;
      session.commit();
      setTimeout(() => {
        if (dictation !== session) return;
        stopDictation();
        // ▶ next plays it from the start.
        file.position = 0;
        updateAudioFileBar();
      }, AUDIO_FILE_TAIL_MS);
      showRemoteStatus(t("editor.audioFileEnded"));
    });
    session.file = {
      audio,
      tap,
      source,
      dest: out,
      keeper: null,
      started: false,
      userPaused: false,
      interrupted: false,
      osReleased: false,
      weSuspended: false,
      causedByUs: false,
      uplinkHeld: false,
      resumeFailed: false,
      resumeSuppressed: false,
      resumeEpoch: 0,
      interruptPending: false,
      resuming: false,
      seekedAt: 0,
      rebuilding: false,
      reconnects: 0,
      reconnecting: false,
      sttDropped: false,
      dropReason: "",
      duck: null,
    };
    session.file.duck = createDuckRetry({
      sessionState: readAudioSessionState,
      stillPaused: () => dictation === session && session.file && !session.file.userPaused && session.file.audio.paused && !session.file.audio.ended,
      replay: () => {
        if (dictation !== session || !session.file || session.file.userPaused) return;
        resumeFilePlayback(session, { announce: false, automatic: true });
      },
      onGiveUp: () => markFileNeedsTap(session),
    });
    ensureSilentKeeper(session);
    audioContext.addEventListener("statechange", () => {
      if (dictation !== session || !session.file) return;
      // The tap graph flinching is not a reason to pause the file or to
      // drop the playback session. Resume it only when the platform is
      // not holding the session for something else.
      if (session.file.userPaused || session.file.audio.ended || session.file.resuming) return;
      if (readAudioSessionState() === "interrupted") return;
      if (session.file.osReleased || session.file.weSuspended) return;
      const action = fileContextAction(audioContext.state, {
        userPaused: session.file.userPaused,
        audioEnded: audio.ended,
        started: session.file.started,
        audioPaused: audio.paused,
      });
      if (action.resumeContext) audioContext.resume().catch(() => {});
    });
    session.file.unbindAudioSession = bindFileAudioSession(session);
    setAudioFileMediaSession(file, "paused");
  }
  if (el.editor.selectionEnd > el.editor.selectionStart) {
    replaceEditorRange(el.editor.selectionStart, el.editor.selectionEnd, "");
  }
  updateDictationButton();
  el.editor.focus();
  showRemoteStatus(t("editor.dictationConnecting"), { sticky: true });
  const pendingText = () => [...session.items.values()].join(" ");
  const language = el.dictationLang.value.split("-")[0];
  // Recording shares this open, so it is the same unprocessed multichannel stream.
  const micAudio = micConstraints(captureAudio());
  // A file's quiet stretches are the recording, not an empty microphone.
  const idleMs = file ? null : REALTIME_IDLE_MS;
  const onIdle = () => {
    if (dictation !== session || session.file) return;
    stopDictation();
    showRemoteStatus(t("editor.dictationIdleStopped"));
  };
  // Each socket captures the epoch it was opened with. A reconnect bumps
  // the epoch first, so a late "Request timeout" from the old socket cannot
  // write the phrase again or pop the stop alert.
  const openEngine = (stream) => {
    const epochAtStart = session.sttEpoch || 1;
    const still = () => dictation === session && session.sttEpoch === epochAtStart;
    if (engine === "soniox") {
      return startSonioxTranscription({
        language,
        audioContext,
        audio: micAudio,
        stream,
        idleMs,
        onIdle,
        terms: spokenMathTerms,
        onTokens: (message) => {
          if (!still() || !dictationStillRunning(session)) return;
          const taken = consumeSonioxTranscript(message.tokens, session.dropPendingFinals);
          session.dropPendingFinals = taken.dropPendingFinals;
          if (!taken.finals && !taken.interim) return;
          if (session.file) session.file.reconnects = 0;
          writeDictation(taken.finals, taken.interim);
        },
        onError: (message) => {
          if (!still()) return;
          handleProviderError(session, message);
        },
      });
    }
    return startRealtimeTranscription({
      language,
      audioContext,
      audio: micAudio,
      stream,
      idleMs,
      onIdle,
      onEvent: (event) => {
        if (!still() || !dictationStillRunning(session)) return;
        if (event.type === "conversation.item.input_audio_transcription.delta") {
          if (session.abandoned.has(event.item_id)) return;
          session.items.set(event.item_id, (session.items.get(event.item_id) || "") + (event.delta || ""));
          if (session.file) session.file.reconnects = 0;
          writeDictation("", pendingText());
        } else if (event.type === "conversation.item.input_audio_transcription.completed") {
          if (session.abandoned.delete(event.item_id)) return;
          session.items.delete(event.item_id);
          if (session.file && event.transcript) session.file.reconnects = 0;
          writeDictation(event.transcript || "", pendingText());
        } else if (event.type === "error") {
          const text = (event.error && event.error.message) || "error";
          if (session.file) handleProviderError(session, text);
          else showRemoteStatus(t("editor.dictationFailed", { message: text }));
        }
      },
    });
  };
  session.openEngine = openEngine;
  openEngine(fileStream)
    .then((handle) => {
      if (dictation !== session) {
        handle.stop();
        return;
      }
      adoptTranscriptionHandle(session, handle);
      if (file) {
        const audio = session.file.audio;
        const seek = () => {
          audio.currentTime = file.position;
          syncFileTap(session);
        };
        if (audio.readyState >= 1) seek();
        else audio.addEventListener("loadedmetadata", seek, { once: true });
        resumeFilePlayback(session);
        showRemoteStatus(t("editor.dictationListening"));
        return;
      }
      // The microphone's three quiet minutes still hang up (onIdle above).
      // The track ending or muting because the tab was hidden does not:
      // that capture is opened again when the page is visible.
      watchMicTracks(session, handle.stream);
      showRemoteStatus(t("editor.dictationListening"));
      if (recordWithDictation && recordingSupported()) startDictationRecording(session, handle.stream, false);
    })
    .catch((err) => {
      if (dictation === session) {
        dictation = null;
        if (file) {
          if (session.file && session.file.tap) session.file.tap.pause();
          clearAudioFileMediaSession();
          releasePlaybackSession("file");
        } else if (session.micOwned) endMicSession();
        updateDictationButton();
      }
      setToolStatus("");
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      alert(denied ? t("editor.dictationDenied") : t("editor.dictationFailed", { message: err.message }));
    });
}

function stopDictation() {
  const session = dictation;
  if (!session) return;
  dictation = null;
  // The recorder first: the realtime engine's stop() ends the stream it records.
  stopDictationRecording(session);
  if (session.file && typeof session.file.unbindAudioSession === "function") {
    session.file.unbindAudioSession();
    session.file.unbindAudioSession = null;
  }
  if (session.file) {
    if (session.file.duck) session.file.duck.reset();
    session.file.audio.pause();
    if (session.file.tap) session.file.tap.pause();
  }
  keepScreenOn(false);
  if (session.micOwned) endMicSession();
  if (session.file) {
    clearAudioFileMediaSession();
    releasePlaybackSession("file");
  }
  // Whatever interim text is on screen simply stays as typed.
  try {
    session.stop();
  } catch (err) {
    // already ended
  }
  updateDictationButton();
}

// For an edit made right where dictation is writing (the remote's tidy, new
// slide, line break and math): the phrase in progress must stay where it
// was said - the recognizer may still deliver a final version of it, and
// that mustn't land at the new spot too - and dictation carries on at the
// caret the edit leaves. Web Speech is simply restarted. The realtime
// engine isn't (a new session would lose a second of speech to the
// handshake): what's been said is committed, its pending items abandoned,
// and the anchor moved.
function rebaseDictation(edit) {
  const session = dictation;
  // The edit is happening in the document on screen. When the transcript
  // is landing in a different document, leave that anchor where it is.
  if (!session || session.writeStash) {
    edit();
    return;
  }
  if (session.engine === "webspeech") {
    stopDictation();
    edit();
    startDictation();
    return;
  }
  const pendingInterim = session.interim;
  session.commit();
  if (session.engine === "soniox" && pendingInterim) session.dropPendingFinals = true;
  for (const id of session.items.keys()) session.abandoned.add(id);
  session.items.clear();
  session.interim = "";
  edit();
  session.from = el.editor.selectionStart;
}

function recoverVisibleFileSession() {
  const session = dictation;
  if (!session || !session.file || document.hidden) return;
  const file = session.file;
  const ctx = session.audioContext;
  if (file.userPaused) {
    // A user pause does not release the session. An OS release that the
    // user then confirmed with pause must not wake the graph on focus.
    if (file.osReleased || file.weSuspended) return;
    if (readAudioSessionState() === "interrupted") return;
    if (ctx && audioContextNeedsResume(ctx.state)) ctx.resume().catch(() => {});
    ensureSilentKeeper(session);
    return;
  }
  // Still held by the platform. The session's statechange resumes playback
  // when the alert ends; doing it here would take the session back.
  if (readAudioSessionState() === "interrupted") return;
  const needsGraph = ctx && audioContextNeedsResume(ctx.state);
  const paused = file.started && file.audio.paused && !file.audio.ended;
  const dropped = file.sttDropped || (typeof session.alive === "function" && !session.alive());
  if (file.interrupted || paused || dropped || needsGraph) {
    // Not a tap. A rejected play() must not look like the provider stopping.
    resumeFilePlayback(session, { announce: false });
    return;
  }
  ensureFileUplink(session);
}

// Hiding the page does not stop dictation and does not release the iOS
// playback session. The browser drops a wake lock whenever the page is
// hidden, and iOS may also freeze timers, so a file sends keepalive once
// on the way out. The graph is resumed when the page is visible again.
// A file the user paused stays paused. An OS interruption is a different
// signal (AudioContext / AudioSession / a system pause) and is handled there.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (dictation && dictation.file && typeof dictation.hold === "function") dictation.hold();
    return;
  }
  if (!dictation) return;
  keepScreenOn(true);
  const session = dictation;
  if (session.file) {
    recoverVisibleFileSession();
    return;
  }
  if (session.engine === "webspeech") {
    resumeMicCapture(session);
    return;
  }
  const track = session.stream && session.stream.getAudioTracks()[0];
  if (session.micSuspended || !track || track.readyState === "ended") {
    session.micSuspended = true;
    resumeMicCapture(session);
    return;
  }
  if (track.muted) {
    setTimeout(() => {
      if (dictation !== session || document.hidden) return;
      const again = session.stream && session.stream.getAudioTracks()[0];
      if (again && again.muted) {
        session.micSuspended = true;
        resumeMicCapture(session);
      }
    }, 1000);
  }
});
// bfcache restore and coming back to the window. visibilitychange does not
// fire for every one of these, and resume() needs another try after iOS
// interrupted the audio session.
window.addEventListener("pageshow", () => recoverVisibleFileSession());
// Focus is also the play button's gesture, so this only wakes the graph.
// Starting playback here would race that click and pause it again.
window.addEventListener("focus", () => {
  const session = dictation;
  if (!session || document.hidden) return;
  // Focus is not the interruption ending. Waking the graph here would take
  // the playback session back while the other app is still recording.
  if (session.file && (session.file.osReleased || session.file.weSuspended || session.file.uplinkHeld)) return;
  if (readAudioSessionState() === "interrupted") return;
  const ctx = session.audioContext;
  if (!ctx || !audioContextNeedsResume(ctx.state)) return;
  ctx.resume().catch(() => {});
  if (session.file) ensureSilentKeeper(session);
});
el.dictationRecordBtn.addEventListener("click", () => {
  // File transcription doesn't open the microphone, so this click must not
  // flip the saved record-with-dictation preference.
  if (el.dictationRecordBtn.getAttribute("aria-disabled") === "true") return;
  recordWithDictation = !recordWithDictation;
  // Turned off mid-recording: the recording ends here, dictation goes on.
  if (!recordWithDictation && dictation && dictation.recording) stopDictationRecording(dictation);
  try {
    localStorage.setItem(DICTATION_RECORD_KEY, recordWithDictation ? "1" : "0");
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
  updateRecordButton();
  // Turned on mid-dictation: start recording right away.
  const session = dictation;
  if (recordWithDictation && session && !session.recording && !session.file) {
    if ((session.engine === "openai" || session.engine === "soniox") && session.stream) startDictationRecording(session, session.stream, false);
    else if (session.engine === "webspeech")
      navigator.mediaDevices
        .getUserMedia({ audio: micConstraints(RECORDING_AUDIO) })
        .then((stream) => (dictation === session ? startDictationRecording(session, stream, true) : stream.getTracks().forEach((tr) => tr.stop())))
        .catch((err) => showRemoteStatus(t("editor.recordingFailed", { message: err.message })));
  }
});
restoreDictationRecord();
restoreMicChoice();
updateMicButton();
refreshMicDevices();
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", refreshMicDevices);
el.dictationMicBtn.addEventListener("click", openMicMenu);
loadRealtimeSttConfig();

function toggleDictation() {
  if (dictation) stopDictation();
  else startDictation();
}

// A command from a live screen (see createLiveSocket's onCommand) - the
// glasses' D-pad standing in for the gamepad remote: "newSlide" (next past
// the last slide) is the remote's new-slide button, "tidySlide" (select) its
// tidy button, "toggleMath" (up) its math button and "lineBreak" (down) its
// line break. Only acted on for the document it was sent about - a screen
// still showing the previous document mustn't change the one opened since.
function handleScreenCommand(message) {
  if (!active || message.filename !== active.filename) return;
  if (message.action === "newSlide") {
    if (presenter.slide === null) presenter.slide = "last";
    openNewSlide();
  } else if (message.action === "tidySlide") {
    tidyCurrentSlide();
  } else if (message.action === "toggleMath") {
    toggleMath();
  } else if (message.action === "lineBreak") {
    breakLine();
  }
}

// ---------- new version deployed ----------
// An open tab keeps running the JavaScript it loaded, so after a deploy it
// can send live updates in the old shape without anyone noticing (a glasses
// screen once stayed in document view because of exactly that). The
// version (see backend app/version.py) is checked every minute and on
// focus; when it moved, a strip offers a reload. Not automatic here: the
// editor may hold unsaved work (the beforeunload prompt still guards it).
const VERSION_CHECK_MS = 60000;
let loadedVersion = null;

async function checkForNewVersion() {
  let version;
  try {
    const res = await fetch("/api/public/version");
    if (!res.ok) return;
    ({ version } = await res.json());
  } catch (err) {
    return;
  }
  if (loadedVersion === null) loadedVersion = version;
  else if (version !== loadedVersion) el.updateBanner.hidden = false;
}

checkForNewVersion();
setInterval(checkForNewVersion, VERSION_CHECK_MS);
window.addEventListener("focus", checkForNewVersion);
// iOS Safari often fires no "focus" when a tab comes back from another app
// (and pauses the interval while hidden) - coming back into view is the
// moment that matters there.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForNewVersion();
});
el.updateReloadBtn.addEventListener("click", () => location.reload());

// ---------- presenter remote (gamepad -> live slides) ----------
//
// Live slides from speech: dictation types into the document, the document
// is published as a slideshow with Live on, and a gamepad (see remote.js)
// drives it. The slide being spoken is the document's *last* slide - the
// text after the final `---` (see slides.js) - and its raw transcript is
// visible to the audience as it's typed. "Make slide" turns that raw text
// into a finished slide with the toolbar's provider/model (through the same
// unrecorded inline-complete endpoint ✨ uses, with the slides so far as
// document context so the deck stays consistent), and opens the next slide
// for dictation right away - the speaker doesn't wait for the model.
//
// Where the audience is (presenter.slide, carried in every live update -
// see currentLiveState and public.js's followPresenter): "last" follows the
// slide being built; a number pins one (prev/next). "Make slide" only ever
// moves the audience *forward* - back to following "last", i.e. on to the
// next slide as soon as speech reaches it - and the finished slide is
// rewritten in place behind them without moving anyone: pinning it when
// the model returned yanked an audience that had already moved on to the
// next slide back to the previous one.
const presenter = { slide: null };
// The most recently made slide, for "undo" (put the raw transcript back) and
// "regenerate" (ask again from the same transcript). Found again by its
// text, since dictation keeps moving everything after it.
let lastMadeSlide = null;
let slideJob = null;
let remoteStatusTimer = null;

function showRemoteStatus(text, { sticky = false } = {}) {
  clearTimeout(remoteStatusTimer);
  if (streaming) return; // the send in flight owns the status line
  setToolStatus(text);
  if (text && !sticky) remoteStatusTimer = setTimeout(() => !streaming && !slideJob && setToolStatus(""), 2500);
}

function presenterUsable() {
  return !!active && !streaming && !el.editor.disabled && !NON_SENDABLE_ROLES.has(active.role);
}

// Rewrites [from, to) without moving the caret, and keeps a running
// dictation's anchor in step when the edit lands before it - the slide
// being swapped in sits above where dictation is still typing.
function spliceKeepingCaret(from, to, text) {
  el.editor.replaceRangeKeepingSelection(from, to, text);
  // A background transcript has its own anchor in another document. An edit
  // on screen must not slide that.
  if (dictation && !dictation.writeStash && to <= dictation.from) dictation.from += text.length - (to - from);
  updateFilenameLabel();
  updateFormatToolbar();
  renderPreview();
}

// The presenter's position rides along in live updates, so both live
// targets - the public page and the glasses screen - follow it.
function sendPresenterUpdate() {
  if (el.livePublicCheckbox.checked) livePublicSocket.send(false);
  if (el.glassesCheckbox.checked) glassesSocket.send(false);
  if (!el.livePublicCheckbox.checked && !el.glassesCheckbox.checked) showRemoteStatus(t("remote.liveOff"));
}

// Tidying is something the audience waits on, so it runs at the selected
// model's *lowest* reasoning level whatever the toolbar says - measured on
// the same prompt, reasoning was most of the wait (gpt-5.6-luna: first token
// 2.4s at its default vs 0.8s at "none"). Anthropic's "off" means no
// extended thinking at all, its fastest; an OpenAI reasoning model with no
// "none"/"minimal" (gpt-6-astra) gets its lowest offered level, since "off"
// there would mean the model's own, higher default.
function fastestReasoning(providerId, model) {
  if (providerId === "anthropic") return "off";
  const provider = providers.find((p) => p.id === providerId);
  const levels = provider && provider.reasoning_efforts && provider.reasoning_efforts[model];
  return levels && levels.length ? levels[0] : "off";
}

// The slide's neighbours are enough for a consistent style; the whole deck
// would only make every tidy slower as the talk goes on.
const SLIDE_CONTEXT_SLIDES = 2;

// One slide from one slide's worth of content, streamed: `onDelta(text)`
// sees the reply as it arrives, and the promise resolves to the cleaned-up
// final slide (post math-conversion, if the format asks for it).
async function generateSlide(raw, context, onDelta) {
  const provider = el.providerSelect.value;
  const model = el.modelSelect.value;
  if (!provider || !model) throw new Error(t("remote.noModel"));
  const settings = {
    provider,
    model,
    reasoningEffort: fastestReasoning(provider, model),
    convertMath: el.formatSelect.value !== "latex",
    hybridMath: el.formatSelect.value === "hybrid",
  };
  const prompt =
    "Below is the content of one presentation slide: raw spoken transcript, or an already-finished " +
    "slide followed by more transcript. Turn all of it into exactly one clean slide in Markdown: " +
    "a `## ` title line, then 2-5 concise bullet points. Write in the speaker's own language, " +
    "fix obvious speech-recognition errors, and keep any math in the document's notation. " +
    "Text inside a `$$` block is math the speaker read aloud (e.g. \"x squared plus one\"): write it " +
    "as real math and keep it a display block - a line with just `$$`, the formula, a line with just `$$` - " +
    "on its own between bullets, never inside one. Short math inside bullet text uses `$...$`. " +
    "Output only the slide - no `---` lines, no code fence around it, nothing before or after.\n\n" +
    `Slide content:\n${raw}`;
  const neighbours = context.trim() ? splitSlides(stripInlineThreads(context)).slice(-SLIDE_CONTEXT_SLIDES).join("\n\n---\n\n") : "";
  let text = "";
  let failed = null;
  await api.inlineComplete(active.projectId, active.sessionId, prompt, [], neighbours.trim(), settings, async (event) => {
    if (event.type === "delta") onDelta(event.text);
    else if (event.type === "done") text = event.text;
    else if (event.type === "error") failed = event.message;
  });
  if (failed) throw new Error(failed);
  // Models sometimes wrap the slide in a fence or add separators anyway.
  const slide = text
    .trim()
    .replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1")
    .split("\n")
    .filter((line) => !/^\s*---\s*$/.test(line))
    .join("\n")
    .trim();
  if (!slide) throw new Error(t("remote.emptySlide"));
  return slide;
}

// Replaces `old` (found by `locate()` once the first words arrive) with a
// slide written in as it streams, so the audience watches it form instead
// of waiting for the whole reply; the streamed text is then swapped for the
// cleaned-up final version. The old text's leading/trailing blank lines are
// kept, so the spacing around the `---` lines stays as it was. On failure,
// whatever was streamed is put back to `old`. Resolves to the final text
// now in the document.
async function streamSlideOver(old, locate, raw, context) {
  const lead = old.match(/^\s*/)[0];
  const trail = old.match(/\s*$/)[0];
  let pos = null; // where the streamed text starts
  let shown = "";
  const stillThere = () => pos !== null && el.editor.value.slice(pos, pos + shown.length) === shown;
  try {
    let pending = ""; // leading whitespace held back until real text comes
    const slide = await generateSlide(raw, context, (piece) => {
      let delta = piece;
      if (pos === null) {
        pending += piece;
        if (!pending.trim()) return;
        delta = pending;
        // The old text and the first words swap in one edit: an empty
        // slide in between would drop out of every slideshow's count for
        // that instant (see slides.js), and a viewer on it would be
        // clamped back onto the slide before - and stay there.
        const at = locate();
        if (at === -1) throw new Error(t("remote.lostTranscript"));
        spliceKeepingCaret(at, at + old.length, lead + delta + trail);
        pos = at + lead.length;
      } else if (!stillThere()) {
        throw new Error(t("remote.lostTranscript"));
      } else {
        spliceKeepingCaret(pos + shown.length, pos + shown.length, delta);
      }
      shown += delta;
    });
    if (pos === null) {
      // Nothing streamed (a provider that only delivers the final text).
      const at = locate();
      if (at === -1) throw new Error(t("remote.lostTranscript"));
      spliceKeepingCaret(at, at + old.length, lead + slide + trail);
      return lead + slide + trail;
    }
    if (!stillThere()) throw new Error(t("remote.lostTranscript"));
    spliceKeepingCaret(pos, pos + shown.length, slide);
    return lead + slide + trail;
  } catch (err) {
    if (stillThere()) spliceKeepingCaret(pos - lead.length, pos + shown.length + trail.length, old);
    throw err;
  }
}

// B: clean up the current (last) slide in place and keep talking on it -
// nobody moves, and speech that arrives meanwhile lands in a fresh
// paragraph under it, ready for the next tidy to fold in.
async function tidyCurrentSlide() {
  if (!presenterUsable()) return;
  if (slideJob) return showRemoteStatus(t("remote.busy"));
  const value = el.editor.value;
  const start = lastSlideStart(value);
  const rawRegion = value.slice(start);
  const raw = stripInlineThreads(rawRegion).trim();
  if (!raw) return showRemoteStatus(t("remote.nothingToSlide"));

  // Give speech somewhere else to go first - a new paragraph below - so it
  // keeps flowing while the model works (see rebaseDictation for why the
  // phrase in progress mustn't follow it there).
  rebaseDictation(() => {
    const opener = value.endsWith("\n\n") ? "" : value.endsWith("\n") ? "\n" : "\n\n";
    if (opener) replaceEditorRange(value.length, value.length, opener);
  });

  const job = (slideJob = { tidy: true });
  showRemoteStatus(t("remote.making"), { sticky: true });
  try {
    const locate = () => {
      const current = el.editor.value;
      return current.slice(start, start + rawRegion.length) === rawRegion ? start : current.lastIndexOf(rawRegion);
    };
    const replacement = await streamSlideOver(rawRegion, locate, raw, value.slice(0, start));
    lastMadeSlide = { raw: rawRegion, slide: replacement };
    showRemoteStatus(t("remote.made"));
  } catch (err) {
    showRemoteStatus(t("remote.failed", { message: err.message }));
  } finally {
    if (slideJob === job) slideJob = null;
  }
}

// A: start a new, empty slide right now - no model call. The audience goes
// straight to it (following "last"), blank until speech reaches it; the
// slide just left stays as it is (B tidies a slide, if wanted, before or
// after). Pressing it again on a slide that's still empty does nothing new.
function openNewSlide() {
  if (!presenterUsable()) return;
  const value = el.editor.value;
  if (value.trim() && stripInlineThreads(value.slice(lastSlideStart(value))).trim()) {
    // Through rebaseDictation: a late final result for the phrase just left
    // behind must not also land on the new slide.
    rebaseDictation(() => {
      // Exactly one blank line before the `---`, whatever the slide ends
      // with (a line break from X leaves one already).
      const gap = value.endsWith("\n\n") ? "" : value.endsWith("\n") ? "\n" : "\n\n";
      replaceEditorRange(value.length, value.length, `${gap}---\n\n`);
    });
  }
  presenter.slide = "last";
  sendPresenterUpdate();
  showRemoteStatus(t("remote.newSlide"));
}

// Presenting writes on the last slide - where dictation is when it's on.
// When it's off, the caret can be anywhere (opening a document puts it at
// the top), and a line break or math block from the remote or the glasses
// landing on an earlier slide would be a surprise, so a caret outside the
// last slide goes to the end first. One already on it (say, inside the
// math block the previous press opened) stays where it is.
function caretToDeckEndUnlessDictating() {
  if (dictation) return;
  const value = el.editor.value;
  if (el.editor.selectionStart >= lastSlideStart(value)) return;
  el.editor.setSelectionRange(value.length, value.length);
}

// X: a line break where dictation is writing, so the next thing said starts
// on the next line - inside a math block a single newline, the formula's
// next line; in text a blank line, so the break shows on the slide too
// (Markdown joins single-newline lines into one paragraph).
function breakLine() {
  if (!presenterUsable()) return;
  caretToDeckEndUnlessDictating();
  const pos = el.editor.selectionStart;
  const before = el.editor.value.slice(0, pos);
  if (!before.trim()) return;
  const insert = insideMathBlock(pos) ? "\n" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  // Through rebaseDictation: the phrase in progress stays above the break.
  if (insert) rebaseDictation(() => replaceEditorRange(pos, pos, insert));
  showRemoteStatus(t("remote.lineBreak"));
}

// Y: a math block. Outside one, inserts an empty block -
//   $$
//   (caret here)
//   $$
// - on lines of its own and puts the caret inside, so what's said next is
// written into the formula. Inside one (an odd number of `$$` in the slide
// before the caret), jumps past its closing `$$` to a new paragraph, back to
// ordinary text. Spoken math inside ("x squared plus one") becomes real
// notation on a tidy (B) - see generateSlide's prompt.
function toggleMath() {
  if (!presenterUsable()) return;
  caretToDeckEndUnlessDictating();
  const pos = el.editor.selectionStart;
  const inside = insideMathBlock(pos);
  // Through rebaseDictation: the phrase in progress stays where it was
  // said, and dictation picks up again at the new caret.
  rebaseDictation(() => {
    const caret = toggleMathBlockAt(pos);
    el.editor.setSelectionRange(caret, caret);
  });
  showRemoteStatus(t(inside ? "remote.mathClose" : "remote.mathOpen"));
}

// Whether `pos` is inside a $$ block (an odd number of $$ before it in the
// same slide).
function insideMathBlock(pos, value = el.editor.value) {
  const before = value.slice(0, pos);
  return (before.slice(lastSlideStart(before)).match(/\$\$/g) || []).length % 2 === 1;
}

// The edit behind both the Y button / glasses up and the spoken "수식시작"
// / "수식끝": outside a block, inserts an empty one -
//   $$
//   (here)
//   $$
// - and inside one, leaves it past its closing $$ (adding one if it was
// deleted). Returns where writing continues.
function toggleMathBlockAt(pos, buf) {
  const value = buf ? buf.value : el.editor.value;
  const replace = (from, to, text) => (buf ? buf.replaceRange(from, to, text) : replaceEditorRange(from, to, text));
  const current = () => (buf ? buf.value : el.editor.value);
  const before = value.slice(0, pos);
  if (!insideMathBlock(pos, value)) {
    const lead = !before.trim() || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const rest = value.slice(pos);
    const tail = rest && !rest.startsWith("\n") ? "\n\n" : "";
    replace(pos, pos, `${lead}$$\n\n$$${tail}`);
    return pos + lead.length + 3;
  }
  const close = value.indexOf("$$", pos);
  if (close === -1) {
    // No closing line (it was deleted): close the formula here instead.
    const end = value.length;
    replace(end, end, `${value.endsWith("\n") ? "" : "\n"}$$\n\n`);
  } else {
    const afterClose = close + 2;
    const next = value.slice(afterClose, afterClose + 2);
    const gap = next === "\n\n" ? "" : next.startsWith("\n") ? "\n" : "\n\n";
    if (gap) replace(afterClose, afterClose, gap);
  }
  const text = current();
  const caretAt = text.indexOf("$$", pos) + 2;
  let caret = caretAt;
  while (text[caret] === "\n" && caret < caretAt + 2) caret += 1;
  return caret;
}

function locateLastMadeSlide() {
  if (!lastMadeSlide) return -1;
  return el.editor.value.lastIndexOf(lastMadeSlide.slide);
}

function undoLastSlide() {
  if (!presenterUsable() || slideJob) return;
  const at = locateLastMadeSlide();
  if (at === -1) return showRemoteStatus(t("remote.nothingToUndo"));
  const { raw, slide } = lastMadeSlide;
  spliceKeepingCaret(at, at + slide.length, raw);
  lastMadeSlide = null;
  showRemoteStatus(t("remote.undone"));
}

async function regenerateLastSlide() {
  if (!presenterUsable()) return;
  if (slideJob) return showRemoteStatus(t("remote.busy"));
  if (locateLastMadeSlide() === -1) return showRemoteStatus(t("remote.nothingToUndo"));
  const target = lastMadeSlide;
  const job = (slideJob = { regenerate: true });
  showRemoteStatus(t("remote.making"), { sticky: true });
  try {
    const at = el.editor.value.lastIndexOf(target.slide);
    const locate = () => el.editor.value.lastIndexOf(target.slide);
    const replacement = await streamSlideOver(target.slide, locate, stripInlineThreads(target.raw).trim(), el.editor.value.slice(0, at));
    lastMadeSlide = { ...target, slide: replacement };
    showRemoteStatus(t("remote.made"));
  } catch (err) {
    showRemoteStatus(t("remote.failed", { message: err.message }));
  } finally {
    if (slideJob === job) slideJob = null;
  }
}

// `delta` steps from where the audience is; `to` ("first" / "last") jumps.
// Landing on the last slide always means following it ("last"), so the
// audience rides along as new slides are built.
function movePresenter(delta, to = null) {
  if (!active) return;
  const count = splitSlides(stripInlineThreads(el.editor.value), { keepEmptyLast: true }).length;
  const current = presenter.slide === null || presenter.slide === "last" ? count - 1 : Math.min(presenter.slide, count - 1);
  const target = to === "first" ? 0 : to === "last" ? count - 1 : current + delta;
  const next = Math.max(0, Math.min(count - 1, target));
  presenter.slide = next === count - 1 ? "last" : next;
  sendPresenterUpdate();
  showRemoteStatus(t("remote.slidePosition", { n: next + 1, total: count }));
}

// Default layout for an 8BitDo Micro-style pad in the browser's "standard"
// mapping: the face buttons drive the writing, the D-pad drives what the
// audience sees. Face buttons are numbered by position (0 bottom, 1 right,
// 2 left, 3 top), which on a Nintendo-labelled pad is B, A, Y, X; the D-pad
// is 12 up, 13 down, 14 left, 15 right. A pad that reports differently is
// fixed up once in the 🎮 dialog. Undo/regenerate exist but have no
// default button.
const remote = createGamepadRemote({
  actions: [
    { id: "newSlide", label: t("remote.action.newSlide"), defaultBinding: { type: "button", index: 1 } },
    { id: "lineBreak", label: t("remote.action.lineBreak"), defaultBinding: { type: "button", index: 3 } },
    { id: "tidySlide", label: t("remote.action.tidySlide"), defaultBinding: { type: "button", index: 0 } },
    { id: "toggleMath", label: t("remote.action.toggleMath"), defaultBinding: { type: "button", index: 2 } },
    { id: "prevSlide", label: t("remote.action.prevSlide"), defaultBinding: { type: "button", index: 12 } },
    { id: "nextSlide", label: t("remote.action.nextSlide"), defaultBinding: { type: "button", index: 13 } },
    { id: "firstSlide", label: t("remote.action.firstSlide"), defaultBinding: { type: "button", index: 15 } },
    { id: "lastSlide", label: t("remote.action.lastSlide"), defaultBinding: { type: "button", index: 14 } },
    { id: "undoSlide", label: t("remote.action.undoSlide"), defaultBinding: null },
    { id: "regenerateSlide", label: t("remote.action.regenerateSlide"), defaultBinding: null },
  ],
  onAction(id) {
    if (presenter.slide === null) presenter.slide = "last";
    if (id === "newSlide") openNewSlide();
    else if (id === "tidySlide") tidyCurrentSlide();
    else if (id === "lineBreak") breakLine();
    else if (id === "toggleMath") toggleMath();
    else if (id === "prevSlide") movePresenter(-1);
    else if (id === "nextSlide") movePresenter(1);
    else if (id === "firstSlide") movePresenter(0, "first");
    else if (id === "lastSlide") movePresenter(0, "last");
    else if (id === "undoSlide") undoLastSlide();
    else if (id === "regenerateSlide") regenerateLastSlide();
  },
  onConnectionChange(pad) {
    el.remoteBtn.hidden = !pad;
    el.remoteBtn.title = pad ? t("remote.buttonTitle", { id: pad.id }) : "";
  },
});
el.remoteBtn.addEventListener("click", () => remote.openSettings());

// ---------- edits from elsewhere (same document open in two browsers) ----------
//
// A Save writes the file; another browser with the same document open used
// to keep showing its old copy until reloaded. Each open document now
// remembers the version it was loaded/saved at (the file's mtime - see
// storage.poll_document) and asks the server every few seconds while the
// tab is visible, and right away when the window regains focus. When the
// file moved on:
//   - nothing unsaved here: the saved content is applied in place, caret
//     kept (only the changed span is rewritten);
//   - unsaved edits here (pane A): never overwritten - a "saved elsewhere"
//     pill offers to load theirs or keep mine. Keeping just stops asking
//     about that version; the next Save here wins, as before.
// Pane B (split view) syncs the same way but only while it has no unsaved
// edits of its own - it has no room for the pill.
// Saved snapshots from the single-writer iPhone editor arrive immediately.
// Existing HTTP polling remains as a fallback after a dropped connection.
var documentFollowers = ["a", "b"].map(pane => createDocumentFollower({
  onUpdate(ref, message) {
    const doc = pane === "a" ? active : activeB;
    if (!doc || doc.projectId !== ref.projectId || doc.sessionId !== ref.sessionId || doc.filename !== ref.filename) return;
    if (pane === "a" && (streaming || slideJob || dictation)) return;
    const editor = pane === "a" ? el.editor : el.editorB;
    if (pane === "a" ? isDirty() : isDirtyB()) return;
    if (doc.version === message.version && editor.value === message.content) return;
    doc.liveRevision = (doc.liveRevision || 0) + 1;
    doc.version = message.version;
    if (pane === "a") {
      hideSyncConflict();
      applyRemoteToA(message.content);
    } else {
      applyTextKeepingCaret(editor, message.content);
      doc.savedContent = message.content;
      cacheDocumentContent(doc, message.content);
      updateFilenameLabelB();
      renderPreviewB();
    }
  }
}));
function syncDocumentFollowers() {
  if (!documentFollowers) return;
  documentFollowers[0].follow(syncable(active) ? active : null);
  documentFollowers[1].follow(splitViewOpen() && syncable(activeB) ? activeB : null);
}
window.addEventListener("pagehide", () => documentFollowers.forEach(follower => follower.close()));
window.addEventListener("pageshow", syncDocumentFollowers);

const SYNC_INTERVAL_MS = 4000;
let pendingRemote = null; // { doc, content } while the pill is showing
let syncInFlight = false;

function syncable(doc) {
  return !!doc && !!doc.sessionId && !!doc.filename && doc.version !== undefined;
}

function hideSyncConflict() {
  pendingRemote = null;
  el.syncConflict.hidden = true;
}

// Rewrites only what differs between the two texts, through the editor's
// caret-preserving edit, so the caret and scroll stay put unless the change
// was exactly where they are.
function applyTextKeepingCaret(editor, next) {
  const prev = editor.value;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev -= 1;
    endNext -= 1;
  }
  editor.replaceRangeKeepingSelection(start, endPrev, next.slice(start, endNext));
}

function cacheDocumentContent(doc, content) {
  const project = projects.get(doc.projectId);
  const session = project && project.sessions && project.sessions.get(doc.sessionId);
  const cached = session && session.documents && session.documents.find((d) => d.filename === doc.filename);
  if (cached) {
    cached.content = content;
    cached.version = doc.version;
  }
}

function applyRemoteToA(content) {
  applyTextKeepingCaret(el.editor, content);
  active.savedContent = content;
  cacheDocumentContent(active, content);
  clearAutosave();
  updateFilenameLabel();
  updateFormatToolbar();
  renderPreview();
}

async function pollPane(pane) {
  const doc = pane === "a" ? active : activeB;
  if (!syncable(doc)) return;
  if (pane === "a" && (streaming || slideJob || dictation)) return;
  const liveRevision = doc.liveRevision || 0;
  let result;
  try {
    result = await api.pollDocument(doc.projectId, doc.sessionId, doc.filename, doc.version);
  } catch (err) {
    return; // offline, deleted, signed out - try again next round
  }
  // The document may have been switched (or a send started) meanwhile.
  if ((pane === "a" ? active : activeB) !== doc || (pane === "a" && (streaming || slideJob || dictation))) return;
  if ((doc.liveRevision || 0) !== liveRevision) return; // A newer WebSocket snapshot arrived while polling.
  doc.version = result.version;
  if (!result.changed) return;
  const editor = pane === "a" ? el.editor : el.editorB;
  const { content } = result;
  if (content === editor.value || content === doc.savedContent) {
    // Our own save, or a write that left the text as it is here already.
    if (content === editor.value) doc.savedContent = content;
    if (pane === "a") updateFilenameLabel();
    else updateFilenameLabelB();
    return;
  }
  if (pane === "a") {
    if (!isDirty()) {
      applyRemoteToA(content);
      showRemoteStatus(t("sync.applied"));
    } else {
      pendingRemote = { doc, content };
      el.syncConflict.hidden = false;
    }
    return;
  }
  if (!isDirtyB()) {
    applyTextKeepingCaret(el.editorB, content);
    activeB.savedContent = content;
    cacheDocumentContent(activeB, content);
    updateFilenameLabelB();
    renderPreviewB();
  }
}

async function syncOpenDocuments() {
  if (syncInFlight || document.visibilityState !== "visible") return;
  syncInFlight = true;
  try {
    await pollPane("a");
    if (splitViewOpen()) await pollPane("b");
  } finally {
    syncInFlight = false;
  }
}

setInterval(syncOpenDocuments, SYNC_INTERVAL_MS);
window.addEventListener("focus", syncOpenDocuments);
document.addEventListener("visibilitychange", syncOpenDocuments);
el.syncLoadBtn.addEventListener("click", () => {
  if (pendingRemote && pendingRemote.doc === active) applyRemoteToA(pendingRemote.content);
  hideSyncConflict();
  el.editor.focus();
});
el.syncKeepBtn.addEventListener("click", () => {
  hideSyncConflict();
  el.editor.focus();
});

// Unlike send/publish, exporting/downloading has no NON_SENDABLE_ROLES
// restriction - a system prompt or a read-only Hermes transcript is just as
// printable/downloadable as any other document, there's simply nothing
// document-specific to send or publish about it.
function updateExportPdfButton() {
  el.exportPdfBtn.disabled = !active;
  el.downloadMdBtn.disabled = !active;
}

function buildDocumentRow(projectId, sessionId, doc) {
  const row = document.createElement("div");
  row.className = "document-row";
  if (
    active &&
    active.projectId === projectId &&
    active.sessionId === sessionId &&
    active.filename === doc.filename
  ) {
    row.classList.add("active");
  }
  if (
    activeB &&
    activeB.projectId === projectId &&
    activeB.sessionId === sessionId &&
    activeB.filename === doc.filename
  ) {
    row.classList.add("active-b");
  }

  const badge = document.createElement("span");
  badge.className = `doc-role-badge role-${doc.role}`;
  badge.textContent = ROLE_LABEL[doc.role] || "?";
  badge.title = roleTitle(doc.role);

  const name = document.createElement("span");
  name.className = "doc-filename";
  name.textContent = doc.filename;

  row.append(badge, name);
  // Looked up by alt-hint mode below (enterAltHintMode/altHintRowFor) to
  // find this row again without threading DOM references through the
  // project/session data model.
  row.dataset.projectId = projectId;
  row.dataset.sessionId = sessionId;
  row.dataset.filename = doc.filename;

  // system.md never appears as a row here (see buildSessionNode), and every
  // action below is for real documents only.
  if (doc.role !== "system") {
    // A document row shows just ✎ and ⋯; rename stays in the menu too.
    const renameBtn = iconButton("✎", t("doc.rename"));
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameDocument(projectId, sessionId, doc.filename);
    });
    row.appendChild(renameBtn);
    attachRowMenu(row, row, (feedbackEl) => [
      { icon: "✎", label: t("doc.rename"), onSelect: () => renameDocument(projectId, sessionId, doc.filename) },
      ...(!doc.filename.endsWith(".c.md")
        ? [{ icon: "+", label: t("doc.createConversationFile"), onSelect: () => createConversationFile(projectId, sessionId, doc.filename) }]
        : []),
      // The inverse of sending a draft (storage.start_exchange's
      // draft_filename) - only a real turn has anything to revert.
      ...(doc.role !== "draft"
        ? [{ icon: "↩", label: t("doc.revertToDraft"), onSelect: () => revertDocumentToDraft(projectId, sessionId, doc.filename) }]
        : []),
      { icon: "⧉", label: t("doc.copyLink"), onSelect: () => copyDocumentLink(feedbackEl, sessionId, doc.filename, firstH1Heading(doc.content)) },
      {
        icon: "⏺",
        label: doc.recordings ? t("doc.recordings", { count: doc.recordings }) : t("doc.recordingsNone"),
        onSelect: () => showRecordings(projectId, sessionId, doc.filename),
      },
      "-",
      { icon: "↗", label: t("doc.openInNewTab"), onSelect: () => window.open(documentUrl(projectId, sessionId, doc.filename), "_blank", "noopener") },
      // Same as ⌘/Ctrl-clicking the row (see the click handler below),
      // spelled out for anyone who wouldn't know the modifier exists.
      { icon: "⇥", label: t("doc.openToSide"), onSelect: () => selectDocumentB(projectId, sessionId, doc.filename) },
      "-",
      { icon: "×", label: t("doc.delete"), danger: true, onSelect: () => removeDocument(projectId, sessionId, doc.filename, doc.role) },
    ]);
  }

  row.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) {
      selectDocumentB(projectId, sessionId, doc.filename);
      return;
    }
    openInTab(docRef(projectId, sessionId, doc.filename));
  });

  // system.md never appears as a row here (filtered out where this is
  // called - see buildSessionNode), so no separate role guard is needed.
  // See startRowDrag's own comment for why this is pointerdown-driven
  // rather than native draggable/dragstart.
  row.addEventListener("pointerdown", (e) => {
    startRowDrag(e, { type: "document", projectId, sessionId, filename: doc.filename, role: doc.role }, row);
  });

  return row;
}

// A shareable-within-this-browser URL for a document, read back by
// parseDocumentUrlRef() at startup - what "새 탭에서 열기"/openTabBtn above
// opens, and how the new tab lands on that exact document instead of
// whatever restoreActiveDocument's localStorage fallback would otherwise
// pick (see init() below).
function documentUrl(projectId, sessionId, filename) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("project", projectId);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("file", filename);
  return url.toString();
}

// The inverse of documentUrl() above - a tab opened from "새 탭에서 열기"
// carries its document in the query string rather than (only) in
// localStorage, so distinct tabs can each stay pinned to their own
// document instead of all converging on whichever one last saved
// ACTIVE_DOC_KEY.
function parseDocumentUrlRef() {
  const params = new URLSearchParams(location.search);
  const projectId = params.get("project");
  const sessionId = params.get("session");
  const filename = params.get("file");
  if (!projectId || !sessionId || !filename) return null;
  return { role: "document", projectId, sessionId, filename };
}

// Builds a link that can be pasted into any other document to link back to
// this one - the whole point being nobody has to remember or hand-type a
// folder's id. Omits the "<sessionId>/" prefix when the link is being
// copied from the same folder that's currently open in the editor (the
// common case, and the one place a bare filename is both valid and nicer
// to read) - otherwise it's a cross-folder link and needs the qualifier.
// `heading` is the document's own first-level heading (see
// firstH1Heading, from asciimath-markdown), if it has one - when it does, the copied
// link reads as "[heading](target)" (a real Markdown link, with something
// a reader would actually want to click on as its label) instead of the
// bare "[[wikilink]]" (see openInternalDocumentLink below, and the
// wikilink support in asciimath-markdown) fallback,
// which renders with the raw filename as its own label.
async function copyDocumentLink(btn, sessionId, filename, heading) {
  const target = active && active.sessionId === sessionId ? filename : `${sessionId}/${filename}`;
  const ref = heading ? `[${heading}](${target})` : `[[${target}]]`;
  if (!(await copyToClipboard(ref))) {
    prompt(t("prompt.copyShareLink"), ref);
    return;
  }
  const original = btn.textContent;
  btn.textContent = "✅";
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

// `allSessions` is the project's whole flat sessions Map (see
// buildProjectNode/refreshProjectSessions) - folders are stored flat,
// keyed by id, each carrying its own meta.parent_id; the tree shape itself
// only ever exists at render time, built here by filtering that same Map
// for whichever id is `id`'s own parent. Recurses into its own child
// folders exactly like it recurses into nothing else - a folder can hold
// both documents and subfolders at once (see docList/childBody below),
// same as any ordinary filesystem folder.
function buildSessionNode(projectId, id, session, allSessions) {
  const node = document.createElement("div");
  node.className = "session-node";

  const row = document.createElement("div");
  row.className = "session-row";
  if (active && active.projectId === projectId && active.sessionId === id && active.role === "system") {
    row.classList.add("active");
  }

  const disclosure = document.createElement("span");
  disclosure.className = "disclosure" + (session.expanded ? " expanded" : "");
  disclosure.textContent = "▶";

  const title = document.createElement("span");
  title.className = "session-title";
  title.textContent = session.meta.title;

  const actions = document.createElement("span");
  actions.className = "session-actions";
  const newDocBtn = iconButton("+", t("folder.newDoc"));
  actions.append(newDocBtn);

  row.append(disclosure, title, actions);
  row.addEventListener("click", () => toggleSession(projectId, id));
  newDocBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    createDraft(projectId, id);
  });
  attachRowMenu(row, actions, () => [
    { icon: "+", label: t("folder.newDoc"), onSelect: () => createDraft(projectId, id) },
    { icon: "📁", label: t("folder.newSubfolder"), onSelect: () => createSubfolder(projectId, id) },
    { icon: "🎙", label: t("folder.transcribe"), onSelect: () => transcribeIntoSession(projectId, id) },
    "-",
    { icon: "S", label: t("folder.systemPrompt"), onSelect: () => openSessionSystemPrompt(projectId, id) },
    { icon: "✎", label: t("doc.rename"), onSelect: () => renameSession(projectId, id) },
    { icon: "⤓", label: t("folder.exportPdfShort"), onSelect: () => exportSessionToPdf(projectId, id) },
    "-",
    { icon: "×", label: t("folder.delete"), danger: true, onSelect: () => removeSession(projectId, id) },
  ]);

  // dataset identity read back by onRowDragMove/onRowDragEnd's
  // elementFromPoint hit-testing - see startRowDrag's comment for why this
  // is pointerdown-driven rather than native draggable/dragstart/dragover.
  row.dataset.projectId = projectId;
  row.dataset.sessionId = id;
  row.addEventListener("pointerdown", (e) => {
    startRowDrag(e, { type: "folder", projectId, sessionId: id }, row);
  });

  node.appendChild(row);

  const docList = document.createElement("div");
  docList.className = "document-list";
  docList.hidden = !session.expanded;
  if (session.expanded) {
    // system.md is reachable via the row's "⋯" menu above now, not
    // listed here - keeps the list to documents you'd actually browse
    // (turns/drafts), and matches how the project- and global-level system
    // prompts are reached (an icon, not a row in some list).
    const listable = session.documents === null ? null : session.documents.filter((d) => d.role !== "system");
    if (listable === null) {
      const loading = document.createElement("div");
      loading.className = "doc-empty";
      loading.textContent = t("common.loading");
      docList.appendChild(loading);
    } else if (listable.length === 0) {
      // Nothing to say here - an empty folder is already obvious from its
      // document list being empty, same as an empty filesystem folder.
    } else {
      for (const doc of listable) {
        docList.appendChild(buildDocumentRow(projectId, id, doc));
      }
    }
  }
  node.appendChild(docList);

  // Child folders - same expand/collapse gate as the document list above,
  // and the same 14px indent .project-body already uses for sessions
  // nested under a project (nesting a folder under a folder just stacks
  // that same rule one level deeper).
  const childBody = document.createElement("div");
  childBody.className = "project-body";
  childBody.hidden = !session.expanded;
  if (session.expanded) {
    for (const [childId, childSession] of allSessions) {
      if (childSession.meta.parent_id === id) {
        childBody.appendChild(buildSessionNode(projectId, childId, childSession, allSessions));
      }
    }
  }
  node.appendChild(childBody);

  return node;
}

function buildProjectNode(id, project) {
  const node = document.createElement("div");
  node.className = "project-node";

  const row = document.createElement("div");
  row.className = "project-row";
  if (active && active.projectId === id && active.role === "project-system") {
    row.classList.add("active");
  }

  const disclosure = document.createElement("span");
  disclosure.className = "disclosure" + (project.expanded ? " expanded" : "");
  disclosure.textContent = "▶";

  const title = document.createElement("span");
  title.className = "project-title";
  title.textContent = project.meta.title;

  const actions = document.createElement("span");
  actions.className = "session-actions";
  const newSessionBtn = iconButton("+", t("project.newFolder"));
  actions.append(newSessionBtn);

  row.append(disclosure, title, actions);
  row.addEventListener("click", () => toggleProject(id));
  newSessionBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    createSession(id);
  });
  attachRowMenu(row, actions, () => [
    { icon: "+", label: t("project.newFolder"), onSelect: () => createSession(id) },
    "-",
    { icon: "S", label: t("project.systemPrompt"), onSelect: () => openInTab({ role: "project-system", projectId: id }) },
    { icon: "✎", label: t("doc.rename"), onSelect: () => renameProject(id) },
    "-",
    { icon: "×", label: t("project.delete"), danger: true, onSelect: () => removeProject(id) },
  ]);

  // The project row itself isn't a drag source (projects don't move) -
  // just a drop target, read back by onRowDragMove/onRowDragEnd's
  // elementFromPoint hit-testing, for a folder dragged back to this
  // project's top level (moveConversation's parent_id: null). See
  // startRowDrag's comment for why dragging is pointer-driven at all.
  row.dataset.projectId = id;

  node.appendChild(row);

  const body = document.createElement("div");
  body.className = "project-body";
  body.hidden = !project.expanded;
  if (project.expanded) {
    if (project.sessions === null) {
      const loading = document.createElement("div");
      loading.className = "doc-empty";
      loading.textContent = t("common.loading");
      body.appendChild(loading);
    } else if (project.sessions.size === 0) {
      const empty = document.createElement("div");
      empty.className = "doc-empty";
      empty.textContent = t("project.noFolders");
      body.appendChild(empty);
    } else {
      // Only top-level folders (no parent) start the walk - each one pulls
      // in its own subfolders recursively (see buildSessionNode), so a
      // folder with a parent is never also rendered again here.
      for (const [sessionId, session] of project.sessions) {
        if (!session.meta.parent_id) {
          body.appendChild(buildSessionNode(id, sessionId, session, project.sessions));
        }
      }
    }
  }
  node.appendChild(body);
  return node;
}

function renderTree() {
  el.sessionTree.innerHTML = "";
  for (const [id, project] of projects) {
    el.sessionTree.appendChild(buildProjectNode(id, project));
  }
  el.globalSystemRow.classList.toggle("active", !!active && active.role === "global-system");
  el.globalCustomSymbolsRow.classList.toggle("active", !!active && active.role === "global-custom-symbols");
  el.globalSpokenMathRow.classList.toggle("active", !!active && active.role === "global-spoken-math");
  renderHermesList();
}

function formatHermesTime(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildHermesRow(session) {
  const row = document.createElement("div");
  row.className = "hermes-row";
  if (active && active.role === "hermes-session" && active.hermesSessionId === session.id) {
    row.classList.add("active");
  }

  const title = document.createElement("span");
  title.className = "hermes-row-title";
  title.textContent = session.title || session.preview || session.id;

  const meta = document.createElement("span");
  meta.className = "hermes-row-meta";
  const bits = [session.source, t("hermes.msgCount", { count: session.message_count })];
  if (session.tool_call_count) bits.push(t("hermes.toolCount", { count: session.tool_call_count }));
  bits.push(formatHermesTime(session.last_active || session.started_at));
  meta.textContent = bits.filter(Boolean).join(" · ");

  row.append(title, meta);
  row.addEventListener("click", () => openInTab({ role: "hermes-session", hermesSessionId: session.id, hermesTitle: session.title }));
  return row;
}

function renderHermesList() {
  el.hermesDisclosure.classList.toggle("expanded", hermesExpanded);
  el.hermesList.hidden = !hermesExpanded;
  el.hermesList.innerHTML = "";
  if (!hermesExpanded) return;

  if (hermesError) {
    const err = document.createElement("div");
    err.className = "doc-empty";
    err.textContent = hermesError;
    el.hermesList.appendChild(err);
    return;
  }
  if (hermesSessions === null) {
    const loading = document.createElement("div");
    loading.className = "doc-empty";
    loading.textContent = t("common.loading");
    el.hermesList.appendChild(loading);
    return;
  }
  if (hermesSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "doc-empty";
    empty.textContent = t("hermes.noSessions");
    el.hermesList.appendChild(empty);
    return;
  }
  for (const session of hermesSessions) {
    el.hermesList.appendChild(buildHermesRow(session));
  }
  if (hermesHasMore) {
    const moreBtn = document.createElement("button");
    moreBtn.className = "hermes-more-btn";
    moreBtn.textContent = t("hermes.loadMore");
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadMoreHermesSessions();
    });
    el.hermesList.appendChild(moreBtn);
  }
}

async function toggleHermesSection() {
  hermesExpanded = !hermesExpanded;
  if (hermesExpanded && hermesSessions === null) {
    renderHermesList();
    await loadHermesSessions();
  }
  renderHermesList();
}

async function loadHermesSessions() {
  hermesError = null;
  try {
    const result = await api.getHermesSessions(0);
    hermesSessions = result.data;
    hermesOffset = result.data.length;
    hermesHasMore = !!result.has_more;
  } catch (err) {
    hermesSessions = [];
    hermesError = t("hermes.loadFailed", { message: err.message });
  }
}

async function loadMoreHermesSessions() {
  try {
    const result = await api.getHermesSessions(hermesOffset);
    hermesSessions = [...(hermesSessions || []), ...result.data];
    hermesOffset += result.data.length;
    hermesHasMore = !!result.has_more;
  } catch (err) {
    hermesError = t("hermes.loadMoreFailed", { message: err.message });
  }
  renderHermesList();
}

// Builds a readable markdown transcript from a Hermes session's raw message
// list, using the same "## <heading>" markers (via i18n.js's chat.userHeading/
// chat.assistantHeading) that sendActive() attaches to a real turn, so
// renderMarkdown()'s math handling (LaTeX $$...$$ etc. - Hermes replies
// often contain it) applies the same way it does to mark-vector's own
// turns. Unlike a real turn, this transcript is display-only - never saved,
// never parsed back into sections - so there's no storage.py-side format to
// stay in sync with here. Tool calls and their results are left out
// entirely - just the user/assistant conversation content, same as what
// mark-vector's own turns show. "session_meta" rows and anything with no
// content are also skipped - they carry nothing to show.
function buildHermesTranscript(messages) {
  const parts = [];
  for (const m of messages) {
    if (m.role === "user" && m.content) {
      parts.push(`${t("chat.userHeading")}\n\n${m.content}`);
    } else if (m.role === "assistant" && m.content) {
      parts.push(`${t("chat.assistantHeading")}\n\n${m.content}`);
    }
  }
  return parts.length ? parts.join("\n\n---\n\n") : t("hermes.emptySession");
}

async function selectHermesSession(session) {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  let text;
  try {
    const result = await api.getHermesSessionMessages(session.id);
    text = buildHermesTranscript(result.data);
  } catch (err) {
    alert(t("hermes.loadFailed", { message: err.message }));
    return;
  }

  active = {
    hermesSessionId: session.id,
    filename: session.title || session.id,
    role: "hermes-session",
    savedContent: text,
  };
  saveActiveDocRef();
  el.editor.value = text;
  el.editor.disabled = true;
  el.saveBtn.disabled = true;
  el.sendBtn.disabled = true;
  updateInlineCompleteButton();
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
}

async function loadProjects() {
  const list = await api.listProjects();
  const next = new Map();
  for (const summary of list) {
    const prev = projects.get(summary.id);
    next.set(summary.id, {
      meta: summary,
      sessions: prev ? prev.sessions : null,
      expanded: prev ? prev.expanded : expandedTreeState.projects.has(summary.id),
      systemPromptContent: prev ? prev.systemPromptContent : "",
    });
  }
  projects = next;
  renderTree();
}

async function refreshProjectSessions(projectId) {
  const project = projects.get(projectId);
  if (!project) return;
  const [list, systemPrompt] = await Promise.all([
    api.listConversations(projectId),
    api.getProjectSystemPrompt(projectId),
  ]);
  const next = new Map();
  for (const summary of list) {
    const prev = project.sessions && project.sessions.get(summary.id);
    next.set(summary.id, {
      meta: summary,
      documents: prev ? prev.documents : null,
      expanded: prev ? prev.expanded : expandedTreeState.sessions.has(summary.id),
    });
  }
  project.sessions = next;
  project.systemPromptContent = systemPrompt.content;
  project.expanded = true;
}

async function refreshSessionDocs(projectId, id) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(id);
  if (!session) return;
  session.documents = await api.listDocuments(projectId, id);
  session.expanded = true;
}

// ---------- quick open (⌘/Ctrl+P, ⌘/Ctrl+K, or the 🔍 button) ----------
// Fuzzy jump to any plain document in any project/folder - a wider net than
// the ⌃/⌥ digit hints (recent + this folder only). Scoped to plain documents for the same reason selectDocumentB is:
// system prompts and Hermes transcripts aren't reached the same way a
// regular document is, and folding them in would mean either a second kind
// of result row or a result that silently can't do what the rest do.

// Every project's sessions, and every session's documents, loaded (fetching
// whatever isn't already cached - see loadProjects/refreshProjectSessions'
// own null-until-fetched convention) so the index below can actually be
// global instead of just whatever the tree happened to have expanded.
// Re-run on every open rather than cached separately: a project/session
// already loaded resolves instantly (these are the same `projects` records
// the tree itself reads), so the only real cost is ever paid once per
// project/folder, the first time anything in this app asks about it.
async function ensureFullTreeLoaded() {
  for (const [projectId, project] of projects) {
    if (project.sessions === null) {
      try {
        await refreshProjectSessions(projectId);
      } catch (err) {
        // leave that project's folders unlisted - see restoreActiveDocument's
        // own comment on why a failed fetch here isn't worth surfacing
      }
    }
  }
  const fetches = [];
  for (const [projectId, project] of projects) {
    if (!project.sessions) continue;
    for (const [sessionId, session] of project.sessions) {
      if (session.documents === null) fetches.push(refreshSessionDocs(projectId, sessionId).catch(() => {}));
    }
  }
  await Promise.all(fetches);
}

// The flat list quickOpenFilter searches - rebuilt from `projects` on every
// open (see ensureFullTreeLoaded above) rather than kept incrementally in
// sync, since nothing about creating/deleting/renaming a document anywhere
// in the tree would otherwise remember to update a separate index.
function buildQuickOpenIndex() {
  const entries = [];
  for (const [projectId, project] of projects) {
    if (!project.sessions) continue;
    for (const [sessionId, session] of project.sessions) {
      if (!session.documents) continue;
      for (const doc of session.documents) {
        if (doc.role === "system") continue;
        entries.push({
          projectId,
          sessionId,
          filename: doc.filename,
          role: doc.role,
          projectTitle: project.meta.title,
          sessionTitle: session.meta.title,
        });
      }
    }
  }
  return entries;
}

// A minimal subsequence fuzzy match: every character of `query` (lowercased)
// has to appear in `text`, in order, but not necessarily adjacent - "qo"
// matches "quick-open.md". Returns null for no match, else a score where
// lower is a better match (characters found earlier, and consecutively,
// score better) plus the matched indices, for `markMatches` below to
// highlight. Deliberately not a fancier scorer (no camelCase/word-boundary
// bonuses) - filenames here are short and mostly flat, so plain subsequence
// distance already separates good matches from noise.
function fuzzyMatch(query, text) {
  if (!query) return { score: 0, indices: [] };
  const lowerText = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let lastMatch = -1;
  const indices = [];
  for (const ch of query.toLowerCase()) {
    const found = lowerText.indexOf(ch, ti);
    if (found === -1) return null;
    score += found - ti; // gap since the cursor - 0 for a consecutive run
    score += lastMatch === -1 ? found : 0; // an early first match beats a late one
    indices.push(found);
    lastMatch = found;
    ti = found + 1;
  }
  return { score, indices };
}

// Wraps the characters at `indices` in <mark> for the highlight in
// .quick-open-row-filename mark (see style.css) - text is escaped first
// since it's a real filename, not markup.
function markMatches(text, indices) {
  const escaped = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  if (!indices.length) return escaped(text);
  let out = "";
  let cursor = 0;
  const indexSet = new Set(indices);
  for (let i = 0; i < text.length; i++) {
    if (indexSet.has(i)) {
      out += `<mark>${escaped(text[i])}</mark>`;
    } else {
      out += escaped(text[i]);
    }
  }
  return out;
}

let quickOpenEntries = [];
let quickOpenFiltered = [];
let quickOpenSelected = 0;

// Best-of-two: matched against the bare filename (what you'd normally type)
// and against "project / folder / filename" (so typing part of a project or
// folder name also finds something) - whichever matches, the better score
// wins; a query that matches neither drops the entry.
//
// With nothing typed yet, the three most recently opened documents lead the
// list (the same recentDocs the ⌥1-3 jump keys use, and likewise skipping the
// one that's open right now, so the first row is "back to where I was"),
// then everything else in tree order without repeating them.
const QUICK_OPEN_RECENT_COUNT = 3;
function quickOpenFilter(query) {
  if (!query.trim()) {
    const sameDoc = (a, b) => a.projectId === b.projectId && a.sessionId === b.sessionId && a.filename === b.filename;
    const recent = [];
    for (const r of recentDocs) {
      if (recent.length === QUICK_OPEN_RECENT_COUNT) break;
      if (active && sameDoc(r, active)) continue;
      const entry = quickOpenEntries.find((e) => sameDoc(e, r));
      if (entry) recent.push(entry);
    }
    return [
      ...recent.map((entry) => ({ entry, indices: [], recent: true })),
      ...quickOpenEntries.filter((entry) => !recent.includes(entry)).map((entry) => ({ entry, indices: [] })),
    ];
  }
  const results = [];
  for (const entry of quickOpenEntries) {
    const path = `${entry.projectTitle} / ${entry.sessionTitle} / ${entry.filename}`;
    const byName = fuzzyMatch(query, entry.filename);
    const byPath = fuzzyMatch(query, path);
    if (!byName && !byPath) continue;
    const best = byName && (!byPath || byName.score <= byPath.score) ? byName : byPath;
    // Indices are only ever shown against the filename (see renderQuickOpenResults)
    // - a match found only in the path (project/folder name) highlights nothing,
    // rather than mis-highlighting unrelated characters in the filename.
    const indices = best === byName ? best.indices : [];
    results.push({ entry, score: best.score, indices });
  }
  results.sort((a, b) => a.score - b.score || a.entry.filename.localeCompare(b.entry.filename));
  return results;
}

// Rebuilds every row - only for an actual change in *which documents are
// shown* (typing, or the first render on open). Hovering a row only moves
// which one is selected (see applyQuickOpenSelection below) without
// touching the DOM: replacing the row currently under a motionless cursor
// used to retrigger that same row's own "mouseenter" (a new element occupies
// the old one's rectangle, and Chrome/Safari both re-fire it for a mutation
// under the pointer even though the pointer never moved), which reran this
// function, which replaced the row again - a synchronous loop that pinned
// the main thread and made the whole palette look dead: no click, arrow key
// or Enter could get a turn once it started. A `.click()` triggered by
// JavaScript, with no real mouse movement, never hits this at all - which is
// exactly why it went unnoticed here and had to be reported from real use.
function renderQuickOpenResults() {
  el.quickOpenResults.innerHTML = "";
  el.quickOpenEmpty.hidden = quickOpenFiltered.length > 0;
  quickOpenFiltered.forEach((result, i) => {
    const { entry, indices } = result;
    const row = document.createElement("div");
    row.className = "quick-open-row" + (i === quickOpenSelected ? " selected" : "");
    row.dataset.index = i;

    const main = document.createElement("div");
    main.className = "quick-open-row-main";
    const badge = document.createElement("span");
    badge.className = `doc-role-badge role-${entry.role}`;
    badge.textContent = ROLE_LABEL[entry.role] || "?";
    const filename = document.createElement("span");
    filename.className = "quick-open-row-filename";
    filename.innerHTML = markMatches(entry.filename, indices);
    main.append(badge, filename);
    const tags = document.createElement("span");
    tags.className = "quick-open-row-tags";
    if (result.recent) {
      const tag = document.createElement("span");
      tag.className = "quick-open-row-recent";
      tag.textContent = t("quickOpen.recent");
      tags.appendChild(tag);
    }
    // The first nine rows open with the jump modifier + their number (see
    // the quick-open keydown handler) - same key and badge look as the
    // tree's hold-to-jump hints.
    if (i < 9) {
      const key = document.createElement("span");
      key.className = "alt-hint-badge";
      key.textContent = `${HINT_KEY_SYMBOL}${i + 1}`;
      tags.appendChild(key);
    }
    if (tags.childElementCount) main.appendChild(tags);

    const path = document.createElement("div");
    path.className = "quick-open-row-path";
    path.textContent = `${entry.projectTitle} / ${entry.sessionTitle}`;

    row.append(main, path);
    row.addEventListener("mouseenter", () => applyQuickOpenSelection(i));
    row.addEventListener("click", (e) => chooseQuickOpenResult(result, e.metaKey || e.ctrlKey));
    el.quickOpenResults.appendChild(row);
  });
  const selectedRow = el.quickOpenResults.children[quickOpenSelected];
  if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
}

// Moves the "selected" class without rebuilding anything - see
// renderQuickOpenResults' own comment on why a hover can't go through a full
// re-render. Arrow-key navigation (moveQuickOpenSelection) uses this too,
// for the same reason it would only get away with rebuilding by accident.
function applyQuickOpenSelection(index) {
  const rows = el.quickOpenResults.children;
  if (rows[quickOpenSelected]) rows[quickOpenSelected].classList.remove("selected");
  quickOpenSelected = index;
  if (rows[quickOpenSelected]) {
    rows[quickOpenSelected].classList.add("selected");
    rows[quickOpenSelected].scrollIntoView({ block: "nearest" });
  }
}

function moveQuickOpenSelection(delta) {
  if (!quickOpenFiltered.length) return;
  const next = (quickOpenSelected + delta + quickOpenFiltered.length) % quickOpenFiltered.length;
  applyQuickOpenSelection(next);
}

// `toSide` (⌘/Ctrl+Enter, or clicking a row with either held) opens into the
// split-view pane instead of the primary one - the same distinction every
// other quick-open-adjacent entry point (tree rows, ⌘/Ctrl-click) already
// makes, so this doesn't teach a third way to mean the same thing.
function chooseQuickOpenResult(result, toSide) {
  if (!result) return;
  const { entry } = result;
  closeQuickOpen();
  if (toSide) selectDocumentB(entry.projectId, entry.sessionId, entry.filename);
  else openInTab(docRef(entry.projectId, entry.sessionId, entry.filename));
}

async function openQuickOpen() {
  if (!el.quickOpenOverlay.hidden) return;
  el.quickOpenOverlay.hidden = false;
  el.quickOpenInput.value = "";
  el.quickOpenEmpty.hidden = true;
  el.quickOpenResults.innerHTML = "";
  quickOpenSelected = 0;
  el.quickOpenInput.focus();
  // Loaded after the overlay is already showing (a blank panel is a more
  // honest "working on it" than making the ⌘P keystroke itself feel like it
  // did nothing until every project has been fetched).
  await ensureFullTreeLoaded();
  quickOpenEntries = buildQuickOpenIndex();
  quickOpenFiltered = quickOpenFilter(el.quickOpenInput.value);
  renderQuickOpenResults();
}

function closeQuickOpen() {
  if (el.quickOpenOverlay.hidden) return;
  el.quickOpenOverlay.hidden = true;
  el.quickOpenInput.blur();
}

// ---------- keyboard shortcuts help ("?", or the ⌨ button) ----------
// One list, generated from this data rather than hand-written in
// index.html, so a platform-specific key (⌘ vs Ctrl, ⌃ vs Alt) renders
// correctly without a second, HTML-only copy to keep in sync - and so a
// shortcut added anywhere else in this file only has to be added here once
// to show up documented. IS_MAC/HINT_KEY_SYMBOL are defined further down
// (see the jump-hint section) - safe to reference here anyway, since this
// only ever runs from openShortcutsHelp(), well after module load.
function shortcutGroups() {
  const mod = IS_MAC ? "⌘" : "Ctrl";
  const alt = IS_MAC ? "⌥" : "Alt";
  return [
    {
      title: "shortcuts.groupGeneral",
      rows: [
        { desc: "shortcuts.showHelp", keys: [`${mod}/`, "?"] },
        { desc: "shortcuts.quickOpen", keys: [`${mod}P`, `${mod}K`] },
        { desc: "shortcuts.qoNav", keys: ["↑", "↓"] },
        { desc: "shortcuts.qoOpen", keys: ["Enter"] },
        { desc: "shortcuts.qoOpenSide", keys: [`${mod}Enter`] },
        { desc: "shortcuts.qoJump", keys: [`${HINT_KEY_SYMBOL}1-9`] },
        { desc: "shortcuts.qoClose", keys: ["Esc"] },
      ],
    },
    {
      title: "shortcuts.groupDocument",
      rows: [
        { desc: "shortcuts.save", keys: [`${mod}S`] },
        { desc: "shortcuts.send", keys: [`${mod}Enter`] },
        { desc: "shortcuts.inlineComplete", keys: [`⇧${mod}Enter`] },
        { desc: "shortcuts.find", keys: [`${mod}F`] },
        { desc: "shortcuts.findNext", keys: ["F3", `⇧F3 / ${mod}G`] },
        { desc: "shortcuts.indent", keys: ["Tab", "⇧Tab"] },
      ],
    },
    {
      title: "shortcuts.groupNavigate",
      rows: [
        { desc: "shortcuts.toggleTree", keys: [`${mod}B`] },
        { desc: "shortcuts.togglePreview", keys: [`${alt}${mod}B`] },
        { desc: "shortcuts.previewViews", keys: [IS_MAC ? `${alt}1 / 2 / 3` : `${alt}⇧1 / 2 / 3`] },
        { desc: "shortcuts.analysisRun", keys: [`${alt}R`] },
        { desc: "shortcuts.jumpDoc", keys: [`${HINT_KEY_SYMBOL}1-9`] },
        { desc: "shortcuts.tabPrevNext", keys: [`${alt}[`, `${alt}]`] },
        { desc: "shortcuts.tabClose", keys: [`${alt}W`] },
        { desc: "shortcuts.tabCloseOthers", keys: [`${alt}O`] },
      ],
    },
    {
      title: "shortcuts.groupSplit",
      rows: [
        { desc: "shortcuts.openSide", keys: [`${mod}Click`] },
        { desc: "shortcuts.togglePane", keys: [`${mod}\\`] },
      ],
    },
  ];
}

function renderShortcutsHelp() {
  el.shortcutsGroups.innerHTML = "";
  for (const group of shortcutGroups()) {
    const title = document.createElement("div");
    title.className = "shortcuts-group-title";
    title.textContent = t(group.title);
    el.shortcutsGroups.appendChild(title);
    for (const row of group.rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "shortcuts-row";
      const desc = document.createElement("span");
      desc.className = "shortcuts-row-desc";
      desc.textContent = t(row.desc);
      const keys = document.createElement("span");
      keys.className = "shortcuts-row-keys";
      for (const key of row.keys) {
        const kbd = document.createElement("kbd");
        kbd.className = "shortcut-key";
        kbd.textContent = key;
        keys.appendChild(kbd);
      }
      rowEl.append(desc, keys);
      el.shortcutsGroups.appendChild(rowEl);
    }
  }
}

function openShortcutsHelp() {
  if (!el.shortcutsOverlay.hidden) return;
  closeQuickOpen();
  renderShortcutsHelp();
  el.shortcutsOverlay.hidden = false;
  el.shortcutsCloseBtn.focus();
}

function closeShortcutsHelp() {
  el.shortcutsOverlay.hidden = true;
}

// Client-side mirror of storage.move_conversation's cycle guard - lets a
// folder drag reject an invalid target (itself, or one of its own
// subfolders) with immediate visual feedback (no drop-target highlight at
// all) instead of a round trip that would only fail once dropped.
function isFolderOrDescendant(project, candidateId, ancestorId) {
  if (candidateId === ancestorId) return true;
  for (const [childId, childSession] of project.sessions) {
    if (childSession.meta.parent_id === ancestorId && isFolderOrDescendant(project, candidateId, childId)) {
      return true;
    }
  }
  return false;
}

// Whether whatever's in `dragPayload` (see its declaration above) can
// legally land on `targetSessionId` - shared by onRowDragMove (to decide
// whether to show the drop-target highlight at all) and onRowDragEnd/
// handleDropOnFolder (to decide whether to actually call the API).
// A document can go to a folder of any project; a folder stays in its own.
function canDropOnFolder(projectId, targetSessionId) {
  if (!dragPayload) return false;
  if (dragPayload.type === "document") return dragPayload.projectId !== projectId || dragPayload.sessionId !== targetSessionId;
  if (dragPayload.projectId !== projectId) return false;
  if (dragPayload.type === "folder") {
    if (dragPayload.sessionId === targetSessionId) return false;
    const project = projects.get(projectId);
    return !!project && !isFolderOrDescendant(project, targetSessionId, dragPayload.sessionId);
  }
  return false;
}

// An official conversation turn ("exchange") is that folder's own history,
// not a file that happens to sit there - dragging one elsewhere copies it
// (see storage.copy_document's docstring for why) rather than relocating
// the actual turn out of its folder's context. Drafts and folders both
// still move.
function isCopyDrag(payload) {
  return payload.type === "document" && payload.role === "exchange";
}

async function handleDropOnFolder(payload, projectId, targetSessionId) {
  if (!payload || !canDropOnFolder(projectId, targetSessionId)) return;
  if (payload.type === "document") {
    const from = { projectId: payload.projectId, sessionId: payload.sessionId };
    const to = { projectId, sessionId: targetSessionId };
    if (isCopyDrag(payload)) {
      await copyDocumentToFolder(from, payload.filename, to);
    } else {
      await moveDocumentToFolder(from, payload.filename, to);
    }
  } else {
    await moveFolderTo(projectId, payload.sessionId, targetSessionId);
  }
}

// The project row's own drop rule: only a folder (never a document, which
// can't exist outside some folder) dragged from that same project can land
// there, moving it back to the project's top level (parent_id: null).
function canDropOnProjectRoot(projectId) {
  return !!dragPayload && dragPayload.type === "folder" && dragPayload.projectId === projectId;
}

const ROW_DRAG_THRESHOLD_PX = 4;

// Starts tracking a potential drag from a pointerdown on a draggable row
// (see buildDocumentRow/buildSessionNode) - "potential" because most
// pointerdowns here are actually the start of an ordinary click (selecting
// a document, toggling a folder, pressing one of its icon buttons), not a
// drag. Nothing about `payload` takes effect - dragPayload isn't even set
// yet - until onRowDragMove sees the pointer actually move past
// ROW_DRAG_THRESHOLD_PX; a plain click never reaches that and falls
// through to whatever click handler the row already had.
function startRowDrag(e, payload, sourceRow) {
  // Mouse only for now - a touch/pen pointerdown on a row is far more
  // likely to be the start of scrolling the tree than a drag, and there's
  // no way to tell which until well after touch-scrolling would already
  // need to have taken over.
  if (e.button !== 0 || e.pointerType !== "mouse") return;
  rowDrag = {
    payload,
    sourceRow,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    dropRow: null,
    dropIsProjectRoot: false,
    ghost: null,
  };
  document.addEventListener("pointermove", onRowDragMove);
  document.addEventListener("pointerup", onRowDragEnd);
  document.addEventListener("pointercancel", onRowDragEnd);
}

// Swallows the one synthetic "click" a pointerdown+pointerup pair always
// fires afterward, purely so finishing an actual drag on a row doesn't
// also select/toggle it the way a plain click on that same row would - a
// capturing listener runs before the row's own (bubble-phase) click
// handler ever sees the event.
function suppressNextClick() {
  document.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, once: true },
  );
}

// A small floating label that follows the cursor for the rest of the drag
// (see onRowDragMove/onRowDragEnd) - the one thing a native HTML5 drag
// gets for free (its own ghost image) that this pointer-driven
// implementation has to build by hand. `sourceRow` is only used to read a
// folder's display title back out (a document's own filename is already
// on `payload`, but a folder's title isn't).
function createDragGhost(payload, sourceRow) {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const label =
    payload.type === "folder" ? (sourceRow && sourceRow.querySelector(".session-title")?.textContent) || "" : payload.filename;
  const icon = payload.type === "folder" ? "📁" : isCopyDrag(payload) ? "⧉" : "📄";
  ghost.textContent = `${icon} ${label}`;
  document.body.appendChild(ghost);
  return ghost;
}

function moveDragGhost(ghost, x, y) {
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
}

// Finds the folder row carrying this exact project/session id - a plain
// linear scan rather than an attribute-selector query, since project/
// session ids are opaque strings nothing here should be building CSS
// selectors out of.
function findSessionRow(projectId, sessionId) {
  for (const row of document.querySelectorAll(".session-row")) {
    if (row.dataset.projectId === projectId && row.dataset.sessionId === sessionId) return row;
  }
  return null;
}

function onRowDragMove(e) {
  if (!rowDrag || e.pointerId !== rowDrag.pointerId) return;
  if (!rowDrag.moved) {
    const dx = e.clientX - rowDrag.startX;
    const dy = e.clientY - rowDrag.startY;
    if (Math.hypot(dx, dy) < ROW_DRAG_THRESHOLD_PX) return;
    rowDrag.moved = true;
    dragPayload = rowDrag.payload;
    document.body.classList.add("row-dragging");
    // Dimming the source implies it's leaving, which isn't true for a
    // copy-drag (see isCopyDrag) - the original stays exactly as it was.
    if (rowDrag.sourceRow && !isCopyDrag(rowDrag.payload)) rowDrag.sourceRow.classList.add("row-drag-source");
    rowDrag.ghost = createDragGhost(rowDrag.payload, rowDrag.sourceRow);
    suppressNextClick();
  }
  e.preventDefault();
  moveDragGhost(rowDrag.ghost, e.clientX, e.clientY);

  // Hovering any document already inside a folder counts the same as
  // hovering that folder's own row - a much bigger, more forgiving target
  // than the folder's single header line, and the natural way a drop
  // "into a folder" reads when that folder already has documents in it.
  const hovered = document.elementFromPoint(e.clientX, e.clientY);
  const hoveredDocRow = hovered && hovered.closest(".document-row");
  const sessionRow = hoveredDocRow
    ? findSessionRow(hoveredDocRow.dataset.projectId, hoveredDocRow.dataset.sessionId)
    : hovered && hovered.closest(".session-row");
  const projectRow = !sessionRow && hovered && hovered.closest(".project-row");
  let candidate = null;
  let dropIsProjectRoot = false;
  if (sessionRow && canDropOnFolder(sessionRow.dataset.projectId, sessionRow.dataset.sessionId)) {
    candidate = sessionRow;
  } else if (projectRow && canDropOnProjectRoot(projectRow.dataset.projectId)) {
    candidate = projectRow;
    dropIsProjectRoot = true;
  }

  if (candidate !== rowDrag.dropRow) {
    if (rowDrag.dropRow) rowDrag.dropRow.classList.remove("drop-target");
    rowDrag.dropRow = candidate;
    rowDrag.dropIsProjectRoot = dropIsProjectRoot;
    if (candidate) candidate.classList.add("drop-target");
  }
}

async function onRowDragEnd(e) {
  if (!rowDrag || e.pointerId !== rowDrag.pointerId) return;
  document.removeEventListener("pointermove", onRowDragMove);
  document.removeEventListener("pointerup", onRowDragEnd);
  document.removeEventListener("pointercancel", onRowDragEnd);
  document.body.classList.remove("row-dragging");
  if (rowDrag.sourceRow) rowDrag.sourceRow.classList.remove("row-drag-source");
  if (rowDrag.dropRow) rowDrag.dropRow.classList.remove("drop-target");
  if (rowDrag.ghost) rowDrag.ghost.remove();

  const { payload, dropRow, dropIsProjectRoot } = rowDrag;
  rowDrag = null;
  // Not cleared until after the calls below - canDropOnFolder/
  // canDropOnProjectRoot (called again from inside handleDropOnFolder, to
  // re-validate rather than just trust the last onRowDragMove highlight)
  // still read this module-level `dragPayload`, so nulling it any earlier
  // than this made every drop silently fail its own re-validation.
  if (!dropRow) {
    dragPayload = null;
    return;
  }

  if (dropIsProjectRoot) {
    if (payload.type === "folder") await moveFolderTo(dropRow.dataset.projectId, payload.sessionId, null);
    dragPayload = null;
    return;
  }
  await handleDropOnFolder(payload, dropRow.dataset.projectId, dropRow.dataset.sessionId);
  dragPayload = null;
}

// `from`/`to`: { projectId, sessionId } - the folders may be in different projects.
async function moveDocumentToFolder(from, filename, to) {
  try {
    await api.moveDocument(from.projectId, from.sessionId, filename, to.sessionId, to.projectId);
    analysisPanel.forget(from.projectId, from.sessionId, filename);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await Promise.all([refreshSessionDocs(from.projectId, from.sessionId), refreshSessionDocs(to.projectId, to.sessionId)]);
  // The moved document is still open in the editor - just under a
  // different folder now, same as renameDocument keeps `active` in sync
  // with a filename change instead of leaving it stale.
  if (
    active &&
    active.projectId === from.projectId &&
    active.sessionId === from.sessionId &&
    active.filename === filename
  ) {
    active.projectId = to.projectId;
    active.sessionId = to.sessionId;
    saveActiveDocRef();
    updateFilenameLabel();
  }
  renderTree();
}

// The copy-drag counterpart of moveDocumentToFolder above - the source
// document/folder is never touched (see isCopyDrag), so there's nothing to
// refresh there and no `active` ref to repoint; only the target folder's
// document list needs to pick up the new draft.
async function copyDocumentToFolder(from, filename, to) {
  try {
    await api.copyDocument(from.projectId, from.sessionId, filename, to.sessionId, to.projectId);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await refreshSessionDocs(to.projectId, to.sessionId);
  renderTree();
}

async function moveFolderTo(projectId, sessionId, newParentId) {
  try {
    await api.moveConversation(projectId, sessionId, newParentId);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await refreshProjectSessions(projectId);
  renderTree();
}

async function toggleProject(id) {
  const project = projects.get(id);
  if (!project) return;
  project.expanded = !project.expanded;
  saveExpandedTreeState();
  if (project.expanded && project.sessions === null) {
    renderTree();
    await refreshProjectSessions(id);
  }
  renderTree();
}

async function toggleSession(projectId, id) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(id);
  if (!session) return;
  session.expanded = !session.expanded;
  saveExpandedTreeState();
  if (session.expanded && session.documents === null) {
    renderTree();
    session.documents = await api.listDocuments(projectId, id);
  }
  renderTree();
}

// Same breakpoint as style.css's phone layout. There, putting the caret in
// the editor would also pop the on-screen keyboard over a document you
// probably opened to read.
const PHONE_LAYOUT = window.matchMedia("(max-width: 700px)");

// Only pair existing siblings; the final .c suffix identifies the left pane.
async function documentPair(projectId, sessionId, filename) {
  if (!filename.endsWith(".md")) return null;
  const session = projects.get(projectId)?.sessions?.get(sessionId);
  if (!session) return null;
  if (session.documents === null) session.documents = await api.listDocuments(projectId, sessionId);
  const right = filename.endsWith(".c.md") ? filename.slice(0, -5) + ".md" : filename;
  const left = right.slice(0, -3) + ".c.md";
  return [left, right].every((name) => session.documents.some((doc) => doc.filename === name))
    ? { left, right } : null;
}

async function pairedDocumentRef(ref) {
  if (ref?.role !== "document") return ref;
  const pair = await documentPair(ref.projectId, ref.sessionId, ref.filename);
  return pair ? { ...ref, filename: pair.left } : ref;
}

// `focus` (on by default): every way of arriving at a document - a tree
// row, quick open, the jump keys, an internal link, and the page-load
// restore of the last open one - leaves the caret at the top of the editor,
// ready to type.
async function selectDocument(projectId, sessionId, filename, { focus = true } = {}) {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const pair = await documentPair(projectId, sessionId, filename);
  const sameRight = pair && activeB?.projectId === projectId && activeB?.sessionId === sessionId && activeB?.filename === pair.right;
  if (pair && !sameRight && isDirtyB() && !confirm(t("confirm.unsavedChanges"))) return;
  if (pair) filename = pair.left;

  const project = projects.get(projectId);
  if (!project) return;
  const session = project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  const doc = session.documents.find((d) => d.filename === filename);
  if (!doc) return;

  // Each document has its own toolbar choice. Switching files, including
  // two documents in the same folder, applies that file's saved choice, or
  // the app default when it has none. Re-selecting the file already open
  // leaves an in-progress dropdown edit alone.
  const documentChanged = !active || active.sessionId !== sessionId || active.projectId !== projectId || active.filename !== filename;
  active = { projectId, sessionId, filename, role: doc.role, savedContent: doc.content, turnId: doc.turn_id, publishToken: doc.publish_token, publishSlides: !!doc.publish_slides, version: doc.version };
  hideSyncConflict();
  saveActiveDocRef();
  rememberRecentDoc(projectId, sessionId, filename);
  el.editor.value = doc.content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  if (documentChanged && !NON_SENDABLE_ROLES.has(doc.role)) applyDocumentSettings(doc);
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
  if (pair) {
    if (sameRight) setSplitView(true);
    else await selectDocumentB(projectId, sessionId, pair.right, { focus: false, paired: true });
  }
  if (focus && !PHONE_LAYOUT.matches && editorViewMode !== "rendered") {
    el.editor.setSelectionRange(0, 0);
    el.editor.focus();
  }
}

// selectDocument's split-view counterpart. Deliberately narrower: only a
// plain document (never a system prompt, the global prompt, or a Hermes
// transcript - see activeB's own comment), no turnId/publishToken, no
// provider/model defaults, no send/inline-complete toolbar. Opens split
// view if it wasn't already, and focusing the pane (which the caller does
// right after, both from the tree and from ⌘/Ctrl-click) is what actually
// makes the shared preview follow it - see the "focus" listeners below.
async function selectDocumentB(projectId, sessionId, filename, { focus = true, paired = false } = {}) {
  if (!paired && await documentPair(projectId, sessionId, filename)) {
    await openInTab(docRef(projectId, sessionId, filename));
    return;
  }
  if (!paired && isDirtyB() && !confirm(t("confirm.unsavedChanges"))) return;

  const project = projects.get(projectId);
  if (!project) return;
  const session = project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  const doc = session.documents.find((d) => d.filename === filename);
  if (!doc) return;

  activeB = { projectId, sessionId, filename, role: doc.role, savedContent: doc.content, version: doc.version };
  saveActiveDocRefB();
  rememberRecentDoc(projectId, sessionId, filename);
  setSplitView(true);
  el.editorB.value = doc.content;
  el.editorB.disabled = false;
  el.saveBtnB.disabled = false;
  updateFilenameLabelB();
  renderPreviewB();
  renderTree();
  // Skipped on restore (see restoreActiveDocumentB) - stealing focus (and
  // with it previewSource, see the "focus" listener below) into the
  // secondary pane on every page load would be a worse default than just
  // leaving it wherever pane A's own restore puts it.
  if (focus) el.editorB.focus();
}

// The close (×) button, and the toolbar toggle when split view is already
// open (see its own listener below) - both mean "I'm done with the second
// pane", so both go through the same unsaved-changes check pane B's content
// deserves; selectDocument already gets this for pane A, and pane B is no
// different just because it isn't the primary one.
function closeSplitView() {
  if (isDirtyB() && !confirm(t("confirm.unsavedChanges"))) return;
  activeB = null;
  saveActiveDocRefB();
  el.editorB.value = "";
  el.editorB.disabled = true;
  el.saveBtnB.disabled = true;
  updateFilenameLabelB();
  setSplitView(false);
  renderTree();
  if (previewSource === "b") setPreviewSource("a");
}

// The open document's folder listing, without a lazy fetch - alt-hint mode
// fires on a bare keydown and must stay synchronous, so it only shows
// hints when the session's documents happen to already be loaded (always
// true in practice: you can't have a document from that session open in the
// editor without having loaded the list first).
function activeSessionDocuments() {
  if (!active || !active.projectId || !active.sessionId) return null;
  const project = projects.get(active.projectId);
  const session = project && project.sessions && project.sessions.get(active.sessionId);
  return session && session.documents ? session.documents : null;
}

// A document-link href (asciimath-markdown's renderInline: a plain [text](url)
// pointed at one, or the shorter [[wikilink]] convention it expands into
// the same shape) is either a bare filename - another document in the
// *same* folder - or "<convId>/filename.md" - a folder elsewhere in the
// same project (convId is the app's own 12-hex-char id, loose-matched here
// rather than hardcoding that exact length). Either shape, when it
// actually resolves to a real document, opens it in the editor instead of
// the browser trying (and failing - documents aren't served as static
// files at any such path) to navigate there. Deliberately narrow: a full
// URL (scheme, or any other path shape) is left alone as an ordinary
// external link, and a target that doesn't resolve to a real document is
// left alone too - so an unrelated ".md" link some provider happened to
// write still just behaves like a normal (if broken) link, exactly as
// before this existed. routers/public.py's GET /api/public/{token}/
// resolve-link (see public.js) resolves these same two shapes server-side
// for a published page, which has no session-tree state to check against.
const INTERNAL_DOC_LINK_RE = /^(?:([0-9a-f]{8,16})\/)?([^/\\:]+\.md)$/i;

async function openInternalDocumentLink(event) {
  const link = event.target.closest("a");
  if (!link) return;
  const href = link.getAttribute("href") || "";
  const match = INTERNAL_DOC_LINK_RE.exec(href);
  if (!match || !active || !active.projectId) return;
  const [, targetSessionId, targetFilename] = match;

  if (!targetSessionId) {
    // Same-folder - the common case, resolved synchronously from whatever
    // this folder's own document list already has cached.
    if (!active.sessionId) return;
    const docs = activeSessionDocuments();
    const doc = docs && docs.find((d) => d.filename === targetFilename);
    if (!doc) return;
    event.preventDefault();
    openInTab(docRef(active.projectId, active.sessionId, targetFilename));
    return;
  }

  // Cross-folder - always intercepted first (a bare "<hex>/filename.md"
  // relative path can't sensibly navigate the browser anywhere useful
  // regardless), then resolved asynchronously: the target folder's own
  // document list may not be loaded yet if its project was never expanded
  // in the tree.
  event.preventDefault();
  const project = projects.get(active.projectId);
  if (!project) return;
  if (project.sessions === null) await refreshProjectSessions(active.projectId);
  const session = project.sessions && project.sessions.get(targetSessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(active.projectId, targetSessionId);
  }
  const doc = session.documents.find((d) => d.filename === targetFilename);
  if (!doc) return;
  openInTab(docRef(active.projectId, targetSessionId, targetFilename));
}

// Holding the jump modifier (see HINT_KEYS below) shows "⌃1".."⌃9" (⌥ off a
// Mac) badges on the tree rows the digits open: 1-3 are the documents opened
// most recently, 4-9 the rest of the open document's folder (see
// buildAltHintEntries). Quick open reaches everything past the ninth.
// altHintDocs is the source of truth for what a
// digit press opens; the DOM badges are only a visual aid and may be missing
// entirely (tree pane collapsed, folder collapsed - likelier now that a
// recent document can live in another one) without affecting that.
//
// The jump modifier is Control on a Mac and Alt elsewhere. On a Mac,
// Option+digit types a special character (⌥1 is "¡", ⌥2 is "™", ...), so
// holding it down and pressing a number would insert text instead of
// jumping; ⌘+digit is Safari's "go to tab N"; and ⇧⌘3/4/5 are the system
// screenshot shortcuts, which never reach the page at all. Control+digit is
// free of all three. Off a Mac there is no Option key, and the Windows/Meta
// key is a worse modifier than Alt, so Alt stays.
const IS_MAC = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
const HINT_KEYS = IS_MAC ? ["Control"] : ["Alt"];
const HINT_KEY_NAME = IS_MAC ? "⌃" : "Alt";
const HINT_KEY_SYMBOL = IS_MAC ? "⌃" : "⌥";
// The ⌥R shortcut (see the preview pane tabs section), on its button.
el.analysisRunBtn.title = IS_MAC ? "⌥R" : "Alt+R";
// True while exactly the jump modifier is held - a chord like ⌃⌘F, or ⇧⌃
// alone, must never arm or trigger the digits.
const hintModifierHeld = (e) =>
  IS_MAC
    ? e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    : e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;

let altHintActive = false;
let altHintDocs = null;
let altHintTimer = null;

function altHintRowFor(entry) {
  for (const row of el.sessionTree.querySelectorAll(".document-row")) {
    if (
      row.dataset.projectId === entry.projectId &&
      row.dataset.sessionId === entry.sessionId &&
      row.dataset.filename === entry.filename
    ) {
      return row;
    }
  }
  return null;
}

// What each digit opens, as nine fixed slots (a gap is a gap, so a number
// never moves under your fingers):
//   1-3  the documents opened most recently, newest first, from anywhere -
//        the one that's open right now is skipped, since jumping to it is a
//        no-op, which is what makes 1 always mean "back to where I was".
//   4-9  the rest of the open document's own folder, in tree order.
// A document already in 1-3 is left out of 4-9 rather than listed twice.
function buildAltHintEntries() {
  const isOpen = (r) =>
    !!active && r.projectId === active.projectId && r.sessionId === active.sessionId && r.filename === active.filename;
  // Where a session's documents are already loaded they can vouch for an
  // entry; one that isn't loaded yet can't be checked, and is trusted (a
  // stale one is simply a no-op when pressed - see selectDocument).
  const stillExists = (r) => {
    const project = projects.get(r.projectId);
    const session = project && project.sessions && project.sessions.get(r.sessionId);
    if (!session) return false;
    if (!session.documents) return true;
    return session.documents.some((d) => d.filename === r.filename && d.role !== "system");
  };
  const slots = new Array(9).fill(null);
  const recent = recentDocs.filter((r) => !isOpen(r) && stillExists(r)).slice(0, 3);
  recent.forEach((r, i) => {
    slots[i] = r;
  });
  const docs = activeSessionDocuments() || [];
  // Mirror buildSessionNode's own "listable" filter: system.md has no row of
  // its own to badge - it's reached via the folder's "⋯" menu instead.
  const folder = docs
    .filter((d) => d.role !== "system" && d.filename !== active.filename)
    .map((d) => ({ projectId: active.projectId, sessionId: active.sessionId, filename: d.filename }))
    .filter((r) => !recent.some((x) => x.projectId === r.projectId && x.sessionId === r.sessionId && x.filename === r.filename));
  folder.slice(0, 6).forEach((r, i) => {
    slots[3 + i] = r;
  });
  return slots;
}

function enterAltHintMode() {
  if (altHintActive || streaming) return;
  const slots = buildAltHintEntries();
  if (!slots.some(Boolean)) return;
  altHintDocs = slots;
  altHintActive = true;
  altHintDocs.forEach((entry, i) => {
    if (!entry) return;
    const row = altHintRowFor(entry);
    if (!row) return;
    const hint = document.createElement("span");
    hint.className = "alt-hint-badge";
    hint.textContent = `${HINT_KEY_SYMBOL}${i + 1}`;
    row.appendChild(hint);
  });
}

function exitAltHintMode() {
  if (altHintTimer) {
    clearTimeout(altHintTimer);
    altHintTimer = null;
  }
  if (!altHintActive) return;
  altHintActive = false;
  altHintDocs = null;
  for (const badge of el.sessionTree.querySelectorAll(".alt-hint-badge")) badge.remove();
}

// A quick modifier tap on its way to some other combo shouldn't flash hint
// badges - only arm the hints once the key has been held long enough that it
// isn't obviously the first half of something else.
function scheduleAltHintMode() {
  if (altHintTimer || altHintActive) return;
  altHintTimer = setTimeout(() => {
    altHintTimer = null;
    enterAltHintMode();
  }, 350);
}

async function openAltHint(index) {
  const entry = altHintDocs && altHintDocs[index - 1];
  exitAltHintMode();
  if (!entry) return;
  await openInTab(docRef(entry.projectId, entry.sessionId, entry.filename));
}

async function selectProjectSystemPrompt(projectId) {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const { content } = await api.getProjectSystemPrompt(projectId);
  const project = projects.get(projectId);
  if (project) project.systemPromptContent = content;
  active = {
    projectId,
    sessionId: null,
    filename: t("doc.projectSystemPromptFilename"),
    role: "project-system",
    savedContent: content,
  };
  saveActiveDocRef();
  el.editor.value = content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
}

async function selectGlobalPrompt() {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const { content } = await api.getGlobalSystemPrompt();
  globalSystemPromptContent = content;
  active = {
    projectId: null,
    sessionId: null,
    filename: t("doc.globalSystemPromptFilename"),
    role: "global-system",
    savedContent: content,
  };
  saveActiveDocRef();
  el.editor.value = content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
}

// The one always-on, app-wide custom AsciiMath symbol table (see
// asciimath-markdown's setCustomAsciiMathSymbols/parseCustomSymbolsCsv and
// backend/app/custom_symbols.py) - a sibling of the global system prompt in
// the tree, but its own separate document/role, not a system-prompt
// variant.
async function selectGlobalCustomSymbols() {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const { content } = await api.getCustomSymbols();
  globalCustomSymbolsContent = content;
  active = {
    projectId: null,
    sessionId: null,
    filename: t("doc.globalCustomSymbolsFilename"),
    role: "global-custom-symbols",
    savedContent: content,
  };
  saveActiveDocRef();
  el.editor.value = content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
}

async function createDraft(projectId, sessionId) {
  const draft = await api.createDraft(projectId, sessionId);
  await refreshSessionDocs(projectId, sessionId);
  renderTree();
  await openInTab(docRef(projectId, sessionId, draft.filename));
}

// The transcript arrives as an ordinary draft already written to disk (see
// routers/transcribe.py) - so once it exists, opening it is exactly
// createDraft's own tail.
function transcribeIntoSession(projectId, sessionId) {
  openTranscribeDialog({
    projectId,
    sessionId,
    onDone: async (doc) => {
      await refreshSessionDocs(projectId, sessionId);
      renderTree();
      await openInTab(docRef(projectId, sessionId, doc.filename));
    },
  });
}

function showRecordings(projectId, sessionId, filename) {
  openRecordingsDialog({
    projectId,
    sessionId,
    filename,
    onChange: async () => {
      await refreshSessionDocs(projectId, sessionId).catch(() => {});
      renderTree();
    },
    // Into the audio-file bar, on the recording's own document: ▶ there
    // plays it and writes it down, live check and all.
    onTranscribe: fileDictationAvailable()
      ? async (name, url) => {
          await openInTab(docRef(projectId, sessionId, filename));
          if (!active || active.projectId !== projectId || active.sessionId !== sessionId || active.filename !== filename) return;
          loadAudioFile(name, url, false);
        }
      : null,
  });
}

async function renameProject(id) {
  const project = projects.get(id);
  if (!project) return;
  const input = prompt(t("prompt.renameProject"), project.meta.title);
  if (input === null) return;
  const title = input.trim();
  if (!title || title === project.meta.title) return;

  const updated = await api.renameProject(id, title);
  project.meta = updated;
  renderTree();
}

async function removeProject(id) {
  const project = projects.get(id);
  const sessionCount = project && project.sessions ? project.sessions.size : null;
  const countNote = sessionCount === null ? "" : t("project.deleteFolderCount", { count: sessionCount });
  if (!confirm(t("confirm.deleteProject", { note: countNote }))) return;
  await api.deleteProject(id);
  projects.delete(id);
  await dropTabs((ref) => ref.projectId === id);
  renderTree();
}

async function renameSession(projectId, id) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(id);
  if (!session) return;
  const input = prompt(t("prompt.renameFolder"), session.meta.title);
  if (input === null) return;
  const title = input.trim();
  if (!title || title === session.meta.title) return;

  const updated = await api.renameConversation(projectId, id, title);
  session.meta = updated;
  renderTree();
}

async function removeSession(projectId, id) {
  // Deleting a folder also deletes every subfolder inside it (see
  // storage.delete_conversation's cascade) - refetch the whole project's
  // folder list rather than removing just this one id locally, so no
  // now-gone descendant folder is left as a stale entry in the tree.
  if (!confirm(t("confirm.deleteFolder"))) return;
  await api.deleteConversation(projectId, id);
  await refreshProjectSessions(projectId);
  const project = projects.get(projectId);
  // Deleting a folder deletes its subfolders too - close every tab whose
  // folder is gone.
  await dropTabs((ref) => ref.projectId === projectId && ref.sessionId && !(project && project.sessions && project.sessions.has(ref.sessionId)));
  renderTree();
}

async function removeDocument(projectId, sessionId, filename, role) {
  // "draft" documents aren't part of the conversation yet, so deleting one
  // only removes that file. An official turn ("exchange", or "user"/
  // "assistant" for pre-merge sessions) is different: it's also dropped
  // from this session's LLM context from that point on, not just hidden
  // from the tree - worth calling out before confirming.
  const message =
    role === "draft"
      ? t("confirm.deleteDraft", { filename })
      : t("confirm.deleteTurn", { filename });
  if (!confirm(message)) return;
  await api.deleteDocument(projectId, sessionId, filename);
  analysisPanel.forget(projectId, sessionId, filename);
  await refreshSessionDocs(projectId, sessionId);
  await dropTabs((ref) => ref.role === "document" && ref.projectId === projectId && ref.sessionId === sessionId && ref.filename === filename);
  // Deleted out from under the split-view pane too - closeSplitView's own
  // unsaved-changes confirm would be asking about content that no longer
  // has anywhere to save to, so this clears it directly instead.
  if (activeB && activeB.projectId === projectId && activeB.sessionId === sessionId && activeB.filename === filename) {
    activeB = null;
    saveActiveDocRefB();
    el.editorB.value = "";
    el.editorB.disabled = true;
    el.saveBtnB.disabled = true;
    updateFilenameLabelB();
    if (previewSource === "b") setPreviewSource("a");
  }
  renderTree();
}

// The inverse of sending a draft (see selectDocument's draftFilename and
// storage.start_exchange) - drops this turn back out of the session's LLM
// history/context, in place, without touching the file's content at all.
async function revertDocumentToDraft(projectId, sessionId, filename) {
  if (!confirm(t("confirm.revertToDraft", { filename }))) return;
  try {
    await api.revertToDraft(projectId, sessionId, filename);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await refreshSessionDocs(projectId, sessionId);
  if (active && active.projectId === projectId && active.sessionId === sessionId && active.filename === filename) {
    // Content on disk is untouched, so the open editor buffer stays as-is -
    // only the role/turn identity changes, which matters for how the next
    // Send is routed (see detectPendingQuestion/sendActive: a stale turnId
    // here would try to retry a turn that no longer exists).
    active.role = "draft";
    active.turnId = null;
    updateSendToolbarVisibility();
    updateFormatToolbar();
    updateSendAvailability();
    updateFilenameLabel();
  }
  renderTree();
}

async function createConversationFile(projectId, sessionId, filename) {
  if (streaming) return;
  try {
    // Refresh first so an existing conversation can simply be reopened.
    await refreshSessionDocs(projectId, sessionId);
    const target = filename.slice(0, -3) + ".c.md";
    if (!cachedDocument(projectId, sessionId, target)) {
      await api.createConversationFile(projectId, sessionId, filename);
      await refreshSessionDocs(projectId, sessionId);
    }
    await openInTab(docRef(projectId, sessionId, target));
  } catch (err) {
    alert(t("action.error", { message: err.message }));
  }
}

async function renameDocument(projectId, sessionId, filename) {
  const base = filename.replace(/\.md$/i, "");
  const input = prompt(t("prompt.renameDocument"), base);
  if (input === null) return;
  const trimmed = input.trim();
  if (!trimmed) return;
  const newFilename = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (newFilename === filename) return;

  try {
    const updated = await api.renameDocument(projectId, sessionId, filename, newFilename);
    analysisPanel.forget(projectId, sessionId, filename);
    await refreshSessionDocs(projectId, sessionId);
    if (
      active &&
      active.projectId === projectId &&
      active.sessionId === sessionId &&
      active.filename === filename
    ) {
      active.filename = updated.filename;
      saveActiveDocRef();
      updateFilenameLabel();
    }
    if (
      activeB &&
      activeB.projectId === projectId &&
      activeB.sessionId === sessionId &&
      activeB.filename === filename
    ) {
      activeB.filename = updated.filename;
      saveActiveDocRefB();
      updateFilenameLabelB();
    }
    renderTree();
  } catch (err) {
    alert(t("action.renameFailed", { message: err.message }));
  }
}

// "공용 수식 말" - the vocabulary math dictation uses (see asciimath-markdown's spoken-math.js), the
// same kind of always-on, app-wide CSV document as the custom symbols.
async function selectGlobalSpokenMath() {
  if (streaming) return;
  if (!openingTab && isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const { content } = await api.getSpokenMath();
  setSpokenMathVocabulary(parseSpokenMathCsv(content));
  active = {
    projectId: null,
    sessionId: null,
    filename: t("doc.globalSpokenMathFilename"),
    role: "global-spoken-math",
    savedContent: content,
  };
  saveActiveDocRef();
  el.editor.value = content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
}

async function saveActive() {
  // The save button is disabled for a Hermes transcript, but Ctrl+S doesn't
  // check that - there's no mark-vector document to save it to.
  if (!active || active.role === "hermes-session") return;
  const content = el.editor.value;
  if (active.role === "global-system") {
    await api.saveGlobalSystemPrompt(content);
    globalSystemPromptContent = content;
  } else if (active.role === "global-custom-symbols") {
    await api.saveCustomSymbols(content);
    globalCustomSymbolsContent = content;
    // Takes effect immediately for every document's preview, not just on
    // the next reload - see asciimath-markdown's setCustomAsciiMathSymbols.
    setCustomAsciiMathSymbols(parseCustomSymbolsCsv(content));
  } else if (active.role === "global-spoken-math") {
    await api.saveSpokenMath(content);
    // The next phrase dictated already uses it.
    setSpokenMathVocabulary(parseSpokenMathCsv(content));
  } else if (active.role === "project-system") {
    await api.saveProjectSystemPrompt(active.projectId, content);
    const project = projects.get(active.projectId);
    if (project) project.systemPromptContent = content;
  } else {
    const saved = await api.saveDocument(active.projectId, active.sessionId, active.filename, content);
    active.version = saved.version;
    hideSyncConflict();
    const project = projects.get(active.projectId);
    const session = project && project.sessions && project.sessions.get(active.sessionId);
    const doc = session && session.documents && session.documents.find((d) => d.filename === active.filename);
    if (doc) doc.content = content;
  }
  active.savedContent = content;
  clearAutosave();
  updateFilenameLabel();
}

// saveActive's narrower counterpart for pane B - always a plain document
// (see activeB's own comment), so none of the per-role branching above
// applies, and there's no autosave-recovery buffer to clear (pane B never
// writes one - see scheduleAutosave/maybeRestoreAutosave, both pane-A-only).
async function saveDocumentB() {
  if (!activeB) return;
  const content = el.editorB.value;
  const saved = await api.saveDocument(activeB.projectId, activeB.sessionId, activeB.filename, content);
  activeB.version = saved.version;
  const project = projects.get(activeB.projectId);
  const session = project && project.sessions && project.sessions.get(activeB.sessionId);
  const doc = session && session.documents && session.documents.find((d) => d.filename === activeB.filename);
  if (doc) doc.content = content;
  activeB.savedContent = content;
  updateFilenameLabelB();
}

function publicUrl(token) {
  return `${location.origin}/p/${token}`;
}

// navigator.clipboard.writeText needs a secure context (https:// or
// localhost) - this app is typically reached over plain http:// via
// Tailscale, so it's silently unavailable there. document.execCommand
// ("copy" on a temporary offscreen textarea) is deprecated but still the
// one copy path that works over plain http, so it's the fallback rather
// than the primary method's error path.
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // fall through to the legacy method below
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (err) {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

// Briefly flashes the publish button to confirm the copy, then restores its
// normal label - only falls back to a manual-copy prompt() when neither
// clipboard method above actually worked.
async function copyLinkWithFeedback(url) {
  if (!(await copyToClipboard(url))) {
    prompt(t("prompt.copyShareLink"), url);
    return;
  }
  // The icon carries the confirmation too - on a phone the label span is
  // hidden, so a text-only "copied" would be invisible exactly where the
  // clipboard is least obvious.
  el.publishIcon.textContent = "✅";
  el.publishLabel.textContent = t("editor.linkCopied");
  setTimeout(updatePublishButton, 1500);
}

// Publishing a doc that's already published just returns its existing token
// (see storage.publish_document) - clicking again is therefore always safe
// and reuses the same link.
async function togglePublish() {
  if (!active || streaming || NON_SENDABLE_ROLES.has(active.role)) return;
  const { projectId, sessionId, filename } = active;
  let url = null;

  if (active.publishToken) {
    const existingUrl = publicUrl(active.publishToken);
    if (confirm(t("confirm.stopSharing", { url: existingUrl }))) {
      await api.unpublishDocument(projectId, sessionId, filename);
      active.publishToken = null;
      active.publishSlides = false;
    } else {
      url = existingUrl; // "cancel" here just means "copy it again"
    }
  } else {
    const { token } = await api.publishDocument(projectId, sessionId, filename);
    active.publishToken = token;
    url = publicUrl(token);
  }

  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(sessionId);
  const doc = session && session.documents && session.documents.find((d) => d.filename === filename);
  if (doc) {
    doc.publish_token = active.publishToken;
    doc.publish_slides = active.publishSlides;
  }

  updatePublishButton();
  renderTree();

  if (url) await copyLinkWithFeedback(url);
}

// The publish-time "view as slideshow" option (see storage.set_publish_slides
// and public.js's slideshow mode). Reverts the checkbox if the request fails,
// so it never shows an option the share link doesn't actually have.
async function setPublishSlides(slides) {
  if (!active || !active.publishToken) return;
  const target = active;
  const { projectId, sessionId, filename } = target;
  try {
    await api.setPublishSlides(projectId, sessionId, filename, slides);
  } catch (err) {
    if (active === target) el.publishSlidesCheckbox.checked = !!target.publishSlides;
    return;
  }
  target.publishSlides = slides;
  // The glasses screen switches between document and slide view on this.
  if (active === target && el.glassesCheckbox.checked) glassesSocket.send(true);
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(sessionId);
  const doc = session && session.documents && session.documents.find((d) => d.filename === filename);
  if (doc) doc.publish_slides = slides;
}

// Snapshots the live preview's already-rendered HTML (KaTeX output and
// all) into #print-target, then hands off to the browser's native print
// dialog - "Save as PDF" there is the actual export. See style.css's
// @media print block for how #print-target gets isolated from the rest of
// the page; using a snapshot instead of printing .preview-pane in place
// means this works the same regardless of whether that pane is currently
// resized or collapsed.
function exportPreviewToPdf() {
  if (!active) return;
  el.printTarget.innerHTML = el.preview.innerHTML;
  window.print();
}

// The folder-level counterpart to exportPreviewToPdf above - same
// print-and-"Save as PDF" mechanism (see that function's comment and
// style.css's @media print block), just with every document directly in
// the folder rendered and concatenated into #print-target instead of one,
// each starting on its own page (see .print-doc-break in style.css).
// Ordered by filename because that's the order api.listDocuments/storage.
// list_documents already returns them in (a plain `sorted(dir.glob("*.md"))`
// server-side) - nothing to sort here. Only this folder's own documents,
// not any subfolders' - same scope as buildSessionNode's own document list
// for this row.
async function exportSessionToPdf(projectId, sessionId) {
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  // system.md is reachable separately (the folder's "⋯" menu) and isn't part of
  // what a reader would expect "this folder, as a PDF" to include - same
  // filter buildSessionNode uses for the tree's own document list.
  const docs = session.documents.filter((d) => d.role !== "system");
  if (docs.length === 0) return;
  el.printTarget.innerHTML = "";
  docs.forEach((doc, i) => {
    const dialect = detectMathDirective(doc.content) || sessionMathDialect(projectId, sessionId);
    const wrapper = document.createElement("div");
    wrapper.className = i > 0 ? "print-doc print-doc-break" : "print-doc";
    // Renders document content directly rather than through the preview, so
    // it needs its own pass at leaving the threads out.
    wrapper.innerHTML = renderMarkdown(stripInlineThreads(doc.content), dialect);
    el.printTarget.appendChild(wrapper);
  });
  // The browser's "Save as PDF" dialog suggests document.title as the
  // filename - normally kept in sync with whichever document is open (see
  // updateFilenameLabel), but that has nothing to do with this folder, so
  // it's swapped to the folder's own name just for this print call and put
  // back immediately after (window.print() blocks until the dialog closes,
  // same assumption exportPreviewToPdf implicitly makes by never touching
  // the title at all).
  const previousTitle = document.title;
  document.title = session.meta.title;
  window.print();
  document.title = previousTitle;
}

// Names the downloaded file after the open document's own filename,
// appending .md only if it doesn't already have some extension - most
// documents already end in .md/.csv, but a Hermes transcript's "filename"
// (see selectHermesSession) is just its title or id, with none.
function downloadFilenameFor(filename) {
  return /\.[A-Za-z0-9]+$/.test(filename) ? filename : `${filename}.md`;
}

// Downloads the editor's current buffer verbatim - exactly what the
// preview is rendering, unsaved edits included, same as printing to PDF
// above does. A plain Blob + temporary <a download> click, not a fetch to
// some backend endpoint - there's nothing server-side to ask for, the
// content is already sitting right here in the editor.
function downloadActiveAsMarkdown() {
  if (!active) return;
  const blob = new Blob([el.editor.value], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadFilenameFor(active.filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// An "exchange" document whose last recognized heading is a user heading
// (checked in whichever of the 3 languages it happens to be - see i18n.js's
// exchangeHeadingRole) has a pending question with no reply yet - either a
// send that failed partway (see start_exchange/complete_exchange), or a
// completed turn a new question was just typed onto the end of. Either way,
// sending should complete that same turn/file in place (storage.retry_exchange),
// not start a new one. Mirrors that function's own guard exactly - both
// must agree on what "still needs an answer" means.
function isIncompleteExchange(role, turnId, rawContent) {
  if (role !== "exchange" || !turnId) return false;
  let lastRole = null;
  for (const line of rawContent.split("\n")) {
    const heading = exchangeHeadingRole(line.trim());
    if (heading) lastRole = heading;
  }
  return lastRole === "user";
}

// Mirrors storage.retry_exchange's own prefix/question split for a pending
// (unanswered) turn: `prefix` is everything before the last user heading -
// any earlier complete rounds, kept verbatim - and `question` is the
// trimmed text after it. Used to keep the live streaming preview from
// discarding those earlier rounds or showing the pending heading twice (the
// buffer already has one; the actual request still sends the raw buffer,
// which the backend splits the same way).
function splitPendingQuestion(rawContent) {
  const lines = rawContent.split("\n");
  let lastUserLine = -1;
  lines.forEach((line, i) => {
    if (exchangeHeadingRole(line.trim()) === "user") lastUserLine = i;
  });
  return {
    prefix: lines.slice(0, lastUserLine).join("\n").replace(/\n+$/, ""),
    question: lines.slice(lastUserLine + 1).join("\n").trim(),
  };
}

// Decides whether sending should complete `active`'s own turn in place
// instead of starting a brand new one - and if so, splits the buffer into
// the untouched history ahead of the new question and the question itself.
// Any document that's already an exchange (has a turnId) stays that same
// exchange for every future send - there's no shape of edit that falls
// through to "start a new turn/file elsewhere" anymore (see sendActive());
// the only question is *how* to read the new question back out of
// whatever's currently in the editor. In every case, what gets sent is
// exactly what's visible in the buffer right now - never anything the
// editor isn't currently showing, or a send would silently smuggle in
// content the buffer doesn't even display any more, which is exactly the
// kind of "what I see isn't what happens" confusion this has to avoid:
// - **An explicit heading is already there** (isIncompleteExchange) -
//   either an unchanged retry of a still-failed send, or a new "## User"
//   (any of the 3 languages) typed by hand below the last answer. Used
//   verbatim; `splitPendingQuestion` finds the split point itself.
// - **Plain text just grew past the turn's last saved, complete state** -
//   the common case, since typing a follow-up question is the whole point
//   and nobody should have to know the heading syntax to do it. The saved
//   content is still sitting there in the buffer, untouched, so keeping it
//   as `prefix` isn't smuggling anything in - it's exactly what's on
//   screen; only the new text typed after it becomes the new question.
// - **Anything else** - text edited or deleted partway through, the whole
//   buffer replaced with something else entirely, or anything that isn't a
//   clean append - the saved content is *not* still visible as-is, so it's
//   not carried along as an invisible `prefix` here (an in-place edit to
//   already-sent history should go through Save, not Send, if it's meant
//   to persist). The buffer's entire current content becomes this round's
//   new question instead, same as if this were this turn's very first
//   question - whatever this turn already had saved stays in the file as
//   its own earlier history (see retry_exchange), it just isn't restated
//   as part of the outgoing question text.
// `needsHeading` tells sendActive() it has to insert a heading itself
// before sending in the second and third cases, since nothing marks where
// the question starts otherwise (storage.py's parse_exchange would just
// fold that plain text into the previous answer, same as any other text
// with no heading of its own).
// Returns null only when there's nothing actually new to send.
function detectPendingQuestion(activeDoc, rawContent) {
  if (!activeDoc || activeDoc.role !== "exchange" || !activeDoc.turnId) return null;
  if (isIncompleteExchange(activeDoc.role, activeDoc.turnId, rawContent)) {
    return { ...splitPendingQuestion(rawContent), needsHeading: false };
  }
  const saved = activeDoc.savedContent.replace(/\n+$/, "");
  if (rawContent.startsWith(saved)) {
    const question = rawContent.slice(saved.length).trim();
    if (question) return { prefix: saved, question, needsHeading: true };
    return null;
  }
  const question = rawContent.trim();
  if (!question || question === saved) return null;
  return { prefix: "", question, needsHeading: true };
}

// Draft-only "inline send" (see sendActive's branch into this below): once
// a draft already has real saved content, sending completes just the
// sentence right behind the cursor in place, rather than promoting the
// whole buffer into a fresh formal turn. "Sentence" = from the last
// sentence-ending punctuation before the cursor (., !, ?, and the CJK
// full-width equivalents 。！？), or a newline, up to the cursor - the
// newline bound keeps a plain trailing line (e.g. typed at the very end of
// a long-running notes draft, with no punctuation of its own yet) from
// pulling in unrelated earlier lines/paragraphs that happen to be the
// nearest thing with a sentence-ending mark.
const SENTENCE_END_RE = /[.!?。！？\n]/;

function sentenceBeforeCursor(text, cursorPos) {
  const { text: sentence } = sentenceRangeBeforeCursor(text, cursorPos);
  return sentence;
}

// Same rule as above, but reporting where in the buffer the sentence starts
// as well - starting a thread *moves* the question into it, so the range it
// occupied has to be replaced, not just read.
function sentenceRangeBeforeCursor(text, cursorPos) {
  let before = text.slice(0, cursorPos);
  // A sentence-ending *punctuation* mark sitting right at the cursor is the
  // just-typed sentence's own closing mark, not an earlier sentence's
  // boundary - e.g. cursor right after "...equation." would otherwise match
  // immediately and return "" instead of the sentence itself. Peel off (at
  // most) one before searching, then reattach it to the result below. A
  // newline right at the cursor is different: an empty line the user
  // hasn't typed on yet really is the boundary, so it's excluded from this
  // peel and left to match normally (returning "").
  let tail = "";
  const last = before[before.length - 1];
  if (last !== undefined && last !== "\n" && SENTENCE_END_RE.test(last)) {
    tail = last;
    before = before.slice(0, -1);
  }
  let boundary = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    if (SENTENCE_END_RE.test(before[i])) {
      boundary = i;
      break;
    }
  }
  const raw = before.slice(boundary + 1) + tail;
  // Leading whitespace isn't part of the sentence, and the range mustn't
  // claim it either: replacing from before it would eat the blank line that
  // separates this paragraph from the one above.
  const lead = raw.length - raw.trimStart().length;
  return { start: boundary + 1 + lead, end: cursorPos, text: raw.trim() };
}

// ---------- inline threads ----------
// (the markers themselves are declared at the top of this file - see why
// there)
// A scratch conversation kept inside the document itself, between a pair of
// marker lines. It's the one construct three separate needs share: the
// markers bound what gets sent back as history (so a thread can go
// multi-turn), what the preview and a published page leave out (see
// stripInlineThreads, and storage.strip_inline_threads for the server side
// of the same job), and - eventually - what an editor could fold away.
//
// Inside, turns carry the same "## User"/"## Assistant" headings a formal
// exchange document uses (i18n.js's chat.userHeading/exchangeHeadingRole),
// in whatever language they were written in, so the same vocabulary works
// across both. A completed reply is always followed by a fresh, empty user
// heading: that's what makes "the text the user just typed" unambiguous on
// the next send, rather than indistinguishable from the tail of the answer.
// The opening marker carries the thread's own collapsed/expanded state, so
// it travels with the document instead of living in some per-browser view
// state that a reload or another device would lose. Expanded means "render
// this in the preview" (see renderDocumentWithThreads) - a published page
// strips every thread either way, which is what the state is *not* for.
// Line-scanned rather than matched with one regex: the body is ordinary
// Markdown that routinely contains code fences and $$...$$ blocks, and an
// unclosed opener has to stay harmless (it bounds nothing) instead of
// swallowing the rest of the document.
function inlineThreads(text) {
  const threads = [];
  let offset = 0;
  let open = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const opening = INLINE_OPEN_RE.exec(trimmed);
    if (opening) {
      open = { start: offset, bodyStart: offset + line.length + 1, shown: !!opening[1] };
    } else if (INLINE_CLOSE_RE.test(trimmed) && open) {
      threads.push({ ...open, bodyEnd: offset, end: offset + line.length });
      open = null;
    }
    offset += line.length + 1;
  }
  return threads;
}

function inlineThreadAt(text, pos) {
  return inlineThreads(text).find((t) => pos >= t.start && pos <= t.end) || null;
}

// What every rendering surface shows: the document minus its threads. The
// editor's own buffer is never rewritten by this - the thread stays in the
// file, which is the whole point.
function stripInlineThreads(text) {
  const threads = inlineThreads(text);
  if (!threads.length) return text;
  let out = text;
  for (const thread of [...threads].reverse()) {
    let end = thread.end;
    if (out[end] === "\n") end += 1;
    out = out.slice(0, thread.start) + out.slice(end);
  }
  return out;
}

// The preview's counterpart to stripInlineThreads: collapsed threads are
// left out exactly as before, expanded ones are rendered in place inside a
// box of their own. Rendered as separate segments rather than by handing
// the whole document to renderMarkdown, so the thread's own markup can wrap
// it - which also means a Markdown construct can't span a thread boundary,
// a fair trade for a block-level divider.
function renderDocumentWithThreads(text, dialect) {
  // A reply that edited the document beside it reads as "edited", not as
  // its raw SEARCH/REPLACE blocks (see doc-edits.js).
  text = collapseEditBlocks(text, `> ✏️ ${t("docEdit.blockNote")}`);
  const threads = inlineThreads(text);
  if (!threads.length) return renderMarkdown(text, dialect);
  // Each segment is rendered on its own, so only the one holding the
  // document's `<!-- math: ... -->` directive would see it - everything after
  // the first thread would fall back to the inherited dialect and render
  // AsciiMath as LaTeX. Resolve it once, from the whole document.
  dialect = detectMathDirective(text) || dialect;
  const parts = [];
  let cursor = 0;
  for (const thread of threads) {
    parts.push(renderMarkdown(text.slice(cursor, thread.start), dialect));
    if (thread.shown) {
      const body = renderMarkdown(text.slice(thread.bodyStart, thread.bodyEnd), dialect);
      parts.push(`<div class="inline-thread">${body}</div>`);
    }
    cursor = thread.end + (text[thread.end] === "\n" ? 1 : 0);
  }
  parts.push(renderMarkdown(text.slice(cursor), dialect));
  return parts.join("");
}

// The ranges the editor can fold, one per thread: from the end of the
// opening marker line to the end of the closing one, so the marker itself
// stays visible as the thing you click to unfold. `folded` mirrors the
// marker, which is what keeps the gutter and the preview telling the same
// story (see editor.js's threadFolds).
function inlineFoldRanges(text) {
  return inlineThreads(text).map((thread) => ({
    markerFrom: thread.start,
    from: thread.bodyStart - 1,
    to: thread.end,
    folded: !thread.shown,
  }));
}

// Every Markdown heading folds its own section: from the end of the heading
// line to the end of the last line before the next heading of the same or a
// higher level (trailing blank lines left out, so the next heading doesn't
// end up glued to the fold). Headings *inside* an inline thread are skipped
// - that thread already folds as one block, and a "## 사용자" inside it would
// otherwise claim a section running past the thread's own closing marker.
function headingFoldRanges(text) {
  const threads = inlineThreads(text);
  const lines = [];
  let offset = 0;
  let fence = null;
  for (const line of text.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const inFence = !!fence;
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && !fenceMatch[2].trim()) fence = null;
    }
    const heading = !inFence && !fenceMatch && /^(#{1,6})\s/.exec(line);
    const insideThread = threads.some((thread) => offset >= thread.start && offset <= thread.end);
    lines.push({
      start: offset,
      end: offset + line.length,
      level: heading ? heading[1].length : 0,
      role: heading && !insideThread ? exchangeHeadingRole(line.trim()) : null,
      blank: !line.trim(),
    });
    offset += line.length + 1;
  }
  const ranges = [];
  lines.forEach((line, index) => {
    if (!line.level) return;
    if (threads.some((thread) => line.start >= thread.start && line.start <= thread.end)) return;
    let last = lines.length - 1;
    for (let next = index + 1; next < lines.length; next++) {
      // Exchange headings own the entire reply, including its Markdown
      // sections. A heading quoted inside an inline thread isn't a turn.
      if (line.role ? lines[next].role : lines[next].level && lines[next].level <= line.level) {
        last = next - 1;
        break;
      }
    }
    while (last > index && lines[last].blank) last -= 1;
    if (lines[last].end > line.end) ranges.push({ markerFrom: line.start, from: line.end, to: lines[last].end });
  });
  return ranges;
}

// What the editor offers a fold arrow for. Threads and headings both, but
// only the thread ones are reconciled against the document afterwards (see
// syncInlineFolds) - a heading's fold is ordinary view state, with nothing
// in the document to disagree with.
// Memoized on the document text because the fold gutter asks per *line*:
// without this, drawing one screenful re-scans the whole document once for
// every visible line. The cache hangs off the function rather than sitting
// in a module-level `let` because this runs during `el`'s own construction
// at the top of this file - anything declared further down is still in the
// temporal dead zone at that point, and CodeMirror swallows the resulting
// ReferenceError as a crashed plugin, leaving the gutter silently missing.
function editorFoldRanges(text) {
  if (!editorFoldRanges.cache || editorFoldRanges.cache.text !== text) {
    editorFoldRanges.cache = { text, ranges: [...inlineFoldRanges(text), ...headingFoldRanges(text)] };
  }
  return editorFoldRanges.cache.ranges;
}

// Keeps the editor's folds matching the markers. Called from renderPreview,
// which already runs after every content change - and a no-op whenever the
// view is already in agreement, which is most of the time.
function syncInlineFolds() {
  el.editor.syncThreadFolds(inlineFoldRanges(el.editor.value));
}

// The gutter arrow's target: a thread addressed by where its marker line
// starts, rather than by the caret (which is somewhere else entirely when
// you click a gutter). Returns whether it was a thread; a heading isn't, and
// is left to CodeMirror's own fold.
function toggleInlineThreadAt(markerLineStart) {
  const thread = inlineThreads(el.editor.value).find((candidate) => candidate.start === markerLineStart);
  if (!thread) return false;
  setInlineThreadShown(thread, !thread.shown);
  return true;
}

// Flips one thread between collapsed and expanded by rewriting its opening
// marker - an ordinary text edit, so it undoes like one and saves like one.
// The caret is put back where it was (shifted by however much the marker
// grew or shrank), since toggling is something you do *while* reading.
function toggleInlineThreadAtCursor() {
  if (!active || streaming) return;
  const thread = inlineThreadAt(el.editor.value, el.editor.selectionStart);
  if (thread) setInlineThreadShown(thread, !thread.shown);
}

// The one writer of a thread's collapsed/expanded state, whichever control
// asked for it (the 👁 button, the fold gutter, a click on the rendered
// thread in the preview). Rewriting the marker is an ordinary text edit, so
// it undoes and saves like one; the caret is put back where it was, shifted
// by however much the marker grew or shrank, since toggling is something
// you do *while* reading.
function setInlineThreadShown(thread, shown) {
  const value = el.editor.value;
  const caret = el.editor.selectionStart;
  const marker = shown ? INLINE_THREAD_OPEN_SHOWN : INLINE_THREAD_OPEN;
  const lineEnd = value.indexOf("\n", thread.start);
  const end = lineEnd === -1 ? value.length : lineEnd;
  if (value.slice(thread.start, end).trim() === marker) return;
  replaceEditorRange(thread.start, end, marker);
  const shift = marker.length - (end - thread.start);
  // A caret left inside a collapsed thread would make CodeMirror unfold it
  // again, so collapsing moves it onto the marker line that stays visible.
  // A caret elsewhere just follows the text around it.
  let next = caret;
  if (caret >= thread.start && caret <= end) next = thread.start;
  else if (caret > end && caret <= thread.end) next = shown ? caret + shift : thread.start;
  else if (caret > thread.end) next = caret + shift;
  el.editor.selectionStart = el.editor.selectionEnd = next;
  updateInlineThreadButton();
}

// Only meaningful with the caret inside a thread, so it's shown only then -
// same "appear where you'd use it" rule the publish and inline buttons
// follow. Its highlight mirrors the thread's current state, so the button
// doubles as the answer to "is this one expanded?".
function updateInlineThreadButton() {
  const thread = active && active.role === "draft" ? inlineThreadAt(el.editor.value, el.editor.selectionStart) : null;
  el.threadToggleBtn.hidden = !thread;
  el.threadToggleBtn.disabled = !thread || streaming;
  el.threadToggleBtn.classList.toggle("dirty", !!(thread && thread.shown));
}

// A thread body split back into turns, plus whatever sits under a trailing
// user heading with no answer yet - the pending question. Text before the
// first heading is ignored rather than guessed at: a thread always opens
// with one.
function parseInlineThread(body) {
  const turns = [];
  let role = null;
  let buffer = [];
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (role && content) turns.push({ role, content });
    buffer = [];
  };
  for (const line of body.split("\n")) {
    const headingRole = exchangeHeadingRole(line.trim());
    if (headingRole) {
      flush();
      role = headingRole;
    } else {
      buffer.push(line);
    }
  }
  flush();
  const pending = turns.length && turns[turns.length - 1].role === "user" ? turns.pop() : null;
  return { history: turns, question: pending ? pending.content : "" };
}

// Every send leaves the same frame around the answer: its own heading above,
// and below it an empty user heading for the follow-up (see the section
// comment above). Kept as two halves so the answer can be streamed into the
// middle of a thread that is already complete and closed.
//
// The foot ends with the fresh user heading, a blank line, and then the line
// the caret lands on (see placeCursorAboveInlineClose) - so a follow-up typed
// there sits under its heading exactly the way the first question does,
// which is what keeps a thread readable in an editor that can't fold it yet.
function inlineReplyFrame() {
  return {
    head: `${t("chat.assistantHeading")}\n\n`,
    foot: `\n\n${t("chat.userHeading")}\n\n\n`,
  };
}

// What a first send opens its thread with: expanded, because the answer you
// just asked for is the one you most want to read, math rendered and all.
// Collapsing is what you do when it's done.
function inlineThreadOpen(question) {
  return `${INLINE_THREAD_OPEN_SHOWN}\n\n${t("chat.userHeading")}\n\n${question}\n\n`;
}

// Writes the frame (and, for a first send, the whole thread around it) into
// the document with an *empty* answer, and returns where that answer goes.
// The thread is closed and well-formed from this moment on, so the preview
// renders it as a box while the reply streams in - see streamInlineReply.
// `thread` is null for the first send at this spot, which is the case that
// has to build the markers and move the question inside them.
function beginInlineReply(thread, cursorPos, question) {
  const { head, foot } = inlineReplyFrame();
  if (thread) {
    // Appended just before the closing marker, so it lands inside the
    // thread however much prose follows it in the document. The question
    // above it ends in a single newline, so this adds the blank line that
    // keeps the next heading a block of its own.
    const separated = el.editor.value.slice(0, thread.bodyEnd).endsWith("\n\n") ? "" : "\n";
    replaceEditorRange(thread.bodyEnd, thread.bodyEnd, separated + head + foot);
    return thread.bodyEnd + separated.length + head.length;
  }
  const { start } = sentenceRangeBeforeCursor(el.editor.value, cursorPos);
  const open = inlineThreadOpen(question);
  // A thread is a block of its own: keep it off the end of whatever
  // paragraph it was extracted from, and off the start of what follows.
  const before = start > 0 && el.editor.value[start - 1] !== "\n" ? "\n\n" : "";
  const after = el.editor.value[cursorPos] === "\n" ? "" : "\n";
  replaceEditorRange(start, cursorPos, `${before}${open}${head}${foot}${INLINE_THREAD_CLOSE}${after}`);
  return start + before.length + open.length + head.length;
}

// The caret belongs on the blank line under the thread's trailing user
// heading, so a follow-up can just be typed. Takes the offset the closing
// marker's own line starts at - both callers know that, where "the end of
// what I inserted" means two different things (the tail ends *at* the
// marker, a whole new block ends *after* it).
function placeCursorAboveInlineClose(closeLineStart) {
  const pos = Math.max(0, closeLineStart - 1);
  el.editor.selectionStart = el.editor.selectionEnd = pos;
  el.editor.focus();
  syncPreviewScrollFromSource("a");
}

// Deliberately the lightest possible sibling of sendActive below: no
// history, no system-prompt-inheriting turn, nothing ever written to
// storage as a turn at all (see routers/conversations.py's inline_complete).
// The draft stays a draft; nothing here promotes it into an "exchange".
//
// Two shapes, decided by where the cursor is (see the inline-threads section
// above):
//   - inside a thread: the text under its trailing user heading is the next
//     question, the thread's earlier turns go along as history, and the
//     answer is appended inside the same thread.
//   - anywhere else: the sentence behind the cursor *becomes* the first
//     question of a new thread, moved out of the document body into it -
//     with ✨ meaning "ask", that sentence is a question, not prose.
// The answer streams into the document as it arrives (see beginInlineReply),
// so the thread appears with the first words rather than after the last. If
// the request fails the document is put back exactly as it was.
//
// Reached from its own button and Shift+Cmd/Ctrl+Enter (see
// updateInlineCompleteButton) - the send button never routes here.
async function sendInlineCompletion() {
  // Same shape of guard sendActive/togglePublish open with: the button is
  // hidden for everything but a draft (updateInlineCompleteButton), but the
  // paths that swap the open document without going through
  // updateSendAvailability (clearEditor, a Hermes transcript) can leave it
  // on screen for a moment, and splicing generated text into a read-only
  // transcript is not something to find out about afterwards.
  if (!active || streaming || active.role !== "draft") return;
  const cursorPos = el.editor.selectionStart;
  const thread = inlineThreadAt(el.editor.value, cursorPos);
  const parsed = thread ? parseInlineThread(el.editor.value.slice(thread.bodyStart, thread.bodyEnd)) : null;
  // In a thread, the pending question is whatever sits under its trailing
  // user heading - an empty one means there's nothing to ask yet.
  const question = parsed ? parsed.question : sentenceBeforeCursor(el.editor.value, cursorPos);
  const history = parsed ? parsed.history : [];
  if (!question) return;
  // What the question is asked *about*: the document above it - above the
  // thread when continuing one, above the sentence that's about to become
  // the question otherwise. Other threads are left out, the same way every
  // rendering surface leaves them out: they're side conversations, not the
  // document.
  const contextEnd = thread ? thread.start : sentenceRangeBeforeCursor(el.editor.value, cursorPos).start;
  const documentContext = stripInlineThreads(el.editor.value.slice(0, contextEnd)).trim();

  const settings = {
    provider: el.providerSelect.value,
    model: el.modelSelect.value,
    reasoningEffort: el.reasoningSelect.value,
    convertMath: el.formatSelect.value !== "latex",
    hybridMath: el.formatSelect.value === "hybrid",
  };
  if (!settings.provider || !settings.model) return;
  const { projectId, sessionId } = active;

  streaming = true;
  el.editor.disabled = true;
  el.saveBtn.disabled = true;
  el.sendBtn.disabled = true;
  el.inlineCompleteBtn.disabled = true;
  updateDictationButton();
  el.providerSelect.disabled = true;
  el.modelSelect.disabled = true;
  el.reasoningSelect.disabled = true;
  el.contextScopeSelect.disabled = true;
  el.formatSelect.disabled = true;
  setToolStatus(t("editor.generating"));

  // The document as it was, for putting back if the answer never arrives.
  const snapshot = el.editor.value;
  // Where the answer goes and how much of it is in the document so far. Both
  // stay null until the first delta: a request that fails before producing
  // anything must not have touched the document at all.
  let replyStart = null;
  let replyEnd = null;
  let fullText = "";
  let errored = false;
  const restore = () => {
    if (replyStart === null) return;
    el.editor.value = snapshot;
    el.editor.selectionStart = el.editor.selectionEnd = Math.min(cursorPos, snapshot.length);
    updateFilenameLabel();
    updateFormatToolbar();
    renderPreview();
    replyStart = replyEnd = null;
  };
  try {
    await api.inlineComplete(projectId, sessionId, question, history, documentContext, settings, async (event) => {
      if (event.type === "tool_status") {
        const label = event.label || event.tool || "";
        setToolStatus(
          event.status === "running"
            ? t("status.toolRunning", { emoji: event.emoji || "🔧", label })
            : t("status.toolDone", { label })
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } else if (event.type === "delta") {
        fullText += event.text;
        if (replyStart === null) {
          // Nothing to show yet at the first delta except the thread itself,
          // so it is built here rather than up front: a tool-using answer can
          // spend a while before its first word, and an empty box that long
          // looks like the click did something wrong.
          replyStart = replyEnd = beginInlineReply(thread, cursorPos, question);
          setToolStatus("");
          streamFollow.preview = isScrolledToBottom(el.preview);
        }
        replaceEditorRange(replyEnd, replyEnd, event.text);
        replyEnd += event.text.length;
        if (streamFollow.preview) el.preview.scrollTop = 1e9;
      } else if (event.type === "done") {
        // The final text (post math-conversion, if requested) - what the
        // streamed deltas above get replaced with, not merely appended to.
        fullText = event.text;
      } else if (event.type === "error") {
        errored = true;
        alert(t("action.error", { message: event.message }));
      }
    });
    const reply = fullText.trim();
    if (errored || !reply) {
      restore();
    } else {
      if (replyStart === null) replyStart = replyEnd = beginInlineReply(thread, cursorPos, question);
      replaceEditorRange(replyStart, replyEnd, reply);
      placeCursorAboveInlineClose(replyStart + reply.length + inlineReplyFrame().foot.length);
    }
  } catch (err) {
    restore();
    alert(t("action.sendFailed", { message: err.message }));
  } finally {
    streaming = false;
    el.editor.disabled = false;
    el.saveBtn.disabled = !active;
    el.providerSelect.disabled = false;
    el.modelSelect.disabled = false;
    el.reasoningSelect.disabled = false;
    el.contextScopeSelect.disabled = false;
    el.formatSelect.disabled = false;
    updateSendAvailability();
    setToolStatus("");
  }
}

// Always the formal turn: whatever's in the buffer becomes this turn's
// question (promoting a draft into an exchange - see storage.start_exchange's
// draft_filename), and the reply lands under its own "## Assistant" heading.
// Completing a sentence in place instead is the inline-complete button's own
// job (sendInlineCompletion above), never something inferred from the draft's
// save state or cursor position here - which it used to be, and which made
// this button silently mean two different things.
// ---------- document editing from the conversation ----------
//
// With split view showing a document, the conversation in pane A can write
// to it: a message sent with the ✏️ toggle on carries pane B's text (as the
// editor shows it, unsaved edits included), the model answers with edit
// blocks (see doc-edits.js and the backend's _target_document_prompt), and
// each block is applied to pane B as it finishes streaming - as ordinary
// unsaved edits. Nothing is saved for the user; the strip above pane B says
// what changed and takes it all back in one click.

function editTargetAvailable() {
  return splitViewOpen() && !!activeB && !!active && !NON_SENDABLE_ROLES.has(active.role);
}

function updateEditTargetButton() {
  const available = editTargetAvailable();
  el.editTargetBtn.hidden = !available;
  if (!available) return;
  el.editTargetBtn.setAttribute("aria-pressed", editTargetOn ? "true" : "false");
  el.editTargetBtn.title = t(editTargetOn ? "docEdit.targetOn" : "docEdit.targetOff", { name: activeB.filename });
}

function toggleEditTarget() {
  editTargetOn = !editTargetOn;
  try {
    localStorage.setItem(EDIT_TARGET_KEY, editTargetOn ? "1" : "0");
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
  updateEditTargetButton();
}

function hideDocEditStrip() {
  docEdit = null;
  el.docEditStrip.hidden = true;
}

function showDocEditStrip() {
  if (!docEdit || (!docEdit.applied && !docEdit.failed)) return;
  const parts = [];
  if (docEdit.applied) parts.push(t("docEdit.applied", { count: docEdit.applied }));
  if (docEdit.failed) parts.push(t("docEdit.failed", { count: docEdit.failed }));
  el.docEditSummary.textContent = parts.join(" · ");
  el.docEditUndoBtn.hidden = !docEdit.applied;
  el.docEditStrip.hidden = false;
}

// Applies whichever edit blocks have finished arriving since the last call.
function applyReplyEdits({ final = false } = {}) {
  const edit = docEdit;
  // Pane B was pointed at another document mid-reply - the rest isn't for it.
  if (!edit || activeB !== edit.doc) return;
  const blocks = parseEditBlocks(edit.reply, { final });
  let changed = false;
  for (; edit.seen < blocks.length; edit.seen++) {
    const result = applyEditBlock(el.editorB.value, blocks[edit.seen]);
    if (!result) {
      edit.failed += 1;
      continue;
    }
    el.editorB.replaceRange(result.from, result.to, result.text);
    // Leaves the newest change selected (and scrolled to), so it can be found.
    el.editorB.setSelectionRange(result.start, result.end);
    edit.applied += 1;
    changed = true;
  }
  if (changed) {
    updateFilenameLabelB();
    if (previewSource === "b") renderPreview();
  }
  if (changed || final) showDocEditStrip();
}

function undoDocEdit() {
  if (!docEdit || activeB !== docEdit.doc) return;
  el.editorB.value = docEdit.before;
  updateFilenameLabelB();
  if (previewSource === "b") renderPreview();
  hideDocEditStrip();
}

async function sendActive() {
  if (!active || streaming || NON_SENDABLE_ROLES.has(active.role)) return;
  const rawContent = el.editor.value;
  const pending = detectPendingQuestion(active, rawContent);
  const retryTurnId = pending ? active.turnId : null;
  // For the "plain text, no heading typed" case, the request body needs an
  // explicit heading of its own so the backend's parse_exchange recognizes
  // a new pending question - without one, that trailing text just reads as
  // more of the previous answer. Otherwise (a from-scratch send, or one
  // that already has its own heading - typed by hand, or an unchanged retry)
  // `rawContent` already carries whatever it needs and is sent verbatim;
  // storage.retry_exchange renormalizes an existing heading under the
  // current language regardless of what was actually typed.
  const content =
    pending && pending.needsHeading
      ? `${pending.prefix ? pending.prefix + "\n\n" : ""}${t("chat.userHeading")}\n\n${pending.question}`
      : rawContent;
  const settings = {
    provider: el.providerSelect.value,
    model: el.modelSelect.value,
    reasoningEffort: el.reasoningSelect.value,
    contextScope: el.contextScopeSelect.value,
    // Whichever format the radio currently shows for this document is also
    // the requested output format for the response about to be generated -
    // see convertActiveFormat/updateFormatToolbar. Hybrid also wants
    // conversion (just dollar-only - see hybridMath below), so it counts
    // here too, not just plain AsciiMath.
    convertMath: el.formatSelect.value !== "latex",
    hybridMath: el.formatSelect.value === "hybrid",
    // A send from an open draft grows that same document into the exchange
    // instead of spawning a new file - see storage.start_exchange.
    draftFilename: active.role === "draft" ? active.filename : null,
    // A retry of a failed send, or a new question continuing an already-
    // complete turn, completes that same turn instead of starting a new
    // one - see storage.retry_exchange. Mutually exclusive with
    // draftFilename (a document is never both a draft and an "exchange").
    retryTurnId,
    // Decides which language's "## User"/"## Assistant"-equivalent heading
    // pair gets attached to whatever's new in this send - see i18n.js and
    // storage.py's EXCHANGE_HEADINGS.
    language: getLanguage(),
    targetDocument: editTargetOn && editTargetAvailable() ? { filename: activeB.filename, content: el.editorB.value } : null,
  };
  if (!settings.provider || !settings.model) return;
  hideDocEditStrip();
  if (settings.targetDocument) {
    docEdit = { doc: activeB, before: el.editorB.value, reply: "", seen: 0, applied: 0, failed: 0 };
  }
  const displayUserContent = pending ? pending.question : content;
  const { projectId, sessionId } = active;

  streaming = true;
  el.editor.disabled = true;
  el.saveBtn.disabled = true;
  el.sendBtn.disabled = true;
  el.inlineCompleteBtn.disabled = true;
  updateDictationButton();
  el.providerSelect.disabled = true;
  el.modelSelect.disabled = true;
  el.reasoningSelect.disabled = true;
  el.contextScopeSelect.disabled = true;
  el.formatSelect.disabled = true;

  let assistantStarted = false;
  let completed = false;

  const restoreOnFailure = () => {
    if (assistantStarted && !completed) {
      // a partial assistant reply was streaming into the editor when things
      // broke; discard it rather than risk saving garbage over the real file
      el.editor.value = active.savedContent;
      updateFilenameLabel();
      updateFormatToolbar();
      renderPreview();
    }
  };

  try {
    await api.sendMessage(projectId, sessionId, content, settings, async (event) => {
      if (event.type === "user_turn") {
        await refreshSessionDocs(projectId, sessionId);
        if (settings.draftFilename || settings.retryTurnId) {
          // The draft was just consumed and reborn as this turn's file, or
          // the retried turn's file was just rewritten with just the
          // question again (see storage.start_exchange/retry_exchange) -
          // repoint `active` at it immediately (a no-op filename change for
          // the retry case), or a mid-stream failure below would
          // revert/save against stale content.
          active = { projectId, sessionId, filename: event.turn.file, role: "exchange", savedContent: event.turn.content, turnId: event.turn.id };
          saveActiveDocRef();
          updateFilenameLabel();
        }
        renderTree();
      } else if (event.type === "tool_status") {
        // Keep showing the latest status (don't clear on "completed") - real
        // gaps between one tool finishing and the next starting can be
        // several seconds, and an empty bar during that stretch looks like
        // nothing is happening at all.
        const label = event.label || event.tool || "";
        if (event.status === "running") {
          setToolStatus(t("status.toolRunning", { emoji: event.emoji || "🔧", label }));
        } else {
          setToolStatus(t("status.toolDone", { label }));
        }
        // If several tool_status lines arrive in the same network read (fast
        // tools can finish within milliseconds), the browser may never
        // actually paint the in-between states. Yield once per event so
        // each one gets a chance to render before the next is processed.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } else if (event.type === "delta") {
        if (!assistantStarted) {
          assistantStarted = true;
          el.editorFilename.textContent = t("editor.generating");
          // Matches storage.py's start_exchange/retry_exchange output so the
          // streamed preview already looks like the final merged file,
          // instead of suddenly gaining this header once the response
          // completes. `pending.prefix` (any earlier complete rounds for a
          // continued turn) is kept ahead of the fresh section, exactly as
          // the backend keeps it in the actual file.
          const newSection = `${t("chat.userHeading")}\n\n${displayUserContent.trim()}\n\n${t("chat.assistantHeading")}\n\n`;
          el.editor.value = pending && pending.prefix ? `${pending.prefix}\n\n${newSection}` : newSection;
          setToolStatus("");
          // The document was just replaced wholesale by the new exchange, so
          // wherever either pane was scrolled before means nothing now -
          // both start out following the reply.
          streamFollow.editor = streamFollow.preview = true;
        }
        el.editor.append(event.text);
        if (docEdit) {
          docEdit.reply += event.text;
          applyReplyEdits();
        }
        renderPreview();
        followStream();
      } else if (event.type === "assistant_turn") {
        completed = true;
        applyReplyEdits({ final: true });
        await refreshSessionDocs(projectId, sessionId);
        active = { projectId, sessionId, filename: event.turn.file, role: "exchange", savedContent: event.turn.content, turnId: event.turn.id };
        saveActiveDocRef();
        el.editor.value = event.turn.content;
        updateFilenameLabel();
        updateFormatToolbar();
        renderPreview();
        followStream();
        renderTree();
      } else if (event.type === "error") {
        alert(t("action.error", { message: event.message }));
        restoreOnFailure();
      }
    });
  } catch (err) {
    alert(t("action.sendFailed", { message: err.message }));
    restoreOnFailure();
  } finally {
    streaming = false;
    el.editor.disabled = false;
    el.saveBtn.disabled = !active;
    el.providerSelect.disabled = false;
    el.modelSelect.disabled = false;
    el.reasoningSelect.disabled = false;
    el.contextScopeSelect.disabled = false;
    el.formatSelect.disabled = false;
    updateSendAvailability();
    setToolStatus("");
    await refreshProjectSessions(projectId);
    renderTree();
    // Once the reply has fully arrived, land the cursor at the very end of
    // the now-updated document - ready to keep typing a follow-up question
    // right there, instead of wherever it happened to be (or nowhere, since
    // the editor was disabled) while streaming. Only for a genuine
    // completion - restoreOnFailure() above already reverted the buffer on
    // an error, and there's nothing useful to place the cursor after there.
    if (completed) {
      el.editor.focus();
      el.editor.setSelectionRange(el.editor.value.length, el.editor.value.length);
    }
  }
}

function populateModelOptions() {
  const provider = providers.find((p) => p.id === el.providerSelect.value);
  el.modelSelect.innerHTML = "";
  if (!provider) return;
  if (provider.models.length === 0) {
    // Every provider returned by getProviders() is already configured (see
    // list_providers()) - an empty list here means fetching its model list
    // itself failed, not a missing API key.
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("provider.noModelList");
    el.modelSelect.appendChild(opt);
  } else {
    for (const model of provider.models) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      if (model === provider.default_model) opt.selected = true;
      el.modelSelect.appendChild(opt);
    }
  }
  updateSendAvailability();
}

async function loadProviders() {
  // Without the defaults the app's own fallback just applies.
  const [list, defaults] = await Promise.all([api.getProviders(), api.getLlmDefaults().catch(() => ({}))]);
  providers = list;
  llmDefaults = defaults || {};
  const initial = appDefaultSettings().provider;
  el.providerSelect.innerHTML = "";
  for (const provider of providers) {
    const opt = document.createElement("option");
    opt.value = provider.id;
    // Provider labels come from the backend in English; a provider this app
    // itself defines (rather than one named in CUSTOM_OPENAI_PROVIDERS) can
    // carry a translation, keyed by its id.
    const labelKey = `provider.label.${provider.id}`;
    const translated = t(labelKey);
    opt.textContent = translated === labelKey ? provider.label : translated;
    if (provider.id === initial) opt.selected = true;
    el.providerSelect.appendChild(opt);
  }
  populateModelOptions();
  // The list can arrive after a document is already open (init doesn't
  // wait for it), in which case selectDocument's applyDocumentSettings ran
  // against empty selects - redo it now that there's something to select.
  if (active && !NON_SENDABLE_ROLES.has(active.role) && !streaming) {
    applyDocumentSettings(cachedDocument(active.projectId, active.sessionId, active.filename));
  }
}

async function createProject() {
  const input = prompt(t("prompt.createProject"), "");
  if (input === null) return;
  const meta = await api.createProject(input.trim() || undefined);
  await loadProjects();
  const project = projects.get(meta.id);
  project.expanded = true;
  await refreshProjectSessions(meta.id);
  saveExpandedTreeState();
  renderTree();
}

// Provider/model/사고 수준/변환 no longer live here - they're chosen per
// turn (see the send toolbar, shown once a sendable document is open), so
// creating a session now only needs a title.
async function createSession(projectId) {
  const input = prompt(t("prompt.createFolder"), "");
  if (input === null) return;
  const meta = await api.createConversation(projectId, input.trim() || undefined);
  await refreshProjectSessions(projectId);
  const project = projects.get(projectId);
  const session = project && project.sessions && project.sessions.get(meta.id);
  if (session) {
    session.expanded = true;
    session.documents = await api.listDocuments(projectId, meta.id);
  }
  saveExpandedTreeState();
  renderTree();
}

// Same as createSession, just nested under an existing folder instead of
// sitting at the project's top level - see storage.create_conversation's
// parent_id param. Expands both the new subfolder and the parent it was
// created under, so it's immediately visible instead of hiding inside a
// still-collapsed parent row.
async function createSubfolder(projectId, parentId) {
  const input = prompt(t("prompt.createFolder"), "");
  if (input === null) return;
  const meta = await api.createConversation(projectId, input.trim() || undefined, parentId);
  await refreshProjectSessions(projectId);
  const project = projects.get(projectId);
  const parent = project && project.sessions && project.sessions.get(parentId);
  if (parent) parent.expanded = true;
  const session = project && project.sessions && project.sessions.get(meta.id);
  if (session) {
    session.expanded = true;
    session.documents = await api.listDocuments(projectId, meta.id);
  }
  saveExpandedTreeState();
  renderTree();
}

el.newProjectBtn.addEventListener("click", createProject);
el.globalSystemRow.addEventListener("click", () => openInTab({ role: "global-system" }));
el.globalCustomSymbolsRow.addEventListener("click", () => openInTab({ role: "global-custom-symbols" }));
el.globalSpokenMathRow.addEventListener("click", () => openInTab({ role: "global-spoken-math" }));
el.hermesHeader.addEventListener("click", toggleHermesSection);
el.mobileTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".mobile-tab");
  if (btn) setMobileView(btn.dataset.view);
});
el.providerSelect.addEventListener("change", () => {
  populateModelOptions();
  persistDraftChoice();
});
el.modelSelect.addEventListener("change", () => {
  updateSendAvailability();
  persistDraftChoice();
});
el.reasoningSelect.addEventListener("change", () => {
  updateDefaultModelButton();
  persistDraftChoice();
});
el.setDefaultModelBtn.addEventListener("click", setDefaultModel);
el.contextScopeSelect.addEventListener("change", persistDraftChoice);
el.saveBtn.addEventListener("click", saveActive);
el.publishBtn.addEventListener("click", togglePublish);
el.toolbarToggleBtn.addEventListener("click", toggleEditorToolbar);
el.inlineCompleteBtn.addEventListener("click", sendInlineCompletion);
restoreDictationLang();
restoreDictationEngine();
el.dictationBtn.addEventListener("click", toggleDictation);
el.dictationEngine.addEventListener("change", () => {
  dictationEnginePreference = normalizeStoredEngine(el.dictationEngine.value);
  saveDictationEngine();
  updateDictationButton();
  if (!dictation) return;
  const playingFile = dictation.file ? audioFile : null;
  stopDictation();
  if (playingFile) {
    const next = chosenEngine("file");
    if (next) startBilledDictation(playingFile, next);
    return;
  }
  startDictation();
});
// A language change mid-dictation restarts it in the new language rather
// than waiting for the next pause.
el.dictationLang.addEventListener("change", () => {
  saveDictationLang();
  if (dictation) {
    stopDictation();
    startDictation();
  }
});
el.threadToggleBtn.addEventListener("click", toggleInlineThreadAtCursor);
// Whether the caret is inside a thread changes with every arrow key and
// click, and nothing else in this app tracks that - "selectionchange" on the
// textarea is the event that actually fires for all of them (input alone
// misses plain cursor moves).
el.editor.addEventListener("selectionchange", updateInlineThreadButton);
el.editor.addEventListener("click", updateInlineThreadButton);
el.editor.addEventListener("keyup", updateInlineThreadButton);
// Reading a thread and then collapsing it is one gesture, so the rendered
// box is itself the control: the Nth box in `container` is the Nth
// *expanded* thread, which is all the mapping this needs. A click on a link
// inside it is left to openInternalDocumentLink. Shared by the preview pane
// and the editor's own rendered view (see #view-mode-btn) - both render the
// exact same document-with-threads markup, just into different elements.
function collapseThreadOnClick(e, container) {
  if (!active || streaming || e.target.closest("a")) return;
  const box = e.target.closest(".inline-thread");
  if (!box) return;
  const boxes = [...container.querySelectorAll(".inline-thread")];
  const shown = inlineThreads(el.editor.value).filter((thread) => thread.shown);
  const thread = shown[boxes.indexOf(box)];
  if (thread) setInlineThreadShown(thread, false);
}
el.preview.addEventListener("click", (e) => collapseThreadOnClick(e, el.preview));
el.editorRendered.addEventListener("click", (e) => collapseThreadOnClick(e, el.editorRendered));
el.editorRendered.addEventListener("click", openInternalDocumentLink);
el.exportPdfBtn.addEventListener("click", exportPreviewToPdf);
el.downloadMdBtn.addEventListener("click", downloadActiveAsMarkdown);
el.editorScrollTopBtn.addEventListener("click", () => el.editor.scrollTo({ top: 0, behavior: "smooth" }));
el.editorScrollBottomBtn.addEventListener("click", () => {
  streamFollow.editor = true;
  el.editor.scrollTo({ top: el.editor.scrollHeight, behavior: "smooth" });
});
el.previewScrollTopBtn.addEventListener("click", () => el.preview.scrollTo({ top: 0, behavior: "smooth" }));
el.previewScrollBottomBtn.addEventListener("click", () => {
  streamFollow.preview = true;
  el.preview.scrollTo({ top: el.preview.scrollHeight, behavior: "smooth" });
});
el.editor.addEventListener("scroll", updateScrollNavVisibility);
el.preview.addEventListener("scroll", updateScrollNavVisibility);
watchUserScroll("editor", [el.editor.scrollElement, el.editorRendered]);
watchUserScroll("preview", [el.preview]);
el.preview.addEventListener("click", openInternalDocumentLink);
window.addEventListener("resize", updateScrollNavVisibility);
el.editor.addEventListener("scroll", () => syncPreviewScrollFromSource("a"));
el.editorB.addEventListener("scroll", () => {
  updateScrollNavVisibility();
  syncPreviewScrollFromSource("b");
});
el.syncScrollCheckbox.addEventListener("change", () => {
  saveSyncScrollPref();
  syncPreviewScrollFromSource(previewSource);
});
restoreSyncScrollPref();
el.glassesCheckbox.addEventListener("change", () => {
  saveGlassesEnabledPref();
  updateGlassesToolbarVisibility();
  if (el.glassesCheckbox.checked) {
    connectGlasses();
  } else {
    glassesSocket.disconnect();
  }
});
el.glassesCopyBtn.addEventListener("click", copyGlassesUrl);
restoreGlassesEnabledPref();
updateGlassesToolbarVisibility();
if (el.glassesCheckbox.checked) connectGlasses();
el.livePublicCheckbox.addEventListener("change", () => {
  saveLivePublicEnabledPref();
  updateLivePublicTarget();
  // A document with no publish token can't have been checked in the first
  // place (the row is hidden - see updateLivePublicTarget), so an unchecked
  // click here always means "stop", never "nothing to connect to yet".
  if (!el.livePublicCheckbox.checked) livePublicSocket.disconnect();
});
restoreLivePublicEnabledPref();
el.publishSlidesCheckbox.addEventListener("change", () => setPublishSlides(el.publishSlidesCheckbox.checked));
el.sendBtn.addEventListener("click", sendActive);
// convertActiveFormat is a no-op when the buffer is already in the picked
// format, and resets this selector back to the buffer's real format if the
// conversion fails (see its finally), so the selector can never end up
// claiming a format the text isn't actually in.
el.formatSelect.addEventListener("change", () => convertActiveFormat(el.formatSelect.value));
el.editor.addEventListener("input", () => {
  updateFilenameLabel();
  updateFormatToolbar();
  renderPreview();
});
// Pane B's counterpart of the above, and of the "which pane is the preview
// following" bookkeeping below - both editors report focus the same way
// (see editor.js's addEventListener: anything not specifically handled
// falls through to the underlying CodeMirror view's own DOM event).
el.editorB.addEventListener("input", () => {
  updateFilenameLabelB();
  renderPreviewB();
});
el.editor.addEventListener("focus", () => {
  focusedEditorPane = "a";
  setPreviewSource("a");
});
el.editorB.addEventListener("focus", () => {
  focusedEditorPane = "b";
  setPreviewSource("b");
});
el.editorB.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDocumentB();
  }
});
el.viewModeBtn.addEventListener("click", toggleEditorViewMode);
el.saveBtnB.addEventListener("click", saveDocumentB);
el.editTargetBtn.addEventListener("click", toggleEditTarget);
el.docEditUndoBtn.addEventListener("click", undoDocEdit);
el.docEditDismissBtn.addEventListener("click", hideDocEditStrip);
el.closeSplitBtn.addEventListener("click", closeSplitView);
el.splitToggleBtn.addEventListener("click", () => {
  if (splitViewOpen()) closeSplitView();
  else setSplitView(true);
});
el.editorScrollTopBtnB.addEventListener("click", () => el.editorB.scrollTo({ top: 0, behavior: "smooth" }));
el.editorScrollBottomBtnB.addEventListener("click", () =>
  el.editorB.scrollTo({ top: el.editorB.scrollHeight, behavior: "smooth" })
);
el.splitResizer.addEventListener("mousedown", (e) => startPaneResize(e, "split"));
el.quickOpenBtn.addEventListener("click", openQuickOpen);
// Cmd/Ctrl+P is Quick Open's usual home (VS Code, Sublime, ...), but it's
// also "print this page" in every browser by default - preventDefault below
// suppresses that, and does so reliably in Chrome/Firefox/Edge, but wasn't
// tried in Safari. Cmd/Ctrl+K rides along as a second, unrelated-enough
// binding (Slack/Linear/GitHub's own "command palette" key) in case P turns
// out to be unavailable on some platform after all.
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !el.shortcutsOverlay.hidden) return;
  if (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "k") {
    e.preventDefault();
    openQuickOpen();
  }
});
el.quickOpenOverlay.addEventListener("click", (e) => {
  if (e.target === el.quickOpenOverlay) closeQuickOpen();
});
el.quickOpenInput.addEventListener("input", () => {
  quickOpenSelected = 0;
  quickOpenFiltered = quickOpenFilter(el.quickOpenInput.value);
  renderQuickOpenResults();
});
el.quickOpenInput.addEventListener("keydown", (e) => {
  // The jump modifier (⌃ on a Mac, Alt elsewhere - see hintModifierHeld) +
  // 1-9 opens that row directly. Bare digits stay search input (filenames
  // are often numbers), and ⌘+digit is the browser's own tab switcher.
  const digit = hintModifierHeld(e) && /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    chooseQuickOpenResult(quickOpenFiltered[Number(digit[1]) - 1], false);
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeQuickOpen();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveQuickOpenSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveQuickOpenSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseQuickOpenResult(quickOpenFiltered[quickOpenSelected], e.metaKey || e.ctrlKey);
  }
});
el.shortcutsBtn.addEventListener("click", openShortcutsHelp);
el.shortcutsCloseBtn.addEventListener("click", closeShortcutsHelp);
el.shortcutsOverlay.addEventListener("click", (e) => {
  if (e.target === el.shortcutsOverlay) closeShortcutsHelp();
});
document.addEventListener("keydown", (e) => {
  if (!el.shortcutsOverlay.hidden && e.key === "Escape") {
    e.preventDefault();
    closeShortcutsHelp();
    return;
  }
  // ⌘/Ctrl+/ works everywhere, editors included - a modifier combo never
  // types a character, so there's no "is this a text field" question to ask
  // first (unlike bare "?" below). The one this app leads with in its own
  // shortcuts list, precisely because it isn't blocked while editing.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "/") {
    e.preventDefault();
    openShortcutsHelp();
    return;
  }
  // ⌘/Ctrl+B and ⌥⌘/Ctrl+Alt+B: VS Code's own keys for its left and right
  // sidebars, here the navigation tree and the preview. Same "works while
  // editing" reasoning as ⌘/ above. Matched on e.code, not e.key - Option
  // turns the B into "∫" on a Mac keyboard.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyB") {
    e.preventDefault();
    if (e.altKey) setPreviewCollapsed(!el.layout.classList.contains("preview-collapsed"));
    else setTreeCollapsed(!el.layout.classList.contains("tree-collapsed"));
    return;
  }
  // "?" only outside a text field - it's ordinary prose punctuation in a
  // document, the quick-open box, or any other input, and only a shortcut
  // everywhere else (mirrors Gmail/Slack/Notion's own convention for this
  // exact key). e.key already accounts for Shift itself (a bare "?" key on
  // some layouts, Shift+/ on a US one both arrive as "?"), so nothing here
  // has to check shiftKey.
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = document.activeElement;
  const typing =
    target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest(".cm-editor"));
  if (typing) return;
  e.preventDefault();
  openShortcutsHelp();
});
// A plain <textarea> treats Tab as "move focus to the next control" (the
// browser default) - useless in a markdown/AsciiMath editor where Tab is
// how you'd indent a list item one level deeper (see asciimath-markdown's nested-
// list support). Shift+Tab removes one indent level instead.
const TAB_INDENT = "  ";

// Replaces the current selection (or just inserts at the caret if it's
// collapsed) with `text`, for the caret-position cases below (plain Tab,
// Enter's indent carry-over) that never move the selection themselves
// first. execCommand is deprecated but still the way to do this while
// keeping the browser's native undo (Ctrl+Z) stack intact - setting
// `.value` directly (the fallback below, and always for replaceEditorRange
// next to this) wipes it.
function insertTextAtCursor(text) {
  if (!document.execCommand("insertText", false, text)) {
    const { selectionStart, selectionEnd } = el.editor;
    replaceEditorRange(selectionStart, selectionEnd, text);
    return;
  }
  updateFilenameLabel();
  updateFormatToolbar();
  renderPreview();
}

// Splices `text` into `[start, end)` directly via `.value` - deliberately
// NOT execCommand, unlike insertTextAtCursor above. The block indent/
// outdent case below has to move the selection itself first (to cover
// every touched line, not just the caret's own position) and then hand
// that range to execCommand in the same tick - which turned out unreliable
// in practice (the programmatic setSelectionRange() wasn't always honored
// by the time execCommand ran, silently replacing the *original* caret
// position instead and merging the line into its predecessor). Direct
// splicing has no such race, at the cost of this one edit not being
// undo-able - the same trade-off convertActiveFormat already accepts
// elsewhere in this file.
function replaceEditorRange(start, end, text) {
  const editor = el.editor;
  editor.replaceRange(start, end, text);
  updateFilenameLabel();
  updateFormatToolbar();
  renderPreview();
}

// The leading whitespace of the line `cursorPos` sits on, whole-line based
// (not just up to `cursorPos`) - so a cursor sitting right at column 0 of
// an already-indented line still reports that line's real indent, not "".
function currentLineIndent(value, cursorPos) {
  const lineStart = value.lastIndexOf("\n", cursorPos - 1) + 1;
  let lineEnd = value.indexOf("\n", cursorPos);
  if (lineEnd === -1) lineEnd = value.length;
  return value.slice(lineStart, lineEnd).match(/^[ \t]*/)[0];
}

function handleEditorTabKey(outdent) {
  const editor = el.editor;
  const { selectionStart, selectionEnd, value } = editor;

  if (selectionStart === selectionEnd && !outdent) {
    insertTextAtCursor(TAB_INDENT);
    return;
  }

  // A selection (even a collapsed one, for outdent) indents/outdents every
  // line it touches, not just the exact selected characters - the usual
  // code-editor convention for block Tab/Shift+Tab.
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  let lineEnd = value.indexOf("\n", selectionEnd);
  if (lineEnd === -1) lineEnd = value.length;
  const newBlock = value
    .slice(lineStart, lineEnd)
    .split("\n")
    .map((line) => {
      if (!outdent) return TAB_INDENT + line;
      if (line.startsWith(TAB_INDENT)) return line.slice(TAB_INDENT.length);
      if (line.startsWith("\t")) return line.slice(1);
      return line.replace(/^ /, "");
    })
    .join("\n");

  replaceEditorRange(lineStart, lineEnd, newBlock);
  editor.selectionStart = lineStart;
}

el.editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveActive();
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
    // Checked before the plain Cmd/Ctrl+Enter below, which doesn't look at
    // shiftKey and would otherwise swallow this. A no-op outside a draft -
    // sendInlineCompletion guards on that itself, same as the button does.
    e.preventDefault();
    sendInlineCompletion();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    sendActive();
  } else if (e.key === "Tab") {
    e.preventDefault();
    handleEditorTabKey(e.shiftKey);
  } else if (e.key === "Enter") {
    // Carries the current line's indentation onto the new one, same as any
    // code editor - a plain <textarea> otherwise always starts the new line
    // at column 0, losing whatever nesting level (see asciimath-markdown's
    // nested-list support) you were just typing at. Left to the browser's
    // own default newline when there's nothing to carry - no behavioral
    // difference either way there, so no reason to intervene.
    const indent = currentLineIndent(el.editor.value, el.editor.selectionStart);
    if (indent) {
      e.preventDefault();
      insertTextAtCursor("\n" + indent);
    }
  }
});
// Option/Alt+Up/Down are deliberately not bound to anything here: they're
// the editor's own "move line up/down" (with Shift, "copy line"), and an
// app-level document switch on the same keys took that away.
document.addEventListener("keydown", (e) => {
  if (!hintModifierHeld(e) || !el.quickOpenOverlay.hidden || !el.shortcutsOverlay.hidden) return;
  // The physical key rather than e.key, so a layout or a modifier that
  // changes what the key types can't stop it counting as the digit.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (HINT_KEYS.includes(e.key)) {
    if (!e.repeat) scheduleAltHintMode();
  } else if (altHintActive && e.key === "Escape") {
    e.preventDefault();
    exitAltHintMode();
  } else if (altHintActive && digit) {
    e.preventDefault();
    openAltHint(Number(digit[1]));
  }
});
// Moves focus to whichever editor pane isn't currently focused - see
// focusedEditorPane, updated independently of the pinned preview. A
// document-level listener like the alt-hint one above, rather than one
// tied to either editor, so it fires the same way regardless of which pane
// (or neither - the tree, a toolbar control) currently has focus.
// Cmd/Ctrl+\ rather than a digit or arrow combo: every one of those is
// already claimed by either this app (the jump-hint digits) or the
// OS/browser on some platform (Option+digit types a character on a Mac,
// plain ⌘+digit is Safari's tab switcher, ⇧⌘3-5 are the screenshot
// shortcuts, ⌃←/→ move between Spaces) - backslash isn't reserved by
// either as far as I could find, but hasn't been tried on real hardware.
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key !== "\\" || !el.quickOpenOverlay.hidden || !el.shortcutsOverlay.hidden) return;
  e.preventDefault();
  toggleSplitFocus();
});
function toggleSplitFocus() {
  if (focusedEditorPane === "b") {
    el.editor.focus();
  } else if (splitViewOpen() && activeB) {
    el.editorB.focus();
  }
  // Split view closed, or open but empty (no document picked yet) - nothing
  // useful to focus there, so pressing this while in pane A just does
  // nothing rather than moving focus into an uneditable, empty pane.
}
// Tabs: ⌥W (Alt+W) closes the current one, ⌥O every other one, ⌥[ / ⌥]
// (Alt+[ / Alt+]) go to the previous / next. ⌘W and ⌃Tab belong to the browser and can't be had.
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || !el.quickOpenOverlay.hidden || !el.shortcutsOverlay.hidden) return;
  if (e.code === "KeyW" && currentTab >= 0) {
    e.preventDefault();
    closeTab(currentTab);
  } else if (e.code === "KeyO" && tabs.length > 1) {
    e.preventDefault();
    closeOtherTabs();
  } else if ((e.code === "BracketLeft" || e.code === "BracketRight") && tabs.length > 1) {
    e.preventDefault();
    const step = e.code === "BracketLeft" ? -1 : 1;
    switchToTab((currentTab + step + tabs.length) % tabs.length);
  }
});
document.addEventListener("keyup", (e) => {
  if (HINT_KEYS.includes(e.key)) exitAltHintMode();
});
window.addEventListener("blur", exitAltHintMode);
window.addEventListener("beforeunload", (e) => {
  if (isDirty() || isDirtyB() || tabs.some((tab, i) => i !== currentTab && stashDirty(tab.stash))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Shows who's logged in + a logout link - purely informational, and a
// no-op (stays hidden) when neither Google sign-in nor the passcode is
// configured (see auth.AuthMiddleware): with no session cookie ever set,
// GET /auth/me always 401s. A passcode session carries no identity (see
// auth.py's /auth/passcode) - `email` comes back null for one, shown as a
// generic label instead of a blank span.
async function loadAuthInfo() {
  try {
    const res = await fetch("/auth/me");
    if (!res.ok) return;
    const { email } = await res.json();
    el.authInfo.textContent = "";
    const emailSpan = document.createElement("span");
    emailSpan.textContent = email || t("auth.passcodeSession");
    emailSpan.title = email || "";
    const logoutLink = document.createElement("a");
    logoutLink.href = "/auth/logout";
    logoutLink.textContent = t("auth.logout");
    el.authInfo.append(emailSpan, logoutLink);
    el.authInfo.hidden = false;
  } catch (err) {
    // non-critical - leave el.authInfo hidden
  }
}

discussionPane = mountDiscussion({
  t,
  getLanguage,
  stopDictation,
  documentTarget() {
    if (!active || !active.projectId || !active.sessionId || active.role === "hermes-session") return null;
    return { projectId: active.projectId, sessionId: active.sessionId, filename: active.filename };
  },
  modelChoice() {
    return {
      provider: el.providerSelect.value,
      model: el.modelSelect.value,
      reasoningEffort: el.reasoningSelect.value,
    };
  },
  readContent: () => el.editor.value,
  applyRange: (from, to, text) => el.editor.replaceRange(from, to, text),
  selectRange: (start, end) => {
    el.editor.setSelectionRange(start, end);
    if (typeof el.editor.revealRange === "function") el.editor.revealRange(start, end);
  },
  restoreContent: (text) => {
    el.editor.value = text;
  },
  save: () => saveActive(),
  sonioxReady: () => sonioxSttAvailable,
  dictationLanguage: () => (el.dictationLang.value || "ko-KR").split("-")[0],
  spokenTerms: spokenMathTerms,
  setAwake: setDiscussAwake,
  setAudioSession: setAudioSessionType,
  setMicLive(live) {
    if (live) beginMicSession();
    else endMicSession();
  },
  onDocumentEdited() {
    updateFilenameLabel();
    renderPreview();
  },
});

(async function init() {
  // Captured before clearEditor() below, which would otherwise wipe this
  // via its own saveActiveDocRef() call before restoreActiveDocument() got
  // a chance to read it.
  const savedDocRef = loadActiveDocRef();
  const savedDocRefB = loadActiveDocRefB();
  const urlDocRef = parseDocumentUrlRef();
  expandedTreeState = loadExpandedTreeState();

  applyStaticTranslations();
  // The editor was built before this ran, so it picked up an untranslated
  // placeholder (index.html carries only the data-i18n-placeholder key).
  el.editor.setPlaceholder(t("editor.placeholder"));
  el.editorB.setPlaceholder(t("editor.placeholder"));
  el.langSelectSlot.appendChild(createLanguageSelect());
  loadAuthInfo();
  // Not awaited: the tree and the open document don't need the model list,
  // and /api/providers can be the slow call on a cold start (a provider with
  // no cached list waits on its live /models - see registry._cached_models).
  // loadProviders() applies the open document's saved choice (or the app
  // default) once the list arrives.
  loadProviders().catch((err) => console.error("Failed to load providers", err));
  // Starts hidden in the HTML (see index.html) to avoid a flash of a
  // section that's just going to fail with a 404 the moment it's expanded -
  // only revealed once we actually know a Hermes gateway is configured.
  el.hermesSection.hidden = !(await api.getHermesConfig()).configured;
  await loadProjects();
  await hydrateExpandedTree();
  renderTree();
  globalSystemPromptContent = (await api.getGlobalSystemPrompt()).content;
  globalCustomSymbolsContent = (await api.getCustomSymbols()).content;
  setCustomAsciiMathSymbols(parseCustomSymbolsCsv(globalCustomSymbolsContent));
  setSpokenMathVocabulary(parseSpokenMathCsv((await api.getSpokenMath()).content));
  clearEditor();
  // Tabs come back as they were; the one that was on screen (or the one a
  // /d/... URL names) is the one loaded now - the rest load when switched to.
  const savedTabs = loadTabs();
  if (savedTabs) tabs = savedTabs.tabs.filter((tab) => tab.ref).map(({ ref, title }) => ({ ref, title, stash: null }));
  const startRef = urlDocRef || (savedTabs && tabs[savedTabs.current] && tabs[savedTabs.current].ref) || savedDocRef;
  const startAt = tabs.findIndex((tab) => sameDocRef(tab.ref, startRef));
  if (startAt >= 0) await switchToTab(startAt, { keepCurrent: false });
  else if (startRef) {
    currentTab = tabs.length - 1;
    await openInTab(startRef);
  }
  renderTabs();
  await restoreActiveDocumentB(savedDocRefB);
})();

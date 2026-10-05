import * as api from "./api.js";
import {
  renderMarkdown,
  detectMathDirective,
  convertAsciiMathToLatex,
  setCustomAsciiMathSymbols,
  parseCustomSymbolsCsv,
  firstH1Heading,
} from "./markdown.js";
import { t, getLanguage, applyStaticTranslations, createLanguageSelect, exchangeHeadingRole } from "./i18n.js";
import { createEditor } from "./editor.js";
import { openTranscribeDialog } from "./transcribe.js";

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
  treeResizer: document.getElementById("tree-resizer"),
  previewResizer: document.getElementById("preview-resizer"),
  treeCollapseBtn: document.getElementById("tree-collapse-btn"),
  treeExpandBtn: document.getElementById("tree-expand-btn"),
  previewCollapseBtn: document.getElementById("preview-collapse-btn"),
  previewExpandBtn: document.getElementById("preview-expand-btn"),
  authInfo: document.getElementById("auth-info"),
  langSelectSlot: document.getElementById("lang-select-slot"),
  globalCustomSymbolsRow: document.getElementById("global-custom-symbols-row"),
  sessionTree: document.getElementById("session-tree"),
  newProjectBtn: document.getElementById("new-project-btn"),
  providerSelect: document.getElementById("provider-select"),
  modelSelect: document.getElementById("model-select"),
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
  toolStatus: document.getElementById("tool-status"),
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
const DEFAULT_PROVIDER_ID = "openai";
// "system"/"project-system" = per-session/per-project system.md,
// "global-system" = the app-wide prompt at the very top, "global-custom-
// symbols" = the app-wide custom-symbols.csv right below it, "hermes-
// session" = a read-only transcript pulled from the local Hermes agent
// gateway (see selectHermesSession below). None of these is a conversation
// turn mark-vector itself owns, so none can be sent to the LLM directly.
const NON_SENDABLE_ROLES = new Set([
  "system",
  "project-system",
  "global-system",
  "global-custom-symbols",
  "hermes-session",
]);

let providers = [];
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
      await selectDocument(ref.projectId, ref.sessionId, ref.filename, { focus: false });
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
    return;
  }
  const dirty = isDirtyB();
  el.editorFilenameB.textContent = activeB.filename + (dirty ? " •" : "");
  el.saveBtnB.classList.toggle("dirty", dirty);
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
      }
    : { type: "update", filename: null, content: "" };
}

// `onConnectedChange(connected)` is called on every open/close so each
// caller can drive its own status dot. `connect(channel)` is safe to call
// again with a different channel while already connected - it tears down
// the old socket first, which is how switching documents re-targets the
// "live" feature below without a separate disconnect step.
function createLiveSocket(onConnectedChange) {
  let channel = null;
  let socket = null;
  let sendTimer = null;
  let lastSentAt = 0;
  let retryDelay = LIVE_RETRY_MIN_MS;
  let retryTimer = null;
  let wantConnected = false;

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
  function send(immediate) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (immediate) {
      clearTimeout(sendTimer);
      sendTimer = null;
      lastSentAt = Date.now();
      socket.send(JSON.stringify(currentLiveState()));
      return;
    }
    const elapsed = Date.now() - lastSentAt;
    if (elapsed >= LIVE_SEND_INTERVAL_MS) {
      lastSentAt = Date.now();
      socket.send(JSON.stringify(currentLiveState()));
      return;
    }
    if (sendTimer) return; // a trailing flush for this window is already queued
    sendTimer = setTimeout(() => {
      sendTimer = null;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      lastSentAt = Date.now();
      socket.send(JSON.stringify(currentLiveState()));
    }, LIVE_SEND_INTERVAL_MS - elapsed);
  }

  function connect(newChannel) {
    channel = newChannel;
    wantConnected = true;
    clearTimeout(retryTimer);
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
      send(true);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
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
    ws.addEventListener("error", () => ws.close());
  }

  function disconnect() {
    wantConnected = false;
    clearTimeout(retryTimer);
    clearTimeout(sendTimer);
    if (socket) {
      const ws = socket;
      socket = null;
      ws.close();
    }
    onConnectedChange(false);
  }

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

const glassesSocket = createLiveSocket((connected) => el.glassesStatusDot.classList.toggle("connected", connected));

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

function glassesUrl() {
  return `${location.origin}/glasses/?c=${encodeURIComponent(glassesSocket.currentChannel())}`;
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

const livePublicSocket = createLiveSocket((connected) => el.livePublicStatusDot.classList.toggle("connected", connected));

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

function setPreviewSource(source) {
  if (previewSource === source) return;
  previewSource = source;
  if (source === "a") renderPreview();
  else renderPreviewB();
}

function paintSharedPreview(text, dialect) {
  // Threads are scratch conversation: collapsed ones are left out, expanded
  // ones are rendered in their own box (see renderDocumentWithThreads). The
  // buffer keeps all of them either way, and a published page gets none.
  el.preview.innerHTML = renderDocumentWithThreads(text, dialect);
}

function renderPreview() {
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
}

// Pane B's counterpart - deliberately thin: no thread-fold sync (pane B's
// folds are plain view state, nothing in the document to reconcile - see
// el.editorB's foldRanges), no autosave, no glasses/live-public (those
// follow pane A's own document regardless of what's on screen - see
// renderPreview above).
function renderPreviewB() {
  if (previewSource === "b" && activeB) {
    paintSharedPreview(el.editorB.value, sessionMathDialect(activeB.projectId, activeB.sessionId));
    syncPreviewScrollFromSource("b");
  }
  updateScrollNavVisibility();
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
  const noFormat = !active || active.role === "hermes-session" || active.role === "global-custom-symbols";
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
  // Nothing in the row means nothing to open, so the phone-only ⚙ goes with
  // it rather than opening an empty strip.
  el.toolbarToggleBtn.hidden = !visible;
}

// Phone-only in effect: the .open class only means anything inside the
// 700px media query (see .editor-toolbar:not(.open) in style.css), so on a
// wider screen this button isn't rendered and the row is always open.
// Deliberately not persisted - "collapsed" is the point of the default, and
// the class survives switching documents within a session anyway.
function toggleEditorToolbar() {
  const open = el.editorToolbar.classList.toggle("open");
  el.toolbarToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  // Same highlight the save/publish buttons use for "this is switched on".
  el.toolbarToggleBtn.classList.toggle("dirty", open);
}

// provider/model/reasoning_effort used to be fixed once for a whole
// session; now they're chosen per turn (see storage.py's start_exchange),
// and this is what a newly-opened turn's controls default to: whatever was
// actually used most recently *in this session* (updated on the backend
// after every send), falling back to a first-time default only if this
// session has never sent anything yet. convert_math isn't part of this
// anymore - it's driven live by the format selector (see currentDocumentFormat/
// updateFormatToolbar), which reflect the open document's own content/
// inherited directive rather than a remembered session preference.
function turnDefaults(session) {
  // context_scope is independent of provider - remembered (or defaulted)
  // the same way regardless of which branch below runs.
  const contextScope = session.meta.context_scope || "default";
  if (session.meta.provider) {
    return {
      provider: session.meta.provider,
      model: session.meta.model,
      reasoningEffort: session.meta.reasoning_effort || "off",
      contextScope,
    };
  }
  const fallback = providers.find((p) => p.id === DEFAULT_PROVIDER_ID) || providers[0];
  return {
    provider: fallback ? fallback.id : "",
    model: fallback ? fallback.default_model : "",
    reasoningEffort: "off",
    contextScope,
  };
}

function applyTurnDefaults(session) {
  const defaults = turnDefaults(session);
  if (defaults.provider) el.providerSelect.value = defaults.provider;
  populateModelOptions();
  // Only override the provider's own default_model (already selected by
  // populateModelOptions above) if the last-used model is still actually
  // offered - a provider's live model list can change over time (a model
  // gets deprecated/renamed), and setting .value to something with no
  // matching <option> just silently leaves the dropdown on no selection at
  // all, which would then block sending entirely.
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
}

function updateSendAvailability() {
  const provider = providers.find((p) => p.id === el.providerSelect.value);
  const usable = !!provider && !!el.modelSelect.value;
  // list_providers() only ever returns configured providers now, so this
  // can only ever mean "there aren't any at all" - not "this one lacks a
  // key", which used to be the other way this warning could show.
  el.providerWarning.hidden = providers.length > 0;
  el.sendBtn.disabled = !active || streaming || NON_SENDABLE_ROLES.has(active.role) || !usable;
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
  for (const level of ["off", ...(levels || [])]) {
    const option = document.createElement("option");
    option.value = level;
    // A level the backend knows about but this build's dictionary doesn't
    // (a new one added server-side) still shows up, just unlocalized,
    // rather than silently disappearing from the selector.
    const key = level === "off" ? "editor.reasoningOff" : REASONING_LEVEL_KEYS[level];
    option.textContent = key ? t(key) : level;
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
// The browser's own Web Speech API - no server round trip, no API key, and
// interim (still-being-spoken) results arrive continuously, which is what
// makes it feel live. Chrome/Edge/Safari only (Firefox has no
// SpeechRecognition), so the control is hidden where it can't work. The
// audio itself goes to the browser vendor's recognizer, not to this app.
//
// Text is written straight into the document at the caret: finalized
// phrases stay, and the phrase still being spoken is shown in place and
// rewritten on every update (dictation.from/interim track that span).
// If the caret moves or the text under that span changes while listening,
// the span is abandoned and dictation picks up again at the new caret.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
const DICTATION_LANG_KEY = "mark-vector:dictation-lang";
const DICTATION_LANG_BY_UI = { ko: "ko-KR", en: "en-US", ja: "ja-JP" };

// null while idle. `target` is the `active` object dictation started on -
// switching documents (a new `active`) stops it rather than typing into
// whatever document happens to be open next.
let dictation = null;

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

function saveDictationLang() {
  try {
    localStorage.setItem(DICTATION_LANG_KEY, el.dictationLang.value);
  } catch (err) {
    // localStorage unavailable - the choice just won't persist across reloads
  }
}

function dictationUsable() {
  return !!active && !streaming && !el.editor.disabled;
}

function updateDictationButton() {
  el.dictationGroup.hidden = !SpeechRecognitionImpl || !active;
  el.dictationBtn.disabled = !dictationUsable() && !dictation;
  if (dictation && (dictation.target !== active || !dictationUsable())) stopDictation();
  const listening = !!dictation;
  el.dictationBtn.classList.toggle("listening", listening);
  el.dictationBtn.setAttribute("aria-pressed", listening ? "true" : "false");
  el.dictationLabel.textContent = t(listening ? "editor.dictationStop" : "editor.dictation");
}

// A space between the new text and whatever precedes it, unless it starts
// a line or already follows whitespace. Japanese isn't space-separated, so
// it never gets one.
function dictationSeparator(pos) {
  if (pos === 0 || el.dictationLang.value.startsWith("ja")) return "";
  const prev = el.editor.value[pos - 1];
  return /\s/.test(prev) ? "" : " ";
}

// Keeps dictation.from/interim honest against edits made while listening -
// see the section comment above.
function reanchorDictation() {
  const d = dictation;
  const { value, selectionStart, selectionEnd } = el.editor;
  const end = d.from + d.interim.length;
  const intact = value.slice(d.from, end) === d.interim;
  if (intact && selectionStart === end && selectionEnd === end) return;
  if (intact && d.interim) {
    // Drop the half-spoken phrase from where it was; its final version
    // will be written at the new caret instead.
    el.editor.replaceRange(d.from, end, "");
    const shift = selectionStart >= end ? d.interim.length : 0;
    d.from = Math.max(0, selectionStart - shift);
    el.editor.setSelectionRange(d.from, d.from);
  } else {
    d.from = selectionStart;
  }
  d.interim = "";
}

function writeDictation(finalText, interimText) {
  const d = dictation;
  reanchorDictation();
  const end = d.from + d.interim.length;
  let insert = "";
  if (finalText) insert += dictationSeparator(d.from) + finalText.trim();
  const committedEnd = d.from + insert.length;
  let interim = "";
  if (interimText.trim()) {
    // Separator judged against what the final text above will leave behind.
    const before = insert ? insert[insert.length - 1] : committedEnd > 0 ? el.editor.value[d.from - 1] : "\n";
    const sep = el.dictationLang.value.startsWith("ja") || /\s/.test(before) || committedEnd === 0 ? "" : " ";
    interim = sep + interimText.trim();
  }
  if (!insert && !interim && !d.interim) return;
  // Dictating in front of existing text: keep a space between the two. The
  // space sits after `committedEnd`, so the next phrase still goes before it.
  const next = el.editor.value[end];
  const trailing = insert && !interim && next && !/\s/.test(next) && !el.dictationLang.value.startsWith("ja") ? " " : "";
  replaceEditorRange(d.from, end, insert + interim + trailing);
  if (trailing) el.editor.setSelectionRange(committedEnd, committedEnd);
  d.from = committedEnd;
  d.interim = interim;
}

function startDictation() {
  if (!SpeechRecognitionImpl || dictation || !dictationUsable()) return;
  const recognition = new SpeechRecognitionImpl();
  recognition.lang = el.dictationLang.value;
  recognition.continuous = true;
  recognition.interimResults = true;
  dictation = { recognition, target: active, from: el.editor.selectionStart, interim: "", error: null };
  // Replace a selection, the way typing would.
  if (el.editor.selectionEnd > el.editor.selectionStart) {
    replaceEditorRange(el.editor.selectionStart, el.editor.selectionEnd, "");
  }
  const session = dictation;

  recognition.addEventListener("result", (e) => {
    if (dictation !== session) return;
    if (session.target !== active || !dictationUsable()) {
      stopDictation();
      return;
    }
    let finalText = "";
    let interimText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += text;
      else interimText += text;
    }
    writeDictation(finalText, interimText);
  });

  recognition.addEventListener("error", (e) => {
    if (dictation !== session) return;
    // "no-speech" (a silent stretch) and "aborted" (our own restart/stop)
    // aren't failures - the "end" handler below just carries on.
    if (e.error === "no-speech" || e.error === "aborted") return;
    session.error = e.error;
  });

  // Chrome ends a "continuous" session on its own after a pause or about a
  // minute of audio - restart it transparently for as long as the user
  // hasn't pressed stop, keeping whatever was last on screen as final.
  recognition.addEventListener("end", () => {
    if (dictation !== session) return;
    session.interim = "";
    if (session.error) {
      const denied = session.error === "not-allowed" || session.error === "service-not-allowed";
      stopDictation();
      alert(denied ? t("editor.dictationDenied") : t("editor.dictationFailed", { message: session.error }));
      return;
    }
    try {
      recognition.start();
    } catch (err) {
      stopDictation();
    }
  });

  try {
    recognition.start();
  } catch (err) {
    dictation = null;
    alert(t("editor.dictationFailed", { message: err.message }));
  }
  updateDictationButton();
  el.editor.focus();
}

function stopDictation() {
  const session = dictation;
  if (!session) return;
  dictation = null;
  // abort(), not stop(): stop() would still deliver one last "result"
  // after this point, into a session that's already been let go. Whatever
  // interim text is on screen simply stays as typed.
  try {
    session.recognition.abort();
  } catch (err) {
    // already ended
  }
  updateDictationButton();
}

function toggleDictation() {
  if (dictation) stopDictation();
  else startDictation();
}

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
      // The inverse of sending a draft (storage.start_exchange's
      // draft_filename) - only a real turn has anything to revert.
      ...(doc.role !== "draft"
        ? [{ icon: "↩", label: t("doc.revertToDraft"), onSelect: () => revertDocumentToDraft(projectId, sessionId, doc.filename) }]
        : []),
      { icon: "⧉", label: t("doc.copyLink"), onSelect: () => copyDocumentLink(feedbackEl, sessionId, doc.filename, firstH1Heading(doc.content)) },
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
    selectDocument(projectId, sessionId, doc.filename);
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
    { icon: "S", label: t("folder.systemPrompt"), onSelect: () => selectSessionSystemPrompt(projectId, id) },
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
    { icon: "S", label: t("project.systemPrompt"), onSelect: () => selectProjectSystemPrompt(id) },
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
  row.addEventListener("click", () => selectHermesSession(session));
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
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

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
    if (result.recent) {
      const tag = document.createElement("span");
      tag.className = "quick-open-row-recent";
      tag.textContent = t("quickOpen.recent");
      main.appendChild(tag);
    }

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
  else selectDocument(entry.projectId, entry.sessionId, entry.filename);
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
        { desc: "shortcuts.jumpDoc", keys: [`${HINT_KEY_SYMBOL}1-9`] },
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
function canDropOnFolder(projectId, targetSessionId) {
  if (!dragPayload || dragPayload.projectId !== projectId) return false;
  if (dragPayload.type === "document") return dragPayload.sessionId !== targetSessionId;
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
    if (isCopyDrag(payload)) {
      await copyDocumentToFolder(projectId, payload.sessionId, payload.filename, targetSessionId);
    } else {
      await moveDocumentToFolder(projectId, payload.sessionId, payload.filename, targetSessionId);
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

async function moveDocumentToFolder(projectId, sourceSessionId, filename, targetSessionId) {
  try {
    await api.moveDocument(projectId, sourceSessionId, filename, targetSessionId);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await Promise.all([refreshSessionDocs(projectId, sourceSessionId), refreshSessionDocs(projectId, targetSessionId)]);
  // The moved document is still open in the editor - just under a
  // different folder now, same as renameDocument keeps `active` in sync
  // with a filename change instead of leaving it stale.
  if (
    active &&
    active.projectId === projectId &&
    active.sessionId === sourceSessionId &&
    active.filename === filename
  ) {
    active.sessionId = targetSessionId;
    saveActiveDocRef();
    updateFilenameLabel();
  }
  renderTree();
}

// The copy-drag counterpart of moveDocumentToFolder above - the source
// document/folder is never touched (see isCopyDrag), so there's nothing to
// refresh there and no `active` ref to repoint; only the target folder's
// document list needs to pick up the new draft.
async function copyDocumentToFolder(projectId, sourceSessionId, filename, targetSessionId) {
  try {
    await api.copyDocument(projectId, sourceSessionId, filename, targetSessionId);
  } catch (err) {
    alert(t("action.error", { message: err.message }));
    return;
  }
  await refreshSessionDocs(projectId, targetSessionId);
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

// `focus` (on by default): every way of *going to* a document - a tree row,
// quick open, the jump keys, an internal link - leaves the
// caret at the top of the editor, ready to type. Off only for the page-load
// restore, which isn't a navigation the user just made.
async function selectDocument(projectId, sessionId, filename, { focus = true } = {}) {
  if (streaming) return;
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const project = projects.get(projectId);
  if (!project) return;
  const session = project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  const doc = session.documents.find((d) => d.filename === filename);
  if (!doc) return;

  // Only reset the provider/model/reasoning controls when arriving from a different
  // session (or from none) - switching between documents *within* the same
  // session shouldn't discard a deliberate in-session override back to
  // that session's last-used settings.
  const sessionChanged = !active || active.sessionId !== sessionId || active.projectId !== projectId;
  active = { projectId, sessionId, filename, role: doc.role, savedContent: doc.content, turnId: doc.turn_id, publishToken: doc.publish_token, publishSlides: !!doc.publish_slides };
  saveActiveDocRef();
  rememberRecentDoc(projectId, sessionId, filename);
  el.editor.value = doc.content;
  maybeRestoreAutosave();
  el.editor.disabled = false;
  el.saveBtn.disabled = false;
  updateSendToolbarVisibility();
  updateFormatToolbar();
  if (sessionChanged && !NON_SENDABLE_ROLES.has(doc.role)) applyTurnDefaults(session);
  updateSendAvailability();
  updateFilenameLabel();
  renderPreview();
  renderTree();
  setMobileView("editor");
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
async function selectDocumentB(projectId, sessionId, filename, { focus = true } = {}) {
  if (isDirtyB() && !confirm(t("confirm.unsavedChanges"))) return;

  const project = projects.get(projectId);
  if (!project) return;
  const session = project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  const doc = session.documents.find((d) => d.filename === filename);
  if (!doc) return;

  activeB = { projectId, sessionId, filename, role: doc.role, savedContent: doc.content };
  saveActiveDocRefB();
  rememberRecentDoc(projectId, sessionId, filename);
  setSplitView(true);
  el.editorB.value = doc.content;
  el.editorB.disabled = false;
  el.saveBtnB.disabled = false;
  updateFilenameLabelB();
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
    selectDocument(active.projectId, active.sessionId, targetFilename);
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
  selectDocument(active.projectId, targetSessionId, targetFilename);
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
  await selectDocument(entry.projectId, entry.sessionId, entry.filename);
}

async function selectProjectSystemPrompt(projectId) {
  if (streaming) return;
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

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

async function selectSessionSystemPrompt(projectId, sessionId) {
  if (streaming) return;
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

  const project = projects.get(projectId);
  if (!project) return;
  const session = project.sessions && project.sessions.get(sessionId);
  if (!session) return;
  if (session.documents === null) {
    session.documents = await api.listDocuments(projectId, sessionId);
  }
  const doc = session.documents.find((d) => d.role === "system");
  if (!doc) return;

  // Reuses the ordinary "system" role/save path (saveActive's generic
  // api.saveDocument branch already handles it - system.md is a real
  // document under the hood, just no longer listed as a row - see
  // buildSessionNode) rather than inventing a session-system-specific one.
  active = { projectId, sessionId, filename: doc.filename, role: "system", savedContent: doc.content };
  saveActiveDocRef();
  el.editor.value = doc.content;
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
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

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
  if (isDirty() && !confirm(t("confirm.unsavedChanges"))) return;

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
  await selectDocument(projectId, sessionId, draft.filename);
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
      await selectDocument(projectId, sessionId, doc.filename);
    },
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
  if (active && active.projectId === id) clearEditor();
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
  const activeFolderStillExists =
    project && project.sessions && active && active.sessionId && project.sessions.has(active.sessionId);
  if (active && active.projectId === projectId && active.sessionId && !activeFolderStillExists) {
    clearEditor();
  }
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
  await refreshSessionDocs(projectId, sessionId);
  if (active && active.projectId === projectId && active.sessionId === sessionId && active.filename === filename) {
    clearEditor();
  }
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
  } else if (active.role === "project-system") {
    await api.saveProjectSystemPrompt(active.projectId, content);
    const project = projects.get(active.projectId);
    if (project) project.systemPromptContent = content;
  } else {
    await api.saveDocument(active.projectId, active.sessionId, active.filename, content);
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
  await api.saveDocument(activeB.projectId, activeB.sessionId, activeB.filename, content);
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
  for (const line of text.split("\n")) {
    const heading = /^(#{1,6})\s/.exec(line);
    lines.push({
      start: offset,
      end: offset + line.length,
      level: heading ? heading[1].length : 0,
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
      if (lines[next].level && lines[next].level <= line.level) {
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
  };
  if (!settings.provider || !settings.model) return;
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
        renderPreview();
        followStream();
      } else if (event.type === "assistant_turn") {
        completed = true;
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
  providers = await api.getProviders();
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
    if (provider.id === DEFAULT_PROVIDER_ID) opt.selected = true;
    el.providerSelect.appendChild(opt);
  }
  populateModelOptions();
  // The list can arrive after a document is already open (init doesn't
  // wait for it), in which case selectDocument's applyTurnDefaults ran
  // against empty selects - redo it now that there's something to select.
  const session = active && projects.get(active.projectId)?.sessions?.get(active.sessionId);
  if (session && !NON_SENDABLE_ROLES.has(active.role) && !streaming) applyTurnDefaults(session);
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
el.globalSystemRow.addEventListener("click", selectGlobalPrompt);
el.globalCustomSymbolsRow.addEventListener("click", selectGlobalCustomSymbols);
el.hermesHeader.addEventListener("click", toggleHermesSection);
el.mobileTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".mobile-tab");
  if (btn) setMobileView(btn.dataset.view);
});
el.providerSelect.addEventListener("change", populateModelOptions);
el.modelSelect.addEventListener("change", updateSendAvailability);
el.saveBtn.addEventListener("click", saveActive);
el.publishBtn.addEventListener("click", togglePublish);
el.toolbarToggleBtn.addEventListener("click", toggleEditorToolbar);
el.inlineCompleteBtn.addEventListener("click", sendInlineCompletion);
restoreDictationLang();
el.dictationBtn.addEventListener("click", toggleDictation);
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
el.editor.addEventListener("focus", () => setPreviewSource("a"));
el.editorB.addEventListener("focus", () => setPreviewSource("b"));
el.editorB.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveDocumentB();
  }
});
el.viewModeBtn.addEventListener("click", toggleEditorViewMode);
el.saveBtnB.addEventListener("click", saveDocumentB);
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
// previewSource, which this doubles as "the pane last focused" for (it's
// already updated by the "focus" listeners on el.editor/el.editorB). A
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
  if (previewSource === "b") {
    el.editor.focus();
  } else if (splitViewOpen() && activeB) {
    el.editorB.focus();
  }
  // Split view closed, or open but empty (no document picked yet) - nothing
  // useful to focus there, so pressing this while in pane A just does
  // nothing rather than moving focus into an uneditable, empty pane.
}
document.addEventListener("keyup", (e) => {
  if (HINT_KEYS.includes(e.key)) exitAltHintMode();
});
window.addEventListener("blur", exitAltHintMode);
window.addEventListener("beforeunload", (e) => {
  if (isDirty() || isDirtyB()) {
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
  // loadProviders() applies the open session's remembered settings itself
  // once the list arrives.
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
  clearEditor();
  await restoreActiveDocument(urlDocRef || savedDocRef);
  await restoreActiveDocumentB(savedDocRefB);
})();

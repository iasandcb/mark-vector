// The editor surface, behind a textarea-shaped adapter.
//
// app.js touches the editor through exactly eleven members - value,
// selectionStart/End, setSelectionRange, scrollTop/scrollHeight/clientHeight,
// scrollTo, focus, disabled, addEventListener - so swapping the textarea for
// CodeMirror is a matter of providing those eleven, not of rewriting the
// hundreds of call sites behind them. Everything else in app.js
// (replaceEditorRange, autosave, scroll sync, inline threads) is unchanged.
//
// Why CodeMirror at all: a <textarea> cannot fold. There is no gutter, no
// overlay, and no way to hide a range without actually deleting the text -
// which is not something an editor should do to a file it is about to save.
// Folding whole inline threads (see app.js's inline-threads section) is the
// one thing that needs a real editor, so that's what this exists for.
//
// Flip USE_CODEMIRROR to false to get the plain textarea back, unchanged:
// the adapter then hands out the element itself and folding quietly becomes
// a no-op. Kept as an escape hatch while this is new.
import {
  EditorState,
  EditorView,
  Compartment,
  keymap,
  placeholder,
  drawSelection,
  history,
  historyKeymap,
  defaultKeymap,
  codeFolding,
  foldGutter,
  foldService,
  foldEffect,
  unfoldEffect,
  foldedRanges,
  search,
  searchKeymap,
  closeSearchPanel,
} from "./vendor/codemirror.js";

const USE_CODEMIRROR = true;

// Events app.js listens for that CodeMirror has no DOM equivalent of, so
// they're synthesized from its update cycle instead. The rest are ordinary
// DOM events, forwarded to the element they actually fire on.
const SYNTHETIC_EVENTS = new Set(["input", "selectionchange"]);

export function createEditor(textarea, { onFoldToggle, foldRanges }) {
  if (!USE_CODEMIRROR) {
    textarea.syncThreadFolds = () => {};
    textarea.replaceRange = (from, to, text) => {
      textarea.value = textarea.value.slice(0, from) + text + textarea.value.slice(to);
      textarea.selectionStart = textarea.selectionEnd = from + text.length;
    };
    textarea.setPlaceholder = (text) => {
      textarea.placeholder = text;
    };
    textarea.append = (text) => {
      textarea.value += text;
    };
    textarea.scrollToEnd = () => {
      textarea.scrollTop = textarea.scrollHeight;
    };
    Object.defineProperty(textarea, "scrollElement", { get: () => textarea });
    // The plain textarea is its own root - see the real adapter's
    // `rootElement` below for what this is for.
    Object.defineProperty(textarea, "rootElement", { get: () => textarea });
    return textarea;
  }

  const listeners = new Map();
  const emit = (type) => {
    for (const listener of listeners.get(type) || []) listener({ type, target: adapter });
  };

  const editable = new Compartment();
  const placeholderText = new Compartment();

  // What can be folded is decided by app.js: inline threads (whose marker
  // in the document says whether they're collapsed - syncThreadFolds below
  // keeps the view matching it, so the editor and the preview can't disagree
  // about one) and Markdown heading sections (ordinary view state, with
  // nothing in the document to reconcile against).
  const foldableRanges = foldService.of((state, lineStart, lineEnd) => {
    const match = foldRanges(state.doc.toString()).find(
      (range) => range.markerFrom >= lineStart && range.markerFrom <= lineEnd
    );
    return match ? { from: match.from, to: match.to } : null;
  });

  const view = new EditorView({
    parent: textarea.parentElement,
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        codeFolding(),
        // The gutter arrow is the same control as the 👁 button: it flips the
        // thread's marker and lets the sync below fold the view to match,
        // rather than folding behind the document's back. Returning true
        // keeps CodeMirror's own fold from also running - but only for a
        // thread; a heading has no marker to flip, so onFoldToggle returns
        // false and CodeMirror folds it as plain view state.
        foldGutter({
          // Arrows rather than CodeMirror's default chevrons, and pointing
          // the way the state reads: ▾ open (click to fold), ▸ folded (click
          // to open). Both are always drawn for a foldable line - a control
          // that only appears on hover is one you have to already know about.
          openText: "▾",
          closedText: "▸",
          domEventHandlers: {
            click: (_view, line) => {
              return onFoldToggle(line.from);
            },
          },
        }),
        foldableRanges,
        // Cmd/Ctrl+F opens CodeMirror's own find/replace panel (F3 or
        // Cmd/Ctrl+G for next, Escape to close) - the editor's ordinary
        // "find", same as any text editor, rather than something this app
        // has to build. `top: true` keeps it pinned under the pane header
        // instead of CodeMirror's default bottom placement, which would sit
        // right under the floating scroll-nav buttons (see .scroll-nav in
        // style.css).
        search({ top: true }),
        // searchKeymap first: Cmd/Ctrl+F and Cmd/Ctrl+G aren't claimed by
        // defaultKeymap, but if that ever changed, find should still win.
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        placeholderText.of(placeholder(textarea.placeholder || "")),
        editable.of(EditorView.editable.of(!textarea.disabled)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit("input");
          if (update.selectionSet || update.docChanged) emit("selectionchange");
        }),
        EditorView.theme({
          "&": { flex: "1", minHeight: "0", fontSize: "13.5px" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": {
            overscrollBehavior: "contain",
            fontFamily: '"SF Mono", Consolas, monospace',
            lineHeight: "1.7",
            overflow: "auto",
          },
          ".cm-content": { padding: "16px 0" },
          ".cm-line": { padding: "0 16px" },
          // The gutter is a control strip, so it looks like one: its own
          // shade, a divider against the text, and arrows big enough to hit.
          ".cm-gutters": {
            backgroundColor: "var(--bg)",
            borderRight: "1px solid var(--border)",
            color: "var(--muted)",
          },
          ".cm-foldGutter": { minWidth: "18px" },
          ".cm-foldGutter span": {
            padding: "0 3px",
            cursor: "pointer",
            fontSize: "11px",
            opacity: "0.75",
          },
          ".cm-foldGutter span:hover": { opacity: "1", color: "var(--accent)" },
          // What a folded thread collapses to. Deliberately readable rather
          // than CodeMirror's default "…": the point of folding one is to
          // know the conversation is there without reading it.
          ".cm-foldPlaceholder": {
            backgroundColor: "var(--code-bg)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            color: "var(--muted)",
            padding: "0 6px",
            margin: "0 4px",
          },
          // The find/replace panel (see search() above) - @codemirror/search
          // ships its own layout (a baseTheme, injected regardless of this
          // block), just none of this app's own colors, so left alone it
          // would show up in CodeMirror's stock light-grey regardless of
          // dark mode.
          ".cm-panels": {
            backgroundColor: "var(--bg)",
            color: "var(--text)",
          },
          ".cm-panel.cm-search": {
            borderBottom: "1px solid var(--border)",
          },
          ".cm-textfield": {
            backgroundColor: "var(--panel)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
          },
          ".cm-button": {
            backgroundColor: "var(--panel)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            backgroundImage: "none",
          },
          ".cm-button:hover": {
            backgroundColor: "var(--border)",
          },
          ".cm-searchMatch": {
            backgroundColor: "var(--code-bg)",
          },
          ".cm-searchMatch-selected": {
            backgroundColor: "var(--accent)",
            color: "var(--accent-contrast)",
          },
        }),
      ],
    }),
  });

  textarea.hidden = true;

  const dispatchSelection = (anchor, head) => {
    const max = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(anchor, max), head: Math.min(head, max) } });
  };

  const adapter = {
    get value() {
      return view.state.doc.toString();
    },
    set value(next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    // Replaces just [from, to) and leaves the caret after the insertion.
    // Assigning `value` swaps the whole document, and CodeMirror drops every
    // fold whose range was inside the replaced text - i.e. all of them - so
    // an edit that should touch one thread's marker would unfold the rest.
    replaceRange(from, to, text) {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
    },
    // Textarea semantics, which app.js relies on when it writes
    // `selectionStart = selectionEnd = pos` as two separate assignments:
    // moving the start past the end drags the end with it, and vice versa.
    get selectionStart() {
      return view.state.selection.main.from;
    },
    set selectionStart(pos) {
      dispatchSelection(pos, Math.max(pos, view.state.selection.main.to));
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    set selectionEnd(pos) {
      dispatchSelection(Math.min(pos, view.state.selection.main.from), pos);
    },
    setSelectionRange(start, end) {
      dispatchSelection(start, end);
    },
    // Streaming's write path: adds to the end instead of the whole-document
    // replace `value +=` would do, and doesn't move the view - whether to
    // follow the new text is the caller's call (scrollToEnd).
    append(text) {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: text } });
    },
    // Scrolling through CodeMirror rather than writing scrollDOM.scrollTop:
    // CodeMirror measures and lays out lazily, so right after a change the
    // DOM's scrollHeight can still be the old one and a raw write would land
    // short of the real end. The scrollIntoView effect is resolved after
    // that measurement.
    scrollToEnd() {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }) });
    },
    // The element that actually scrolls - for listeners that have to see
    // the user scrolling it (wheel/touch/scrollbar drags), which
    // addEventListener above would otherwise route to the content element.
    get scrollElement() {
      return view.scrollDOM;
    },
    get scrollTop() {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(value) {
      view.scrollDOM.scrollTop = value;
    },
    get scrollHeight() {
      return view.scrollDOM.scrollHeight;
    },
    get clientHeight() {
      return view.scrollDOM.clientHeight;
    },
    scrollTo(options) {
      view.scrollDOM.scrollTo(options);
    },
    focus() {
      view.focus();
    },
    // The view's own top-level element - not part of the textarea-shaped API
    // above, and not meant for general use. Its one job is letting app.js
    // hide/show the whole editor (see the source/rendered toggle) without
    // reaching past this adapter for anything else about it.
    get rootElement() {
      return view.dom;
    },
    get disabled() {
      return !view.state.facet(EditorView.editable);
    },
    set disabled(value) {
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!value)) });
      // Going disabled means this document is being cleared or swapped out
      // from under the view (clearEditor, a document switch, streaming
      // starting) - a find panel left open over whatever replaces it would
      // be searching content the query was never typed against.
      if (value) closeSearchPanel(view);
    },
    setPlaceholder(text) {
      view.dispatch({ effects: placeholderText.reconfigure(placeholder(text)) });
    },
    addEventListener(type, listener) {
      if (SYNTHETIC_EVENTS.has(type)) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
        return;
      }
      if (type === "scroll") {
        view.scrollDOM.addEventListener(type, listener);
        return;
      }
      if (type === "keydown") {
        // app.js's own bindings (⌘S, ⌘↵, ⇧⌘↵, and its Markdown-aware
        // Tab/Enter) have to beat CodeMirror's. Captured on the wrapper -
        // an ancestor of the element CodeMirror handles keys on, so this
        // always runs first - and anything app.js claims with
        // preventDefault is stopped before CodeMirror can act on it too.
        view.dom.addEventListener(
          type,
          (event) => {
            listener(event);
            if (event.defaultPrevented) event.stopImmediatePropagation();
          },
          true
        );
        return;
      }
      view.contentDOM.addEventListener(type, listener);
    },
    // Folds the view to match the markers. Called after anything that can
    // change them; a no-op when the view already agrees, which is what keeps
    // it from fighting the user mid-edit.
    syncThreadFolds(ranges) {
      const folded = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => folded.push({ from, to }));
      const effects = [];
      for (const range of ranges) {
        const isFolded = folded.some((f) => f.from === range.from && f.to === range.to);
        if (range.folded && !isFolded) effects.push(foldEffect.of({ from: range.from, to: range.to }));
        else if (!range.folded && isFolded) effects.push(unfoldEffect.of({ from: range.from, to: range.to }));
      }
      if (effects.length) view.dispatch({ effects });
    },
  };

  return adapter;
}

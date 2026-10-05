import { renderMarkdown, parseCustomSymbolsCsv, setCustomAsciiMathSymbols, firstH1Heading } from "./markdown.js";
import { applyStaticTranslations, t } from "./i18n.js";
import { splitSlides } from "./slides.js";

// No language switcher here (unlike index.html/login.html) - a share-link
// recipient is often not a mark-vector user at all and there's barely
// anything on this page to translate anyway (the PDF button tooltip, the
// invalid-link message). Still runs through i18n.js so it respects a
// language already chosen in this browser (e.g. the link's own owner
// previewing it), just without a control to change it here.
applyStaticTranslations();

const headerEl = document.getElementById("public-header");
const filenameEl = document.getElementById("public-filename");
const liveDotEl = document.getElementById("public-live-dot");
const downloadMdBtn = document.getElementById("download-md-btn");
const exportPdfBtn = document.getElementById("export-pdf-btn");
const contentEl = document.getElementById("public-content");
const errorEl = document.getElementById("public-error");
const viewToggleBtn = document.getElementById("view-toggle-btn");
const slidePrevBtn = document.getElementById("slide-prev-btn");
const slideNextBtn = document.getElementById("slide-next-btn");
const slideCounterEl = document.getElementById("slide-counter");
const slideFullscreenBtn = document.getElementById("slide-fullscreen-btn");

// The page is served at /p/<token> for any token (see main.py's public_view)
// - validity is decided entirely by whether /api/public/<token> resolves,
// not by anything checked before this script runs.
const token = location.pathname.replace(/^\/p\//, "").replace(/\/$/, "");

// Uses the document's own first-level heading as the browser tab title
// (see asciimath-markdown's firstH1Heading for why only its very first line
// counts) - falls back to the filename when there isn't one, same as
// index.html's own tab title does for the open document (see app.js's
// updateFilenameLabel).
function updatePageTitle() {
  if (!doc) return;
  document.title = firstH1Heading(doc.content) || doc.filename.replace(/\.md$/i, "");
}

async function load() {
  const res = await fetch(`/api/public/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// The global custom-symbol table (see routers/public.py's GET
// /api/public/custom-symbols for why this page uses that instead of the
// session-cookie-gated /api/custom-symbols app.js uses) - applied before
// the first render below so a published document using a custom AsciiMath2
// symbol doesn't briefly (or permanently, since nothing here ever re-
// renders on its own) fall back to asciimath-markdown's bare-parser guess for it.
// Best-effort: a network hiccup here still lets the document itself load
// and render, just without whichever custom symbols it happens to use.
async function loadCustomSymbols() {
  try {
    const res = await fetch("/api/public/custom-symbols");
    if (!res.ok) return;
    const { content } = await res.json();
    setCustomAsciiMathSymbols(parseCustomSymbolsCsv(content));
  } catch (err) {
    // Network hiccup, etc. - render proceeds without custom symbols.
  }
}

// The public-page counterpart to app.js's openInternalDocumentLink - same
// two href shapes (a bare same-folder filename, or "<convId>/filename.md"
// for a folder elsewhere in the project), but there's no session-tree
// state here to check against, so routers/public.py's GET
// /api/public/{token}/resolve-link does the resolving server-side instead
// (into the target's own publish token, if it has one - never exposing
// this app's project/conversation ids to the client either way).
const INTERNAL_LINK_RE = /^(?:([0-9a-f]{8,16})\/)?([^/\\:]+\.md)$/i;

contentEl.addEventListener("click", async (e) => {
  const link = e.target.closest("a");
  if (!link) return;
  const href = link.getAttribute("href") || "";
  if (!INTERNAL_LINK_RE.test(href)) return;
  e.preventDefault();
  try {
    const res = await fetch(`/api/public/${encodeURIComponent(token)}/resolve-link?target=${encodeURIComponent(href)}`);
    if (!res.ok) return;
    const { token: targetToken } = await res.json();
    // No token - the target isn't published (or doesn't exist) - the link
    // just doesn't go anywhere, same as it wouldn't from an unpublished
    // project either.
    if (targetToken) location.href = `/p/${targetToken}`;
  } catch (err) {
    // Network hiccup, etc. - same as above, the link just doesn't navigate.
  }
});

// ---------- slideshow ----------
//
// A document published with the "slides" option (see storage.set_publish_
// slides) opens here as a slideshow, one <section class="slide"> per slide
// (see slides.js for where the boundaries are), shown one at a time (see
// public.html's body.slides-mode styles).
let view = "document"; // or "slides"
let slideIndex = 0;
let slideCount = 0;

function slideIndexFromHash() {
  const m = /^#\/?(\d+)$/.exec(location.hash);
  return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
}

function render() {
  if (view !== "slides") {
    document.body.classList.remove("slides-mode");
    contentEl.innerHTML = renderMarkdown(doc.content, doc.dialect);
    updateViewToggle();
    return;
  }
  document.body.classList.add("slides-mode");
  const slides = splitSlides(doc.content);
  slideCount = slides.length;
  contentEl.innerHTML = "";
  for (const source of slides) {
    const section = document.createElement("section");
    section.className = "slide";
    section.innerHTML = renderMarkdown(source, doc.dialect);
    contentEl.appendChild(section);
  }
  // A live edit that removed slides shouldn't leave the visitor past the end.
  goToSlide(Math.min(slideIndex, slideCount - 1));
  updateViewToggle();
}

function goToSlide(index) {
  slideIndex = Math.max(0, Math.min(index, slideCount - 1));
  contentEl.querySelectorAll(".slide").forEach((section, i) => {
    section.classList.toggle("current", i === slideIndex);
    if (i === slideIndex) section.scrollTop = 0;
  });
  slideCounterEl.textContent = `${slideIndex + 1} / ${slideCount}`;
  slidePrevBtn.disabled = slideIndex === 0;
  slideNextBtn.disabled = slideIndex >= slideCount - 1;
  // replaceState, not a hash assignment: stepping through a deck shouldn't
  // fill the back button's history with every slide.
  history.replaceState(null, "", `#${slideIndex + 1}`);
}

// The owner's gamepad remote (see app.js's presenter remote) puts the slide
// it's presenting into each live update: a 0-based index, or "last" to ride
// the newest slide as it's being built. Applied only when it *changes* (or,
// for "last", when a new slide appears) - every keystroke on the owner's
// side sends an update, and re-applying an unchanged position each time
// would yank back a visitor who'd stepped to another slide on their own.
// Absent (undefined) when the owner isn't using the remote at all.
let presenterSlide;
let presenterSlideCount = 0;
function followPresenter(slide) {
  if (slide === undefined || slide === null || view !== "slides") {
    presenterSlide = slide;
    return;
  }
  const changed = slide !== presenterSlide || (slide === "last" && slideCount !== presenterSlideCount);
  presenterSlide = slide;
  presenterSlideCount = slideCount;
  if (changed) goToSlide(slide === "last" ? slideCount - 1 : slide);
}

function updateViewToggle() {
  const slides = view === "slides";
  viewToggleBtn.textContent = t(slides ? "public.viewDocument" : "public.viewSlides");
  viewToggleBtn.title = t(slides ? "public.viewDocumentTitle" : "public.viewSlidesTitle");
}

function setView(next) {
  view = next;
  if (view !== "slides") history.replaceState(null, "", location.pathname + location.search);
  render();
}

viewToggleBtn.addEventListener("click", () => setView(view === "slides" ? "document" : "slides"));
slidePrevBtn.addEventListener("click", () => goToSlide(slideIndex - 1));
slideNextBtn.addEventListener("click", () => goToSlide(slideIndex + 1));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
// iPhone Safari has no Fullscreen API for anything but <video>.
slideFullscreenBtn.hidden = !document.documentElement.requestFullscreen;
slideFullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("keydown", (e) => {
  if (view !== "slides" || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      goToSlide(slideIndex + (e.shiftKey && e.key === " " ? -1 : 1));
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      goToSlide(slideIndex - 1);
      break;
    case "Home":
      goToSlide(0);
      break;
    case "End":
      goToSlide(slideCount - 1);
      break;
    case "f":
    case "F":
      if (!slideFullscreenBtn.hidden) toggleFullscreen();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// Horizontal swipe on a phone/tablet - vertical movement is left alone so a
// slide taller than the screen still scrolls normally.
let touchStart = null;
contentEl.addEventListener("touchstart", (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
contentEl.addEventListener("touchend", (e) => {
  if (view !== "slides" || !touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  goToSlide(slideIndex + (dx < 0 ? 1 : -1));
});

// Mutated in place by the live WebSocket below (see connectLive) - the
// download/export handlers read whichever content is current at click time
// rather than whatever was on the page when it first loaded, so a page
// left open through a live edit still downloads/prints the latest text.
let doc = null;

Promise.all([load(), loadCustomSymbols()])
  .then(([loaded]) => {
    doc = loaded;
    filenameEl.textContent = doc.filename;
    updatePageTitle();
    // Always the document's current content (see storage.resolve_published) -
    // reloading this page reflects any edit made since the link was shared.
    // The owner's publish option (see storage.set_publish_slides) only picks
    // the view a visitor starts in - the toggle lets them switch either way.
    if (doc.slides) {
      viewToggleBtn.hidden = false;
      view = "slides";
      slideIndex = slideIndexFromHash();
    }
    render();
    downloadMdBtn.hidden = false;
    downloadMdBtn.addEventListener("click", () => {
      const blob = new Blob([doc.content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = /\.[A-Za-z0-9]+$/.test(doc.filename) ? doc.filename : `${doc.filename}.md`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
    exportPdfBtn.hidden = false;
    exportPdfBtn.addEventListener("click", () => window.print());
    connectLive();
  })
  .catch(() => {
    headerEl.hidden = true;
    contentEl.hidden = true;
    errorEl.hidden = false;
  });

// While the document's owner has the editor's "Live" checkbox on (see
// app.js's livePublicSocket), edits stream in here over the same channel -
// "pub-<token>" in backend/app/routers/live.py's shared _channels dict -
// instead of this page only ever showing whatever was on disk when it
// loaded. No auth beyond the channel id itself, same as every other
// consumer of that endpoint (see live.py) - and nothing here sends
// anything, so a stray connection from this page can't disrupt anyone
// else's view the way a raw WebSocket client crafted by hand could (see
// app.js's own comment on that risk).
//
// Silent when the owner never turns "Live" on: routers/live.py only ever
// pushes a channel's *last* update to a newly-joined socket, so with no
// live update ever sent on this channel, nothing arrives and the page just
// keeps showing what load() rendered above - reload-to-refresh, same as
// before this feature existed.
let liveSocket = null;
let liveRetryDelay = 1000;
const LIVE_RETRY_MAX_MS = 10000;

function connectLive() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(`pub-${token}`)}`);
  liveSocket = socket;
  socket.addEventListener("open", () => {
    if (liveSocket !== socket) return;
    liveRetryDelay = 1000;
  });
  socket.addEventListener("message", (event) => {
    if (liveSocket !== socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (!message || message.filename == null) return;
    doc = { ...doc, filename: message.filename, content: message.content || "", dialect: message.dialect || (doc && doc.dialect) || "latex" };
    filenameEl.textContent = doc.filename;
    updatePageTitle();
    render();
    followPresenter(message.slide);
    liveDotEl.hidden = false;
    liveDotEl.classList.add("connected");
  });
  socket.addEventListener("close", () => {
    if (liveSocket !== socket) return;
    liveSocket = null;
    liveDotEl.hidden = true;
    liveDotEl.classList.remove("connected");
    setTimeout(connectLive, liveRetryDelay);
    liveRetryDelay = Math.min(liveRetryDelay * 1.5, LIVE_RETRY_MAX_MS);
  });
  socket.addEventListener("error", () => socket.close());
}

// Mirrors whatever mark-vector's main editor currently has open, live, on a
// Meta Ray-Ban Display screen. There is no text input, mouse, or touch on
// the glasses (see the Build guide) - this page is purely a passive display,
// so unlike frontend/static/js/app.js there is nothing here to wire up
// beyond receiving updates and rendering them.
//
// Custom AsciiMath symbols (see asciimath-markdown's setCustomAsciiMathSymbols) are
// deliberately not fetched here - that endpoint sits behind the app's
// Google-auth session cookie, which this device never has, and its own
// 401 handling would bounce this page to a /login it has no way to complete
// (no keyboard). Bare AsciiMath/LaTeX still renders fine without it; only a
// project's custom symbol table would be missing.
import { renderMarkdown, detectMathDirective } from "/static/js/markdown.js";
import { splitSlides } from "/static/js/slides.js";

const filenameEl = document.getElementById("filename");
const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");

// A specific document (from the editor's "Live to glasses" URL) if given -
// otherwise this screen runs in ambient mode, always tracking whichever
// document was *most recently* put into live preview, anywhere (see
// backend/app/routers/live.py's /ws/live with no channel).
const channel = new URLSearchParams(location.search).get("c");
// Ambient mode has no channel id to act as its own secret, so the server
// requires this instead when APP_PASSCODE is configured (see routers/
// live.py) - set once in the URL itself when the glasses' web app is
// configured (e.g. ".../glasses/?pin=1234"), never typed interactively.
// Harmless to send on a channel-specific connection too (that path ignores
// it entirely), so it's just always forwarded when present.
const pin = new URLSearchParams(location.search).get("pin");

function setStatus(connected) {
  statusEl.classList.toggle("live", connected);
}

function renderIdle(hint) {
  filenameEl.textContent = "";
  contentEl.innerHTML = `<p class="hint">${hint}</p>`;
  lastFilename = null;
  followBottom = true;
}

// Every update replaces contentEl's entire innerHTML - with nothing else
// done, the browser just leaves scrollTop at whatever raw pixel value it
// already was, which (since the document keeps growing during an LLM
// stream) means the view stays pinned near the top while the newest text
// lands out of sight below it. "Follow the bottom" is what actually reads
// as live - but only while nothing's manually scrolled away to read
// something earlier; see the keydown handler below, which is the only
// thing that can turn followBottom back off.
const NEAR_BOTTOM_PX = 24;
let lastFilename = null;
let followBottom = true;

function isNearBottom() {
  return contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight <= NEAR_BOTTOM_PX;
}

// ---------- slide view ----------
// One slide at a time, the same split the public slideshow uses (see
// slides.js), whenever the document is published as a slideshow
// (message.slides) - the same switch that puts the public page in slide
// view. While the owner presents with the gamepad remote, its position
// (message.slide) is followed exactly the way
// public.js's followPresenter does - applied only when it changes, or for
// "last" when a new slide appears - so the dpad's own left/right stepping
// isn't undone by every keystroke on the owner's side.
let lastMessage = null;
let slideIndex = 0;
let slideCount = 0;
let presenterSlide;
let presenterSlideCount = 0;

function slideMode(message) {
  return !!message && !!message.slides;
}

function renderSlides(message, isNewDocument) {
  const presenting = message.slide !== undefined && message.slide !== null;
  const slides = splitSlides(message.content || "", { keepEmptyLast: presenting });
  slideCount = slides.length;
  // Rendered one slide at a time, so the document's own math directive
  // has to be resolved from the whole text first (only the first slide
  // carries it) - same as public.js.
  const dialect = detectMathDirective(message.content || "") || message.dialect || "latex";
  const previousIndex = slideIndex;
  if (isNewDocument) {
    slideIndex = 0;
    presenterSlide = undefined;
  }
  if (presenting) {
    const changed = message.slide !== presenterSlide || (message.slide === "last" && slideCount !== presenterSlideCount);
    presenterSlide = message.slide;
    presenterSlideCount = slideCount;
    if (changed) slideIndex = message.slide === "last" ? slideCount - 1 : message.slide;
  }
  slideIndex = Math.max(0, Math.min(slideIndex, slideCount - 1));
  filenameEl.textContent = `${message.filename} · ${slideIndex + 1}/${slideCount}`;
  const source = slides[slideIndex];
  contentEl.innerHTML = source.trim() ? renderMarkdown(source, dialect) : '<p class="hint">(empty slide)</p>';
  if (isNewDocument || slideIndex !== previousIndex) {
    followBottom = true;
    contentEl.scrollTop = 0;
  } else if (followBottom) {
    contentEl.scrollTop = contentEl.scrollHeight;
  }
}

function render(message) {
  lastMessage = message;
  if (!message || !message.filename) {
    renderIdle("No document open in mark-vector.");
    return;
  }

  // The live target switched to a different document entirely (not just
  // grown) - start over from its top, and follow-mode re-engages
  // regardless of where a previous document had been scrolled to.
  const isNewDocument = message.filename !== lastFilename;
  lastFilename = message.filename;

  if (slideMode(message)) {
    renderSlides(message, isNewDocument);
    return;
  }
  filenameEl.textContent = message.filename;

  contentEl.innerHTML = (message.content || "").trim()
    ? renderMarkdown(message.content, message.dialect || "latex")
    : '<p class="hint">(empty)</p>';

  if (isNewDocument) {
    followBottom = true;
    contentEl.scrollTop = 0;
  } else if (followBottom) {
    contentEl.scrollTop = contentEl.scrollHeight;
  }
}

let socket = null;
let retryDelay = 1000;
// Browsers deliberately hide *why* a WebSocket handshake was rejected
// (no HTTP status, and in practice not even routers/live.py's own close
// code reliably survives to the browser's "close" event either - a
// rejection before accept() completes as an HTTP-level failure, not a
// clean WS close) - see MDN's CloseEvent docs. Timing is the only signal
// actually available: a connection that never reaches "open" and closes
// almost immediately is a rejection (missing/wrong ?pin= in ambient mode,
// almost certainly - see routers/live.py), not a network drop, which
// either happens after a real connection or takes much longer to time out.
let openedThisAttempt = false;
let attemptStartedAt = 0;
let consecutiveFastFails = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const path = channel ? `/ws/live/${encodeURIComponent(channel)}` : "/ws/live";
  const query = pin ? `?pin=${encodeURIComponent(pin)}` : "";
  openedThisAttempt = false;
  attemptStartedAt = Date.now();
  socket = new WebSocket(`${proto}://${location.host}${path}${query}`);

  socket.addEventListener("open", () => {
    openedThisAttempt = true;
    consecutiveFastFails = 0;
    setStatus(true);
    retryDelay = 1000;
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    render(message);
  });
  socket.addEventListener("close", () => {
    setStatus(false);
    if (!openedThisAttempt && Date.now() - attemptStartedAt < 2000) {
      consecutiveFastFails += 1;
    } else {
      consecutiveFastFails = 0;
    }
    // Only ambient mode (no ?c=) can be rejected this way (see routers/
    // live.py) - and only once it's happened a couple of times in a row,
    // so one stray fast failure doesn't flash this over the real idle
    // message. Retrying is still worth doing regardless (the pin could get
    // fixed, or the reason might not be the pin at all), so this is a hint
    // shown alongside the retry loop, not a replacement for it.
    if (!channel && consecutiveFastFails >= 2) {
      renderIdle("Can't connect - check this page's own URL has the right ?pin= (see the live-preview checkbox in mark-vector).");
    }
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 10000);
  });
  // A network blip fires "error" then "close" - closing explicitly here
  // just avoids waiting out however long the browser takes to notice on
  // its own before the "close" handler above kicks off the retry.
  socket.addEventListener("error", () => socket.close());
}

renderIdle(channel ? "Waiting for that document to go live…" : "Waiting for a live preview, from any document…");
connect();

// The one interaction this screen supports: the Neural Band / touch strip's
// dpad emits arrow key events (see the Build guide) - there's no focusable
// element to move between, so up/down scroll the content pane instead,
// standing in for the page-level scroll this fixed viewport can't have, and
// in slide view left/right step between slides.
const SCROLL_STEP = 140;
document.addEventListener("keydown", (event) => {
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && slideMode(lastMessage)) {
    event.preventDefault();
    const next = slideIndex + (event.key === "ArrowRight" ? 1 : -1);
    if (next < 0 || next >= slideCount) return;
    slideIndex = next;
    renderSlides(lastMessage, false);
    return;
  }
  if (event.key === "ArrowDown") {
    contentEl.scrollTop += SCROLL_STEP;
  } else if (event.key === "ArrowUp") {
    contentEl.scrollTop -= SCROLL_STEP;
  } else {
    return;
  }
  event.preventDefault();
  // Scrolling up (to read something earlier) turns follow-mode off until
  // manually scrolled back down to the bottom - see render()'s use of
  // followBottom above.
  followBottom = isNearBottom();
});

// Mirrors whatever mark-vector's main editor currently has open, live, on a
// Meta Ray-Ban Display screen. There is no text input, mouse, or touch on
// the glasses (see the Build guide) - this page is purely a passive display,
// so unlike frontend/static/js/app.js there is nothing here to wire up
// beyond receiving updates and rendering them.
//
// Custom AsciiMath symbols come from the same unauthenticated
// /api/public/custom-symbols the public page uses (see routers/public.py) -
// not /api/custom-symbols, which sits behind the app's session cookie this
// device never has (and whose 401 handling would bounce this page to a
// /login it can't complete - no keyboard).
import { renderMarkdown, detectMathDirective, parseCustomSymbolsCsv, setCustomAsciiMathSymbols } from "/static/js/markdown.js";
import { splitSlides } from "/static/js/slides.js";
import {
  HEARTBEAT_MS,
  PONG_TIMEOUT_MS,
  RESUME_PONG_TIMEOUT_MS,
  applyDocument,
  heartbeatAction,
  isLiveDocument,
  linkPhase,
  resumeAction,
  stallAction,
  stallInfo,
  stallLabel,
  statusLabel,
} from "/static/js/glasses-link.mjs";

const filenameEl = document.getElementById("filename");
const statusEl = document.getElementById("status");
const statusLabelEl = document.getElementById("status-label");
const linkStatusEl = document.getElementById("link-status");
const stallEl = document.getElementById("stall");
const contentEl = document.getElementById("content");
const screenEl = document.getElementById("screen");
const liveCheckEl = document.getElementById("live-check");

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

// The editor appends its language when it copies this URL (app.js's
// glassesUrl), so an iPhone that has never opened mark-vector still shows
// the same language. A stored choice on this device is the fallback.
function readGlassLang() {
  const fromQuery = new URLSearchParams(location.search).get("lang");
  if (fromQuery === "ko" || fromQuery === "ja" || fromQuery === "en") return fromQuery;
  try {
    const stored = localStorage.getItem("mark-vector:lang");
    if (stored === "ko" || stored === "ja" || stored === "en") return stored;
  } catch (err) {
    // private mode — English labels
  }
  return "en";
}
const glassLang = readGlassLang();
document.documentElement.lang = glassLang;

// The page is a fixed 600×600 waveguide (viewport width=600, initial-scale=1).
// On an iPhone that scale does not shrink to fit: the visual viewport is the
// phone width and the status, which sits at the right of the 600px header,
// would be off screen with user-scalable=no. When the visible width is
// narrower than the waveguide, fit the screen to what is actually in view.
// At 600 (the glasses) this leaves the stylesheet's fixed size alone.
function fitGlassViewport() {
  const vv = window.visualViewport;
  const width = vv ? vv.width : window.innerWidth;
  const height = vv ? vv.height : window.innerHeight;
  const narrow = width > 0 && width < 590;
  const targets = [document.documentElement, document.body, screenEl];
  if (!narrow) {
    for (const node of targets) {
      node.style.width = "";
      node.style.height = "";
    }
    return;
  }
  // width=600 and initial-scale=1 leave the right-hand status outside an
  // iPhone's visible area, and user-scalable=no means it cannot be pinched
  // back. Pull the layout viewport in to the visible width. The glasses
  // themselves report ~600 and never enter this branch.
  const meta = document.querySelector('meta[name="viewport"]');
  const wpx = Math.round(width);
  const hpx = Math.max(200, Math.round(height));
  if (meta) {
    const content = `width=${wpx}, height=${hpx}, initial-scale=1, maximum-scale=1, user-scalable=no`;
    if (meta.getAttribute("content") !== content) meta.setAttribute("content", content);
  }
  const w = `${wpx}px`;
  const h = `${hpx}px`;
  for (const node of targets) {
    node.style.width = w;
    node.style.height = h;
  }
}
fitGlassViewport();
window.addEventListener("resize", fitGlassViewport);
window.addEventListener("orientationchange", () => setTimeout(fitGlassViewport, 100));
if (window.visualViewport) window.visualViewport.addEventListener("resize", fitGlassViewport);

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

// ---------- live check ----------
// While the editor's Evaluate tab runs its live check, each update carries
// a snapshot of it (message.liveCheck - see analysis.js's liveSnapshot):
// a status line and the newest findings, labels already in the editor's
// language. In document view the findings, newest first, take most of the
// screen under a strip of the document's newest lines, and the D-pad's
// up/down scroll them - the findings are what's read, the document just
// follows its end. Right swaps the document strip for the findings too
// (left brings it back). Slides keep their screen, with the newest
// findings in a strip below. A finding that's just come in gets the
// findings' top edge lit for a while.
const FRESH_MS = 8000;
// How many of the newest findings the strip under a slide shows (as many as fit).
const STRIP_ISSUES = 3;
let showFindings = false;
let lastFindingCount = null;
let freshTimer = null;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderLiveCheck(message) {
  const check = message && message.liveCheck;
  if (!check) {
    liveCheckEl.hidden = true;
    screenEl.classList.remove("findings", "checking");
    showFindings = false;
    lastFindingCount = null;
    return;
  }
  liveCheckEl.hidden = false;
  screenEl.classList.toggle("checking", !slideMode(message));
  if (lastFindingCount !== null && check.count > lastFindingCount) {
    liveCheckEl.classList.add("fresh");
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => liveCheckEl.classList.remove("fresh"), FRESH_MS);
  }
  lastFindingCount = check.count;
  const findings = showFindings && !slideMode(message);
  screenEl.classList.toggle("findings", findings);
  const dialect = message.dialect || "latex";
  const md = (text) => renderMarkdown(text || "", dialect);
  const shown = slideMode(message) ? check.issues.slice(0, STRIP_ISSUES) : check.issues;
  const status = `<div class="lc-status">${escapeHtml(check.status)}${check.error ? ` <span class="lc-error">${escapeHtml(check.error)}</span>` : ""}</div>`;
  const items = shown
    .map(
      (issue) => `<div class="lc-issue severity-${escapeHtml(issue.severity)}">
        <span class="lc-label">${escapeHtml(issue.label)}</span>${issue.at ? `<span class="lc-time">${escapeHtml(new Date(issue.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}
        ${issue.quote ? `<div class="lc-quote">${md(issue.quote)}</div>` : ""}
        <div class="lc-problem">${md(issue.problem)}</div>
        ${issue.correction ? `<div class="lc-correction">→ ${md(issue.correction)}</div>` : ""}
      </div>`
    )
    .join("");
  const scroll = liveCheckEl.scrollTop;
  liveCheckEl.innerHTML = status + items;
  // Where it was scrolled to - at the top, that's the newest finding.
  liveCheckEl.scrollTop = slideMode(message) ? 0 : scroll;
}

// The editor sends the whole document up to 5 times a second (see
// LIVE_SEND_INTERVAL_MS in app.js), and each one used to be rendered in
// full - Markdown and every formula. On the glasses' processor that takes
// longer than the gap between updates once a lecture's transcript runs to
// a few thousand words, so they queued up: the screen fell further and
// further behind until it stopped. Now an update only marks itself as the
// latest, and one render runs for whichever is latest once the page is
// free - those that arrived meanwhile are skipped, not drawn one by one.
let pendingMessage = null;
let renderQueued = false;

function scheduleRender(message) {
  pendingMessage = message;
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const latest = pendingMessage;
    pendingMessage = null;
    render(latest);
  }, 0);
}

// ...and while the screen follows the bottom (it can only show the last
// screenful anyway), only the document's last TAIL_CHARS or so are
// rendered, starting at a paragraph, line or sentence break that isn't
// inside math. Scrolling up re-renders the whole document (see keydown).
const TAIL_CHARS = 4000;

function tailOf(content) {
  if (content.length <= TAIL_CHARS) return content;
  const from = content.length - TAIL_CHARS;
  for (const sep of ["\n\n", "\n", ". "]) {
    for (let cut = content.indexOf(sep, from); cut !== -1 && cut < content.length - TAIL_CHARS / 4; cut = content.indexOf(sep, cut + 1)) {
      // An even number of $ before the cut: not inside $...$ or $$...$$.
      if ((content.slice(0, cut).match(/\$/g) || []).length % 2 === 0) return content.slice(cut + sep.length);
    }
  }
  return content;
}

function render(message) {
  lastMessage = message;
  renderLiveCheck(message);
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

  const content = message.content || "";
  // Following the bottom, only the end is rendered - see tailOf.
  const shown = followBottom && !isNewDocument ? tailOf(content) : content;
  contentEl.innerHTML = content.trim()
    ? (shown.length < content.length ? '<p class="hint">…</p>' : "") + renderMarkdown(shown, message.dialect || "latex")
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
let retryTimer = null;
let heartbeatTimer = null;
let pongTimer = null;
let started = false;
let retrying = false;
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

// WebKit keeps readyState OPEN after the radio dies (lock screen, tab
// background, Safari/Orion discarding the page) and may never fire close.
// A ping unanswered within PONG_TIMEOUT_MS replaces the socket now — the
// old "check again next heartbeat" waited another 10s with the dot still
// lit. `dropped` makes a late close on the socket we already replaced a
// no-op, so it can't schedule a second reconnect.
let awaitingPong = false;
let pingSentAt = 0;
let pongBudget = PONG_TIMEOUT_MS;
let lastPongAt = 0;
// Bumped when the page is hidden so a ping timer that was frozen in the
// background can't wake up and declare a healthy socket dead. iOS delivers
// that timer and visibilitychange in either order.
let pingGeneration = 0;
const dropped = new WeakSet();
let track = { content: null, producing: false, lastChangeAt: null };
let stallProbed = false;

const PHASE_DOT = { connected: "live", connecting: "pending", reconnecting: "pending", disconnected: "down" };

function paintLink(now = Date.now()) {
  const phase = linkPhase({
    readyState: socket ? socket.readyState : 3,
    online: navigator.onLine !== false,
    retrying,
    started,
  });
  const label = statusLabel(glassLang, phase);
  if (linkStatusEl.dataset.phase !== phase) {
    linkStatusEl.dataset.phase = phase;
    statusEl.className = PHASE_DOT[phase] || "pending";
  }
  if (statusLabelEl.textContent !== label) statusLabelEl.textContent = label;
  if (linkStatusEl.title !== label) linkStatusEl.title = label;
  const stall = stallInfo(track, now);
  const stallText = stall.stalled ? stallLabel(glassLang, stall.seconds) : "";
  if (stallText) {
    stallEl.hidden = false;
    if (stallEl.textContent !== stallText) stallEl.textContent = stallText;
  } else if (!stallEl.hidden) {
    stallEl.hidden = true;
    stallEl.textContent = "";
  }
  return stall;
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function noteDrop(ws) {
  if (dropped.has(ws)) return;
  dropped.add(ws);
  if (socket === ws) socket = null;
  stopHeartbeat();
  clearTimeout(pongTimer);
  awaitingPong = false;
  if (!openedThisAttempt && Date.now() - attemptStartedAt < 2000) consecutiveFastFails += 1;
  else consecutiveFastFails = 0;
  // Only ambient mode (no ?c=) can be rejected this way (see routers/
  // live.py) - and only once it's happened a couple of times in a row,
  // so one stray fast failure doesn't flash this over the real idle
  // message. Retrying is still worth doing regardless (the pin could get
  // fixed, or the reason might not be the pin at all), so this is a hint
  // shown alongside the retry loop, not a replacement for it.
  if (!channel && consecutiveFastFails >= 2) {
    renderIdle("Can't connect - check this page's own URL has the right ?pin= (see the live-preview checkbox in mark-vector).");
  }
  // No radio: say disconnected and wait for `online`. Dialing on a timer
  // while the phone is offline only burns the backoff.
  if (navigator.onLine === false) {
    retrying = false;
    clearTimeout(retryTimer);
    paintLink();
    return;
  }
  retrying = true;
  paintLink();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 1.5, 10000);
}

// Not waiting on close(): a dead connection's close can take minutes to
// come back. The new socket goes up now, and the old one's events are
// ignored (see dropped / socket identity in the handlers).
function reconnectNow() {
  const dead = socket;
  if (dead) dropped.add(dead);
  socket = null;
  stopHeartbeat();
  clearTimeout(pongTimer);
  clearTimeout(retryTimer);
  awaitingPong = false;
  retrying = true;
  paintLink();
  if (dead) {
    try {
      dead.close();
    } catch (err) {
      // already closing
    }
  }
  connect();
}

function sendPing(budget) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    reconnectNow();
    return;
  }
  awaitingPong = true;
  pingSentAt = Date.now();
  pongBudget = budget;
  clearTimeout(pongTimer);
  const ws = socket;
  const generation = ++pingGeneration;
  pongTimer = setTimeout(() => {
    if (generation !== pingGeneration || socket !== ws || !awaitingPong) return;
    // A timer unfrozen as the phone wakes is not evidence the socket died.
    // resumeLink sends a fresh ping once the page is actually visible.
    if (document.hidden) return;
    const action = heartbeatAction({
      readyState: socket.readyState,
      awaitingPong,
      sincePing: Date.now() - pingSentAt,
      pongTimeout: pongBudget,
    });
    if (action === "reconnect") reconnectNow();
  }, budget);
  try {
    ws.send(JSON.stringify({ type: "ping" }));
  } catch (err) {
    reconnectNow();
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (document.hidden) return;
    const action = heartbeatAction({
      readyState: socket ? socket.readyState : 3,
      awaitingPong,
      sincePing: Date.now() - pingSentAt,
      pongTimeout: pongBudget,
    });
    if (action === "reconnect") reconnectNow();
    else if (action === "ping") sendPing(PONG_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

function connect() {
  started = true;
  clearTimeout(retryTimer);
  clearTimeout(pongTimer);
  awaitingPong = false;
  const previous = socket;
  if (previous) {
    dropped.add(previous);
    socket = null;
    try {
      previous.close();
    } catch (err) {
      // already closing
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const path = channel ? `/ws/live/${encodeURIComponent(channel)}` : "/ws/live";
  const query = pin ? `?pin=${encodeURIComponent(pin)}` : "";
  openedThisAttempt = false;
  attemptStartedAt = Date.now();
  const ws = new WebSocket(`${proto}://${location.host}${path}${query}`);
  socket = ws;
  paintLink();

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    openedThisAttempt = true;
    consecutiveFastFails = 0;
    retrying = false;
    retryDelay = 1000;
    awaitingPong = false;
    // Opening is proof of life until the first real pong, so a stall in
    // the first few seconds doesn't immediately redial.
    lastPongAt = Date.now();
    paintLink();
    startHeartbeat();
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (message && message.type === "pong") {
      awaitingPong = false;
      lastPongAt = Date.now();
      clearTimeout(pongTimer);
      paintLink();
      return;
    }
    if (isLiveDocument(message)) {
      track = applyDocument(track, message, Date.now());
      if (!stallInfo(track, Date.now()).stalled) stallProbed = false;
      paintLink();
    }
    scheduleRender(message);
  });
  ws.addEventListener("close", () => noteDrop(ws));
  // error often arrives without a timely close on iOS. noteDrop is
  // idempotent, so a close that follows does not dial twice.
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch (err) {
      // already closing
    }
    noteDrop(ws);
  });
}

// Back on screen after the phone locked or the tab was discarded. A
// backgrounded WebKit socket is not trustworthy just because it still
// says OPEN — ping it, and replace it if it can't answer. bfcache
// (pageshow.persisted) restores a socket that is already dead.
let lastResumeAt = 0;

function resumeLink({ force = false } = {}) {
  if (!started) return;
  // visibility, pageshow, and focus all fire together when an iPhone
  // unlocks. One probe is enough; the rest would reset the pong timer.
  const now = Date.now();
  if (!force && now - lastResumeAt < 1000) {
    paintLink();
    return;
  }
  lastResumeAt = now;
  paintLink();
  if (force) {
    reconnectNow();
    return;
  }
  const action = resumeAction({
    readyState: socket ? socket.readyState : 3,
    online: navigator.onLine !== false,
    awaitingPong,
    sincePing: Date.now() - pingSentAt,
    resumeTimeout: RESUME_PONG_TIMEOUT_MS,
  });
  if (action === "offline") {
    clearTimeout(retryTimer);
    retrying = false;
    paintLink();
    return;
  }
  if (action === "reconnect") reconnectNow();
  else if (action === "probe") sendPing(RESUME_PONG_TIMEOUT_MS);
  else paintLink();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) fitGlassViewport();
  if (document.hidden) {
    // The in-flight pong deadline was scheduled against a clock that iOS
    // is about to freeze. Drop it; the next visible pass probes from scratch.
    pingGeneration += 1;
    clearTimeout(pongTimer);
    awaitingPong = false;
    return;
  }
  resumeLink();
});
window.addEventListener("pageshow", (event) => {
  fitGlassViewport();
  resumeLink({ force: !!event.persisted });
});
window.addEventListener("online", () => resumeLink());
window.addEventListener("offline", () => resumeLink());
window.addEventListener("focus", () => {
  if (!document.hidden) resumeLink();
});
document.addEventListener("resume", () => resumeLink());

// While a session should be writing (message.producing), ten seconds
// without a changed document is a stall. If the socket is actually dead,
// that same moment redials; a live pong leaves the warning up and the
// connection alone.
setInterval(() => {
  const stall = paintLink();
  if (!stall.stalled) {
    stallProbed = false;
    return;
  }
  if (stallProbed) return;
  stallProbed = true;
  const action = stallAction({
    readyState: socket ? socket.readyState : 3,
    awaitingPong,
    sincePing: Date.now() - pingSentAt,
    sincePong: lastPongAt > 0 ? Date.now() - lastPongAt : null,
    pongTimeout: PONG_TIMEOUT_MS,
  });
  if (action === "reconnect") reconnectNow();
  else if (action === "probe") sendPing(PONG_TIMEOUT_MS);
}, 1000);

paintLink();

// Commands back to the editor (see app.js's handleScreenCommand): returns
// whether one was actually sent.
function sendCommand(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !lastMessage || !lastMessage.filename) return false;
  socket.send(JSON.stringify({ type: "command", action, filename: lastMessage.filename }));
  return true;
}

function requestNewSlide() {
  sendCommand("newSlide");
}

// A deploy changes this page's own code too, and nobody can press reload
// on the glasses - so when the server's frontend version (see backend
// app/version.py) moves past the one this page loaded with, it reloads
// itself.
const VERSION_CHECK_MS = 60000;
let loadedVersion = null;
async function checkForNewVersion() {
  try {
    const res = await fetch("/api/public/version");
    if (!res.ok) return;
    const { version } = await res.json();
    if (loadedVersion === null) loadedVersion = version;
    else if (version !== loadedVersion) {
      // Reloading with no connection leaves the glasses on an "App not
      // loading" screen nobody can get past without the menu - so only once
      // the page itself (and its script) can be fetched; otherwise next round.
      const page = await fetch(location.href, { cache: "reload" });
      const script = await fetch("/glasses/app.js", { cache: "reload" });
      if (page.ok && script.ok) location.reload();
    }
  } catch (err) {
    // offline for a moment - check again next round
  }
}
checkForNewVersion();
setInterval(checkForNewVersion, VERSION_CHECK_MS);

// Loaded before the first render (so a custom symbol never flashes as the
// bare parser's guess), then re-checked every minute: this screen stays up
// for hours, and an edit to the table in the editor should reach it without
// anyone reloading a page that has no way to reload itself. Best-effort -
// a failed fetch just keeps whatever table is already applied.
const CUSTOM_SYMBOLS_REFRESH_MS = 60000;
let customSymbolsContent = null;

async function loadCustomSymbols() {
  try {
    const res = await fetch("/api/public/custom-symbols");
    if (!res.ok) return false;
    const { content } = await res.json();
    if (content === customSymbolsContent) return false;
    customSymbolsContent = content;
    setCustomAsciiMathSymbols(parseCustomSymbolsCsv(content));
    return true;
  } catch (err) {
    return false;
  }
}

renderIdle(channel ? "Waiting for that document to go live…" : "Waiting for a live preview, from any document…");
loadCustomSymbols().finally(connect);
setInterval(async () => {
  if ((await loadCustomSymbols()) && lastMessage) render(lastMessage);
}, CUSTOM_SYMBOLS_REFRESH_MS);

// The one interaction this screen supports: the Neural Band / touch strip's
// dpad emits arrow key events (see the Build guide) - there's no focusable
// element to move between, so up/down scroll the content pane instead,
// standing in for the page-level scroll this fixed viewport can't have, and
// in slide view left/right step between slides.
const SCROLL_STEP = 140;
document.addEventListener("keydown", (event) => {
  // Document view with a live check running: up/down scroll the findings,
  // right gives them the whole screen, left brings the document strip back.
  if (lastMessage && lastMessage.liveCheck && !slideMode(lastMessage)) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = event.key === "ArrowRight";
      if (next !== showFindings) {
        showFindings = next;
        liveCheckEl.scrollTop = 0;
        renderLiveCheck(lastMessage);
      }
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      liveCheckEl.scrollTop += event.key === "ArrowDown" ? SCROLL_STEP : -SCROLL_STEP;
      return;
    }
  }
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && slideMode(lastMessage)) {
    event.preventDefault();
    const next = slideIndex + (event.key === "ArrowRight" ? 1 : -1);
    if (next >= slideCount) {
      // "Next" past the last slide asks the editor for a new, blank one
      // (the same as the gamepad remote's new-slide button - see app.js's
      // handleScreenCommand); the live update that follows brings this
      // screen onto it.
      requestNewSlide();
      return;
    }
    if (next < 0) return;
    slideIndex = next;
    renderSlides(lastMessage, false);
    return;
  }
  // Select (a Neural Band pinch / touchpad tap arrives as Enter) tidies the
  // slide being built - the gamepad remote's tidy button. The tidied slide
  // streams back in as ordinary live updates; until the first of them
  // arrives the header says it's on its way.
  if (event.key === "Enter" && slideMode(lastMessage)) {
    event.preventDefault();
    if (sendCommand("tidySlide")) filenameEl.textContent += " · ✨";
    return;
  }
  // In slide view up/down write rather than scroll: up starts (or leaves) a
  // math block, down breaks the line - the gamepad remote's Y and X. The
  // slide being written follows its own bottom as text arrives, so there's
  // little left to scroll there; document view still scrolls with them.
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && slideMode(lastMessage)) {
    event.preventDefault();
    const math = event.key === "ArrowUp";
    if (sendCommand(math ? "toggleMath" : "lineBreak")) filenameEl.textContent += math ? " · $$" : " · ↵";
    return;
  }
  if (event.key === "ArrowUp" && followBottom && lastMessage) {
    // Only the end was rendered (see tailOf) - the whole document now,
    // kept at the same distance from the bottom so nothing jumps.
    const fromBottom = contentEl.scrollHeight - contentEl.scrollTop;
    followBottom = false;
    render(lastMessage);
    contentEl.scrollTop = contentEl.scrollHeight - fromBottom;
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

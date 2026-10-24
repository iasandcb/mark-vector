// The glasses screen (/glasses/) is a passive WebSocket mirror of the
// editor (see routers/live.py). Two failures used to look the same: the
// dot stayed lit, and the text just stopped.
//
// 1. WebKit (iPhone Safari, Orion, and a phone that locked or backgrounded
//    the tab) can freeze the page and kill the socket without ever firing
//    close or error. readyState stays OPEN, and send() does not throw —
//    the bytes sit in a buffer that goes nowhere. The old client only
//    noticed on the *next* 10s heartbeat, so a dead mirror looked connected
//    for up to 20s, longer when timers were suspended. Nothing listened
//    for visibilitychange / pageshow, unlike the editor's own live socket.
// 2. The disconnected color was a near-black red on a black waveguide, so
//    the only indicator effectively disappeared instead of saying so.
//
// This module is the decisions. glasses/app.js owns the socket and the DOM.

export const STALL_MS = 10000;
export const HEARTBEAT_MS = 10000;
// A ping with no pong this soon is a dead socket. Waiting for the next
// heartbeat (the previous behavior) hid the drop for a full extra beat.
export const PONG_TIMEOUT_MS = 5000;
// Coming back to the foreground: prove the socket quickly. A backgrounded
// WebKit page often still reports OPEN.
export const RESUME_PONG_TIMEOUT_MS = 2500;

const COPY = {
  en: {
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    stall: "No new characters for {seconds}s",
  },
  ko: {
    connecting: "연결 중",
    connected: "연결됨",
    reconnecting: "재연결 중",
    disconnected: "연결 끊김",
    stall: "{seconds}초 동안 새 글자 없음",
  },
  ja: {
    connecting: "接続中",
    connected: "接続済み",
    reconnecting: "再接続中",
    disconnected: "切断",
    stall: "{seconds}秒間、新しい文字がありません",
  },
};

function copy(lang) {
  return COPY[lang] || COPY.en;
}

// WebSocket readyState: 0 connecting, 1 open, 2 closing, 3 closed.
// `retrying` is set once a live socket has dropped and another attempt is
// scheduled or in progress. Before the first attempt, `started` is false.
export function linkPhase({ readyState, online, retrying, started }) {
  if (online === false && readyState !== 1) return "disconnected";
  if (readyState === 1) return "connected";
  if (retrying) return "reconnecting";
  if (!started || readyState === 0) return "connecting";
  return "disconnected";
}

export function statusLabel(lang, phase) {
  const table = copy(lang);
  return table[phase] || table.connecting;
}

export function stallLabel(lang, seconds) {
  return copy(lang).stall.replaceAll("{seconds}", String(seconds));
}

// Dictation landing in *this* document, or a model reply streaming into it.
// A document that is merely open is not expected to grow.
export function expectsText({ dictatingHere = false, streaming = false } = {}) {
  return !!dictatingHere || !!streaming;
}

export function isLiveDocument(message) {
  return !!message && message.type === "update" && typeof message.content === "string";
}

// `track` is { content, producing, lastChangeAt }. content starts null so
// the first snapshot is not compared against "". Any later change of the
// text counts as characters arriving — interim speech often rewrites a
// span without making it longer. An identical replay (the server resends
// the last state on reconnect) does not reset the clock.
export function applyDocument(track, message, now) {
  const content = typeof message.content === "string" ? message.content : "";
  const producing = !!message.producing;
  const previous = track && track.content != null ? track.content : null;
  const seen = previous != null;
  const changed = seen && content !== previous;
  const started = producing && !(track && track.producing);
  let lastChangeAt = track && track.lastChangeAt != null ? track.lastChangeAt : null;
  if (!producing) lastChangeAt = null;
  else if (!seen || changed || started) lastChangeAt = now;
  return { content, producing, lastChangeAt };
}

export function stallInfo(track, now, stallMs = STALL_MS) {
  if (!track || !track.producing || track.lastChangeAt == null) return { stalled: false, seconds: 0 };
  const elapsed = now - track.lastChangeAt;
  if (elapsed < stallMs) return { stalled: false, seconds: 0 };
  return { stalled: true, seconds: Math.floor(elapsed / 1000) };
}

// What the heartbeat tick should do. A handshake in progress is left alone.
export function heartbeatAction({ readyState, awaitingPong, sincePing, pongTimeout }) {
  if (readyState === 0) return "wait";
  if (readyState !== 1) return "reconnect";
  if (awaitingPong && sincePing >= pongTimeout) return "reconnect";
  if (awaitingPong) return "wait";
  return "ping";
}

// Page shown again, network returned, or the phone unlocked.
// "probe" pings a socket that still claims to be open. "offline" means
// there is nothing to dial and the indicator should say disconnected.
export function resumeAction({ readyState, online, awaitingPong = false, sincePing = 0, resumeTimeout = RESUME_PONG_TIMEOUT_MS }) {
  if (online === false) return readyState === 1 ? "probe" : "offline";
  if (readyState === 0) return "wait";
  if (readyState !== 1) return "reconnect";
  if (awaitingPong && sincePing < resumeTimeout) return "wait";
  return "probe";
}

// The stall warning is about text, not the socket. Reconnect only when
// this check can see that the transport is actually dead. A recent pong
// means the mirror is up and the words themselves have stopped.
export function stallAction({ readyState, awaitingPong, sincePing, sincePong, pongTimeout }) {
  if (readyState === 0) return "wait";
  if (readyState !== 1) return "reconnect";
  if (awaitingPong && sincePing >= pongTimeout) return "reconnect";
  if (awaitingPong) return "wait";
  if (sincePong != null && sincePong < pongTimeout) return "warn";
  return "probe";
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  PONG_TIMEOUT_MS,
  STALL_MS,
  applyDocument,
  expectsText,
  heartbeatAction,
  isLiveDocument,
  linkPhase,
  resumeAction,
  stallAction,
  stallInfo,
  stallLabel,
  statusLabel,
} from "./glasses-link.mjs";

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

test("the indicator names the socket, including the retry and the offline drop", () => {
  assert.equal(linkPhase({ readyState: CLOSED, online: true, retrying: false, started: false }), "connecting");
  assert.equal(linkPhase({ readyState: CONNECTING, online: true, retrying: false, started: true }), "connecting");
  assert.equal(linkPhase({ readyState: OPEN, online: true, retrying: false, started: true }), "connected");
  assert.equal(linkPhase({ readyState: CLOSED, online: true, retrying: true, started: true }), "reconnecting");
  assert.equal(linkPhase({ readyState: CONNECTING, online: true, retrying: true, started: true }), "reconnecting");
  assert.equal(linkPhase({ readyState: CLOSED, online: false, retrying: true, started: true }), "disconnected");
  assert.equal(linkPhase({ readyState: CLOSED, online: true, retrying: false, started: true }), "disconnected");
  assert.equal(statusLabel("ko", "connected"), "연결됨");
  assert.equal(statusLabel("ko", "reconnecting"), "재연결 중");
  assert.equal(statusLabel("ko", "disconnected"), "연결 끊김");
  assert.equal(statusLabel("en", "reconnecting"), "Reconnecting");
  assert.equal(statusLabel("ja", "connected"), "接続済み");
});

test("text is expected only while dictation or a reply is actually writing", () => {
  assert.equal(expectsText({}), false);
  assert.equal(expectsText({ dictatingHere: true }), true);
  assert.equal(expectsText({ streaming: true }), true);
  assert.equal(expectsText({ dictatingHere: false, streaming: false }), false);
});

test("a quiet open document does not warn, and 10s without new characters does", () => {
  let track = { content: null, producing: false, lastChangeAt: null };
  track = applyDocument(track, { type: "update", content: "강의", producing: false }, 0);
  assert.deepEqual(stallInfo(track, STALL_MS), { stalled: false, seconds: 0 });

  track = applyDocument(track, { type: "update", content: "강의", producing: true }, 1000);
  assert.equal(stallInfo(track, 1000 + STALL_MS - 1).stalled, false);
  assert.deepEqual(stallInfo(track, 1000 + STALL_MS), { stalled: true, seconds: 10 });
  assert.equal(stallLabel("ko", 10), "10초 동안 새 글자 없음");
  assert.equal(stallLabel("en", 10), "No new characters for 10s");

  track = applyDocument(track, { type: "update", content: "강의 다음", producing: true }, 20000);
  assert.equal(stallInfo(track, 20000 + STALL_MS - 1).stalled, false);

  // The reconnect replay of the same text must not clear the stall.
  const stalled = applyDocument(track, { type: "update", content: "강의 다음", producing: true }, 40000);
  assert.equal(stalled.lastChangeAt, track.lastChangeAt);
  assert.equal(stallInfo(stalled, 40000).stalled, true);

  const stopped = applyDocument(stalled, { type: "update", content: "강의 다음", producing: false }, 41000);
  assert.equal(stallInfo(stopped, 60000).stalled, false);
});

test("commands and pongs are not document snapshots", () => {
  assert.equal(isLiveDocument({ type: "update", content: "a" }), true);
  assert.equal(isLiveDocument({ type: "pong" }), false);
  assert.equal(isLiveDocument({ type: "command", action: "newSlide", filename: "a.md" }), false);
  assert.equal(isLiveDocument({ filename: "a.md" }), false);
});

test("a missing pong reconnects without waiting for another full heartbeat", () => {
  assert.equal(heartbeatAction({ readyState: OPEN, awaitingPong: false, sincePing: 0, pongTimeout: PONG_TIMEOUT_MS }), "ping");
  assert.equal(heartbeatAction({ readyState: OPEN, awaitingPong: true, sincePing: PONG_TIMEOUT_MS - 1, pongTimeout: PONG_TIMEOUT_MS }), "wait");
  assert.equal(heartbeatAction({ readyState: OPEN, awaitingPong: true, sincePing: PONG_TIMEOUT_MS, pongTimeout: PONG_TIMEOUT_MS }), "reconnect");
  assert.equal(heartbeatAction({ readyState: CONNECTING, awaitingPong: false, sincePing: 0, pongTimeout: PONG_TIMEOUT_MS }), "wait");
  assert.equal(heartbeatAction({ readyState: CLOSED, awaitingPong: false, sincePing: 0, pongTimeout: PONG_TIMEOUT_MS }), "reconnect");
});

test("returning to the page probes a socket that still looks open and redials one that does not", () => {
  assert.equal(resumeAction({ readyState: OPEN, online: true }), "probe");
  assert.equal(resumeAction({ readyState: CLOSED, online: true }), "reconnect");
  assert.equal(resumeAction({ readyState: CONNECTING, online: true }), "wait");
  assert.equal(resumeAction({ readyState: CLOSED, online: false }), "offline");
  // A brief offline flicker must not tear down a socket that is still open.
  assert.equal(resumeAction({ readyState: OPEN, online: false }), "probe");
  assert.equal(resumeAction({ readyState: OPEN, online: true, awaitingPong: true, sincePing: 500, resumeTimeout: 2500 }), "wait");
});

test("a stall reconnects only when the transport is dead", () => {
  assert.equal(
    stallAction({ readyState: OPEN, awaitingPong: false, sincePing: 0, sincePong: 1000, pongTimeout: PONG_TIMEOUT_MS }),
    "warn"
  );
  assert.equal(
    stallAction({ readyState: OPEN, awaitingPong: false, sincePing: 0, sincePong: PONG_TIMEOUT_MS, pongTimeout: PONG_TIMEOUT_MS }),
    "probe"
  );
  assert.equal(
    stallAction({ readyState: OPEN, awaitingPong: true, sincePing: PONG_TIMEOUT_MS, sincePong: 9000, pongTimeout: PONG_TIMEOUT_MS }),
    "reconnect"
  );
  assert.equal(
    stallAction({ readyState: CLOSED, awaitingPong: false, sincePing: 0, sincePong: null, pongTimeout: PONG_TIMEOUT_MS }),
    "reconnect"
  );
  assert.equal(
    stallAction({ readyState: CONNECTING, awaitingPong: false, sincePing: 0, sincePong: null, pongTimeout: PONG_TIMEOUT_MS }),
    "wait"
  );
});

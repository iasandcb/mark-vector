import assert from "node:assert/strict";
import test from "node:test";
import { formatPlaybackClock, parsePlaybackTime, playbackJump } from "./audio-time.mjs";

test("timestamps and plain seconds parse to a position", () => {
  assert.equal(parsePlaybackTime("1:23"), 83);
  assert.equal(parsePlaybackTime("12:05"), 12 * 60 + 5);
  assert.equal(parsePlaybackTime("1:02:30"), 3600 + 120 + 30);
  assert.equal(parsePlaybackTime("90"), 90);
  assert.equal(parsePlaybackTime("90.5"), 90.5);
  assert.equal(parsePlaybackTime("90,5"), 90.5);
  assert.equal(parsePlaybackTime("  1:23  "), 83);
  assert.equal(parsePlaybackTime("1：02：30"), 3750);
  assert.equal(parsePlaybackTime("1 : 23"), 83);
  assert.equal(parsePlaybackTime("0:00"), 0);
  assert.equal(parsePlaybackTime("75:00"), 75 * 60);
  assert.equal(parsePlaybackTime("01:02"), 62);
});

test("a time that is not a position is refused", () => {
  for (const text of ["", "   ", "abc", "-1", "1:60", "1:02:60", "1:2:3:4", "1:", ":23", "1.2.3", "+5"]) {
    assert.equal(parsePlaybackTime(text), null, text);
  }
});

test("a jump past the end is refused and a short file still accepts its end", () => {
  assert.deepEqual(playbackJump(10, 100), { ok: true, seconds: 10 });
  assert.deepEqual(playbackJump(0, 5), { ok: true, seconds: 0 });
  assert.deepEqual(playbackJump(5, 5), { ok: true, seconds: 5 });
  assert.deepEqual(playbackJump(5.02, 5), { ok: true, seconds: 5 });
  assert.deepEqual(playbackJump(90, 83), { ok: false, reason: "range" });
  assert.deepEqual(playbackJump(null, 83), { ok: false, reason: "invalid" });
  assert.deepEqual(playbackJump(-1, 83), { ok: false, reason: "invalid" });
  assert.deepEqual(playbackJump(10, null), { ok: false, reason: "loading" });
  assert.deepEqual(playbackJump(10, 0), { ok: false, reason: "loading" });
  assert.deepEqual(playbackJump(10, Number.NaN), { ok: false, reason: "loading" });
});

test("the clock shows minutes until an hour, then hours", () => {
  assert.equal(formatPlaybackClock(0), "00:00");
  assert.equal(formatPlaybackClock(83), "01:23");
  assert.equal(formatPlaybackClock(3723), "1:02:03");
  assert.equal(formatPlaybackClock(Number.NaN), "--:--");
});

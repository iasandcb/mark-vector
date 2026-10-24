import assert from "node:assert/strict";
import test from "node:test";
import {
  attachDuckPlayback,
  beginMicSession,
  claimPlaybackSession,
  clearMediaSession,
  createDuckRetry,
  duckResumeDecision,
  endMicSession,
  fileSpeakerRoute,
  mediaMetadataFor,
  pauseOrigin,
  playbackClaimOwner,
  playbackSessionRequest,
  publishMediaSession,
  releasePlaybackSession,
  resetPlaybackSessionForTests,
  tapSyncAction,
  writeAudioSessionType,
} from "./playback-session.mjs";

test("playback is requested only when nothing is recording", () => {
  assert.equal(playbackSessionRequest({ micLive: false, supported: true }), "playback");
  assert.equal(playbackSessionRequest({ micLive: true, supported: true }), null);
  assert.equal(playbackSessionRequest({ micLive: false, supported: false }), null);
});

test("a live microphone forces auto and a playback claim cannot override it", () => {
  resetPlaybackSessionForTests();
  const session = { type: "playback" };
  assert.equal(beginMicSession(session), 1);
  assert.equal(session.type, "auto");
  assert.equal(claimPlaybackSession("file", session), false);
  assert.equal(session.type, "auto");
  assert.equal(playbackClaimOwner(), null);
  assert.equal(endMicSession(), 0);
  assert.equal(claimPlaybackSession("file", session), true);
  assert.equal(session.type, "playback");
  assert.equal(claimPlaybackSession("recording", session), true);
  assert.equal(playbackClaimOwner(), "recording");
  // The file stopping must not drop the recording's claim.
  assert.equal(releasePlaybackSession("file", session), false);
  assert.equal(session.type, "playback");
  assert.equal(releasePlaybackSession("recording", session), true);
  assert.equal(session.type, "auto");
  assert.equal(playbackClaimOwner(), null);
});

test("a session that rejects the write is left alone", () => {
  const session = {
    _type: "play-and-record",
    set type(value) {
      throw new Error("not settable");
    },
    get type() {
      return this._type;
    },
  };
  assert.equal(writeAudioSessionType(session, "playback"), false);
  assert.equal(session.type, "play-and-record");
});

test("lock-screen metadata names the file", () => {
  assert.deepEqual(mediaMetadataFor("lecture.m4a"), { title: "lecture.m4a", artist: "mark-vector" });
  assert.equal(mediaMetadataFor("  ").title, "mark-vector");
  resetPlaybackSessionForTests();
  const target = { metadata: null, playbackState: "none", handlers: {} };
  target.setActionHandler = (action, handler) => {
    target.handlers[action] = handler;
  };
  assert.equal(publishMediaSession("file", { title: "Talk", playbackState: "playing" }, target), true);
  assert.deepEqual(target.metadata, { title: "Talk", artist: "mark-vector" });
  assert.equal(target.playbackState, "playing");
  assert.equal(clearMediaSession("recording", target), false);
  assert.equal(target.metadata.title, "Talk");
  assert.equal(clearMediaSession("file", target), true);
  assert.equal(target.metadata, null);
  assert.equal(target.playbackState, "none");
});

test("the audible file is a media element, not the Web Audio graph", () => {
  assert.equal(fileSpeakerRoute(), "element");
});

test("the silent tap follows the audible element", () => {
  assert.equal(tapSyncAction({ audiblePaused: false, tapPaused: true, audibleTime: 3, tapTime: 3 }), "play");
  assert.equal(tapSyncAction({ audiblePaused: true, tapPaused: false }), "pause");
  assert.equal(tapSyncAction({ audiblePaused: false, tapPaused: false, audibleTime: 10, tapTime: 9 }), "seek");
  assert.equal(tapSyncAction({ audiblePaused: false, tapPaused: false, audibleTime: 10, tapTime: 9.8 }), "ok");
  assert.equal(tapSyncAction({ audiblePaused: true, tapPaused: true, audibleTime: 4, tapTime: 1 }), "seek");
  assert.equal(tapSyncAction({ audiblePaused: true, tapPaused: true, audibleTime: 4, tapTime: 4 }), "ok");
});

test("an active-session pause replays; an interrupted one waits; the user wins", () => {
  const playing = { wasPlaying: true, systemPause: true, sessionState: "active" };
  assert.equal(duckResumeDecision(playing), "replay");
  assert.equal(duckResumeDecision({ ...playing, sessionState: "interrupted" }), "wait");
  assert.equal(duckResumeDecision({ ...playing, sessionState: "" }), "replay");
  assert.equal(duckResumeDecision({ ...playing, userPaused: true }), "ignore");
  assert.equal(duckResumeDecision({ ...playing, ended: true }), "ignore");
  assert.equal(duckResumeDecision({ ...playing, wasPlaying: false }), "ignore");
  assert.equal(duckResumeDecision({ ...playing, attempts: 1, attemptAgeMs: 50 }), "later");
  assert.equal(duckResumeDecision({ ...playing, attempts: 1, attemptAgeMs: 700 }), "replay");
  assert.equal(duckResumeDecision({ ...playing, attempts: 4, attemptAgeMs: 5000 }), "give-up");
});

test("a finger on the controls is a user pause; an interrupted session is not", () => {
  assert.equal(pauseOrigin({ userMarked: true, pointerAgeMs: 5000 }), "user");
  assert.equal(pauseOrigin({ sessionState: "interrupted", pointerAgeMs: 10 }), "system");
  assert.equal(pauseOrigin({ pointerAgeMs: 100 }), "user");
  assert.equal(pauseOrigin({ pointerAgeMs: 5000 }), "system");
  assert.equal(pauseOrigin({}), "system");
});

test("a repeated pause waits, then replays; a held interruption does not replay until it ends", () => {
  let now = 1000;
  let state = "active";
  let paused = true;
  const plays = [];
  const scheduled = [];
  const retry = createDuckRetry({
    now: () => now,
    schedule: (fn, ms) => {
      const id = scheduled.length + 1;
      scheduled.push({ id, fn, ms });
      return id;
    },
    cancel: (id) => {
      const item = scheduled.find((entry) => entry.id === id);
      if (item) item.cancelled = true;
    },
    sessionState: () => state,
    stillPaused: () => paused,
    replay: () => {
      plays.push(now);
      paused = false;
    },
  });
  assert.equal(retry.onSystemPause(), "replay");
  assert.deepEqual(plays, [1000]);
  paused = true;
  now = 1100;
  assert.equal(retry.onSystemPause(), "later");
  assert.equal(plays.length, 1);
  assert.equal(scheduled[0].ms, 700);
  now = 2000;
  scheduled[0].fn();
  assert.deepEqual(plays, [1000, 2000]);

  paused = true;
  state = "interrupted";
  now = 9000;
  assert.equal(retry.onSystemPause(), "wait");
  assert.equal(plays.length, 2);
  assert.equal(retry.onSession("interrupted"), "wait");
  assert.equal(plays.length, 2);
  state = "active";
  assert.equal(retry.onSession("active"), "replay");
  assert.equal(plays.length, 3);

  // The element kept playing through a session blip: do not pause it.
  paused = false;
  state = "interrupted";
  retry.onSession("interrupted");
  state = "active";
  assert.equal(retry.onSession("active"), "ignore");
  assert.equal(plays.length, 3);
});

test("giving up waits for a real play, and a user pause cancels a pending replay", () => {
  let now = 0;
  let paused = true;
  let gaveUp = 0;
  const scheduled = [];
  const plays = [];
  const retry = createDuckRetry({
    now: () => now,
    maxAttempts: 2,
    replayGapMs: 700,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms, cancelled: false });
      return scheduled.length;
    },
    cancel: (id) => {
      scheduled[id - 1].cancelled = true;
    },
    sessionState: () => "active",
    stillPaused: () => paused,
    replay: () => {
      plays.push(now);
    },
    onGiveUp: () => {
      gaveUp += 1;
    },
  });
  assert.equal(retry.onSystemPause(), "replay");
  now = 10;
  assert.equal(retry.onSystemPause(), "later");
  now = 20;
  scheduled[0].fn();
  assert.equal(plays.length, 2);
  now = 30;
  assert.equal(retry.onSystemPause(), "give-up");
  assert.equal(gaveUp, 1);
  assert.equal(retry.onSession("active"), "ignore");

  retry.reset();
  paused = true;
  assert.equal(retry.onSystemPause(), "replay");
  now = 40;
  assert.equal(retry.onSystemPause(), "later");
  retry.reset();
  now = 800;
  scheduled[1].fn();
  assert.equal(scheduled[1].cancelled, true);
  assert.equal(plays.length, 3);
});

test("a recordings player replays a system pause and leaves a user pause paused", async () => {
  resetPlaybackSessionForTests();
  const session = { type: "auto", state: "active", listeners: new Set() };
  session.addEventListener = (type, fn) => session.listeners.add(fn);
  session.removeEventListener = (type, fn) => session.listeners.delete(fn);
  let now = 5000;
  let pointerAt = null;
  const claims = [];
  const releases = [];
  const published = [];
  const cleared = [];
  class FakeAudio extends EventTarget {
    constructor() {
      super();
      this.paused = true;
      this.ended = false;
      this.plays = 0;
    }
    play() {
      this.paused = false;
      this.plays += 1;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  const audio = new FakeAudio();
  const handle = attachDuckPlayback(audio, {
    owner: "recording:1",
    title: "YouTube talk",
    now: () => now,
    sessionState: () => session.state,
    audioSession: session,
    claim: (owner) => {
      claims.push(owner);
      return true;
    },
    release: (owner) => {
      releases.push(owner);
    },
    publish: (owner, details) => {
      published.push({ owner, ...details, handlerKeys: Object.keys(details.handlers || {}) });
    },
    clearMedia: (owner) => {
      cleared.push(owner);
    },
    schedule: () => 1,
    cancel: () => {},
  });
  await audio.play();
  assert.deepEqual(claims, ["recording:1"]);
  assert.equal(published.at(-1).title, "YouTube talk");
  assert.equal(published.at(-1).playbackState, "playing");
  assert.equal(audio.plays, 1);

  // System pause, session already active: duck failed, so replay.
  audio.paused = true;
  audio.dispatchEvent(new Event("pause"));
  assert.equal(audio.plays, 2);
  assert.equal(audio.paused, false);

  // The listener pressed pause on the control.
  now = 5100;
  pointerAt = now;
  audio.dispatchEvent(new Event("pointerdown"));
  audio.pause();
  assert.equal(audio.plays, 2);
  assert.equal(audio.paused, true);
  assert.equal(published.at(-1).playbackState, "paused");
  assert.deepEqual(releases, []);

  // An interruption while playing resumes only when the session lets go,
  // and not if the user had paused.
  await audio.play();
  audio.paused = true;
  session.state = "interrupted";
  audio.dispatchEvent(new Event("pause"));
  assert.equal(audio.plays, 3);
  session.state = "active";
  handle.sessionChanged();
  assert.equal(audio.plays, 4);

  handle.noteUserPause();
  session.state = "interrupted";
  handle.sessionChanged();
  session.state = "active";
  handle.sessionChanged();
  assert.equal(audio.plays, 4);

  audio.ended = true;
  audio.dispatchEvent(new Event("ended"));
  assert.deepEqual(releases, ["recording:1"]);
  assert.deepEqual(cleared, ["recording:1"]);
  handle.stop();
  assert.deepEqual(releases, ["recording:1", "recording:1"]);
});

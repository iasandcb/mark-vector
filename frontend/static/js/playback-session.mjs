// iOS mixes a media element in a "playback" audio session the way the
// YouTube app does: a short voice alert ducks the volume, both play, and
// the volume comes back. The same alert interrupts a Web Audio graph
// (MediaElementSource → destination) and a "play-and-record" session.
//
// The audible file is therefore always a plain media element. Transcription
// still needs samples, so a second element is tapped and that tap is not
// the speaker. A live microphone is never overridden: the Audio Session
// spec ends a mic track whose session type is not "auto" or "play-and-record".

const MEDIA_ACTIONS = ["play", "pause", "seekbackward", "seekforward", "seekto"];

let micDepth = 0;
let claimOwner = null;
let mediaOwner = null;

function navigatorSession() {
  try {
    return typeof navigator !== "undefined" ? navigator.audioSession : null;
  } catch (err) {
    return null;
  }
}

function navigatorMedia() {
  try {
    return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
  } catch (err) {
    return null;
  }
}

export function writeAudioSessionType(session, type) {
  if (!session || !type) return false;
  try {
    session.type = type;
    return true;
  } catch (err) {
    return false;
  }
}

// What to ask the platform for. Null means "do not touch the session".
export function playbackSessionRequest({ micLive = false, supported = true } = {}) {
  if (!supported || micLive) return null;
  return "playback";
}

export function micSessionLive() {
  return micDepth > 0;
}

// Recording / dictation / discussion. Drops any playback claim first so a
// microphone track is not ended for having type "playback".
export function beginMicSession(session = navigatorSession()) {
  micDepth += 1;
  claimOwner = null;
  writeAudioSessionType(session, "auto");
  return micDepth;
}

export function endMicSession() {
  micDepth = Math.max(0, micDepth - 1);
  return micDepth;
}

export function claimPlaybackSession(owner = "playback", session = navigatorSession()) {
  if (micDepth > 0 || !session) return false;
  if (!writeAudioSessionType(session, "playback")) return false;
  claimOwner = owner;
  return true;
}

export function releasePlaybackSession(owner = "playback", session = navigatorSession()) {
  if (claimOwner !== owner) return false;
  claimOwner = null;
  if (micDepth > 0) return false;
  return writeAudioSessionType(session, "auto");
}

export function playbackClaimOwner() {
  return claimOwner;
}

export function mediaMetadataFor(title) {
  const name = String(title || "").trim() || "mark-vector";
  return { title: name, artist: "mark-vector" };
}

export function publishMediaSession(owner, { title, playbackState, handlers, Metadata } = {}, target = navigatorMedia()) {
  if (!target) return false;
  mediaOwner = owner;
  const fields = title ? mediaMetadataFor(title) : null;
  if (fields) {
    try {
      const Ctor = Metadata || (typeof MediaMetadata !== "undefined" ? MediaMetadata : null);
      target.metadata = Ctor ? new Ctor(fields) : fields;
    } catch (err) {
      try {
        target.metadata = fields;
      } catch (error) {
        // metadata is optional; the action handlers still apply
      }
    }
  }
  if (playbackState) {
    try {
      target.playbackState = playbackState;
    } catch (err) {
      // this browser has no playbackState
    }
  }
  if (handlers) {
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        if (typeof target.setActionHandler === "function") target.setActionHandler(action, handler);
      } catch (err) {
        // action not supported
      }
    }
  }
  return true;
}

export function setMediaPlaybackState(owner, playbackState, target = navigatorMedia()) {
  if (!target || mediaOwner !== owner || !playbackState) return false;
  try {
    target.playbackState = playbackState;
    return true;
  } catch (err) {
    return false;
  }
}

export function clearMediaSession(owner, target = navigatorMedia()) {
  if (!target || mediaOwner !== owner) return false;
  mediaOwner = null;
  try {
    target.metadata = null;
  } catch (err) {
    // already clear
  }
  try {
    target.playbackState = "none";
  } catch (err) {
    // this browser has no playbackState
  }
  if (typeof target.setActionHandler === "function") {
    for (const action of MEDIA_ACTIONS) {
      try {
        target.setActionHandler(action, null);
      } catch (err) {
        // action not supported
      }
    }
  }
  return true;
}

export function mediaSessionOwner() {
  return mediaOwner;
}

// Tests construct a fresh module state. Production never calls this.
export function resetPlaybackSessionForTests() {
  micDepth = 0;
  claimOwner = null;
  mediaOwner = null;
}

// The element the user hears. "element" is a plain media element, which
// iOS ducks. A Web Audio graph that is the speaker gets interrupted.
export function fileSpeakerRoute() {
  return "element";
}

// The transcription tap follows the audible element. It is never the speaker.
export function tapSyncAction({
  audiblePaused = true,
  tapPaused = true,
  audibleTime = 0,
  tapTime = 0,
  drift = 0.35,
} = {}) {
  const apart = Math.abs((audibleTime || 0) - (tapTime || 0)) > drift;
  if (audiblePaused && !tapPaused) return "pause";
  if (audiblePaused) return apart ? "seek" : "ok";
  if (tapPaused) return "play";
  return apart ? "seek" : "ok";
}

// A pause while the platform still reports "interrupted" waits. A pause
// while the session is already active is iOS stopping a file it should
// have ducked: replay, unless the last replay was just paused again.
export function duckResumeDecision({
  userPaused = false,
  ended = false,
  wasPlaying = false,
  systemPause = false,
  sessionState = "",
  attempts = 0,
  attemptAgeMs = Infinity,
  maxAttempts = 4,
  replayGapMs = 700,
} = {}) {
  if (userPaused || ended || !wasPlaying) return "ignore";
  if (sessionState === "interrupted") return "wait";
  if (!systemPause) return "ignore";
  if (attempts >= maxAttempts) return "give-up";
  if (attempts > 0 && attemptAgeMs < replayGapMs) return "later";
  return "replay";
}

// Native controls don't say who paused. A pointer on the element in the
// last moment is the listener. An interrupted session is the platform
// even if a finger was just down. Media Session pause sets userMarked.
export function pauseOrigin({ userMarked = false, sessionState = "", pointerAgeMs = Infinity, pointerWindowMs = 700 } = {}) {
  if (userMarked) return "user";
  if (sessionState === "interrupted") return "system";
  if (pointerAgeMs >= 0 && pointerAgeMs < pointerWindowMs) return "user";
  return "system";
}

export function createDuckRetry(hooks = {}) {
  const now = hooks.now || (() => Date.now());
  const schedule = hooks.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = hooks.cancel || ((id) => clearTimeout(id));
  const sessionState = hooks.sessionState || (() => "");
  const replayGapMs = hooks.replayGapMs ?? 700;
  const maxAttempts = hooks.maxAttempts ?? 4;
  let attempts = 0;
  let attemptAt = 0;
  let waiting = false;
  let gaveUp = false;
  let replaying = false;
  let replayGen = 0;
  let timer = null;

  const clearTimer = () => {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  };

  const tryReplay = () => {
    replayGen += 1;
    const gen = replayGen;
    replaying = true;
    attempts += 1;
    attemptAt = now();
    waiting = true;
    let pending;
    try {
      pending = hooks.replay && hooks.replay();
    } catch (err) {
      pending = null;
    }
    const done = () => {
      if (replayGen === gen) replaying = false;
    };
    if (pending && typeof pending.then === "function") pending.then(done, done);
    else done();
    return "replay";
  };

  return {
    reset() {
      attempts = 0;
      attemptAt = 0;
      waiting = false;
      gaveUp = false;
      replaying = false;
      clearTimer();
    },
    isReplaying() {
      return replaying;
    },
    onSystemPause() {
      if (gaveUp) return "give-up";
      if (attempts > 0 && now() - attemptAt >= replayGapMs) attempts = 0;
      const decision = duckResumeDecision({
        wasPlaying: true,
        systemPause: true,
        sessionState: sessionState(),
        attempts,
        attemptAgeMs: attempts > 0 ? now() - attemptAt : Infinity,
        maxAttempts,
        replayGapMs,
      });
      if (decision === "ignore") return decision;
      waiting = true;
      if (decision === "replay") return tryReplay();
      if (decision === "later") {
        clearTimer();
        timer = schedule(() => {
          timer = null;
          if (!waiting || gaveUp) return;
          if (sessionState() === "interrupted") return;
          if (hooks.stillPaused && !hooks.stillPaused()) {
            waiting = false;
            return;
          }
          tryReplay();
        }, replayGapMs);
        return decision;
      }
      if (decision === "give-up") {
        waiting = false;
        gaveUp = true;
        clearTimer();
        if (hooks.onGiveUp) hooks.onGiveUp();
      }
      return decision;
    },
    onSession(state) {
      if (state === "interrupted") {
        if (!gaveUp) waiting = true;
        return "wait";
      }
      if (!waiting || gaveUp) return "ignore";
      if (hooks.stillPaused && !hooks.stillPaused()) {
        waiting = false;
        clearTimer();
        return "ignore";
      }
      clearTimer();
      attempts = 0;
      return tryReplay();
    },
  };
}

// Plain <audio controls> (the recordings list, where an ingested YouTube
// soundtrack is played). Feature-detects the Audio Session API via claim().
export function attachDuckPlayback(audio, options = {}) {
  const now = options.now || (() => Date.now());
  const sessionState = options.sessionState || (() => {
    const session = navigatorSession();
    return session && typeof session.state === "string" ? session.state : "";
  });
  const claim = options.claim || ((owner) => claimPlaybackSession(owner));
  const release = options.release || ((owner) => releasePlaybackSession(owner));
  const publish = options.publish || ((owner, details) => publishMediaSession(owner, details));
  const clearMedia = options.clearMedia || ((owner) => clearMediaSession(owner));
  const owner = options.owner || "playback";
  const title = options.title || "";
  let userMarked = false;
  let wasPlaying = false;
  let pointerAt = -Infinity;

  const duck = createDuckRetry({
    now,
    schedule: options.schedule,
    cancel: options.cancel,
    sessionState,
    replayGapMs: options.replayGapMs,
    maxAttempts: options.maxAttempts,
    stillPaused: () => !userMarked && audio.paused && !audio.ended,
    replay: () => {
      let pending;
      try {
        pending = audio.play();
      } catch (err) {
        pending = null;
      }
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      return pending;
    },
    onGiveUp: options.onGiveUp,
  });

  const metadata = (playbackState) => {
    const handlers = {
      play: () => {
        userMarked = false;
        duck.reset();
        const pending = audio.play();
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      },
      pause: () => {
        userMarked = true;
        audio.pause();
      },
    };
    publish(owner, { title, playbackState, handlers: options.mediaHandlers || handlers });
  };

  const onPointer = () => {
    pointerAt = now();
  };

  const onPlay = () => {
    if (!duck.isReplaying()) duck.reset();
    userMarked = false;
    wasPlaying = true;
    claim(owner);
    metadata("playing");
  };

  const onPause = () => {
    if (audio.ended) {
      wasPlaying = false;
      userMarked = false;
      duck.reset();
      release(owner);
      clearMedia(owner);
      return;
    }
    const origin = pauseOrigin({
      userMarked,
      sessionState: sessionState(),
      pointerAgeMs: now() - pointerAt,
    });
    if (origin === "user" || !wasPlaying) {
      userMarked = true;
      wasPlaying = false;
      duck.reset();
      metadata("paused");
      return;
    }
    duck.onSystemPause();
  };

  const onSession = () => {
    if (userMarked) return;
    duck.onSession(sessionState());
  };

  audio.addEventListener("play", onPlay);
  audio.addEventListener("pause", onPause);
  audio.addEventListener("ended", onPause);
  audio.addEventListener("pointerdown", onPointer);
  audio.addEventListener("pointerup", onPointer);

  let unlisten = () => {};
  const audioSession = options.audioSession !== undefined ? options.audioSession : navigatorSession();
  if (audioSession && typeof audioSession.addEventListener === "function") {
    audioSession.addEventListener("statechange", onSession);
    unlisten = () => {
      try {
        audioSession.removeEventListener("statechange", onSession);
      } catch (err) {
        // already gone
      }
    };
  }

  return {
    stop() {
      duck.reset();
      unlisten();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("pointerdown", onPointer);
      audio.removeEventListener("pointerup", onPointer);
      release(owner);
      clearMedia(owner);
    },
    noteUserPause() {
      userMarked = true;
      wasPlaying = false;
      duck.reset();
    },
    sessionChanged: onSession,
  };
}

// A playback position typed by hand: "1:23", "12:05", "1:02:30", or plain
// seconds ("90", "90.5"). Shared by the editor's file bar and the
// recordings list, so both jump with the same rules. No DOM.

const FULLWIDTH_COLON = /：/g;

// Minutes may be 60 or more when the text has no hour field ("75:00" is
// 75 minutes). With an hour field, minutes and seconds stay under 60.
export function parsePlaybackTime(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim().replace(FULLWIDTH_COLON, ":");
  if (!raw) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
    const seconds = Number(raw.replace(",", "."));
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const nums = parts.map((part) => Number(part));
  if (parts.length === 2) {
    const [minutes, seconds] = nums;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }
  const [hours, minutes, seconds] = nums;
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

// `duration` is seconds, or null/NaN/0 when the length is not known yet.
// A hair past the end (float noise) lands on the end. A real overrun does
// not move playback.
export function playbackJump(seconds, duration) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: "loading" };
  }
  if (seconds > duration + 0.05) return { ok: false, reason: "range" };
  return { ok: true, seconds: Math.min(seconds, duration) };
}

export const PLAYBACK_JUMP_MESSAGE = {
  invalid: "audio.gotoInvalid",
  range: "audio.gotoRange",
  loading: "audio.gotoLoading",
};

export function formatPlaybackClock(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const mm = String(Math.floor(whole / 60) % 60).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

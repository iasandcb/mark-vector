// Ambient /ws/live has no channel id of its own. The glasses device cannot
// type, so its page URL may still carry ?pin=. That value is posted to
// /auth/passcode (which sets mv_session) and is not copied onto the socket.
// A channel URL (?c=) is a capability URL and skips this entirely.
// scripter does not open /ws/live.

export function liveSocketPath(channel) {
  if (channel) return `/ws/live/${encodeURIComponent(channel)}`;
  return "/ws/live";
}

// requestPasscode resolves to an HTTP status, or rejects when the network fails.
// 200 and 404 are remembered: the cookie is set, or passcode auth is off.
// 401 and 429 are not retried, so a wrong pin cannot lock the IP forever.
export async function allowAmbientConnect({ channel, pin, alreadyAllowed, requestPasscode }) {
  if (channel) return { ok: true, remember: false, retry: false };
  if (alreadyAllowed || !pin) return { ok: true, remember: !!alreadyAllowed, retry: false };
  let status;
  try {
    status = await requestPasscode(pin);
  } catch {
    return { ok: false, remember: false, retry: true };
  }
  if (status === 200 || status === 404) return { ok: true, remember: true, retry: false };
  if (status === 401 || status === 429) return { ok: false, remember: false, retry: false };
  return { ok: false, remember: false, retry: true };
}

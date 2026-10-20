import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.parse
from pathlib import Path

import httpx2
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .config import settings
from .models import PasscodeLoginRequest

router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

SESSION_COOKIE = "mv_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days - a personal app, not worth re-prompting often
STATE_COOKIE = "mv_oauth_state"
STATE_MAX_AGE = 10 * 60  # just long enough to complete the Google redirect round-trip

# Reachable with no session at all: the login page and the OAuth dance
# itself (obviously), this app's own JS/CSS (the login page needs to load
# it too - it isn't sensitive on its own, only the API data behind it is),
# the public share-link feature (routers/public.py, main.py's /p/{token})
# which is *meant* to work for anyone with the link, logged in or not, and
# the glasses live-preview screen (main.py's /glasses mount) - a Meta
# Ray-Ban Display has no keyboard to complete a Google sign-in with, so it
# has to be reachable the same unauthenticated way /p/ is. (routers/live.py's
# /ws/live/{channel} websocket doesn't need listing here at all - Starlette's
# BaseHTTPMiddleware, which this class extends, only ever wraps http-scope
# requests and passes websocket connections straight through untouched.)
#
# "/" and "/about" are public too: the landing page (frontend/landing.html)
# is what a signed-out visitor gets at the root - main.index decides
# between it and the app with is_authenticated() below.
_PUBLIC_EXACT_PATHS = {"/", "/about", "/login", "/glasses"}
# /api/ingest/ checks a token of its own instead (see routers/ingest.py).
_PUBLIC_PATH_PREFIXES = ("/auth/", "/static/", "/p/", "/api/public/", "/glasses/", "/api/ingest/")


def _session_secret() -> bytes:
    """Stable across restarts (a fresh random key each boot would silently
    log every session out on every restart) - generated once and persisted
    next to the rest of this app's state. Deliberately not cached in a
    module-level variable: this is read at most once per request, and not
    caching keeps it trivially correct under tests that monkeypatch
    settings.data_dir per test (see storage.py's identical lazy-path
    pattern for why - an import-time or first-call-cached value would keep
    pointing at whichever data_dir happened to be active first)."""
    path = Path(settings.data_dir)
    path.mkdir(parents=True, exist_ok=True)
    secret_path = path / ".session_secret"
    if not secret_path.exists():
        secret_path.write_text(secrets.token_hex(32), encoding="utf-8")
    return secret_path.read_text(encoding="utf-8").encode()


def _sign_session(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    signature = hmac.new(_session_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _verify_session(cookie_value: str | None) -> dict | None:
    if not cookie_value or "." not in cookie_value:
        return None
    body, _, signature = cookie_value.partition(".")
    expected = hmac.new(_session_secret(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload


@router.get("/config")
async def auth_config():
    """Tells the login page which sign-in method(s) to render - Google,
    passcode, both, or (mid-setup, or a fresh checkout) neither. Public like
    everything else under /auth/ - it reveals nothing but booleans."""
    return {"google": bool(settings.google_client_id), "passcode": bool(settings.app_passcode)}


@router.post("/passcode")
async def passcode_login(req: PasscodeLoginRequest):
    if not settings.app_passcode:
        raise HTTPException(status_code=404, detail="Passcode sign-in is not configured")
    # compare_digest over a plain `==` - a 4-digit passcode is guessable
    # enough already without also leaking timing information about how many
    # leading digits matched.
    if not hmac.compare_digest(req.code, settings.app_passcode):
        raise HTTPException(status_code=401, detail="Incorrect passcode")

    # No `email` - unlike a Google session, there's no identity behind a
    # shared passcode to record. Every other reader of a session payload
    # (auth.me, AuthMiddleware) already treats a missing/None email as fine.
    session_value = _sign_session({"email": None, "exp": time.time() + SESSION_MAX_AGE})
    response = JSONResponse({"ok": True})
    response.set_cookie(SESSION_COOKIE, session_value, max_age=SESSION_MAX_AGE, httponly=True, samesite="lax")
    return response


@router.get("/login")
async def login(request: Request):
    if not settings.google_client_id:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID is not configured")
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": str(request.url_for("auth_callback")),
        "response_type": "code",
        "scope": "openid email",
        "state": state,
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}")
    response.set_cookie(STATE_COOKIE, state, max_age=STATE_MAX_AGE, httponly=True, samesite="lax")
    return response


@router.get("/callback", name="auth_callback")
async def callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    expected_state = request.cookies.get(STATE_COOKIE)
    if error or not code or not state or not expected_state or not hmac.compare_digest(state, expected_state):
        response = RedirectResponse("/login?error=oauth_failed")
        response.delete_cookie(STATE_COOKIE)
        return response

    async with httpx2.AsyncClient() as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": str(request.url_for("auth_callback")),
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            response = RedirectResponse("/login?error=oauth_failed")
            response.delete_cookie(STATE_COOKIE)
            return response
        access_token = token_resp.json().get("access_token")

        userinfo_resp = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        if userinfo_resp.status_code != 200:
            response = RedirectResponse("/login?error=oauth_failed")
            response.delete_cookie(STATE_COOKIE)
            return response
        userinfo = userinfo_resp.json()

    email = (userinfo.get("email") or "").lower()
    if not userinfo.get("email_verified") or email not in settings.allowed_emails:
        response = RedirectResponse("/login?error=unauthorized")
        response.delete_cookie(STATE_COOKIE)
        return response

    session_value = _sign_session({"email": email, "exp": time.time() + SESSION_MAX_AGE})
    response = RedirectResponse("/")
    response.set_cookie(
        SESSION_COOKIE, session_value, max_age=SESSION_MAX_AGE, httponly=True, samesite="lax"
    )
    response.delete_cookie(STATE_COOKIE)
    return response


@router.get("/logout")
async def logout():
    response = RedirectResponse("/login")
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/me")
async def me(request: Request):
    payload = _verify_session(request.cookies.get(SESSION_COOKIE))
    if payload is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"email": payload["email"]}


def auth_enabled() -> bool:
    return bool(settings.google_client_id or settings.app_passcode)


def is_authenticated(request: Request) -> bool:
    """True when the app itself may be shown: auth is off entirely, or the
    request carries a valid session."""
    return not auth_enabled() or _verify_session(request.cookies.get(SESSION_COOKIE)) is not None


class AuthMiddleware(BaseHTTPMiddleware):
    """No-op entirely until Google sign-in and/or the passcode are actually
    configured (see Settings.google_client_id/app_passcode) - so a fresh
    checkout, or this app running exactly as it did before either feature
    existed, is never locked out by it. Once either is configured: every
    request needs a valid session cookie except the public paths above; a
    browser navigation without one is bounced to /login, an API call gets a
    401 instead of an HTML redirect body (so frontend/static/js/api.js's
    fetch() callers can detect it cleanly). A session is a session
    regardless of which method minted it - /login just offers whichever
    method(s) are configured (see GET /auth/config)."""

    async def dispatch(self, request: Request, call_next):
        if not auth_enabled():
            return await call_next(request)

        path = request.url.path
        if path in _PUBLIC_EXACT_PATHS or path.startswith(_PUBLIC_PATH_PREFIXES):
            return await call_next(request)

        payload = _verify_session(request.cookies.get(SESSION_COOKIE))
        if payload is None:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Not authenticated"}, status_code=401)
            return RedirectResponse("/login")

        request.state.user_email = payload["email"]
        return await call_next(request)

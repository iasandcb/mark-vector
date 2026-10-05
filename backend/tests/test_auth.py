import time
import types

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import settings
from app.main import app


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def google_configured(monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", "test-client-id")
    monkeypatch.setattr(settings, "google_client_secret", "test-client-secret")
    monkeypatch.setattr(settings, "allowed_emails", ["iasandcb@gmail.com"])


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeGoogleClient:
    def __init__(self, token_payload, userinfo_payload, token_status=200, userinfo_status=200):
        self.token_payload = token_payload
        self.userinfo_payload = userinfo_payload
        self.token_status = token_status
        self.userinfo_status = userinfo_status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data=None):
        return _FakeResponse(self.token_status, self.token_payload)

    async def get(self, url, headers=None):
        return _FakeResponse(self.userinfo_status, self.userinfo_payload)


def _patch_google_client(monkeypatch, **kwargs):
    fake = _FakeGoogleClient(**kwargs)
    monkeypatch.setattr(auth, "httpx2", types.SimpleNamespace(AsyncClient=lambda: fake))


# ---------- middleware: no-op until Google sign-in is configured ----------


def test_no_auth_required_when_google_not_configured(isolated_data_dir, client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_api_reachable_with_no_cookie_when_google_not_configured(isolated_data_dir, client):
    resp = client.get("/api/projects")
    assert resp.status_code == 200


# ---------- middleware: enforced once configured ----------


def test_root_shows_landing_page_without_session(isolated_data_dir, google_configured, client):
    resp = client.get("/", follow_redirects=False)
    assert resp.status_code == 200
    assert 'id="landing"' in resp.text


def test_about_always_shows_landing_page(isolated_data_dir, google_configured, client):
    assert 'id="landing"' in client.get("/about").text
    session = auth._sign_session({"email": "iasandcb@gmail.com", "exp": time.time() + 3600})
    client.cookies.set(auth.SESSION_COOKIE, session)
    assert 'id="landing"' in client.get("/about").text


def test_api_returns_401_without_session(isolated_data_dir, google_configured, client):
    resp = client.get("/api/projects")
    assert resp.status_code == 401


def test_login_page_reachable_without_session(isolated_data_dir, google_configured, client):
    assert client.get("/login").status_code == 200


def test_static_assets_reachable_without_session(isolated_data_dir, google_configured, client):
    assert client.get("/static/js/app.js").status_code == 200


def test_public_share_link_reachable_without_session(isolated_data_dir, google_configured, client):
    # No such token exists - the point is the *middleware* doesn't block it
    # (a 404 from the route itself is fine; a redirect to /login is not).
    assert client.get("/api/public/no-such-token").status_code == 404


def test_authenticated_request_reaches_the_app(isolated_data_dir, google_configured, client):
    session = auth._sign_session({"email": "iasandcb@gmail.com", "exp": time.time() + 3600})
    client.cookies.set(auth.SESSION_COOKIE, session)
    resp = client.get("/")
    assert resp.status_code == 200
    assert 'id="landing"' not in resp.text
    assert client.get("/api/projects").status_code == 200


# ---------- session cookie signing ----------


def test_session_round_trips(isolated_data_dir):
    token = auth._sign_session({"email": "a@b.com", "exp": time.time() + 60})
    payload = auth._verify_session(token)
    assert payload["email"] == "a@b.com"


def test_tampered_session_is_rejected(isolated_data_dir):
    token = auth._sign_session({"email": "a@b.com", "exp": time.time() + 60})
    body, _, sig = token.partition(".")
    tampered = f"{body}x.{sig}"
    assert auth._verify_session(tampered) is None


def test_expired_session_is_rejected(isolated_data_dir):
    token = auth._sign_session({"email": "a@b.com", "exp": time.time() - 1})
    assert auth._verify_session(token) is None


def test_missing_session_is_rejected(isolated_data_dir):
    assert auth._verify_session(None) is None
    assert auth._verify_session("") is None
    assert auth._verify_session("garbage") is None


def test_session_secret_is_stable_across_calls(isolated_data_dir):
    assert auth._session_secret() == auth._session_secret()


# ---------- /auth/login ----------


def test_login_without_google_client_id_is_500(isolated_data_dir, client):
    assert client.get("/auth/login").status_code == 500


def test_login_redirects_to_google_with_state_cookie(isolated_data_dir, google_configured, client):
    resp = client.get("/auth/login", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert resp.headers["location"].startswith(auth.GOOGLE_AUTH_URL)
    assert "client_id=test-client-id" in resp.headers["location"]
    assert auth.STATE_COOKIE in resp.cookies


# ---------- /auth/callback ----------


def test_callback_without_state_cookie_fails(isolated_data_dir, google_configured, client):
    resp = client.get("/auth/callback?code=abc&state=xyz", follow_redirects=False)
    assert resp.headers["location"] == "/login?error=oauth_failed"


def test_callback_with_mismatched_state_fails(isolated_data_dir, google_configured, client):
    client.cookies.set(auth.STATE_COOKIE, "expected-state")
    resp = client.get("/auth/callback?code=abc&state=wrong-state", follow_redirects=False)
    assert resp.headers["location"] == "/login?error=oauth_failed"


def test_callback_allows_configured_email(isolated_data_dir, google_configured, client, monkeypatch):
    _patch_google_client(
        monkeypatch,
        token_payload={"access_token": "tok"},
        userinfo_payload={"email": "IASandCB@gmail.com", "email_verified": True},
    )
    client.cookies.set(auth.STATE_COOKIE, "s1")
    resp = client.get("/auth/callback?code=abc&state=s1", follow_redirects=False)
    assert resp.headers["location"] == "/"
    assert auth.SESSION_COOKIE in resp.cookies

    session_client = TestClient(app)
    session_client.cookies.set(auth.SESSION_COOKIE, resp.cookies[auth.SESSION_COOKIE])
    me = session_client.get("/auth/me")
    assert me.status_code == 200
    # normalized to lowercase, matching settings.allowed_emails
    assert me.json()["email"] == "iasandcb@gmail.com"


def test_callback_rejects_unlisted_email(isolated_data_dir, google_configured, client, monkeypatch):
    _patch_google_client(
        monkeypatch,
        token_payload={"access_token": "tok"},
        userinfo_payload={"email": "someone-else@gmail.com", "email_verified": True},
    )
    client.cookies.set(auth.STATE_COOKIE, "s1")
    resp = client.get("/auth/callback?code=abc&state=s1", follow_redirects=False)
    assert resp.headers["location"] == "/login?error=unauthorized"
    assert auth.SESSION_COOKIE not in resp.cookies


def test_callback_rejects_unverified_email(isolated_data_dir, google_configured, client, monkeypatch):
    _patch_google_client(
        monkeypatch,
        token_payload={"access_token": "tok"},
        userinfo_payload={"email": "iasandcb@gmail.com", "email_verified": False},
    )
    client.cookies.set(auth.STATE_COOKIE, "s1")
    resp = client.get("/auth/callback?code=abc&state=s1", follow_redirects=False)
    assert resp.headers["location"] == "/login?error=unauthorized"


def test_callback_handles_token_exchange_failure(isolated_data_dir, google_configured, client, monkeypatch):
    _patch_google_client(monkeypatch, token_payload={}, userinfo_payload={}, token_status=400)
    client.cookies.set(auth.STATE_COOKIE, "s1")
    resp = client.get("/auth/callback?code=abc&state=s1", follow_redirects=False)
    assert resp.headers["location"] == "/login?error=oauth_failed"


# ---------- /auth/logout ----------


def test_logout_clears_session_and_redirects(isolated_data_dir, google_configured, client):
    session = auth._sign_session({"email": "iasandcb@gmail.com", "exp": time.time() + 3600})
    client.cookies.set(auth.SESSION_COOKIE, session)
    resp = client.get("/auth/logout", follow_redirects=False)
    assert resp.headers["location"] == "/login"
    # A cleared cookie is sent back with an empty/expired value.
    assert not resp.cookies.get(auth.SESSION_COOKIE)


# ---------- /auth/me ----------


def test_me_without_session_is_401(isolated_data_dir, client):
    assert client.get("/auth/me").status_code == 401

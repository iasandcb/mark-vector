from pathlib import Path
import json
from email.utils import formatdate
from types import SimpleNamespace
from uuid import uuid4

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import x_articles
from app.config import settings
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "google_client_id", None)
    monkeypatch.setattr(settings, "app_passcode", None)
    for name in ("x_api_key", "x_api_secret", "x_access_token", "x_access_token_secret", "x_user_access_token"):
        monkeypatch.setattr(settings, name, None)
    return TestClient(app)


@pytest.fixture
def configured(client, monkeypatch):
    monkeypatch.setattr(settings, "x_api_key", "consumer-key")
    monkeypatch.setattr(settings, "x_api_secret", "consumer-secret")
    monkeypatch.setattr(settings, "x_access_token", "user-token")
    monkeypatch.setattr(settings, "x_access_token_secret", "user-secret")
    return client


def draft_body():
    return {"request_id": str(uuid4()), "title": "제목", "content_state": {
        "blocks": [{"key": "mv0", "type": "unstyled", "text": "😀 굵게 link",
                    "inline_style_ranges": [{"offset": 3, "length": 2, "style": "bold"}],
                    "entity_ranges": [{"key": 0, "offset": 6, "length": 4}]}],
        "entities": [{"key": "0", "value": {"type": "link", "mutability": "mutable", "data": {"url": "https://example.com"}}}],
    }}


@pytest.fixture
def upstream(monkeypatch):
    calls = []
    class FakeClient:
        def __init__(self, **kwargs):
            assert kwargs == {"timeout": 30.0, "follow_redirects": False}
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def post(self, url, headers, **kwargs):
            calls.append((url, headers, kwargs))
            assert url == "https://api.x.com/2/articles/draft"
            return httpx2.Response(201, json={"data": {"id": "12345"}})
    monkeypatch.setattr(x_articles.httpx2, "Client", FakeClient)
    return calls


def respond(monkeypatch, response=None, failure=None):
    class FakeClient:
        def __init__(self, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def post(self, *args, **kwargs):
            if failure:
                return failure()
            return response
    monkeypatch.setattr(x_articles, "httpx2", SimpleNamespace(Client=FakeClient, RequestError=httpx2.RequestError))


def test_unconfigured_does_not_expose_secrets_or_call_x(client, upstream):
    assert client.get("/api/x-articles/config").json() == {"configured": False}
    assert client.post("/api/x-articles/drafts", json=draft_body()).status_code == 503
    assert upstream == []


def test_export_creates_only_one_draft_and_is_idempotent(configured, upstream):
    body = draft_body()
    assert configured.get("/api/x-articles/config").json() == {"configured": True}
    first = configured.post("/api/x-articles/drafts", json=body)
    assert first.status_code == 200
    assert first.json() == {"article_id": "12345", "url": "https://x.com/i/articles"}
    assert len(upstream) == 1
    assert upstream[0][0] == "https://api.x.com/2/articles/draft"
    assert upstream[0][2]["json"] == {"title": body["title"], "content_state": body["content_state"]}
    auth = upstream[0][1]["Authorization"]
    assert auth.startswith("OAuth ") and 'oauth_signature_method="HMAC-SHA1"' in auth
    assert "consumer-secret" not in auth and "user-secret" not in auth
    assert configured.post("/api/x-articles/drafts", json=body).json() == first.json()
    assert len(upstream) == 1


def test_publication_endpoint_is_unavailable_and_never_calls_x(configured, upstream):
    body = draft_body()
    configured.post("/api/x-articles/drafts", json=body)
    assert configured.post(f"/api/x-articles/drafts/{body['request_id']}/publish").status_code == 404
    assert len(upstream) == 1


def test_idempotency_survives_new_client_and_changed_payload_is_rejected(configured, upstream):
    body = draft_body()
    configured.post("/api/x-articles/drafts", json=body)
    with TestClient(app) as fresh:
        assert fresh.post("/api/x-articles/drafts", json=body).status_code == 200
    body["title"] = "different"
    assert configured.post("/api/x-articles/drafts", json=body).status_code == 409
    assert len(upstream) == 1


def test_account_change_cannot_reuse_old_export(configured, upstream, monkeypatch):
    body = draft_body()
    configured.post("/api/x-articles/drafts", json=body)
    monkeypatch.setattr(settings, "x_access_token", "another-account")
    assert configured.post("/api/x-articles/drafts", json=body).status_code == 409
    assert len(upstream) == 1


def test_oauth2_user_token_supported(client, upstream, monkeypatch):
    monkeypatch.setattr(settings, "x_user_access_token", "user-context-token")
    assert client.post("/api/x-articles/drafts", json=draft_body()).status_code == 200
    assert upstream[0][1] == {"Authorization": "Bearer user-context-token"}


@pytest.mark.parametrize("status,code", [(401, "authentication"), (402, "credits"), (403, "permission"), (429, "rateLimit"), (400, "invalidContent"), (404, "endpointUnavailable"), (413, "articleTooLarge"), (422, "invalidContent"), (500, "upstreamUnavailable"), (503, "upstreamUnavailable"), (409, "rejected")])
def test_upstream_errors_are_safe_and_do_not_redirect_to_app_login(configured, monkeypatch, status, code):
    respond(monkeypatch, httpx2.Response(status, json={"detail": "secret upstream content"}))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert response.status_code == 502
    assert response.json() == {"detail": code}
    assert not Path(settings.data_dir, "x-articles.json").exists()


def test_transport_failure_has_no_automatic_retry(configured, monkeypatch):
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise httpx2.ConnectError("private diagnostics")
    respond(monkeypatch, failure=fail)
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert response.json() == {"detail": "connectionFailed"}
    assert len(calls) == 1


def test_invalid_response_is_not_saved(configured, monkeypatch):
    respond(monkeypatch, httpx2.Response(201, json={"data": {"id": "../../bad"}}))
    assert configured.post("/api/x-articles/drafts", json=draft_body()).json() == {"detail": "invalidResponse"}


@pytest.mark.parametrize("mutation", ["empty", "bad_range", "unknown_entity", "script_link", "unknown_style", "too_large"])
def test_invalid_content_never_reaches_x(configured, upstream, mutation):
    body = draft_body()
    if mutation == "empty":
        body["title"] = " "
    elif mutation == "bad_range":
        body["content_state"]["blocks"][0]["inline_style_ranges"][0]["length"] = 100
    elif mutation == "unknown_entity":
        body["content_state"]["blocks"][0]["entity_ranges"][0]["key"] = 5
    elif mutation == "script_link":
        body["content_state"]["entities"][0]["value"]["data"]["url"] = "javascript:alert(1)"
    elif mutation == "unknown_style":
        body["content_state"]["blocks"][0]["inline_style_ranges"][0]["style"] = "BOLD"
    else:
        body["content_state"]["blocks"][0]["text"] = "x" * 200_001
    assert configured.post("/api/x-articles/drafts", json=body).status_code == 422
    assert not upstream


def test_cross_origin_and_unauthenticated_access_rejected(configured, upstream, monkeypatch):
    assert configured.post("/api/x-articles/drafts", json=draft_body(), headers={"Origin": "https://evil.example"}).status_code == 403
    monkeypatch.setattr(settings, "app_passcode", "1234")
    assert configured.get("/api/x-articles/config").status_code == 401
    assert configured.post("/api/x-articles/drafts", json=draft_body()).status_code == 401
    assert not upstream


def test_429_exposes_reset_and_counts_without_exposing_private_body_or_headers(configured, monkeypatch, caplog):
    body = draft_body()
    respond(monkeypatch, httpx2.Response(429, json={
        "type": "https://api.x.com/2/problems/rate-limit-exceeded",
        "detail": f"Rejected {body['title']}: {body['content_state']['blocks'][0]['text']}",
        "request": {"private": "PRIVATE_BODY"},
    }, headers={
        "x-rate-limit-limit": "10", "x-rate-limit-remaining": "0", "x-rate-limit-reset": "1793332800",
        "Retry-After": "120", "Authorization": "PRIVATE_HEADER", "Set-Cookie": "PRIVATE_COOKIE",
    }))
    response = configured.post("/api/x-articles/drafts", json=body)
    assert response.status_code == 502
    assert response.json() == {"detail": "rateLimit"}
    assert response.headers["X-RateLimit-Limit"] == "10"
    assert response.headers["X-RateLimit-Remaining"] == "0"
    assert response.headers["X-RateLimit-Reset"] == "1793332800"
    assert response.headers["Retry-After"] == "120"
    assert response.headers["X-X-Error-Type"] == "rate-limit-exceeded"
    assert "reset=1793332800" in caplog.text
    combined = str(response.headers) + response.text + caplog.text
    assert "PRIVATE_" not in combined
    assert json.loads(response.headers["X-X-Error-Info"])["detail"] == "Rejected [redacted]: [redacted]"
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("domain", ["api.x.com", "api.twitter.com"])
def test_429_usage_cap_is_distinct_even_when_credits_may_remain(configured, monkeypatch, domain):
    respond(monkeypatch, httpx2.Response(429, json={"type": f"https://{domain}/2/problems/usage-capped"}))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert response.json() == {"detail": "usageCap"}
    assert response.headers["X-X-Error-Type"] == "usage-capped"
    assert "X-RateLimit-Reset" not in response.headers


def test_429_missing_headers_does_not_invent_a_reset(configured, monkeypatch):
    respond(monkeypatch, httpx2.Response(429, text="upstream error"))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert response.json() == {"detail": "rateLimit"}
    assert not any(name in response.headers for name in ["X-RateLimit-Reset", "X-RateLimit-Limit", "Retry-After"])


def test_429_untrusted_metadata_is_not_forwarded_or_logged(configured, monkeypatch, caplog):
    respond(monkeypatch, httpx2.Response(429, json={"type": "https://private.example/usage-capped", "detail": "consumer-secret", "request": "PRIVATE_BODY"}, headers={
        "x-rate-limit-reset": "PRIVATE_TOKEN", "x-rate-limit-limit": "-1", "x-rate-limit-remaining": "9e9",
        "retry-after": "PRIVATE_DATE",
    }))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert response.json() == {"detail": "rateLimit"}
    assert "X-X-Error-Type" not in response.headers
    assert "X-RateLimit-Reset" not in response.headers
    assert "Retry-After" not in response.headers
    assert "PRIVATE_" not in response.text + str(response.headers) + caplog.text


def test_limit_diagnostic_selects_error_fields_and_redacts_credentials(configured, monkeypatch, caplog):
    respond(monkeypatch, httpx2.Response(429, json={
        "title": "Too Many Requests", "type": "about:blank",
        "detail": "consumer-key consumer-secret user-token user-secret",
        "errors": [{"code": 88, "message": "Rate limit exceeded"},
                   {"code": 123, "message": "Authorization: OAuth private-signature"},
                   {"code": 456, "message": "PRIVATE_EXTRA_ERROR"}],
        "access_token": "PRIVATE_EXTRA_FIELD",
    }))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    info = json.loads(response.headers["X-X-Error-Info"])
    assert info == {
        "title": "Too Many Requests", "type": "about:blank",
        "detail": "[redacted] [redacted] [redacted] [redacted]",
        "errors": [{"code": 88, "message": "Rate limit exceeded"},
                   {"code": 123, "message": "[redacted authentication data]"}],
    }
    assert "PRIVATE_" not in str(response.headers) + caplog.text
    assert "Too Many Requests" not in caplog.text
    assert not Path(settings.data_dir, "x-articles.json").exists()


def test_limit_diagnostic_is_bounded_ascii_and_ignores_malformed_fields(configured, monkeypatch):
    respond(monkeypatch, httpx2.Response(429, json={
        "title": "😀" * 1000, "detail": "😀" * 1000,
        "errors": [{"message": "😀" * 1000}, {"detail": "😀" * 1000}],
    }))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    raw = response.headers["X-X-Error-Info"]
    assert raw.isascii() and len(raw) <= 6000
    assert json.loads(raw)["title"]
    respond(monkeypatch, httpx2.Response(429, json={"title": [], "detail": {}, "code": True, "errors": [None]}))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert json.loads(response.headers["X-X-Error-Info"]) == {"format": "no-error-fields"}


def test_non_json_limit_body_is_not_forwarded(configured, monkeypatch):
    respond(monkeypatch, httpx2.Response(429, text="<html>PRIVATE_BODY</html>"))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert json.loads(response.headers["X-X-Error-Info"]) == {"format": "non-json"}
    assert "PRIVATE_BODY" not in str(response.headers) + response.text


def test_retry_after_http_date_is_converted_to_seconds(configured, monkeypatch):
    now = 1793332800
    monkeypatch.setattr(x_articles.time, "time", lambda: now)
    respond(monkeypatch, httpx2.Response(429, json={}, headers={"Retry-After": formatdate(now + 90, usegmt=True)}))
    response = configured.post("/api/x-articles/drafts", json=draft_body())
    assert int(response.headers["Retry-After"]) in (90, 91)

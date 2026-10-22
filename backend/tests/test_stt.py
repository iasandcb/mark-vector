import json

import pytest
from fastapi.testclient import TestClient

import app.routers.stt as stt
from app.config import settings
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


class _Resp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text

    def json(self):
        return json.loads(self.text)


class _FakeClient:
    calls = []
    response = _Resp(201, "v=0\r\nanswer")

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, files=None, json=None):
        _FakeClient.calls.append({"url": url, "headers": headers, "files": files, "json": json})
        return _FakeClient.response


@pytest.fixture
def fake_openai(monkeypatch):
    _FakeClient.calls = []
    _FakeClient.response = _Resp(201, "v=0\r\nanswer")
    monkeypatch.setattr(stt.httpx2, "AsyncClient", _FakeClient)
    return _FakeClient


def test_config_reports_availability(client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", None)
    monkeypatch.setattr(settings, "soniox_api_key", None)
    assert client.get("/api/stt/config").json() == {
        "available": False,
        "openai": False,
        "soniox": False,
        "model": "gpt-live-transcribe",
    }
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    body = client.get("/api/stt/config").json()
    assert body["available"] is True
    assert body["openai"] is True
    assert body["soniox"] is False
    monkeypatch.setattr(settings, "soniox_api_key", "soniox-long-lived")
    body = client.get("/api/stt/config").json()
    assert body["soniox"] is True
    assert "soniox-long-lived" not in json.dumps(body)


def test_session_forwards_offer_and_returns_answer(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    resp = client.post("/api/stt/session?language=ko", content="v=0\r\noffer", headers={"Content-Type": "application/sdp"})
    assert resp.status_code == 200
    assert resp.text == "v=0\r\nanswer"
    assert resp.headers["content-type"].startswith("application/sdp")
    (call,) = fake_openai.calls
    assert call["url"] == stt.CALLS_URL
    assert call["headers"] == {"Authorization": "Bearer sk-test"}
    assert call["files"]["sdp"][1] == "v=0\r\noffer"
    session = json.loads(call["files"]["session"][1])
    assert session["type"] == "transcription"
    assert session["audio"]["input"]["transcription"] == {"model": "gpt-live-transcribe", "languages": ["ko"]}
    assert session["audio"]["input"]["turn_detection"] is None


def test_session_ignores_unknown_language(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    client.post("/api/stt/session?language=xx", content="v=0\r\noffer", headers={"Content-Type": "application/sdp"})
    session = json.loads(fake_openai.calls[0]["files"]["session"][1])
    assert "languages" not in session["audio"]["input"]["transcription"]


def test_session_errors(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "openai_api_key", None)
    assert client.post("/api/stt/session", content="v=0").status_code == 400
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    assert client.post("/api/stt/session", content="not sdp").status_code == 400
    fake_openai.response = _Resp(401, "bad key")
    resp = client.post("/api/stt/session", content="v=0\r\noffer")
    assert resp.status_code == 502
    assert "bad key" in resp.json()["detail"]


def test_soniox_key_is_not_offered_or_minted_when_unset(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "soniox_api_key", None)
    assert client.post("/api/stt/soniox/key").status_code == 400
    assert fake_openai.calls == []


def test_soniox_key_mints_a_temporary_websocket_key(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "soniox_api_key", "soniox-long-lived")
    fake_openai.response = _Resp(200, json.dumps({
        "api_key": "snx_temp_test",
        "expires_at": "2026-10-22T00:02:00Z",
        "usage_type": "transcribe_websocket",
        "secret": "soniox-long-lived",
    }))
    resp = client.post("/api/stt/soniox/key")
    assert resp.status_code == 200
    assert resp.json() == {"api_key": "snx_temp_test", "expires_at": "2026-10-22T00:02:00Z"}
    assert "soniox-long-lived" not in resp.text
    (call,) = fake_openai.calls
    assert call["url"] == stt.SONIOX_TEMP_KEY_URL
    assert call["headers"]["Authorization"] == "Bearer soniox-long-lived"
    assert call["json"] == {
        "usage_type": "transcribe_websocket",
        "expires_in_seconds": stt.SONIOX_EXPIRES_IN_SECONDS,
        "single_use": True,
        "max_session_duration_seconds": stt.SONIOX_MAX_SESSION_SECONDS,
    }
    assert call["json"]["expires_in_seconds"] <= 60
    assert call["json"]["max_session_duration_seconds"] >= 60 * 60


def test_soniox_key_hides_the_long_lived_key_on_upstream_errors(client, monkeypatch, fake_openai):
    monkeypatch.setattr(settings, "soniox_api_key", "soniox-long-lived")
    fake_openai.response = _Resp(401, "rejected soniox-long-lived")
    resp = client.post("/api/stt/soniox/key")
    assert resp.status_code == 502
    assert "soniox-long-lived" not in resp.text
    fake_openai.response = _Resp(200, "not-json")
    assert client.post("/api/stt/soniox/key").status_code == 502
    fake_openai.response = _Resp(200, json.dumps({"expires_at": "soon"}))
    assert client.post("/api/stt/soniox/key").status_code == 502

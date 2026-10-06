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


class _FakeClient:
    calls = []
    response = _Resp(201, "v=0\r\nanswer")

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, files=None):
        _FakeClient.calls.append({"url": url, "headers": headers, "files": files})
        return _FakeClient.response


@pytest.fixture
def fake_openai(monkeypatch):
    _FakeClient.calls = []
    _FakeClient.response = _Resp(201, "v=0\r\nanswer")
    monkeypatch.setattr(stt.httpx2, "AsyncClient", _FakeClient)
    return _FakeClient


def test_config_reports_availability(client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", None)
    assert client.get("/api/stt/config").json() == {"available": False, "model": "gpt-live-transcribe"}
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    assert client.get("/api/stt/config").json()["available"] is True


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

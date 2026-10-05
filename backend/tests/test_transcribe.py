import json

import pytest
from fastapi.testclient import TestClient

from app import storage, transcription
from app.config import settings
from app.main import app

SEGMENTS = [
    {"speaker": "A", "text": "Hello there.", "start": 0.0, "end": 1.5},
    {"speaker": "A", "text": "How are you?", "start": 1.6, "end": 3.0},
    {"speaker": "B", "text": "Fine, thanks.", "start": 3.2, "end": 4.8},
    {"speaker": "A", "text": "Great.", "start": 3605.0, "end": 3606.0},
]


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def client():
    return TestClient(app)


def _events(resp):
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


def test_to_markdown_merges_consecutive_segments_per_speaker():
    md = transcription.to_markdown(SEGMENTS, "Meeting", "ko")
    assert md.startswith("# Meeting\n")
    assert "화자 2명" in md
    assert "**A** `00:00` Hello there. How are you?" in md
    assert "**B** `00:03` Fine, thanks." in md
    assert "**A** `1:00:05` Great." in md


def test_transcribe_creates_document(isolated_data_dir, client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "fake")
    received = {}

    async def fake_transcribe(path, filename, language=None):
        received["bytes"] = path.read_bytes()
        received["language"] = language
        return SEGMENTS

    monkeypatch.setattr(transcription, "transcribe", fake_transcribe)
    pid = storage.create_project("p")["id"]
    cid = storage.create_conversation(pid, "c")["id"]

    resp = client.post(
        f"/api/projects/{pid}/conversations/{cid}/transcribe",
        files={"file": ("standup.m4a", b"fake-audio", "audio/mp4")},
        data={"language": "en", "audio_language": "ko"},
    )

    assert resp.status_code == 200
    events = _events(resp)
    assert events[0] == {"type": "status", "stage": "transcribing"}
    doc = events[-1]["document"]
    assert received["bytes"] == b"fake-audio"
    assert received["language"] == "ko"
    assert doc["content"].startswith("# standup\n")
    saved = {d["filename"]: d for d in storage.list_documents(pid, cid)}
    assert saved[doc["filename"]]["role"] == "draft"
    assert "**B**" in saved[doc["filename"]]["content"]


def test_transcribe_reports_api_errors_in_stream(isolated_data_dir, client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "fake")

    async def failing(path, filename, language=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(transcription, "transcribe", failing)
    pid = storage.create_project("p")["id"]
    cid = storage.create_conversation(pid, "c")["id"]
    resp = client.post(
        f"/api/projects/{pid}/conversations/{cid}/transcribe",
        files={"file": ("a.webm", b"x", "audio/webm")},
    )
    assert _events(resp)[-1] == {"type": "error", "message": "boom"}
    assert all(d["role"] == "system" for d in storage.list_documents(pid, cid))


def test_transcribe_requires_api_key(isolated_data_dir, client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", None)
    resp = client.post(
        "/api/projects/x/conversations/y/transcribe",
        files={"file": ("a.webm", b"x", "audio/webm")},
    )
    assert resp.status_code == 400
    assert client.get("/api/transcribe/config").json()["available"] is False

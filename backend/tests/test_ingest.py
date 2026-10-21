import io

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app

TOKEN = "s3cret"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "ingest_token", TOKEN)
    return TestClient(app)


def _post(client, name="talk.m4a", data=b"\x00\x00\x00\x18ftypM4A ", token=TOKEN, **form):
    return client.post(
        "/api/ingest/audio",
        headers={"Authorization": f"Bearer {token}"} if token else {},
        files={"file": (name, io.BytesIO(data), "audio/mp4")},
        data=form,
    )


def test_makes_project_date_folder_and_document_with_the_recording(client):
    res = _post(client, date="2026-10-20")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["filename"] == "talk.md"
    [project] = [p for p in storage.list_projects() if p["id"] == body["project_id"]]
    assert project["title"] == "youtube"
    [folder] = storage.list_conversations(body["project_id"])
    assert folder["title"] == "2026-10-20" and folder["parent_id"] is None
    docs = storage.list_documents(body["project_id"], body["conv_id"])
    doc = next(d for d in docs if d["filename"] == "talk.md")
    assert doc["content"] == ""
    [rec] = storage.list_recordings(body["project_id"], body["conv_id"], "talk.md")
    assert rec["id"].endswith(".m4a") and rec["size"] == 12
    assert body["url"].endswith(f"&file=talk.md")


def test_reuses_the_project_and_folder_and_numbers_a_taken_name(client):
    existing = storage.create_project("YouTube")
    first = _post(client, date="2026-10-20").json()
    second = _post(client, date="2026-10-20").json()
    assert first["project_id"] == second["project_id"] == existing["id"]
    assert first["conv_id"] == second["conv_id"]
    assert second["filename"] == "talk (2).md"


def test_needs_the_token(client):
    assert _post(client, token=None).status_code == 401
    assert _post(client, token="wrong").status_code == 401


def test_off_without_a_token_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "ingest_token", None)
    assert _post(client).status_code == 404


def test_rejects_other_types_and_empty_files(client):
    assert _post(client, name="talk.txt").status_code == 400
    assert _post(client, data=b"").status_code == 400
    folder_docs = [
        d
        for p in storage.list_projects()
        for c in storage.list_conversations(p["id"])
        for d in storage.list_documents(p["id"], c["id"])
        if d["filename"] != "system.md"
    ]
    assert folder_docs == []


def test_reachable_with_sign_in_on(client, monkeypatch):
    monkeypatch.setattr(settings, "app_passcode", "1234")
    assert client.get("/api/projects").status_code == 401
    assert _post(client, date="2026-10-20").status_code == 200

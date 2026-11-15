"""Uploading a finished audio file onto a document's recordings list.
The list may be empty; the file is a normal recording and, like ingest,
joins the YouTube queue unless enqueue says otherwise."""

import errno
import io

from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app

TOKEN = "worker-secret"


def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "worker_token", TOKEN)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    monkeypatch.setattr(settings, "app_passcode", None)
    return TestClient(app)


def _doc():
    pid = storage.create_project("Lectures")["id"]
    conv = storage.create_conversation(pid, "2026-10-18")["id"]
    filename = storage.create_draft(pid, conv)["filename"]
    return pid, conv, filename


def _upload(client, base, name, data, content_type, **form):
    return client.post(f"{base}/upload", files={"file": (name, io.BytesIO(data), content_type)}, data=form)


def test_upload_onto_an_empty_list_is_a_queued_recording(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    assert client.get(base).json() == []

    res = _upload(
        client, base, "lecture.wav", b"RIFFwav-bytes", "audio/wav", started="2026-10-18T19:30:12", duration_sec="12.5"
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"].startswith("20261018-193012-") and body["id"].endswith(".wav")
    assert body["size"] == len(b"RIFFwav-bytes")
    assert body["mime"] == "audio/wav"
    assert body["video"]["status"] == "queued" and body["video"]["attempt"] == 0

    listed = client.get(base).json()
    assert [item["id"] for item in listed] == [body["id"]]
    assert listed[0]["video"]["job_id"] == body["video"]["job_id"]
    assert [d["recordings"] for d in storage.list_documents(pid, conv) if d["filename"] == filename] == [1]

    jobs = client.get("/api/worker/jobs", headers={"Authorization": f"Bearer {TOKEN}"}).json()["jobs"]
    assert jobs[0]["recording_id"] == body["id"]
    assert jobs[0]["duration_sec"] == 12.5
    assert jobs[0]["filename"] == filename
    got = client.get(f"{base}/{body['id']}")
    assert got.content == b"RIFFwav-bytes" and got.headers["content-type"].startswith("audio/wav")


def test_a_second_upload_lands_on_a_list_that_already_has_one(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    first = _upload(client, base, "a.mp3", b"mp3-a", "audio/mpeg", started="2026-10-18T19:00:00")
    second = _upload(client, base, "b.m4a", b"m4a-b", "audio/mp4", started="2026-10-18T20:00:00")
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["mime"] == "audio/mpeg" and first.json()["id"].endswith(".mp3")
    ids = {item["id"] for item in client.get(base).json()}
    assert ids == {first.json()["id"], second.json()["id"]}
    assert len(client.get("/api/worker/jobs", headers={"Authorization": f"Bearer {TOKEN}"}).json()["jobs"]) == 2


def test_enqueue_false_keeps_it_off_the_queue(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    res = _upload(client, base, "talk.flac", b"fLaC", "audio/flac", enqueue="no")
    assert res.status_code == 200, res.text
    assert res.json()["video"] is None and res.json()["id"].endswith(".flac")
    assert client.get("/api/worker/jobs", headers={"Authorization": f"Bearer {TOKEN}"}).json()["jobs"] == []
    # .wave is the same container as .wav.
    wave = _upload(client, base, "talk.wave", b"RIFFmore", "audio/wav", enqueue="0")
    assert wave.status_code == 200 and wave.json()["id"].endswith(".wav")


def test_rejects_empty_and_unknown_types_without_keeping_them(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    assert _upload(client, base, "empty.mp3", b"", "audio/mpeg").status_code == 400
    bad = _upload(client, base, "notes.txt", b"hello", "text/plain")
    assert bad.status_code == 400 and "txt" in bad.json()["detail"]
    assert _upload(client, base, "talk.mp3", b"x", "audio/mpeg", started="not-a-date").status_code == 400
    assert client.get(base).json() == []


def test_disk_full_is_json_and_keeps_no_recording(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    real = storage._copy_into_recording

    def fail(path, src):
        class _Full:
            def read(self, n=-1):
                raise OSError(errno.ENOSPC, "No space left on device")

        return real(path, _Full())

    monkeypatch.setattr(storage, "_copy_into_recording", fail)
    res = _upload(client, base, "yatap.m4a", b"\x00\x00\x00\x18ftypM4A ", "audio/mp4")
    assert res.status_code == 507, res.text
    assert res.headers["content-type"].startswith("application/json")
    assert res.json()["detail"] == "Not enough disk space to store this recording"
    assert client.get(base).json() == []


def test_upload_needs_the_session_not_the_worker_token(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    pid, conv, filename = _doc()
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    monkeypatch.setattr(settings, "app_passcode", "1234")
    res = _upload(client, base, "talk.ogg", b"OggS", "audio/ogg")
    # The session cookie is what this route wants, and the worker token is not a substitute.
    denied = client.post(
        f"{base}/upload",
        headers={"Authorization": f"Bearer {TOKEN}"},
        files={"file": ("talk.ogg", io.BytesIO(b"OggS"), "audio/ogg")},
    )
    assert res.status_code == 401 and denied.status_code == 401
    assert client.get("/api/worker/jobs", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200

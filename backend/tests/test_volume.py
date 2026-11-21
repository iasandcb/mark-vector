"""Storage screen: disk usage, recording inventory, delete, and cleanup.

Uses a temp data directory. Never talks to the deployed app.
"""

import shutil
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import auth, storage, video_jobs, volume
from app.config import settings
from app.main import app


@pytest.fixture
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "storage_warn_percent", 80)
    return tmp_path


def _client():
    return TestClient(app)


def _doc(title="강의"):
    pid = storage.create_project(title)["id"]
    conv = storage.create_conversation(pid, "2026-10-18")["id"]
    filename = storage.create_draft(pid, conv)["filename"]
    storage.save_document(pid, conv, filename, "본문 유지")
    return pid, conv, filename


def _recording(pid, conv, filename, started, payload=b"audio-bytes"):
    rec = storage.create_recording(pid, conv, filename, "webm", started)
    storage.append_recording(pid, conv, filename, rec["id"], 0, payload)
    return rec["id"]


def _play(pid, conv, filename, recording_id, payload=b"play-copy"):
    _src, dest = storage.playable_recording_paths(pid, conv, filename, recording_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(payload)
    return dest


def _succeed(pid, conv, filename, recording_id, youtube_id="abcdefghijk"):
    video_jobs.set_enqueued(pid, conv, filename, recording_id, True, 3)
    job = video_jobs.claim("tester", 60)
    assert job["recording_id"] == recording_id
    video_jobs.complete(job["id"], job["claim_token"], youtube_id)
    return youtube_id


def _ref(pid, conv, filename, recording_id):
    return {"project_id": pid, "conv_id": conv, "filename": filename, "recording_id": recording_id}


def test_usage_is_disk_usage_of_the_data_root(data, monkeypatch):
    seen = {}

    def fake(path):
        seen["path"] = path
        return shutil._ntuple_diskusage(1000, 800, 50)

    monkeypatch.setattr(volume.shutil, "disk_usage", fake)
    body = _client().get("/api/storage").json()
    assert seen["path"] == data
    assert body["total_bytes"] == 1000
    assert body["used_bytes"] == 800
    assert body["free_bytes"] == 50
    assert body["percent_used"] == 80.0
    assert body["threshold_percent"] == 80
    assert body["warning"] is True

    monkeypatch.setattr(settings, "storage_warn_percent", 90)
    quiet = _client().get("/api/storage").json()
    assert quiet["warning"] is False
    assert quiet["threshold_percent"] == 90
    assert quiet["used_bytes"] == 800


def test_usage_matches_the_real_filesystem(data):
    body = _client().get("/api/storage").json()
    raw = shutil.disk_usage(data)
    assert (body["total_bytes"], body["used_bytes"], body["free_bytes"]) == (raw.total, raw.used, raw.free)
    assert 0 <= body["percent_used"] <= 100


def test_warn_percent_rejects_bad_env(monkeypatch):
    monkeypatch.setenv("STORAGE_WARN_PERCENT", "70")
    assert volume_loader() == 70
    monkeypatch.setenv("STORAGE_WARN_PERCENT", "80.5")
    assert volume_loader() == 80.5
    for raw in ("", "nope", "-1", "101", "nan", "inf"):
        monkeypatch.setenv("STORAGE_WARN_PERCENT", raw)
        assert volume_loader() == 80.0


def volume_loader():
    from app.config import _load_storage_warn_percent

    return _load_storage_warn_percent()


def test_lists_size_date_project_youtube_and_play_copies(data):
    pid, conv, filename = _doc("음성 프로젝트")
    rid = _recording(pid, conv, filename, datetime(2026, 10, 18, 19, 30, 12), b"12345")
    play = _play(pid, conv, filename, rid, b"mono")
    loose = play.parent / "orphan.mono.m4a"
    loose.write_bytes(b"xyz")
    _succeed(pid, conv, filename, rid, "abcdefghijk")

    other_pid, other_conv, other_file = _doc("다른 프로젝트")
    queued = _recording(other_pid, other_conv, other_file, datetime(2026, 10, 19, 9, 0, 0), b"queued!")
    video_jobs.set_enqueued(other_pid, other_conv, other_file, queued, True, 1)

    body = _client().get("/api/storage/recordings").json()
    rows = {row["recording_id"]: row for row in body["recordings"]}
    assert set(rows) == {rid, queued}
    done = rows[rid]
    assert done["size"] == 5
    assert done["date"].startswith("2026-10-18T10:30:12")
    assert done["project_id"] == pid
    assert done["project_title"] == "음성 프로젝트"
    assert done["conv_id"] == conv
    assert done["folder_title"] == "2026-10-18"
    assert done["filename"] == filename
    assert done["youtube_uploaded"] is True
    assert done["youtube_video_id"] == "abcdefghijk"
    assert done["video_status"] == "succeeded"
    assert done["play_copies"] == [
        {
            "project_id": pid,
            "project_title": "음성 프로젝트",
            "conv_id": conv,
            "folder_title": "2026-10-18",
            "filename": filename,
            "name": play.name,
            "size": 4,
            "recording_id": rid,
        }
    ]
    waiting = rows[queued]
    assert waiting["youtube_uploaded"] is False
    assert waiting["youtube_video_id"] is None
    assert waiting["video_status"] == "queued"
    assert waiting["project_title"] == "다른 프로젝트"
    assert body["loose_play_copies"][0]["name"] == "orphan.mono.m4a"
    assert body["loose_play_copies"][0]["size"] == 3
    assert "secret" not in str(body)
    assert "/" not in done["recording_id"]


def test_delete_removes_original_and_play_copy_and_keeps_the_document(data):
    pid, conv, filename = _doc()
    keep_id = _recording(pid, conv, filename, datetime(2026, 10, 18, 19, 30, 12), b"keep-me!!")
    keep_play = _play(pid, conv, filename, keep_id, b"keep-play")
    drop_id = _recording(pid, conv, filename, datetime(2026, 10, 18, 20, 0, 0), b"drop-me")
    drop_play = _play(pid, conv, filename, drop_id, b"drop-play")
    _succeed(pid, conv, filename, drop_id)
    video_jobs.set_enqueued(pid, conv, filename, keep_id, True, 2)
    sibling = storage.create_draft(pid, conv)["filename"]
    storage.save_document(pid, conv, sibling, f"see [{filename}]({filename})")

    outside = data / "outside.bin"
    outside.write_bytes(b"do-not-touch")
    res = _client().request(
        "DELETE",
        "/api/storage/recordings",
        json={"recordings": [_ref(pid, conv, filename, drop_id)]},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["deleted"] == 1
    assert body["freed_bytes"] == len(b"drop-me") + len(b"drop-play")
    assert body["usage"]["total_bytes"] > 0
    assert not drop_play.exists() and not (drop_play.parent.parent / drop_id).exists()
    assert keep_play.read_bytes() == b"keep-play"
    assert storage.list_recordings(pid, conv, filename)[0]["id"] == keep_id
    assert storage.get_document(pid, conv, filename)["content"] == "본문 유지"
    assert filename in storage.get_document(pid, conv, sibling)["content"]
    assert [d["recordings"] for d in storage.list_documents(pid, conv) if d["filename"] == filename] == [1]
    assert video_jobs.videos_for_document(pid, conv, filename)[keep_id]["status"] == "queued"
    assert drop_id not in video_jobs.videos_for_document(pid, conv, filename)
    assert outside.read_bytes() == b"do-not-touch"
    assert storage.list_conversations(pid)


def test_path_traversal_deletes_nothing(data):
    pid, conv, filename = _doc()
    rid = _recording(pid, conv, filename, datetime(2026, 10, 18, 19, 30, 12), b"safe-audio")
    outside = data / "secret.bin"
    outside.write_bytes(b"secret-bytes")
    client = _client()
    attacks = [
        _ref(pid, conv, "../../secret.bin", rid),
        _ref("../" + pid, conv, filename, rid),
        _ref(pid, "..", filename, rid),
        _ref(pid, conv, filename, "../secret.bin"),
        _ref(pid, conv, filename, "20261018-193012-abcd.webm/../../secret.bin"),
    ]
    for item in attacks:
        res = client.request("DELETE", "/api/storage/recordings", json={"recordings": [item, _ref(pid, conv, filename, rid)]})
        assert res.status_code == 400, item
        assert outside.read_bytes() == b"secret-bytes"
        assert storage.list_recordings(pid, conv, filename)[0]["id"] == rid


def test_symlink_outside_the_recordings_tree_is_not_followed(data):
    pid, conv, filename = _doc()
    rid = _recording(pid, conv, filename, datetime(2026, 10, 18, 19, 30, 12), b"real-audio")
    outside_dir = data.parent / "outside-volume"
    outside_dir.mkdir()
    secret = outside_dir / "secret.bin"
    secret.write_bytes(b"secret-bytes")
    _src, play = storage.playable_recording_paths(pid, conv, filename, rid)
    play.parent.mkdir(parents=True, exist_ok=True)
    linked = play.parent / f"{rid}.mono.m4a"
    linked.symlink_to(secret)

    res = _client().request("DELETE", "/api/storage/recordings", json={"recordings": [_ref(pid, conv, filename, rid)]})
    assert res.status_code == 200
    assert secret.read_bytes() == b"secret-bytes"
    assert not linked.exists()

    # A project directory that is a symlink to somewhere else is not a
    # recordings folder, even if the link target contains a matching name.
    planted = outside_dir / "conversations" / "conv1234abcd" / ".recordings" / "note.md"
    planted.mkdir(parents=True)
    planted_id = "20261018-193012-ab12.webm"
    (planted / planted_id).write_bytes(b"not-ours")
    (data / "projects" / "evilproj1234").symlink_to(outside_dir)
    escaped = _client().request(
        "DELETE",
        "/api/storage/recordings",
        json={"recordings": [_ref("evilproj1234", "conv1234abcd", "note.md", planted_id)]},
    )
    assert escaped.status_code == 400
    assert (planted / planted_id).read_bytes() == b"not-ours"
    assert secret.read_bytes() == b"secret-bytes"

    play_link = data / "projects"
    # .play itself pointing outside must not be walked.
    pid2, conv2, filename2 = _doc("둘")
    rid2 = _recording(pid2, conv2, filename2, datetime(2026, 10, 20, 8, 0, 0), b"second")
    _succeed(pid2, conv2, filename2, rid2, "zzzzzzzzzzz")
    folder = storage._recordings_dir(storage._conversations_dir(pid2) / conv2, filename2)
    # _recordings_dir doesn't mkdir; the recording call did.
    assert folder.is_dir()
    escaped_play = folder / storage.PLAYABLE_DIRNAME
    escaped_play.symlink_to(outside_dir)
    preview = _client().post("/api/storage/cleanup/preview").json()
    assert all(item["name"] != "secret.bin" for item in preview["play_copies"])
    applied = _client().post("/api/storage/cleanup").json()
    assert secret.read_bytes() == b"secret-bytes"
    assert escaped_play.is_symlink()
    assert applied["freed_bytes"] >= len(b"second")
    assert not (folder / rid2).exists()
    assert play_link.is_dir()


def test_cleanup_preview_does_not_delete_and_apply_keeps_unfinished_originals(data):
    pid, conv, filename = _doc()
    done = _recording(pid, conv, filename, datetime(2026, 10, 18, 19, 30, 12), b"uploaded-audio")
    done_play = _play(pid, conv, filename, done, b"done-play")
    _succeed(pid, conv, filename, done, "abcdefghijk")
    waiting = _recording(pid, conv, filename, datetime(2026, 10, 19, 9, 0, 0), b"still-needed")
    waiting_play = _play(pid, conv, filename, waiting, b"wait-play")
    video_jobs.set_enqueued(pid, conv, filename, waiting, True, 4)
    storage.save_document(pid, conv, filename, "본문 유지")

    client = _client()
    preview = client.post("/api/storage/cleanup/preview")
    assert preview.status_code == 200
    body = preview.json()
    assert [row["recording_id"] for row in body["originals"]] == [done]
    play_names = {item["name"] for item in body["play_copies"]}
    assert play_names == {done_play.name, waiting_play.name}
    assert body["freed_bytes"] == len(b"uploaded-audio") + len(b"done-play") + len(b"wait-play")
    assert done_play.read_bytes() == b"done-play"
    assert (done_play.parent.parent / done).is_file()
    assert waiting_play.read_bytes() == b"wait-play"

    applied = client.post("/api/storage/cleanup")
    assert applied.status_code == 200
    assert applied.json()["freed_bytes"] == body["freed_bytes"]
    assert not done_play.exists()
    assert not (waiting_play.parent.parent / done).exists()
    assert not waiting_play.exists()
    assert storage.list_recordings(pid, conv, filename)[0]["id"] == waiting
    assert video_jobs.videos_for_document(pid, conv, filename)[waiting]["status"] == "queued"
    assert done not in video_jobs.videos_for_document(pid, conv, filename)
    assert storage.get_document(pid, conv, filename)["content"] == "본문 유지"
    again = client.post("/api/storage/cleanup/preview").json()
    assert again["originals"] == []
    assert again["play_copies"] == []
    assert again["freed_bytes"] == 0


def test_empty_selection_is_rejected(data):
    res = _client().request("DELETE", "/api/storage/recordings", json={"recordings": []})
    assert res.status_code == 400


def test_storage_routes_use_session_auth(data, monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", "test-client-id")
    monkeypatch.setattr(settings, "google_client_secret", "test-client-secret")
    client = _client()
    assert client.get("/api/storage").status_code == 401
    assert client.get("/api/storage/recordings").status_code == 401
    assert client.request("DELETE", "/api/storage/recordings", json={"recordings": []}).status_code == 401
    assert client.post("/api/storage/cleanup/preview").status_code == 401
    assert client.post("/api/storage/cleanup").status_code == 401
    assert client.get("/api/storage", headers={"Authorization": "Bearer not-a-session"}).status_code == 401
    session = auth._sign_session({"email": "iasandcb@gmail.com", "exp": time.time() + 3600})
    client.cookies.set(auth.SESSION_COOKIE, session)
    assert client.get("/api/storage").status_code == 200

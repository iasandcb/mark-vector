import io
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app
from app.routers import ingest

TOKEN = "s3cret"
# 07:45:12 UTC is 16:45:12 in Asia/Seoul (and in the +9 fallback).
_UTC = datetime(2026, 11, 14, 7, 45, 12, tzinfo=timezone.utc)


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


def _install_clock(monkeypatch):
    """`_now_local` asks datetime.now for INGEST_TIMEZONE's wall clock."""

    class _Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return _UTC.replace(tzinfo=None)
            return _UTC.astimezone(tz)

    monkeypatch.setattr(ingest, "datetime", _Clock)


def _folder_title(body):
    return next(
        folder["title"]
        for folder in storage.list_conversations(body["project_id"])
        if folder["id"] == body["conv_id"]
    )


def _project_title(body):
    [project] = [p for p in storage.list_projects() if p["id"] == body["project_id"]]
    return project["title"]


def test_omitted_layout_still_uses_todays_dashed_folder_and_the_filename(client, monkeypatch):
    _install_clock(monkeypatch)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    res = _post(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert _project_title(body) == "youtube"
    assert _folder_title(body) == "2026-11-14"
    assert body["filename"] == "talk.md"
    assert body["video_job"]["status"] == "queued"
    assert body["recording"]["id"].startswith("20261114-164512-")


def test_stamp_layout_uses_yyyymmdd_and_hhmmss_in_ingest_timezone(client, monkeypatch):
    _install_clock(monkeypatch)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    res = _post(client, name="memo.m4a", layout=" Stamp ")
    assert res.status_code == 200, res.text
    body = res.json()
    assert _project_title(body) == "youtube"
    assert _folder_title(body) == "20261114"
    assert body["filename"] == "164512.md"
    assert body["video_job"]["status"] == "queued"
    assert body["recording"]["id"].startswith("20261114-164512-")

    monkeypatch.setattr(settings, "ingest_timezone", "UTC")
    utc = _post(client, layout="stamp").json()
    assert utc["project_id"] == body["project_id"] and utc["conv_id"] == body["conv_id"]
    assert utc["filename"] == "074512.md"

    monkeypatch.setattr(settings, "ingest_timezone", "Not/AZone")
    fallback = _post(client, layout="stamp").json()
    assert _folder_title(fallback) == "20261114"
    assert fallback["filename"] == "164512 (2).md"
    assert fallback["conv_id"] == body["conv_id"]


def test_explicit_project_folder_and_title_win_over_stamp(client, monkeypatch):
    _install_clock(monkeypatch)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    res = _post(
        client,
        layout="stamp",
        project="Voice",
        folder="inbox",
        title="memo",
        date="2026-10-20",
        enqueue="false",
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert _project_title(body) == "Voice"
    assert _folder_title(body) == "inbox"
    assert body["filename"] == "memo.md"
    assert body["video_job"] is None


def test_stamp_keeps_an_explicit_date_when_folder_is_omitted(client, monkeypatch):
    _install_clock(monkeypatch)
    res = _post(client, layout="stamp", date="2026-10-20", project="  ")
    assert res.status_code == 200, res.text
    body = res.json()
    assert _project_title(body) == "youtube"
    assert _folder_title(body) == "2026-10-20"
    assert body["filename"] == "164512.md"


def test_folder_is_the_exact_name_and_beats_date(client):
    res = _post(client, folder=" 20261114 ", date="2026-10-20", title="164512")
    assert res.status_code == 200, res.text
    body = res.json()
    assert _folder_title(body) == "20261114"
    assert body["filename"] == "164512.md"
    spaced = _post(client, folder="음성 메모", title="하나")
    assert spaced.status_code == 200, spaced.text
    assert _folder_title(spaced.json()) == "음성 메모"
    assert spaced.json()["filename"] == "하나.md"


def test_blank_folder_and_title_are_the_same_as_omitting_them(client, monkeypatch):
    _install_clock(monkeypatch)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    plain = _post(client, folder="   ", title="   ")
    assert plain.status_code == 200, plain.text
    assert _folder_title(plain.json()) == "2026-11-14"
    assert plain.json()["filename"] == "talk.md"
    stamped = _post(client, folder="   ", title="   ", layout="stamp")
    assert _folder_title(stamped.json()) == "20261114"
    assert stamped.json()["filename"] == "164512.md"


@pytest.mark.parametrize(
    "folder",
    ["../etc", "a/b", "a\\b", "..", ".", "/tmp", "foo/../bar", " .. ", "x\ny", "n" * 256],
)
def test_folder_must_be_one_path_component(client, folder):
    res = _post(client, folder=folder, layout="stamp", title="memo")
    assert res.status_code == 400, folder
    assert res.json()["detail"] == "folder must be a single path component"
    assert not any(p["title"].strip().lower() == "youtube" for p in storage.list_projects())


def test_storage_rejects_a_folder_with_a_nul_before_creating_a_project(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    with pytest.raises(ValueError, match="single path component"):
        storage.ingest_audio(
            "youtube", "a\x00b", "memo", "m4a", io.BytesIO(b"abc"), datetime(2026, 11, 14, 16, 45, 12)
        )
    assert not any(p["title"].strip().lower() == "youtube" for p in storage.list_projects())


def test_unknown_layout_and_a_bad_date_are_rejected(client):
    bad_layout = _post(client, layout="daily")
    assert bad_layout.status_code == 400
    assert bad_layout.json()["detail"] == "layout must be stamp"
    bad_date = _post(client, layout="stamp", folder="20261114", date="14-11-2026")
    assert bad_date.status_code == 400
    assert bad_date.json()["detail"] == "date must be YYYY-MM-DD"
    assert not any(p["title"].strip().lower() == "youtube" for p in storage.list_projects())

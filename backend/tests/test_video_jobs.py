"""The YouTube worker queue: who gets in, the lease, and the contract a
second machine polls. Existing recordings stay out until opted in."""

import io
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import storage, video_jobs
from app.config import settings
from app.main import app

TOKEN = "worker-secret"
INGEST = "ingest-secret"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "worker_token", TOKEN)
    monkeypatch.setattr(settings, "ingest_token", INGEST)
    monkeypatch.setattr(settings, "ingest_timezone", "Asia/Seoul")
    monkeypatch.setattr(settings, "app_passcode", None)
    return TestClient(app)


def _auth(token=TOKEN):
    return {"Authorization": f"Bearer {token}"}


def _doc(client):
    pid = storage.create_project("Lectures")["id"]
    conv = storage.create_conversation(pid, "2026-10-18")["id"]
    filename = storage.create_draft(pid, conv)["filename"]
    return pid, conv, filename


def _recording(client, pid, conv, filename, started="2026-10-18T19:30:12", body=b"audio-bytes", ext="m4a"):
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    rec = client.post(base, json={"ext": ext, "started": started})
    assert rec.status_code == 200, rec.text
    rid = rec.json()["id"]
    put = client.put(f"{base}/{rid}?offset=0", content=body)
    assert put.status_code == 200, put.text
    return rid, base


def _enqueue(client, base, rid, **body):
    res = client.put(f"{base}/{rid}/video", json={"enqueue": True, **body})
    assert res.status_code == 200, res.text
    return res.json()["video"]


def _waiting(client, **params):
    res = client.get("/api/worker/jobs", headers=_auth(), params=params)
    assert res.status_code == 200, res.text
    return res.json()["jobs"]


def test_a_recording_is_not_queued_until_someone_opts_in(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    assert _waiting(client) == []
    listed = client.get(base).json()
    assert listed[0]["id"] == rid and listed[0]["video"] is None

    video = _enqueue(client, base, rid, duration_sec=95.25)
    assert video["status"] == "queued" and video["attempt"] == 0
    [job] = _waiting(client)
    assert job["id"] == video["job_id"]
    assert job["title"] == filename.removesuffix(".md")
    assert job["filename"] == filename
    assert job["recording_id"] == rid
    assert job["duration_sec"] == 95.25
    assert job["created_at"] == "2026-10-18T10:30:12+00:00"  # 19:30 in Asia/Seoul
    assert job["project_title"] == "Lectures"
    assert job["folder_title"] == "2026-10-18"
    assert job["mime"] == "audio/mp4"
    assert job["result"] is None and job["error"] is None
    assert "claim_token" not in job
    assert job["audio_url"] == f"/api/worker/jobs/{job['id']}/audio"

    again = _enqueue(client, base, rid, duration_sec=10)
    assert again["job_id"] == video["job_id"] and again["status"] == "queued"
    assert _waiting(client)[0]["duration_sec"] == 10


def test_opt_out_and_back_in(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    _enqueue(client, base, rid)
    out = client.put(f"{base}/{rid}/video", json={"enqueue": False})
    assert out.status_code == 200 and out.json()["video"]["status"] == "cancelled"
    assert _waiting(client) == []
    # Opting out of something already out, and of a recording that was never
    # queued, are both quiet.
    assert client.put(f"{base}/{rid}/video", json={"enqueue": False}).json()["video"]["status"] == "cancelled"
    other, other_base = _recording(client, pid, conv, filename, started="2026-10-18T20:00:00")
    assert client.put(f"{other_base}/{other}/video", json={"enqueue": False}).json() == {"video": None}
    back = _enqueue(client, base, rid)
    assert back["status"] == "queued"
    assert [job["recording_id"] for job in _waiting(client)] == [rid]


def test_empty_recording_is_refused(client):
    pid, conv, filename = _doc(client)
    base = f"/api/projects/{pid}/conversations/{conv}/documents/{filename}/recordings"
    rid = client.post(base, json={"ext": "m4a", "started": "2026-10-18T19:30:12"}).json()["id"]
    res = client.put(f"{base}/{rid}/video", json={"enqueue": True})
    assert res.status_code == 400
    assert _waiting(client) == []


def test_list_order_limit_and_status(client):
    pid, conv, filename = _doc(client)
    early, base = _recording(client, pid, conv, filename, started="2026-10-18T19:30:12")
    late, _ = _recording(client, pid, conv, filename, started="2026-10-18T21:00:00")
    _enqueue(client, base, early)
    _enqueue(client, base, late)
    assert [j["recording_id"] for j in _waiting(client)] == [early, late]
    assert [j["recording_id"] for j in _waiting(client, order="newest")] == [late, early]
    assert [j["recording_id"] for j in _waiting(client, order="oldest", limit=1)] == [early]
    assert client.get("/api/worker/jobs", headers=_auth(), params={"order": "sideways"}).status_code == 400
    assert client.get("/api/worker/jobs", headers=_auth(), params={"status": "nope"}).status_code == 400


def test_claim_is_exclusive_and_the_token_gates_the_audio(client):
    pid, conv, filename = _doc(client)
    first, base = _recording(client, pid, conv, filename, body=b"one-audio")
    second, _ = _recording(client, pid, conv, filename, started="2026-10-18T21:00:00", body=b"two-audio")
    _enqueue(client, base, first)
    _enqueue(client, base, second)

    claim = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook", "lease_seconds": 60})
    assert claim.status_code == 200, claim.text
    job = claim.json()["job"]
    assert job["recording_id"] == first
    assert job["status"] == "claimed" and job["attempt"] == 1 and job["worker_id"] == "macbook"
    token = job["claim_token"]
    assert token and "claim_token" not in client.get(f"/api/worker/jobs/{job['id']}", headers=_auth()).json()

    other = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "other-mac"}).json()["job"]
    assert other["recording_id"] == second and other["claim_token"] != token
    assert client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "third"}).json() == {"job": None}

    audio = client.get(job["audio_url"], headers={**_auth(), "X-Claim-Token": token})
    assert audio.status_code == 200 and audio.content == b"one-audio"
    assert audio.headers["content-type"].startswith("audio/mp4")
    assert first in audio.headers["content-disposition"]
    assert client.get(job["audio_url"], headers=_auth()).status_code == 409
    assert client.get(job["audio_url"], headers={**_auth(), "X-Claim-Token": other["claim_token"]}).status_code == 409

    # The signed-in user cannot pull a job out from under the worker.
    refused = client.put(f"{base}/{first}/video", json={"enqueue": False})
    assert refused.status_code == 409


def test_two_workers_cannot_claim_the_same_job(client):
    pid, conv, filename = _doc(client)
    base = None
    for stamp, body in (("2026-10-18T19:30:12", b"a"), ("2026-10-18T21:00:00", b"b")):
        rid, base = _recording(client, pid, conv, filename, started=stamp, body=body)
        _enqueue(client, base, rid)
    barrier = threading.Barrier(6)
    found = []
    lock = threading.Lock()

    def go(name):
        barrier.wait()
        job = video_jobs.claim(name, 60)
        with lock:
            found.append(None if job is None else job["id"])

    threads = [threading.Thread(target=go, args=(f"w{i}",)) for i in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    claimed = [job_id for job_id in found if job_id]
    assert len(claimed) == 2 and len(set(claimed)) == 2
    assert found.count(None) == 4


def test_a_lease_expires_and_progress_renews_it(client, monkeypatch):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    _enqueue(client, base, rid)
    clock = {"t": datetime(2026, 10, 21, 1, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(video_jobs, "_now", lambda: clock["t"])

    job = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook", "lease_seconds": 60}).json()["job"]
    token = job["claim_token"]
    assert job["lease_expires_at"] == "2026-10-21T01:01:00+00:00"

    clock["t"] += timedelta(seconds=50)
    progress = client.post(
        f"/api/worker/jobs/{job['id']}/progress",
        headers=_auth(),
        json={"claim_token": token, "message": "transcribing", "percent": 40},
    )
    assert progress.status_code == 200, progress.text
    body = progress.json()
    assert body["progress"] == {"message": "transcribing", "percent": 40}
    assert body["lease_expires_at"] == "2026-10-21T01:01:50+00:00"  # 01:00:50 + 60s
    assert body["status"] == "claimed"
    # What the recordings dialog shows while the Mac is working.
    shown = client.get(base).json()[0]["video"]
    assert shown["status"] == "claimed" and shown["progress"]["percent"] == 40

    clock["t"] = datetime(2026, 10, 21, 1, 1, 40, tzinfo=timezone.utc)  # still inside the renewed lease
    assert client.get(f"/api/worker/jobs/{job['id']}", headers=_auth()).json()["status"] == "claimed"

    clock["t"] = datetime(2026, 10, 21, 1, 1, 51, tzinfo=timezone.utc)
    assert client.post(
        f"/api/worker/jobs/{job['id']}/progress",
        headers=_auth(),
        json={"claim_token": token, "message": "too late"},
    ).status_code == 409
    assert client.get(base).json()[0]["video"]["status"] == "queued"
    again = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "other-mac", "lease_seconds": 60}).json()["job"]
    assert again["id"] == job["id"] and again["attempt"] == 2 and again["worker_id"] == "other-mac"
    assert again["claim_token"] != token


def test_success_failure_and_retry(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename, body=b"lecture")
    _enqueue(client, base, rid)
    job = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    bad = client.post(
        f"/api/worker/jobs/{job['id']}/complete",
        headers=_auth(),
        json={"claim_token": "nope", "youtube_video_id": "abcdefghijk"},
    )
    assert bad.status_code == 409

    done = client.post(
        f"/api/worker/jobs/{job['id']}/complete",
        headers=_auth(),
        json={"claim_token": job["claim_token"], "youtube_video_id": "abcdefghijk", "transcript": "고친 내용"},
    )
    assert done.status_code == 200, done.text
    result = done.json()["result"]
    assert result["youtube_video_id"] == "abcdefghijk"
    assert result["youtube_url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert result["transcript"] == "고친 내용"
    assert done.json()["status"] == "succeeded"
    assert _waiting(client) == []
    shown = client.get(base).json()[0]["video"]
    assert shown["youtube_url"] == result["youtube_url"] and shown["transcript"] == "고친 내용"
    # Already published: opting in does not queue it again, opting out is refused.
    assert _enqueue(client, base, rid)["status"] == "succeeded"
    assert client.put(f"{base}/{rid}/video", json={"enqueue": False}).status_code == 409
    assert client.post(f"/api/worker/jobs/{job['id']}/retry", headers=_auth()).status_code == 409

    rid2, _ = _recording(client, pid, conv, filename, started="2026-10-18T21:00:00")
    _enqueue(client, base, rid2)
    job2 = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    failed = client.post(
        f"/api/worker/jobs/{job2['id']}/fail",
        headers=_auth(),
        json={"claim_token": job2["claim_token"], "error": "scripter crashed"},
    )
    assert failed.status_code == 200 and failed.json()["status"] == "failed"
    assert failed.json()["error"] == "scripter crashed"
    assert _waiting(client) == []
    assert _waiting(client, status="failed")[0]["id"] == job2["id"]
    # A failed job is not claimed again until someone retries it.
    assert client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"] is None

    retried = client.post(f"/api/worker/jobs/{job2['id']}/retry", headers=_auth())
    assert retried.status_code == 200 and retried.json()["status"] == "queued"
    assert retried.json()["error"] is None and retried.json()["attempt"] == 1
    assert [j["id"] for j in _waiting(client)] == [job2["id"]]

    # The dialog's Retry is the same opt-in, and it works from failed too.
    claimed = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    client.post(
        f"/api/worker/jobs/{claimed['id']}/fail",
        headers=_auth(),
        json={"claim_token": claimed["claim_token"], "error": "again"},
    )
    assert _enqueue(client, base, rid2)["status"] == "queued"
    custom = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    res = client.post(
        f"/api/worker/jobs/{custom['id']}/complete",
        headers=_auth(),
        json={
            "claim_token": custom["claim_token"],
            "youtube_video_id": "zzzzzzzzzzz",
            "youtube_url": "https://youtu.be/zzzzzzzzzzz",
            "transcript": "   ",
        },
    )
    assert res.json()["result"]["youtube_url"] == "https://youtu.be/zzzzzzzzzzz"
    assert res.json()["result"]["transcript"] is None


def test_bad_results_are_rejected(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    _enqueue(client, base, rid)
    job = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook", "lease_seconds": 30}).json()["job"]
    url = f"/api/worker/jobs/{job['id']}"
    assert client.post(f"{url}/complete", headers=_auth(), json={"claim_token": job["claim_token"], "youtube_video_id": "no"}).status_code == 400
    assert client.post(
        f"{url}/complete",
        headers=_auth(),
        json={"claim_token": job["claim_token"], "youtube_video_id": "abcdefghijk", "youtube_url": "javascript:alert(1)"},
    ).status_code == 400
    assert client.post(f"{url}/fail", headers=_auth(), json={"claim_token": job["claim_token"], "error": "  "}).status_code == 400
    assert client.post(f"{url}/progress", headers=_auth(), json={"claim_token": job["claim_token"]}).status_code == 400
    assert client.post(f"{url}/progress", headers=_auth(), json={"claim_token": job["claim_token"], "percent": 101}).status_code == 400
    assert client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "  ", "lease_seconds": 60}).status_code == 400
    assert client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "mac", "lease_seconds": 10}).status_code == 400
    # The bad calls did not drop the claim.
    assert client.get(url, headers=_auth()).json()["status"] == "claimed"


def test_a_missing_file_does_not_block_the_queue(client):
    pid, conv, filename = _doc(client)
    gone, base = _recording(client, pid, conv, filename, body=b"gone")
    kept, _ = _recording(client, pid, conv, filename, started="2026-10-18T21:00:00", body=b"kept")
    first = _enqueue(client, base, gone)
    _enqueue(client, base, kept)
    path, _mime = storage.recording_file(pid, conv, filename, gone)
    path.unlink()
    job = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    assert job["recording_id"] == kept
    failed = client.get(f"/api/worker/jobs/{first['job_id']}", headers=_auth()).json()
    assert failed["status"] == "failed" and "missing" in failed["error"].lower()
    assert client.post(f"/api/worker/jobs/{first['job_id']}/retry", headers=_auth()).status_code == 409


def test_rename_move_and_delete_follow_the_job(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename, body=b"moved-audio")
    video = _enqueue(client, base, rid)
    storage.rename_document(pid, conv, filename, "lecture.md")
    job = client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).json()["job"]
    assert job["id"] == video["job_id"] and job["filename"] == "lecture.md" and job["title"] == "lecture"
    audio = client.get(job["audio_url"], headers={**_auth(), "X-Claim-Token": job["claim_token"]})
    assert audio.content == b"moved-audio"

    client.post(
        f"/api/worker/jobs/{job['id']}/fail",
        headers=_auth(),
        json={"claim_token": job["claim_token"], "error": "pause"},
    )
    client.post(f"/api/worker/jobs/{job['id']}/retry", headers=_auth())
    other = storage.create_conversation(pid, "elsewhere")["id"]
    storage.move_document(pid, conv, "lecture.md", other)
    moved = client.get(f"/api/worker/jobs/{job['id']}", headers=_auth()).json()
    assert moved["conv_id"] == other and moved["filename"] == "lecture.md"
    storage.delete_recording(pid, other, "lecture.md", rid)
    assert client.get(f"/api/worker/jobs/{job['id']}", headers=_auth()).status_code == 404
    assert _waiting(client) == []


def test_deleting_the_folder_drops_its_jobs(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    _enqueue(client, base, rid)
    storage.delete_conversation(pid, conv)
    assert _waiting(client) == []


def test_deleting_a_project_drops_its_jobs(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    _enqueue(client, base, rid)
    storage.delete_project(pid)
    assert _waiting(client) == []


def test_ingest_queues_unless_told_not_to(client):
    def post(**form):
        return client.post(
            "/api/ingest/audio",
            headers={"Authorization": f"Bearer {INGEST}"},
            files={"file": ("talk.m4a", io.BytesIO(b"\x00\x00ftyp"), "audio/mp4")},
            data={"date": "2026-10-20", **form},
        )

    first = post()
    assert first.status_code == 200, first.text
    assert first.json()["video_job"]["status"] == "queued"
    assert len(_waiting(client)) == 1
    second = post(enqueue="false")
    assert second.status_code == 200 and second.json()["video_job"] is None
    assert len(_waiting(client)) == 1
    third = post(enqueue="no")
    assert third.json()["video_job"] is None


def test_worker_token_is_its_own_secret(client, monkeypatch):
    assert client.get("/api/worker/jobs").status_code == 401
    assert client.get("/api/worker/jobs", headers=_auth("nope")).status_code == 401
    assert client.get("/api/worker/jobs", headers=_auth(INGEST)).status_code == 401
    assert client.post("/api/ingest/audio", headers=_auth(TOKEN), files={"file": ("t.m4a", io.BytesIO(b"x"), "audio/mp4")}).status_code == 401

    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    monkeypatch.setattr(settings, "app_passcode", "1234")
    assert client.get("/api/projects").status_code == 401
    # The worker API stays open with its own token when sign-in is on.
    # That token does not authorize the owner's opt-in, which wants a session.
    assert client.get("/api/worker/jobs", headers=_auth()).status_code == 200
    assert client.put(f"{base}/{rid}/video", json={"enqueue": True}, headers=_auth()).status_code == 401

    monkeypatch.setattr(settings, "worker_token", None)
    assert client.get("/api/worker/jobs", headers=_auth()).status_code == 404
    assert client.post("/api/worker/jobs/claim", headers=_auth(), json={"worker_id": "macbook"}).status_code == 404


def test_worker_routes_with_auth_off_still_need_the_token(client):
    pid, conv, filename = _doc(client)
    rid, base = _recording(client, pid, conv, filename)
    # Auth is off in this fixture, so the owner's opt-in works with no cookie.
    assert client.put(f"{base}/{rid}/video", json={"enqueue": True}).status_code == 200

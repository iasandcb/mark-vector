"""A pull queue of recordings waiting to become YouTube videos.

The worker (scripter on a Mac that may be asleep) polls this queue. Nothing
here ever calls out. State lives in ``DATA_DIR/video-jobs.json``, the same
flat JSON registry as ``published.json``, guarded by a lock file so two
workers cannot claim the same recording.

A recording is not in the queue until something opts it in: the app does
that when a dictation upload finishes, ``POST /api/ingest/audio`` does it
unless told not to, and the signed-in user can do it for any recording
(including ones that already existed). Opting out cancels a job that has
not been claimed and has not already succeeded.
"""

import fcntl
import hmac
import json
import math
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import storage
from .config import settings

JOBS_FILENAME = "video-jobs.json"
LOCK_FILENAME = "video-jobs.lock"

LEASE_DEFAULT = 3600
LEASE_MIN = 30
LEASE_MAX = 24 * 3600
DURATION_MAX = 48 * 3600
TRANSCRIPT_MAX = 2_000_000
ERROR_MAX = 4000
MESSAGE_MAX = 500
WORKER_ID_MAX = 64

STATUSES = ("queued", "claimed", "succeeded", "failed", "cancelled")
# What GET /api/worker/jobs?status= accepts besides the statuses themselves.
LIST_STATUSES = ("waiting", *STATUSES, "all")

_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_STARTED_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})")
_URL_RE = re.compile(r"^https?://\S{1,480}$")

_thread_lock = threading.Lock()


def wants_queue(raw: str | None) -> bool:
    """Form field `enqueue`. Absent, or anything but an explicit no, means
    the recording joins the YouTube queue. Shared by ingest and the
    recordings-list upload."""
    return (raw or "").strip().lower() not in {"0", "false", "no", "off"}


class VideoJobError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _zone():
    try:
        return ZoneInfo(settings.ingest_timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone(timedelta(hours=9))


def _jobs_path() -> Path:
    return Path(settings.data_dir) / JOBS_FILENAME


def recording_created_at(recording_id: str) -> str:
    """The clock embedded in a recording id (the speaker's local time),
    read in INGEST_TIMEZONE and stored as UTC. That clock has no zone of
    its own; the ingest zone is the app's single notion of local time."""
    match = _STARTED_RE.match(recording_id)
    if not match:
        return _iso(_now())
    local = datetime(
        int(match[1]), int(match[2]), int(match[3]), int(match[4]), int(match[5]), int(match[6]), tzinfo=_zone()
    )
    return _iso(local)


def _doc_title(filename: str) -> str:
    return filename[:-3] if filename.endswith(".md") else filename


def _read() -> dict:
    path = _jobs_path()
    if not path.exists():
        return {"jobs": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise VideoJobError(500, "Could not read the video job queue") from exc
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), dict):
        raise VideoJobError(500, "Could not read the video job queue")
    return data


def _write(data: dict) -> None:
    path = _jobs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _release_expired(data: dict, now: datetime) -> bool:
    changed = False
    for job in data["jobs"].values():
        if job["status"] != "claimed":
            continue
        expires = job.get("lease_expires_at")
        if expires and datetime.fromisoformat(expires) > now:
            continue
        _clear_claim(job, now)
        job["status"] = "queued"
        changed = True
    return changed


def _with_jobs(mutator):
    """Exclusive access across threads and processes.

    Expired leases are returned to the queue before ``mutator`` runs, and
    that write is kept even when ``mutator`` raises — a rejected retry
    must not leave a crashed worker's job looking claimed. ``mutator``
    returns ``(changed, result)``."""
    root = Path(settings.data_dir)
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / LOCK_FILENAME
    with _thread_lock:
        with open(lock_path, "a+", encoding="utf-8") as lockf:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
            try:
                data = _read()
                now = _now()
                released = _release_expired(data, now)
                try:
                    changed, result = mutator(data, now)
                except Exception:
                    if released:
                        _write(data)
                    raise
                if released or changed:
                    _write(data)
                return result
            finally:
                fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)


def _clear_claim(job: dict, now: datetime) -> None:
    job["worker_id"] = None
    job["claim_token"] = None
    job["lease_expires_at"] = None
    job["claimed_at"] = None
    job["progress_message"] = None
    job["progress_percent"] = None
    job["updated_at"] = _iso(now)


def _tokens_match(expected: str | None, got: str | None) -> bool:
    if not expected or not got:
        return False
    a, b = expected.encode(), got.encode()
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def _progress(job: dict) -> dict | None:
    message, percent = job.get("progress_message"), job.get("progress_percent")
    if message is None and percent is None:
        return None
    return {"message": message, "percent": percent}


def _result(job: dict) -> dict | None:
    if job["status"] != "succeeded":
        return None
    return {
        "youtube_video_id": job.get("youtube_video_id"),
        "youtube_url": job.get("youtube_url"),
        "transcript": job.get("transcript"),
    }


def _labels(job: dict) -> tuple[str | None, str | None]:
    project_title = folder_title = None
    try:
        project_title = storage.get_project(job["project_id"]).get("title")
    except FileNotFoundError:
        pass
    try:
        folder_title = storage._read_meta(job["project_id"], job["conv_id"]).get("title")
    except FileNotFoundError:
        pass
    return project_title, folder_title


def worker_view(job: dict) -> dict:
    project_title, folder_title = _labels(job)
    ext = job["recording_id"].rsplit(".", 1)[-1]
    return {
        "id": job["id"],
        "status": job["status"],
        "title": _doc_title(job["filename"]),
        "filename": job["filename"],
        "recording_id": job["recording_id"],
        "project_id": job["project_id"],
        "project_title": project_title,
        "conv_id": job["conv_id"],
        "folder_title": folder_title,
        "mime": storage.RECORDING_EXTS.get(ext),
        "duration_sec": job.get("duration_sec"),
        "created_at": job["created_at"],
        "enqueued_at": job["enqueued_at"],
        "updated_at": job["updated_at"],
        "attempt": job["attempt"],
        "worker_id": job.get("worker_id"),
        "lease_expires_at": job.get("lease_expires_at"),
        "progress": _progress(job),
        "error": job.get("error"),
        "result": _result(job),
        "audio_url": f"/api/worker/jobs/{job['id']}/audio",
    }


def user_view(job: dict) -> dict:
    """What the recordings list shows. No claim token."""
    return {
        "job_id": job["id"],
        "status": job["status"],
        "attempt": job["attempt"],
        "progress": _progress(job),
        "error": job.get("error"),
        "youtube_video_id": job.get("youtube_video_id"),
        "youtube_url": job.get("youtube_url"),
        "transcript": job.get("transcript"),
        "updated_at": job["updated_at"],
    }


def _find(data: dict, project_id: str, conv_id: str, filename: str, recording_id: str) -> dict | None:
    for job in data["jobs"].values():
        if (
            job["project_id"] == project_id
            and job["conv_id"] == conv_id
            and job["filename"] == filename
            and job["recording_id"] == recording_id
        ):
            return job
    return None


def _require_job(data: dict, job_id: str) -> dict:
    job = data["jobs"].get(job_id)
    if job is None:
        raise VideoJobError(404, "Job not found")
    return job


def _recording_ok(job: dict) -> bool:
    try:
        path, _mime = storage.recording_file(job["project_id"], job["conv_id"], job["filename"], job["recording_id"])
    except (FileNotFoundError, ValueError):
        return False
    return path.is_file() and path.stat().st_size > 0


def _check_duration(duration_sec) -> float | None:
    if duration_sec is None:
        return None
    if isinstance(duration_sec, bool) or not isinstance(duration_sec, (int, float)):
        raise VideoJobError(400, "duration_sec must be a number")
    if not math.isfinite(duration_sec) or duration_sec < 0 or duration_sec > DURATION_MAX:
        raise VideoJobError(400, "duration_sec is out of range")
    return round(float(duration_sec), 3)


def _check_lease(lease_seconds: int) -> int:
    if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, int):
        raise VideoJobError(400, "lease_seconds must be an integer")
    if not LEASE_MIN <= lease_seconds <= LEASE_MAX:
        raise VideoJobError(400, f"lease_seconds must be between {LEASE_MIN} and {LEASE_MAX}")
    return lease_seconds


def _check_worker_id(worker_id: str) -> str:
    worker_id = (worker_id or "").strip()
    if not worker_id or len(worker_id) > WORKER_ID_MAX or any(ord(c) < 32 for c in worker_id):
        raise VideoJobError(400, "worker_id must be 1-64 characters")
    return worker_id


def _new_job(project_id, conv_id, filename, recording_id, duration_sec, now: datetime) -> dict:
    stamp = _iso(now)
    return {
        "id": uuid.uuid4().hex,
        "project_id": project_id,
        "conv_id": conv_id,
        "filename": filename,
        "recording_id": recording_id,
        "duration_sec": duration_sec,
        "created_at": recording_created_at(recording_id),
        "enqueued_at": stamp,
        "updated_at": stamp,
        "status": "queued",
        "attempt": 0,
        "worker_id": None,
        "claim_token": None,
        "lease_seconds": LEASE_DEFAULT,
        "lease_expires_at": None,
        "claimed_at": None,
        "progress_message": None,
        "progress_percent": None,
        "error": None,
        "youtube_video_id": None,
        "youtube_url": None,
        "transcript": None,
    }


def _requeue(job: dict, now: datetime, duration_sec) -> None:
    _clear_claim(job, now)
    job["status"] = "queued"
    job["error"] = None
    job["youtube_video_id"] = None
    job["youtube_url"] = None
    job["transcript"] = None
    job["enqueued_at"] = _iso(now)
    if duration_sec is not None:
        job["duration_sec"] = duration_sec


def set_enqueued(
    project_id: str,
    conv_id: str,
    filename: str,
    recording_id: str,
    enqueue: bool,
    duration_sec=None,
) -> dict | None:
    """Opt a recording in (``enqueue``) or out. In is idempotent for a job
    that is already queued, claimed, or succeeded. Out refuses a claim in
    progress and a job that already succeeded."""
    duration = _check_duration(duration_sec)
    path, _ = storage.recording_file(project_id, conv_id, filename, recording_id)
    if path.stat().st_size <= 0:
        raise VideoJobError(400, "Recording is empty")

    def mutate(data: dict, now: datetime):
        job = _find(data, project_id, conv_id, filename, recording_id)
        if enqueue:
            if job is None:
                job = _new_job(project_id, conv_id, filename, recording_id, duration, now)
                data["jobs"][job["id"]] = job
                return True, user_view(job)
            if job["status"] in ("queued", "claimed", "succeeded"):
                changed = False
                if duration is not None and job["status"] == "queued" and job.get("duration_sec") != duration:
                    job["duration_sec"] = duration
                    job["updated_at"] = _iso(now)
                    changed = True
                return changed, user_view(job)
            _requeue(job, now, duration)
            return True, user_view(job)
        if job is None:
            return False, None
        if job["status"] == "claimed":
            raise VideoJobError(409, "Job is in progress")
        if job["status"] == "succeeded":
            raise VideoJobError(409, "Job already succeeded")
        if job["status"] != "cancelled":
            job["status"] = "cancelled"
            _clear_claim(job, now)
            job["error"] = None
            return True, user_view(job)
        return False, user_view(job)

    return _with_jobs(mutate)


def videos_for_document(project_id: str, conv_id: str, filename: str) -> dict[str, dict]:
    """recording id → user-facing status. An expired claim shows as queued."""

    def mutate(data: dict, _now_):
        found = {
            job["recording_id"]: user_view(job)
            for job in data["jobs"].values()
            if job["project_id"] == project_id and job["conv_id"] == conv_id and job["filename"] == filename
        }
        return False, found

    return _with_jobs(mutate)


def _sort_key(job: dict):
    return (job.get("created_at") or "", job["id"])


def list_jobs(status: str = "waiting", order: str = "oldest", limit: int | None = None) -> list[dict]:
    if status not in LIST_STATUSES:
        raise VideoJobError(400, "status must be waiting, queued, claimed, succeeded, failed, cancelled, or all")
    if order not in ("oldest", "newest"):
        raise VideoJobError(400, "order must be oldest or newest")
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500):
        raise VideoJobError(400, "limit must be an integer from 1 to 500")

    def mutate(data: dict, _now_):
        jobs = list(data["jobs"].values())
        if status == "waiting":
            jobs = [job for job in jobs if job["status"] == "queued"]
        elif status != "all":
            jobs = [job for job in jobs if job["status"] == status]
        jobs.sort(key=_sort_key, reverse=order == "newest")
        if limit is not None:
            jobs = jobs[:limit]
        return False, [worker_view(job) for job in jobs]

    return _with_jobs(mutate)


def get_job(job_id: str) -> dict:
    def mutate(data: dict, _now_):
        return False, worker_view(_require_job(data, job_id))

    return _with_jobs(mutate)


def claim(worker_id: str, lease_seconds: int = LEASE_DEFAULT) -> dict | None:
    """The oldest waiting recording whose file is still there. A missing
    file is marked failed and skipped, so one bad entry does not block the
    queue. None when nothing is waiting."""
    worker_id = _check_worker_id(worker_id)
    lease_seconds = _check_lease(lease_seconds)

    def mutate(data: dict, now: datetime):
        waiting = sorted((job for job in data["jobs"].values() if job["status"] == "queued"), key=_sort_key)
        changed = False
        chosen = None
        for job in waiting:
            if not _recording_ok(job):
                job["status"] = "failed"
                job["error"] = "Recording file is missing"
                job["updated_at"] = _iso(now)
                changed = True
                continue
            chosen = job
            break
        if chosen is None:
            return changed, None
        token = secrets.token_urlsafe(32)
        chosen["status"] = "claimed"
        chosen["worker_id"] = worker_id
        chosen["claim_token"] = token
        chosen["lease_seconds"] = lease_seconds
        chosen["claimed_at"] = _iso(now)
        chosen["lease_expires_at"] = _iso(now + timedelta(seconds=lease_seconds))
        chosen["attempt"] = int(chosen.get("attempt") or 0) + 1
        chosen["error"] = None
        chosen["progress_message"] = None
        chosen["progress_percent"] = None
        chosen["updated_at"] = chosen["claimed_at"]
        view = worker_view(chosen)
        view["claim_token"] = token
        return True, view

    return _with_jobs(mutate)


def _held(data: dict, job_id: str, claim_token: str) -> dict:
    job = _require_job(data, job_id)
    if job["status"] != "claimed" or not _tokens_match(job.get("claim_token"), claim_token):
        raise VideoJobError(409, "Job is not held by this claim")
    return job


def report_progress(
    job_id: str,
    claim_token: str,
    message: str | None = None,
    percent: int | None = None,
    lease_seconds: int | None = None,
) -> dict:
    if message is not None:
        message = message.strip()
        if not message:
            message = None
        elif len(message) > MESSAGE_MAX:
            raise VideoJobError(400, f"message must be at most {MESSAGE_MAX} characters")
    if percent is not None and (isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 100):
        raise VideoJobError(400, "percent must be an integer from 0 to 100")
    if message is None and percent is None:
        raise VideoJobError(400, "progress needs a message or a percent")
    renew = _check_lease(lease_seconds) if lease_seconds is not None else None

    def mutate(data: dict, now: datetime):
        job = _held(data, job_id, claim_token)
        job["progress_message"] = message
        job["progress_percent"] = percent
        seconds = renew if renew is not None else int(job.get("lease_seconds") or LEASE_DEFAULT)
        job["lease_seconds"] = seconds
        job["lease_expires_at"] = _iso(now + timedelta(seconds=seconds))
        job["updated_at"] = _iso(now)
        return True, worker_view(job)

    return _with_jobs(mutate)


def complete(
    job_id: str,
    claim_token: str,
    youtube_video_id: str,
    youtube_url: str | None = None,
    transcript: str | None = None,
) -> dict:
    youtube_video_id = (youtube_video_id or "").strip()
    if not _YOUTUBE_ID_RE.match(youtube_video_id):
        raise VideoJobError(400, "youtube_video_id must be 6-64 characters of letters, digits, _ or -")
    if youtube_url is not None:
        youtube_url = youtube_url.strip()
        if not _URL_RE.match(youtube_url):
            raise VideoJobError(400, "youtube_url must be an http(s) URL")
    else:
        youtube_url = f"https://www.youtube.com/watch?v={youtube_video_id}"
    if transcript is not None:
        if not isinstance(transcript, str):
            raise VideoJobError(400, "transcript must be a string")
        if len(transcript) > TRANSCRIPT_MAX:
            raise VideoJobError(400, "transcript is too long")
        transcript = transcript if transcript.strip() else None

    def mutate(data: dict, now: datetime):
        job = _held(data, job_id, claim_token)
        job["status"] = "succeeded"
        job["youtube_video_id"] = youtube_video_id
        job["youtube_url"] = youtube_url
        job["transcript"] = transcript
        job["error"] = None
        _clear_claim(job, now)
        return True, worker_view(job)

    return _with_jobs(mutate)


def fail(job_id: str, claim_token: str, error: str) -> dict:
    error = (error or "").strip()
    if not error or len(error) > ERROR_MAX:
        raise VideoJobError(400, f"error must be 1-{ERROR_MAX} characters")

    def mutate(data: dict, now: datetime):
        job = _held(data, job_id, claim_token)
        job["status"] = "failed"
        job["error"] = error
        _clear_claim(job, now)
        return True, worker_view(job)

    return _with_jobs(mutate)


def retry(job_id: str) -> dict:
    """Failed → queued. A crashed claim does not need this: it becomes
    waiting again when the lease expires."""

    def mutate(data: dict, now: datetime):
        job = _require_job(data, job_id)
        if job["status"] != "failed":
            raise VideoJobError(409, "Only a failed job can be retried")
        if not _recording_ok(job):
            raise VideoJobError(409, "Recording file is missing")
        _requeue(job, now, None)
        return True, worker_view(job)

    return _with_jobs(mutate)


def audio_for_claim(job_id: str, claim_token: str) -> tuple[Path, str, str]:
    """(path, media type, download filename) for the worker that holds the lease."""

    def mutate(data: dict, _now_):
        job = _held(data, job_id, claim_token)
        try:
            path, mime = storage.recording_file(job["project_id"], job["conv_id"], job["filename"], job["recording_id"])
        except FileNotFoundError as exc:
            raise VideoJobError(404, "Recording file is missing") from exc
        if not path.is_file() or path.stat().st_size <= 0:
            raise VideoJobError(404, "Recording file is missing")
        name = f"{_doc_title(job['filename'])}-{job['recording_id']}"
        return False, (path, mime, name)

    return _with_jobs(mutate)


def retarget(
    project_id: str,
    conv_id: str,
    filename: str,
    *,
    project_id_to: str,
    conv_id_to: str,
    filename_to: str,
) -> None:
    """Keep jobs pointed at a document that was renamed or moved."""
    if not _jobs_path().exists():
        return

    def mutate(data: dict, now: datetime):
        changed = False
        stamp = _iso(now)
        for job in data["jobs"].values():
            if job["project_id"] == project_id and job["conv_id"] == conv_id and job["filename"] == filename:
                job["project_id"] = project_id_to
                job["conv_id"] = conv_id_to
                job["filename"] = filename_to
                job["updated_at"] = stamp
                changed = True
        return changed, None

    _with_jobs(mutate)


def forget(
    *,
    project_id: str,
    conv_id: str | None = None,
    conv_ids: list[str] | None = None,
    filename: str | None = None,
    recording_id: str | None = None,
) -> None:
    """Drop jobs whose recording is gone. A succeeded job goes too: the
    YouTube id lived on the recording, and the recording is the UI for it."""
    if not _jobs_path().exists():
        return
    ids = set(conv_ids or [])
    if conv_id is not None:
        ids.add(conv_id)

    def matches(job: dict) -> bool:
        if job["project_id"] != project_id:
            return False
        if ids and job["conv_id"] not in ids:
            return False
        if filename is not None and job["filename"] != filename:
            return False
        if recording_id is not None and job["recording_id"] != recording_id:
            return False
        return True

    def mutate(data: dict, _now_):
        kept = {jid: job for jid, job in data["jobs"].items() if not matches(job)}
        changed = len(kept) != len(data["jobs"])
        if changed:
            data["jobs"] = kept
        return changed, None

    _with_jobs(mutate)

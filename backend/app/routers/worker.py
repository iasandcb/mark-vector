"""Pull queue for a machine that turns recordings into YouTube videos.

The worker polls; this server never calls it. WORKER_TOKEN is its own
secret (not INGEST_TOKEN). With the variable unset every route 404s, the
same way ingest does. Session auth does not apply — see auth.py's public
prefix — because the worker has no browser session.

The JSON contract is documented in docs/youtube-queue.md ("YouTube 영상 작업 큐").
"""

import hmac

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import video_jobs
from ..config import settings

router = APIRouter(prefix="/api/worker", tags=["worker"])


def _check_token(request: Request) -> None:
    if not settings.worker_token:
        raise HTTPException(status_code=404, detail="Not found")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    # compare_digest over ==, same as the ingest token. A missing token and
    # a wrong one are the same 401 — the 404 above is only "not configured".
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), settings.worker_token.encode()):
        raise HTTPException(status_code=401, detail="Invalid token")


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except video_jobs.VideoJobError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


class ClaimBody(BaseModel):
    worker_id: str
    lease_seconds: int = video_jobs.LEASE_DEFAULT


class ProgressBody(BaseModel):
    claim_token: str
    message: str | None = None
    percent: int | None = None
    lease_seconds: int | None = None


class CompleteBody(BaseModel):
    claim_token: str
    youtube_video_id: str
    youtube_url: str | None = None
    transcript: str | None = None


class FailBody(BaseModel):
    claim_token: str
    error: str


@router.get("/jobs")
def list_jobs(request: Request, status: str = "waiting", order: str = "oldest", limit: int | None = None):
    """Recordings waiting to be processed, unless `status` says otherwise.

    `order` is `oldest` (default) or `newest`, by the recording's start
    time. `waiting` (the default) is queued jobs plus claims whose lease
    has expired — those are put back to queued as they are read.
    """
    _check_token(request)
    return {"jobs": _call(video_jobs.list_jobs, status, order, limit)}


@router.post("/jobs/claim")
def claim_job(request: Request, body: ClaimBody):
    """Atomically take the oldest waiting job. `{"job": null}` when the
    queue is empty. The claim token is only returned here."""
    _check_token(request)
    return {"job": _call(video_jobs.claim, body.worker_id, body.lease_seconds)}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    _check_token(request)
    return _call(video_jobs.get_job, job_id)


@router.get("/jobs/{job_id}/audio")
def download_audio(job_id: str, request: Request, x_claim_token: str | None = Header(default=None)):
    """The original recording bytes. Only the worker holding the lease."""
    _check_token(request)
    if not x_claim_token:
        raise HTTPException(status_code=409, detail="Job is not held by this claim")
    path, mime, name = _call(video_jobs.audio_for_claim, job_id, x_claim_token)
    return FileResponse(path, media_type=mime, filename=name)


@router.post("/jobs/{job_id}/progress")
def report_progress(job_id: str, request: Request, body: ProgressBody):
    """Status while the lease is held. Reporting renews the lease."""
    _check_token(request)
    return _call(
        video_jobs.report_progress,
        job_id,
        body.claim_token,
        body.message,
        body.percent,
        body.lease_seconds,
    )


@router.post("/jobs/{job_id}/complete")
def complete_job(job_id: str, request: Request, body: CompleteBody):
    _check_token(request)
    return _call(
        video_jobs.complete,
        job_id,
        body.claim_token,
        body.youtube_video_id,
        body.youtube_url,
        body.transcript,
    )


@router.post("/jobs/{job_id}/fail")
def fail_job(job_id: str, request: Request, body: FailBody):
    _check_token(request)
    return _call(video_jobs.fail, job_id, body.claim_token, body.error)


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str, request: Request):
    """Put a failed job back on the queue. Expired claims do not need this."""
    _check_token(request)
    return _call(video_jobs.retry, job_id)

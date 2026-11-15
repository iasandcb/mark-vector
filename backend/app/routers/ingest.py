"""Audio a bot drops in - a YouTube soundtrack another tool extracted, or a
voice memo - attached to a new document, ready to transcribe.

    curl -H "Authorization: Bearer $INGEST_TOKEN" -F file=@talk.m4a \\
         https://markvector.fly.dev/api/ingest/audio

makes "talk.md" in the folder named for today (INGEST_TIMEZONE's day, e.g.
"2026-10-20") of the "youtube" project, both made if missing, with the file
as its recording. Omitting the new fields keeps that default, which is what
scripter's youtube_ingest.py already sends.

A voice memo that should land in today's compact folder, under a document
named for the current time, sends `layout=stamp` and omits project, folder,
and title:

    curl -H "Authorization: Bearer $INGEST_TOKEN" -F file=@memo.m4a \\
         -F layout=stamp \\
         https://markvector.fly.dev/api/ingest/audio

That makes "164512.md" (HHmmss, 24-hour clock) in the folder "20261114"
(YYYYMMDD). Both come from INGEST_TIMEZONE (default Asia/Seoul). An explicit
`project`, `folder`, or `title` still wins over those defaults.

Optional form fields:

- `project` — default "youtube".
- `folder` — the exact folder name. One path component: no slashes or
  control characters, not `.` or `..`, at most 255 characters. When this is
  set it wins over `date` and over `layout`.
- `date` (YYYY-MM-DD) — the folder name when `folder` is omitted. Existing
  callers keep using this. A date that is sent must still match
  YYYY-MM-DD, even when `folder` is what actually names the folder.
- `title` — the document name, instead of the file's own name. With
  `layout=stamp` and no title, the name is the current HHmmss.
- `layout` — `stamp` for the compact date folder and clock document above.
  Anything else is rejected. Omit it for the YYYY-MM-DD default.
- `enqueue` — `false`/`0`/`no`/`off` keeps the recording out of the YouTube
  queue. Anything else, including omitting it, queues the new recording.

A full data volume is 507 JSON (`Not enough disk space to store this
recording`). Any other failure to write the file is 500 JSON. Neither is
the bare text "Internal Server Error" Starlette sends for an uncaught
exception.

Not behind the sign-in (auth.AuthMiddleware lets /api/ingest/ through): a
bot has no session. INGEST_TOKEN is the key instead, and without it set the
route is off."""

import hmac
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile

from .. import storage, video_jobs
from ..config import settings
from .recordings import prepare_playable

router = APIRouter(prefix="/api/ingest", tags=["ingest"])
logger = logging.getLogger(__name__)

DEFAULT_PROJECT = "youtube"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_LAYOUT_STAMP = "stamp"


def _check_token(request: Request) -> None:
    if not settings.ingest_token:
        raise HTTPException(status_code=404, detail="Not found")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), settings.ingest_token.encode()):
        raise HTTPException(status_code=401, detail="Invalid token")


def _now_local() -> datetime:
    try:
        tz = ZoneInfo(settings.ingest_timezone)
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone(timedelta(hours=9))
    return datetime.now(tz)


def _layout(raw: str) -> str:
    layout = raw.strip().lower()
    if layout not in {"", _LAYOUT_STAMP}:
        raise HTTPException(status_code=400, detail="layout must be stamp")
    return layout


def _folder_title(now: datetime, folder: str, date: str, layout: str) -> str:
    """`folder` is the exact name. Otherwise `date` still names the folder.
    With neither, `layout=stamp` uses YYYYMMDD and the plain default stays
    today's YYYY-MM-DD."""
    if folder.strip():
        return folder.strip()
    if date:
        return date
    if layout == _LAYOUT_STAMP:
        return now.strftime("%Y%m%d")
    return now.strftime("%Y-%m-%d")


def _document_title(now: datetime, title: str, stem: str, layout: str) -> str:
    if title.strip():
        return title.strip()
    if layout == _LAYOUT_STAMP:
        return now.strftime("%H%M%S")
    return stem


@router.post("/audio")
async def ingest_audio(
    request: Request,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    project: str = Form(DEFAULT_PROJECT),
    date: str = Form(""),
    folder: str = Form(""),
    title: str = Form(""),
    layout: str = Form(""),
    enqueue: str = Form(""),
):
    _check_token(request)
    name = PurePath(file.filename or "audio").name
    stem, _, ext = name.rpartition(".")
    if not stem:
        stem, ext = ext, ""
    ext = ext.lower()
    if ext not in storage.RECORDING_EXTS:
        allowed = ", ".join(sorted(storage.RECORDING_EXTS))
        raise HTTPException(status_code=400, detail=f"Unsupported file type: .{ext} ({allowed})")
    if date and not _DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    chosen = _layout(layout)
    now = _now_local()
    try:
        result = storage.ingest_audio(
            project.strip() or DEFAULT_PROJECT,
            _folder_title(now, folder, date, chosen),
            _document_title(now, title, stem, chosen),
            ext,
            file.file,
            now.replace(tzinfo=None),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except OSError as exc:
        # The copy writes straight onto the data volume. A full volume raises
        # here, after the body has already been accepted. Logged with the
        # errno so the fly log still shows ENOSPC; the client gets JSON
        # instead of Starlette's text/plain 500.
        logger.exception("ingest audio failed errno=%s", exc.errno)
        status, detail = storage.recording_write_error(exc)
        raise HTTPException(status_code=status, detail=detail)
    # The playable copy is made now, not on the first ▶ - for an hour's
    # audio that takes a minute or more.
    background.add_task(prepare_playable, result["project_id"], result["conv_id"], result["filename"], result["recording"]["id"])
    base = str(request.base_url).rstrip("/")
    result["url"] = f"{base}/?project={result['project_id']}&session={result['conv_id']}&file={result['filename']}"
    # The file is complete (unlike a dictation recording, which is still
    # growing until the browser finishes uploading). Existing recordings
    # are not backfilled; only this new one is offered to the worker.
    result["video_job"] = None
    if video_jobs.wants_queue(enqueue):
        try:
            result["video_job"] = video_jobs.set_enqueued(
                result["project_id"], result["conv_id"], result["filename"], result["recording"]["id"], True
            )
        except video_jobs.VideoJobError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    return result

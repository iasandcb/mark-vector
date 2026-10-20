"""Audio a bot drops in - e.g. the soundtrack of a YouTube video someone
else's tool extracted - attached to a new document, ready to transcribe.

    curl -H "Authorization: Bearer $INGEST_TOKEN" -F file=@talk.m4a \\
         https://markvector.fly.dev/api/ingest/audio

makes "talk.md" in the folder named for today (INGEST_TIMEZONE's day, e.g.
"2026-10-20") of the "youtube" project, both made if missing, with the file
as its recording. Optional form fields: `project`, `date` (YYYY-MM-DD) and
`title` (instead of the file's own name).

Not behind the sign-in (auth.AuthMiddleware lets /api/ingest/ through): a
bot has no session. INGEST_TOKEN is the key instead, and without it set the
route is off."""

import hmac
import re
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from .. import storage
from ..config import settings

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

DEFAULT_PROJECT = "youtube"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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


@router.post("/audio")
async def ingest_audio(
    request: Request,
    file: UploadFile = File(...),
    project: str = Form(DEFAULT_PROJECT),
    date: str = Form(""),
    title: str = Form(""),
):
    _check_token(request)
    name = PurePath(file.filename or "audio").name
    stem, _, ext = name.rpartition(".")
    if not stem:
        stem, ext = ext, ""
    ext = ext.lower()
    if ext not in storage.RECORDING_EXTS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: .{ext} (m4a, webm or ogg)")
    if date and not _DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    now = _now_local()
    try:
        result = storage.ingest_audio(
            project.strip() or DEFAULT_PROJECT,
            date or now.strftime("%Y-%m-%d"),
            title.strip() or stem,
            ext,
            file.file,
            now.replace(tzinfo=None),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    base = str(request.base_url).rstrip("/")
    result["url"] = f"{base}/?project={result['project_id']}&session={result['conv_id']}&file={result['filename']}"
    return result

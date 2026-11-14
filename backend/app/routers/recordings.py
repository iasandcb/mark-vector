import asyncio
import logging
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import PurePath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import storage, video_jobs
from ..config import settings

router = APIRouter(prefix="/api/projects/{project_id}/conversations/{conv_id}/documents/{filename}/recordings", tags=["recordings"])
logger = logging.getLogger(__name__)

# One upload is a few seconds of speech-grade audio; this is just a ceiling.
MAX_CHUNK_BYTES = 8 * 1024 * 1024


def _reject(status: int, detail, *, where: str, **ctx) -> HTTPException:
    """A 4xx the client can show. Logged with the reason so a recording that
    never becomes a file or a YouTube job is visible on the server too.
    `detail` is the response body; nothing here is a credential."""
    rendered = detail if isinstance(detail, str) else repr(detail)
    context = " ".join(f"{key}={value}" for key, value in ctx.items() if value is not None)
    logger.warning(
        "recording rejected: where=%s status=%s detail=%s%s",
        where,
        status,
        rendered,
        f" {context}" if context else "",
    )
    return HTTPException(status_code=status, detail=detail)


class NewRecording(BaseModel):
    ext: str
    # The recorder's local time ("2026-10-18T19:30:12"), for the id.
    started: str


def _not_found(exc: FileNotFoundError, *, where: str) -> HTTPException:
    return _reject(404, f"Not found: {exc}", where=where)


@router.get("")
def list_recordings(project_id: str, conv_id: str, filename: str):
    try:
        recordings = storage.list_recordings(project_id, conv_id, filename)
        videos = video_jobs.videos_for_document(project_id, conv_id, filename)
    except ValueError as exc:
        raise _reject(400, str(exc), where="list", project=project_id, file=filename)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="list")
    except video_jobs.VideoJobError as exc:
        raise _reject(exc.status_code, exc.detail, where="list", project=project_id, file=filename)
    for recording in recordings:
        recording["video"] = videos.get(recording["id"])
    return recordings


class VideoEnqueue(BaseModel):
    enqueue: bool
    # Seconds, when the client knows them (the recorder's own clock).
    duration_sec: float | None = None


@router.put("/{recording_id}/video")
def set_recording_video(project_id: str, conv_id: str, filename: str, recording_id: str, body: VideoEnqueue):
    """Opt this recording into or out of the YouTube queue. New dictation
    recordings are opted in by the app once the upload finishes; this is
    how an older recording is added, or a queued one is taken back."""
    try:
        video = video_jobs.set_enqueued(
            project_id, conv_id, filename, recording_id, body.enqueue, body.duration_sec
        )
    except ValueError as exc:
        raise _reject(400, str(exc), where="enqueue", project=project_id, file=filename, recording=recording_id)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="enqueue")
    except video_jobs.VideoJobError as exc:
        raise _reject(exc.status_code, exc.detail, where="enqueue", project=project_id, file=filename, recording=recording_id)
    return {"video": video}


def _upload_started(raw: str) -> datetime:
    """The recorder's clock for the id. A zoned stamp is read in that zone;
    a bare one is the sender's local time, same as a dictation recording.
    Omitted means now in INGEST_TIMEZONE, same as ingest."""
    if not raw.strip():
        try:
            tz = ZoneInfo(settings.ingest_timezone)
        except (ZoneInfoNotFoundError, ValueError):
            tz = timezone(timedelta(hours=9))
        return datetime.now(tz).replace(tzinfo=None)
    try:
        started = datetime.fromisoformat(raw.strip())
    except ValueError:
        raise _reject(400, "started must be an ISO timestamp", where="upload")
    if started.tzinfo is not None:
        try:
            tz = ZoneInfo(settings.ingest_timezone)
        except (ZoneInfoNotFoundError, ValueError):
            tz = timezone(timedelta(hours=9))
        started = started.astimezone(tz).replace(tzinfo=None)
    return started


def _upload_ext(name: str) -> str:
    ext = PurePath(name or "").suffix.lower().lstrip(".")
    if ext == "wave":
        ext = "wav"
    if ext not in storage.RECORDING_EXTS:
        allowed = ", ".join(sorted(storage.RECORDING_EXTS))
        raise _reject(400, f"Unsupported file type: .{ext or '?'} ({allowed})", where="upload", name=name)
    return ext


@router.post("/upload")
def upload_recording(
    project_id: str,
    conv_id: str,
    filename: str,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    started: str = Form(""),
    duration_sec: str = Form(""),
    enqueue: str = Form(""),
):
    """A whole audio file, from the recordings list, becomes one recording
    of this document. Same bytes as ingest, and queued for the YouTube
    worker the same way unless `enqueue` is false/0/no/off. Session auth,
    not INGEST_TOKEN."""
    ext = _upload_ext(file.filename or "")
    when = _upload_started(started)
    duration = None
    if duration_sec.strip():
        try:
            duration = float(duration_sec)
        except ValueError:
            raise _reject(400, "duration_sec must be a number", where="upload", file=filename)
    try:
        info = storage.add_recording_bytes(project_id, conv_id, filename, ext, file.file, when)
    except ValueError as exc:
        raise _reject(400, str(exc), where="upload", project=project_id, file=filename)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="upload")
    info["video"] = None
    if video_jobs.wants_queue(enqueue):
        try:
            info["video"] = video_jobs.set_enqueued(project_id, conv_id, filename, info["id"], True, duration)
        except video_jobs.VideoJobError as exc:
            raise _reject(exc.status_code, exc.detail, where="upload-enqueue", project=project_id, file=filename, recording=info["id"])
    background.add_task(prepare_playable, project_id, conv_id, filename, info["id"])
    return info


@router.post("")
def create_recording(project_id: str, conv_id: str, filename: str, req: NewRecording):
    try:
        started = datetime.fromisoformat(req.started)
        return storage.create_recording(project_id, conv_id, filename, req.ext, started)
    except ValueError as exc:
        raise _reject(400, str(exc), where="create", project=project_id, file=filename, ext=req.ext)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="create")


@router.put("/{recording_id}")
async def append_recording(project_id: str, conv_id: str, filename: str, recording_id: str, offset: int, request: Request):
    """The next piece of a recording, raw bytes at `offset`. 409 with the
    current size when `offset` isn't where the file ends."""
    data = await request.body()
    if len(data) > MAX_CHUNK_BYTES:
        raise _reject(413, "Chunk too large", where="append", project=project_id, file=filename, recording=recording_id, bytes=len(data))
    try:
        size = storage.append_recording(project_id, conv_id, filename, recording_id, offset, data)
    except storage.RecordingOffsetError as exc:
        raise _reject(409, {"size": exc.size}, where="append", project=project_id, file=filename, recording=recording_id, offset=offset, size=exc.size)
    except ValueError as exc:
        raise _reject(400, str(exc), where="append", project=project_id, file=filename, recording=recording_id)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="append")
    return {"size": size}


_convert_locks: dict[str, asyncio.Lock] = {}


# Quieter than this, a channel is taken to carry nothing.
SILENT_DB = -70.0


async def _channel_levels(src) -> list[float]:
    """Each channel's RMS level in dB (-inf for pure silence)."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-vn",
        "-af", "astats=measure_perchannel=RMS_level:measure_overall=none", "-f", "null", "-",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    levels = []
    for value in re.findall(r"RMS level dB:\s*(\S+)", err.decode(errors="replace")):
        try:
            levels.append(float(value))
        except ValueError:
            levels.append(float("-inf"))
    return levels


def _mono_filter(levels: list[float]) -> str:
    """Down to one channel: the only one with sound in it, if just one has
    any (a whole side silent - iOS does that with some microphones -
    would otherwise halve the volume), else all of them averaged."""
    loud = [i for i, level in enumerate(levels) if level > SILENT_DB]
    if len(levels) > 1 and len(loud) == 1:
        return f"pan=mono|c0=c{loud[0]}"
    return "pan=mono|c0=" + "+".join(f"{1 / max(len(levels), 1):.4f}*c{i}" for i in range(max(len(levels), 1)))


async def _playable(src, dst) -> None:
    """Makes `dst` a mono AAC copy of `src` unless an up-to-date one is there.
    The player asks several times over (ranges), so one conversion at a time
    per recording."""
    lock = _convert_locks.setdefault(str(dst), asyncio.Lock())
    async with lock:
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            return
        if shutil.which("ffmpeg") is None:
            raise HTTPException(status_code=501, detail="ffmpeg is not installed on the server")
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".part")
        mono = _mono_filter(await _channel_levels(src))
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-af", mono, "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart", "-f", "mp4", str(tmp),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Conversion failed: {err.decode(errors='replace')[-300:]}")
        tmp.replace(dst)


async def prepare_playable(project_id: str, conv_id: str, filename: str, recording_id: str) -> None:
    """Makes the playable copy ahead of the first request for it; a failure
    just leaves that request to try again."""
    try:
        src, dst = storage.playable_recording_paths(project_id, conv_id, filename, recording_id)
        await _playable(src, dst)
    except Exception:
        pass


@router.get("/{recording_id}")
async def get_recording(project_id: str, conv_id: str, filename: str, recording_id: str, format: str | None = None):
    """The recording as recorded - or, with `format=m4a`, as the mono AAC
    copy that plays anywhere (see storage.PLAYABLE_SUFFIX)."""
    stem = f"{filename.removesuffix('.md')}-{recording_id}"
    try:
        if format == "m4a":
            src, dst = storage.playable_recording_paths(project_id, conv_id, filename, recording_id)
            await _playable(src, dst)
            return FileResponse(dst, media_type="audio/mp4", filename=stem.rsplit(".", 1)[0] + ".m4a")
        path, mime = storage.recording_file(project_id, conv_id, filename, recording_id)
    except ValueError as exc:
        raise _reject(400, str(exc), where="read", project=project_id, file=filename, recording=recording_id)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="read")
    return FileResponse(path, media_type=mime, filename=stem)


@router.delete("/{recording_id}")
def delete_recording(project_id: str, conv_id: str, filename: str, recording_id: str):
    try:
        storage.delete_recording(project_id, conv_id, filename, recording_id)
    except ValueError as exc:
        raise _reject(400, str(exc), where="delete", project=project_id, file=filename, recording=recording_id)
    except FileNotFoundError as exc:
        raise _not_found(exc, where="delete")
    return {"ok": True}

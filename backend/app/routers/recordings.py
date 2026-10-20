import asyncio
import re
import shutil
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import storage

router = APIRouter(prefix="/api/projects/{project_id}/conversations/{conv_id}/documents/{filename}/recordings", tags=["recordings"])

# One upload is a few seconds of speech-grade audio; this is just a ceiling.
MAX_CHUNK_BYTES = 8 * 1024 * 1024


class NewRecording(BaseModel):
    ext: str
    # The recorder's local time ("2026-10-18T19:30:12"), for the id.
    started: str


def _not_found(exc: FileNotFoundError) -> HTTPException:
    return HTTPException(status_code=404, detail=f"Not found: {exc}")


@router.get("")
def list_recordings(project_id: str, conv_id: str, filename: str):
    try:
        return storage.list_recordings(project_id, conv_id, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)


@router.post("")
def create_recording(project_id: str, conv_id: str, filename: str, req: NewRecording):
    try:
        started = datetime.fromisoformat(req.started)
        return storage.create_recording(project_id, conv_id, filename, req.ext, started)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)


@router.put("/{recording_id}")
async def append_recording(project_id: str, conv_id: str, filename: str, recording_id: str, offset: int, request: Request):
    """The next piece of a recording, raw bytes at `offset`. 409 with the
    current size when `offset` isn't where the file ends."""
    data = await request.body()
    if len(data) > MAX_CHUNK_BYTES:
        raise HTTPException(status_code=413, detail="Chunk too large")
    try:
        size = storage.append_recording(project_id, conv_id, filename, recording_id, offset, data)
    except storage.RecordingOffsetError as exc:
        raise HTTPException(status_code=409, detail={"size": exc.size})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)
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
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)
    return FileResponse(path, media_type=mime, filename=stem)


@router.delete("/{recording_id}")
def delete_recording(project_id: str, conv_id: str, filename: str, recording_id: str):
    try:
        storage.delete_recording(project_id, conv_id, filename, recording_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)
    return {"ok": True}

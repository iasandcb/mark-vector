import asyncio
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


async def _playable(src, dst) -> None:
    """Makes `dst` an AAC copy of `src` unless an up-to-date one is there.
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
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart", "-f", "mp4", str(tmp),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Conversion failed: {err.decode(errors='replace')[-300:]}")
        tmp.replace(dst)


@router.get("/{recording_id}")
async def get_recording(project_id: str, conv_id: str, filename: str, recording_id: str, format: str | None = None):
    """The recording as recorded - or, with `format=m4a`, as AAC for a
    player that can't take the original."""
    stem = f"{filename.removesuffix('.md')}-{recording_id}"
    try:
        if format == "m4a" and not recording_id.endswith(".m4a"):
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

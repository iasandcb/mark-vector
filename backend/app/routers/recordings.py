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


@router.get("/{recording_id}")
def get_recording(project_id: str, conv_id: str, filename: str, recording_id: str):
    try:
        path, mime = storage.recording_file(project_id, conv_id, filename, recording_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)
    return FileResponse(path, media_type=mime, filename=f"{filename.removesuffix('.md')}-{recording_id}")


@router.delete("/{recording_id}")
def delete_recording(project_id: str, conv_id: str, filename: str, recording_id: str):
    try:
        storage.delete_recording(project_id, conv_id, filename, recording_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise _not_found(exc)
    return {"ok": True}

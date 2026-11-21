"""Storage screen: volume usage, recording inventory, delete, cleanup.

Same session auth as the rest of ``/api`` (see auth.AuthMiddleware). These
paths are not public, and a worker or ingest token does not grant them.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import video_jobs, volume

router = APIRouter(prefix="/api/storage", tags=["storage"])


class RecordingRef(BaseModel):
    project_id: str
    conv_id: str
    filename: str
    recording_id: str


class DeleteRecordings(BaseModel):
    recordings: list[RecordingRef]


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc) or "Not found")
    except video_jobs.VideoJobError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("")
def get_storage():
    """Bytes used on the filesystem that holds the data directory."""
    return _call(volume.usage_report)


@router.get("/recordings")
def get_storage_recordings():
    """Every recording under the data directory, with its ``.play`` copies."""
    return _call(volume.list_volume_recordings)


@router.delete("/recordings")
def delete_storage_recordings(body: DeleteRecordings):
    """Delete selected originals and the ``.play`` copies derived from them."""
    return _call(volume.delete_recordings, [item.model_dump() for item in body.recordings])


@router.post("/cleanup/preview")
def preview_storage_cleanup():
    """Originals with a finished YouTube upload, and every ``.play`` copy."""
    return _call(volume.cleanup_preview)


@router.post("/cleanup")
def run_storage_cleanup():
    """Delete what ``preview`` described. Documents and unfinished originals stay."""
    return _call(volume.cleanup_apply)

from fastapi import APIRouter

from .. import storage
from ..models import SaveDocumentRequest

router = APIRouter(prefix="/api/spoken-math", tags=["spoken-math"])


@router.get("")
def get_spoken_math():
    return {"content": storage.get_global_spoken_math()}


@router.put("")
def save_spoken_math(req: SaveDocumentRequest):
    return storage.save_global_spoken_math(req.content)

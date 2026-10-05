from fastapi import APIRouter

from .. import storage
from ..models import SaveDocumentRequest

router = APIRouter(prefix="/api/system-prompt", tags=["system-prompt"])


@router.get("")
def get_system_prompt():
    return {"content": storage.get_global_system_prompt()}


@router.put("")
def save_system_prompt(req: SaveDocumentRequest):
    return storage.save_global_system_prompt(req.content)

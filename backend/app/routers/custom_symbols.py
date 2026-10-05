from fastapi import APIRouter

from .. import storage
from ..models import SaveDocumentRequest

router = APIRouter(prefix="/api/custom-symbols", tags=["custom-symbols"])


@router.get("")
def get_custom_symbols():
    return {"content": storage.get_global_custom_symbols()}


@router.put("")
def save_custom_symbols(req: SaveDocumentRequest):
    return storage.save_global_custom_symbols(req.content)

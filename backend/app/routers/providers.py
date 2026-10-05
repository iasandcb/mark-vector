from fastapi import APIRouter

from ..providers.registry import list_providers

router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.get("")
async def get_providers():
    return await list_providers()

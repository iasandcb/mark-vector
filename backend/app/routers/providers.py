from fastapi import APIRouter
from pydantic import BaseModel

from .. import storage
from ..providers.registry import list_providers

router = APIRouter(prefix="/api/providers", tags=["providers"])


class LLMDefaults(BaseModel):
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None


@router.get("")
async def get_providers():
    return await list_providers()


# What a document with no provider/model of its own starts on.
@router.get("/defaults")
def get_defaults():
    return storage.get_llm_defaults()


@router.put("/defaults")
def save_defaults(req: LLMDefaults):
    return storage.save_llm_defaults(req.model_dump())

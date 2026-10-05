import httpx2 as httpx
from fastapi import APIRouter, HTTPException

from ..config import settings

router = APIRouter(prefix="/api/hermes", tags=["hermes"])

# Read-only proxy onto the locally-running Hermes agent gateway's own
# session-browsing API (not the OpenAI-compatible /v1/chat/completions
# surface used for sending messages - see providers/registry.py). Proxied
# through the backend, rather than hit directly from the browser, so the
# gateway's API key (CUSTOM_OPENAI_PROVIDERS in .env) never reaches the
# frontend.


def _hermes_config() -> dict:
    cfg = next((p for p in settings.custom_providers if p["id"] == "hermes"), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Hermes provider is not configured")
    return cfg


def _api_root(cfg: dict) -> str:
    # base_url is the OpenAI-compatible chat endpoint (".../v1"); Hermes's
    # own session-browsing API lives at the same host's root, not under /v1.
    base = cfg["base_url"].rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


async def _hermes_get(path: str, params: dict | None = None) -> dict:
    cfg = _hermes_config()
    root = _api_root(cfg)
    headers = {"Authorization": f"Bearer {cfg.get('api_key', '')}"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{root}{path}", headers=headers, params=params)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=503, detail=f"Hermes 게이트웨이에 연결할 수 없습니다: {exc}")
    if resp.status_code == 401:
        raise HTTPException(status_code=502, detail="Hermes API 키가 올바르지 않습니다")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Hermes 요청 실패: {resp.status_code}")
    return resp.json()


@router.get("/config")
async def hermes_config():
    """Lets the frontend decide whether to show the "Hermes sessions" tree
    section at all - see app.js's init(). No auth needed beyond the app's
    own (this reveals nothing but a boolean); avoids the section flashing
    into view only to fail with a 404 the moment it's expanded."""
    return {"configured": any(p["id"] == "hermes" for p in settings.custom_providers)}


@router.get("/sessions")
async def list_hermes_sessions(offset: int = 0, limit: int = 50):
    return await _hermes_get("/api/sessions", params={"offset": offset, "limit": limit})


@router.get("/sessions/{session_id}/messages")
async def get_hermes_session_messages(session_id: str):
    return await _hermes_get(f"/api/sessions/{session_id}/messages")

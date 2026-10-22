"""Realtime speech-to-text for browsers without the Web Speech API (Chrome
and every other non-Safari browser on iOS - Apple only enables
SpeechRecognition in Safari itself), plus an optional Soniox engine.

OpenAI: the browser streams its microphone to the Realtime API over WebRTC
and gets transcript deltas back on a data channel. This server only takes
part in the handshake (the "unified interface"): the browser posts its SDP
offer here, and the offer goes on to /v1/realtime/calls together with the
session configuration and this server's own OPENAI_API_KEY - the key never
reaches the browser, and no audio passes through this server.

https://developers.openai.com/api/docs/guides/realtime-transcription
https://developers.openai.com/api/docs/guides/voice-webrtc
Billed per minute of audio streamed ($0.017/min for gpt-live-transcribe at
the time of writing), so the frontend only connects while dictating.

Soniox: the browser opens Soniox's realtime WebSocket itself. This server
only mints a temporary key (POST /v1/auth/temporary-api-key) with
SONIOX_API_KEY, which stays here. About $0.12/hour of audio sent.
"""

import json

import httpx2
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..config import settings

router = APIRouter(prefix="/api/stt", tags=["stt"])

MODEL = "gpt-live-transcribe"
CALLS_URL = "https://api.openai.com/v1/realtime/calls"
SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key"
# The temporary key only has to be presented while the socket opens.
SONIOX_EXPIRES_IN_SECONDS = 60
# One stream, long enough for a lecture. A forgotten microphone still hangs
# up client-side after three quiet minutes; this caps a session the client
# never closes. https://soniox.com/docs/guides/temporary-api-keys
SONIOX_MAX_SESSION_SECONDS = 3 * 60 * 60
# ISO-639-1 codes the dictation language select offers (ko-KR / en-US /
# ja-JP on the frontend); anything else is left to the model to detect.
_LANGUAGES = {"ko", "en", "ja"}


def _session_config(language: str | None) -> dict:
    transcription: dict = {"model": MODEL}
    if language in _LANGUAGES:
        transcription["languages"] = [language]
    # gpt-live-transcribe takes no server-side turn detection (VAD); the
    # browser commits each stretch of speech itself when it hears a pause.
    # No audio.format either: over WebRTC the format comes from the SDP.
    return {"type": "transcription", "audio": {"input": {"transcription": transcription, "turn_detection": None}}}


def _soniox_temp_key_body() -> dict:
    return {
        "usage_type": "transcribe_websocket",
        "expires_in_seconds": SONIOX_EXPIRES_IN_SECONDS,
        "single_use": True,
        "max_session_duration_seconds": SONIOX_MAX_SESSION_SECONDS,
    }


def _safe_upstream_detail(prefix: str, status_code: int, text: str) -> str:
    detail = f"{prefix} ({status_code}): {text[:300]}"
    secret = settings.soniox_api_key
    if secret and secret in detail:
        return f"{prefix} ({status_code})"
    return detail


@router.get("/config")
def stt_config():
    openai = bool(settings.openai_api_key)
    # `available` stays "OpenAI realtime is configured" so an older page
    # still means the same thing. `soniox` is the new flag.
    return {"available": openai, "openai": openai, "soniox": bool(settings.soniox_api_key), "model": MODEL}


@router.post("/session")
async def create_session(request: Request, language: str | None = None):
    if not settings.openai_api_key:
        raise HTTPException(status_code=400, detail="OPENAI_API_KEY is not configured")
    offer = (await request.body()).decode("utf-8", errors="replace")
    if not offer.strip().startswith("v="):
        raise HTTPException(status_code=400, detail="An SDP offer is required")
    files = {
        "sdp": (None, offer, "application/sdp"),
        "session": (None, json.dumps(_session_config(language)), "application/json"),
    }
    async with httpx2.AsyncClient(timeout=20) as client:
        resp = await client.post(CALLS_URL, headers={"Authorization": f"Bearer {settings.openai_api_key}"}, files=files)
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Realtime session failed ({resp.status_code}): {resp.text[:300]}")
    return Response(content=resp.text, media_type="application/sdp")


@router.post("/soniox/key")
async def create_soniox_key():
    """Mint a temporary Soniox key for one realtime transcription websocket.

    Authenticated like the rest of /api (see AuthMiddleware). The long-lived
    SONIOX_API_KEY is sent only to api.soniox.com.
    """
    if not settings.soniox_api_key:
        raise HTTPException(status_code=400, detail="SONIOX_API_KEY is not configured")
    async with httpx2.AsyncClient(timeout=20) as client:
        resp = await client.post(
            SONIOX_TEMP_KEY_URL,
            headers={
                "Authorization": f"Bearer {settings.soniox_api_key}",
                "Content-Type": "application/json",
            },
            json=_soniox_temp_key_body(),
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=_safe_upstream_detail("Soniox temporary key failed", resp.status_code, resp.text))
    try:
        payload = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Soniox temporary key response was not JSON")
    api_key = payload.get("api_key") if isinstance(payload, dict) else None
    if not isinstance(api_key, str) or not api_key:
        raise HTTPException(status_code=502, detail="Soniox temporary key response had no api_key")
    # The temporary key only. Anything else Soniox sent back stays here.
    out = {"api_key": api_key}
    expires_at = payload.get("expires_at")
    if isinstance(expires_at, str):
        out["expires_at"] = expires_at
    return out

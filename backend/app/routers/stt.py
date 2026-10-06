"""Realtime speech-to-text for browsers without the Web Speech API (Chrome
and every other non-Safari browser on iOS - Apple only enables
SpeechRecognition in Safari itself).

The browser streams its microphone to OpenAI's Realtime API over WebRTC
and gets transcript deltas back on a data channel. This server only takes
part in the handshake (the "unified interface"): the browser posts its SDP
offer here, and the offer goes on to /v1/realtime/calls together with the
session configuration and this server's own OPENAI_API_KEY - the key never
reaches the browser, and no audio passes through this server.

https://developers.openai.com/api/docs/guides/realtime-transcription
https://developers.openai.com/api/docs/guides/voice-webrtc
Billed per minute of audio streamed ($0.017/min for gpt-live-transcribe at
the time of writing), so the frontend only connects while dictating.
"""

import json

import httpx2
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from ..config import settings

router = APIRouter(prefix="/api/stt", tags=["stt"])

MODEL = "gpt-live-transcribe"
CALLS_URL = "https://api.openai.com/v1/realtime/calls"
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


@router.get("/config")
def stt_config():
    return {"available": bool(settings.openai_api_key), "model": MODEL}


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

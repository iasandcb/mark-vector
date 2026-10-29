"""X Articles user-auth API client. Credentials never leave the server."""

import base64
import hashlib
import hmac
import logging
import secrets
import time
from urllib.parse import quote, urlencode

import httpx2
from fastapi import HTTPException

from .config import settings

logger = logging.getLogger(__name__)

DRAFT_URL = "https://api.x.com/2/articles/draft"


def auth_mode() -> str | None:
    if all((settings.x_api_key, settings.x_api_secret, settings.x_access_token, settings.x_access_token_secret)):
        return "oauth1"
    if settings.x_user_access_token:
        return "oauth2"
    return None


def account_key() -> str:
    token = settings.x_access_token if auth_mode() == "oauth1" else settings.x_user_access_token
    return hashlib.sha256((token or "").encode()).hexdigest()


def _escape(value: str) -> str:
    return quote(value, safe="~-._")


def authorization(url: str) -> str:
    mode = auth_mode()
    if mode is None:
        raise HTTPException(503, "notConfigured")
    if mode == "oauth2":
        return f"Bearer {settings.x_user_access_token}"
    params = {
        "oauth_consumer_key": settings.x_api_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": settings.x_access_token,
        "oauth_version": "1.0",
    }
    normalized = urlencode(sorted(params.items()), quote_via=quote, safe="~")
    base = "&".join(_escape(part) for part in ("POST", url, normalized))
    key = f"{_escape(settings.x_api_secret)}&{_escape(settings.x_access_token_secret)}"
    params["oauth_signature"] = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    return "OAuth " + ", ".join(f'{_escape(k)}="{_escape(v)}"' for k, v in sorted(params.items()))


def create_draft(payload: dict) -> dict:
    url = DRAFT_URL
    headers = {"Authorization": authorization(url)}
    try:
        # No redirects or automatic retries: these calls create external state.
        with httpx2.Client(timeout=30.0, follow_redirects=False) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx2.RequestError:
        raise HTTPException(502, "connectionFailed") from None
    if response.status_code >= 300:
        code = {400: "invalidContent", 401: "authentication", 402: "credits", 403: "permission",
                404: "endpointUnavailable", 413: "articleTooLarge", 422: "invalidContent",
                429: "rateLimit"}.get(response.status_code, "upstreamUnavailable" if response.status_code >= 500 else "rejected")
        logger.warning("X article draft failed: status=%d category=%s", response.status_code, code)
        # Do not echo upstream response bodies (which may contain private data).
        raise HTTPException(502, code)
    try:
        data = response.json().get("data", {})
        identifier = data.get("id")
        if not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdigit():
            raise ValueError
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(502, "invalidResponse") from None
    return data

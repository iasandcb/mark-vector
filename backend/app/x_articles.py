"""X Articles user-auth API client. Credentials never leave the server."""

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlencode

import httpx2
from fastapi import HTTPException

from .config import settings

logger = logging.getLogger(__name__)

DRAFT_URL = "https://api.x.com/2/articles/draft"


def _error_diagnostic(response, payload: dict) -> str:
    """Bounded, redacted error fields for the authenticated requester only.

    Never log or persist these descriptions. Do not forward arbitrary body
    fields, headers, URLs, HTML responses or echoed request objects.
    """
    private = [getattr(settings, name) for name in (
        "x_api_key", "x_api_secret", "x_access_token", "x_access_token_secret", "x_user_access_token",
    )]
    private.append(payload.get("title"))
    content = payload.get("content_state", {})
    private.extend(block.get("text") for block in content.get("blocks", []))
    for entity in content.get("entities", []):
        private.extend(entity.get("value", {}).get("data", {}).values())
    variants = set()
    for value in private:
        if isinstance(value, str) and value:
            variants.update((value, quote(value, safe=""), json.dumps(value, ensure_ascii=True)[1:-1]))

    def text(value, length):
        if not isinstance(value, str):
            return None
        # An upstream error can echo authentication data. Drop such a field.
        if re.search(r"authorization|oauth_|\bbearer\s|api[_ -]?(?:key|secret)|access[_ -]?token", value, re.I):
            return "[redacted authentication data]"
        for secret in sorted(variants, key=len, reverse=True):
            value = value.replace(secret, "[redacted]")
        return " ".join(value.split())[:length] or None

    def code(value):
        if type(value) is int and 0 <= value <= 999_999:
            return value
        return None

    try:
        body = response.json()
    except (ValueError, TypeError):
        return '{"format":"non-json"}'
    if not isinstance(body, dict):
        return '{"format":"unexpected-json"}'
    info = {}
    # A type URI may contain private query strings. Only canonical problem URIs.
    problem = body.get("type")
    if isinstance(problem, str) and (problem == "about:blank" or re.fullmatch(
        r"https://api\.(?:x|twitter)\.com/2/problems/[a-z-]{1,64}", problem,
    )):
        info["type"] = problem
    for name, value in (("title", text(body.get("title"), 120)),
                        ("detail", text(body.get("detail"), 500)), ("code", code(body.get("code")))):
        if value is not None:
            info[name] = value
    errors = body.get("errors")
    if isinstance(errors, list):
        summaries = []
        for error in errors[:2]:
            if not isinstance(error, dict):
                continue
            summary = {key: value for key, value in (
                ("code", code(error.get("code"))), ("message", text(error.get("message"), 240)),
                ("detail", text(error.get("detail"), 240)),
            ) if value is not None}
            if summary:
                summaries.append(summary)
        if summaries:
            info["errors"] = summaries
    if not info:
        info["format"] = "no-error-fields"
    encoded = json.dumps(info, ensure_ascii=True, separators=(",", ":"))
    if len(encoded) > 6000:
        # Keep the response header below common HTTP header size limits.
        info.pop("errors", None)
        for key in ("title", "detail"):
            if key in info:
                info[key] = info[key][:160]
        encoded = json.dumps(info, ensure_ascii=True, separators=(",", ":"))
    return encoded


def _limit_diagnostics(response) -> tuple[str | None, dict[str, str]]:
    """Forward only known error types and numeric rate-limit metadata.

    Never copy the error body, request headers, URLs or credentials into an
    application response or log. A 429 can mean a usage cap, not just a
    short-lived rate limit.
    """
    headers = {}
    for upstream, outgoing in (
        ("x-rate-limit-limit", "X-RateLimit-Limit"),
        ("x-rate-limit-remaining", "X-RateLimit-Remaining"),
        ("x-rate-limit-reset", "X-RateLimit-Reset"),
    ):
        value = response.headers.get(upstream, "").strip()
        if value.isascii() and value.isdigit() and len(value) <= 12:
            headers[outgoing] = str(int(value))
    retry_after = response.headers.get("retry-after", "").strip()
    if retry_after.isascii() and retry_after.isdigit() and len(retry_after) <= 12:
        headers["Retry-After"] = str(int(retry_after))
    elif retry_after:
        try:
            date = parsedate_to_datetime(retry_after)
            if date.tzinfo is not None:
                headers["Retry-After"] = str(max(0, int(date.timestamp() - time.time()) + 1))
        except (ValueError, TypeError, OverflowError):
            pass
    problem = None
    try:
        body = response.json()
        if isinstance(body, dict):
            value = body.get("type")
            for candidate in ("usage-capped", "rate-limit-exceeded", "client-forbidden"):
                if value in (f"https://api.x.com/2/problems/{candidate}", f"https://api.twitter.com/2/problems/{candidate}"):
                    problem = candidate
                    headers["X-X-Error-Type"] = candidate
                    break
    except (ValueError, TypeError):
        pass
    return problem, headers


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
        diagnostic_headers = {}
        if response.status_code == 429:
            problem, diagnostic_headers = _limit_diagnostics(response)
            diagnostic_headers["X-X-Error-Info"] = _error_diagnostic(response, payload)
            diagnostic_headers["Cache-Control"] = "no-store"
            if problem == "usage-capped":
                code = "usageCap"
            logger.warning(
                "X article limit: problem=%s limit=%s remaining=%s reset=%s retry_after=%s",
                problem, diagnostic_headers.get("X-RateLimit-Limit"),
                diagnostic_headers.get("X-RateLimit-Remaining"),
                diagnostic_headers.get("X-RateLimit-Reset"), diagnostic_headers.get("Retry-After"),
            )
        logger.warning("X article draft failed: status=%d category=%s", response.status_code, code)
        # Only selected, redacted 429 fields reach the authenticated requester.
        raise HTTPException(502, code, headers=diagnostic_headers)
    try:
        data = response.json().get("data", {})
        identifier = data.get("id")
        if not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdigit():
            raise ValueError
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(502, "invalidResponse") from None
    return data

import json
import os
import re
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _load_custom_providers() -> list[dict]:
    """Parses CUSTOM_OPENAI_PROVIDERS, a JSON array of OpenAI-compatible
    endpoints, e.g.:
      [{"id": "hermes", "label": "Hermes (Nous)",
        "base_url": "https://inference-api.nousresearch.com/v1",
        "api_key": "...", "models": ["Hermes-4-70B"]}]
    "models" is optional - if omitted, the model list is fetched from the
    endpoint's own /v1/models. Malformed JSON is treated as "none configured"
    rather than crashing the app.
    """
    raw = os.getenv("CUSTOM_OPENAI_PROVIDERS", "")
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [p for p in parsed if isinstance(p, dict) and p.get("id") and p.get("base_url")]


def _load_allowed_emails() -> list[str]:
    """Comma-separated Google allowlist.

    Unset or blank allows nobody. There is no built-in address, so a public
    checkout does not ship a personal default.
    """
    raw = os.getenv("ALLOWED_EMAILS", "")
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


def _load_storage_warn_percent() -> float:
    """When the data volume is at least this full, the workspace warns.

    ``STORAGE_WARN_PERCENT`` is a number from 0 to 100. Anything else
    (unset, blank, not a number, out of range) is 80, the same way a bad
    ``CUSTOM_OPENAI_PROVIDERS`` value is ignored instead of crashing.
    """
    raw = os.getenv("STORAGE_WARN_PERCENT", "").strip()
    if not raw:
        return 80.0
    try:
        value = float(raw)
    except ValueError:
        return 80.0
    if value != value or value in (float("inf"), float("-inf")) or not 0 <= value <= 100:
        return 80.0
    return value


def _load_passcode() -> str | None:
    """A lighter-weight alternate to Google sign-in (see auth.py's
    /auth/passcode) for gating a public test deployment without setting up
    an OAuth client/redirect URIs first. Kept to exactly 4 digits, as
    requested; anything else in the env var is treated as "not configured"
    rather than crashing the app, same as CUSTOM_OPENAI_PROVIDERS above."""
    raw = os.getenv("APP_PASSCODE", "").strip()
    return raw if re.fullmatch(r"\d{4}", raw) else None


@dataclass
class Settings:
    data_dir: str = os.getenv("DATA_DIR", "../data")
    anthropic_api_key: str | None = os.getenv("ANTHROPIC_API_KEY") or None
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY") or None
    # Long-lived Soniox key. The browser never sees it — /api/stt/soniox/key
    # mints a short-lived temporary key. Unset = Soniox is not offered.
    soniox_api_key: str | None = os.getenv("SONIOX_API_KEY") or None
    xai_api_key: str | None = os.getenv("XAI_API_KEY") or None
    # X Articles (separate from xAI/Grok). OAuth 1.0a user credentials,
    # or an OAuth 2.0 user-context access token with tweet.write.
    x_api_key: str | None = os.getenv("X_API_KEY") or None
    x_api_secret: str | None = os.getenv("X_API_SECRET") or None
    x_access_token: str | None = os.getenv("X_ACCESS_TOKEN") or None
    x_access_token_secret: str | None = os.getenv("X_ACCESS_TOKEN_SECRET") or None
    x_user_access_token: str | None = os.getenv("X_USER_ACCESS_TOKEN") or None
    custom_providers: list[dict] = field(default_factory=_load_custom_providers)
    # Google sign-in is off entirely until both of these are set (see
    # auth.AuthMiddleware) - so a fresh checkout keeps working with no auth,
    # exactly like before this was added, until deliberately turned on.
    google_client_id: str | None = os.getenv("GOOGLE_CLIENT_ID") or None
    google_client_secret: str | None = os.getenv("GOOGLE_CLIENT_SECRET") or None
    allowed_emails: list[str] = field(default_factory=_load_allowed_emails)
    # Independent of Google sign-in above - either one alone is enough to
    # turn auth on (see auth.AuthMiddleware), and both can be configured at
    # once so either grants access.
    app_passcode: str | None = field(default_factory=_load_passcode)
    # The bearer token a bot uploads audio with (routers/ingest.py) - that
    # route is off until it's set - and the day its date folders follow.
    ingest_token: str | None = os.getenv("INGEST_TOKEN") or None
    ingest_timezone: str = os.getenv("INGEST_TIMEZONE", "Asia/Seoul")
    # A different secret for the machine that pulls recordings and uploads
    # them to YouTube (routers/worker.py). Not the ingest token: that one
    # only grants the ability to drop a file in. Unset, the worker API is off.
    worker_token: str | None = os.getenv("WORKER_TOKEN") or None
    # Workspace banner once shutil.disk_usage(DATA_DIR) reaches this percent.
    storage_warn_percent: float = field(default_factory=_load_storage_warn_percent)


settings = Settings()

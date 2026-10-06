import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

from .. import chatgpt_auth
from ..config import settings
from .anthropic_provider import AnthropicProvider
from .base import LLMProvider
from .chatgpt_provider import ChatGPTProvider
from .openai_provider import OpenAIProvider

STATIC_PROVIDER_INFO: dict[str, dict] = {
    "openai": {"label": "OpenAI", "preferred_default_model": "gpt-5.6-luna"},
    "anthropic": {"label": "Anthropic", "preferred_default_model": None},
    # The user's own ChatGPT plan instead of an API key - configured by
    # signing in with `python -m app.chatgpt_auth login` (+ `push` for Fly).
    # The frontend shows a translated label instead when it has one for this
    # id (i18n "provider.label.chatgpt") - this English one is the fallback.
    "chatgpt": {"label": "ChatGPT (my plan)", "preferred_default_model": None},
}

_instances: dict[str, LLMProvider] = {}

MODELS_CACHE_TTL = 300  # seconds
# A provider's /models call gets this long before the last-known list is
# used instead - the OpenAI SDK's own default (10 min timeout, 2 retries)
# once held the whole picker, and with it the app's first paint, for 30s+
# while OpenAI's /v1/models was returning 504s.
MODELS_FETCH_TIMEOUT = 8  # seconds
# After a failed refresh, how long to keep serving the last-known list
# before trying the provider again.
MODELS_RETRY_AFTER = 60  # seconds
_models_cache: dict[str, tuple[float, list[str], dict[str, list[str]]]] = {}
# In-flight background refreshes, one per provider at most.
_refreshing: dict[str, asyncio.Task] = {}


def _custom_provider_config(provider_id: str) -> dict | None:
    return next((p for p in settings.custom_providers if p["id"] == provider_id), None)


def _provider_catalog() -> list[tuple[str, dict]]:
    """All known provider ids with their display info, static first then
    whatever's configured in CUSTOM_OPENAI_PROVIDERS."""
    custom = [
        (
            p["id"],
            {"label": p.get("label", p["id"]), "preferred_default_model": p.get("default_model")},
        )
        for p in settings.custom_providers
    ]
    return list(STATIC_PROVIDER_INFO.items()) + custom


def get_provider(provider_id: str) -> LLMProvider:
    if provider_id in _instances:
        return _instances[provider_id]

    if provider_id == "anthropic":
        _instances[provider_id] = AnthropicProvider(settings.anthropic_api_key)
    elif provider_id == "openai":
        _instances[provider_id] = OpenAIProvider(settings.openai_api_key)
    elif provider_id == "chatgpt":
        _instances[provider_id] = ChatGPTProvider(chatgpt_auth.credentials)
    else:
        cfg = _custom_provider_config(provider_id)
        if cfg is None:
            raise ValueError(f"Unknown provider: {provider_id}")
        _instances[provider_id] = OpenAIProvider(
            cfg.get("api_key"),
            base_url=cfg["base_url"],
            static_models=cfg.get("models"),
            filter_models=False,
            label=cfg.get("label", cfg["id"]),
        )
    return _instances[provider_id]


def _is_configured(provider_id: str) -> bool:
    if provider_id == "anthropic":
        return bool(settings.anthropic_api_key)
    if provider_id == "openai":
        return bool(settings.openai_api_key)
    if provider_id == "chatgpt":
        return chatgpt_auth.credentials.available()
    cfg = _custom_provider_config(provider_id)
    return bool(cfg and cfg.get("api_key") and cfg.get("base_url"))


def _disk_cache_path() -> Path:
    return Path(settings.data_dir) / "models-cache.json"


def _read_disk_cache() -> dict:
    try:
        return json.loads(_disk_cache_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_disk_cache(provider_id: str, models: list[str], reasoning_efforts: dict[str, list[str]]) -> None:
    """The last list each provider successfully returned, kept across
    restarts so a provider that's down right after a deploy still shows up
    with its models. Atomic write; a failure here only loses the cache."""
    data = _read_disk_cache()
    data[provider_id] = {"models": models, "reasoning_efforts": reasoning_efforts, "fetched_at": time.time()}
    path = _disk_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".models-cache-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass


def _last_known(provider_id: str) -> tuple[list[str], dict[str, list[str]]] | None:
    cached = _models_cache.get(provider_id)
    if cached and cached[1]:
        return cached[1], cached[2]
    entry = _read_disk_cache().get(provider_id)
    if entry and entry.get("models"):
        return entry["models"], entry.get("reasoning_efforts", {})
    return None


async def _fetch_models(provider_id: str) -> tuple[list[str], dict[str, list[str]]]:
    """One live /models round trip, bounded by MODELS_FETCH_TIMEOUT. An
    empty list counts as a failure - it never replaces a good one."""
    provider = get_provider(provider_id)

    async def fetch():
        models = await provider.list_models()
        return models, await provider.reasoning_efforts(models)

    models, reasoning_efforts = await asyncio.wait_for(fetch(), MODELS_FETCH_TIMEOUT)
    if not models:
        raise RuntimeError(f"{provider_id} returned no models")
    _models_cache[provider_id] = (time.monotonic(), models, reasoning_efforts)
    _write_disk_cache(provider_id, models, reasoning_efforts)
    return models, reasoning_efforts


def _mark_retry_later(provider_id: str, fallback: tuple[list[str], dict[str, list[str]]] | None) -> None:
    models, efforts = fallback or ([], {})
    _models_cache[provider_id] = (time.monotonic() - MODELS_CACHE_TTL + MODELS_RETRY_AFTER, models, efforts)


def _schedule_refresh(provider_id: str, fallback: tuple[list[str], dict[str, list[str]]]) -> None:
    if provider_id in _refreshing and not _refreshing[provider_id].done():
        return

    async def refresh():
        try:
            await _fetch_models(provider_id)
        except Exception:
            _mark_retry_later(provider_id, fallback)

    _refreshing[provider_id] = asyncio.create_task(refresh())


async def _cached_models(provider_id: str) -> tuple[list[str], dict[str, list[str]]]:
    """Returns (models, reasoning_efforts) - the second maps whichever of the
    first support reasoning to the effort levels each of them accepts.

    Stale-while-revalidate: once any list is known for a provider (in
    memory, or on disk from an earlier run), it's returned immediately and
    refreshed in the background - so a slow or failing /models never holds
    up the picker. Only a provider with no list ever recorded waits on a
    live fetch (bounded by MODELS_FETCH_TIMEOUT)."""
    cached = _models_cache.get(provider_id)
    if cached and time.monotonic() - cached[0] < MODELS_CACHE_TTL:
        return cached[1], cached[2]
    known = _last_known(provider_id)
    if known:
        _schedule_refresh(provider_id, known)
        return known
    try:
        return await _fetch_models(provider_id)
    except Exception:
        _mark_retry_later(provider_id, None)
        return [], {}


async def list_providers() -> list[dict]:
    """Only ever returns providers with an API key actually set - an
    unconfigured one (no ANTHROPIC_API_KEY, no OPENAI_API_KEY, a
    CUSTOM_OPENAI_PROVIDERS entry missing api_key/base_url, ...) has nothing
    usable to offer and would just be dead weight in the picker."""
    configured = [(pid, info) for pid, info in _provider_catalog() if _is_configured(pid)]
    # Concurrently, so one provider still on its first (live) fetch costs
    # its own timeout at most rather than adding to everyone else's.
    fetched = await asyncio.gather(*(_cached_models(pid) for pid, _ in configured))
    result = []
    for (provider_id, info), (models, reasoning_efforts) in zip(configured, fetched):
        preferred = info.get("preferred_default_model")
        if preferred and preferred in models:
            default_model = preferred
        else:
            default_model = models[0] if models else None
        result.append(
            {
                "id": provider_id,
                "label": info["label"],
                "models": models,
                "default_model": default_model,
                # {model: [levels]} for whichever of `models` support
                # reasoning at all - the keys say which models the reasoning
                # selector applies to, the values which levels it should
                # offer for each. See LLMProvider.reasoning_efforts.
                "reasoning_efforts": reasoning_efforts,
                # {model: level} - what "Default" (no setting sent) means on
                # each of those models, where known. See
                # LLMProvider.reasoning_default.
                "reasoning_defaults": {
                    m: level for m in reasoning_efforts if (level := get_provider(provider_id).reasoning_default(m))
                },
            }
        )
    return result

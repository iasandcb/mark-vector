import asyncio
import functools

import pytest

from app.config import settings
from app.providers import registry


def async_test(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        asyncio.run(fn(*args, **kwargs))

    return wrapper


class _FakeProvider:
    """Stands in for AnthropicProvider/OpenAIProvider - list_providers()
    only needs list_models(), reasoning_efforts() and reasoning_default()
    from it."""

    def __init__(self, models, reasoning_models):
        self._models = models
        self._reasoning_models = reasoning_models

    async def list_models(self):
        return self._models

    async def reasoning_efforts(self, models):
        return {m: ["low", "medium", "high"] for m in self._reasoning_models}

    def reasoning_default(self, model):
        return "high" if model == "claude-opus-5" else None

    async def stream(self, *args, **kwargs):
        raise NotImplementedError


@pytest.fixture(autouse=True)
def _isolated_registry_state(monkeypatch, tmp_path):
    # list_providers() persists the last-known lists (models-cache.json)
    # under data_dir - never into the real one.
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(registry, "_refreshing", {})
    # get_provider()/list_providers() memoize into module-level dicts -
    # reset both so one test's fake provider/cached models can't leak into
    # the next.
    monkeypatch.setattr(registry, "_instances", {})
    monkeypatch.setattr(registry, "_models_cache", {})


@async_test
async def test_list_providers_includes_reasoning_models(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "fake")
    monkeypatch.setattr(settings, "openai_api_key", None)
    monkeypatch.setattr(settings, "custom_providers", [])
    registry._instances["anthropic"] = _FakeProvider(
        models=["claude-opus-5", "claude-haiku-3"],
        reasoning_models=["claude-opus-5"],
    )

    result = await registry.list_providers()

    assert len(result) == 1
    assert result[0]["id"] == "anthropic"
    assert result[0]["models"] == ["claude-opus-5", "claude-haiku-3"]
    assert result[0]["reasoning_efforts"] == {"claude-opus-5": ["low", "medium", "high"]}
    assert result[0]["reasoning_defaults"] == {"claude-opus-5": "high"}


@async_test
async def test_list_providers_omits_unconfigured_providers(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    monkeypatch.setattr(settings, "openai_api_key", None)
    monkeypatch.setattr(settings, "custom_providers", [])

    result = await registry.list_providers()

    assert result == []

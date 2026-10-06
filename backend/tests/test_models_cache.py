import asyncio
import json
import time

import pytest

from app.config import settings
from app.providers import registry


class _Provider:
    def __init__(self, models=None, hang=False, fail=False):
        self.models = models or []
        self.hang = hang
        self.fail = fail
        self.calls = 0

    async def list_models(self):
        self.calls += 1
        if self.hang:
            await asyncio.sleep(3600)
        if self.fail:
            raise RuntimeError("504")
        return self.models

    async def reasoning_efforts(self, models):
        return {m: ["low", "high"] for m in models if m.startswith("r")}

    def reasoning_default(self, model):
        return None


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    monkeypatch.setattr(settings, "openai_api_key", "fake")
    monkeypatch.setattr(settings, "custom_providers", [])
    monkeypatch.setattr(registry, "_instances", {})
    monkeypatch.setattr(registry, "_models_cache", {})
    monkeypatch.setattr(registry, "_refreshing", {})
    monkeypatch.setattr(registry, "MODELS_FETCH_TIMEOUT", 0.2)


def _models(result, provider_id="openai"):
    return next(p for p in result if p["id"] == provider_id)["models"]


def test_successful_fetch_is_persisted():
    registry._instances["openai"] = _Provider(["gpt-a", "r-1"])
    result = asyncio.run(registry.list_providers())
    assert _models(result) == ["gpt-a", "r-1"]
    saved = json.loads(registry._disk_cache_path().read_text())
    assert saved["openai"]["models"] == ["gpt-a", "r-1"]
    assert saved["openai"]["reasoning_efforts"] == {"r-1": ["low", "high"]}


def test_down_provider_serves_last_known_list_immediately():
    registry._write_disk_cache("openai", ["gpt-old"], {})
    registry._instances["openai"] = _Provider(hang=True)

    async def run():
        started = time.monotonic()
        result = await registry.list_providers()
        elapsed = time.monotonic() - started
        await asyncio.gather(*registry._refreshing.values())
        return result, elapsed

    result, elapsed = asyncio.run(run())
    assert _models(result) == ["gpt-old"]
    assert elapsed < 0.1  # didn't wait for the hanging provider at all
    # The failed background refresh keeps the old list and backs off.
    stamp, models, _ = registry._models_cache["openai"]
    assert models == ["gpt-old"]
    assert time.monotonic() - stamp > registry.MODELS_CACHE_TTL - registry.MODELS_RETRY_AFTER - 1


def test_no_known_list_waits_at_most_the_timeout():
    registry._instances["openai"] = _Provider(hang=True)
    started = time.monotonic()
    result = asyncio.run(registry.list_providers())
    assert _models(result) == []
    assert time.monotonic() - started < 1


def test_stale_list_is_refreshed_in_background():
    provider = _Provider(["gpt-new"])
    registry._instances["openai"] = provider
    registry._models_cache["openai"] = (time.monotonic() - registry.MODELS_CACHE_TTL - 1, ["gpt-old"], {})

    async def run():
        first = await registry.list_providers()
        await asyncio.gather(*registry._refreshing.values())
        return first, await registry.list_providers()

    first, second = asyncio.run(run())
    assert _models(first) == ["gpt-old"]
    assert _models(second) == ["gpt-new"]
    assert provider.calls == 1


def test_empty_result_never_replaces_a_good_list():
    registry._write_disk_cache("openai", ["gpt-old"], {})
    registry._instances["openai"] = _Provider([])

    async def run():
        await registry.list_providers()
        await asyncio.gather(*registry._refreshing.values())

    asyncio.run(run())
    assert json.loads(registry._disk_cache_path().read_text())["openai"]["models"] == ["gpt-old"]
    assert registry._models_cache["openai"][1] == ["gpt-old"]


def test_one_slow_provider_does_not_delay_the_others(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "fake")
    registry._instances["openai"] = _Provider(hang=True)
    registry._instances["anthropic"] = _Provider(["claude-x"])
    started = time.monotonic()
    result = asyncio.run(registry.list_providers())
    assert _models(result, "anthropic") == ["claude-x"]
    assert time.monotonic() - started < 0.5  # one timeout, not one per provider

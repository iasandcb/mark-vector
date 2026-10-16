import asyncio
import functools

import pytest

from app.providers.anthropic_provider import WEB_FETCH_TOOL, AnthropicProvider
from app.providers.openai_provider import OpenAIProvider, _is_current_chat_model


def async_test(fn):
    """pytest-asyncio isn't a project dependency - this just runs the async
    test body to completion via asyncio.run(), which is all a plain
    request/response-shaped async test needs."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        asyncio.run(fn(*args, **kwargs))

    return wrapper


# ---------- shared fakes: mimic the SDKs' "async with ... as stream: async
# for event in stream" streaming protocol without any real network I/O ----------


class _FakeAsyncStream:
    def __init__(self, events):
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        for event in self._events:
            yield event


class _Obj:
    """A plain attribute bag - stand-in for the SDKs' typed event/response
    models, which tests have no need to construct for real."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


# ---------- AnthropicProvider ----------


def _anthropic_events():
    return [
        _Obj(type="content_block_start", index=0, content_block=_Obj(type="server_tool_use", name="web_fetch")),
        _Obj(type="content_block_stop", index=0),
        _Obj(type="content_block_start", index=1, content_block=_Obj(type="text")),
        _Obj(type="content_block_delta", index=1, delta=_Obj(type="text_delta", text="안녕")),
        _Obj(type="content_block_delta", index=1, delta=_Obj(type="text_delta", text="하세요")),
        _Obj(type="content_block_stop", index=1),
    ]


@async_test
async def test_anthropic_declares_web_fetch_tool(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    captured = {}

    def fake_stream(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream(_anthropic_events())

    monkeypatch.setattr(provider._client.messages, "stream", fake_stream)

    events = [e async for e in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-5")]

    assert captured["tools"] == [WEB_FETCH_TOOL]
    assert events == [
        {"type": "tool_status", "status": "running", "tool": "web_fetch", "emoji": "🌐", "label": "웹 페이지 가져오는 중"},
        {"type": "tool_status", "status": "completed", "tool": "web_fetch", "emoji": "✅", "label": "웹 페이지 가져오기 완료"},
        {"type": "text", "text": "안녕"},
        {"type": "text", "text": "하세요"},
    ]


@async_test
async def test_anthropic_ignores_non_tool_block_stops(monkeypatch):
    """A plain text block's content_block_stop must not be mistaken for a
    tool call finishing - only indices seen in a server_tool_use start
    should ever produce a "completed" tool_status."""
    provider = AnthropicProvider(api_key="fake")

    def fake_stream(**kwargs):
        return _FakeAsyncStream(
            [
                _Obj(type="content_block_start", index=0, content_block=_Obj(type="text")),
                _Obj(type="content_block_delta", index=0, delta=_Obj(type="text_delta", text="hi")),
                _Obj(type="content_block_stop", index=0),
            ]
        )

    monkeypatch.setattr(provider._client.messages, "stream", fake_stream)

    events = [e async for e in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-5")]
    assert events == [{"type": "text", "text": "hi"}]


@async_test
async def test_anthropic_raises_when_unconfigured():
    provider = AnthropicProvider(api_key=None)
    with pytest.raises(RuntimeError):
        async for _ in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-5"):
            pass


# ---------- AnthropicProvider - capability-driven thinking ----------
# budget_tokens now 400s on current models (Opus 5, Sonnet 5, Fable 5/5.1,
# Opus 4.7/4.8) and adaptive thinking likely 400s on older ones (Sonnet 4.5,
# Haiku 4.5, ...) - there's no single request shape safe for both, so the
# right one is chosen per model from what models.list()/retrieve() actually
# reports supported, never guessed from the model id string.


def _support(supported):
    return _Obj(supported=supported)


def _capabilities(*, adaptive, enabled, effort_supported=True, effort_levels=("low", "medium", "high")):
    return _Obj(
        thinking=_Obj(
            supported=adaptive or enabled,
            types=_Obj(adaptive=_support(adaptive), enabled=_support(enabled)),
        ),
        effort=_Obj(
            supported=effort_supported,
            low=_support("low" in effort_levels),
            medium=_support("medium" in effort_levels),
            high=_support("high" in effort_levels),
        ),
    )


async def _stream_with_capabilities(provider, monkeypatch, model, reasoning_effort, capabilities):
    captured = {}
    provider._capabilities_cache[model] = capabilities

    def fake_stream(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream([])

    monkeypatch.setattr(provider._client.messages, "stream", fake_stream)
    async for _ in provider.stream([{"role": "user", "content": "hi"}], model, reasoning_effort=reasoning_effort):
        pass
    return captured


@async_test
async def test_current_model_uses_adaptive_thinking_and_effort(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    caps = _capabilities(adaptive=True, enabled=False)
    captured = await _stream_with_capabilities(provider, monkeypatch, "claude-opus-5", "high", caps)

    assert captured["thinking"] == {"type": "adaptive"}
    assert captured["output_config"] == {"effort": "high"}
    assert captured["max_tokens"] == 64000
    assert "budget_tokens" not in captured.get("thinking", {})


@async_test
async def test_adaptive_model_without_effort_support_skips_output_config(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    caps = _capabilities(adaptive=True, enabled=False, effort_supported=False)
    captured = await _stream_with_capabilities(provider, monkeypatch, "claude-opus-5", "high", caps)

    assert captured["thinking"] == {"type": "adaptive"}
    assert "output_config" not in captured


@async_test
async def test_legacy_model_uses_budget_tokens(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    caps = _capabilities(adaptive=False, enabled=True)
    captured = await _stream_with_capabilities(provider, monkeypatch, "claude-haiku-4-5", "medium", caps)

    assert captured["thinking"] == {"type": "enabled", "budget_tokens": 8000}
    assert captured["max_tokens"] == 8000 + 4096
    assert "output_config" not in captured


@async_test
async def test_model_with_no_thinking_support_falls_back_silently(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    caps = _capabilities(adaptive=False, enabled=False)
    captured = await _stream_with_capabilities(provider, monkeypatch, "claude-haiku-3", "high", caps)

    assert "thinking" not in captured
    assert "output_config" not in captured
    assert captured["max_tokens"] == 4096


@async_test
async def test_reasoning_off_skips_capability_lookup_entirely(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    captured = {}

    def fake_stream(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream([])

    async def fail_retrieve(model_id):
        raise AssertionError("should not look up capabilities when reasoning is off")

    monkeypatch.setattr(provider._client.messages, "stream", fake_stream)
    monkeypatch.setattr(provider._client.models, "retrieve", fail_retrieve)

    async for _ in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-5", reasoning_effort="off"):
        pass
    assert "thinking" not in captured
    # Claude Opus 5 thinks by default even with no setting sent, and that
    # thinking counts toward max_tokens - so the cap is the thinking one.
    assert captured["max_tokens"] == 64000

    captured.clear()
    async for _ in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-4-8", reasoning_effort="off"):
        pass
    assert "thinking" not in captured
    assert captured["max_tokens"] == 4096


@async_test
async def test_list_models_populates_capability_cache(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    caps = _capabilities(adaptive=True, enabled=False)
    fake_models = _FakeAsyncStream([_Obj(id="claude-opus-5", capabilities=caps)])

    monkeypatch.setattr(provider._client.models, "list", lambda: fake_models)

    ids = await provider.list_models()
    assert ids == ["claude-opus-5"]
    assert provider._capabilities_cache["claude-opus-5"] is caps

    # stream() must reuse the cache from list_models() rather than calling
    # models.retrieve() again for a model already seen.
    async def fail_retrieve(model_id):
        raise AssertionError("should have reused the cache populated by list_models()")

    monkeypatch.setattr(provider._client.models, "retrieve", fail_retrieve)
    captured = {}

    def fake_stream(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream([])

    monkeypatch.setattr(provider._client.messages, "stream", fake_stream)
    async for _ in provider.stream([{"role": "user", "content": "hi"}], "claude-opus-5", reasoning_effort="low"):
        pass
    assert captured["thinking"] == {"type": "adaptive"}


@async_test
async def test_reasoning_capable_models_filters_by_thinking_support(monkeypatch):
    provider = AnthropicProvider(api_key="fake")
    provider._capabilities_cache["claude-opus-5"] = _capabilities(adaptive=True, enabled=False)
    provider._capabilities_cache["claude-haiku-4-5"] = _capabilities(adaptive=False, enabled=True)
    provider._capabilities_cache["claude-haiku-3"] = _capabilities(adaptive=False, enabled=False)

    result = await provider.reasoning_capable_models(["claude-opus-5", "claude-haiku-4-5", "claude-haiku-3"])

    assert result == ["claude-opus-5", "claude-haiku-4-5"]


# ---------- OpenAIProvider - real OpenAI (Responses API + web_search) ----------


def _openai_events():
    return [
        _Obj(type="response.web_search_call.in_progress"),
        _Obj(type="response.web_search_call.searching"),
        _Obj(type="response.web_search_call.completed"),
        _Obj(type="response.output_text.delta", delta="안녕"),
        _Obj(type="response.output_text.delta", delta="하세요"),
        _Obj(type="response.completed"),
    ]


@async_test
async def test_openai_real_provider_uses_responses_api_with_web_search(monkeypatch):
    provider = OpenAIProvider(api_key="fake")  # base_url=None -> real OpenAI
    assert provider._is_real_openai is True
    captured = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream(_openai_events())

    monkeypatch.setattr(provider._client.responses, "create", fake_create)

    messages = [{"role": "user", "content": "hi"}]
    events = [e async for e in provider.stream(messages, "gpt-5.6-luna", system_prompt="be nice")]

    assert captured["tools"] == [{"type": "web_search"}]
    assert captured["input"] is messages  # no reshaping needed - same {"role","content"} shape
    assert captured["instructions"] == "be nice"
    assert "reasoning" not in captured  # reasoning_effort not passed -> omitted
    assert events == [
        {"type": "tool_status", "status": "running", "tool": "web_search", "emoji": "🌐", "label": "웹 검색 준비 중"},
        {"type": "tool_status", "status": "running", "tool": "web_search", "emoji": "🌐", "label": "웹 검색 중"},
        {"type": "tool_status", "status": "completed", "tool": "web_search", "emoji": "✅", "label": "웹 검색 완료"},
        {"type": "text", "text": "안녕"},
        {"type": "text", "text": "하세요"},
    ]


@async_test
async def test_openai_reasoning_effort_maps_to_reasoning_param(monkeypatch):
    provider = OpenAIProvider(api_key="fake")
    captured = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream([])

    monkeypatch.setattr(provider._client.responses, "create", fake_create)

    async for _ in provider.stream([{"role": "user", "content": "hi"}], "gpt-5.6-luna", reasoning_effort="high"):
        pass
    assert captured["reasoning"] == {"effort": "high"}


@async_test
async def test_openai_reasoning_off_is_omitted(monkeypatch):
    provider = OpenAIProvider(api_key="fake")
    captured = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _FakeAsyncStream([])

    monkeypatch.setattr(provider._client.responses, "create", fake_create)

    async for _ in provider.stream([{"role": "user", "content": "hi"}], "gpt-5.6-luna", reasoning_effort="off"):
        pass
    assert "reasoning" not in captured


@async_test
async def test_openai_response_failed_raises(monkeypatch):
    provider = OpenAIProvider(api_key="fake")

    async def fake_create(**kwargs):
        return _FakeAsyncStream([_Obj(type="response.failed", response=_Obj(error="boom"))])

    monkeypatch.setattr(provider._client.responses, "create", fake_create)

    with pytest.raises(RuntimeError, match="boom"):
        async for _ in provider.stream([{"role": "user", "content": "hi"}], "gpt-5.6-luna"):
            pass


def test_gpt_6_1_sol_survives_the_chat_model_filter_and_is_selectable():
    """Dated snapshots and non-chat models are dropped; the default model is not."""
    assert _is_current_chat_model("gpt-6.1-sol") is True
    assert _is_current_chat_model("gpt-4o-2024-08-06") is False

    provider = OpenAIProvider(api_key="fake")
    efforts = asyncio.run(provider.reasoning_efforts(["gpt-6.1-sol", "gpt-4o"]))
    assert "gpt-6.1-sol" in efforts
    assert "low" in efforts["gpt-6.1-sol"]
    assert "gpt-4o" not in efforts
    assert provider.reasoning_default("gpt-6.1-sol") == "medium"


@async_test
async def test_openai_reasoning_capable_models_matches_by_name_pattern():
    provider = OpenAIProvider(api_key="fake")
    models = ["gpt-5.6-luna", "gpt-5-mini", "o1", "o3-mini", "o4-mini", "gpt-4o", "gpt-4.1", "text-embedding-3-large"]

    result = await provider.reasoning_capable_models(models)

    assert result == ["gpt-5.6-luna", "gpt-5-mini", "o1", "o3-mini", "o4-mini"]


# ---------- OpenAIProvider - custom base_url (Hermes/Together/etc.) must be
# unaffected: no Responses API, no web_search, exact prior Chat Completions
# behavior ----------


def test_custom_base_url_does_not_use_real_openai_path():
    provider = OpenAIProvider(api_key="fake", base_url="http://127.0.0.1:8642/v1")
    assert provider._is_real_openai is False

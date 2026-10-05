from typing import AsyncIterator

from anthropic import AsyncAnthropic
from anthropic.types import ModelCapabilities

from .base import REASONING_LEVELS, LLMProvider

# Legacy thinking-budget fallback, for models whose capabilities say they
# support only thinking type "enabled" (pre-4.6: Sonnet 4.5, Haiku 4.5,
# Opus 4.5, and older) - current models (Fable 5/5.1, Opus 5/4.8/4.7/4.6,
# Sonnet 5/4.6) use adaptive thinking + output_config.effort instead, chosen
# per request from the model's own reported capabilities (see
# _capabilities/stream below) rather than guessed from the model id string,
# since `budget_tokens` now gets a 400 on current models and `thinking:
# {type: "adaptive"}` likely 400s on older ones - there's no single request
# shape that's safe for both generations.
THINKING_BUDGETS = {"low": 2000, "medium": 8000, "high": 24000}
# Levels that exist elsewhere (an adaptive Anthropic model's xhigh/max, an
# OpenAI model's none/minimal - see base.REASONING_LEVELS) but have no
# budget of their own here: a request still carrying one of those from a
# previous model gets the nearest budget in the same direction rather than
# an arbitrary one.
_BUDGET_LEVEL_FALLBACKS = {"none": "low", "minimal": "low", "xhigh": "high", "max": "high"}
DEFAULT_MAX_TOKENS = 4096
# Adaptive thinking has no fixed budget of its own (depth is controlled by
# output_config.effort instead) and can legitimately produce a lot of output
# on a hard problem - matches the general "streaming request" max_tokens
# guidance rather than the small non-thinking default above.
ADAPTIVE_THINKING_MAX_TOKENS = 64000

# Hosted server tool - runs on Anthropic's own infrastructure (no load on
# this backend) and only fetches a URL already present in the conversation,
# not an arbitrary crawl - see
# https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool.
# No beta header needed. max_uses caps how many fetches one turn can make.
# allowed_callers=["direct"] pins invocation to a normal model-initiated
# call - without it, some models default to requiring "programmatic tool
# calling" (invocation from inside the code_execution tool) for web_fetch,
# which not every model supports and which this app never opts into for any
# of its own tools anyway; omitting it 400s outright on those models
# ('claude-haiku-4-5-20251001' does not support programmatic tool calling').
WEB_FETCH_TOOL = {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5, "allowed_callers": ["direct"]}


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str | None):
        self._client = AsyncAnthropic(api_key=api_key) if api_key else None
        # Per-model capability lookups are cached indefinitely (not TTLed
        # like registry.py's model *list* cache) - a given model id's
        # declared capabilities don't change during this process's lifetime.
        self._capabilities_cache: dict[str, ModelCapabilities | None] = {}

    async def list_models(self) -> list[str]:
        if self._client is None:
            return []
        ids = []
        async for model in self._client.models.list():
            ids.append(model.id)
            # Free capability data riding along with a call this already
            # makes - populating the cache here means stream() usually
            # never needs its own models.retrieve() round-trip at all.
            self._capabilities_cache[model.id] = model.capabilities
        return ids

    async def _capabilities(self, model: str) -> ModelCapabilities | None:
        if model not in self._capabilities_cache:
            info = await self._client.models.retrieve(model)
            self._capabilities_cache[model] = info.capabilities
        return self._capabilities_cache[model]

    async def reasoning_efforts(self, models: list[str]) -> dict[str, list[str]]:
        # Usually free of any extra API round-trip: list_models() already
        # populates _capabilities_cache for every model it returns, and
        # `models` here is always that same list (see registry._cached_models).
        # Unlike OpenAI (where the levels have to be inferred from the model
        # id - see openai_provider._EFFORT_RULES), every level offered here
        # comes from what the model itself reports, so this stays correct on
        # its own as models come and go.
        result: dict[str, list[str]] = {}
        for model in models:
            caps = await self._capabilities(model)
            thinking = caps.thinking if caps else None
            if not thinking:
                continue
            if thinking.types.adaptive.supported:
                effort = caps.effort
                levels = [
                    level
                    for level in REASONING_LEVELS
                    if effort
                    and effort.supported
                    and getattr(getattr(effort, level, None), "supported", False)
                ]
                # Adaptive thinking works without output_config.effort too
                # (stream() below just omits it), in which case the level
                # picked has no effect on the request - but the selector
                # still needs something to offer for "think about this", so
                # fall back to the classic three.
                result[model] = levels or list(THINKING_BUDGETS)
            elif thinking.types.enabled.supported:
                # Legacy thinking-budget models: the levels are exactly the
                # budgets defined above, nothing finer.
                result[model] = list(THINKING_BUDGETS)
        return result

    async def stream(
        self,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        if self._client is None:
            raise RuntimeError("ANTHROPIC_API_KEY is not configured")

        kwargs = {"model": model, "messages": messages, "tools": [WEB_FETCH_TOOL]}
        if system_prompt:
            kwargs["system"] = system_prompt

        if reasoning_effort and reasoning_effort != "off":
            caps = await self._capabilities(model)
            thinking = caps.thinking if caps else None
            if thinking and thinking.types.adaptive.supported:
                kwargs["thinking"] = {"type": "adaptive"}
                kwargs["max_tokens"] = ADAPTIVE_THINKING_MAX_TOKENS
                effort_support = caps.effort
                # getattr with a default rather than a bare attribute lookup:
                # the level arrives from the client, which may still be
                # carrying one this model has no field for at all (a session
                # remembers its last level across a model switch, and the
                # levels differ per model - see reasoning_efforts above), and
                # "this model doesn't take that" should drop the effort, not
                # raise.
                if effort_support.supported and getattr(getattr(effort_support, reasoning_effort, None), "supported", False):
                    kwargs["output_config"] = {"effort": reasoning_effort}
            elif thinking and thinking.types.enabled.supported:
                # Same story as the getattr above: a level these legacy
                # models never offered (xhigh/max from an adaptive model,
                # none/minimal from an OpenAI one) clamps to the nearest
                # budget they do have instead of 500ing on a KeyError.
                level = _BUDGET_LEVEL_FALLBACKS.get(reasoning_effort, reasoning_effort)
                budget = THINKING_BUDGETS.get(level, THINKING_BUDGETS["medium"])
                kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
                kwargs["max_tokens"] = budget + DEFAULT_MAX_TOKENS
            # else: this model doesn't support extended thinking at all -
            # fall through and answer without it rather than fail the whole
            # request over a reasoning level it can't honor.

        if "max_tokens" not in kwargs:
            kwargs["max_tokens"] = DEFAULT_MAX_TOKENS

        # Switched from the .text_stream shortcut to the raw event iterator
        # so a web_fetch call in progress can be surfaced too - text_stream
        # only ever yields text_delta content and silently drops everything
        # else. `pending_tools` remembers which content-block indices are a
        # server_tool_use call (keyed by content_block_start's `index`, the
        # only thing content_block_stop carries back to correlate with) so
        # its matching stop event reports "completed" instead of being
        # ignored like every non-tool block's stop.
        async with self._client.messages.stream(**kwargs) as stream:
            pending_tools: dict[int, str] = {}
            async for event in stream:
                if event.type == "content_block_start" and event.content_block.type == "server_tool_use":
                    name = event.content_block.name
                    pending_tools[event.index] = name
                    yield {"type": "tool_status", "status": "running", "tool": name, "emoji": "🌐", "label": "웹 페이지 가져오는 중"}
                elif event.type == "content_block_delta" and event.delta.type == "text_delta":
                    yield {"type": "text", "text": event.delta.text}
                elif event.type == "content_block_stop" and event.index in pending_tools:
                    name = pending_tools.pop(event.index)
                    yield {"type": "tool_status", "status": "completed", "tool": name, "emoji": "✅", "label": "웹 페이지 가져오기 완료"}

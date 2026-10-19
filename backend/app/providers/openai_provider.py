import json
import re
from typing import AsyncIterator

from openai import AsyncOpenAI

from .base import LLMProvider

# OpenAI's /v1/models mixes in embeddings, audio, image, moderation, etc.
# alongside chat models, and lists every dated snapshot next to its canonical
# alias. Filter both out so the picker only shows current, chat-capable models.
_NON_CHAT_SUBSTRINGS = (
    "embedding", "whisper", "tts", "audio", "realtime", "transcribe", "image",
    "moderation", "dall-e", "sora", "search-preview", "search-api",
    "deep-research", "codex", "davinci-002", "babbage-002", "-instruct",
)
_SNAPSHOT_SUFFIX_RE = re.compile(r"-(\d{4}-\d{2}-\d{2}|\d{3,4}|16k)$")

# There's no capabilities endpoint for OpenAI (or OpenAI-compatible
# gateways) the way AnthropicProvider._capabilities has one, so reasoning
# support is inferred from the model id instead: OpenAI's o-series and the
# gpt-5/gpt-6 families are reasoning models (reasoning_effort/
# reasoning.effort is meaningful); everything else (gpt-4o, gpt-4.1, ...)
# isn't. Applied unconditionally to every OpenAIProvider instance, including
# custom base_url gateways (Together/Fireworks/OpenRouter/local) - it won't
# recognize a reasoning-capable model under a different naming scheme, but
# no per-model signal exists there either.
_REASONING_MODEL_RE = re.compile(r"^(o1|o3|o4)(-|$)|^gpt-(5|6)")
# ...except the "-chat-latest" aliases, which sit inside those same families
# but point at the ChatGPT-aligned *non*-reasoning model of each generation
# (gpt-5.2-chat-latest's docs page lists structured_outputs/function_calling/
# streaming/image_input and no reasoning at all) - sending them an effort is
# a 400, so they're excluded from the selector entirely rather than offered
# levels none of them take.
_NON_REASONING_SUFFIXES = ("-chat-latest",)

# Which effort levels each reasoning model actually accepts. Same "no
# capabilities endpoint" problem as above, one level deeper: the levels are
# genuinely model-specific (sending one a model doesn't have is a 400, not a
# silently ignored parameter), so they're transcribed from OpenAI's own
# per-model docs pages and matched most-specific-first. Deliberately a
# manual snapshot - the model *list* stays live (list_models above), but
# nothing in the API reports this, so a newly released family lands on
# _DEFAULT_EFFORTS below until this table learns about it, which is the safe
# direction to be wrong in: low/medium/high are accepted by every reasoning
# model OpenAI has shipped so far.
#   https://developers.openai.com/api/docs/guides/reasoning
_EFFORT_RULES: tuple[tuple[re.Pattern, tuple[str, ...]], ...] = (
    # Pro tiers first, since they're the exception to their own generation's
    # set: gpt-5-pro takes *only* high, and every later pro (5.2/5.4/5.5)
    # starts at medium instead of none/low.
    (re.compile(r"^gpt-5-pro"), ("high",)),
    (re.compile(r"^gpt-5\.\d+-pro"), ("medium", "high", "xhigh")),
    # GPT-6 Astra (and the bare "gpt-6" alias pointing at it) and GPT-6.1
    # Sol reject "none" outright; GPT-6 Sol and Luna take it. Deliberately not a plain
    # "^gpt-6" prefix - an unrecognized future gpt-6 sibling is better off
    # on the conservative default below than offered a "max" it may not take.
    (re.compile(r"^gpt-6(-astra|$)"), ("low", "medium", "high", "xhigh", "max")),
    (re.compile(r"^gpt-6\.1-sol"), ("low", "medium", "high", "xhigh", "max")),
    (re.compile(r"^gpt-6-(sol|luna)"), ("none", "low", "medium", "high", "xhigh", "max")),
    # 5.6 (luna/sol/terra): the only non-pro family with "max".
    (re.compile(r"^gpt-5\.6"), ("none", "low", "medium", "high", "xhigh", "max")),
    # 5.2 through 5.5 share one set. 5.1 is the same minus xhigh, except for
    # codex-max, which introduced xhigh - codex models are filtered out of
    # the picker for real OpenAI (see _NON_CHAT_SUBSTRINGS), but a custom
    # gateway can still expose one.
    (re.compile(r"^gpt-5\.[2-5]"), ("none", "low", "medium", "high", "xhigh")),
    (re.compile(r"^gpt-5\.1-codex-max"), ("none", "low", "medium", "high", "xhigh")),
    (re.compile(r"^gpt-5\.1"), ("none", "low", "medium", "high")),
    # The original gpt-5 generation (incl. mini/nano): "minimal" here,
    # replaced by "none" from 5.1 onwards, and no xhigh/max anywhere in it.
    # Anchored so a later point release never lands on this older set.
    (re.compile(r"^gpt-5(-|$)"), ("minimal", "low", "medium", "high")),
)
# Every OpenAI reasoning model shipped so far accepts these three, so an id
# no rule above recognizes (a brand-new family, an o-series model, anything
# behind a custom gateway) under-offers rather than risking a 400 on a level
# that model doesn't have.
_DEFAULT_EFFORTS = ("low", "medium", "high")

# The level each model uses when no reasoning.effort is sent - what the
# selector's "Default" entry stands for. Transcribed from the per-model docs
# pages ("medium (default)" and the like), most-specific-first; a model none
# of these match is simply shown as "Default" with no level, rather than a
# guess. 5.1 through 5.4 really do default to no reasoning at all.
_DEFAULT_EFFORT_RULES: tuple[tuple[re.Pattern, str], ...] = (
    (re.compile(r"^gpt-5-pro"), "high"),
    (re.compile(r"^gpt-5\.5-pro"), "high"),
    (re.compile(r"^gpt-5\.4-pro"), "medium"),
    (re.compile(r"^gpt-6\.1-sol|^gpt-6-(sol|luna)"), "medium"),
    (re.compile(r"^gpt-5\.[56](?!\d)(?!-pro)"), "medium"),
    (re.compile(r"^gpt-5\.[124](?!\d)(?!-pro)"), "none"),
    (re.compile(r"^gpt-5(-(mini|nano)|$)"), "medium"),
)


def _is_current_chat_model(model_id: str) -> bool:
    lower = model_id.lower()
    if any(s in lower for s in _NON_CHAT_SUBSTRINGS):
        return False
    return not _SNAPSHOT_SUFFIX_RE.search(model_id)


def _is_reasoning_model(model_id: str) -> bool:
    lower = model_id.lower()
    if lower.endswith(_NON_REASONING_SUFFIXES):
        return False
    return bool(_REASONING_MODEL_RE.match(lower))


def _effort_levels(model_id: str) -> tuple[str, ...]:
    lower = model_id.lower()
    return next((levels for pattern, levels in _EFFORT_RULES if pattern.match(lower)), _DEFAULT_EFFORTS)


# Responses API progress events for hosted tools, "response.<tool>_call.<phase>"
# (OpenAI's web_search, xAI's web_search/x_search), as the tool_status events
# the UI shows while a search runs.
_HOSTED_TOOL_LABELS = {"web_search": ("🌐", "웹 검색"), "x_search": ("𝕏", "X 검색")}
_HOSTED_TOOL_PHASES = {
    "in_progress": ("running", "{} 준비 중"),
    "searching": ("running", "{} 중"),
    "completed": ("completed", "{} 완료"),
}
_HOSTED_TOOL_EVENT_RE = re.compile(r"^response\.(\w+)_call\.(\w+)$")


def _hosted_tool_status(event_type: str) -> dict | None:
    match = _HOSTED_TOOL_EVENT_RE.match(event_type)
    if not match or match[1] not in _HOSTED_TOOL_LABELS or match[2] not in _HOSTED_TOOL_PHASES:
        return None
    emoji, name = _HOSTED_TOOL_LABELS[match[1]]
    status, label = _HOSTED_TOOL_PHASES[match[2]]
    return {"type": "tool_status", "status": status, "tool": match[1], "emoji": "✅" if status == "completed" else emoji, "label": label.format(name)}


class OpenAIProvider(LLMProvider):
    """Talks to OpenAI's own API, or to anything that speaks the same
    /v1/chat/completions wire format (Together, Fireworks, OpenRouter,
    Nous' Hermes API, a local vLLM/Ollama/LM Studio server, ...) when given
    a custom `base_url`.
    """

    # Hosted (server-side) tools sent on the Responses API path - see
    # _stream_responses_api.
    _hosted_tools: tuple[str, ...] = ("web_search",)

    def __init__(
        self,
        api_key: str | None,
        base_url: str | None = None,
        static_models: list[str] | None = None,
        filter_models: bool = True,
        label: str = "OpenAI",
    ):
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url) if api_key else None
        self._static_models = static_models
        self._filter_models = filter_models
        self._label = label
        # The hosted web_search tool (below) only exists on OpenAI's own
        # Responses API - a custom base_url (Together/Fireworks/OpenRouter/a
        # local vLLM server/the Hermes gateway/...) only ever speaks the
        # Chat Completions wire format, so this stays False for all of them
        # and stream() keeps using that path unchanged.
        self._is_real_openai = base_url is None

    async def list_models(self) -> list[str]:
        if self._static_models is not None:
            return list(self._static_models)
        if self._client is None:
            return []
        response = await self._client.models.list()
        ids = [m.id for m in response.data]
        # The OpenAI-catalog-specific filter (dated snapshots, non-chat
        # modalities) doesn't generalize to other services' naming schemes -
        # e.g. many chat-tuned open models are legitimately named
        # "...-Instruct", which our own "-instruct" exclusion would wrongly
        # drop. Only apply it to the real OpenAI endpoint.
        if self._filter_models:
            ids = [i for i in ids if _is_current_chat_model(i)]
        return sorted(ids)

    async def reasoning_efforts(self, models: list[str]) -> dict[str, list[str]]:
        return {m: list(_effort_levels(m)) for m in models if _is_reasoning_model(m)}

    def reasoning_default(self, model: str) -> str | None:
        lower = model.lower()
        return next((level for pattern, level in _DEFAULT_EFFORT_RULES if pattern.match(lower)), None)

    async def stream(
        self,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        if self._client is None:
            raise RuntimeError(f"{self._label} is not configured")

        if self._is_real_openai:
            async for event in self._stream_responses_api(self._client, messages, model, reasoning_effort, system_prompt):
                yield event
            return

        full_messages = [{"role": "system", "content": system_prompt}] + messages if system_prompt else messages
        kwargs = {"model": model, "messages": full_messages, "stream": True}
        if reasoning_effort and reasoning_effort != "off":
            kwargs["reasoning_effort"] = reasoning_effort

        # Parse the raw SSE body ourselves instead of consuming the SDK's
        # typed ChatCompletionChunk iterator. Some OpenAI-compatible gateways
        # (agent gateways that expose tool-call progress, for instance) send
        # extra SSE blocks under a custom "event:" name alongside the normal
        # ones. The SDK tries to force every block into a ChatCompletionChunk
        # regardless of its event name, which for those extra blocks produces
        # a chunk with choices=None instead of surfacing what was actually
        # sent - so that information was both unavailable AND a crash risk.
        # Reading the body directly gets us both the normal text deltas and
        # whatever else the gateway wants to report.
        raw_stream = await self._client.chat.completions.create(**kwargs)
        response = raw_stream.response
        try:
            event_name = None
            async for line in response.aiter_lines():
                line = line.rstrip("\r")
                if line == "":
                    event_name = None
                    continue
                if line.startswith(":"):
                    continue  # SSE comment/heartbeat
                if line.startswith("event:"):
                    event_name = line[len("event:") :].strip()
                    continue
                if not line.startswith("data:"):
                    continue

                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue

                if event_name and event_name != "message":
                    if "toolCallId" in payload:
                        payload["tool_call_id"] = payload.pop("toolCallId")
                    yield {"type": "tool_status", "event": event_name, **payload}
                    continue

                choices = payload.get("choices")
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield {"type": "text", "text": content}
        finally:
            await response.aclose()

    async def _stream_responses_api(
        self,
        client: AsyncOpenAI,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None,
        system_prompt: str | None,
        **extra,
    ) -> AsyncIterator[dict]:
        """OpenAI's hosted web_search tool (real fetches, run on OpenAI's own
        infrastructure - no load on this backend) only exists on the
        Responses API, not Chat Completions - see
        https://platform.openai.com/docs/guides/tools-web-search. `input`
        takes the exact same [{"role", "content"}, ...] shape `messages`
        already is, so no conversion is needed; `system_prompt` maps to the
        separate top-level `instructions` param instead of being folded into
        `input` the way Chat Completions folds it into `messages`."""
        kwargs = {"model": model, "input": messages, "tools": [{"type": t} for t in self._hosted_tools], "stream": True, **extra}
        if system_prompt:
            kwargs["instructions"] = system_prompt
        if reasoning_effort and reasoning_effort != "off":
            kwargs["reasoning"] = {"effort": reasoning_effort}

        stream = await client.responses.create(**kwargs)
        async with stream:
            async for event in stream:
                if event.type == "response.output_text.delta":
                    yield {"type": "text", "text": event.delta}
                elif status := _hosted_tool_status(event.type):
                    yield status
                elif event.type in ("response.failed", "response.incomplete"):
                    raise RuntimeError(self._describe_failure(event))

    def _describe_failure(self, event) -> str:
        return f"{self._label} response {event.type.split('.')[-1]}: {event.response.error}"

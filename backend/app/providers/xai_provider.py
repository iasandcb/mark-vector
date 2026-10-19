import re
from typing import AsyncIterator

from .openai_provider import OpenAIProvider

XAI_BASE_URL = "https://api.x.ai/v1"

# xAI's /v1/models also lists its image, video and voice models.
_NON_CHAT_SUBSTRINGS = ("imagine", "voice", "embed", "tts", "image", "video")

# Which reasoning.effort levels each Grok model accepts, and what it runs at
# when none is sent - transcribed from docs.x.ai (the Reasoning guide and the
# per-model pages), most-specific-first. Same reasoning as openai_provider's
# _EFFORT_RULES: nothing in the API reports this, and a level a model doesn't
# take is a 400, so a model none of these match (grok-4.20-*-reasoning,
# grok-build, a future family) gets no selector at all and just runs at its
# own default. Most Grok models can't turn reasoning off, hence no "none".
#   https://docs.x.ai/developers/model-capabilities/text/reasoning
_EFFORT_RULES: tuple[tuple[re.Pattern, tuple[str, ...], str | None], ...] = (
    (re.compile(r"^grok-4\.20-multi-agent"), ("low", "medium", "high", "xhigh"), None),
    (re.compile(r"^grok-4\.[67](?!\d)"), ("low", "medium", "high", "xhigh"), "high"),
    (re.compile(r"^grok-4\.5(?!\d)"), ("low", "medium", "high"), "high"),
    (re.compile(r"^grok-4\.3(?!\d)"), ("none", "low", "medium", "high", "xhigh"), "low"),
)


def _rule(model_id: str):
    lower = model_id.lower()
    if "non-reasoning" in lower:
        return None
    return next((rule for rule in _EFFORT_RULES if rule[0].match(lower)), None)


class XAIProvider(OpenAIProvider):
    """Grok, via xAI's OpenAI-compatible Responses API - the same wire format
    as the real-OpenAI path of OpenAIProvider, with xAI's own hosted search
    tools: web_search plus x_search (posts on X), both run on xAI's side.
    https://docs.x.ai/developers/tools/overview"""

    _hosted_tools = ("web_search", "x_search")

    def __init__(self, api_key: str | None):
        super().__init__(api_key, base_url=XAI_BASE_URL, label="xAI")

    async def list_models(self) -> list[str]:
        if self._client is None:
            return []
        response = await self._client.models.list()
        return sorted(m.id for m in response.data if not any(s in m.id.lower() for s in _NON_CHAT_SUBSTRINGS))

    async def reasoning_efforts(self, models: list[str]) -> dict[str, list[str]]:
        return {m: list(rule[1]) for m in models if (rule := _rule(m))}

    def reasoning_default(self, model: str) -> str | None:
        rule = _rule(model)
        return rule[2] if rule else None

    async def stream(
        self,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        if self._client is None:
            raise RuntimeError("XAI_API_KEY is not configured")
        async for event in self._stream_responses_api(self._client, messages, model, reasoning_effort, system_prompt):
            yield event

from abc import ABC, abstractmethod
from typing import AsyncIterator

# "off" (or None) means "send no reasoning setting at all", so whatever the
# model's own default is applies - deliberately distinct from the "none"
# level below, which is an explicit "don't reason" that some models accept
# as a value (and which is *not* the same thing on a model whose default
# effort is medium). The rest are relative effort levels each provider maps
# to its own mechanism (thinking budget, output_config.effort,
# reasoning_effort, ...). Listed in increasing order, which is the order the
# UI offers whichever subset a given model actually supports - see
# reasoning_efforts below.
REASONING_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


class LLMProvider(ABC):
    @abstractmethod
    def stream(
        self,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        """Yields events as they arrive:
          {"type": "text", "text": str} - a chunk of the assistant's reply
          {"type": "tool_status", "status": "running"|"completed", ...}
            - progress info from a gateway/agent that exposes tool calls as
              extra SSE events. Most providers never emit this; consumers
              should treat it as purely informational and ignore unknown
              extra fields.
        """

    @abstractmethod
    async def list_models(self) -> list[str]:
        """Return the chat-capable model ids currently available to this account."""

    async def reasoning_efforts(self, models: list[str]) -> dict[str, list[str]]:
        """Given a subset of this provider's own list_models() output, return
        {model id: the reasoning levels that model actually accepts}, each
        ordered as in REASONING_LEVELS. A model that doesn't support
        reasoning at all is left out of the mapping entirely - so the
        /api/providers response tells the UI both which models the reasoning
        selector applies to (the keys) and which levels to offer for each
        (the values), rather than offering one fixed set of levels for every
        model and letting the provider reject the unsupported ones with a
        400. Default: empty, since a provider that doesn't override this has
        no way to tell reasoning-capable models apart from the rest."""
        return {}

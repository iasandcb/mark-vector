from typing import AsyncIterator

import httpx2
from openai import AsyncOpenAI

from ..chatgpt_auth import RESOURCE, ChatGPTCredentials
from .openai_provider import OpenAIProvider

# Error codes the plan-usage route reports in response.failed (or as the
# HTTP error body) that have a specific thing to tell the user - see
# https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
_FAILURE_MESSAGES = {
    "subscription_sharing_usage_limit_exceeded": "ChatGPT 플랜 사용 한도에 도달했습니다 - https://chatgpt.com/settings/usage 에서 확인하세요",
    "subscription_sharing_usage_unavailable": "ChatGPT 플랜 사용량을 확인할 수 없습니다. 잠시 후 다시 시도하세요",
    "subscription_sharing_user_not_eligible": "이 계정/워크스페이스는 ChatGPT 플랜을 다른 앱에서 쓸 수 없습니다",
    "subscription_sharing_unsupported_capability": "ChatGPT 플랜 경로에서 지원하지 않는 요청입니다",
}


class ChatGPTProvider(OpenAIProvider):
    """OpenAI's Responses API, authorized by the user's ChatGPT plan
    (Sign in with ChatGPT OAuth token, see app/chatgpt_auth.py) instead of
    an API key. Same wire format as the real-OpenAI path of OpenAIProvider,
    with the plan route's restrictions: store=false and stream=true on every
    request, full history in `input`, no temperature/max_output_tokens/etc.
    (none of which this app sends anyway), and a per-account model catalog."""

    def __init__(self, credentials: ChatGPTCredentials):
        super().__init__(api_key=None, label="ChatGPT")
        self._credentials = credentials
        # The key is swapped per request (with_options below) because the
        # access token rotates hourly; this one is never sent.
        self._client = AsyncOpenAI(api_key="unused", max_retries=0)

    async def list_models(self) -> list[str]:
        # Not the usual {"data": [...]} shape: {"models": [{slug,
        # display_name, visibility}, ...]}, already in the order ChatGPT
        # wants them shown - so no sorting and no _is_current_chat_model
        # filter, just the entries meant for a picker.
        token = await self._credentials.access_token()
        async with httpx2.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{RESOURCE}/models", headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
        return [m["slug"] for m in resp.json().get("models", []) if m.get("visibility") == "list"]

    async def stream(
        self,
        messages: list[dict],
        model: str,
        reasoning_effort: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[dict]:
        client = self._client.with_options(api_key=await self._credentials.access_token())
        async for event in self._stream_responses_api(
            client, messages, model, reasoning_effort, system_prompt, store=False
        ):
            yield event

    def _describe_failure(self, event) -> str:
        error = event.response.error
        code = getattr(error, "code", None)
        return _FAILURE_MESSAGES.get(code) or super()._describe_failure(event)

[목차](README.md) · [README](../README.md)

## 모델 목록 & 사고 수준

모델 드롭다운은 하드코딩이 아니라 각 프로바이더의 `/models` API를 실시간으로 호출해 채웁니다(5분 캐시). Anthropic은 반환되는 모델을 그대로 쓰고, OpenAI는 임베딩/음성/이미지/조정(moderation) 등 채팅과 무관한 모델과 날짜가 박힌 스냅샷(`gpt-4o-2024-08-06` 등)을 걸러내고 대표 별칭만 남깁니다(`backend/app/providers/openai_provider.py`의 `_is_current_chat_model`). OpenAI와 ChatGPT 플랜의 기본 모델은 그 목록에 `gpt-6.1-sol`이 있으면 그 모델입니다(`backend/app/providers/registry.py`의 `preferred_default_model`). 없으면 목록의 첫 모델을 고릅니다.

**사고 수준**(기본/낮음/중간/높음 등, 모델마다 다름)도 프로바이더별로 다르게 매핑됩니다.

**기본**은 사고 설정을 아예 보내지 않아 모델 자체의 기본값으로 돌아갑니다. 모델 문서에서 확인한 기본값이 있으면 `기본 (중간)`처럼 괄호에 표시합니다(예: GPT-5.5·Claude Opus 5.5는 중간, Claude Sonnet 5.5·Fable은 높음, GPT-5.1·5.2·5.4와 Claude 4.x는 없음). 표는 `openai_provider.py`/`anthropic_provider.py`의 `_DEFAULT_EFFORT_RULES`에 있고, 표에 없는 모델은 그냥 `기본`으로 나옵니다. 기본값으로도 생각하는 Claude 모델은 생각이 답을 자르지 않도록 `max_tokens`를 64000으로 잡습니다.

- **Anthropic**: 모델 capabilities가 adaptive thinking을 지원하면 `thinking: {type: "adaptive"}`를 켜고, 그 모델이 받는 수준일 때만 `output_config.effort`에 고른 값을 넣습니다(`max_tokens`는 64000). 그 수준을 받지 않으면 effort만 빼고 adaptive thinking은 유지합니다. 예전 모델(thinking type이 `enabled`뿐인 것)만 `budget_tokens`를 낮음 2000 / 중간 8000 / 높음 24000으로 두고 `max_tokens`를 budget + 4096으로 늘리며, 그 모델에 없는 수준은 가까운 budget으로 바꿉니다. 사고 자체를 지원하지 않으면 설정 없이 답합니다.
- **OpenAI**: 공식 API는 Responses API로 보내고, 사고 수준은 `reasoning: {"effort": ...}`입니다(Chat Completions의 `reasoning_effort`가 아님). 선택지는 모델마다 `_EFFORT_RULES`에 적힌 것(`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 중 일부)이고, 표에 없는 추론 모델은 `low`/`medium`/`high`만 나옵니다. 추론 모델이 아니면(gpt-4o 등) 사고 수준 선택이 꺼집니다. OpenAI 호환 커스텀 엔드포인트만 Chat Completions의 `reasoning_effort`를 그대로 넘기며, 그 서비스가 거부하면 오류가 화면에 표시됩니다.
- **xAI (Grok)**: OpenAI와 같은 Responses API(`https://api.x.ai/v1`)로 보내고, 웹 검색(`web_search`)과 X 검색(`x_search`)을 켭니다. 사고 수준은 `xai_provider.py`의 `_EFFORT_RULES`(grok-4.7·4.6은 낮음~`xhigh`, 기본 높음 / 4.5는 낮음~높음, 기본 높음 / 4.3은 `none`~`xhigh`, 기본 낮음)를 따르고, 표에 없는 모델과 `non-reasoning` 모델은 사고 수준 선택이 꺼집니다. 기본 모델은 `grok-4.7`입니다.

### 프로바이더/모델/사고 수준/맥락은 메시지 단위이고, 수식 표기는 문서 단위입니다

폴더가 아니라 **메시지를 보낼 때마다** 고릅니다. 에디터가 보낼 수 있는 문서(초안 또는 과거 공식 턴)를 표시하고 있을 때, 에디터 상단 툴바(⚙)에 프로바이더·모델·사고 수준·맥락 드롭다운이 나타납니다. 수식 표기 드롭다운(LaTeX/AsciiMath/하이브리드)은 시스템 프롬프트에서도 보이지만, `custom-symbols.csv`·`spoken-math.csv`·Hermes 전사본에서는 숨겨집니다(system.md·공통 시스템 프롬프트에서는 **대화** 버튼이 비활성화됩니다). 같은 폴더 안에서도 턴마다 다른 프로바이더/모델을 쓸 수 있습니다 — 예를 들어 1번 질문은 GPT로, 2번 질문은 Claude로 보내고 같은 스레드에서 이어갈 수 있습니다. 어느 프로바이더가 받든, 맥락으로 넘어가는 이전 턴은 그 텍스트 그대로입니다. 맥락 범위의 기본값은 **이 문서만**(`context_scope: "default"`, 그 파일 안의 라운드만)이고, **같은 폴더**(`sibling`)나 **폴더 + 하위 폴더**(`descendants`)로 넓힐 수 있습니다.

프로바이더·모델·사고 수준·맥락은 **문서마다** 따로입니다. 이미 보낸 턴을 다시 열면 그 턴에 기록된 값이 드롭다운에 채워집니다. 초안에서 드롭다운을 바꾸면 그 선택이 그 초안에 저장되어, 나중에 다시 열어도 유지됩니다. 새 문서와, 한 번도 고르지 않은 초안은 폴더에 이미 보낸 메시지가 있어도 OpenAI(`OPENAI_API_KEY`가 있을 때)와 모델 `gpt-6.1-sol`로 시작합니다. OpenAI가 없으면 목록의 첫 프로바이더와 그 프로바이더의 기본 모델을 고르고, 사고 수준은 기본, 맥락은 이 문서만으로 시작합니다. 폴더 `meta.json`의 `provider`/`model`은 기본값에 쓰이지 않으며, 전송해도 그 값은 바뀌지 않습니다. 수식 변환은 열린 문서의 directive(없으면 그 폴더 `system.md` → 프로젝트 `system.md` → 공통 `system.md` → LaTeX)가 드롭다운을 정하고, LaTeX가 아니면 응답을 AsciiMath2로 변환합니다. 각 공식 턴은 실제로 어떤 설정으로 만들어졌는지도 함께 기록합니다(`meta.json`의 `turns[].provider`/`model`/`reasoning_effort`/`convert_math`/`context_scope`).

폴더 생성(각 프로젝트 행의 "+" 버튼, 또는 폴더 ⋯ 메뉴의 "새 하위 폴더")은 제목만 물어봅니다(비워두면 첫 메시지로 자동 채워짐) — 프로바이더/모델 선택은 첫 메시지를 보낼 때 합니다.

## ChatGPT 플랜으로 쓰기 (API 키 없이)

[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)로 로그인하면 `OPENAI_API_KEY` 대신 본인 ChatGPT 플랜으로 OpenAI 모델을 쓸 수 있습니다. 프로바이더 드롭다운에 **ChatGPT (내 플랜)**(영어 UI에서는 *ChatGPT (my plan)*)으로 나타나며, 모델 목록은 그 계정이 쓸 수 있는 모델(`/v1/models`의 `visibility: "list"`)입니다. 사용량은 [ChatGPT 설정 → Usage](https://chatgpt.com/settings/usage)에서 확인·제한합니다.

OpenAI는 이 흐름의 redirect를 `http://127.0.0.1` 루프백만 허용하므로 Fly 서버가 콜백을 직접 받을 수 없습니다. 그래서 문서의 "Self-hosted VMs" 절차대로 로컬에서 로그인한 뒤 자격증명을 서버로 옮깁니다.

```bash
cd backend
uv run python -m app.chatgpt_auth login   # 브라우저에서 "Continue" → DATA_DIR/chatgpt/credentials.json (0600)
uv run python -m app.chatgpt_auth push    # 기본 앱 markvector. 포크는 --app <앱 이름>. Fly 볼륨 /data/chatgpt/로 전송, 로컬 토큰은 삭제
uv run python -m app.chatgpt_auth status  # 확인 / logout: 세션 해지
```

`push` 이후에는 서버가 1시간짜리 access token을 알아서 갱신합니다(refresh token은 갱신마다 교체, 30일 미사용 시 만료 → 다시 `login` + `push`). 로컬에서도 쓰려면 `push` 하지 말고 로컬에 그대로 두면 됩니다 — 같은 refresh token을 두 곳에서 갱신하면 서로를 무효화하므로 한 곳에만 둡니다.

이 경로는 Responses API 전용이라 `store: false`/`stream: true`로 보내며, 웹 검색은 계정/워크스페이스 정책에 따라 동작합니다(`backend/app/providers/chatgpt_provider.py`).

## OpenAI 호환 프로바이더 (Hermes, 자체 호스팅 등)

Anthropic/OpenAI 외에, `/v1/chat/completions`을 그대로 따르는 아무 서비스나(Hermes(Nous), Together, Fireworks, OpenRouter, 로컬 vLLM/Ollama/LM Studio 등) `backend/.env`의 `CUSTOM_OPENAI_PROVIDERS`에 JSON 배열로 추가하면 프로바이더 드롭다운에 그대로 나타납니다. 코드 수정 없이 개수 제한 없이 추가할 수 있습니다.

```
CUSTOM_OPENAI_PROVIDERS=[{"id":"hermes","label":"Hermes (Nous)","base_url":"https://inference-api.nousresearch.com/v1","api_key":"...","models":["Hermes-4-70B"]}]
```

- `id`, `base_url`은 필수, `label`은 없으면 `id`를 그대로 씁니다.
- `models`는 선택입니다 — 지정하면 그 목록을 그대로 쓰고, 생략하면 해당 엔드포인트의 `/v1/models`를 호출해 자동으로 채웁니다(자체 호스팅 서버는 `/v1/models`를 구현 안 했거나 다르게 동작하는 경우가 있어서, 확실하지 않으면 직접 지정하는 걸 추천합니다). OpenAI 공식 API 전용인 "구식 스냅샷/비채팅 모델 걸러내기" 필터는 커스텀 프로바이더에는 적용하지 않습니다 — 다른 서비스는 모델명 규칙이 달라서(예: `-Instruct` 접미사가 있는 정상적인 채팅 모델이 많음) 오히려 잘못 걸러낼 수 있기 때문입니다.
- `api_key`가 없으면 그 프로바이더는 목록에 나오지 않습니다(키가 없는 Anthropic/OpenAI도 같습니다). 인증이 필요 없는 로컬 서버라도 아무 문자열이나 넣어주세요.
- 사고 수준을 켜면 Chat Completions의 `reasoning_effort`를 전달합니다(공식 OpenAI의 Responses API `reasoning.effort`와는 다릅니다) — 그 서비스가 지원하지 않으면 오류가 그대로 표시됩니다.

### 도구 호출 진행 상황 표시

Hermes 같은 에이전트 게이트웨이는 표준 응답 텍스트 외에, 도구를 실행할 때마다 별도의 SSE `event:` 블록으로 진행 상황(`{"tool": ..., "label": ..., "status": "running"|"completed"}`)을 함께 보내는 경우가 있습니다. mark-vector는 openai SDK의 타입 파싱을 거치지 않고 응답 본문을 직접 읽어서, 이런 커스텀 이벤트를 잡아내 에디터 위에 "🔧 label" 형태로 실시간 표시합니다. 최종 답변 텍스트가 오기 시작하면 자동으로 사라집니다. 공식 OpenAI는 웹 검색, Anthropic은 웹 페이지 가져오기를 같은 자리에 `🌐`/`✅`와 함께 표시합니다. 어느 쪽 이벤트도 없는 프로바이더에서는 아무것도 표시되지 않습니다(동작에 영향 없음).

## 새 LLM 프로바이더 추가하기

**OpenAI 호환 API**라면 위의 [OpenAI 호환 프로바이더](models.md#openai-호환-프로바이더-hermes-자체-호스팅-등) 처럼 `.env`에 `CUSTOM_OPENAI_PROVIDERS` 한 줄만 추가하면 되고, 코드 수정이 필요 없습니다.

그 외의 새 API 형식을 통째로 추가하려면:

1. `backend/app/providers/`에 `LLMProvider`를 상속한 클래스 작성 (`stream(messages, model, reasoning_effort=None, system_prompt=None) -> AsyncIterator[dict]`와 `list_models() -> list[str]` 구현. `stream`은 문자열 조각이 아니라 `{"type": "text", "text": ...}`와, 있으면 `{"type": "tool_status", ...}` 이벤트를 yield합니다)
2. `backend/app/providers/registry.py`의 `STATIC_PROVIDER_INFO`, `get_provider()`, `_is_configured()`에 등록

프론트엔드는 `/api/providers` 응답을 그대로 반영하므로 별도 수정이 필요 없습니다.

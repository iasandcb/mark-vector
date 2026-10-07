# mark-vector

마크다운 문서 단위로 입력/출력을 주고받는 LLM 클라이언트 웹 앱입니다. 대화의 각 턴(사용자 입력, LLM 응답)은 하나의 완전한 마크다운 문서로 취급되며, 파일시스템에 `.md` 파일로 저장됩니다.

화면은 3단 세로 split 뷰입니다.

- **왼쪽**: `data/projects/`를 반영한 **프로젝트 → 세션 → 턴** 3단 트리(아래 "프로젝트 · 세션 · 턴" 참고). 세션 제목은 처음엔 첫 사용자 메시지의 첫 줄로 자동으로 채워지지만, 세션 행의 ✎ 버튼으로 언제든 원하는 이름으로 바꿀 수 있습니다(한번 이름을 바꾸면 이후 메시지로 자동 갱신되지 않습니다).
- **가운데**: 왼쪽에서 선택한 문서를 편집하는 에디터. 보낼 수 있는 문서를 열면 그 메시지를 어떤 프로바이더/모델/사고 수준으로, AsciiMath 변환 여부와 함께 보낼지 고르는 작은 툴바가 있습니다(상단 버튼 줄을 한 줄로 유지하려고 평소에는 접혀 있고, 오른쪽 끝 ⚙로 엽니다)(프로바이더/모델/사고 수준/변환은 세션이 아니라 메시지 단위 설정 — 아래 "모델 목록 & 사고 수준" 참고).
- **오른쪽**: 가운데 편집 중인 내용의 실시간 마크다운 미리보기.

가운데 에디터의 "LLM로 보내기" 버튼을 누르면 현재 편집 중인 내용이 그대로 다음 사용자 턴으로 전송되고, LLM 응답이 스트리밍되어 새 문서로 트리에 나타납니다.

문서가 열려 있을 때 점프 키(맥은 `⌃`, 그 외는 `Alt`)를 잠깐(약 0.35초) 누르고 있으면 트리의 문서에 `⌃1`~`⌃9` 배지가 붙고, 그 번호를 누르면 해당 문서가 바로 열립니다 — 1~3은 최근에 연 문서, 4~9는 같은 폴더의 문서입니다. 그 밖의 문서는 퀵 오픈(`⌘P`/`⌘K`)으로 찾습니다. (`⌥↑`/`⌥↓`는 편집기의 줄 위/아래로 옮기기 키라 앱 단축키로 쓰지 않습니다.)

화면 폭이 700px 이하(휴대폰)일 때는 3단이 아니라 화면 아래 탭(📁 목록 / ✏️ 편집 / 👁 미리보기)으로 한 번에 한 화면만 보여주고, 글자 크기와 버튼/터치 영역을 키워서 좁은 화면에서도 눈에 편하게 읽고 누를 수 있게 했습니다. 문서를 선택하면 자동으로 편집 탭으로 전환됩니다.

- **백엔드**: Python (FastAPI)
- **프론트엔드**: 바닐라 HTML / CSS / JS (빌드 도구, 프레임워크 없음)
- **LLM 프로바이더**: Anthropic, OpenAI (전환 가능한 구조)
- **수식 렌더링**: KaTeX (LaTeX) + asciimath-parser (AsciiMath2 → LaTeX 변환). AsciiMath2 표준과 그 표준을 구현한 LaTeX → AsciiMath2 변환 파이썬 패키지는 별도 저장소 [asciimath2](https://github.com/iasandcb/asciimath2) (PyPI `asciimath2`) 참고.

## 프로젝트 구조

```
mark-vector/
  backend/
    pyproject.toml        # uv 프로젝트 정의 (Python 3.14)
    .env.example          # 환경변수 예시
    app/
      main.py             # FastAPI 앱, 정적 파일 서빙
      config.py           # .env 로드 및 설정
      storage.py          # 프로젝트/대화/턴/초안 문서 파일시스템 저장소
      latex_to_asciimath.py  # 응답 저장 전 LaTeX 수식 -> AsciiMath2 변환 (opt-in, asciimath2 패키지 사용)
      custom_symbols.py    # 공용 커스텀 심볼 CSV -> asciimath2.Config (LaTeX -> AsciiMath2 방향)
      models.py           # 요청 스키마
      providers/          # LLM 프로바이더 어댑터 (Anthropic/OpenAI) + registry
      routers/            # /api/projects, /api/projects/{id}/conversations, /api/providers, /api/system-prompt, /api/custom-symbols
  frontend/
    index.html
    static/
      css/style.css
      js/
        app.js            # 3단 뷰(트리/에디터/미리보기) UI 로직
        api.js            # fetch 래퍼 + NDJSON 스트림 파서
        markdown.js        # 마크다운 렌더러 (수식은 KaTeX/asciimath-parser 사용)
  data/
    system.md             # 공통 시스템 프롬프트 (런타임 생성, git에는 커밋되지 않음)
    custom-symbols.csv    # 공용 커스텀 심볼 (런타임 생성, 기본값은 빈 파일, git에는 커밋되지 않음)
    spoken-math.csv       # 공용 수식 말 (처음 읽을 때 backend/app/spoken_math_default.csv로 생성, git에는 커밋되지 않음)
    conversations/        # 대화별 폴더 (런타임 생성, git에는 커밋되지 않음)
```

## 요구 사항

- [uv](https://docs.astral.sh/uv/) (Python 버전 및 의존성 관리)
- uv가 Python 3.14를 자동으로 설치/관리하므로 시스템 Python 버전은 무관합니다.

## 설치 및 실행

```bash
cd backend
cp .env.example .env      # API 키 입력
uv sync                    # 최초 1회 (Python 3.14 + 의존성 설치)
uv run uvicorn app.main:app --reload
```

브라우저에서 http://127.0.0.1:8000 접속.

FastAPI가 `frontend/` 디렉터리를 함께 서빙하므로 별도의 프론트엔드 서버나 빌드 과정이 필요 없습니다.

## 환경 변수 (`backend/.env`)

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 키 (선택, 미설정 시 해당 프로바이더 비활성) |
| `OPENAI_API_KEY` | OpenAI API 키 (선택, 미설정 시 해당 프로바이더 비활성) |
| `DATA_DIR` | 대화 저장 경로 (기본값: `../data`) |

프로바이더는 최소 하나만 설정하면 됩니다. 사이드바에서 API 키가 없는 프로바이더는 "no API key"로 표시됩니다.

## 모델 목록 & 사고 수준

모델 드롭다운은 하드코딩이 아니라 각 프로바이더의 `/models` API를 실시간으로 호출해 채웁니다(5분 캐시). Anthropic은 반환되는 모델을 그대로 쓰고, OpenAI는 임베딩/음성/이미지/조정(moderation) 등 채팅과 무관한 모델과 날짜가 박힌 스냅샷(`gpt-4o-2024-08-06` 등)을 걸러내고 대표 별칭만 남깁니다(`backend/app/providers/openai_provider.py`의 `_is_current_chat_model`).

**사고 수준**(기본/낮음/중간/높음 등, 모델마다 다름)도 프로바이더별로 다르게 매핑됩니다.

**기본**은 사고 설정을 아예 보내지 않아 모델 자체의 기본값으로 돌아갑니다. 모델 문서에서 확인한 기본값이 있으면 `기본 (중간)`처럼 괄호에 표시합니다(예: GPT-5.5·Claude Opus 5.5는 중간, Claude Sonnet 5.5·Fable은 높음, GPT-5.1~5.4와 Claude 4.x는 없음). 표는 `openai_provider.py`/`anthropic_provider.py`의 `_DEFAULT_EFFORT_RULES`에 있고, 표에 없는 모델은 그냥 `기본`으로 나옵니다. 기본값으로도 생각하는 Claude 모델은 생각이 답을 자르지 않도록 `max_tokens`를 넉넉히 잡습니다.

- **Anthropic**: extended thinking을 켜고 `budget_tokens`를 낮음 2000 / 중간 8000 / 높음 24000으로 설정합니다(`max_tokens`는 budget + 4096으로 자동 확장).
- **OpenAI**: `reasoning_effort` 파라미터에 `low`/`medium`/`high`를 그대로 전달합니다. 이 파라미터를 지원하지 않는 모델(gpt-4o 등)에서 사고 수준을 켜면 API가 오류를 반환할 수 있습니다 — 이 경우 오류가 그대로 화면에 표시됩니다.

### 프로바이더/모델/사고 수준/변환 설정은 턴(메시지) 단위입니다

세션이 아니라 **메시지를 보낼 때마다** 고릅니다. 에디터가 보낼 수 있는 문서(초안 또는 과거 공식 턴)를 표시하고 있을 때, 에디터 상단에 프로바이더·모델·사고 수준 드롭다운과 "LaTeX → AsciiMath 자동 변환" 체크박스가 나타납니다(system.md·공통 시스템 프롬프트에서는 보낼 수 없으므로 숨겨집니다). 같은 세션 안에서도 턴마다 다른 프로바이더/모델을 쓸 수 있습니다 — 예를 들어 1번 질문은 GPT로, 2번 질문은 Claude로 보내고 같은 스레드에서 이어갈 수 있습니다. 어느 프로바이더가 받든 대화 맥락(`build_history`)은 이전 턴들의 텍스트 그대로 전달되므로 문제없이 이어집니다.

컨트롤은 그 세션에서 **마지막으로 실제 전송에 쓰인 값**으로 미리 채워집니다(세션 안에서 다른 문서로 옮겨도 유지되고, 다른 세션으로 옮기면 그 세션의 마지막 값으로 다시 채워집니다). 세션이 아직 메시지를 한 번도 보낸 적이 없으면 기본 프로바이더 · 사고 수준 기본 · 변환 꺼짐으로 시작합니다. 각 공식 턴은 실제로 어떤 설정으로 만들어졌는지도 함께 기록합니다(`meta.json`의 `turns[].provider`/`model`/`reasoning_effort`/`convert_math`).

세션 생성(각 프로젝트 행의 "+" 버튼)은 이제 제목만 물어봅니다(비워두면 첫 메시지로 자동 채워짐) — 프로바이더/모델 선택은 첫 메시지를 보낼 때 합니다.

## ChatGPT 플랜으로 쓰기 (API 키 없이)

[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)로 로그인하면 `OPENAI_API_KEY` 대신 본인 ChatGPT 플랜으로 OpenAI 모델을 쓸 수 있습니다. 프로바이더 드롭다운에 **ChatGPT (내 플랜)**(영어 UI에서는 *ChatGPT (my plan)*)으로 나타나며, 모델 목록은 그 계정이 쓸 수 있는 모델(`/v1/models`의 `visibility: "list"`)입니다. 사용량은 [ChatGPT 설정 → Usage](https://chatgpt.com/settings/usage)에서 확인·제한합니다.

OpenAI는 이 흐름의 redirect를 `http://127.0.0.1` 루프백만 허용하므로 Fly 서버가 콜백을 직접 받을 수 없습니다. 그래서 문서의 "Self-hosted VMs" 절차대로 로컬에서 로그인한 뒤 자격증명을 서버로 옮깁니다.

```bash
cd backend
uv run python -m app.chatgpt_auth login   # 브라우저에서 "Continue" → DATA_DIR/chatgpt/credentials.json (0600)
uv run python -m app.chatgpt_auth push    # Fly 볼륨 /data/chatgpt/로 전송, 로컬 토큰은 삭제
uv run python -m app.chatgpt_auth status  # 확인 / logout: 세션 해지
```

`push` 이후에는 서버가 1시간짜리 access token을 알아서 갱신합니다(refresh token은 갱신마다 교체, 30일 미사용 시 만료 → 다시 `login` + `push`). 로컬에서도 쓰려면 `push` 하지 말고 로컬에 그대로 두면 됩니다 — 같은 refresh token을 두 곳에서 갱신하면 서로를 무효화하므로 한 곳에만 둡니다.

이 경로는 Responses API 전용이라 `store: false`/`stream: true`로 보내며, 웹 검색은 계정/워크스페이스 정책에 따라 동작합니다(`backend/app/providers/chatgpt_provider.py`).

## 오디오 전사 (화자 분리)

폴더 행의 `⋯` 메뉴 → **오디오 전사 (화자 분리)…** 에서 오디오 파일(m4a/mp3/wav/webm/mp4)을 올리거나 브라우저에서 바로 녹음하면, OpenAI `gpt-4o-transcribe-diarize`로 전사하고 화자를 A, B, …로 구분한 마크다운 문서를 그 폴더에 새 초안으로 만듭니다.

```markdown
# 주간회의

> 2026-10-01 09:00 · 32:14 · 화자 3명 · gpt-4o-transcribe-diarize

**A** `00:00` 안녕하세요. 오늘은…

**B** `00:07` 네, 먼저…
```

- 같은 화자의 연속 구간은 한 문단으로 합칩니다. 화자 이름은 편집기에서 `**A**`를 찾아 바꾸면 됩니다. 문서는 일반 초안이라 그대로 LLM에 보내 요약할 수 있습니다.
- **녹음 언어**(자동/한국어/English/日本語)를 지정하면 도중에 다른 언어로 새는 현상이 줄어듭니다. 기본값은 UI 언어이고, 마지막 선택을 기억합니다.
- API 파일 한도는 25MB입니다. 그보다 큰 파일은 서버가 ffmpeg로 모노 24kbps Opus(시간당 약 11MB)로 압축해 **한 번에** 보냅니다. 나눠 보내면 조각마다 화자 라벨이 달라지기 때문입니다. 브라우저 녹음은 32kbps(시간당 약 14MB)로 녹음합니다.
- `OPENAI_API_KEY`가 필요합니다. ChatGPT 플랜 경로는 전사 API를 지원하지 않습니다.

## 받아쓰기 (🎤)

편집기 툴바의 🎤는 말하는 내용을 커서 위치에 실시간으로 받아씁니다. 브라우저에 따라 두 가지 방식 중 하나를 씁니다.

| 브라우저 | 방식 | 비용 |
|---|---|---|
| 데스크톱 크롬·엣지, 사파리(맥·아이폰), 안드로이드 크롬 | 브라우저 자체 음성 인식(Web Speech API) | 무료 |
| 아이폰의 크롬·파이어폭스 등 사파리 외 브라우저, 파이어폭스 | OpenAI 실시간 전사(`gpt-live-transcribe`, WebRTC) | 켜 둔 동안 분당 약 $0.017 (`OPENAI_API_KEY`) |

아이폰에서는 애플이 음성 인식을 사파리에만 열어 두어서, 다른 브라우저에서는 두 번째 방식으로 자동 전환됩니다(버튼에 마우스를 올리면 과금 방식임을 표시). 브라우저가 마이크 음성을 OpenAI로 직접 보내고, 서버는 연결 시작만 중계하므로 API 키는 서버 밖으로 나가지 않습니다(`backend/app/routers/stt.py`, `frontend/static/js/realtime-stt.js`). 말이 잠깐 멈추면 그 구간이 확정되고, 비용을 아끼기 위해 탭이 가려지거나 3분 동안 소리가 없으면 자동으로 꺼집니다.

두 방식이 모두 되는 브라우저(사파리, 데스크톱 크롬 등)에서는 언어 선택 옆에 **엔진 선택**(🌐 내장 / ⚡ 실시간)이 나타납니다. 기본은 무료인 내장이고, 내장 인식이 약한 곳(특히 사파리)에서는 실시간을 고르면 됩니다. 선택은 브라우저마다 기억하며, 받아쓰는 중에 바꾸면 새 엔진으로 바로 이어집니다.

### 수식 받아쓰기

받아쓰는 위치가 `$$` 수식 블록 안이면(리모컨 Y, 안경 ↑, 또는 "수식시작"이라고 말해서 엶) 말한 내용을 AsciiMath로 바꿔 씁니다(`frontend/static/js/kor-math.js`).

바꾸는 규칙은 왼쪽 트리 맨 위의 **공용 수식 말**(`S` 배지) 문서 하나에 모두 있습니다. 실제로는 `data/spoken-math.csv`이고, 처음 열 때 기본 어휘(`backend/app/spoken_math_default.csv`)로 채워진 뒤로는 이 파일만 씁니다. 한 줄에 `말, 기호` 하나씩(첫 쉼표 앞이 말, 뒤가 기호라서 `과, ,`처럼 기호가 쉼표여도 됨, 기호가 `\n`이면 수식 안 줄바꿈, `$$`이면 `$$`를 친 것처럼 수식 블록을 열거나 닫음), `#`로 시작하는 줄은 주석, 같은 말이 여러 번 있으면 아래쪽이 이깁니다. 저장하면 바로 다음 받아쓰기부터 적용되고, 다른 브라우저에서도 받아쓰기를 시작할 때 새로 읽어 옵니다.

기본 어휘는 [obsidian-publish-asciimath의 kor-math.js](https://github.com/iasandcb/obsidian-publish-asciimath/blob/main/kor-math.js)를 옮겨 온 것에, 소리 내어 말하기 좋은 괄호 말을 더했습니다.

| 말 | 기호 |
|---|---|
| 수식시작 / 수식끝 | 받아쓰는 자리에서 수식 블록을 열기 / 닫기 (리모컨 Y와 같음) |
| 열고 … 닫고 | `(` … `)` |
| 집합 열고 … 집합 닫고 | `{` … `}` |
| 행렬 열고 … 행렬 닫고 | `[` … `]` |
| 다음줄 | `;` (행렬의 다음 행) |
| 이고 | 수식 안에서 줄바꿈 |

예: "엑스 승 2 더하기 라지 와이 는 열고 에이 과 비 닫고" → `x ^ 2 + Y = ( a , b )`, "행렬 열고 1 과 2 다음줄 3 과 4 행렬 닫고" → 2×2 행렬.

- 가장 긴 말부터 맞춥니다("라지에이"는 `A`, "집합 열고"는 `{`). 인식기가 한국어 띄어쓰기를 들쭉날쭉하게 하므로 한글 사이 띄어쓰기는 무시합니다.
- 숫자·영문처럼 이미 기호로 받아쓴 것은 그대로 두고, 인식기가 붙인 문장부호(끝의 `.` 등)는 지웁니다(`3.14` 같은 소수점은 유지).
- 대문자는 "라지"로 말합니다("라지 에이" → `A`). 원본의 "빅"은 뒤 모음과 연음되어("빅 에이" → [비게이]) 인식이 잘 안 돼 바꿨습니다.
- 원본 목록과 다른 점: "피"가 두 번(`p`, `phi`) 있어 나중 것인 `phi`로, "집폐"는 `{`로 잘못 적혀 있어 `}`로 바로잡았습니다.
- 지시문이 없어 LaTeX로 읽히는 문서라도 아직 다른 수식이 없으면, 처음 수식을 받아쓸 때 맨 위에 `<!-- math: asciimath -->`를 넣습니다. 이미 LaTeX 수식이 있거나 `<!-- math: latex -->`라고 밝힌 문서에서는 바꾸지 않고 일반 받아쓰기로 둡니다.

## 게임패드 리모컨으로 실시간 슬라이드

말하는 내용을 받아쓰면서 게임패드 버튼으로 슬라이드를 만들고, 공개 슬라이드쇼를 보는 청중의 화면을 넘길 수 있습니다. 컨트롤러는 **일반 게임패드 모드**로 연결합니다(예: 8BitDo Micro는 **D** 모드). 키보드 모드(K)와 달리 버튼이 편집기에 글자로 입력되지 않아서 받아쓰기 중에도 안전합니다(`frontend/static/js/remote.js`, Gamepad API).

준비:

1. 문서를 공개하고 **슬라이드로 보기** 옵션과 **Live**를 켭니다.
2. 편집기 툴바에서 받아쓰기(🎤)를 시작하고, 슬라이드를 만들 프로바이더/모델을 골라 둡니다.
3. 컨트롤러를 연결하고 페이지에서 아무 버튼이나 한 번 누르면 툴바에 🎮이 나타납니다. 🎮을 눌러 동작마다 **지정** → 버튼 누르기로 배정합니다(버튼과 스틱/D패드 축 모두 인식).

| 기본 버튼 (8BitDo Micro 표기) | 동작 | 하는 일 |
|---|---|---|
| A | 새 빈 슬라이드 | 정리하지 않고 즉시 `---`를 넣어 빈 새 장을 열고, 청중 화면도 바로 그 빈 장으로 옮깁니다. 이후 받아쓰는 말은 그 장에 쌓입니다. 이미 빈 장이면 아무것도 더하지 않습니다. |
| X | 줄넘김 | 받아쓰는 위치에서 줄을 넘깁니다. 본문에서는 빈 줄을 넣어 문단을 나누므로 슬라이드에서도 줄이 바뀌어 보이고, 수식 블록 안에서는 한 줄만 넘겨 수식의 다음 줄이 됩니다. |
| B | 현재 슬라이드 정리 | 지금 장의 내용(원문, 또는 정리된 슬라이드 + 이어서 받아쓴 원문)을 그 자리에서 슬라이드로 정리합니다. 첫 글자부터 스트리밍으로 써 넣고, 모델의 가장 낮은 사고 수준으로 보냅니다. 청중은 움직이지 않고, 정리하는 동안 말한 내용은 그 아래 새 문단으로 이어집니다. |
| Y | 수식 블록 | 본문에서 누르면 `$$` / 빈 줄 / `$$`로 된 빈 수식 블록을 넣고 커서를 그 안에 둡니다. 이어서 말하는 내용이 수식 안으로 들어가고, 수식 안에서 다시 누르면 닫는 `$$` 뒤 다음 문단으로 빠져나옵니다. 말로 한 수식("x 제곱 더하기 1")은 B로 정리할 때 수식 표기로 바뀝니다. |
| 십자키 ↑ / ↓ | 청중 화면: 이전 / 다음 장 | |
| 십자키 → / ← | 청중 화면: 맨 앞 / 맨 뒤 장 | 맨 뒤로 가면 받아쓰는 장을 다시 실시간으로 따라갑니다. |
| (지정 안 됨) | 마지막 정리 취소 / 다시 만들기 | 필요하면 🎮 설정에서 버튼을 지정합니다. |

기본 버튼 번호는 브라우저의 standard 배열(십자키 12~15, 얼굴 버튼은 위치 기준 0 아래·1 오른쪽·2 왼쪽·3 위)을 가정합니다. 컨트롤러가 다르게 보고하면 🎮 설정에서 한 번 다시 지정하면 됩니다.

받아쓰는 원문은 Live로 청중에게도 실시간으로 보입니다. 청중 화면 위치는 Live 업데이트에 함께 실려 갑니다. 기본은 "받아쓰는 중인 마지막 장"을 따라가는 것이고, 정리(B)는 청중을 움직이지 않고 그 자리에서 슬라이드를 바꿉니다. 리모컨으로 발표하는 동안에는 방금 연 빈 장도 공개 페이지에 표시됩니다(평소에는 빈 장을 건너뜀). 이전/다음/맨 앞으로 특정 장에 멈춘 뒤 마지막 장에서 "다음"이나 "맨 뒤"를 누르면 다시 받아쓰는 장을 따라갑니다. 리모컨을 한 번도 쓰지 않은 Live에는 이 정보가 실리지 않아서, 청중이 각자 장을 넘기는 기존 동작 그대로입니다.

안경 화면(`/glasses/`, 편집기의 Glasses 체크박스)도 문서가 **슬라이드로 보기**로 공개되어 있으면 한 장씩 보여 줍니다. 머리글에 `파일명 · 2/5`처럼 장 번호가 붙고, 안경 D패드로 리모컨처럼 발표를 진행합니다: ←/→ 장 넘기기(마지막 장에서 →는 새 빈 장, 리모컨 A), 선택(핀치/탭, Enter) 지금 장 정리(리모컨 B, 머리글에 ✨), ↑ 수식 블록 열기/나가기(리모컨 Y, 머리글에 $$), ↓ 줄넘김(리모컨 X, 머리글에 ↵ — 본문에서는 문단 나눔, 수식 안에서는 한 줄). 받아쓰기가 꺼져 있을 때 커서가 마지막 장 밖에 있으면 줄넘김과 수식은 문서 끝에 들어갑니다. 문서 전체 보기에서는 ↑/↓가 스크롤입니다. 리모컨으로 발표하는 동안에는 청중 화면과 같은 장을 따라갑니다. 슬라이드 옵션을 끄면 다시 문서 전체를 보여 줍니다.

## OpenAI 호환 프로바이더 (Hermes, 자체 호스팅 등)

Anthropic/OpenAI 외에, `/v1/chat/completions`을 그대로 따르는 아무 서비스나(Hermes(Nous), Together, Fireworks, OpenRouter, 로컬 vLLM/Ollama/LM Studio 등) `backend/.env`의 `CUSTOM_OPENAI_PROVIDERS`에 JSON 배열로 추가하면 프로바이더 드롭다운에 그대로 나타납니다. 코드 수정 없이 개수 제한 없이 추가할 수 있습니다.

```
CUSTOM_OPENAI_PROVIDERS=[{"id":"hermes","label":"Hermes (Nous)","base_url":"https://inference-api.nousresearch.com/v1","api_key":"...","models":["Hermes-4-70B"]}]
```

- `id`, `base_url`은 필수, `label`은 없으면 `id`를 그대로 씁니다.
- `models`는 선택입니다 — 지정하면 그 목록을 그대로 쓰고, 생략하면 해당 엔드포인트의 `/v1/models`를 호출해 자동으로 채웁니다(자체 호스팅 서버는 `/v1/models`를 구현 안 했거나 다르게 동작하는 경우가 있어서, 확실하지 않으면 직접 지정하는 걸 추천합니다). OpenAI 공식 API 전용인 "구식 스냅샷/비채팅 모델 걸러내기" 필터는 커스텀 프로바이더에는 적용하지 않습니다 — 다른 서비스는 모델명 규칙이 달라서(예: `-Instruct` 접미사가 있는 정상적인 채팅 모델이 많음) 오히려 잘못 걸러낼 수 있기 때문입니다.
- `api_key`도 없으면 그 프로바이더는 "설정 안 됨"으로 표시되고 목록에 나오되 세션 생성은 막힙니다. 인증이 필요 없는 로컬 서버라도 아무 문자열이나 넣어주세요.
- 사고 수준을 켜면 다른 OpenAI 프로바이더와 동일하게 `reasoning_effort`를 전달합니다 — 그 서비스가 지원하지 않으면 오류가 그대로 표시됩니다.

### 도구 호출 진행 상황 표시

Hermes 같은 에이전트 게이트웨이는 표준 응답 텍스트 외에, 도구를 실행할 때마다 별도의 SSE `event:` 블록으로 진행 상황(`{"tool": ..., "label": ..., "status": "running"|"completed"}`)을 함께 보내는 경우가 있습니다. mark-vector는 openai SDK의 타입 파싱을 거치지 않고 응답 본문을 직접 읽어서, 이런 커스텀 이벤트를 잡아내 에디터 위에 "🔧 label" 형태로 실시간 표시합니다. 최종 답변 텍스트가 오기 시작하면 자동으로 사라집니다. 이런 이벤트를 보내지 않는 일반 OpenAI/Anthropic/기타 프로바이더에서는 그냥 아무것도 표시되지 않습니다(동작에 영향 없음).

## 프로젝트 · 세션 · 턴

트리는 **프로젝트 → 세션 → 턴** 3단 구조입니다. 프로젝트는 세션들을 묶는 상위 단위로, 그 안의 모든 세션이 공유하는 자체 시스템 프롬프트를 가질 수 있습니다(아래 "시스템 프롬프트" 참고). "+ 새 프로젝트"로 만들고, 각 프로젝트 행의 "+"로 그 프로젝트 안에 세션을 만듭니다. 프로젝트 삭제는 **그 안의 모든 세션·대화를 함께 삭제**하는 되돌릴 수 없는 작업이라, 삭제 버튼을 누르면 안에 세션이 몇 개 있는지 보여주는 확인 창이 뜹니다.

이 기능이 생기기 전부터 있던 세션은 전부 자동으로 `기본 프로젝트`(id: `default`)로 옮겨집니다 — 서버가 `/api/projects`를 처음 응답할 때(주로 앱을 처음 켤 때) `data/conversations/`가 남아 있으면 통째로 `data/projects/default/conversations/`로 옮기고, 이후로는 그 자리에 아무것도 없으므로 다시 실행되지 않습니다(멱등).

## 시스템 프롬프트

시스템 프롬프트는 **세 계층**입니다.

- **공통 시스템 프롬프트**: 왼쪽 트리 맨 위, 프로젝트 목록과 별개로 항상 고정된 "공통 시스템 프롬프트" 항목(`G` 배지). 모든 프로젝트·모든 세션의 모든 메시지에 적용됩니다. 실제로는 `data/system.md` 파일 하나입니다.
- **프로젝트별 시스템 프롬프트**: 프로젝트를 펼치면 세션 목록 맨 위에 "프로젝트 시스템 프롬프트" 항목(`P` 배지)이 있습니다. 그 프로젝트 안의 모든 세션에 적용됩니다.
- **세션별 시스템 프롬프트**: 세션을 만들면 그 폴더에 `system.md`가 자동으로 생성됩니다(각 세션 트리에서 항상 맨 위, `S` 배지). 그 세션에만 적용됩니다.

셋 다 다른 문서처럼 선택해서 편집·저장할 수 있고(프로젝트·세션 시스템 프롬프트는 삭제되지 않으며, 공통 프롬프트와 함께 "LLM로 보내기" 버튼도 비활성화됩니다 — 대화 턴이 아니라 설정이기 때문). 메시지를 보낼 때마다 세 파일을 모두 읽어 **공통 → 프로젝트 → 세션** 순서로 이어붙인 뒤(있는 것끼리만 빈 줄로 구분, 셋 다 비어 있으면 아무것도 전달하지 않음) 프로바이더별 방식으로 전달합니다.

- **Anthropic**: 별도의 `system` 파라미터로 전달합니다.
- **OpenAI**: 메시지 목록 맨 앞에 `{role: "system", ...}`으로 추가합니다.

기존에 만들어둔 세션(이 기능 이전)도 문서 목록을 조회하는 순간 빈 `system.md`가 자동으로 채워집니다.

## 공용 커스텀 심볼

"공통 시스템 프롬프트" 바로 아래, 왼쪽 트리 맨 위에 항상 고정된 "공용 커스텀 심볼" 항목(`C` 배지)이 있습니다. 실제로는 `data/custom-symbols.csv` 파일 하나이고(기본값은 빈 파일), 계층 구분 없이 앱 전체에 항상 적용됩니다.

각 줄은 `<AsciiMath 토큰>, <LaTeX>` 형식입니다(예: `suu, \sqcup`, `pmf, \text{pmf}`) — [obsidian-publish-asciimath의 custom-symbols.csv](https://github.com/iasandcb/obsidian-publish-asciimath/blob/main/custom-symbols.csv)와 같은 형식입니다.

- **프론트엔드**(AsciiMath2 → LaTeX, `markdown.js`): 모든 줄을 그대로 `asciimath-parser`의 `symbols` 설정에 등록합니다 — 분류가 필요 없으므로 CSV의 모든 줄이 항상 적용됩니다. 저장하는 즉시(새로고침 없이) 반영됩니다.
- **백엔드**(LaTeX → AsciiMath2, `asciimath2` 변환기): "LaTeX → AsciiMath 자동 변환" 시 이 CSV를 함께 읽어 `asciimath2.Config`의 `custom_macros`/`custom_text` 확장 지점에 반영합니다. 다만 이 방향은 다음 두 형태의 LaTeX만 인식합니다.
  - 인자 없는 단독 매크로: `\sqcup`, `\hookrightarrow`, `\nleq` 등
  - `\text{X}`/`\operatorname{X}`/`\operatorname*{X}` (내용 `X`가 고정된 경우): `\text{pmf}`, `\operatorname*{LIM}` 등
  - 그 외 형태(`\frac{...}{...}` 패턴, 복합 매크로 시퀀스 등)는 이 방향에서는 조용히 무시됩니다 — 프론트엔드 렌더링(수동으로 그 토큰을 직접 입력하는 경우)에는 여전히 적용되고, LLM 응답을 자동 변환할 때만 그 특정 줄의 효과가 없을 뿐입니다.

system.md에 [수식 렌더링](#수식-렌더링)의 `<!-- math: asciimath -->`/`<!-- math: latex -->` directive를 넣으면, 그 지시자가 없는 문서(특히 LLM 응답)를 미리보기에 렌더링할 때도 기본값으로 적용됩니다. 우선순위는 **문서 자신의 directive → 세션별 `system.md`의 directive → 프로젝트별 `system.md`의 directive → 공통 `system.md`의 directive → LaTeX(최종 기본값)** 순입니다.

## 여러 브라우저에서 같은 문서 열기

두 컴퓨터(또는 두 탭)에서 같은 문서를 열어 두면, 한쪽에서 저장한 내용이 다른 쪽에 몇 초 안에 반영됩니다. 열린 문서는 탭이 보이는 동안 4초마다, 그리고 창으로 돌아올 때마다 서버에 "그 뒤로 바뀌었는지"를 묻습니다(파일 수정 시각을 버전으로 사용, 바뀌지 않았으면 내용 없이 짧은 응답).

- 이쪽에 저장 안 한 수정이 **없으면**: 저장된 내용을 그 자리에서 반영합니다. 바뀐 부분만 고쳐 쓰므로 커서 위치는 유지됩니다.
- 이쪽에 저장 안 한 수정이 **있으면**: 덮어쓰지 않고 편집기 위에 "다른 곳에서 저장됨 [불러오기] [내 것 유지]"를 띄웁니다. 내 것 유지를 고르면 그 버전에 대해서는 다시 묻지 않고, 이후 저장하면 이쪽 내용이 저장됩니다.
- 둘로 보기의 오른쪽 창도 저장 안 한 수정이 없을 때 같은 방식으로 반영됩니다.
- 답변 생성, 받아쓰기, 슬라이드 정리 중에는 확인을 쉽니다.

## 데이터 저장 방식

프로젝트 하나 = `data/projects/<프로젝트ID>/` 폴더 하나. 대화(세션) 하나 = 그 프로젝트 폴더 안 `conversations/<대화ID>/` 폴더 하나.

```
data/
  system.md                       # 공통 시스템 프롬프트
  projects/<project-id>/
    meta.json                     # 제목
    system.md                     # 프로젝트별 시스템 프롬프트 (기본 빈 문서)
    conversations/<id>/
      meta.json                   # 제목, 마지막으로 쓴 프로바이더/모델, 공식 턴 목록/순서
      system.md                   # 세션별 시스템 프롬프트 (세션마다 자동 생성, 기본 빈 문서)
      0001.md                     # 1번째 대화 (질문+답변이 한 파일에, 마크다운 문서)
      0002.md                     # 2번째 대화
      draft-a1b2c3d4.md           # 초안 문서 (아직 전송되지 않음, meta.json에는 없음)
      ...
```

각 파일은 온전한 마크다운 문서이므로, 텍스트 에디터로 직접 열어보거나 다른 도구로 재활용할 수 있습니다.

- **공식 턴**(`NNNN.md`)은 질문이 짧고 답변이 긴 경우가 대부분이라, 사용자 입력과 LLM 응답을 별개 문서 두 개로 나누지 않고 **한 파일 안에 `## User` / `## Assistant` 마크다운 헤딩으로 구분**해 담습니다(헤딩은 영어/한국어/일본어 — 메시지를 보낸 시점의 UI 언어를 따르며, 한 파일 안에서도 대화가 이어지는 동안 언어를 바꾸면 라운드마다 다른 언어의 헤딩이 섞일 수 있습니다 — 기존 라운드의 헤딩은 그대로 두고 새 라운드만 그 시점 언어로 붙습니다). 미리보기에서도 그대로 두 개의 섹션으로 보입니다. `meta.json`의 `turns` 목록에 등록되어 있고, LLM에 보낼 대화 맥락(컨텍스트)을 만들 때 이 헤딩을 기준으로 다시 질문/답변으로 분리해서 사용합니다("LLM로 보내기"를 누르면 사용자 부분만 먼저 저장되고, 응답이 스트리밍되는 대로 같은 파일에 어시스턴트 섹션이 채워집니다).
  - 이 기능 이전에 만들어진 세션의 기존 턴은 그대로 `NNNN_user.md`/`NNNN_assistant.md` 두 파일 형태로 남아 있습니다 — 기존 파일을 병합하거나 다시 쓰지 않았고, 대화 맥락을 만들 때 옛 형식과 새 형식을 자동으로 함께 처리합니다. 그 세션에서 새로 주고받는 대화부터 한 파일 형식이 적용됩니다.
  - 열려 있는 공식 턴의 내용이 **아직 답변 없는 질문으로 끝나 있으면**(전송이 실패해 답변을 못 받은 경우든, 이미 완성된 라운드 아래에 새 질문을 이어 적은 경우든) "LLM로 보내기"는 새 턴을 만드는 대신 **그 파일을 이어서 완성**합니다 — 새 질문 바로 뒤에 답변이 붙고, 그 앞의 라운드들은 그대로 보존됩니다.
- **초안**(`draft-*.md`)은 "+ 새 문서"로 만든, 아직 전송하지 않은 문서입니다. `meta.json`에 없으므로 LLM 컨텍스트에는 포함되지 않으며, 자유롭게 삭제할 수 있습니다.
- **시스템 프롬프트**(`system.md`)는 세션마다 하나씩 자동 생성되는 특수 문서입니다. 턴도 초안도 아니며, 메시지 전송 시 대화 맥락과 별도로 프로바이더의 시스템 프롬프트로 전달됩니다.
- 왼쪽 트리에서 어떤 문서든 선택해 가운데 에디터에서 수정한 뒤 **저장**하면 해당 파일이 그대로 덮어써집니다(공식 턴도 예외 없이 덮어쓰기 가능 — 대화 기록을 고정 불변으로 취급하지 않습니다).
- **삭제**(`system.md`를 제외한 각 문서 행의 × 버튼)는 초안·공식 턴 모두 가능합니다. 공식 턴을 삭제하면 그 파일뿐 아니라 `meta.json`의 `turns` 목록에서도 빠지므로, 이후 그 세션에서 주고받는 대화의 LLM 컨텍스트(`build_history`)에서도 함께 제외됩니다 — 삭제 버튼을 누르면 이 점을 다시 한번 확인합니다. 새 턴의 파일 번호(`NNNN.md`)는 항상 그 세션에서 지금까지 쓰인 가장 큰 번호 다음 값으로 매겨지므로(초안이나 존재하는 파일 개수가 아니라), 중간 턴을 삭제해 번호에 빈틈이 생겨도 다음에 만들어질 턴이 남아있는 파일과 번호가 겹치지 않습니다. `system.md`는 모든 세션에 반드시 하나 있어야 하므로 유일하게 삭제할 수 없습니다.
- **LLM로 보내기**는 에디터의 현재 내용으로 **새 공식 턴**을 만듭니다. 열려 있던 문서(초안이든 과거 턴이든)를 덮어쓰지 않습니다 — 단, 열려 있는 턴이 이미 답변 없는 질문으로 끝나 있으면 예외로, 그 턴 자체를 이어서 완성합니다(위 참고).
- **이름 변경**(각 문서 행의 ✎ 버튼)은 `system.md`를 제외한 모든 문서(초안·공식 턴 모두)에서 가능합니다. 공식 턴을 리네임해도 역할/순서 정보는 파일명이 아니라 `meta.json`에 저장돼 있으므로 안전하며, 리네임 시 그 기록도 함께 갱신됩니다. 파일명은 `.md`로 끝나야 하고 경로 구분자(`/`)는 쓸 수 없다는 것 외에는 한글·공백 등 자유롭게 허용됩니다.

## 수식 렌더링

KaTeX(LaTeX)와 [asciimath-parser](https://github.com/widcardw/asciimath-parser)(AsciiMath2 → LaTeX 변환 후 KaTeX 렌더링)를 jsDelivr CDN에서 로드해 사용합니다. 여기서 말하는 AsciiMath는 asciimath.org 원본 표준이 아니라 그 확장인 **AsciiMath2**입니다 — 표준 정의는 [asciimath2의 SPEC.md](https://github.com/iasandcb/asciimath2/blob/main/SPEC.md) 참고. KaTeX는 `index.html`에 `<script>` 태그로, asciimath-parser는 브라우저용 UMD 빌드가 없어 `frontend/static/js/markdown.js`에서 ES 모듈로 직접 `import`합니다. 둘 다 고정 버전으로 링크되어 있으므로, 실행 환경에 인터넷 접속이 필요합니다(오프라인 환경이라면 해당 파일들을 `frontend/static/vendor/`에 내려받아 로컬 경로로 바꿔주세요).

| 문법 | 종류 | 예시 |
|---|---|---|
| `$...$` | 인라인 수식 (기본 LaTeX, directive로 전환 가능) | `질량 $E=mc^2$ 등가식` |
| `$$...$$` | 블록 수식 (한 줄 또는 여러 줄, 기본 LaTeX, directive로 전환 가능) | `$$ \int_0^1 x^2\,dx = \tfrac13 $$` |
| `\(...\)` | 인라인 수식 (항상 LaTeX) | `질량 \(E=mc^2\) 등가식` |
| `\[...\]` | 블록 수식 (한 줄 또는 여러 줄, 항상 LaTeX) | `\[ \int_0^1 x^2\,dx = \tfrac13 \]` |
| ` ```asciimath ` | 블록 AsciiMath (항상 AsciiMath) | ` ```asciimath\nsqrt(2)/3\n``` ` |
| ` ```math ` / ` ```latex ` | 블록 LaTeX (항상 LaTeX) | ` ```math\n\frac{1}{2}\n``` ` |

`\(...\)`/`\[...\]`는 표준 LaTeX2e 명령이며(LLM들이 `$...$`/`$$...$$`보다 오히려 이쪽을 더 자주 씁니다), AsciiMath 대응 표기가 없으므로 ` ```math ` 펜스처럼 문서의 math directive와 무관하게 항상 LaTeX로 렌더링됩니다.

`$...$`/`$$...$$`가 기본으로는 LaTeX를 뜻하지만, 문서 아무 곳에나(주로 맨 위에) 아래 directive 주석을 넣으면 그 문서 전체에서 `$`/`$$`를 AsciiMath로 해석합니다. 여러 개 있으면 마지막 것이 적용되고, 이 주석 줄 자체는 렌더링 결과에는 나타나지 않습니다(다른 마크다운 뷰어에서 열어도 일반 HTML 주석이라 보이지 않습니다).

```
<!-- math: asciimath -->
```

```
<!-- math: latex -->
```

세 번째로 `hybrid`가 있습니다 — `$...$`/`$$...$$`는 `asciimath`와 똑같이 AsciiMath지만, `\(...\)`/`\[...\]`는 (원래부터 그렇듯) 항상 LaTeX라는 점을 **의도적으로 활용**하는 모드입니다: 같은 문서 안에서 어떤 수식은 `$`로, 어떤 수식은 `\(`로 써서 두 표기를 나란히 섞어 쓰겠다는 선택이고, "LaTeX → AsciiMath2 자동 변환"도 이 구분을 그대로 지킵니다(아래 참고).

```
<!-- math: hybrid -->
```

에디터 상단 "Math" 라디오(LaTeX/AsciiMath/Hybrid)로 현재 문서의 방식을 바로 바꿀 수 있고, 전환 시 필요하면 기존 수식도 함께 변환됩니다(AsciiMath2 ⇄ LaTeX 변환에 대한 안내는 아래 "LaTeX → AsciiMath2 자동 변환" 참고 — Hybrid로 전환할 땐 `$`/`$$` 수식만 변환되고 `\(`/`\[` 수식은 그대로 남습니다).

` ```asciimath `/` ```math ` 펜스 블록은 이미 명시적이라 directive와 무관하게 항상 그대로 동작합니다.

인라인 AsciiMath 전용 구분자(`%...%`)는 제공하지 않습니다 — "10%에서 20%로" 같은 평범한 백분율 표기와 충돌하기 쉬워서, directive로 문서 전체의 `$` 의미를 바꾸는 방식으로 대체했습니다.

블록 수식에 여러 줄을 쓰면 dialect에 따라 다르게 처리됩니다.

- **LaTeX**(기본값)에서는 각 줄이 실제 줄바꿈으로 분리되고 가운데 정렬되어 렌더링됩니다(내부적으로 KaTeX의 `gathered` 환경 사용). 빈 줄은 무시됩니다.
- **AsciiMath2**에서는 AsciiMath2 자체의 정렬 문법을 그대로 씁니다 — 빈 줄이 행(row) 구분자이고, 각 행 안의 `&`는 정렬 마커로 그대로 전달됩니다([asciimath2 SPEC.md](https://github.com/iasandcb/asciimath2/blob/main/SPEC.md) 2.2절). 전체 블록을 한 번에 asciimath-parser에 넘기므로 `\begin{aligned}`/행렬(`[a,b;c,d]`) 구조가 그대로 살아납니다. 빈 줄이 없는 단일 표현식은 이전과 동일하게 한 줄로 렌더링됩니다.

`$$`/`\[`/`\]` 여는·닫는 마커는 그 줄에 단독으로 있지 않아도 됩니다 — LLM이 자주 쓰는 `\[A=\n\begin{bmatrix}...\end{bmatrix}\]`처럼 마커 바로 뒤/앞에 내용이 붙어 있어도 블록으로 인식합니다.

파싱에 실패한 수식은 오류를 표시할 뿐 전체 렌더링을 막지 않습니다.

### LaTeX → AsciiMath2 자동 변환

LLM이 직접 AsciiMath를 생성하면 품질이 떨어지는 경우가 많습니다(학습 데이터에 LaTeX가 압도적으로 많아서). 그래서 메시지를 보낼 때 전송 툴바의 "Math" 라디오에서 **AsciiMath** 또는 **Hybrid**를 선택해두면, LLM에게는 평소처럼 LaTeX로 답하게 하고 — 응답이 저장되기 직전에 서버(`backend/app/latex_to_asciimath.py`, [`asciimath2`](https://github.com/iasandcb/asciimath2) 패키지 사용)가 수식을 하나씩 AsciiMath2로 변환을 시도합니다. **LaTeX**를 선택해두면 변환 없이 LLM 응답 그대로 저장됩니다.

- **AsciiMath** 선택 시: `$...$`/`$$...$$`/`\(...\)`/`\[...\]` 안의 수식을 전부 변환 대상으로 삼습니다. 성공한 것은 `$...$`/`$$...$$`(AsciiMath2)로 바뀌고, 문서 맨 위에 `<!-- math: asciimath -->`가 자동으로 붙습니다. 행렬·정렬 수식(`\begin{pmatrix}`, `\begin{aligned}` 등)도 변환됩니다 — `asciimath2`가 이런 구문을 지원하는 것이 이전에 쓰던 `py-asciimath`와 갈아탄 이유입니다.
- **Hybrid** 선택 시: `$...$`/`$$...$$` 안의 수식만 변환 대상으로 삼고, `\(...\)`/`\[...\]`는 변환을 시도조차 하지 않고 원본 LaTeX 그대로 둡니다 — LLM이 어느 표기를 썼는지에 따라 결과물이 두 표기로 자연스럽게 나뉩니다. 문서 맨 위에는 `<!-- math: hybrid -->`가 붙습니다.
- (두 모드 공통) 변환에 **실패**하면(asciimath2가 지원하지 않는 구문 — [asciimath2 README](https://github.com/iasandcb/asciimath2#readme)의 "Scope, honestly" 참고) 원본 LaTeX를 `\(...\)`/`\[...\]`로 남겨서 — directive와 무관하게 항상 LaTeX로 렌더링되므로 — 깨지지 않고 그대로 보입니다.
- 그 외에 조용히 틀린 결과를 내는(에러 없이) 경우까지는 자동으로 잡아내지 못합니다 — 이건 알려진 잔여 위험입니다.

메시지 단위 설정이며 기본값은 꺼짐입니다(위 "프로바이더/모델/사고 수준/변환 설정은 턴 단위입니다" 참고) — 매번 켜고 끌 수 있습니다.

## API 개요

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/providers` | 사용 가능한 LLM 프로바이더/모델 목록 |
| GET | `/api/projects` | 프로젝트 목록 (레거시 `data/conversations/`가 남아 있으면 이 호출에서 `기본 프로젝트`로 마이그레이션) |
| POST | `/api/projects` | 새 프로젝트 생성 `{title?}` |
| GET | `/api/projects/{id}` | 프로젝트 상세 조회 |
| PATCH | `/api/projects/{id}` | 프로젝트 이름 변경 `{title}` |
| DELETE | `/api/projects/{id}` | 프로젝트 삭제 (안의 모든 세션·대화 함께 삭제) |
| GET | `/api/projects/{id}/system-prompt` | 프로젝트별 시스템 프롬프트 조회 `{content}` |
| PUT | `/api/projects/{id}/system-prompt` | 프로젝트별 시스템 프롬프트 저장 `{content}` |
| GET | `/api/projects/{id}/conversations` | 그 프로젝트의 대화 목록 |
| POST | `/api/projects/{id}/conversations` | 새 대화 생성 `{title?}` |
| GET | `/api/projects/{id}/conversations/{cid}` | 대화 상세(모든 공식 턴 포함) 조회 |
| PATCH | `/api/projects/{id}/conversations/{cid}` | 세션 이름 변경 `{title}` |
| DELETE | `/api/projects/{id}/conversations/{cid}` | 대화 삭제 |
| GET | `/api/projects/{id}/conversations/{cid}/documents` | 세션 내 모든 문서(공식 턴 + 초안 + `system.md`) 목록/내용 조회, `system.md`가 항상 맨 앞 |
| POST | `/api/projects/{id}/conversations/{cid}/documents` | 빈 초안 문서 생성 |
| PUT | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 내용 덮어쓰기 (`system.md` 포함) |
| PATCH | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 이름 변경 `{new_filename}` (`system.md`는 400) |
| DELETE | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 삭제 (초안·공식 턴 모두 가능, `system.md`만 400) |
| POST | `/api/projects/{id}/conversations/{cid}/messages` | 사용자 턴 전송 `{content, provider, model, reasoning_effort?, convert_math?, hybrid_math?, language?}` → LLM 응답을 NDJSON으로 스트리밍. `language`(`en`/`ko`/`ja`, 기본 `en`)는 이번에 새로 붙는 `## User`/`## Assistant` 헤딩의 언어를 고릅니다. `hybrid_math`(`convert_math`가 true일 때만 의미 있음)를 켜면 `$`/`$$` 수식만 변환하고 `\(`/`\[` 수식은 그대로 둡니다. |
| POST | `/api/projects/{id}/conversations/{cid}/transcribe` | 오디오 전사(화자 분리) multipart `file, title?, language?, audio_language?` → NDJSON `status`/`heartbeat`/`document`/`error` 이벤트, 결과는 새 초안 문서 |
| GET | `/api/transcribe/config` | 전사 사용 가능 여부 `{available, model}` |
| POST | `/api/convert-to-asciimath` | 문서 전체를 지금 바로 AsciiMath2로 변환 `{content, hybrid?}` → `{content}`. `hybrid`를 켜면 `$`/`$$` 수식만 변환합니다. |
| GET | `/api/system-prompt` | 공통(전역) 시스템 프롬프트 조회 `{content}` |
| PUT | `/api/system-prompt` | 공통 시스템 프롬프트 저장 `{content}` |
| GET | `/api/custom-symbols` | 공용 커스텀 심볼 CSV 조회 `{content}` |
| PUT | `/api/custom-symbols` | 공용 커스텀 심볼 CSV 저장 `{content}` |

`POST /messages`는 줄바꿈으로 구분된 JSON 이벤트를 스트리밍합니다. `user_turn`과 `assistant_turn`은 서로 다른 파일이 아니라 **같은 파일**(`turn.file`)의 두 저장 시점입니다 — `user_turn`은 사용자 부분만 담아 새로 만든 직후, `assistant_turn`은 어시스턴트 부분까지 채워 다시 저장한 직후:

```
{"type": "user_turn", "turn": {"id": "...", "file": "0003.md", "content": "## User\n\n...", ...}}
{"type": "delta", "text": "..."}
{"type": "delta", "text": "..."}
{"type": "tool_status", "status": "running"|"completed", ...}   (일부 프로바이더만)
{"type": "assistant_turn", "turn": {"id": "...", "file": "0003.md", "content": "## User\n\n...\n\n## Assistant\n\n...", ...}}
```

프로바이더 오류 발생 시 `{"type": "error", "message": "..."}` 이벤트가 전송됩니다.

## 새 LLM 프로바이더 추가하기

**OpenAI 호환 API**라면 위의 [OpenAI 호환 프로바이더](#openai-호환-프로바이더-hermes-자체-호스팅-등) 처럼 `.env`에 `CUSTOM_OPENAI_PROVIDERS` 한 줄만 추가하면 되고, 코드 수정이 필요 없습니다.

그 외의 새 API 형식을 통째로 추가하려면:

1. `backend/app/providers/`에 `LLMProvider`를 상속한 클래스 작성 (`stream(messages, model, reasoning_effort=None) -> AsyncIterator[str]`와 `list_models() -> list[str]` 구현)
2. `backend/app/providers/registry.py`의 `STATIC_PROVIDER_INFO`, `get_provider()`, `_is_configured()`에 등록

프론트엔드는 `/api/providers` 응답을 그대로 반영하므로 별도 수정이 필요 없습니다.

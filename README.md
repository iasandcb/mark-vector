# mark-vector

마크다운 문서 단위로 입력/출력을 주고받는 LLM 클라이언트 웹 앱입니다. 대화의 각 턴(사용자 입력, LLM 응답)은 하나의 완전한 마크다운 문서로 취급되며, 파일시스템에 `.md` 파일로 저장됩니다.

**인터넷에 올리기 전에:** `GOOGLE_CLIENT_ID` 또는 `APP_PASSCODE`가 없으면 이 앱은 로그인을 요구하지 않습니다. 그 호스트의 문서 조회·수정·삭제, 스토리지 삭제, LLM 호출(API 과금), Soniox 임시 키 발급, ingest가 주소만 알면 열려 있습니다. `POST /api/ingest/audio`는 세션 대신 `INGEST_TOKEN`을 보며, 그 토큰이 없으면 404입니다. `/api/public/custom-symbols`와 `/api/public/spoken-math`는 인증과 관계없이 공개이고, scripter가 그대로 읽습니다. Fly.io에 이 값을 넣는 명령은 [배포](docs/deploy.md)에 있습니다.

## 기능

- [화면](docs/ui.md) — 3단(트리·에디터·미리보기), 탭, 휴대폰에서는 한 화면, 분할 보기에서 대화로 옆 문서를 고칩니다.
- [문서와 저장](docs/documents-and-storage.md) — 프로젝트·폴더·문서, 시스템 프롬프트, 공용 커스텀 심볼, 여러 브라우저에서 같은 문서, 디스크 형식.
- [모델](docs/models.md) — 모델 목록과 사고 수준, ChatGPT 플랜, OpenAI 호환 엔드포인트, 새 프로바이더를 코드로 넣는 방법.
- [수식](docs/math.md) — KaTeX·AsciiMath2 렌더링과 LaTeX에서 AsciiMath2로 바꾸는 자동 변환.
- [오디오](docs/audio.md) — 화자 분리 전사, 받아쓰기, 수식 받아쓰기, 음성 토론.
- [슬라이드 리모컨](docs/slides-remote.md) — 게임패드로 실시간 슬라이드를 만들고 청중 화면을 넘깁니다.
- [YouTube 작업 큐](docs/youtube-queue.md) — 맥의 워커가 끌어 가는 녹음 영상 큐와 JSON 계약.
- [X 아티클](docs/x-articles.md) — 편집 중인 문서를 X 아티클 초안으로 보냅니다.
- [세토 iPhone](docs/seto-iphone.md) — 세토 앱이 문서를 실시간으로 씁니다.
- [API](docs/api.md) — HTTP와 NDJSON 스트리밍 개요.

## 자주 찾는 설정

- 프로바이더·모델·사고 수준·맥락은 메시지를 보낼 때마다 고르고, 수식 표기는 그 문서의 directive를 따릅니다. [모델](docs/models.md)
- 받아쓰기는 브라우저 내장, OpenAI, Soniox 중 하나입니다. Soniox 키는 서버에만 있고 브라우저에는 짧은 임시 키만 갑니다. [오디오](docs/audio.md)
- 슬라이드 리모컨은 키보드 모드가 아니라 일반 게임패드 모드로 붙입니다. [슬라이드 리모컨](docs/slides-remote.md)
- YouTube 영상은 이 서버가 맥을 호출하지 않습니다. 맥의 워커가 큐를 끌어 갑니다. [YouTube 작업 큐](docs/youtube-queue.md)
- X로 보내는 것은 초안 한 번이고, 공개 발행은 X에서 합니다. [X 아티클](docs/x-articles.md)

## 구성

- **백엔드**: Python (FastAPI). [uv](https://docs.astral.sh/uv/)가 Python 3.14와 의존성을 설치합니다.
- **프론트엔드**: 바닐라 HTML / CSS / JS. FastAPI가 `frontend/`를 함께 서빙합니다.
- **LLM**: Anthropic, OpenAI, ChatGPT 플랜(API 키 대신 로그인), OpenAI 호환 엔드포인트.
- **수식**: KaTeX(LaTeX)와 [AsciiMath2](https://github.com/iasandcb/asciimath2).
- 디렉터리 배치는 [프로젝트 구조](docs/project-structure.md), 화면의 나머지는 [화면](docs/ui.md)에 있습니다.

`data/`의 대화, 시스템 프롬프트, 커스텀 심볼, 녹음, YouTube 큐는 실행 중에 생기며 git에 들어가지 않습니다.

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

FastAPI가 `frontend/` 디렉터리를 함께 서빙하므로 별도의 프론트엔드 서버나 빌드 과정이 필요 없습니다. 자기 Fly.io 앱으로 띄우는 절차는 [배포](docs/deploy.md)에 있습니다.

## 환경 변수

로컬 설정은 `backend/.env`입니다. LLM 프로바이더 키는 최소 하나만 있으면 됩니다. 키가 하나도 없으면 툴바에 설정 안내가 나옵니다.

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | 하나 이상. 없는 프로바이더는 드롭다운에 나오지 않습니다 |
| `APP_PASSCODE` 또는 `GOOGLE_CLIENT_ID` | 인터넷에 열기 전에 필요합니다. 위의 경고를 보세요. Google 로그인에는 `GOOGLE_CLIENT_SECRET`도 필요합니다 |
| `DATA_DIR` | 대화 저장 경로. 기본값 `../data` |

Soniox, ingest, YouTube 워커, X 아티클, 디스크 경고까지 포함한 표는 [환경 변수](docs/configuration.md)에 있습니다.

API 키 없이 OpenAI 모델을 쓰려면 [ChatGPT 플랜](docs/models.md)으로 로그인합니다. `/v1/chat/completions`를 따르는 서비스는 [모델](docs/models.md)의 `CUSTOM_OPENAI_PROVIDERS`로 추가합니다.

대화는 `DATA_DIR` 아래 마크다운 파일입니다. 턴 하나의 질문과 답은 한 파일에 담기고, 시스템 프롬프트는 공통·프로젝트·폴더 순으로 이어 붙습니다. 파일 형식은 [문서와 저장](docs/documents-and-storage.md)에 있습니다.

## 배포

노트북에서만 쓰면 [설치 및 실행](#설치-및-실행)이면 됩니다. 포크를 자기 Fly.io 앱으로 띄우는 전체 절차는 [배포](docs/deploy.md)에 있습니다. 그 전에 필요한 것만 적으면 다음과 같습니다.

- `fly.toml`의 `app`(이 저장소는 `markvector`), `primary_region`(이 저장소는 `nrt`), 볼륨 `source`(이 저장소는 `markvector_data`)를 자기 값으로 바꿉니다. `destination`과 `DATA_DIR`은 `/data`입니다.
- 볼륨은 배포 전에 만듭니다. `fly.toml`에 `initial_size`가 없어서 `fly deploy`가 볼륨을 대신 만들지 않습니다.
- 공개 전에 `APP_PASSCODE` 또는 Google 로그인(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`)을 `fly secrets set`으로 넣습니다. 켜지 않으면 위의 경고대로 주소만 알면 열립니다.
- 쓰는 API 키와 `SONIOX_API_KEY`, `INGEST_TOKEN`, `WORKER_TOKEN`, X 자격증명도 시크릿입니다. `INGEST_TOKEN`과 `WORKER_TOKEN`은 서로 다른 값입니다.
- `main`에 푸시하거나 Actions에서 수동 실행하면 `.github/workflows/fly-deploy.yml`이 `flyctl deploy --remote-only`를 돌립니다. Actions secret 이름은 `FLY_API_TOKEN`이고, 배포 대상 앱은 `fly.toml`의 `app`입니다.
- ChatGPT 플랜 자격증명을 볼륨으로 옮길 때는 `uv run python -m app.chatgpt_auth push --app <앱 이름>`입니다. 서버 경로는 `/data/chatgpt/`입니다.

키, 토큰, 배포 토큰은 이 문서나 git에 적지 않습니다.

## 라이선스

Copyright (c) 2026 Changshin Lee. 이 저장소는 [MIT License](LICENSE)입니다.

`frontend/static/js/vendor/`에 벤더 고지가 있습니다. CodeMirror 6 번들은 MIT입니다. lz-string 1.5.0은 소스 헤더의 WTFPL이며, 태그 1.5.0의 LICENSE 파일은 MIT입니다. KaTeX와 asciimath-markdown은 CDN에서 불러오며 이 라이선스에 포함되지 않습니다.

## 문서

목차는 [docs/README.md](docs/README.md)입니다.

- [화면](docs/ui.md) — 레이아웃, 탭, 옆 문서 편집
- [프로젝트 구조](docs/project-structure.md) — 저장소 디렉터리
- [환경 변수](docs/configuration.md) — `backend/.env`
- [배포](docs/deploy.md) — 포크의 Fly.io 절차
- [모델](docs/models.md) — 모델, ChatGPT 플랜, 호환 프로바이더
- [오디오](docs/audio.md) — 전사, 받아쓰기, 음성 토론
- [슬라이드 리모컨](docs/slides-remote.md) — 게임패드와 실시간 슬라이드
- [문서와 저장](docs/documents-and-storage.md) — 트리, 시스템 프롬프트, 파일 형식
- [수식](docs/math.md) — 렌더링과 자동 변환
- [YouTube 작업 큐](docs/youtube-queue.md) — 워커 JSON 계약
- [X 아티클](docs/x-articles.md) — 초안 내보내기
- [API](docs/api.md) — HTTP 개요
- [세토 iPhone](docs/seto-iphone.md) — 실시간 입력 웹소켓

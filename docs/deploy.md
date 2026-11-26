[목차](README.md) · [README](../README.md)

## 배포

포크한 저장소를 자기 Fly.io 계정에 띄우는 절차입니다. flyctl로 `fly auth login`이 된 계정에서, 저장소 루트(`fly.toml`과 `Dockerfile`이 있는 곳)에서 진행합니다. 같은 앱을 노트북에서만 실행하려면 [설치 및 실행](../README.md#설치-및-실행)이면 되고, 아래 시크릿과 같은 이름의 변수는 `backend/.env`에 넣습니다.

`fly.toml`에 들어 있는 다음 값은 원 계정의 앱·리전·볼륨입니다. 포크는 배포 전에 자기 것으로 바꿉니다.

- `app = 'markvector'`
- `primary_region = 'nrt'`
- `[[mounts]]`의 `source = 'markvector_data'` (`destination = '/data'`. `[env]`의 `DATA_DIR = '/data'`와 같은 경로)

파일을 직접 고칠 때는 그 세 칸을 바꿉니다. 기존 `fly.toml`(Dockerfile 빌드, 포트 8080, `/data` 마운트, 머신 크기)을 유지한 채 새 앱으로 등록하려면 다음을 씁니다. `--copy-config`는 있는 설정 파일을 스캐너 질문 없이 사용합니다. `--name`은 등록할 앱 이름이고, `--primary-region`은 `primary_region`을 그 리전으로 덮어씁니다. `--no-deploy`는 볼륨과 로그인을 넣기 전에 머신을 띄우지 않습니다. `source`는 이 명령이 바꾸지 않으므로, 원 앱의 볼륨 이름 `markvector_data`를 자기 볼륨 이름으로 고칩니다.

```bash
fly launch --copy-config --no-deploy --name <앱 이름> --primary-region <리전>
```

등록 뒤에는 `fly.toml`을 다시 읽습니다. `app`이 자기 앱 이름인지, `primary_region`이 고른 리전인지, `min_machines_running = 1`과 `[[mounts]]`가 그대로인지 확인합니다. `app`이 아직 `markvector`이면 그 칸을 자기 앱 이름으로 고칩니다.

볼륨은 배포 전에 만듭니다. `[[mounts]]`에는 `source`와 `destination`만 있고 `initial_size`가 없어서, `fly deploy`가 볼륨을 대신 만들지 않습니다. 이름은 고친 `source`, 리전은 `primary_region`과 같게 합니다. `--size`의 단위는 GB입니다. 이 저장소의 Fly 데이터는 `/data`에 마운트된 1GB 볼륨입니다(`backend/app/volume.py`).

```bash
fly volumes create <볼륨 이름> --app <앱 이름> --region <리전> --size 1
```

머신은 `fly.toml` 기준으로 한 대(`min_machines_running = 1`, `size = 'shared-cpu-1x'`, `memory = '512mb'`)이고 `auto_stop_machines = 'off'`라 유휴여도 꺼지지 않습니다. 그 머신에 볼륨이 하나 있으면 됩니다.

### 시크릿

공개 전 조건과, 로그인이 없을 때 열리는 범위는 [인터넷에 올리기 전에](../README.md)에 있습니다. `APP_PASSCODE`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`가 켜는 기능은 [환경 변수](configuration.md) 표와 같습니다. `GOOGLE_CLIENT_SECRET`은 `GOOGLE_CLIENT_ID`와 같이 넣습니다.

Google 콘솔의 리다이렉트 URI는 앱의 https 주소에 `/auth/callback`을 붙인 값이고, 기본 호스트라면 `https://<앱 이름>.fly.dev/auth/callback`입니다. Fly가 TLS를 끝내고, 컨테이너는 `Dockerfile`의 `--proxy-headers`로 그 `https`를 믿습니다.

로그인을 켠 뒤에도 `/`, `/about`, `/p/`, `/glasses`는 그대로 열립니다. `/api/public/`는 [인터넷에 올리기 전에](../README.md)의 공개 CSV와 같습니다. `/api/worker/`는 세션 대신 `WORKER_TOKEN`을 봅니다. `DATA_DIR`은 `fly.toml`이 이미 `/data`로 넣으므로 시크릿으로 다시 넣지 않습니다. `INGEST_TIMEZONE`과 `STORAGE_WARN_PERCENT`는 [환경 변수](configuration.md) 표를 따릅니다. OpenAI 호환 엔드포인트는 [OpenAI 호환 프로바이더](models.md#openai-호환-프로바이더-hermes-자체-호스팅-등)의 `CUSTOM_OPENAI_PROVIDERS`입니다.

값은 `fly secrets set`으로 넣습니다. `...`와 `you@example.com`은 자리표시이므로 자기 값으로 바꾸고, 쓰지 않는 줄은 빼세요. `--stage`는 저장만 하고 머신을 아직 배포하지 않습니다.

| 이름 | 언제 | 켜는 기능 |
|---|---|---|
| `APP_PASSCODE` | 공개 전 (Google과 둘 중 하나, 또는 둘 다) | [환경 변수](configuration.md) 표와 같음 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 공개 전 (암호와 둘 중 하나, 또는 둘 다) | [환경 변수](configuration.md) 표와 같음. 시크릿도 같이 넣습니다 |
| `ALLOWED_EMAILS` | Google을 쓸 때 | [환경 변수](configuration.md) 표와 같음. 비우면 아무도 허용하지 않습니다 |
| `ANTHROPIC_API_KEY` | 선택 | Anthropic. 없으면 그 프로바이더는 비활성. |
| `OPENAI_API_KEY` | 선택 | OpenAI 대화, 화자 분리 전사, 실시간 받아쓰기. 없으면 비활성. |
| `XAI_API_KEY` | 선택 | xAI(Grok). 없으면 비활성. |
| `SONIOX_API_KEY` | 선택 | Soniox 실시간 받아쓰기. 없으면 엔진 목록에 나오지 않습니다. |
| `INGEST_TOKEN` | 선택 | `POST /api/ingest/audio`의 Bearer. 없으면 그 API는 404. |
| `WORKER_TOKEN` | 선택 | YouTube 워커 `/api/worker/`의 Bearer. `INGEST_TOKEN`과 다른 비밀. 없으면 404. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | 선택 | X 아티클 초안(OAuth 1.0a). `XAI_API_KEY`와 별개입니다. |
| `X_USER_ACCESS_TOKEN` | 선택 | X 아티클용 OAuth 2.0 사용자 토큰. OAuth 1.0a 네 값이 있으면 그쪽이 우선입니다. |

```bash
fly secrets set APP_PASSCODE=... --stage --app <앱 이름>
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ALLOWED_EMAILS=you@example.com --stage --app <앱 이름>
fly secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=... XAI_API_KEY=... --stage --app <앱 이름>
fly secrets set SONIOX_API_KEY=... --stage --app <앱 이름>
fly secrets set INGEST_TOKEN=... WORKER_TOKEN=... --stage --app <앱 이름>
fly secrets set X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=... --stage --app <앱 이름>
fly secrets set X_USER_ACCESS_TOKEN=... --stage --app <앱 이름>
```

`INGEST_TOKEN`과 `WORKER_TOKEN`은 서로 다른 임의 문자열입니다. 만드는 예는 `openssl rand -hex 32`입니다.

### 첫 배포

시크릿과 볼륨이 준비된 뒤 저장소 루트에서 첫 배포를 합니다.

```bash
fly deploy
```

빌드 컨텍스트는 저장소 루트입니다. `Dockerfile`이 `backend/`, `frontend/`, `glasses/`를 같이 넣고, `fly.toml`의 `[build]`가 그 파일을 가리킵니다. `internal_port = 8080`은 이미지의 `PORT=8080`과 같습니다. `fly deploy`의 빌드 기본은 Fly 원격 빌더입니다.

ChatGPT 플랜 자격증명을 이 볼륨으로 옮길 때 `push`의 기본 앱은 `markvector`입니다(`backend/app/chatgpt_auth.py`의 `FLY_APP`). 포크는 `uv run python -m app.chatgpt_auth push --app <앱 이름>`으로 자기 앱을 지정합니다. 볼륨 안의 경로는 `/data/chatgpt/`입니다.

### GitHub Actions

`.github/workflows/fly-deploy.yml`은 `main`에 push되거나 수동 실행(`workflow_dispatch`)일 때 `flyctl deploy --remote-only`를 돌립니다. 이미지는 Fly 원격 빌더에서 만들므로 러너에 Docker는 필요 없습니다. 앱 이름, 리전, 포트, `/data` 볼륨은 `fly.toml`에서 읽습니다. 워크플로 명령에는 앱 이름이 없고, `fly.toml`의 `app`이 배포 대상입니다. 포크가 이 워크플로 안에 앱 이름을 직접 적었다면 그 문자열도 자기 앱으로 바꿉니다.

저장소 Actions secret 이름은 `FLY_API_TOKEN`입니다. 앱을 만든 뒤 `fly tokens create deploy`가 인쇄하는 배포 토큰을 그 이름으로 넣습니다(설정 → Secrets and variables → Actions). 토큰 문자열은 이 문서나 git에 적지 않습니다.

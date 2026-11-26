[목차](README.md) · [README](../README.md)

## 환경 변수 (`backend/.env`)

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 키 (선택, 미설정 시 해당 프로바이더 비활성) |
| `OPENAI_API_KEY` | OpenAI API 키 (선택, 미설정 시 해당 프로바이더 비활성) |
| `SONIOX_API_KEY` | Soniox 실시간 전사 키 (선택). 서버에만 두고, 브라우저에는 짧은 임시 키만 줍니다. 미설정 시 Soniox는 받아쓰기 엔진에 나오지 않습니다. Fly에 넣는 방법은 [배포](deploy.md). |
| `XAI_API_KEY` | xAI(Grok) API 키 (선택, 미설정 시 해당 프로바이더 비활성) |
| `INGEST_TOKEN` | 봇이 오디오를 올리는 `POST /api/ingest/audio`의 Bearer 토큰 (선택, 미설정 시 비활성) |
| `INGEST_TIMEZONE` | 업로드 날짜 폴더의 기준 시간대이자, 녹음 id에 적힌 시각을 UTC로 읽을 때의 시간대 (기본 `Asia/Seoul`) |
| `WORKER_TOKEN` | YouTube 워커 큐(`/api/worker/...`)의 Bearer 토큰. `INGEST_TOKEN`과 다른 비밀. 미설정 시 그 API는 404 |
| `DATA_DIR` | 대화 저장 경로 (기본값: `../data`) |
| `STORAGE_WARN_PERCENT` | 데이터 디렉터리 디스크 사용률이 이 퍼센트 이상이면 워크스페이스에 경고 (기본 `80`, 0–100. 그 외 값은 무시하고 80) |
| `APP_PASSCODE` | 정확히 4자리면 로그인 필요. Google과 함께 두면 둘 중 하나로 들어옵니다. 그 외 값은 무시 |
| `GOOGLE_CLIENT_ID` | 이 값이 있으면 앱 인증이 켜집니다. 실제 Google 로그인에는 `GOOGLE_CLIENT_SECRET`도 필요합니다 |
| `ALLOWED_EMAILS` | Google로 허용할 주소, 쉼표로 구분, 소문자로 맞춥니다. 비우면 아무도 허용하지 않습니다. 소스에 기본 주소는 없습니다 |

프로바이더는 최소 하나만 설정하면 됩니다. API 키가 없는 프로바이더는 드롭다운에 나오지 않고, 하나도 없으면 툴바에 "설정된 LLM 프로바이더가 없습니다. 서버의 .env에서 API 키를 설정하세요."가 표시됩니다.

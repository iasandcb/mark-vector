[목차](README.md) · [README](../README.md)

## X 아티클로 내보내기

편집기 상단 **𝕏 아티클**에서 현재 편집 중인 문서를 X 아티클 초안으로 보냅니다. 저장 전 수정도 포함하며, 인라인 대화는 펼쳐져 있어도 제외합니다. 분할 보기에서 왼쪽이 `.c.md`이고 오른쪽이 그 짝 `.md`이면, 오른쪽 창의 같은 버튼이 오른쪽 문서를 초안으로 보냅니다. 제한·오류 안내는 어느 쪽이든 같은 창을 씁니다. 먼저 제목과 변환 결과를 확인하고 **X에 초안 만들기**를 누릅니다. 그 뒤 **X 아티클 열기**를 눌러 X의 아티클 목록에서 해당 제목의 초안을 선택하고 편집·공개 발행을 마무리합니다. 마크벡터의 발행/공유 링크는 생성하지 않으며, 이후 원본 문서 수정은 X에 자동 반영되지 않습니다.

X API 호출은 초안 생성 한 번으로 끝납니다. 공개 발행 API 경로와 버튼은 제공하지 않습니다. 2026-10-29 확인한 [X 공식 요금표](https://developer.x.com/?lang=en)의 `Article: Draft` 단가 기준, 정상 전송 한 편당 **$0.01**입니다. X 웹에서 직접 발행하므로 별도 `Article: Publish` API 호출 비용은 없습니다. X 구독료, 세금, 결제 수수료는 별도입니다.

### API 자격증명 설정

X 개발자 앱에서 **Read and Write** 권한을 켜고, 발행할 계정의 OAuth 1.0a 사용자 Access Token/Secret을 발급합니다. 권한을 바꾼 뒤에는 사용자 토큰을 다시 발급해야 할 수 있습니다. 서버의 `backend/.env`에 다음 네 값을 설정하고 서버를 재시작합니다. Fly에서는 [배포](deploy.md)의 `fly secrets set`에 같은 이름을 넣습니다.

```dotenv
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

이 키는 Grok용 `XAI_API_KEY`와 별개입니다. 자격증명은 서버에서만 사용하며 브라우저에 전달하지 않습니다. 이 앱은 개인용 공유 작업 공간이므로 앱 접근 권한이 있는 사용자는 모두 **서버에 설정한 하나의 X 계정**으로 내보냅니다.

대안으로 `tweet.read tweet.write users.read` 권한이 있는 **OAuth 2.0 사용자 컨텍스트** 토큰을 `X_USER_ACCESS_TOKEN`에 설정할 수 있습니다. 앱 전용 Bearer Token은 발행 권한이 없습니다. OAuth 2.0 사용자 토큰은 만료되면 직접 갱신해야 하며, 네 개의 OAuth 1.0a 값이 모두 있으면 그쪽을 우선 사용합니다. 발행 계정은 X 아티클 이용 자격이 있어야 하며, API 접근 권한·크레딧도 별도로 필요할 수 있습니다. [X 아티클 안내](https://help.x.com/en/using-x/articles), [공식 API](https://docs.x.com/x-api/articles/introduction).

### 변환과 재시도

- 첫 H1을 아티클 제목으로 분리하고, 없으면 파일명을 사용합니다. 내보내기 창에서 제목을 바꿀 수 있습니다.
- 제목·목록·인용·굵게·기울임·취소선·외부 링크는 X의 본문 형식으로 변환합니다. 코드와 표는 Markdown 블록, 블록 수식은 LaTeX 블록으로 보냅니다.
- 인라인 수식은 `$` 구분자를 제거한 LaTeX 텍스트로 문장 안에 유지하고, 블록 수식은 X 수식 블록으로 보냅니다. 중첩 목록은 평탄화됩니다. 내부 문서 링크는 일반 텍스트로, 이미지는 설명으로 바뀝니다. 이미지는 X에서 직접 업로드하세요. 이미지 URL을 내보내지 않아 마크벡터 이미지에 대한 외부 조회도 생기지 않습니다.
- 같은 창에서 완료된 초안 생성 요청을 다시 보내면 `DATA_DIR/x-articles.json`의 결과를 재사용합니다. 네트워크 오류로 X의 처리 결과를 확인하지 못하면 자동 재시도하지 않습니다. 먼저 X 아티클 목록을 확인한 뒤 재시도하세요. 창을 다시 열면 새 내보내기가 됩니다.
- X의 `429`는 요청 제한과 사용량 상한(`usage-capped`)을 구분합니다. 15분 창(`x-rate-limit-*`)과 함께 `x-user-limit-24hour-*`, `x-app-limit-24hour-*` 같은 `x-*-limit-*` 한도, `x-access-level`, `x-transaction-id`, 사용한 인증 방식(`oauth1` 또는 `oauth2`)을 화면과 서버 로그에 남깁니다. 리셋 시각은 UTC와 KST로 함께 보이며, 24시간 카운터의 남은 횟수가 0이면 그 초기화 시각을 안내합니다. 같은 헤더는 다른 오류 응답에도 남깁니다. 토큰·시크릿과 X 오류 본문 원문은 기록하지 않고, 제한이 풀렸는지 확인하는 재호출도 하지 않습니다.

API는 기존 앱 로그인으로 보호됩니다. `GET /api/x-articles/config`는 설정 여부만 반환합니다. `POST /api/x-articles/drafts`는 `{request_id, title, content_state}`를 받아 초안을 만듭니다. `request_id`는 클라이언트가 생성한 UUID이며, 응답은 `{article_id, url}`입니다. `url`은 X의 아티클 목록 주소입니다.

변환 회귀 테스트는 `python3 -m http.server 8765 --directory frontend`로 정적 서버를 실행하고 `http://127.0.0.1:8765/tests/x-article.html`에서 확인합니다. 백엔드 테스트는 `cd backend && uv run pytest tests/test_x_articles.py`이며 외부 X API를 호출하지 않습니다.

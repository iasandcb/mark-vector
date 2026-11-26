[목차](README.md) · [README](../README.md)

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
      providers/          # LLM 프로바이더 어댑터 (Anthropic/OpenAI/ChatGPT) + registry
      routers/            # /api/projects, /api/projects/{id}/conversations, /api/providers, /api/system-prompt, /api/custom-symbols
  frontend/
    index.html
    static/
      css/style.css
      js/
        app.js            # 3단 뷰(트리/에디터/미리보기) UI 로직
        api.js            # fetch 래퍼 + NDJSON 스트림 파서
        markdown.js        # asciimath-markdown@0.4.2 재export (KaTeX는 index.html, 수식 렌더·받아쓰기)
  data/
    system.md             # 공통 시스템 프롬프트 (런타임 생성, git에는 커밋되지 않음)
    custom-symbols.csv    # 공용 커스텀 심볼 (런타임 생성, 기본값은 빈 파일, git에는 커밋되지 않음)
    spoken-math.csv       # 공용 수식 말 (처음 읽을 때 backend/app/spoken_math_default.csv로 생성, git에는 커밋되지 않음)
    projects/             # 프로젝트별 폴더 (런타임 생성, git에는 커밋되지 않음). 각 프로젝트의 conversations/ 가 폴더
    video-jobs.json       # YouTube 작업 큐 (런타임 생성, git에는 커밋되지 않음)
```

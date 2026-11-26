[목차](README.md) · [README](../README.md)

## API 개요

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/providers` | 사용 가능한 LLM 프로바이더/모델 목록 |
| GET | `/api/projects` | 프로젝트 목록 (레거시 `data/conversations/`가 남아 있으면 이 호출에서 `기본 프로젝트`로 마이그레이션) |
| POST | `/api/projects` | 새 프로젝트 생성 `{title?}` |
| GET | `/api/projects/{id}` | 프로젝트 상세 조회 |
| PATCH | `/api/projects/{id}` | 프로젝트 이름 변경 `{title}` |
| DELETE | `/api/projects/{id}` | 프로젝트 삭제 (안의 모든 폴더·문서 함께 삭제) |
| GET | `/api/projects/{id}/system-prompt` | 프로젝트별 시스템 프롬프트 조회 `{content}` |
| PUT | `/api/projects/{id}/system-prompt` | 프로젝트별 시스템 프롬프트 저장 `{content}` |
| GET | `/api/projects/{id}/conversations` | 그 프로젝트의 대화 목록 |
| POST | `/api/projects/{id}/conversations` | 새 폴더 생성 `{title?, parent_id?}`. `parent_id`가 있으면 그 폴더 아래 하위 폴더 |
| GET | `/api/projects/{id}/conversations/{cid}` | 대화 상세(모든 공식 턴 포함) 조회 |
| PATCH | `/api/projects/{id}/conversations/{cid}` | 폴더 이름 변경 `{title}` |
| DELETE | `/api/projects/{id}/conversations/{cid}` | 대화 삭제 |
| GET | `/api/projects/{id}/conversations/{cid}/documents` | 세션 내 모든 문서(공식 턴 + 초안 + `system.md`) 목록/내용 조회, `system.md`가 항상 맨 앞 |
| POST | `/api/projects/{id}/conversations/{cid}/documents` | 빈 초안 문서 생성 |
| PUT | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 내용 덮어쓰기 (`system.md` 포함) |
| PATCH | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 이름 변경 `{new_filename}` (`system.md`는 400) |
| DELETE | `/api/projects/{id}/conversations/{cid}/documents/{filename}` | 문서 삭제 (초안·공식 턴 모두 가능, `system.md`만 400) |
| POST | `/api/projects/{id}/conversations/{cid}/messages` | 사용자 턴 전송 `{content, provider, model, reasoning_effort?, convert_math?, hybrid_math?, language?, context_scope?, draft_filename?, retry_turn_id?, target_document?, include_history?}` → LLM 응답을 NDJSON으로 스트리밍. `language`(`en`/`ko`/`ja`, 기본 `en`)는 이번에 새로 붙는 `## User`/`## Assistant` 헤딩의 언어를 고릅니다. `hybrid_math`(`convert_math`가 true일 때만 의미 있음)를 켜면 `$`/`$$` 수식만 변환하고 `\(`/`\[` 수식은 그대로 둡니다. `context_scope`는 `default`(이 문서만, 기본)/`sibling`(같은 폴더)/`descendants`(하위 폴더 포함)입니다. `draft_filename`이 있으면 그 초안 파일이 공식 턴이 되고, `retry_turn_id`가 있으면 그 턴을 이어서 완성합니다. `target_document`는 `{filename, content}`이고, `include_history`가 false면 이전 턴을 맥락에서 뺍니다(기본 true). |
| POST | `/api/projects/{id}/conversations/{cid}/transcribe` | 오디오 전사(화자 분리) multipart `file, title?, language?, audio_language?` → NDJSON `status`/`heartbeat`/`document`/`error` 이벤트, 결과는 새 초안 문서 |
| GET | `/api/transcribe/config` | 전사 사용 가능 여부 `{available, model}` |
| POST | `/api/convert-to-asciimath` | 문서 전체를 지금 바로 AsciiMath2로 변환 `{content, hybrid?}` → `{content}`. `hybrid`를 켜면 `$`/`$$` 수식만 변환합니다. |
| PUT | `/api/projects/{id}/conversations/{cid}/documents/{filename}/recordings/{recording_id}/video` | 그 녹음을 YouTube 큐에 넣거나 뺌 `{enqueue, duration_sec?}`. 로그인 세션. 자세한 계약은 [YouTube 영상 작업 큐](youtube-queue.md#youtube-영상-작업-큐) |
| POST | `…/recordings/upload` | 음성 파일 multipart `file`, 선택 `started`, `duration_sec`, `enqueue`. 그 문서의 녹음이 되고 기본으로 큐에 들어갑니다. 로그인 세션 |
| GET, POST | `/api/worker/jobs` … | 워커용 큐. `Authorization: Bearer $WORKER_TOKEN`. 목록·claim·오디오·progress·complete·fail·retry. [YouTube 영상 작업 큐](youtube-queue.md)의 JSON이 계약입니다. |
| GET | `/api/storage` | 데이터 디렉터리 디스크 `total_bytes` / `used_bytes` / `free_bytes` / `percent_used`, `threshold_percent`, `warning`. 로그인 세션 |
| GET | `/api/storage/recordings` | 녹음 목록(크기, 날짜, 프로젝트·폴더·문서, YouTube 업로드 완료 여부, `.play` 복사본 크기). 로그인 세션 |
| DELETE | `/api/storage/recordings` | 선택한 원본과 그 `.play` 복사본 삭제 `{recordings:[{project_id, conv_id, filename, recording_id}]}`. 로그인 세션 |
| POST | `/api/storage/cleanup/preview` | YouTube 업로드가 끝난 원본과 모든 `.play` 복사본, 비워질 바이트. 파일을 지우지 않음 |
| POST | `/api/storage/cleanup` | 미리보기의 파일을 삭제. 업로드가 끝나지 않은 원본과 문서는 유지 |
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

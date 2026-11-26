[목차](README.md) · [README](../README.md)

## YouTube 영상 작업 큐

녹음을 받아쓰는 영상으로 만들어 YouTube에 올리는 일은 [scripter](https://github.com/iasandcb/scripter)가 사용자 맥북에서 합니다. 맥은 오래 꺼져 있을 수 있으므로 **마크벡터가 맥을 호출하지 않습니다.** 맥의 워커가 이 큐를 주기적으로 끌어 갑니다(pull). 워커가 둘(나중 맥 한 대 더)이어도 같은 녹음을 둘이 집지 않도록, 가져가기는 원자적이고 리스(lease)가 있습니다.

큐는 별도 서비스나 데이터베이스 없이 `/data/video-jobs.json` 한 파일입니다(`published.json`과 같은 방식, 잠금은 `/data/video-jobs.lock`). 이 저장소의 Fly 배포는 `.github/workflows/fly-deploy.yml`이 하고, 포크에서 그 절차를 따르는 방법은 [배포](deploy.md)에 있습니다.

### 어떤 녹음이 큐에 들어가는가

**이미 디스크에 있는 녹음은 넣지 않습니다.** 이 기능 이후의 새 녹음만, 그리고 사용자가 직접 넣은 녹음만 대기합니다.

- 받아쓰기 녹음은 업로드가 끝난 뒤에 앱이 큐에 넣습니다. 녹음 도중 탭이 죽거나 업로드를 포기한 부분 파일은 들어가지 않습니다.
- 문서 ⋯ → 녹음(녹음이 하나도 없어도 열림)에서 **음성 파일 올리기**로 m4a, mp3, wav, webm, ogg, opus, aac, flac, mp4를 그 문서의 녹음으로 올립니다. 로그인 세션이고, 기본으로 큐에 넣습니다. `enqueue=false`면 ingest와 같이 넣지 않습니다.
- `POST /api/ingest/audio`는 파일이 통째로 있으므로 기본으로 큐에 넣습니다. 폼 필드 `enqueue`가 `false` / `0` / `no` / `off`이면 넣지 않습니다.
- 문서의 녹음 목록(트리에서 문서 ⋯ → 녹음)에서 **YouTube 대기열에 넣기** / **대기열에서 빼기** / **다시 시도**를 누를 수 있습니다. 같은 동작이 로그인 세션의 API입니다.

```
PUT /api/projects/{project_id}/conversations/{conv_id}/documents/{filename}/recordings/{recording_id}/video
Content-Type: application/json
Cookie: mv_session=...          # 앱 로그인. WORKER_TOKEN으로는 열 수 없습니다.

{"enqueue": true, "duration_sec": 95.2}     # duration_sec는 생략 가능
{"enqueue": false}                          # 대기·실패·취소만 뺄 수 있음
```

응답은 `{"video": null}` 또는 아래 사용자용 요약입니다. `GET` 같은 경로의 녹음 목록 각 항목에도 `video`가 붙습니다(없으면 `null`).

```json
{
  "job_id": "…",
  "status": "queued",
  "attempt": 0,
  "progress": null,
  "error": null,
  "youtube_video_id": null,
  "youtube_url": null,
  "transcript": null,
  "updated_at": "2026-10-21T01:00:00+00:00"
}
```

`enqueue: true`는 아직 없는 녹음에 작업을 만들고, `cancelled`/`failed`는 다시 `queued`로 되돌립니다. 이미 `queued`/`claimed`/`succeeded`이면 그대로 둡니다(대기 중일 때만 `duration_sec`를 고칩니다). `enqueue: false`는 대기·실패·취소를 `cancelled`로 바꿉니다. 작업이 없으면 `{"video": null}`입니다. 워커가 쥐고 있는 작업(`claimed`)은 409 `Job is in progress`, 이미 성공한 작업은 409 `Job already succeeded`입니다. 빈 파일은 400 `Recording is empty`입니다.

### 워커 인증

`Authorization: Bearer $WORKER_TOKEN`. `INGEST_TOKEN`과 **다른** 비밀입니다. 올리는 권한과 영상을 만들어 공개하는 권한을 나누기 위해서입니다.

Fly에 넣는 명령은 [배포](deploy.md)에 있습니다. 값은 `openssl rand -hex 32`로 만든 임의 문자열이면 됩니다. 로컬은 `backend/.env`의 `WORKER_TOKEN`입니다. 변수가 비어 있으면 `/api/worker/`는 통째로 **404**입니다(ingest와 같음). 토큰이 없거나 틀리면 **401** `{"detail":"Invalid token"}`입니다. 로그인 쿠키와는 무관하고, 로그인이 켜져 있어도 이 토큰만 있으면 워커 경로를 호출할 수 있습니다.

시각은 모두 UTC ISO 8601(`2026-10-21T01:00:00+00:00`)입니다. `created_at`만 예외로, 녹음 id에 박힌 시작 시각(녹음한 쪽의 벽시계)을 `INGEST_TIMEZONE`(기본 `Asia/Seoul`)으로 해석한 뒤 UTC로 저장한 값입니다.

### 상태와 리스

| status | 의미 |
|---|---|
| `queued` | 워커를 기다리는 중. 목록의 기본값(`waiting`)이 이것입니다. |
| `claimed` | 어떤 워커가 리스를 쥐고 처리 중. |
| `succeeded` | YouTube id/URL이 기록됨. 전사 텍스트가 있을 수 있습니다. |
| `failed` | 워커가 실패를 보고함. 다시 시도하기 전까지 대기열에 없습니다. |
| `cancelled` | 사용자가 뺐습니다. |

리스의 기본은 **3600초**, 허용 범위는 **30초~86400초**(24시간)입니다. 기한이 지난 `claimed`는 다음 읽기(목록, 단건, 가져가기, 진행, 완료, 실패, 오디오, 재시도, 녹음 목록)에서 `queued`로 돌아갑니다. 진행 보고(`progress`)는 리스를 그 시점부터 다시 셉니다(본문의 `lease_seconds`가 있으면 그 길이, 없으면 가져갈 때 정한 길이). 기한이 지난 뒤의 진행/완료/실패/다운로드는 **409** `{"detail":"Job is not held by this claim"}`이고, 그 작업은 다른 워커가 가져갈 수 있습니다. 죽어서 실패를 못 보낸 워커의 작업은 그래서 다시 대기열이 됩니다. `fail`은 "처리했는데 안 됐다"일 때만 쓰고, 그러면 `retry` 또는 사용자의 다시 넣기 전까지 대기하지 않습니다.

`attempt`는 가져간 횟수입니다. 만료로 돌아온 작업을 다시 가져가면 1 오릅니다.

가져가기는 항상 `created_at`이 가장 오래된 대기 작업 하나입니다. 파일이 없으면 그 작업을 `failed`(`error`: `Recording file is missing`)로 두고 다음 것으로 넘어가서, 하나 때문에 큐가 막히지 않습니다.

### `GET /api/worker/jobs`

대기 중인 녹음 목록.

쿼리: `order`=`oldest`(기본)|`newest` (`created_at` 기준), `status`=`waiting`(기본)|`queued`|`claimed`|`succeeded`|`failed`|`cancelled`|`all`, `limit`=1~500.

```json
{
  "jobs": [
    {
      "id": "job id (32 hex)",
      "status": "queued",
      "title": "talk",
      "filename": "talk.md",
      "recording_id": "20261018-193012-ab12.m4a",
      "project_id": "…",
      "project_title": "youtube",
      "conv_id": "…",
      "folder_title": "2026-10-20",
      "mime": "audio/mp4",
      "duration_sec": 95.2,
      "created_at": "2026-10-18T10:30:12+00:00",
      "enqueued_at": "2026-10-21T01:00:00+00:00",
      "updated_at": "2026-10-21T01:00:00+00:00",
      "attempt": 0,
      "worker_id": null,
      "lease_expires_at": null,
      "progress": null,
      "error": null,
      "result": null,
      "audio_url": "/api/worker/jobs/<id>/audio"
    }
  ]
}
```

`duration_sec`는 모를 때 `null`입니다. `mime`는 원본 컨테이너(`audio/webm`, `audio/mp4`, `audio/ogg`)입니다. `title`은 문서 파일명에서 `.md`를 뺀 것입니다. 이 응답에는 `claim_token`이 없습니다. `progress`는 `{"message": string|null, "percent": 0~100|null}`이고, 둘 다 없으면 `null`입니다.

### `POST /api/worker/jobs/claim`

가장 오래된 대기 작업 하나를 원자적으로 집습니다. 빈 큐는 작업이 `null`입니다. 둘 이상의 워커가 동시에 호출해도 서로 다른 작업을 받거나 `null`을 받습니다.

```json
{"worker_id": "macbook-pro", "lease_seconds": 3600}
```

`worker_id`는 1~64자(제어 문자 없음)이고 필수입니다. `lease_seconds`를 생략하면 3600입니다.

응답의 `job`은 목록의 작업 객체와 같고, `status`는 `claimed`이며 **여기만** `claim_token`이 더 있습니다.

```json
{
  "job": {
    "id": "…",
    "status": "claimed",
    "claim_token": "url-safe token",
    "worker_id": "macbook-pro",
    "attempt": 1,
    "lease_expires_at": "2026-10-21T02:00:00+00:00",
    "audio_url": "/api/worker/jobs/<id>/audio"
  }
}
```

(위의 필드는 일부입니다. 목록과 같은 나머지 필드가 모두 함께 옵니다.)

빈 큐:

```json
{"job": null}
```

`claim_token`은 **이 응답에만** 있습니다. 잃어버리면 리스가 끝날 때까지 그 작업을 완료하거나 실패로 보고할 수 없습니다.

### `GET /api/worker/jobs/{id}`

작업 하나. 모양은 목록의 원소와 같고 `claim_token`은 없습니다. 없으면 404 `{"detail":"Job not found"}`.

### `GET /api/worker/jobs/{id}/audio`

리스를 쥔 워커에게만 원본 녹음 바이트를 줍니다. 헤더 `X-Claim-Token: <claim_token>`. `Content-Type`은 `mime`, 파일명은 `{title}-{recording_id}`입니다. 토큰이 없거나 틀리거나 리스가 끝났으면 409 `Job is not held by this claim`. 성공 뒤나 실패 뒤에는 더 이상 claimed가 아니므로 같은 409입니다. 워커는 가져간 직후, 처리가 끝나기 전에 받으면 됩니다.

### `POST /api/worker/jobs/{id}/progress`

처리 중 상태. 리스를 갱신합니다. `message`(최대 500자)와 `percent`(0~100 정수) 중 적어도 하나. `lease_seconds`는 생략 가능.

```json
{"claim_token": "…", "message": "transcribing", "percent": 40}
```

응답은 갱신된 작업 객체(`claim_token` 없음)입니다. 리스를 안 쥐고 있으면 409.

### `POST /api/worker/jobs/{id}/complete`

성공. 리스가 살아 있고 토큰이 맞을 때만.

```json
{
  "claim_token": "…",
  "youtube_video_id": "abcdefghijk",
  "youtube_url": "https://youtu.be/abcdefghijk",
  "transcript": "고친 전사 전문. 생략 가능"
}
```

`youtube_video_id`는 영문·숫자·`_`·`-` 6~64자이고 필수입니다. `youtube_url`을 생략하면 `https://www.youtube.com/watch?v={id}`를 저장합니다. 주면 `http`/`https` URL이어야 합니다. `transcript`는 생략 가능하고, 빈 문자열이면 `null`로 저장합니다(최대 2,000,000자). 전사 본문은 문서 파일을 덮어쓰지 않고 작업에만 남으며, 녹음 목록에서 접어 보여 줍니다.

응답 작업의 `status`는 `succeeded`이고 `result`는 다음과 같습니다.

```json
{"youtube_video_id": "abcdefghijk", "youtube_url": "https://youtu.be/abcdefghijk", "transcript": "…"}
```

그 전에는 `result`가 `null`입니다.

### `POST /api/worker/jobs/{id}/fail`

```json
{"claim_token": "…", "error": "scripter crashed"}
```

`error`는 1~4000자. 응답의 `status`는 `failed`이고 `error`에 그 문자열이 있습니다. 대기 목록에서는 빠집니다.

### `POST /api/worker/jobs/{id}/retry`

본문 없음. `failed`만 `queued`로 되돌립니다. 그 외 상태는 409 `Only a failed job can be retried`. 파일이 없으면 409 `Recording file is missing`. 사용자의 다시 시도(`PUT .../video` `{"enqueue": true}`)도 실패·취소된 작업을 같은 대기 상태로 되돌립니다.

문서·폴더·프로젝트를 지우거나 녹음을 지우면 그 작업도 지워집니다. 문서를 바꾸거나 다른 폴더로 옮기면 작업의 `filename` / `conv_id` / `project_id`가 따라가서, 이미 발급한 `audio_url`로 계속 받을 수 있습니다.

### 워커가 돌리는 순서

1. `GET /api/worker/jobs` (기본: 오래된 순의 대기 작업). 비어 있으면 수십 초 뒤에 다시 봅니다. 맥이 잠들어 있는 동안은 큐가 쌓여 있습니다.
2. `POST /api/worker/jobs/claim`. `job`이 `null`이면 1로.
3. `GET job.audio_url`에 `X-Claim-Token`.
4. 처리하면서 `POST .../progress` (긴 영상이면 리스가 끊기지 않게).
5. 성공이면 `POST .../complete`, 실패면 `POST .../fail`. 다시 할 실패는 `POST .../retry`.

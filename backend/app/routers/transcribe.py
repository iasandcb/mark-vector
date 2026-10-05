import asyncio
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from .. import storage, transcription

router = APIRouter(tags=["transcribe"])

# Fly's proxy drops a connection that's silent for too long, and a long
# recording can take minutes to come back from the API - so the response
# is NDJSON with a heartbeat while waiting, same wire format as /messages.
HEARTBEAT_SECONDS = 10


@router.get("/api/transcribe/config")
def transcribe_config():
    return {"available": transcription.available(), "model": transcription.MODEL}


@router.post("/api/projects/{project_id}/conversations/{conv_id}/transcribe")
async def transcribe(
    project_id: str,
    conv_id: str,
    file: UploadFile = File(...),
    title: str = Form(""),
    language: str = Form("en"),
    audio_language: str = Form(""),
):
    """`language` is the UI language (the document's own labels);
    `audio_language` is an optional ISO-639-1 hint for what's spoken -
    without it the model can drift into another language mid-recording."""
    if not transcription.available():
        raise HTTPException(status_code=400, detail="OPENAI_API_KEY is not configured")
    try:
        storage.list_documents(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Copied out of the request up front: the upload's own spooled file
    # isn't guaranteed to outlive this handler, and the work below runs
    # inside the streamed response after it returns.
    filename = Path(file.filename or "recording.webm").name
    workdir = transcription.spool_dir()
    src = workdir / filename
    with src.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)
    if src.stat().st_size == 0:
        shutil.rmtree(workdir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Empty audio file")

    async def event_stream():
        try:
            upload = src
            if src.stat().st_size > transcription.MAX_UPLOAD_BYTES:
                yield json.dumps({"type": "status", "stage": "compressing"}) + "\n"
                upload = await transcription.compress(src)

            yield json.dumps({"type": "status", "stage": "transcribing"}) + "\n"
            task = asyncio.create_task(transcription.transcribe(upload, upload.name, audio_language or None))
            while True:
                done, _ = await asyncio.wait({task}, timeout=HEARTBEAT_SECONDS)
                if done:
                    break
                yield json.dumps({"type": "heartbeat"}) + "\n"
            segments = task.result()
            if not segments:
                raise RuntimeError("음성이 인식되지 않았습니다")

            doc_title = title.strip() or Path(filename).stem
            content = transcription.to_markdown(segments, doc_title, language)
            draft = storage.create_draft(project_id, conv_id)
            saved = storage.save_document(project_id, conv_id, draft["filename"], content)
            yield json.dumps({"type": "document", "document": {**draft, **saved}}) + "\n"
        except Exception as exc:  # surface API/ffmpeg errors to the client
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import analysis, storage
from ..models import AnalysisRequest
from ..providers.registry import get_provider

router = APIRouter(prefix="/api/projects/{project_id}/conversations", tags=["analysis"])


def _check_kind(kind: str) -> None:
    if kind not in storage.ANALYSIS_KINDS:
        raise HTTPException(status_code=404, detail=f"Unknown analysis: {kind}")


@router.get("/{conv_id}/documents/{filename}/analysis/{kind}")
def get_analysis(project_id: str, conv_id: str, filename: str, kind: str):
    """The last saved result of this kind for the document, or null."""
    _check_kind(kind)
    try:
        return storage.get_analysis(project_id, conv_id, filename, kind)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.post("/{conv_id}/documents/{filename}/analysis/{kind}")
async def run_analysis(project_id: str, conv_id: str, filename: str, kind: str, req: AnalysisRequest):
    """Evaluates (under one of the lenses) or formalizes `req.content` - the editor's text, saved or
    not - and saves the result beside the document. NDJSON like
    send_message's stream: "delta" events while the reply comes in, then
    {"type": "done", "result": ...} with the saved record (or "error")."""
    _check_kind(kind)
    try:
        storage.get_analysis(project_id, conv_id, filename, kind)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")
    try:
        provider = get_provider(req.provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Deliberately not the folder's system-prompt chain: that sets up a
    # conversation partner, and a review should read the same whoever's
    # folder the document sits in.
    system_prompt = analysis.system_prompt(kind, req.language, req.math_dialect)
    messages = [{"role": "user", "content": analysis.user_message(kind, filename, req.content)}]

    async def event_stream():
        chunks: list[str] = []
        try:
            async for event in provider.stream(messages, req.model, req.reasoning_effort, system_prompt):
                if event["type"] == "text":
                    chunks.append(event["text"])
                    yield json.dumps({"type": "delta", "text": event["text"]}) + "\n"
                elif event["type"] == "tool_status":
                    yield json.dumps(event) + "\n"
        except Exception as exc:  # surface provider/network errors to the client
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
            return
        text = "".join(chunks)
        parsed = analysis.parse_evaluation(text) if kind in analysis.EVALUATE_KINDS else analysis.parse_formalization(text)
        result = {
            **parsed,
            "content_sha256": analysis.content_hash(req.content),
            "provider": req.provider,
            "model": req.model,
            "reasoning_effort": req.reasoning_effort,
        }
        try:
            record = storage.save_analysis(project_id, conv_id, filename, kind, result)
        except FileNotFoundError:
            # The document went away mid-run (deleted or renamed in another
            # tab) - still hand back what came in, just unsaved.
            record = {**result, "kind": kind, "created_at": None}
        yield json.dumps({"type": "done", "result": record}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")

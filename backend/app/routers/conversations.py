import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import storage
from ..custom_symbols import build_config
from ..latex_to_asciimath import HYBRID_MATH_DIRECTIVE, MATH_DIRECTIVE, convert_math_to_asciimath
from ..models import (
    CopyDocumentRequest,
    CreateConversationRequest,
    CreateMessageRequest,
    InlineCompleteRequest,
    MoveConversationRequest,
    MoveDocumentRequest,
    PublishOptionsRequest,
    RenameConversationRequest,
    RenameDocumentRequest,
    SaveDocumentRequest,
)
from ..providers.registry import get_provider

router = APIRouter(prefix="/api/projects/{project_id}/conversations", tags=["conversations"])


@router.get("")
def list_conversations(project_id: str):
    try:
        return storage.list_conversations(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.post("")
def create_conversation(project_id: str, req: CreateConversationRequest):
    try:
        return storage.create_conversation(project_id, req.title or "Untitled", parent_id=req.parent_id)
    except FileNotFoundError:
        # Either the project itself, or (if parent_id was given) the folder
        # it's meant to nest under - storage.create_conversation raises the
        # same exception type for both, and neither is worth telling apart
        # here (a stale parent_id is exactly as unexpected as a stale
        # project_id would be).
        raise HTTPException(status_code=404, detail="Project or parent folder not found")


@router.get("/{conv_id}")
def get_conversation(project_id: str, conv_id: str):
    try:
        return storage.get_conversation(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.patch("/{conv_id}")
def rename_conversation(project_id: str, conv_id: str, req: RenameConversationRequest):
    try:
        return storage.rename_conversation(project_id, conv_id, req.title)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.delete("/{conv_id}")
def delete_conversation(project_id: str, conv_id: str):
    try:
        storage.delete_conversation(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


@router.post("/{conv_id}/move")
def move_conversation(project_id: str, conv_id: str, req: MoveConversationRequest):
    try:
        return storage.move_conversation(project_id, conv_id, req.parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Folder not found")


@router.get("/{conv_id}/documents")
def list_documents(project_id: str, conv_id: str):
    try:
        return storage.list_documents(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.post("/{conv_id}/documents")
def create_draft(project_id: str, conv_id: str):
    try:
        return storage.create_draft(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.put("/{conv_id}/documents/{filename}")
def save_document(project_id: str, conv_id: str, filename: str, req: SaveDocumentRequest):
    try:
        return storage.save_document(project_id, conv_id, filename, req.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.patch("/{conv_id}/documents/{filename}")
def rename_document(project_id: str, conv_id: str, filename: str, req: RenameDocumentRequest):
    try:
        return storage.rename_document(project_id, conv_id, filename, req.new_filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.post("/{conv_id}/documents/{filename}/move")
def move_document(project_id: str, conv_id: str, filename: str, req: MoveDocumentRequest):
    try:
        return storage.move_document(project_id, conv_id, filename, req.target_conv_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.post("/{conv_id}/documents/{filename}/copy")
def copy_document(project_id: str, conv_id: str, filename: str, req: CopyDocumentRequest):
    try:
        return storage.copy_document(project_id, conv_id, filename, req.target_conv_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.delete("/{conv_id}/documents/{filename}")
def delete_document(project_id: str, conv_id: str, filename: str):
    try:
        storage.delete_document(project_id, conv_id, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"ok": True}


@router.post("/{conv_id}/documents/{filename}/revert-to-draft")
def revert_to_draft(project_id: str, conv_id: str, filename: str):
    try:
        return storage.revert_turn_to_draft(project_id, conv_id, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.post("/{conv_id}/documents/{filename}/publish")
def publish_document(project_id: str, conv_id: str, filename: str):
    try:
        return storage.publish_document(project_id, conv_id, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.patch("/{conv_id}/documents/{filename}/publish")
def update_publish_options(project_id: str, conv_id: str, filename: str, req: PublishOptionsRequest):
    try:
        return storage.set_publish_slides(project_id, conv_id, filename, req.slides)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not published")


@router.delete("/{conv_id}/documents/{filename}/publish")
def unpublish_document(project_id: str, conv_id: str, filename: str):
    storage.unpublish_document(project_id, conv_id, filename)
    return {"ok": True}


@router.post("/{conv_id}/messages")
async def send_message(project_id: str, conv_id: str, req: CreateMessageRequest):
    try:
        meta = storage.get_conversation(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")

    try:
        provider = get_provider(req.provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # One file per exchange: this creates it with just the user's half, then
    # complete_exchange() below rewrites the same file once the reply is in.
    # Provider/model/reasoning/convert_math are chosen per turn (this
    # request), not looked up from session-level meta - see storage.py's
    # start_exchange docstring. If this send started from an open draft or
    # is retrying/continuing a turn whose last question has no reply yet,
    # that same file is reused instead of spawning a new one.
    try:
        if req.retry_turn_id:
            turn = storage.retry_exchange(
                project_id,
                conv_id,
                req.retry_turn_id,
                req.content,
                language=req.language,
                provider=req.provider,
                model=req.model,
                reasoning_effort=req.reasoning_effort,
                convert_math=req.convert_math,
                context_scope=req.context_scope,
            )
        else:
            turn = storage.start_exchange(
                project_id,
                conv_id,
                req.content,
                language=req.language,
                provider=req.provider,
                model=req.model,
                reasoning_effort=req.reasoning_effort,
                convert_math=req.convert_math,
                context_scope=req.context_scope,
                draft_filename=req.draft_filename,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Document not found: {exc}")

    # Built fresh *after* retry_exchange/start_exchange above (rather than
    # from the `meta` already fetched at the top of this function, which was
    # only ever for the 404 check) - what the LLM sees as history has to
    # match what's actually on disk now (and so what the frontend's editor
    # was showing - see app.js's detectPendingQuestion), not whatever this
    # turn's file happened to hold a moment ago: a continuation that cleanly
    # appended past the saved content leaves earlier rounds untouched either
    # way, but one that replaced this turn's content outright (the buffer no
    # longer showing the old rounds at all) must not still feed them to the
    # LLM as if nothing had changed. `req.context_scope` decides how far
    # build_history_for_turn reaches - see CONTEXT_SCOPES.
    history = (
        storage.build_history_for_turn(
            project_id, conv_id, turn["id"], scope=req.context_scope, exclude_pending_tail_of=turn["id"]
        )
        if req.include_history
        else []
    )
    # `turn["question"]` (not `req.content` directly) - for a retried/
    # continued turn, `req.content` is the editor's *entire* buffer, which
    # can already hold earlier complete rounds; storage.retry_exchange
    # already extracted just the new trailing question.
    # `exclude_pending_tail_of` above drops that same (now-pending, freshly
    # written) question from history's own snapshot of this turn without
    # dropping any earlier complete rounds still actually in that file, so
    # together this appends it exactly once. `turn["id"]`, not
    # `req.retry_turn_id` - that's still None for a brand-new turn
    # (start_exchange), but this turn now exists either way (it was just
    # created, above), so its own pending question needs excluding here
    # exactly the same way.
    history.append({"role": "user", "content": turn["question"]})

    # System prompt cascade: global (app-wide) -> project (shared by every
    # folder in it) -> every ancestor folder, root first -> this folder's
    # own (see storage.get_system_prompt_chain - folder nesting is purely
    # organizational, but a system prompt still makes sense to inherit down
    # the chain the same way a project's already does).
    global_prompt = storage.get_global_system_prompt().strip()
    project_prompt = storage.get_project_system_prompt(project_id).strip()
    folder_chain = storage.get_system_prompt_chain(project_id, conv_id)
    system_prompt = "\n\n".join(p for p in (global_prompt, project_prompt, *folder_chain) if p) or None

    async def event_stream():
        yield json.dumps({"type": "user_turn", "turn": turn}) + "\n"
        chunks: list[str] = []
        try:
            async for event in provider.stream(history, req.model, req.reasoning_effort, system_prompt):
                if event["type"] == "text":
                    chunks.append(event["text"])
                    yield json.dumps({"type": "delta", "text": event["text"]}) + "\n"
                elif event["type"] == "tool_status":
                    yield json.dumps(event) + "\n"
        except Exception as exc:  # surface provider/network errors to the client
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
            return
        full_text = "".join(chunks)
        directive = None
        if req.convert_math:
            config = build_config(storage.get_global_custom_symbols())
            full_text, needs_directive = await asyncio.to_thread(
                convert_math_to_asciimath, full_text, config, req.hybrid_math
            )
            if needs_directive:
                directive = HYBRID_MATH_DIRECTIVE if req.hybrid_math else MATH_DIRECTIVE
        updated_turn = storage.complete_exchange(
            project_id, conv_id, turn["id"], full_text, directive=directive, language=req.language
        )
        yield json.dumps({"type": "assistant_turn", "turn": updated_turn}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


# Generous, but a bound: a very long document keeps its part nearest the
# question, which is the part a question asked mid-document is about.
INLINE_CONTEXT_MAX_CHARS = 100_000


def _inline_document_context(context: str) -> str:
    """The document an inline question is asked from, as a system-prompt
    section - so every provider gets it the same way (instructions/system),
    and it sits apart from the thread's own user/assistant turns."""
    context = context.strip()
    if not context:
        return ""
    if len(context) > INLINE_CONTEXT_MAX_CHARS:
        context = "…" + context[-INLINE_CONTEXT_MAX_CHARS:]
    return (
        "The user is asking this from inside a document they are writing. "
        "Here is the document text that comes before the question - answer "
        "with it in mind, and treat references like \"this\" or \"above\" "
        "as pointing into it:\n\n"
        f"<document>\n{context}\n</document>"
    )


@router.post("/{conv_id}/inline-complete")
async def inline_complete(project_id: str, conv_id: str, req: InlineCompleteRequest):
    """app.js's inline-thread mode (a scratch conversation living inside a
    draft document, between its <!-- inline --> markers) - a lighter sibling
    of send_message above: no turn is started and nothing is ever written to
    storage here. History *is* built, but from what the client parsed out of
    the document rather than from any stored turn (see InlineCompleteRequest).
    Same NDJSON event shape (delta/tool_status/error) as send_message's own
    stream, but ends in {"type": "done", "text": ...} instead of
    "assistant_turn" - there's no turn to attach the finished reply to, so
    the client gets the final (post-math-conversion, if requested) text
    directly and splices it into the editor itself."""
    try:
        provider = get_provider(req.provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Same cascade send_message uses (see its own comment above) - an
    # inline completion should still stay in character with the rest of
    # this folder, even though it's never recorded as one of its turns.
    global_prompt = storage.get_global_system_prompt().strip()
    project_prompt = storage.get_project_system_prompt(project_id).strip()
    folder_chain = storage.get_system_prompt_chain(project_id, conv_id)
    system_prompt = "\n\n".join(
        p for p in (global_prompt, project_prompt, *folder_chain, _inline_document_context(req.context)) if p
    ) or None

    async def event_stream():
        chunks: list[str] = []
        try:
            messages = [*(m.model_dump() for m in req.history), {"role": "user", "content": req.content}]
            async for event in provider.stream(messages, req.model, req.reasoning_effort, system_prompt):
                if event["type"] == "text":
                    chunks.append(event["text"])
                    yield json.dumps({"type": "delta", "text": event["text"]}) + "\n"
                elif event["type"] == "tool_status":
                    yield json.dumps(event) + "\n"
        except Exception as exc:  # surface provider/network errors to the client
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
            return
        full_text = "".join(chunks)
        if req.convert_math:
            config = build_config(storage.get_global_custom_symbols())
            full_text, _ = await asyncio.to_thread(convert_math_to_asciimath, full_text, config, req.hybrid_math)
        yield json.dumps({"type": "done", "text": full_text}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")

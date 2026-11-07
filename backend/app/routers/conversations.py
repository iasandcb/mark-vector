import asyncio
import json
from datetime import date

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import storage
from ..custom_symbols import build_config
from ..latex_to_asciimath import HYBRID_MATH_DIRECTIVE, MATH_DIRECTIVE, convert_math_to_asciimath
from ..models import (
    CopyDocumentRequest,
    CreateConversationRequest,
    CreateMessageRequest,
    DiscussRequest,
    InlineCompleteRequest,
    MoveConversationRequest,
    MoveDocumentRequest,
    PublishOptionsRequest,
    RenameConversationRequest,
    RenameDocumentRequest,
    SaveDocumentRequest,
    SaveDraftSettingsRequest,
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


@router.get("/suggest-title")
def suggest_conversation_title(
    project_id: str, parent_id: str | None = None, today: str | None = None
):
    # Match draft naming: use the browser's calendar day when supplied.
    try:
        day = date.fromisoformat(today) if today else None
    except ValueError:
        day = None
    try:
        return {"title": storage.suggest_conversation_title(project_id, parent_id, today=day)}
    except FileNotFoundError:
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


@router.post("/{conv_id}/promote")
def promote_conversation(project_id: str, conv_id: str):
    try:
        return storage.promote_conversation(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


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
def create_draft(project_id: str, conv_id: str, today: str | None = None):
    # `today` is the browser's own calendar day (YYYY-MM-DD) - what a new
    # entry in a date-named folder is called (see
    # storage._next_draft_filename). This server runs in UTC, where it can
    # still be yesterday or already tomorrow for the person writing.
    try:
        day = date.fromisoformat(today) if today else None
    except ValueError:
        day = None
    try:
        return storage.create_draft(project_id, conv_id, today=day)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.post("/{conv_id}/documents/{filename}/conversation-file")
def create_conversation_file(project_id: str, conv_id: str, filename: str):
    try:
        return storage.create_conversation_file(project_id, conv_id, filename)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Conversation file already exists")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.get("/{conv_id}/documents/{filename}")
def poll_document(project_id: str, conv_id: str, filename: str, since: str | None = None):
    """Polled by an open editor to pick up saves made in another browser -
    see storage.poll_document."""
    try:
        return storage.poll_document(project_id, conv_id, filename, since)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.put("/{conv_id}/documents/{filename}/settings")
def save_draft_settings(project_id: str, conv_id: str, filename: str, req: SaveDraftSettingsRequest):
    """The toolbar choice for this draft. Ignored for a document that is
    already a turn - that choice is whatever the last send recorded."""
    try:
        return storage.set_draft_settings(
            project_id,
            conv_id,
            filename,
            provider=req.provider,
            model=req.model,
            reasoning_effort=req.reasoning_effort,
            context_scope=req.context_scope,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Document not found: {exc}")


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
        return storage.move_document(project_id, conv_id, filename, req.target_conv_id, req.target_project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document not found")


@router.post("/{conv_id}/documents/{filename}/copy")
def copy_document(project_id: str, conv_id: str, filename: str, req: CopyDocumentRequest):
    try:
        return storage.copy_document(project_id, conv_id, filename, req.target_conv_id, req.target_project_id)
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


# Bounds what one request carries; a document past it keeps its beginning
# (and says so), since edits are matched against the text the model saw.
TARGET_DOCUMENT_MAX_CHARS = 200_000


def _target_document_prompt(filename: str, content: str) -> str:
    """The document open beside the conversation, plus the edit-block
    protocol the frontend understands (app.js's parseEditBlocks). Plain text
    rather than tool calling, so every provider - Anthropic, OpenAI, the
    ChatGPT plan, an OpenAI-compatible gateway - works the same way."""
    truncated = len(content) > TARGET_DOCUMENT_MAX_CHARS
    shown = content[:TARGET_DOCUMENT_MAX_CHARS]
    note = "\n(The document continues past this point; only the part shown can be edited.)" if truncated else ""
    state = "It is empty." if not content.strip() else "Its current text is between the <document> tags below."
    return (
        f'The user has a document open beside this conversation: "{filename}". {state}\n\n'
        "You can write to this document and edit it. When the user asks for that, answer briefly as "
        "usual and put the changes in edit blocks - the app applies them to the document, so do not "
        "repeat the new text outside the blocks, and do not ask the user to paste anything. When the "
        "user only asks a question about the document, answer it without any edit block.\n\n"
        "An edit block is a code block fenced with FOUR backticks and the language `edit`:\n\n"
        "````edit\n"
        "<<<<<<< SEARCH\n"
        "text to find, copied exactly from the document\n"
        "=======\n"
        "text to put in its place\n"
        ">>>>>>> REPLACE\n"
        "````\n\n"
        "- SEARCH must match the document character for character and appear in it only once; "
        "include a neighboring line if needed to make it unique. Keep it short - a few lines.\n"
        "- To add text at the end of the document, leave SEARCH empty.\n"
        "- To insert text somewhere else, SEARCH for the line it goes after and repeat that line in the replacement.\n"
        "- To delete text, leave the replacement empty.\n"
        "- Use one block per place changed, in document order.\n"
        "- To replace the whole document, use one block fenced with four backticks and the language "
        "`rewrite` holding the complete new text, with no SEARCH/REPLACE markers.\n"
        "- Write in the document's own language, style and math notation.\n\n"
        "The text below is the document as it is right now. Trust it over anything earlier in this "
        "conversation: an edit you made before may have been undone or changed by the user since.\n\n"
        f"<document>\n{shown}\n</document>{note}"
    )


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
    # that same file is reused instead of spawning a new one. A `.c.md`
    # conversation file is that file even when the client did not also
    # pass a draft or turn id: the send must not allocate `0001.md`.
    content = req.content
    retry_turn_id = req.retry_turn_id
    draft_filename = req.draft_filename
    try:
        if req.conversation_filename:
            retry_turn_id, draft_filename, content = storage.bind_conversation_send(
                project_id,
                conv_id,
                req.conversation_filename,
                content,
                language=req.language,
                retry_turn_id=retry_turn_id,
            )
        if retry_turn_id:
            turn = storage.retry_exchange(
                project_id,
                conv_id,
                retry_turn_id,
                content,
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
                content,
                language=req.language,
                provider=req.provider,
                model=req.model,
                reasoning_effort=req.reasoning_effort,
                convert_math=req.convert_math,
                context_scope=req.context_scope,
                draft_filename=draft_filename,
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
    target_prompt = (
        _target_document_prompt(req.target_document.filename, req.target_document.content)
        if req.target_document
        else ""
    )
    system_prompt = "\n\n".join(p for p in (global_prompt, project_prompt, *folder_chain, target_prompt) if p) or None

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


_DISCUSSION_LANGUAGE = {"ko": "Korean", "en": "English", "ja": "Japanese"}


def _discussion_preamble(language: str) -> str:
    name = _DISCUSSION_LANGUAGE.get(language, "Korean")
    return (
        "You are a thoughtful discussion partner about the document open beside this conversation. "
        f"The app language is {name}. Reply in that language unless the user writes or speaks another one; then follow the user. "
        "Keep each reply short — a few sentences — because the user reads it while talking. "
        "Edit the document only when the user clearly asks you to change, add, or delete something. "
        "A question, a disagreement, or a request to explain is not an edit. "
        "When you do edit, use the edit blocks below and then confirm in one short sentence what changed."
    )


def _discussion_summary(summary: str) -> str:
    summary = (summary or "").strip()
    if not summary:
        return ""
    return "Earlier in this voice discussion, condensed so the recent turns can stay in full:\n" + summary


@router.post("/{conv_id}/discuss")
async def discuss_document(project_id: str, conv_id: str, req: DiscussRequest):
    """The voice-discussion pane: Soniox turns into text, and the model the
    toolbar already selected answers. Reuses the edit-block prompt from
    send_message. Unlike that route, no exchange file is written — the pane
    holds the transcript, and the browser saves the document itself."""
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="A spoken turn is required")
    try:
        storage.get_conversation(project_id, conv_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Conversation not found")
    try:
        provider = get_provider(req.provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    global_prompt = storage.get_global_system_prompt().strip()
    project_prompt = storage.get_project_system_prompt(project_id).strip()
    folder_chain = storage.get_system_prompt_chain(project_id, conv_id)
    system_prompt = "\n\n".join(
        p
        for p in (
            _discussion_preamble(req.language),
            _discussion_summary(req.summary),
            global_prompt,
            project_prompt,
            *folder_chain,
            _target_document_prompt(req.target_document.filename, req.target_document.content),
        )
        if p
    )

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
        except Exception as exc:
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
            return
        # No math conversion: an edit block has to match the document
        # character for character, and this reply is shown as text.
        yield json.dumps({"type": "done", "text": "".join(chunks)}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")

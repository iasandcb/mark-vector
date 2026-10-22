from typing import Literal

from pydantic import BaseModel


class PasscodeLoginRequest(BaseModel):
    code: str


class CreateProjectRequest(BaseModel):
    title: str | None = None


class RenameProjectRequest(BaseModel):
    title: str


class CreateConversationRequest(BaseModel):
    title: str | None = None
    # See storage.create_conversation's parent_id docstring - nests this
    # folder under another one in the same project instead of leaving it at
    # the top level.
    parent_id: str | None = None


class TargetDocument(BaseModel):
    """The document open beside the conversation (split view's other pane)
    that this message may write to or edit - sent as the editor currently
    shows it, unsaved changes included. See
    routers/conversations.py's _target_document_prompt."""

    filename: str
    content: str


class CreateMessageRequest(BaseModel):
    content: str
    provider: str
    model: str
    reasoning_effort: str | None = None
    convert_math: bool = False
    # Only meaningful when convert_math is True: converts $...$/$$...$$
    # spans only, leaving \(...\)/\[...\] spans as literal LaTeX, never even
    # attempted - the "Hybrid" format radio's deliberate LaTeX+AsciiMath2
    # mix, as opposed to convert_math's normal best-effort "convert
    # everything, fall back to LaTeX only on failure". See
    # latex_to_asciimath.convert_math_to_asciimath's `hybrid` param.
    hybrid_math: bool = False
    # The UI's language when this was sent (see i18n.js) - decides which
    # language's "## User"/"## Assistant"-equivalent heading pair
    # storage.py's start_exchange/retry_exchange/complete_exchange attach to
    # the new content. Purely a labeling choice for text already fully
    # composed by the client/provider; unrelated to what language the LLM
    # itself replies in.
    language: str = "en"
    # When False, this turn's LLM call omits every earlier turn in the
    # session - just this message and the system prompt(s). The turn is
    # still recorded in the session normally, so a *later* send with this
    # left at the default True includes it like any other prior turn; only
    # the request that set this False itself goes out context-free.
    include_history: bool = True
    # Set when the conversation is editing the document beside it: the
    # model gets that document and may answer with edit blocks, which the
    # frontend applies to it (see app.js's "document editing" section).
    target_document: TargetDocument | None = None
    # Which other turns count as "history" when include_history is True -
    # see storage.build_history_for_turn/CONTEXT_SCOPES. "default": only
    # this turn's own content. "sibling": every turn in this same folder
    # (the app's original, only behavior before folders could nest).
    # "descendants": every turn in this folder and every folder nested
    # under it.
    context_scope: Literal["default", "sibling", "descendants"] = "default"
    # When sending from an open draft document, its filename - so the
    # exchange is written into that same file instead of a brand new one.
    # See storage.start_exchange's draft_filename docstring.
    draft_filename: str | None = None
    # When retrying a turn that started but never got its reply, that turn's
    # id - so the reply lands in that same turn/file instead of a new one.
    # See storage.retry_exchange. Mutually exclusive with draft_filename.
    retry_turn_id: str | None = None


class InlineMessage(BaseModel):
    """One earlier turn of an inline thread (see InlineCompleteRequest's
    `history`). Roles are constrained here rather than trusted, since these
    come straight out of a document's own text - whatever the client parsed
    out of it goes to a provider verbatim otherwise."""

    role: Literal["user", "assistant"]
    content: str


class LiveCheckRequest(BaseModel):
    """One step of Evaluate's live mode (routers/analysis.py): the passage
    `content[start:end]` - what changed since the last step - is checked,
    with the text before it as context."""

    content: str
    start: int
    end: int
    provider: str
    model: str
    reasoning_effort: str | None = None
    language: str = "en"
    math_dialect: str = "latex"


class AnalysisRequest(BaseModel):
    """The preview pane's Evaluate/Formalize run (routers/analysis.py).
    `content` is the editor's text as it stands, which may be ahead of what
    is saved; `language` is the UI's, the fallback language for the reply."""

    content: str
    provider: str
    model: str
    reasoning_effort: str | None = None
    language: str = "en"
    # How the client renders this document's math ("latex", "asciimath" or
    # "hybrid" - its directive, else the folder's): the reply's own math is
    # asked for in the same notation, so it renders the same way.
    math_dialect: str = "latex"


class DiscussRequest(BaseModel):
    """One spoken turn of the voice-discussion pane. The client keeps the
    transcript and sends a bounded history plus, for a long document, an
    excerpt rather than the whole file. Nothing in this request is stored;
    document edits are applied and saved by the browser."""

    content: str
    history: list[InlineMessage] = []
    summary: str = ""
    target_document: TargetDocument
    provider: str
    model: str
    reasoning_effort: str | None = None
    # The app language. The reply follows the speaker when they use another.
    language: str = "ko"


class InlineCompleteRequest(BaseModel):
    """An unrecorded LLM completion for app.js's inline-thread mode (see
    routers/conversations.py's inline_complete). Unlike CreateMessageRequest
    there's no *turn* bookkeeping: nothing here is ever written to disk, and
    the reply goes back to the client to splice into the document itself.
    `content` is the pending question and `history` the earlier turns of the
    same thread, both parsed by app.js out of the document's own text - the
    thread lives in the document, not in storage, which is why the client
    has to hand it over on every call. This folder's system-prompt chain
    still applies, so the completion stays in character with the rest of
    it."""

    content: str
    history: list[InlineMessage] = []
    # The document text above the question (other inline threads already
    # stripped by the client) - what the question is asked about.
    context: str = ""
    provider: str
    model: str
    reasoning_effort: str | None = None
    convert_math: bool = False
    hybrid_math: bool = False


class SaveDocumentRequest(BaseModel):
    content: str


class SaveDraftSettingsRequest(BaseModel):
    """An explicit provider/model choice for a draft that has not been sent.
    See storage.set_draft_settings. A turn's choice is recorded when the
    message is sent, not through this request."""

    provider: str
    model: str
    reasoning_effort: str | None = None
    context_scope: Literal["default", "sibling", "descendants"] = "default"


class ConvertToAsciiMathRequest(BaseModel):
    content: str
    # See CreateMessageRequest.hybrid_math - same "dollar-only" conversion
    # choice, for the on-demand "convert this whole document now" action
    # (the format radio) rather than a fresh LLM response. A dedicated model
    # rather than reusing SaveDocumentRequest, since every other route that
    # takes one is a plain overwrite with no format-choice field of its own.
    hybrid: bool = False


class RenameDocumentRequest(BaseModel):
    new_filename: str


class RenameConversationRequest(BaseModel):
    title: str


class MoveConversationRequest(BaseModel):
    # None moves the folder to the project's top level. See
    # storage.move_conversation.
    parent_id: str | None = None


class MoveDocumentRequest(BaseModel):
    target_conv_id: str
    # Another project's folder; this one's when left out.
    target_project_id: str | None = None


class CopyDocumentRequest(BaseModel):
    target_conv_id: str
    target_project_id: str | None = None


class PublishOptionsRequest(BaseModel):
    # See storage.set_publish_slides.
    slides: bool

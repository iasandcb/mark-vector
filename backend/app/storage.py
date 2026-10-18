import json
import re
import shutil
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .config import settings

SYSTEM_FILENAME = "system.md"
CUSTOM_SYMBOLS_FILENAME = "custom-symbols.csv"
SPOKEN_MATH_FILENAME = "spoken-math.csv"
# The vocabulary a fresh install starts with - copied into DATA_DIR the
# first time it's read, and from then on only that copy is used and edited.
SPOKEN_MATH_SEED = Path(__file__).with_name("spoken_math_default.csv")

# A user message is almost always short; the reply is often long. Keeping
# them as two separate tree entries per exchange was mostly clutter, so each
# exchange is one file with both parts under these headings (kept as real
# Markdown headings, not hidden comments, so the split is visible when the
# file is read or previewed on its own, not just when parsed by this app).
# One heading pair per UI language (see frontend/static/js/i18n.js's three
# supported languages) - which pair a *new* heading uses follows whatever
# language the sender's UI was set to at send time (the `language` param
# threaded through start_exchange/retry_exchange/complete_exchange below),
# but *parsing* (_EXCHANGE_HEADING_ROLES, used by parse_exchange) recognizes
# all three regardless of the current language, since a conversation can mix
# languages across turns/sends - the sender's language, not the reader's,
# decided each heading when it was written, and older documents may
# predate this entirely (Korean, from before this was configurable).
DEFAULT_EXCHANGE_LANGUAGE = "en"
EXCHANGE_HEADINGS = {
    "en": {"user": "## User", "assistant": "## Assistant"},
    "ko": {"user": "## 사용자", "assistant": "## 어시스턴트"},
    "ja": {"user": "## ユーザー", "assistant": "## アシスタント"},
}
_EXCHANGE_HEADING_ROLES = {
    heading: role for headings in EXCHANGE_HEADINGS.values() for role, heading in headings.items()
}

# Deliberately permissive (Korean, spaces, symbols all fine for renaming) —
# the only real constraint is no path separators, so a filename can never
# resolve outside its conversation's own directory.
_FILENAME_RE = re.compile(r"^[^/\\\x00-\x1f]+\.md$")
# The lookahead requires the digit run to be immediately followed by "." or
# "_" - i.e. actually be "NNNN.md"/"NNNN_role.md" numbering, not just start
# with a digit. Without it, a "YYYY-MM-DD.md" daily-log filename (see
# create_draft/_next_draft_filename) would parse its year as a four-digit
# NNNN index, pushing every later numbered document in that same folder up
# to "2027.md" and beyond.
_LEADING_DIGITS_RE = re.compile(r"^(\d+)(?=[._])")

# Every conversation lived directly under data/conversations/ before
# projects existed. Migrated (see _migrate_legacy_conversations) into a
# project with this fixed id, so it's stable across repeated startups
# rather than a fresh uuid each time - migration only ever needs to run
# once per data directory.
DEFAULT_PROJECT_ID = "default"
DEFAULT_PROJECT_TITLE = "기본 프로젝트"


def _validate_filename(filename: str) -> None:
    if not _FILENAME_RE.match(filename):
        raise ValueError(f"Invalid filename: {filename}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- global (app-wide) system prompt ----------


def _global_system_path() -> Path:
    path = Path(settings.data_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / SYSTEM_FILENAME


def get_global_system_prompt() -> str:
    """Raw (unstripped) content, for the editor to display exactly what's saved."""
    path = _global_system_path()
    if not path.exists():
        path.write_text("", encoding="utf-8")
    return path.read_text(encoding="utf-8")


def save_global_system_prompt(content: str) -> dict:
    path = _global_system_path()
    path.write_text(content, encoding="utf-8")
    return {"content": content, "updated_at": _now()}


# ---------- global (app-wide) custom AsciiMath symbols ----------
#
# One shared CSV, always applied - unlike the system prompt tiers, there's
# no per-project/per-session override for this (see
# app/custom_symbols.py for the format and how it's applied to both the
# LaTeX -> AsciiMath2 conversion and, via /api/custom-symbols, the
# frontend's AsciiMath2 -> LaTeX rendering).


def _global_custom_symbols_path() -> Path:
    path = Path(settings.data_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / CUSTOM_SYMBOLS_FILENAME


def get_global_custom_symbols() -> str:
    """Raw CSV text, for the editor to display exactly what's saved."""
    path = _global_custom_symbols_path()
    if not path.exists():
        path.write_text("", encoding="utf-8")
    return path.read_text(encoding="utf-8")


def save_global_custom_symbols(content: str) -> dict:
    path = _global_custom_symbols_path()
    path.write_text(content, encoding="utf-8")
    return {"content": content, "updated_at": _now()}


# ---------- global spoken-math vocabulary ----------
#
# "공용 수식 말": the rules dictation uses inside a $$ block to turn spoken
# Korean math into AsciiMath (see asciimath-markdown's src/spoken-math.js for the
# format and matching). One file holds the whole vocabulary - the defaults
# it was seeded with and every later edit alike - so there's no separate
# built-in table to drift from it.


def _global_spoken_math_path() -> Path:
    path = Path(settings.data_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / SPOKEN_MATH_FILENAME


def get_global_spoken_math() -> str:
    path = _global_spoken_math_path()
    if not path.exists():
        shutil.copyfile(SPOKEN_MATH_SEED, path)
    return path.read_text(encoding="utf-8")


def save_global_spoken_math(content: str) -> dict:
    path = _global_spoken_math_path()
    path.write_text(content, encoding="utf-8")
    return {"content": content, "updated_at": _now()}


# ---------- projects ----------
#
# projects/<project_id>/
#   meta.json
#   system.md            - shared by every session in this project (see
#                           routers/conversations.py's system-prompt join:
#                           global -> project -> session)
#   conversations/<conv_id>/...   - exactly the old data/conversations/<id>/
#                                   layout, just nested one level deeper


def _projects_root() -> Path:
    path = Path(settings.data_dir) / "projects"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _project_dir(project_id: str) -> Path:
    return _projects_root() / project_id


def _project_meta_path(project_id: str) -> Path:
    return _project_dir(project_id) / "meta.json"


def _read_project_meta(project_id: str) -> dict:
    path = _project_meta_path(project_id)
    if not path.exists():
        raise FileNotFoundError(project_id)
    return json.loads(path.read_text(encoding="utf-8"))


def _write_project_meta(project_id: str, meta: dict) -> None:
    _project_meta_path(project_id).write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _migrate_legacy_conversations() -> None:
    """One-time migration for a data directory that predates projects: every
    session lived directly under data/conversations/. Moves that whole
    directory to become the default project's own conversations/, so
    sessions that existed before this change keep working exactly as
    before, just inside a project now. Idempotent (a no-op once the legacy
    directory is gone) and safe to call on every list_projects() - it's
    cheap (one exists() check) once migrated.

    Runs lazily here rather than at process startup / module import so it
    always sees the *current* settings.data_dir - tests monkeypatch that
    per-test, which an import-time migration would miss entirely.
    """
    legacy_dir = Path(settings.data_dir) / "conversations"
    if not legacy_dir.exists():
        return

    default_dir = _project_dir(DEFAULT_PROJECT_ID)
    default_dir.mkdir(parents=True, exist_ok=True)
    target = default_dir / "conversations"

    if target.exists():
        # Partial/repeated migration (e.g. an earlier run got interrupted) -
        # move whatever's left session by session instead of clobbering.
        for child in legacy_dir.iterdir():
            dest = target / child.name
            if not dest.exists():
                shutil.move(str(child), str(dest))
    else:
        shutil.move(str(legacy_dir), str(target))

    if legacy_dir.exists() and not any(legacy_dir.iterdir()):
        legacy_dir.rmdir()

    if not _project_meta_path(DEFAULT_PROJECT_ID).exists():
        now = _now()
        _write_project_meta(
            DEFAULT_PROJECT_ID,
            {
                "id": DEFAULT_PROJECT_ID,
                "title": DEFAULT_PROJECT_TITLE,
                "created_at": now,
                "updated_at": now,
            },
        )
    _ensure_system_file(default_dir)


def list_projects() -> list[dict]:
    _migrate_legacy_conversations()
    summaries = []
    for entry in _projects_root().iterdir():
        if entry.is_dir() and (entry / "meta.json").exists():
            meta = _read_project_meta(entry.name)
            summaries.append(
                {
                    "id": meta["id"],
                    "title": meta["title"],
                    "created_at": meta["created_at"],
                    "updated_at": meta["updated_at"],
                }
            )
    # Fixed order (newest-created first) rather than most-recently-active -
    # sorting by activity meant sending one message anywhere inside a
    # project bounced it to the top of every other project's list, which
    # read as the whole sidebar reordering itself mid-session. `created_at`
    # never changes after the fact, so a project's position stays put no
    # matter what happens inside it. list_conversations (a project's own
    # folders) keeps its existing most-recently-active sort - only the
    # project list itself changes here.
    summaries.sort(key=lambda m: m["created_at"], reverse=True)
    return summaries


def create_project(title: str = "Untitled") -> dict:
    project_id = uuid.uuid4().hex[:12]
    project_dir = _project_dir(project_id)
    project_dir.mkdir(parents=True, exist_ok=False)
    now = _now()
    meta = {"id": project_id, "title": title, "created_at": now, "updated_at": now}
    _write_project_meta(project_id, meta)
    (project_dir / SYSTEM_FILENAME).write_text("", encoding="utf-8")
    (project_dir / "conversations").mkdir(parents=True, exist_ok=True)
    return meta


def get_project(project_id: str) -> dict:
    return _read_project_meta(project_id)


def rename_project(project_id: str, title: str) -> dict:
    meta = _read_project_meta(project_id)
    meta["title"] = title
    meta["updated_at"] = _now()
    _write_project_meta(project_id, meta)
    return meta


def delete_project(project_id: str) -> None:
    """Deletes a project and every session inside it. There is no
    "project of last resort" once this project's sessions are gone - unlike
    system.md within a session, an empty project is a perfectly valid,
    intentional state (nothing forces one to exist)."""
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise FileNotFoundError(project_id)
    shutil.rmtree(project_dir)


def _ensure_system_file(dir_path: Path) -> None:
    path = dir_path / SYSTEM_FILENAME
    if not path.exists():
        path.write_text("", encoding="utf-8")


def get_project_system_prompt(project_id: str) -> str:
    """Raw (unstripped) content, for the editor - mirrors
    get_global_system_prompt(). Stripping (for the LLM system-prompt join)
    happens at the call site, same as the global one."""
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise FileNotFoundError(project_id)
    _ensure_system_file(project_dir)
    return (project_dir / SYSTEM_FILENAME).read_text(encoding="utf-8")


def save_project_system_prompt(project_id: str, content: str) -> dict:
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise FileNotFoundError(project_id)
    (project_dir / SYSTEM_FILENAME).write_text(content, encoding="utf-8")
    meta = _read_project_meta(project_id)
    meta["updated_at"] = _now()
    _write_project_meta(project_id, meta)
    return {"content": content, "updated_at": meta["updated_at"]}


# ---------- conversations (sessions), nested under a project ----------


def _touch_project(project_id: str) -> None:
    """Bumps a project's own updated_at from session-level activity inside
    it (a new session, a new turn, a deleted session), so list_projects()'s
    most-recently-active-first sort actually reflects activity - not just
    project rename/creation, the same way a session's own updated_at
    already gets bumped by more than just renaming it."""
    try:
        meta = _read_project_meta(project_id)
    except FileNotFoundError:
        return
    meta["updated_at"] = _now()
    _write_project_meta(project_id, meta)


def _conversations_dir(project_id: str) -> Path:
    if not _project_dir(project_id).exists():
        raise FileNotFoundError(project_id)
    path = _project_dir(project_id) / "conversations"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _meta_path(project_id: str, conv_id: str) -> Path:
    return _conversations_dir(project_id) / conv_id / "meta.json"


def _read_meta(project_id: str, conv_id: str) -> dict:
    path = _meta_path(project_id, conv_id)
    if not path.exists():
        raise FileNotFoundError(conv_id)
    return json.loads(path.read_text(encoding="utf-8"))


def _write_meta(project_id: str, conv_id: str, meta: dict) -> None:
    _meta_path(project_id, conv_id).write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def list_conversations(project_id: str) -> list[dict]:
    summaries = []
    for entry in _conversations_dir(project_id).iterdir():
        if entry.is_dir() and (entry / "meta.json").exists():
            meta = _read_meta(project_id, entry.name)
            summaries.append(
                {
                    "id": meta["id"],
                    "project_id": project_id,
                    # None for a folder created before nesting existed, or
                    # one deliberately left at the top level - both mean
                    # "no parent" the same way (see app.js's tree grouping).
                    "parent_id": meta.get("parent_id"),
                    "title": meta["title"],
                    "provider": meta["provider"],
                    "model": meta["model"],
                    "reasoning_effort": meta.get("reasoning_effort"),
                    "convert_math": meta.get("convert_math", False),
                    "created_at": meta["created_at"],
                    "updated_at": meta["updated_at"],
                }
            )
    summaries.sort(key=lambda m: m["updated_at"], reverse=True)
    return summaries


def create_conversation(project_id: str, title: str = "Untitled", parent_id: str | None = None) -> dict:
    """Provider/model/reasoning_effort/convert_math are chosen per document,
    not for the folder. The top-level fields stay on meta so older files
    still load, but a send does not update them and the editor does not
    read them: a new document uses the app default, and a document that
    already has its own saved choice (a turn, or a draft the user picked
    for) uses that. See list_documents / set_draft_settings.

    `parent_id`, when given, nests this folder under another one in the
    same project (see get_system_prompt_chain) - purely a logical pointer,
    not a physical directory move: every folder still lives flat under
    projects/<pid>/conversations/<id>/ regardless of nesting depth, so
    creating/deleting/renaming a folder never has to touch any other
    folder's files. `_read_meta` raises FileNotFoundError on its own if
    `parent_id` doesn't name a real folder in this project."""
    if parent_id is not None:
        _read_meta(project_id, parent_id)
    conv_id = uuid.uuid4().hex[:12]
    conv_dir = _conversations_dir(project_id) / conv_id
    conv_dir.mkdir(parents=True, exist_ok=False)
    now = _now()
    meta = {
        "id": conv_id,
        "project_id": project_id,
        "parent_id": parent_id,
        "title": title,
        "provider": None,
        "model": None,
        "reasoning_effort": None,
        "convert_math": False,
        "context_scope": None,
        "created_at": now,
        "updated_at": now,
        "turns": [],
    }
    _write_meta(project_id, conv_id, meta)
    (conv_dir / SYSTEM_FILENAME).write_text("", encoding="utf-8")
    _touch_project(project_id)
    return meta


def get_system_prompt(project_id: str, conv_id: str) -> str:
    conv_dir = _conversations_dir(project_id) / conv_id
    _ensure_system_file(conv_dir)
    return (conv_dir / SYSTEM_FILENAME).read_text(encoding="utf-8").strip()


def get_system_prompt_chain(project_id: str, conv_id: str) -> list[str]:
    """The folder-nesting analogue of the existing global -> project ->
    session system-prompt cascade (see routers/conversations.py's
    send_message), just walked up an arbitrary parent_id chain instead of a
    fixed two tiers: this folder's own system.md, preceded by every
    ancestor folder's (root first). `seen` guards against a corrupted/
    cyclic parent_id chain - should never happen, but a hang here would be
    a much worse failure mode than just stopping early."""
    chain = []
    current: str | None = conv_id
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        chain.append(get_system_prompt(project_id, current))
        current = _read_meta(project_id, current).get("parent_id")
    chain.reverse()
    return chain


def get_conversation(project_id: str, conv_id: str) -> dict:
    meta = _read_meta(project_id, conv_id)
    conv_dir = _conversations_dir(project_id) / conv_id
    turns = []
    for turn in meta["turns"]:
        content = (conv_dir / turn["file"]).read_text(encoding="utf-8")
        turns.append({**turn, "content": content})
    return {**meta, "turns": turns}


def rename_conversation(project_id: str, conv_id: str, title: str) -> dict:
    meta = _read_meta(project_id, conv_id)
    meta["title"] = title
    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    return meta


def _descendant_folder_ids(project_id: str, conv_id: str) -> list[str]:
    """conv_id itself, plus every folder nested under it at any depth -
    shared by delete_conversation's cascade and the "descendants" context
    scope (see build_history_for_turn). Folders point at their parent via
    parent_id (see create_conversation) rather than living inside it on
    disk, so this is the only way to find "everything under conv_id" -
    there's no directory tree to walk."""
    ids = [conv_id]
    for child in list_conversations(project_id):
        if child["parent_id"] == conv_id:
            ids.extend(_descendant_folder_ids(project_id, child["id"]))
    return ids


def move_conversation(project_id: str, conv_id: str, new_parent_id: str | None) -> dict:
    """Drag-and-drop reparenting - a plain parent_id update, since folders
    never nest physically on disk (see create_conversation's docstring).
    Guarded against the one thing that would actually corrupt the tree:
    moving a folder under itself or one of its own descendants, which
    _descendant_folder_ids would then loop over forever."""
    meta = _read_meta(project_id, conv_id)
    if new_parent_id is not None:
        if new_parent_id == conv_id or new_parent_id in _descendant_folder_ids(project_id, conv_id):
            raise ValueError("Cannot move a folder into itself or one of its own subfolders")
        _read_meta(project_id, new_parent_id)
    meta["parent_id"] = new_parent_id
    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    _touch_project(project_id)
    return meta


def delete_conversation(project_id: str, conv_id: str) -> None:
    """Cascades to every descendant folder too, same principle as
    delete_project already cascading to every session inside it - deleting
    a folder deletes everything organized under it, not just itself. Every
    folder (this one and each descendant) lives in its own flat directory
    regardless of nesting depth, so each can just be removed independently -
    no containment order to worry about."""
    if not (_conversations_dir(project_id) / conv_id).exists():
        raise FileNotFoundError(conv_id)
    for folder_id in _descendant_folder_ids(project_id, conv_id):
        shutil.rmtree(_conversations_dir(project_id) / folder_id)
    _touch_project(project_id)


def _build_user_only_content(user_content: str, language: str) -> str:
    """A brand-new turn's very first section: just the pending question, no
    reply yet - used by start_exchange, and by retry_exchange for the fresh
    trailing section it renormalizes (see its docstring)."""
    heading = EXCHANGE_HEADINGS[language]["user"]
    return f"{heading}\n\n{user_content.strip()}\n"


def parse_exchange(content: str) -> list[dict]:
    """Splits one exchange file's content back into role messages, by
    whichever of EXCHANGE_HEADINGS' user/assistant heading pairs it finds -
    any language, and a document with several rounds may mix them if its
    UI language changed between sends. Used to reconstruct LLM history."""
    messages: list[dict] = []
    role = None
    buffer: list[str] = []

    def flush():
        if role and buffer:
            text = "\n".join(buffer).strip()
            if text:
                messages.append({"role": role, "content": text})

    for line in content.split("\n"):
        heading_role = _EXCHANGE_HEADING_ROLES.get(line.strip())
        if heading_role:
            flush()
            role = heading_role
            buffer = []
        else:
            buffer.append(line)
    flush()
    return messages


def _turn_messages(turn: dict, *, exclude_pending_tail_of: str | None) -> list[dict]:
    """One turn's own content as LLM messages. Either an old-style single-
    role file (has a "role" key - from before user/assistant were merged
    into one file per exchange) or a new-style merged exchange file (no
    "role" key - parsed into up to two messages by its headings). `turn`
    must already have `content` attached, i.e. it came from
    get_conversation(), not list_conversations()'s bare summaries.

    `exclude_pending_tail_of`, when this turn's id, drops just its own
    trailing pending (unanswered) question, if it has one - the caller
    (routers/conversations.py's send_message) is about to append that exact
    question itself (as `turn["question"]`, from a fresher in-flight
    retry_exchange/start_exchange result, not this snapshot's possibly-
    stale on-disk content), so leaving it here too would duplicate it. Any
    earlier *complete* rounds already in this same turn/file (see
    retry_exchange's "continue a completed turn" case) are unaffected and
    still included."""
    if "role" in turn:
        return [{"role": turn["role"], "content": turn["content"]}]
    messages = parse_exchange(turn["content"])
    if turn.get("id") == exclude_pending_tail_of and messages and messages[-1]["role"] == "user":
        messages = messages[:-1]
    return messages


def build_history(meta: dict, *, exclude_pending_tail_of: str | None = None) -> list[dict]:
    """Reconstructs the LLM message history from every turn in one
    conversation/folder - the "sibling" context scope's own logic (see
    build_history_for_turn), also still used directly wherever "every turn
    in this exact folder" is what's wanted regardless of scope (e.g.
    build_history's own historical callers). `meta` must already have
    `content` attached to each turn, i.e. it's the return value of
    get_conversation()."""
    history = []
    for turn in meta["turns"]:
        history.extend(_turn_messages(turn, exclude_pending_tail_of=exclude_pending_tail_of))
    return history


CONTEXT_SCOPES = ("default", "sibling", "descendants")


def build_history_for_turn(
    project_id: str, conv_id: str, turn_id: str, *, scope: str, exclude_pending_tail_of: str | None = None
) -> list[dict]:
    """The LLM context a turn actually sees, per `scope` (see
    CONTEXT_SCOPES):
    - "default": just this turn's own content - whatever multi-round
      history already lives in its own file (see retry_exchange), nothing
      from any other document in this or any other folder.
    - "sibling": every turn in this same folder - build_history's own
      behavior, unchanged, just reached through here too.
    - "descendants": every turn in this folder and every folder nested
      under it (see _descendant_folder_ids), merged and ordered by each
      turn's own created_at - so folders interleave chronologically rather
      than one folder's turns all landing before another's regardless of
      when either was actually written."""
    if scope == "default":
        meta = get_conversation(project_id, conv_id)
        turn = next((t for t in meta["turns"] if t["id"] == turn_id), None)
        if turn is None:
            raise FileNotFoundError(turn_id)
        return _turn_messages(turn, exclude_pending_tail_of=exclude_pending_tail_of)

    if scope == "sibling":
        meta = get_conversation(project_id, conv_id)
        return build_history(meta, exclude_pending_tail_of=exclude_pending_tail_of)

    if scope == "descendants":
        turns: list[dict] = []
        for folder_id in _descendant_folder_ids(project_id, conv_id):
            turns.extend(get_conversation(project_id, folder_id)["turns"])
        turns.sort(key=lambda t: t["created_at"])
        history: list[dict] = []
        for turn in turns:
            history.extend(_turn_messages(turn, exclude_pending_tail_of=exclude_pending_tail_of))
        return history

    raise ValueError(f"Unknown context scope: {scope!r}")


def _next_document_index(meta: dict, conv_dir: Path) -> int:
    """The next `NNNN` to use for a new document - a fresh draft
    (create_draft) or a turn started from scratch (start_exchange with no
    draft_filename). Deliberately the max of every index already in use,
    plus one - both registered turns (meta["turns"]) *and* plain files
    already sitting on disk that haven't been sent yet (a draft created but
    not yet promoted into a turn - see start_exchange's draft_filename
    param, which reuses that same file/number rather than moving to a new
    one). Scanning meta["turns"] alone would let two drafts created
    back-to-back collide on the same number (neither is a turn yet, so
    neither shows up there) and silently overwrite one another; using
    `len(...)` instead of the max would let a reused low number collide
    with a turn/draft that still exists once either can be deleted. Old-
    style turn pairs ("0001_user.md" / "0001_assistant.md") share one
    leading number, which this parses the same way as a new-style
    "0001.md"."""
    max_index = 0
    for turn in meta["turns"]:
        m = _LEADING_DIGITS_RE.match(turn["file"])
        if m:
            max_index = max(max_index, int(m.group(1)))
    for path in conv_dir.glob("*.md"):
        m = _LEADING_DIGITS_RE.match(path.name)
        if m:
            max_index = max(max_index, int(m.group(1)))
    return max_index + 1


def start_exchange(
    project_id: str,
    conv_id: str,
    user_content: str,
    *,
    provider: str,
    model: str,
    reasoning_effort: str | None = None,
    convert_math: bool = False,
    context_scope: str = "default",
    draft_filename: str | None = None,
    language: str = DEFAULT_EXCHANGE_LANGUAGE,
) -> dict:
    """`draft_filename`, when given, is an existing draft (see create_draft)
    that this exchange grows out of: that draft's own file becomes the
    exchange in place - same filename, now registered as an official turn -
    rather than leaving it behind as an orphaned scratch file while the
    exchange lands in a freshly numbered NNNN.md elsewhere. Whichever
    document was open when "send" was clicked is exactly the document that
    ends up holding the reply - never a different one."""
    meta = _read_meta(project_id, conv_id)
    conv_dir = _conversations_dir(project_id) / conv_id
    content = _build_user_only_content(user_content, language)

    if draft_filename is not None:
        _validate_filename(draft_filename)
        draft_path = conv_dir / draft_filename
        if not draft_path.exists():
            raise FileNotFoundError(draft_filename)
        is_draft = draft_filename != SYSTEM_FILENAME and not any(
            t["file"] == draft_filename for t in meta["turns"]
        )
        if not is_draft:
            raise ValueError(f"{draft_filename!r} is not a draft")
        filename = draft_filename
    else:
        filename = f"{_next_document_index(meta, conv_dir):04d}.md"

    (conv_dir / filename).write_text(content, encoding="utf-8")

    now = _now()
    turn = {
        "id": uuid.uuid4().hex[:8],
        "file": filename,
        "created_at": now,
        # Recorded per turn since these are chosen per turn now, not fixed
        # for the whole session - this is what was actually used for this
        # one exchange, which can differ from the turn before or after it.
        "provider": provider,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "convert_math": convert_math,
        "context_scope": context_scope,
    }
    meta["turns"].append(turn)
    meta["updated_at"] = now
    # The file is a turn now, so any choice saved while it was still a
    # draft lives on the turn above. Drop the draft copy.
    _pop_draft_choice(meta, filename)

    if meta["title"] == "Untitled" and user_content.strip():
        first_line = user_content.strip().splitlines()[0]
        meta["title"] = first_line.lstrip("#").strip()[:60] or "Untitled"

    _write_meta(project_id, conv_id, meta)
    _touch_project(project_id)
    # "question": the exact text the LLM should see as this turn's new user
    # message - callers (routers/conversations.py) use this instead of the
    # raw request body, which for retry_exchange below can carry an entire
    # multi-round document, not just the one new question.
    return {**turn, "content": content, "question": user_content.strip()}


def retry_exchange(
    project_id: str,
    conv_id: str,
    turn_id: str,
    raw_content: str,
    *,
    provider: str,
    model: str,
    reasoning_effort: str | None = None,
    convert_math: bool = False,
    context_scope: str = "default",
    language: str = DEFAULT_EXCHANGE_LANGUAGE,
) -> dict:
    """Completes a turn/file whose content ends in a pending, unanswered
    question - rewrites that same file in place instead of start_exchange's
    usual "always a fresh NNNN.md", so the answer lands right after its own
    question rather than in a new, disconnected file elsewhere.

    Two distinct ways to get here, handled identically:
    - **A failed send retried**: the turn started, the provider errored out
      before any reply came back (see complete_exchange, never called that
      time), and the file still holds just that one unanswered question.
    - **A completed turn continued**: the file already holds one or more
      full question/answer rounds, and a new question was typed (or, once
      the editor supports it, appended) below the last answer - same "this
      file's tail end is a question with no reply yet" shape, just with
      history in front of it this time.

    `raw_content` is the editor's full buffer, same as start_exchange's
    user_content elsewhere - but here it still carries whatever heading(s)
    are already in the document (there's no reply yet to the last one, so
    nothing pushed it out of view), so it's parsed by those headings rather
    than wrapped verbatim, or the last question's heading would double up.
    Everything before that trailing question - any earlier complete rounds,
    in whatever language their headings happen to already be in - is kept
    byte-for-byte; only the trailing question itself is renormalized
    (stripped, rewrapped under `language`'s heading), the same as a fresh
    start_exchange call would for a turn's very first question."""
    meta = _read_meta(project_id, conv_id)
    turn = next((t for t in meta["turns"] if t["id"] == turn_id), None)
    if turn is None:
        raise FileNotFoundError(turn_id)

    messages = parse_exchange(raw_content)
    if not messages or messages[-1]["role"] != "user":
        raise ValueError(f"Turn {turn_id!r} has no pending question to answer")
    user_content = messages[-1]["content"]

    lines = raw_content.split("\n")
    last_user_line = max(
        i for i, line in enumerate(lines) if _EXCHANGE_HEADING_ROLES.get(line.strip()) == "user"
    )
    prefix = "\n".join(lines[:last_user_line]).rstrip("\n")
    new_section = _build_user_only_content(user_content, language)
    content = f"{prefix}\n\n{new_section}" if prefix else new_section

    conv_dir = _conversations_dir(project_id) / conv_id
    (conv_dir / turn["file"]).write_text(content, encoding="utf-8")

    turn["provider"] = provider
    turn["model"] = model
    turn["reasoning_effort"] = reasoning_effort
    turn["convert_math"] = convert_math
    turn["context_scope"] = context_scope

    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    _touch_project(project_id)
    return {**turn, "content": content, "question": user_content}


def complete_exchange(
    project_id: str,
    conv_id: str,
    turn_id: str,
    assistant_content: str,
    *,
    directive: str | None = None,
    language: str = DEFAULT_EXCHANGE_LANGUAGE,
) -> dict:
    """`directive`, when given (typically `latex_to_asciimath.MATH_DIRECTIVE`
    or `HYBRID_MATH_DIRECTIVE`), is prepended at the true top of the whole
    document - not merely a bool, since which of the two literal directive
    strings applies depends on whether the LaTeX -> AsciiMath2 auto-
    conversion that ran before this call was full or hybrid (dollar-only);
    the caller (routers/conversations.py) already knows which and passes it
    straight through instead of this function guessing from `language` or
    anything else it has no way to infer that from."""
    meta = _read_meta(project_id, conv_id)
    turn = next((t for t in meta["turns"] if t["id"] == turn_id), None)
    if turn is None:
        raise FileNotFoundError(turn_id)

    conv_dir = _conversations_dir(project_id) / conv_id
    path = conv_dir / turn["file"]
    # Appended directly onto whatever's already on disk - which, whether this
    # turn holds its first question or several complete rounds already (see
    # retry_exchange), always ends in exactly one pending, unanswered
    # question at this point, with nothing after it to preserve. Earlier
    # rounds are therefore never re-derived/re-serialized here, so their
    # existing headings (whatever language each happened to be sent in)
    # stay exactly as they were written.
    existing_raw = path.read_text(encoding="utf-8").rstrip("\n")
    heading = EXCHANGE_HEADINGS[language]["assistant"]
    content = f"{existing_raw}\n\n{heading}\n\n{assistant_content.strip()}\n"
    # The directive only means anything at the true top of the whole
    # rendered document (frontend/static/js/markdown.js's DIRECTIVE_RE scans
    # for it there), not tucked under an assistant heading partway through -
    # which is where it'd land if latex_to_asciimath.py prepended it to just
    # the assistant half before this function ever sees it. `parse_exchange`
    # (used by build_history for LLM context) safely ignores any line before
    # the first recognized heading, so this is safe to prepend after the
    # fact without disturbing either half.
    if directive:
        content = f"{directive}\n{content}"
    path.write_text(content, encoding="utf-8")

    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    return {**turn, "content": content}


def _choice_from(record: dict | None) -> dict | None:
    """A document's own saved provider/model, or None when it has none.

    `provider` is the signal that a choice was actually stored. A missing
    record (a new draft, a turn from before these fields existed) means
    "no choice", which the editor fills with the app default rather than
    the folder's last send."""
    if not record or not record.get("provider"):
        return None
    return {
        "provider": record.get("provider"),
        "model": record.get("model"),
        "reasoning_effort": record.get("reasoning_effort"),
        "context_scope": record.get("context_scope") or "default",
    }


def _draft_choices(meta: dict) -> dict:
    choices = meta.get("draft_settings")
    return choices if isinstance(choices, dict) else {}


def _pop_draft_choice(meta: dict, filename: str) -> dict | None:
    choices = meta.get("draft_settings")
    if not isinstance(choices, dict):
        return None
    return choices.pop(filename, None)


def _put_draft_choice(meta: dict, filename: str, choice: dict) -> None:
    meta.setdefault("draft_settings", {})[filename] = choice


def _document_choice(meta: dict, filename: str, turn: dict | None) -> dict | None:
    if turn:
        return _choice_from(turn)
    return _choice_from(_draft_choices(meta).get(filename))


def set_draft_settings(
    project_id: str,
    conv_id: str,
    filename: str,
    *,
    provider: str,
    model: str,
    reasoning_effort: str | None = None,
    context_scope: str = "default",
) -> dict:
    """Remember an explicit toolbar choice on a draft that has not been
    sent. A turn keeps its choice on the turn record (written when it is
    sent); this is only for a draft the user has actually picked a
    provider/model for, so reopening it does not fall back to the app
    default. A new draft has no entry here until that happens."""
    _validate_filename(filename)
    if filename == SYSTEM_FILENAME:
        raise ValueError(f"{filename!r} is not a draft")
    if not provider or not model:
        raise ValueError("provider and model are required")
    meta = _read_meta(project_id, conv_id)
    conv_dir = _conversations_dir(project_id) / conv_id
    path = conv_dir / filename
    if not path.exists():
        raise FileNotFoundError(filename)
    if any(t["file"] == filename for t in meta["turns"]):
        raise ValueError(f"{filename!r} is not a draft")
    choice = {
        "provider": provider,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "context_scope": context_scope or "default",
    }
    _put_draft_choice(meta, filename, choice)
    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    return choice


def list_documents(project_id: str, conv_id: str) -> list[dict]:
    meta = _read_meta(project_id, conv_id)
    conv_dir = _conversations_dir(project_id) / conv_id
    _ensure_system_file(conv_dir)
    turn_by_file = {t["file"]: t for t in meta["turns"]}
    published_by_file = _published_tokens_by_filename(project_id, conv_id)
    slides_files = _published_slides_filenames(project_id, conv_id)
    documents = []
    for path in sorted(conv_dir.glob("*.md")):
        turn = turn_by_file.get(path.name)
        if path.name == SYSTEM_FILENAME:
            role, turn_id = "system", None
        elif turn:
            # old turns (pre-merge) carry their own "role"; new turns are a
            # full user+assistant exchange in one file, so use "exchange"
            role, turn_id = turn.get("role", "exchange"), turn["id"]
        else:
            role, turn_id = "draft", None
        stat = path.stat()
        choice = _document_choice(meta, path.name, turn)
        documents.append(
            {
                "filename": path.name,
                "role": role,
                "turn_id": turn_id,
                "content": path.read_text(encoding="utf-8"),
                "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "version": _file_version(path),
                "publish_token": published_by_file.get(path.name),
                "publish_slides": path.name in slides_files,
                # None on a document that has never had its own choice saved
                # (a new draft). The editor then uses the app default, not
                # whatever this folder last sent with.
                "provider": choice["provider"] if choice else None,
                "model": choice["model"] if choice else None,
                "reasoning_effort": choice["reasoning_effort"] if choice else None,
                "context_scope": choice["context_scope"] if choice else None,
            }
        )
    # pin the system prompt to the top regardless of filename sort order
    documents.sort(key=lambda d: d["role"] != "system")
    return documents


def revert_turn_to_draft(project_id: str, conv_id: str, filename: str) -> dict:
    """The inverse of start_exchange's draft_filename param: unregisters
    this file as a turn - dropping it out of meta["turns"], so it no longer
    counts toward LLM history (see build_history) and can no longer be
    continued via retry_exchange - while leaving the file and its content on
    disk exactly as they are. Same filename, same content, just a plain
    draft again; never deleted, never renamed. (system.md is never a turn,
    so passing it here just falls into the same "not a turn" ValueError as
    any other non-turn filename would.)"""
    _validate_filename(filename)
    meta = _read_meta(project_id, conv_id)
    turn = next((t for t in meta["turns"] if t["file"] == filename), None)
    if turn is None:
        raise ValueError(f"{filename!r} is not a turn")
    meta["turns"] = [t for t in meta["turns"] if t["file"] != filename]
    # The file is a draft again. Keep the choice that was saved on the
    # turn, so reopening it still shows that choice rather than the app
    # default.
    choice = _choice_from(turn)
    if choice:
        _put_draft_choice(meta, filename, choice)
    meta["updated_at"] = _now()
    _write_meta(project_id, conv_id, meta)
    _touch_project(project_id)

    conv_dir = _conversations_dir(project_id) / conv_id
    content = (conv_dir / filename).read_text(encoding="utf-8")
    return {"filename": filename, "role": "draft", "turn_id": None, "content": content, "updated_at": _now()}


_DATE_FILENAME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.md$")


def _next_draft_filename(meta: dict, conv_dir: Path, today: date) -> str:
    """A folder used as a daily log/journal - its last document named
    "YYYY-MM-DD.md" - gets a new document named for today instead of the
    usual NNNN.md numbering, so "새 문서" starts today's entry whatever day
    the last one was written. When today's already exists, it continues
    with the day after the last entry instead (a second entry "for today"
    still needs a name of its own). Only the *last* filename (plain alphabetical order,
    same as list_documents' own sort - system.md is never date-named so
    never interferes) is checked, not every file in the folder: a folder
    that's mixed NNNN.md and date-named documents, or has gaps, should only
    ever continue from whatever's actually most recent, not the first date
    that happens to match. Falls back to the plain numbered scheme when the
    last file isn't date-named, or (this should only ever matter for a
    concurrent double-call) when both candidate names are somehow taken
    already."""
    existing = sorted(p.name for p in conv_dir.glob("*.md") if p.name != SYSTEM_FILENAME)
    if existing:
        match = _DATE_FILENAME_RE.match(existing[-1])
        if match:
            last_date = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
            for candidate in (today, last_date + timedelta(days=1)):
                next_filename = f"{candidate:%Y-%m-%d}.md"
                if not (conv_dir / next_filename).exists():
                    return next_filename
    return f"{_next_document_index(meta, conv_dir):04d}.md"


def create_draft(project_id: str, conv_id: str, today: date | None = None) -> dict:
    """Shares start_exchange's own NNNN.md numbering (see
    _next_document_index) rather than a separate random-uuid scheme, so a
    draft's filename never has to change when it's later sent - it's simply
    registered as a turn in place, still under the same number. See
    _next_draft_filename for the one exception, a folder already in
    "YYYY-MM-DD.md per document" form - `today` is the date to name the new
    entry after there (the caller's own calendar day; this server's if not
    given)."""
    conv_dir = _conversations_dir(project_id) / conv_id
    if not conv_dir.exists():
        raise FileNotFoundError(conv_id)
    meta = _read_meta(project_id, conv_id)
    filename = _next_draft_filename(meta, conv_dir, today or date.today())
    (conv_dir / filename).write_text("", encoding="utf-8")
    return {"filename": filename, "role": "draft", "turn_id": None, "content": "", "updated_at": _now()}


def _file_version(path: Path) -> str:
    """A document's version for change detection between browsers that have
    it open (see poll_document): the file's own mtime in nanoseconds, so any
    write - a Save, a finished exchange, another tab - moves it, with
    nothing extra to keep in step."""
    return str(path.stat().st_mtime_ns)


def poll_document(project_id: str, conv_id: str, filename: str, since: str | None = None) -> dict:
    """One document's current content and version - or, when `since` is
    already its version, just {"changed": False}, so a browser polling an
    open document for edits made elsewhere costs next to nothing while
    nothing has changed."""
    _validate_filename(filename)
    path = _conversations_dir(project_id) / conv_id / filename
    if not path.exists():
        raise FileNotFoundError(filename)
    version = _file_version(path)
    if since is not None and since == version:
        return {"changed": False, "version": version}
    return {"changed": True, "filename": filename, "content": path.read_text(encoding="utf-8"), "version": version}


def save_document(project_id: str, conv_id: str, filename: str, content: str) -> dict:
    _validate_filename(filename)
    path = _conversations_dir(project_id) / conv_id / filename
    if not path.exists():
        raise FileNotFoundError(filename)
    path.write_text(content, encoding="utf-8")
    return {"filename": filename, "content": content, "updated_at": _now(), "version": _file_version(path)}


def rename_document(project_id: str, conv_id: str, old_filename: str, new_filename: str) -> dict:
    _validate_filename(old_filename)
    _validate_filename(new_filename)
    if old_filename == SYSTEM_FILENAME or new_filename == SYSTEM_FILENAME:
        raise PermissionError("Cannot rename the system prompt document")
    if old_filename == new_filename:
        raise ValueError("New filename is the same as the current one")

    conv_dir = _conversations_dir(project_id) / conv_id
    old_path = conv_dir / old_filename
    new_path = conv_dir / new_filename
    if not old_path.exists():
        raise FileNotFoundError(old_filename)
    if new_path.exists():
        raise ValueError(f"A document named {new_filename!r} already exists")

    old_path.rename(new_path)
    _move_analyses(conv_dir, old_filename, conv_dir, new_filename)

    meta = _read_meta(project_id, conv_id)
    turn = next((t for t in meta["turns"] if t["file"] == old_filename), None)
    choice = _pop_draft_choice(meta, old_filename)
    if turn:
        turn["file"] = new_filename
    if choice:
        _put_draft_choice(meta, new_filename, choice)
    if turn or choice:
        _write_meta(project_id, conv_id, meta)

    _repoint_publish(project_id, conv_id, old_filename, new_filename)

    stat = new_path.stat()
    return {
        "filename": new_filename,
        "role": turn.get("role", "exchange") if turn else "draft",
        "turn_id": turn["id"] if turn else None,
        "content": new_path.read_text(encoding="utf-8"),
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "publish_token": _published_tokens_by_filename(project_id, conv_id).get(new_filename),
        "publish_slides": new_filename in _published_slides_filenames(project_id, conv_id),
    }


def move_document(project_id: str, conv_id: str, filename: str, target_conv_id: str) -> dict:
    """Drag-and-drop move to a different folder in the same project - the
    cross-folder analogue of rename_document, which only ever moves a file
    within its own conv_dir. system.md never moves (every folder has its
    own, see _ensure_system_file); moving a registered turn keeps its turn
    entry (id, role, provider/model, etc.) intact, just relocated from the
    source folder's meta["turns"] to the target's."""
    _validate_filename(filename)
    if filename == SYSTEM_FILENAME:
        raise PermissionError("Cannot move the system prompt document")
    if conv_id == target_conv_id:
        raise ValueError("Source and target folder are the same")

    _read_meta(project_id, target_conv_id)
    src_dir = _conversations_dir(project_id) / conv_id
    dst_dir = _conversations_dir(project_id) / target_conv_id
    src_path = src_dir / filename
    dst_path = dst_dir / filename
    if not src_path.exists():
        raise FileNotFoundError(filename)
    if dst_path.exists():
        raise ValueError(f"A document named {filename!r} already exists in the target folder")

    src_path.rename(dst_path)
    _move_analyses(src_dir, filename, dst_dir, filename)

    src_meta = _read_meta(project_id, conv_id)
    turn = next((t for t in src_meta["turns"] if t["file"] == filename), None)
    # A draft's explicit choice moves with the file. A turn carries its
    # choice on the turn record, which is relocated below. A copy (see
    # copy_document) deliberately does not take the choice: the new file
    # is a new draft and starts on the app default.
    choice = _pop_draft_choice(src_meta, filename)
    if turn or choice:
        if turn:
            src_meta["turns"] = [t for t in src_meta["turns"] if t["file"] != filename]
        src_meta["updated_at"] = _now()
        _write_meta(project_id, conv_id, src_meta)

        dst_meta = _read_meta(project_id, target_conv_id)
        if turn:
            dst_meta["turns"].append(turn)
        if choice and not turn:
            _put_draft_choice(dst_meta, filename, choice)
        dst_meta["updated_at"] = _now()
        _write_meta(project_id, target_conv_id, dst_meta)

    registry = _read_published()
    token = _find_publish_token(registry, project_id, conv_id, filename)
    if token is not None:
        registry[token]["conv_id"] = target_conv_id
        _write_published(registry)

    _touch_project(project_id)

    stat = dst_path.stat()
    return {
        "filename": filename,
        "role": turn.get("role", "exchange") if turn else "draft",
        "turn_id": turn["id"] if turn else None,
        "content": dst_path.read_text(encoding="utf-8"),
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "publish_token": _published_tokens_by_filename(project_id, target_conv_id).get(filename),
        "publish_slides": filename in _published_slides_filenames(project_id, target_conv_id),
    }


def copy_document(project_id: str, conv_id: str, filename: str, target_conv_id: str) -> dict:
    """Drag-and-drop copy to a different folder in the same project - the
    non-destructive alternative to move_document, for a document (an
    official conversation turn, most importantly) whose *original* is worth
    leaving exactly where it is: still that folder's own turn, still part
    of its LLM history, untouched. The copy always lands as a plain draft
    under a fresh NNNN.md number in the target folder - never a turn itself
    (a turn's id/role/provider/model describe one specific exchange in one
    specific folder's history; duplicating that into a second folder would
    just be a stale-looking clone of it, not a real one), and never
    system.md (every folder already has its own)."""
    _validate_filename(filename)
    if filename == SYSTEM_FILENAME:
        raise PermissionError("Cannot copy the system prompt document")
    if conv_id == target_conv_id:
        raise ValueError("Source and target folder are the same")

    target_meta = _read_meta(project_id, target_conv_id)
    src_path = _conversations_dir(project_id) / conv_id / filename
    if not src_path.exists():
        raise FileNotFoundError(filename)

    target_dir = _conversations_dir(project_id) / target_conv_id
    content = src_path.read_text(encoding="utf-8")
    new_filename = f"{_next_document_index(target_meta, target_dir):04d}.md"
    (target_dir / new_filename).write_text(content, encoding="utf-8")
    _touch_project(project_id)

    stat = (target_dir / new_filename).stat()
    return {
        "filename": new_filename,
        "role": "draft",
        "turn_id": None,
        "content": content,
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


def delete_document(project_id: str, conv_id: str, filename: str) -> None:
    """Deletes a draft or an official conversation turn. `system.md` is the
    only document that can't be deleted (every conversation must have one -
    see _ensure_system_file).

    Deleting an official turn also drops it from `meta["turns"]`, which
    means it stops appearing in this conversation's LLM context (see
    build_history) from that point on - the point of deleting a turn is
    that it's actually gone, not just hidden from the tree.
    """
    _validate_filename(filename)
    if filename == SYSTEM_FILENAME:
        raise PermissionError("Cannot delete the system prompt document")
    path = _conversations_dir(project_id) / conv_id / filename
    if not path.exists():
        raise FileNotFoundError(filename)

    meta = _read_meta(project_id, conv_id)
    turn = next((t for t in meta["turns"] if t["file"] == filename), None)
    choice = _pop_draft_choice(meta, filename)
    if turn or choice:
        # Meta first, then the file: if the file removal below somehow
        # fails, the result is a harmless orphaned file no longer
        # referenced by meta.json, rather than a meta.json entry pointing
        # at a file that no longer exists (which would break
        # get_conversation/build_history for the whole session).
        if turn:
            meta["turns"].remove(turn)
        meta["updated_at"] = _now()
        _write_meta(project_id, conv_id, meta)
    path.unlink()
    _move_analyses(path.parent, filename, None, None)
    unpublish_document(project_id, conv_id, filename)


# ---------- analyses (the preview pane's Evaluate / Formalize tabs) ----------
#
# <conv_dir>/.analysis/<filename>.<kind>.json - the last result of each kind
# for one document, kept beside it so reopening the document shows it again.
# A dot-directory, so list_documents' "*.md" glob never sees it; it follows
# its document through rename/move/delete (_move_analyses). Each result
# records the sha256 of the text it was made from, which is how the client
# tells a result that's gone stale.

ANALYSIS_DIRNAME = ".analysis"
ANALYSIS_KINDS = ("evaluate", "evaluate-logic", "evaluate-writing", "evaluate-live", "formalize")


def _analysis_path(conv_dir: Path, filename: str, kind: str) -> Path:
    if kind not in ANALYSIS_KINDS:
        raise ValueError(f"Unknown analysis kind: {kind!r}")
    return conv_dir / ANALYSIS_DIRNAME / f"{filename}.{kind}.json"


def _move_analyses(src_dir: Path, filename: str, dst_dir: Path | None, new_filename: str | None) -> None:
    """Carries a document's analyses along with it - or, with no `dst_dir`,
    deletes them."""
    for kind in ANALYSIS_KINDS:
        src = _analysis_path(src_dir, filename, kind)
        if not src.exists():
            continue
        if dst_dir is None:
            src.unlink()
            continue
        dst = _analysis_path(dst_dir, new_filename, kind)
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)


def get_analysis(project_id: str, conv_id: str, filename: str, kind: str) -> dict | None:
    _validate_filename(filename)
    conv_dir = _conversations_dir(project_id) / conv_id
    if not (conv_dir / filename).exists():
        raise FileNotFoundError(filename)
    path = _analysis_path(conv_dir, filename, kind)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_analysis(project_id: str, conv_id: str, filename: str, kind: str, result: dict) -> dict:
    _validate_filename(filename)
    conv_dir = _conversations_dir(project_id) / conv_id
    if not (conv_dir / filename).exists():
        raise FileNotFoundError(filename)
    path = _analysis_path(conv_dir, filename, kind)
    path.parent.mkdir(exist_ok=True)
    record = {**result, "kind": kind, "created_at": _now()}
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return record


def delete_analysis(project_id: str, conv_id: str, filename: str, kind: str) -> None:
    _validate_filename(filename)
    conv_dir = _conversations_dir(project_id) / conv_id
    if not (conv_dir / filename).exists():
        raise FileNotFoundError(filename)
    _analysis_path(conv_dir, filename, kind).unlink(missing_ok=True)


# ---------- publishing (public read-only share links) ----------
#
# data/published.json
#   { token: {project_id, conv_id, filename, created_at, slides?} }
#
# `slides` (absent = False) is the publish-time "view as a slideshow" option
# - see set_publish_slides and static/js/public.js's slideshow mode, which
# splits the document into slides at its `---` lines.
#
# A single flat registry (not nested under a project/conversation, unlike
# everything above) because a token is looked up with nothing else known
# about it - see routers/public.py's GET /api/public/{token}, which is the
# only consumer that doesn't already have project_id/conv_id in hand.


def _published_path() -> Path:
    path = Path(settings.data_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path / "published.json"


def _read_published() -> dict:
    path = _published_path()
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _write_published(registry: dict) -> None:
    _published_path().write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")


def _find_publish_token(registry: dict, project_id: str, conv_id: str, filename: str) -> str | None:
    return next(
        (
            token
            for token, entry in registry.items()
            if entry["project_id"] == project_id and entry["conv_id"] == conv_id and entry["filename"] == filename
        ),
        None,
    )


def _published_tokens_by_filename(project_id: str, conv_id: str) -> dict[str, str]:
    return {
        entry["filename"]: token
        for token, entry in _read_published().items()
        if entry["project_id"] == project_id and entry["conv_id"] == conv_id
    }


def _published_slides_filenames(project_id: str, conv_id: str) -> set[str]:
    return {
        entry["filename"]
        for entry in _read_published().values()
        if entry["project_id"] == project_id and entry["conv_id"] == conv_id and entry.get("slides")
    }


def _repoint_publish(project_id: str, conv_id: str, old_filename: str, new_filename: str) -> None:
    """Keeps a document's public link (if any) pointed at it across a
    rename, rather than silently breaking on the next resolve_published."""
    registry = _read_published()
    token = _find_publish_token(registry, project_id, conv_id, old_filename)
    if token is not None:
        registry[token]["filename"] = new_filename
        _write_published(registry)


def publish_document(project_id: str, conv_id: str, filename: str) -> dict:
    """Mints (or reuses) an unguessable public token for `filename`, so it
    can be shared via GET /p/<token> without exposing this app's own
    project/conversation ids in the link - see routers/public.py. Idempotent:
    publishing an already-published document just returns its existing
    token rather than minting a second one, so re-clicking "publish" doesn't
    invalidate a link someone was already given."""
    _validate_filename(filename)
    if filename == SYSTEM_FILENAME:
        raise ValueError("Cannot publish the system prompt document")
    path = _conversations_dir(project_id) / conv_id / filename
    if not path.exists():
        raise FileNotFoundError(filename)

    registry = _read_published()
    token = _find_publish_token(registry, project_id, conv_id, filename)
    if token is None:
        token = uuid.uuid4().hex
        registry[token] = {
            "project_id": project_id,
            "conv_id": conv_id,
            "filename": filename,
            "created_at": _now(),
        }
        _write_published(registry)
    return {"token": token}


def set_publish_slides(project_id: str, conv_id: str, filename: str, slides: bool) -> dict:
    """Turns the slideshow view of an already-published document on or off.
    Kept on the registry entry rather than in the document itself so the
    same share link (not a second one) switches between the two views -
    FileNotFoundError when `filename` isn't published at all."""
    registry = _read_published()
    token = _find_publish_token(registry, project_id, conv_id, filename)
    if token is None:
        raise FileNotFoundError(filename)
    if slides:
        registry[token]["slides"] = True
    else:
        registry[token].pop("slides", None)
    _write_published(registry)
    return {"token": token, "slides": slides}


def unpublish_document(project_id: str, conv_id: str, filename: str) -> None:
    registry = _read_published()
    token = _find_publish_token(registry, project_id, conv_id, filename)
    if token is not None:
        del registry[token]
        _write_published(registry)


def get_document(project_id: str, conv_id: str, filename: str) -> dict:
    """Single-document read - the get_conversation/list_documents counterpart
    for exactly one file, used by resolve_published so a public read doesn't
    need this conversation's whole document list."""
    _validate_filename(filename)
    path = _conversations_dir(project_id) / conv_id / filename
    if not path.exists():
        raise FileNotFoundError(filename)
    stat = path.stat()
    return {
        "filename": filename,
        "content": path.read_text(encoding="utf-8"),
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


_MATH_DIRECTIVE_RE = re.compile(r"^<!--\s*math:\s*(latex|asciimath|hybrid)\s*-->\s*$", re.IGNORECASE)

# An inline thread: the scratch conversation app.js keeps inside a document
# (see its own INLINE_OPEN_RE/INLINE_CLOSE_RE - kept in sync with this
# pattern, including the ": show" spelling an expanded thread carries;
# the same way markdown.js and _MATH_DIRECTIVE_RE above mirror each other).
# Stripped here rather than only hidden client-side, because a published
# page that merely hides it would still carry the whole conversation in the
# response body - which is the opposite of what hiding it is for.
_INLINE_THREAD_RE = re.compile(
    r"^[ \t]*<!--[ \t]*inline[ \t]*(?::[ \t]*show[ \t]*)?-->[ \t]*$"
    r".*?^[ \t]*<!--[ \t]*/inline[ \t]*-->[ \t]*$\n?",
    re.MULTILINE | re.DOTALL,
)


def strip_inline_threads(text: str) -> str:
    """Everything outside the document's inline threads. An unclosed opener
    is left alone rather than swallowing the rest of the document with it -
    a half-typed marker shouldn't blank a published page."""
    return _INLINE_THREAD_RE.sub("", text or "")


def _detect_math_directive(text: str) -> str | None:
    """Python port of markdown.js's detectMathDirective - scans for a
    `<!-- math: latex|asciimath -->` line without stripping it out, "last
    occurrence wins" (kept in sync with markdown.js's DIRECTIVE_RE)."""
    found = None
    for line in (text or "").splitlines():
        m = _MATH_DIRECTIVE_RE.match(line.strip())
        if m:
            found = m.group(1).lower()
    return found


def resolve_math_dialect(project_id: str, conv_id: str) -> str:
    """Python port of app.js's sessionMathDialect - the public page has no
    client-side access to this session's ancestor system prompts to inherit
    a directive from the way the editor does, so it's resolved here instead:
    session system.md, then project system.md, then the global system
    prompt, then "latex"."""
    dialect = _detect_math_directive(get_system_prompt(project_id, conv_id))
    if dialect:
        return dialect
    dialect = _detect_math_directive(get_project_system_prompt(project_id))
    if dialect:
        return dialect
    return _detect_math_directive(get_global_system_prompt()) or "latex"


def resolve_published(token: str) -> dict:
    """Looks up a published token and returns its document's *current*
    content - a publish link stays live against further edits rather than
    freezing a snapshot at publish time, so this always re-reads from disk.
    A token whose document/conversation/project has since been deleted is
    pruned from the registry here rather than left to 404 forever."""
    registry = _read_published()
    entry = registry.get(token)
    if entry is None:
        raise FileNotFoundError(token)
    try:
        doc = get_document(entry["project_id"], entry["conv_id"], entry["filename"])
        dialect = resolve_math_dialect(entry["project_id"], entry["conv_id"])
    except FileNotFoundError:
        del registry[token]
        _write_published(registry)
        raise
    # Inline threads are scratch conversation, not published content - see
    # strip_inline_threads. Dropped here, so the reader's browser never
    # receives them at all (the editor's own preview hides them client-side,
    # which is enough there because that reader is the author).
    return {
        "filename": doc["filename"],
        "content": strip_inline_threads(doc["content"]),
        "dialect": dialect,
        "slides": bool(entry.get("slides")),
        "updated_at": doc["updated_at"],
    }


# A document-link href, exactly as frontend/static/js/markdown.js's
# renderInline / app.js's openInternalDocumentLink produce and parse it: a
# bare filename (same folder as whichever document the link is in), or
# "<convId>/filename.md" (a folder elsewhere in the same project).
_INTERNAL_LINK_RE = re.compile(r"^(?:([0-9a-f]{8,16})/)?([^/\\:]+\.md)$", re.IGNORECASE)


def resolve_published_link(token: str, target: str) -> str | None:
    """The public-page counterpart to app.js's openInternalDocumentLink,
    which can't run there - a published page has no session-tree state to
    resolve a document link against, only the one token it was opened
    with. Given that token and the raw href of a link inside its document,
    resolves `target` (same two shapes as above, always scoped to the
    *same project* as `token`'s own document - never across projects) to
    *its own* publish token, if it has one, without ever exposing this
    app's project/conversation ids to the client. None (not a 404) for a
    target that doesn't parse as an internal link, doesn't exist, or simply
    isn't published itself - none of those are errors, they just mean the
    link isn't clickable from here, the same as it wouldn't be from an
    unpublished project either."""
    registry = _read_published()
    entry = registry.get(token)
    if entry is None:
        raise FileNotFoundError(token)
    m = _INTERNAL_LINK_RE.match(target)
    if not m:
        return None
    target_conv_id = m.group(1) or entry["conv_id"]
    target_filename = m.group(2)
    return _find_publish_token(registry, entry["project_id"], target_conv_id, target_filename)

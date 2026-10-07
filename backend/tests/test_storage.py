from datetime import date, timedelta

import pytest

from app import storage
from app.config import settings
from app.latex_to_asciimath import MATH_DIRECTIVE


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def pid(isolated_data_dir) -> str:
    """A fresh project's id - every conversation now lives inside one."""
    return storage.create_project("테스트 프로젝트")["id"]


def _start(pid: str, conv_id: str, question: str, **overrides) -> dict:
    kwargs = {"provider": "openai", "model": "gpt-test", **overrides}
    return storage.start_exchange(pid, conv_id, question, **kwargs)


def _send_turn(pid: str, conv_id: str, question: str, answer: str, **overrides) -> dict:
    turn = _start(pid, conv_id, question, **overrides)
    return storage.complete_exchange(pid, conv_id, turn["id"], answer)


def test_directive_lands_at_the_true_top_of_the_document(isolated_data_dir, pid):
    # The directive only means anything scanned from the very top of the
    # whole rendered file (see markdown.js's DIRECTIVE_RE). It used to land
    # under "## 어시스턴트" instead, because latex_to_asciimath.py prepended
    # it to just the assistant half before storage.py ever assembled the
    # full "## 사용자 ... ## 어시스턴트 ..." document around it.
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "질문", convert_math=True)
    updated = storage.complete_exchange(
        pid, meta["id"], turn["id"], "$1/2$", directive=MATH_DIRECTIVE
    )

    lines = updated["content"].split("\n")
    assert lines[0] == MATH_DIRECTIVE
    assert lines[1] == storage.EXCHANGE_HEADINGS["en"]["user"]

    on_disk = (
        isolated_data_dir / "projects" / pid / "conversations" / meta["id"] / turn["file"]
    ).read_text()
    assert on_disk == updated["content"]


def test_no_directive_when_not_requested(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "질문", convert_math=False)
    updated = storage.complete_exchange(pid, meta["id"], turn["id"], "\\(x\\)")

    assert MATH_DIRECTIVE not in updated["content"]
    assert updated["content"].split("\n")[0] == storage.EXCHANGE_HEADINGS["en"]["user"]


def test_directive_does_not_break_reparsing_the_turn(isolated_data_dir, pid):
    # A directive-prefixed file must still round-trip correctly through
    # parse_exchange (used both here, to recover user_content on a second
    # complete_exchange call, and by build_history for LLM context).
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "질문 내용", convert_math=True)
    storage.complete_exchange(pid, meta["id"], turn["id"], "$1/2$", directive=MATH_DIRECTIVE)

    conv = storage.get_conversation(pid, meta["id"])
    history = storage.build_history(conv)
    assert history == [
        {"role": "user", "content": "질문 내용"},
        {"role": "assistant", "content": "$1/2$"},
    ]


def test_deleting_a_turn_removes_it_from_meta_and_history(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn1 = _send_turn(pid, meta["id"], "Q1", "A1")
    _send_turn(pid, meta["id"], "Q2", "A2")

    storage.delete_document(pid, meta["id"], turn1["file"])

    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == ["0002.md"]
    assert storage.build_history(conv) == [
        {"role": "user", "content": "Q2"},
        {"role": "assistant", "content": "A2"},
    ]
    conv_dir = isolated_data_dir / "projects" / pid / "conversations" / meta["id"]
    assert not (conv_dir / turn1["file"]).exists()


def test_deleting_a_turn_does_not_collide_with_a_later_turns_number(isolated_data_dir, pid):
    # This is the whole reason turn deletion was blocked in the first
    # place: file numbering used to be `len(turns) + 1`, so deleting turn 1
    # of a 2-turn conversation dropped the count back to 1, and the *next*
    # new turn would also compute index 2 - colliding with (and silently
    # overwriting) the "0002.md" that was never deleted.
    meta = storage.create_conversation(pid)
    turn1 = _send_turn(pid, meta["id"], "Q1", "A1")
    _send_turn(pid, meta["id"], "Q2", "A2")
    storage.delete_document(pid, meta["id"], turn1["file"])

    turn3 = _send_turn(pid, meta["id"], "Q3", "A3")

    assert turn3["file"] == "0003.md"
    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == ["0002.md", "0003.md"]
    assert storage.build_history(conv) == [
        {"role": "user", "content": "Q2"},
        {"role": "assistant", "content": "A2"},
        {"role": "user", "content": "Q3"},
        {"role": "assistant", "content": "A3"},
    ]


def test_system_prompt_cannot_be_deleted(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    with pytest.raises(PermissionError):
        storage.delete_document(pid, meta["id"], storage.SYSTEM_FILENAME)


def test_deleting_a_draft_does_not_touch_turns(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    _send_turn(pid, meta["id"], "Q1", "A1")
    draft = storage.create_draft(pid, meta["id"])

    storage.delete_document(pid, meta["id"], draft["filename"])

    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == ["0001.md"]


def test_sending_from_a_draft_grows_it_into_the_turn_instead_of_a_new_file(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    draft = storage.create_draft(pid, meta["id"])
    assert draft["filename"] == "0001.md"  # numbered like any other document, not draft-<uuid>.md

    turn = _start(pid, meta["id"], "질문", draft_filename=draft["filename"])

    # Same file, in place - never deleted and recreated under some other
    # name. Whatever document was open when "send" was clicked is exactly
    # the one that ends up holding the reply.
    assert turn["file"] == draft["filename"] == "0001.md"

    conv = storage.get_conversation(pid, meta["id"])
    assert [d["filename"] for d in storage.list_documents(pid, meta["id"]) if d["role"] == "draft"] == []
    assert [t["file"] for t in conv["turns"]] == ["0001.md"]


def test_two_drafts_created_before_either_is_sent_get_distinct_numbers(isolated_data_dir, pid):
    # Neither draft is in meta["turns"] yet, so numbering them has to look at
    # the files already on disk too - otherwise both would compute the same
    # next index and the second would silently overwrite the first.
    meta = storage.create_conversation(pid)
    draft1 = storage.create_draft(pid, meta["id"])
    draft2 = storage.create_draft(pid, meta["id"])
    assert draft1["filename"] != draft2["filename"]
    assert {draft1["filename"], draft2["filename"]} == {"0001.md", "0002.md"}

    # Sending the second draft doesn't renumber it down to "the next turn" -
    # it keeps the number it already had.
    turn = _start(pid, meta["id"], "질문", draft_filename=draft2["filename"])
    assert turn["file"] == draft2["filename"] == "0002.md"

    # The still-unsent first draft is untouched and keeps its own number.
    docs = storage.list_documents(pid, meta["id"])
    assert next(d for d in docs if d["filename"] == draft1["filename"])["role"] == "draft"


class TestDailyLogDraftNaming:
    """A folder used as a daily log - every document named "YYYY-MM-DD.md" -
    has create_draft continue that sequence with tomorrow's date instead of
    the usual NNNN.md numbering (see storage._next_draft_filename)."""

    def test_continues_from_the_last_dated_document(self, isolated_data_dir, pid):
        conv = storage.create_conversation(pid)
        storage.save_document(pid, conv["id"], storage.create_draft(pid, conv["id"])["filename"], "")
        # Rename the fresh 0001.md draft into today's dated entry by hand -
        # simplest way to get a folder into "every document is dated" shape
        # without needing a real date-named turn.
        today = date(2026, 1, 5)
        today_name = f"{today:%Y-%m-%d}.md"
        storage.rename_document(pid, conv["id"], "0001.md", today_name)

        draft = storage.create_draft(pid, conv["id"])

        assert draft["filename"] == f"{today + timedelta(days=1):%Y-%m-%d}.md"

    def test_ignores_a_folder_not_yet_all_dated_documents(self, isolated_data_dir, pid):
        conv = storage.create_conversation(pid)
        draft = storage.create_draft(pid, conv["id"])
        assert draft["filename"] == "0001.md"

    def test_only_looks_at_the_last_filename_not_every_dated_one(self, isolated_data_dir, pid):
        conv = storage.create_conversation(pid)
        earlier = date(2026, 1, 1)
        later = date(2026, 1, 10)
        for d in (earlier, later):
            filename = storage.create_draft(pid, conv["id"])["filename"]
            storage.save_document(pid, conv["id"], filename, "")
            storage.rename_document(pid, conv["id"], filename, f"{d:%Y-%m-%d}.md")

        draft = storage.create_draft(pid, conv["id"])

        assert draft["filename"] == f"{later + timedelta(days=1):%Y-%m-%d}.md"

    def test_a_dated_filename_does_not_pollute_plain_numbering_in_the_same_folder(self, isolated_data_dir, pid):
        # A dated file's leading digits (its year) must never be mistaken
        # for an NNNN index - see _LEADING_DIGITS_RE's lookahead. Renaming
        # the dated file away first (rather than just having it exist
        # alongside an NNNN.md draft) is what actually exercises this: a
        # folder whose *last* file is date-shaped but everything else is
        # still plain-numbered.
        conv = storage.create_conversation(pid)
        dated = storage.create_draft(pid, conv["id"])["filename"]
        storage.rename_document(pid, conv["id"], dated, "2026-09-11.md")
        turn = _start(pid, conv["id"], "질문")
        assert turn["file"] == "0001.md"


def test_reverting_a_turn_to_draft_keeps_the_file_but_drops_it_from_history(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn1 = _send_turn(pid, meta["id"], "Q1", "A1")
    _send_turn(pid, meta["id"], "Q2", "A2")

    reverted = storage.revert_turn_to_draft(pid, meta["id"], turn1["file"])
    assert reverted == {
        "filename": turn1["file"],
        "role": "draft",
        "turn_id": None,
        "content": turn1["content"],
        "updated_at": reverted["updated_at"],
    }

    # Same file, same content, still sitting right there - just no longer a
    # turn: list_documents shows it as a draft, and it's gone from the
    # LLM-history-producing turns list, but the file itself was never
    # touched on disk.
    docs = storage.list_documents(pid, meta["id"])
    doc = next(d for d in docs if d["filename"] == turn1["file"])
    assert doc["role"] == "draft"
    assert doc["content"] == turn1["content"]

    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == ["0002.md"]
    assert storage.build_history(conv) == [
        {"role": "user", "content": "Q2"},
        {"role": "assistant", "content": "A2"},
    ]


def test_a_reverted_draft_can_be_sent_again_like_any_other_draft(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn1 = _send_turn(pid, meta["id"], "Q1", "A1")
    storage.revert_turn_to_draft(pid, meta["id"], turn1["file"])

    turn_again = _start(pid, meta["id"], "완전히 새로 쓴 질문", draft_filename=turn1["file"])
    assert turn_again["file"] == turn1["file"]
    assert turn_again["content"] == "## User\n\n완전히 새로 쓴 질문\n"


def test_reverting_a_draft_or_missing_file_raises(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    draft = storage.create_draft(pid, meta["id"])
    with pytest.raises(ValueError):
        storage.revert_turn_to_draft(pid, meta["id"], draft["filename"])
    with pytest.raises(ValueError):
        storage.revert_turn_to_draft(pid, meta["id"], "0099.md")


def test_sending_from_a_missing_draft_raises(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    with pytest.raises(FileNotFoundError):
        _start(pid, meta["id"], "질문", draft_filename="draft-nope.md")


def test_sending_with_draft_filename_of_an_existing_turn_raises(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "Q1")
    storage.complete_exchange(pid, meta["id"], turn["id"], "A1")
    with pytest.raises(ValueError):
        _start(pid, meta["id"], "Q2", draft_filename=turn["file"])


def test_retrying_a_failed_turn_completes_it_in_place(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "질문")  # provider errored before complete_exchange ran

    retried = storage.retry_exchange(
        pid, meta["id"], turn["id"], "## 사용자\n\n질문",
        provider="openai", model="gpt-test",
    )
    assert retried["file"] == turn["file"]
    assert retried["id"] == turn["id"]

    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == [turn["file"]]  # no new turn appended

    completed = storage.complete_exchange(pid, meta["id"], turn["id"], "답변")
    assert completed["file"] == turn["file"]
    assert storage.parse_exchange(completed["content"]) == [
        {"role": "user", "content": "질문"},
        {"role": "assistant", "content": "답변"},
    ]


def test_retrying_honors_an_edited_question(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "원래 질문")

    retried = storage.retry_exchange(
        pid, meta["id"], turn["id"], "## 사용자\n\n수정된 질문",
        provider="openai", model="gpt-test",
    )
    assert storage.parse_exchange(retried["content"]) == [{"role": "user", "content": "수정된 질문"}]


def test_retrying_a_completed_turn_raises(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _send_turn(pid, meta["id"], "Q1", "A1")
    with pytest.raises(ValueError):
        storage.retry_exchange(
            pid, meta["id"], turn["id"], "## 사용자\n\nQ1\n\n## 어시스턴트\n\nA1",
            provider="openai", model="gpt-test",
        )


def test_retrying_a_missing_turn_raises(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    with pytest.raises(FileNotFoundError):
        storage.retry_exchange(
            pid, meta["id"], "nope", "## 사용자\n\nQ",
            provider="openai", model="gpt-test",
        )


def test_start_exchange_uses_the_given_language(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "hello", language="ja")
    assert turn["content"].splitlines()[0] == storage.EXCHANGE_HEADINGS["ja"]["user"]


def test_start_exchange_defaults_to_english(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "hello")
    assert turn["content"].splitlines()[0] == storage.EXCHANGE_HEADINGS["en"]["user"]


def test_complete_exchange_uses_the_given_language(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _start(pid, meta["id"], "hello")
    completed = storage.complete_exchange(pid, meta["id"], turn["id"], "hi", language="ko")
    lines = completed["content"].split("\n")
    assert lines[0] == storage.EXCHANGE_HEADINGS["en"]["user"]  # unchanged from start_exchange
    assert storage.EXCHANGE_HEADINGS["ko"]["assistant"] in lines


def test_continuing_a_completed_turn_appends_a_new_round_to_the_same_file(isolated_data_dir, pid):
    # The new capability retry_exchange now also covers: a turn that already
    # has one or more full rounds gets a new trailing "## User" question
    # completed in place, instead of always spawning a fresh NNNN.md.
    meta = storage.create_conversation(pid)
    turn = _send_turn(pid, meta["id"], "Q1", "A1")

    raw = turn["content"] + "\n" + storage.EXCHANGE_HEADINGS["en"]["user"] + "\n\nQ2"
    continued = storage.retry_exchange(
        pid, meta["id"], turn["id"], raw, provider="openai", model="gpt-test",
    )
    assert continued["file"] == turn["file"]
    assert continued["question"] == "Q2"
    # The first round survives byte-for-byte - not re-derived/re-serialized.
    assert continued["content"].startswith(turn["content"])

    conv = storage.get_conversation(pid, meta["id"])
    assert [t["file"] for t in conv["turns"]] == [turn["file"]]  # still one turn/file

    completed = storage.complete_exchange(pid, meta["id"], turn["id"], "A2")
    assert storage.parse_exchange(completed["content"]) == [
        {"role": "user", "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user", "content": "Q2"},
        {"role": "assistant", "content": "A2"},
    ]


def test_continuing_preserves_earlier_rounds_language_while_new_one_uses_current(isolated_data_dir, pid):
    meta = storage.create_conversation(pid)
    turn = _send_turn(pid, meta["id"], "Q1", "A1", language="ko")

    raw = turn["content"] + "\n" + storage.EXCHANGE_HEADINGS["ja"]["user"] + "\n\nQ2"
    continued = storage.retry_exchange(
        pid, meta["id"], turn["id"], raw, provider="openai", model="gpt-test", language="ja",
    )
    assert storage.EXCHANGE_HEADINGS["ko"]["user"] in continued["content"]  # round 1, untouched
    assert storage.EXCHANGE_HEADINGS["ja"]["user"] in continued["content"]  # round 2, renormalized
    assert storage.parse_exchange(continued["content"]) == [
        {"role": "user", "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user", "content": "Q2"},
    ]


class TestPerTurnSettings:
    """provider/model/reasoning_effort/convert_math are chosen per turn, not
    fixed for the whole session (that used to be the case - a session's
    settings were locked in at creation and couldn't change)."""

    def test_new_conversation_has_no_settings_yet(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid, "제목")
        assert meta["provider"] is None
        assert meta["model"] is None
        assert meta["reasoning_effort"] is None
        assert meta["convert_math"] is False

    def test_turn_records_its_own_settings(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        turn = _start(
            pid, meta["id"], "Q1", provider="anthropic", model="claude-x",
            reasoning_effort="high", convert_math=True,
        )
        conv = storage.get_conversation(pid, meta["id"])
        stored = conv["turns"][0]
        assert stored["provider"] == "anthropic"
        assert stored["model"] == "claude-x"
        assert stored["reasoning_effort"] == "high"
        assert stored["convert_math"] is True
        assert turn["provider"] == "anthropic"

    def test_different_turns_can_use_different_settings(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        _send_turn(pid, meta["id"], "Q1", "A1", provider="openai", model="gpt-a")
        _send_turn(pid, meta["id"], "Q2", "A2", provider="anthropic", model="claude-b")

        conv = storage.get_conversation(pid, meta["id"])
        assert [t["provider"] for t in conv["turns"]] == ["openai", "anthropic"]
        assert [t["model"] for t in conv["turns"]] == ["gpt-a", "claude-b"]

    def test_session_level_fields_track_most_recently_used(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        _start(pid, meta["id"], "Q1", provider="openai", model="gpt-a", reasoning_effort="low")
        second = storage.get_conversation(pid, meta["id"])
        assert second["provider"] == "openai" and second["model"] == "gpt-a"

        _start(pid, meta["id"], "Q2", provider="anthropic", model="claude-b", reasoning_effort="high")
        third = storage.get_conversation(pid, meta["id"])
        assert third["provider"] == "anthropic"
        assert third["model"] == "claude-b"
        assert third["reasoning_effort"] == "high"


class TestProjects:
    def test_create_list_rename(self, isolated_data_dir):
        p = storage.create_project("첫 프로젝트")
        assert p["title"] == "첫 프로젝트"

        listed = storage.list_projects()
        assert [x["id"] for x in listed] == [p["id"]]

        renamed = storage.rename_project(p["id"], "새 이름")
        assert renamed["title"] == "새 이름"
        assert storage.list_projects()[0]["title"] == "새 이름"

    def test_conversations_are_scoped_to_their_project(self, isolated_data_dir):
        p1 = storage.create_project("P1")
        p2 = storage.create_project("P2")
        c1 = storage.create_conversation(p1["id"], "C1")
        storage.create_conversation(p2["id"], "C2")

        assert [c["id"] for c in storage.list_conversations(p1["id"])] == [c1["id"]]
        assert len(storage.list_conversations(p2["id"])) == 1

        with pytest.raises(FileNotFoundError):
            # c1 belongs to p1, not p2 - looking it up under the wrong
            # project must not silently find it via some shared namespace.
            storage.get_conversation(p2["id"], c1["id"])

    def test_deleting_a_project_deletes_its_conversations(self, isolated_data_dir):
        p = storage.create_project("삭제될 프로젝트")
        c = storage.create_conversation(p["id"])

        storage.delete_project(p["id"])

        with pytest.raises(FileNotFoundError):
            storage.get_project(p["id"])
        with pytest.raises(FileNotFoundError):
            storage.list_conversations(p["id"])
        assert not (isolated_data_dir / "projects" / p["id"]).exists()
        assert c  # sanity: it did exist before deletion

    def test_session_activity_bumps_the_projects_updated_at(self, isolated_data_dir):
        # updated_at itself still tracks real activity (a new session, a new
        # turn), not just renaming the project - list_projects() no longer
        # sorts by it (see test_project_order_is_fixed_by_creation_date_
        # regardless_of_activity below), but it's still meaningful metadata.
        p1 = storage.create_project("P1")

        conv = storage.create_conversation(p1["id"])
        after_create = storage.get_project(p1["id"])
        assert after_create["updated_at"] > p1["updated_at"]

        storage.start_exchange(p1["id"], conv["id"], "Q", provider="openai", model="m")
        after_turn = storage.get_project(p1["id"])
        assert after_turn["updated_at"] >= after_create["updated_at"]

    def test_project_order_is_fixed_by_creation_date_regardless_of_activity(self, isolated_data_dir):
        # Sorting by most-recently-active used to mean sending one message
        # anywhere inside a project bounced it to the top of every other
        # project - the whole sidebar reordering itself mid-session. Order
        # must now depend only on created_at, immune to activity in any of
        # them.
        p1 = storage.create_project("P1")
        p2 = storage.create_project("P2")
        p3 = storage.create_project("P3")

        # Heavy activity in the *oldest* project - must not move it.
        conv = storage.create_conversation(p1["id"])
        turn = storage.start_exchange(p1["id"], conv["id"], "Q", provider="openai", model="m")
        storage.complete_exchange(p1["id"], conv["id"], turn["id"], "A")
        storage.rename_project(p1["id"], "P1 renamed")

        assert [p["id"] for p in storage.list_projects()] == [p3["id"], p2["id"], p1["id"]]

    def test_project_system_prompt_round_trips(self, isolated_data_dir):
        p = storage.create_project()
        assert storage.get_project_system_prompt(p["id"]) == ""
        storage.save_project_system_prompt(p["id"], "이 프로젝트의 공통 지시문")
        assert storage.get_project_system_prompt(p["id"]) == "이 프로젝트의 공통 지시문"

    def test_system_prompt_hierarchy_is_global_project_session(self, isolated_data_dir, pid):
        # Exercises the actual join the router does, not just each piece in
        # isolation - global, project, and session prompts must all survive
        # into one combined string, in that order.
        storage.save_global_system_prompt("전역 지시")
        storage.save_project_system_prompt(pid, "프로젝트 지시")
        meta = storage.create_conversation(pid)
        conv_dir = isolated_data_dir / "projects" / pid / "conversations" / meta["id"]
        (conv_dir / storage.SYSTEM_FILENAME).write_text("세션 지시", encoding="utf-8")

        global_prompt = storage.get_global_system_prompt().strip()
        project_prompt = storage.get_project_system_prompt(pid).strip()
        session_prompt = storage.get_system_prompt(pid, meta["id"])
        combined = "\n\n".join(p for p in (global_prompt, project_prompt, session_prompt) if p)

        assert combined == "전역 지시\n\n프로젝트 지시\n\n세션 지시"


class TestFolderNesting:
    """Sessions as nestable folders - a folder can point at another one in
    the same project via parent_id (create_conversation), purely for
    organization: LLM history/turns stay scoped to each folder exactly as
    before (see build_history/start_exchange/retry_exchange, untouched by
    this), only the system-prompt cascade and deletion follow the chain."""

    def test_creating_a_subfolder_records_its_parent(self, isolated_data_dir, pid):
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        assert child["parent_id"] == parent["id"]

        listed = {c["id"]: c for c in storage.list_conversations(pid)}
        assert listed[parent["id"]]["parent_id"] is None
        assert listed[child["id"]]["parent_id"] == parent["id"]

    def test_creating_a_subfolder_under_a_missing_parent_raises(self, isolated_data_dir, pid):
        with pytest.raises(FileNotFoundError):
            storage.create_conversation(pid, "Child", parent_id="nope")

    def test_system_prompt_chain_walks_every_ancestor_root_first(self, isolated_data_dir, pid):
        grandparent = storage.create_conversation(pid, "GP")
        parent = storage.create_conversation(pid, "P", parent_id=grandparent["id"])
        child = storage.create_conversation(pid, "C", parent_id=parent["id"])

        def write_own_system(conv_id, text):
            path = isolated_data_dir / "projects" / pid / "conversations" / conv_id / storage.SYSTEM_FILENAME
            path.write_text(text, encoding="utf-8")

        write_own_system(grandparent["id"], "조부모 지시")
        write_own_system(parent["id"], "부모 지시")
        write_own_system(child["id"], "자식 지시")

        assert storage.get_system_prompt_chain(pid, child["id"]) == ["조부모 지시", "부모 지시", "자식 지시"]
        # A folder with no parent is just a one-element chain of itself -
        # same shape get_system_prompt(pid, conv_id) already returned alone.
        assert storage.get_system_prompt_chain(pid, grandparent["id"]) == ["조부모 지시"]

    def test_deleting_a_folder_cascades_to_its_subfolders(self, isolated_data_dir, pid):
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        grandchild = storage.create_conversation(pid, "Grandchild", parent_id=child["id"])
        sibling = storage.create_conversation(pid, "Unrelated")  # must survive

        storage.delete_conversation(pid, parent["id"])

        remaining = {c["id"] for c in storage.list_conversations(pid)}
        assert remaining == {sibling["id"]}
        conv_dir = isolated_data_dir / "projects" / pid / "conversations"
        assert not (conv_dir / parent["id"]).exists()
        assert not (conv_dir / child["id"]).exists()
        assert not (conv_dir / grandchild["id"]).exists()
        assert (conv_dir / sibling["id"]).exists()

    def test_moving_a_folder_updates_its_parent_id(self, isolated_data_dir, pid):
        a = storage.create_conversation(pid, "A")
        b = storage.create_conversation(pid, "B")
        storage.move_conversation(pid, b["id"], a["id"])
        assert storage.get_conversation(pid, b["id"])["parent_id"] == a["id"]

    def test_moving_a_folder_to_the_top_level_clears_parent_id(self, isolated_data_dir, pid):
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        storage.move_conversation(pid, child["id"], None)
        assert storage.get_conversation(pid, child["id"])["parent_id"] is None

    def test_moving_a_folder_into_itself_raises(self, isolated_data_dir, pid):
        a = storage.create_conversation(pid, "A")
        with pytest.raises(ValueError):
            storage.move_conversation(pid, a["id"], a["id"])

    def test_moving_a_folder_into_its_own_descendant_raises(self, isolated_data_dir, pid):
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        grandchild = storage.create_conversation(pid, "Grandchild", parent_id=child["id"])
        with pytest.raises(ValueError):
            storage.move_conversation(pid, parent["id"], grandchild["id"])
        # Untouched by the rejected move.
        assert storage.get_conversation(pid, parent["id"])["parent_id"] is None

    def test_moving_a_folder_into_a_missing_parent_raises(self, isolated_data_dir, pid):
        a = storage.create_conversation(pid, "A")
        with pytest.raises(FileNotFoundError):
            storage.move_conversation(pid, a["id"], "nope")


class TestMoveDocument:
    """Drag-and-drop moving a document to a different folder in the same
    project - files never nest, so this is the one place a document's own
    conv_id actually changes rather than just its filename."""

    def test_moving_a_draft_relocates_the_file_and_keeps_its_content(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        draft = storage.create_draft(pid, source["id"])
        storage.save_document(pid, source["id"], draft["filename"], "초안 내용")

        moved = storage.move_document(pid, source["id"], draft["filename"], target["id"])

        assert moved["content"] == "초안 내용"
        assert moved["role"] == "draft"
        source_files = {d["filename"] for d in storage.list_documents(pid, source["id"])}
        target_files = {d["filename"] for d in storage.list_documents(pid, target["id"])}
        assert draft["filename"] not in source_files
        assert draft["filename"] in target_files

    def test_moving_a_turn_keeps_its_turn_metadata_in_the_target_folder(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        turn = _send_turn(pid, source["id"], "질문", "대답")

        moved = storage.move_document(pid, source["id"], turn["file"], target["id"])

        assert moved["role"] == "exchange"
        assert moved["turn_id"] == turn["id"]
        assert not any(t["file"] == turn["file"] for t in storage.get_conversation(pid, source["id"])["turns"])
        assert any(t["file"] == turn["file"] for t in storage.get_conversation(pid, target["id"])["turns"])

    def test_moving_the_system_prompt_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        with pytest.raises(PermissionError):
            storage.move_document(pid, source["id"], storage.SYSTEM_FILENAME, target["id"])

    def test_moving_to_the_same_folder_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        draft = storage.create_draft(pid, source["id"])
        with pytest.raises(ValueError):
            storage.move_document(pid, source["id"], draft["filename"], source["id"])

    def test_moving_onto_an_existing_filename_in_the_target_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        draft = storage.create_draft(pid, source["id"])
        # Force a name collision in the target folder.
        (isolated_data_dir / "projects" / pid / "conversations" / target["id"] / draft["filename"]).write_text(
            "", encoding="utf-8"
        )
        with pytest.raises(ValueError):
            storage.move_document(pid, source["id"], draft["filename"], target["id"])

    def test_moving_to_a_missing_target_folder_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        draft = storage.create_draft(pid, source["id"])
        with pytest.raises(FileNotFoundError):
            storage.move_document(pid, source["id"], draft["filename"], "nope")


class TestCopyDocument:
    """Drag-and-drop copying a document to a different folder - the
    non-destructive sibling of TestMoveDocument, used for a turn whose
    original is worth leaving exactly where it is (see copy_document's own
    docstring). Always lands as a plain draft under a fresh number, never a
    turn itself, regardless of what the original was."""

    def test_copying_a_draft_leaves_the_original_and_adds_a_new_draft(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        draft = storage.create_draft(pid, source["id"])
        storage.save_document(pid, source["id"], draft["filename"], "초안 내용")

        copied = storage.copy_document(pid, source["id"], draft["filename"], target["id"])

        assert copied["content"] == "초안 내용"
        assert copied["role"] == "draft"
        assert copied["turn_id"] is None
        source_files = {d["filename"] for d in storage.list_documents(pid, source["id"])}
        target_files = {d["filename"] for d in storage.list_documents(pid, target["id"])}
        assert draft["filename"] in source_files  # untouched
        assert copied["filename"] in target_files

    def test_copying_a_turn_lands_as_a_draft_and_leaves_the_turn_intact(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        turn = _send_turn(pid, source["id"], "질문", "대답")

        copied = storage.copy_document(pid, source["id"], turn["file"], target["id"])

        assert copied["role"] == "draft"
        assert copied["turn_id"] is None
        assert copied["content"] == storage.get_document(pid, source["id"], turn["file"])["content"]
        # The original turn is still registered in its own folder, untouched.
        assert any(t["file"] == turn["file"] for t in storage.get_conversation(pid, source["id"])["turns"])
        assert not any(t["file"] == copied["filename"] for t in storage.get_conversation(pid, target["id"])["turns"])

    def test_copying_the_system_prompt_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        target = storage.create_conversation(pid, "Target")
        with pytest.raises(PermissionError):
            storage.copy_document(pid, source["id"], storage.SYSTEM_FILENAME, target["id"])

    def test_copying_to_the_same_folder_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        draft = storage.create_draft(pid, source["id"])
        with pytest.raises(ValueError):
            storage.copy_document(pid, source["id"], draft["filename"], source["id"])

    def test_copying_to_a_missing_target_folder_raises(self, isolated_data_dir, pid):
        source = storage.create_conversation(pid, "Source")
        draft = storage.create_draft(pid, source["id"])
        with pytest.raises(FileNotFoundError):
            storage.copy_document(pid, source["id"], draft["filename"], "nope")


class TestContextScope:
    """build_history_for_turn's three scopes (storage.CONTEXT_SCOPES) -
    how far outside a turn's own file the LLM context sent alongside it
    reaches. "default" and "sibling" don't need folder nesting at all;
    "descendants" is the one scope that actually depends on it."""

    def test_default_scope_is_just_this_turns_own_content(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        other = _send_turn(pid, meta["id"], "다른 턴 질문", "다른 턴 답변")
        mine = _send_turn(pid, meta["id"], "내 턴 질문", "내 턴 답변")

        history = storage.build_history_for_turn(pid, meta["id"], mine["id"], scope="default")
        assert history == [
            {"role": "user", "content": "내 턴 질문"},
            {"role": "assistant", "content": "내 턴 답변"},
        ]
        assert other  # sanity: the other turn really exists and is excluded above

    def test_sibling_scope_matches_build_history(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        _send_turn(pid, meta["id"], "Q1", "A1")
        mine = _send_turn(pid, meta["id"], "Q2", "A2")

        via_scope = storage.build_history_for_turn(pid, meta["id"], mine["id"], scope="sibling")
        via_build_history = storage.build_history(storage.get_conversation(pid, meta["id"]))
        assert via_scope == via_build_history == [
            {"role": "user", "content": "Q1"},
            {"role": "assistant", "content": "A1"},
            {"role": "user", "content": "Q2"},
            {"role": "assistant", "content": "A2"},
        ]

    def test_descendants_scope_spans_nested_folders_sorted_by_created_at(self, isolated_data_dir, pid):
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        unrelated = storage.create_conversation(pid, "Unrelated")  # must NOT be included

        t1 = _send_turn(pid, parent["id"], "부모 질문", "부모 답변")
        t2 = _send_turn(pid, child["id"], "자식 질문", "자식 답변")
        _send_turn(pid, unrelated["id"], "무관한 질문", "무관한 답변")

        history = storage.build_history_for_turn(pid, parent["id"], t1["id"], scope="descendants")
        assert history == [
            {"role": "user", "content": "부모 질문"},
            {"role": "assistant", "content": "부모 답변"},
            {"role": "user", "content": "자식 질문"},
            {"role": "assistant", "content": "자식 답변"},
        ]
        assert t2  # sanity: the child turn really exists

    def test_default_scope_excludes_pending_tail_only_for_the_turn_being_completed(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        turn = _start(pid, meta["id"], "질문")  # pending - no reply yet

        history = storage.build_history_for_turn(
            pid, meta["id"], turn["id"], scope="default", exclude_pending_tail_of=turn["id"]
        )
        assert history == []  # the only content is the pending question itself, excluded


class TestLegacyMigration:
    """Before projects existed, every session lived directly under
    data/conversations/. list_projects() must transparently fold that into
    a "기본 프로젝트" the first time it's called against an old data
    directory, without touching anything already on disk beyond moving it."""

    def test_legacy_conversations_directory_is_migrated(self, isolated_data_dir):
        legacy_dir = isolated_data_dir / "conversations" / "abc123"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "meta.json").write_text(
            '{"id": "abc123", "title": "옛날 세션", "provider": "openai", '
            '"model": "gpt-x", "reasoning_effort": null, "convert_math": false, '
            '"created_at": "2020-01-01T00:00:00+00:00", '
            '"updated_at": "2020-01-01T00:00:00+00:00", "turns": []}',
            encoding="utf-8",
        )
        (legacy_dir / storage.SYSTEM_FILENAME).write_text("", encoding="utf-8")

        projects = storage.list_projects()

        assert len(projects) == 1
        assert projects[0]["id"] == storage.DEFAULT_PROJECT_ID
        assert projects[0]["title"] == storage.DEFAULT_PROJECT_TITLE
        assert not (isolated_data_dir / "conversations").exists()

        migrated = storage.list_conversations(storage.DEFAULT_PROJECT_ID)
        assert [c["title"] for c in migrated] == ["옛날 세션"]

    def test_migration_is_idempotent(self, isolated_data_dir):
        legacy_dir = isolated_data_dir / "conversations" / "abc123"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "meta.json").write_text(
            '{"id": "abc123", "title": "T", "provider": null, "model": null, '
            '"reasoning_effort": null, "convert_math": false, '
            '"created_at": "2020-01-01T00:00:00+00:00", '
            '"updated_at": "2020-01-01T00:00:00+00:00", "turns": []}',
            encoding="utf-8",
        )

        storage.list_projects()
        storage.list_projects()  # must not raise the second time around

        assert len(storage.list_conversations(storage.DEFAULT_PROJECT_ID)) == 1

    def test_no_legacy_directory_means_no_default_project(self, isolated_data_dir):
        assert storage.list_projects() == []


class TestPublishing:
    def test_publishing_a_draft_returns_a_token_resolvable_via_the_registry(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])
        storage.save_document(pid, meta["id"], draft["filename"], "안녕하세요")

        result = storage.publish_document(pid, meta["id"], draft["filename"])
        resolved = storage.resolve_published(result["token"])

        assert resolved["filename"] == draft["filename"]
        assert resolved["content"] == "안녕하세요"
        assert resolved["dialect"] == "latex"

    def test_publishing_twice_reuses_the_same_token(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])

        first = storage.publish_document(pid, meta["id"], draft["filename"])
        second = storage.publish_document(pid, meta["id"], draft["filename"])

        assert first["token"] == second["token"]

    def test_publish_reflects_edits_made_after_publishing(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])
        token = storage.publish_document(pid, meta["id"], draft["filename"])["token"]

        storage.save_document(pid, meta["id"], draft["filename"], "수정된 내용")

        assert storage.resolve_published(token)["content"] == "수정된 내용"

    def test_unpublish_invalidates_the_token(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])
        token = storage.publish_document(pid, meta["id"], draft["filename"])["token"]

        storage.unpublish_document(pid, meta["id"], draft["filename"])

        with pytest.raises(FileNotFoundError):
            storage.resolve_published(token)

    def test_publishing_the_system_prompt_raises(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        with pytest.raises(ValueError):
            storage.publish_document(pid, meta["id"], storage.SYSTEM_FILENAME)

    def test_publishing_a_missing_document_raises(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        with pytest.raises(FileNotFoundError):
            storage.publish_document(pid, meta["id"], "nope.md")

    def test_renaming_a_published_document_keeps_its_link_live(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])
        token = storage.publish_document(pid, meta["id"], draft["filename"])["token"]

        storage.rename_document(pid, meta["id"], draft["filename"], "새이름.md")

        resolved = storage.resolve_published(token)
        assert resolved["filename"] == "새이름.md"

    def test_deleting_a_published_document_invalidates_its_link(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])
        token = storage.publish_document(pid, meta["id"], draft["filename"])["token"]

        storage.delete_document(pid, meta["id"], draft["filename"])

        with pytest.raises(FileNotFoundError):
            storage.resolve_published(token)

    def test_resolving_an_unknown_token_raises(self, isolated_data_dir):
        with pytest.raises(FileNotFoundError):
            storage.resolve_published("no-such-token")

    def test_list_documents_reports_publish_token(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        draft = storage.create_draft(pid, meta["id"])

        docs = storage.list_documents(pid, meta["id"])
        assert next(d for d in docs if d["filename"] == draft["filename"])["publish_token"] is None

        token = storage.publish_document(pid, meta["id"], draft["filename"])["token"]
        docs = storage.list_documents(pid, meta["id"])
        assert next(d for d in docs if d["filename"] == draft["filename"])["publish_token"] == token

    def test_resolve_math_dialect_inherits_session_then_project_then_global(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        storage.save_global_system_prompt("<!-- math: asciimath -->")
        assert storage.resolve_math_dialect(pid, meta["id"]) == "asciimath"

        storage.save_project_system_prompt(pid, "<!-- math: latex -->")
        assert storage.resolve_math_dialect(pid, meta["id"]) == "latex"

        session_dir = storage._conversations_dir(pid) / meta["id"]
        (session_dir / storage.SYSTEM_FILENAME).write_text("<!-- math: asciimath -->", encoding="utf-8")
        assert storage.resolve_math_dialect(pid, meta["id"]) == "asciimath"

    def test_resolve_math_dialect_defaults_to_latex(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        assert storage.resolve_math_dialect(pid, meta["id"]) == "latex"


class TestPublishedLinks:
    """resolve_published_link - the public-page counterpart to app.js's
    openInternalDocumentLink, resolving a document-link href from inside a
    published page into *that target's own* publish token, entirely
    server-side (a public page has no session-tree state of its own to
    check a link against)."""

    def test_same_folder_link_to_a_published_sibling_resolves(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        a = storage.create_draft(pid, meta["id"])
        b = storage.create_draft(pid, meta["id"])
        token_a = storage.publish_document(pid, meta["id"], a["filename"])["token"]
        token_b = storage.publish_document(pid, meta["id"], b["filename"])["token"]

        assert storage.resolve_published_link(token_a, b["filename"]) == token_b

    def test_same_folder_link_to_an_unpublished_sibling_resolves_to_none(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        a = storage.create_draft(pid, meta["id"])
        b = storage.create_draft(pid, meta["id"])  # never published
        token_a = storage.publish_document(pid, meta["id"], a["filename"])["token"]

        assert storage.resolve_published_link(token_a, b["filename"]) is None

    def test_cross_folder_link_resolves_within_the_same_project(self, isolated_data_dir, pid):
        folder1 = storage.create_conversation(pid, "Folder 1")
        folder2 = storage.create_conversation(pid, "Folder 2")
        a = storage.create_draft(pid, folder1["id"])
        b = storage.create_draft(pid, folder2["id"])
        token_a = storage.publish_document(pid, folder1["id"], a["filename"])["token"]
        token_b = storage.publish_document(pid, folder2["id"], b["filename"])["token"]

        assert storage.resolve_published_link(token_a, f"{folder2['id']}/{b['filename']}") == token_b

    def test_cross_folder_link_never_reaches_a_different_project(self, isolated_data_dir):
        p1 = storage.create_project("P1")
        p2 = storage.create_project("P2")
        conv1 = storage.create_conversation(p1["id"])
        conv2 = storage.create_conversation(p2["id"])
        a = storage.create_draft(p1["id"], conv1["id"])
        b = storage.create_draft(p2["id"], conv2["id"])
        token_a = storage.publish_document(p1["id"], conv1["id"], a["filename"])["token"]
        storage.publish_document(p2["id"], conv2["id"], b["filename"])

        # Even though conv2["id"] happens to be a real folder id, it belongs
        # to a different project - resolve_published_link never looks
        # outside token_a's own project, so this must not resolve.
        assert storage.resolve_published_link(token_a, f"{conv2['id']}/{b['filename']}") is None

    def test_malformed_target_resolves_to_none(self, isolated_data_dir, pid):
        meta = storage.create_conversation(pid)
        a = storage.create_draft(pid, meta["id"])
        token_a = storage.publish_document(pid, meta["id"], a["filename"])["token"]

        for bad_target in ["https://example.com", "../escape/0002.md", "not-markdown.txt", ""]:
            assert storage.resolve_published_link(token_a, bad_target) is None

    def test_resolving_a_link_from_an_unknown_token_raises(self, isolated_data_dir):
        with pytest.raises(FileNotFoundError):
            storage.resolve_published_link("no-such-token", "0002.md")


class TestDocumentVersion:
    def test_poll_document_reports_changes_by_version(self, isolated_data_dir):
        pid = storage.create_project("p")["id"]
        cid = storage.create_conversation(pid, "c")["id"]
        name = storage.create_draft(pid, cid)["filename"]
        saved = storage.save_document(pid, cid, name, "first")

        unchanged = storage.poll_document(pid, cid, name, since=saved["version"])
        assert unchanged == {"changed": False, "version": saved["version"]}

        import os, time
        path = storage._conversations_dir(pid) / cid / name
        path.write_text("second", encoding="utf-8")
        os.utime(path, ns=(time.time_ns(), time.time_ns() + 1_000_000))
        changed = storage.poll_document(pid, cid, name, since=saved["version"])
        assert changed["changed"] is True
        assert changed["content"] == "second"
        assert changed["version"] != saved["version"]

    def test_list_documents_carries_the_same_version(self, isolated_data_dir):
        pid = storage.create_project("p")["id"]
        cid = storage.create_conversation(pid, "c")["id"]
        name = storage.create_draft(pid, cid)["filename"]
        saved = storage.save_document(pid, cid, name, "x")
        listed = next(d for d in storage.list_documents(pid, cid) if d["filename"] == name)
        assert listed["version"] == saved["version"]

    def test_poll_document_missing(self, isolated_data_dir):
        pid = storage.create_project("p")["id"]
        cid = storage.create_conversation(pid, "c")["id"]
        import pytest as _pytest
        with _pytest.raises(FileNotFoundError):
            storage.poll_document(pid, cid, "nope.md")


def test_spoken_math_is_seeded_once_then_edited_in_place(isolated_data_dir):
    seeded = storage.get_global_spoken_math()
    assert "집합 열고, {" in seeded
    assert "엑스, x" in seeded
    assert (isolated_data_dir / storage.SPOKEN_MATH_FILENAME).read_text(encoding="utf-8") == seeded

    storage.save_global_spoken_math("제곱, ^2\n")
    # The saved copy is the vocabulary from now on - never re-seeded.
    assert storage.get_global_spoken_math() == "제곱, ^2\n"

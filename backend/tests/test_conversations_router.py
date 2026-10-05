import json

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app
import app.routers.conversations as conversations_router


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


class RecordingProvider:
    """Fake LLMProvider that just records the `messages` it was called
    with, so tests can assert on exactly what history the router built -
    without hitting a real provider/API key."""

    def __init__(self, text="ok"):
        self.received_messages = None
        self.received_system_prompt = None
        self._text = text

    async def stream(self, messages, model, reasoning_effort=None, system_prompt=None):
        self.received_messages = messages
        self.received_system_prompt = system_prompt
        yield {"type": "text", "text": self._text}

    async def list_models(self):
        return ["gpt-test"]


@pytest.fixture
def recording_provider(monkeypatch):
    provider = RecordingProvider()
    monkeypatch.setattr(conversations_router, "get_provider", lambda provider_id: provider)
    return provider


@pytest.fixture
def client():
    return TestClient(app)


def _seed_one_turn(pid: str, conv_id: str) -> None:
    turn = storage.start_exchange(pid, conv_id, "첫 질문", provider="openai", model="gpt-test")
    storage.complete_exchange(pid, conv_id, turn["id"], "첫 대답")


def test_include_history_defaults_to_true(isolated_data_dir, client, recording_provider):
    # The default context_scope ("default") only ever includes a turn's own
    # content (see the context-scope tests below), so this has to continue
    # an existing turn - not start a brand-new one - to actually exercise
    # "history included" meaningfully: the turn's own earlier round.
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    turn = storage.start_exchange(pid, conv_id, "첫 질문", provider="openai", model="gpt-test")
    storage.complete_exchange(pid, conv_id, turn["id"], "첫 대답")

    # retry_exchange (unlike start_exchange) expects the *whole* buffer,
    # ending in a fresh pending "## User" section - app.js's sendActive()
    # builds this; a raw request has to do it by hand the same way
    # test_continuing_a_turn_sends_only_the_new_question_not_the_whole_buffer
    # already does below.
    whole_buffer = (
        storage.EXCHANGE_HEADINGS["en"]["user"] + "\n\n첫 질문\n\n"
        + storage.EXCHANGE_HEADINGS["en"]["assistant"] + "\n\n첫 대답\n\n"
        + storage.EXCHANGE_HEADINGS["en"]["user"] + "\n\n두 번째 질문"
    )
    resp = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/messages",
        json={
            "content": whole_buffer,
            "provider": "openai",
            "model": "gpt-test",
            "retry_turn_id": turn["id"],
        },
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [
        {"role": "user", "content": "첫 질문"},
        {"role": "assistant", "content": "첫 대답"},
        {"role": "user", "content": "두 번째 질문"},
    ]


def test_default_scope_excludes_other_turns_in_the_same_folder(isolated_data_dir, client, recording_provider):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    _seed_one_turn(pid, conv_id)  # an unrelated turn already in this folder

    resp = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/messages",
        json={"content": "새 질문", "provider": "openai", "model": "gpt-test"},
    )
    assert resp.status_code == 200
    # context_scope defaults to "default" - a brand-new turn's own content is
    # just this one question, so nothing from the other turn already in the
    # folder is included.
    assert recording_provider.received_messages == [{"role": "user", "content": "새 질문"}]


def test_sibling_scope_includes_every_turn_in_the_same_folder(isolated_data_dir, client, recording_provider):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    _seed_one_turn(pid, conv_id)

    resp = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/messages",
        json={"content": "새 질문", "provider": "openai", "model": "gpt-test", "context_scope": "sibling"},
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [
        {"role": "user", "content": "첫 질문"},
        {"role": "assistant", "content": "첫 대답"},
        {"role": "user", "content": "새 질문"},
    ]


def test_descendants_scope_includes_subfolder_turns_in_chronological_order(
    isolated_data_dir, client, recording_provider
):
    pid = storage.create_project("p")["id"]
    parent_id = storage.create_conversation(pid, "Parent")["id"]
    child_id = storage.create_conversation(pid, "Child", parent_id=parent_id)["id"]

    t1 = storage.start_exchange(pid, parent_id, "부모 질문", provider="openai", model="gpt-test")
    storage.complete_exchange(pid, parent_id, t1["id"], "부모 답변")
    t2 = storage.start_exchange(pid, child_id, "자식 질문", provider="openai", model="gpt-test")
    storage.complete_exchange(pid, child_id, t2["id"], "자식 답변")

    resp = client.post(
        f"/api/projects/{pid}/conversations/{parent_id}/messages",
        json={"content": "새 질문", "provider": "openai", "model": "gpt-test", "context_scope": "descendants"},
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [
        {"role": "user", "content": "부모 질문"},
        {"role": "assistant", "content": "부모 답변"},
        {"role": "user", "content": "자식 질문"},
        {"role": "assistant", "content": "자식 답변"},
        {"role": "user", "content": "새 질문"},
    ]


def test_include_history_false_sends_only_this_message(isolated_data_dir, client, recording_provider):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    _seed_one_turn(pid, conv_id)

    resp = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/messages",
        json={
            "content": "문맥 없이 보낼 질문",
            "provider": "openai",
            "model": "gpt-test",
            "include_history": False,
        },
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [{"role": "user", "content": "문맥 없이 보낼 질문"}]

    # The turn is still recorded in the session normally - only the LLM
    # call itself skipped prior context, not the session's own history.
    conv = storage.get_conversation(pid, conv_id)
    assert len(conv["turns"]) == 2


def test_continuing_a_turn_sends_only_the_new_question_not_the_whole_buffer(
    isolated_data_dir, client, recording_provider
):
    # Regression test: retry_turn_id used to make the router append the
    # *entire* request body (the editor's whole buffer, which for a
    # continued turn already contains earlier complete rounds) as one new
    # "user" history message on top of build_history's own reconstruction
    # of that same turn's earlier rounds - duplicating them in the prompt.
    # It must use turn["question"] (just the new trailing question) instead.
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    turn = storage.start_exchange(pid, conv_id, "Q1", provider="openai", model="gpt-test")
    storage.complete_exchange(pid, conv_id, turn["id"], "A1")

    whole_buffer = (
        storage.EXCHANGE_HEADINGS["en"]["user"] + "\n\nQ1\n\n"
        + storage.EXCHANGE_HEADINGS["en"]["assistant"] + "\n\nA1\n\n"
        + storage.EXCHANGE_HEADINGS["en"]["user"] + "\n\nQ2"
    )
    resp = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/messages",
        json={
            "content": whole_buffer,
            "provider": "openai",
            "model": "gpt-test",
            "retry_turn_id": turn["id"],
        },
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [
        {"role": "user", "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user", "content": "Q2"},
    ]

    conv = storage.get_conversation(pid, conv_id)
    assert len(conv["turns"]) == 1  # still the same one file, not a new turn


def _read_ndjson(resp):
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


class TestInlineComplete:
    """app.js's inline-send mode (draft document, cursor mid-document) -
    routers/conversations.py's inline_complete. Deliberately the lightest
    possible sibling of /messages: no turn, no history bookkeeping, no
    write to storage at all - just this one sentence in, the model's reply
    streamed back out."""

    def test_sends_only_the_given_content_with_no_history(self, isolated_data_dir, client, recording_provider):
        pid = storage.create_project("p")["id"]
        conv_id = storage.create_conversation(pid)["id"]
        _seed_one_turn(pid, conv_id)  # unrelated turn already in the folder

        resp = client.post(
            f"/api/projects/{pid}/conversations/{conv_id}/inline-complete",
            json={"content": "이 문장을 설명해줘", "provider": "openai", "model": "gpt-test"},
        )
        assert resp.status_code == 200
        assert recording_provider.received_messages == [{"role": "user", "content": "이 문장을 설명해줘"}]

    def test_never_creates_a_turn(self, isolated_data_dir, client, recording_provider):
        pid = storage.create_project("p")["id"]
        conv_id = storage.create_conversation(pid)["id"]

        client.post(
            f"/api/projects/{pid}/conversations/{conv_id}/inline-complete",
            json={"content": "질문", "provider": "openai", "model": "gpt-test"},
        )

        assert storage.get_conversation(pid, conv_id)["turns"] == []

    def test_returns_delta_then_done_events(self, isolated_data_dir, client, recording_provider):
        pid = storage.create_project("p")["id"]
        conv_id = storage.create_conversation(pid)["id"]

        resp = client.post(
            f"/api/projects/{pid}/conversations/{conv_id}/inline-complete",
            json={"content": "질문", "provider": "openai", "model": "gpt-test"},
        )
        events = _read_ndjson(resp)
        assert events == [{"type": "delta", "text": "ok"}, {"type": "done", "text": "ok"}]

    def test_inherits_the_folder_system_prompt_chain(self, isolated_data_dir, client, recording_provider):
        pid = storage.create_project("p")["id"]
        storage.save_global_system_prompt("전역 지시")
        storage.save_project_system_prompt(pid, "프로젝트 지시")
        parent = storage.create_conversation(pid, "Parent")
        child = storage.create_conversation(pid, "Child", parent_id=parent["id"])
        (isolated_data_dir / "projects" / pid / "conversations" / parent["id"] / storage.SYSTEM_FILENAME).write_text(
            "부모 지시", encoding="utf-8"
        )

        client.post(
            f"/api/projects/{pid}/conversations/{child['id']}/inline-complete",
            json={"content": "질문", "provider": "openai", "model": "gpt-test"},
        )

        assert recording_provider.received_system_prompt == "전역 지시\n\n프로젝트 지시\n\n부모 지시"

    def test_convert_math_applies_to_the_final_text(self, isolated_data_dir, client, monkeypatch):
        pid = storage.create_project("p")["id"]
        conv_id = storage.create_conversation(pid)["id"]
        provider = RecordingProvider(text=r"답은 $\frac{1}{2}$ 입니다")
        monkeypatch.setattr(conversations_router, "get_provider", lambda provider_id: provider)

        resp = client.post(
            f"/api/projects/{pid}/conversations/{conv_id}/inline-complete",
            json={"content": "질문", "provider": "openai", "model": "gpt-test", "convert_math": True},
        )
        events = _read_ndjson(resp)
        done = next(e for e in events if e["type"] == "done")
        assert done["text"] == "답은 $1/2$ 입니다"

    def test_unknown_provider_raises_400(self, isolated_data_dir, client):
        pid = storage.create_project("p")["id"]
        conv_id = storage.create_conversation(pid)["id"]

        resp = client.post(
            f"/api/projects/{pid}/conversations/{conv_id}/inline-complete",
            json={"content": "질문", "provider": "nonexistent", "model": "gpt-test"},
        )
        assert resp.status_code == 400


# ---------- inline-complete: the document above the question ----------


def test_inline_complete_sends_document_context_in_system_prompt(isolated_data_dir, recording_provider, client):
    pid = storage.create_project("p")["id"]
    cid = storage.create_conversation(pid, "c")["id"]
    resp = client.post(
        f"/api/projects/{pid}/conversations/{cid}/inline-complete",
        json={
            "content": "이 증명에서 빠진 단계는?",
            "history": [],
            "context": "# 정리 1\n\n모든 짝수는 두 홀수의 합이다.",
            "provider": "openai",
            "model": "gpt-test",
        },
    )
    assert resp.status_code == 200
    assert recording_provider.received_messages == [{"role": "user", "content": "이 증명에서 빠진 단계는?"}]
    assert "<document>\n# 정리 1\n\n모든 짝수는 두 홀수의 합이다.\n</document>" in recording_provider.received_system_prompt


def test_inline_complete_without_context_adds_nothing(isolated_data_dir, recording_provider, client):
    pid = storage.create_project("p")["id"]
    cid = storage.create_conversation(pid, "c")["id"]
    client.post(
        f"/api/projects/{pid}/conversations/{cid}/inline-complete",
        json={"content": "q", "provider": "openai", "model": "gpt-test"},
    )
    assert recording_provider.received_system_prompt is None


def test_inline_context_keeps_the_part_nearest_the_question(monkeypatch):
    monkeypatch.setattr(conversations_router, "INLINE_CONTEXT_MAX_CHARS", 10)
    section = conversations_router._inline_document_context("0123456789ABCDEFGHIJ")
    assert "<document>\n…ABCDEFGHIJ\n</document>" in section

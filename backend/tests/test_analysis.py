import json

import pytest
from fastapi.testclient import TestClient

from app import analysis, storage
from app.config import settings
from app.main import app
import app.routers.analysis as analysis_router


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


class FakeProvider:
    def __init__(self, text):
        self.text = text
        self.messages = None
        self.system_prompt = None

    async def stream(self, messages, model, reasoning_effort=None, system_prompt=None):
        self.messages = messages
        self.system_prompt = system_prompt
        for i in range(0, len(self.text), 7):
            yield {"type": "text", "text": self.text[i : i + 7]}


def _draft():
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    filename = storage.create_draft(pid, conv_id)["filename"]
    storage.save_document(pid, conv_id, filename, "1 + 1 = 3")
    return pid, conv_id, filename


def _events(response):
    return [json.loads(line) for line in response.text.splitlines() if line]


class TestParseEvaluation:
    def test_plain_json(self):
        text = json.dumps(
            {
                "verdict": "flawed",
                "score": 40,
                "summary": "s",
                "issues": [{"severity": "error", "quote": "1 + 1 = 3", "problem": "p", "correction": "2"}],
            }
        )
        result = analysis.parse_evaluation(text)
        assert result["verdict"] == "flawed"
        assert result["score"] == 40
        assert result["issues"][0]["quote"] == "1 + 1 = 3"

    def test_fenced_and_surrounded_json(self):
        text = 'Here you go:\n```json\n{"verdict": "sound", "score": "95", "summary": "ok", "issues": []}\n```'
        result = analysis.parse_evaluation(text)
        assert result["verdict"] == "sound"
        assert result["score"] == 95

    def test_bad_fields_are_coerced(self):
        text = '{"verdict": "great", "score": 250, "issues": [{"severity": "fatal", "problem": "x"}, "junk"]}'
        result = analysis.parse_evaluation(text)
        assert result["verdict"] is None
        assert result["score"] == 100
        assert result["issues"] == [{"severity": "warning", "quote": "", "problem": "x", "correction": ""}]

    def test_not_json_is_kept_raw(self):
        result = analysis.parse_evaluation("I think it's fine.")
        assert result["raw"] == "I think it's fine."
        assert result["issues"] == []


class TestParseFormalization:
    def test_code_and_notes(self):
        text = "Intro\n\n```lean\nimport Mathlib\n\nexample : 1 + 1 = 2 := by norm_num\n```\n\n- notes"
        result = analysis.parse_formalization(text)
        assert result["code"] == "import Mathlib\n\nexample : 1 + 1 = 2 := by norm_num"
        assert result["notes"].startswith("Intro")
        assert result["notes"].endswith("- notes")

    def test_no_code_block(self):
        assert analysis.parse_formalization("nothing")["code"] == ""


class TestStorage:
    def test_save_get_and_follow_rename_move_delete(self, isolated_data_dir):
        pid, conv_id, filename = _draft()
        assert storage.get_analysis(pid, conv_id, filename, "evaluate") is None
        storage.save_analysis(pid, conv_id, filename, "evaluate", {"score": 1})
        assert storage.get_analysis(pid, conv_id, filename, "evaluate")["score"] == 1
        # not listed as a document
        assert [d["filename"] for d in storage.list_documents(pid, conv_id)] == ["system.md", filename]

        storage.rename_document(pid, conv_id, filename, "renamed.md")
        assert storage.get_analysis(pid, conv_id, "renamed.md", "evaluate")["score"] == 1

        other = storage.create_conversation(pid)["id"]
        storage.move_document(pid, conv_id, "renamed.md", other)
        assert storage.get_analysis(pid, other, "renamed.md", "evaluate")["score"] == 1

        storage.delete_document(pid, other, "renamed.md")
        storage.create_draft(pid, other)  # whatever its name, no stale analysis
        (isolated_data_dir / "projects" / pid / "conversations" / other / "renamed.md").write_text("x")
        assert storage.get_analysis(pid, other, "renamed.md", "evaluate") is None

    def test_unknown_kind(self, isolated_data_dir):
        pid, conv_id, filename = _draft()
        with pytest.raises(ValueError):
            storage.get_analysis(pid, conv_id, filename, "nope")


class TestRouter:
    def test_evaluate_streams_and_saves(self, isolated_data_dir, monkeypatch):
        pid, conv_id, filename = _draft()
        reply = json.dumps({"verdict": "flawed", "score": 10, "summary": "wrong", "issues": []})
        provider = FakeProvider(reply)
        monkeypatch.setattr(analysis_router, "get_provider", lambda provider_id: provider)
        client = TestClient(app)
        url = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/analysis/evaluate"

        assert client.get(url).json() is None
        response = client.post(url, json={"content": "1 + 1 = 3", "provider": "openai", "model": "m", "language": "ko"})
        events = _events(response)
        assert "".join(e["text"] for e in events if e["type"] == "delta") == reply
        done = events[-1]
        assert done["type"] == "done"
        assert done["result"]["score"] == 10
        assert done["result"]["content_sha256"] == analysis.content_hash("1 + 1 = 3")
        assert "1 + 1 = 3" in provider.messages[0]["content"]
        assert "Korean" in provider.system_prompt
        assert "as LaTeX" in provider.system_prompt
        assert client.get(url).json()["verdict"] == "flawed"

    def test_formalize(self, isolated_data_dir, monkeypatch):
        pid, conv_id, filename = _draft()
        provider = FakeProvider("```lean\nimport Mathlib\n```\nnotes")
        monkeypatch.setattr(analysis_router, "get_provider", lambda provider_id: provider)
        client = TestClient(app)
        url = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/analysis/formalize"
        body = {"content": "x", "provider": "openai", "model": "m", "math_dialect": "asciimath"}
        done = _events(client.post(url, json=body))[-1]
        assert "as AsciiMath" in provider.system_prompt
        assert done["result"]["code"] == "import Mathlib"
        assert done["result"]["notes"] == "notes"

    def test_unknown_kind_and_missing_document(self, isolated_data_dir):
        pid, conv_id, filename = _draft()
        client = TestClient(app)
        base = f"/api/projects/{pid}/conversations/{conv_id}/documents"
        assert client.get(f"{base}/{filename}/analysis/nope").status_code == 404
        assert client.get(f"{base}/missing.md/analysis/evaluate").status_code == 404

    def test_evaluate_lenses_are_saved_apart(self, isolated_data_dir, monkeypatch):
        pid, conv_id, filename = _draft()
        provider = FakeProvider(json.dumps({"verdict": "no_claims", "score": 100, "summary": "", "issues": []}))
        monkeypatch.setattr(analysis_router, "get_provider", lambda provider_id: provider)
        client = TestClient(app)
        base = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/analysis"
        body = {"content": "x", "provider": "openai", "model": "m"}
        done = _events(client.post(f"{base}/evaluate-logic", json=body))[-1]
        assert done["result"]["verdict"] == "no_claims"
        assert "fact-checker" in provider.system_prompt
        assert '"no_claims"' in provider.system_prompt
        assert client.get(f"{base}/evaluate").json() is None
        assert client.get(f"{base}/evaluate-logic").json()["kind"] == "evaluate-logic"

        _events(client.post(f"{base}/evaluate-writing", json=body))
        assert "editor" in provider.system_prompt
        assert "no_math" not in provider.system_prompt and "no_claims" not in provider.system_prompt
        storage.rename_document(pid, conv_id, filename, "moved.md")
        assert client.get(f"{base.replace(filename, 'moved.md')}/evaluate-writing").json() is not None


class TestLive:
    def test_merge_skips_repeated_quotes(self):
        issue = {"severity": "error", "quote": "1543년", "problem": "p", "correction": ""}
        first = analysis.merge_live(None, [issue], "t1")
        assert first["checks"] == 1 and len(first["added"]) == 1
        second = analysis.merge_live(first, [issue, {**issue, "quote": "other"}], "t2")
        assert [i["quote"] for i in second["issues"]] == ["1543년", "other"]
        assert [i["quote"] for i in second["added"]] == ["other"]

    def test_passage_and_context(self):
        content = "A" * 5000 + "NEW PART"
        msg = analysis.live_user_message("f.md", content, 5000, len(content))
        assert "<passage>\nNEW PART\n</passage>" in msg
        assert msg.count("A") <= analysis.LIVE_CONTEXT_CHARS + 5

    def test_live_endpoint_accumulates_and_clears(self, isolated_data_dir, monkeypatch):
        pid, conv_id, filename = _draft()
        reply = json.dumps({"issues": [{"severity": "error", "quote": "1 + 1 = 3", "problem": "2", "correction": ""}]})
        provider = FakeProvider(reply)
        monkeypatch.setattr(analysis_router, "get_provider", lambda provider_id: provider)
        client = TestClient(app)
        url = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/analysis/evaluate-live"
        body = {"content": "intro\n1 + 1 = 3", "start": 6, "end": 15, "provider": "openai", "model": "m"}
        first = client.post(url, json=body).json()
        assert len(first["added"]) == 1 and first["record"]["checks"] == 1
        assert "<passage>\n1 + 1 = 3\n</passage>" in provider.messages[0]["content"]
        assert "lecture" in provider.system_prompt
        second = client.post(url, json=body).json()
        assert second["added"] == [] and second["record"]["checks"] == 2
        assert client.get(url).json()["checks"] == 2
        assert client.delete(url).status_code == 200
        assert client.get(url).json() is None

        provider.text = "not json"
        assert client.post(url, json=body).json()["added"] == []

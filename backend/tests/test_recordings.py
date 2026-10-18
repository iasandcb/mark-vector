import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app


@pytest.fixture
def doc(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    filename = storage.create_draft(pid, conv_id)["filename"]
    return pid, conv_id, filename


def test_upload_in_pieces_and_follow_the_document(doc):
    pid, conv_id, filename = doc
    client = TestClient(app)
    base = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/recordings"
    rec = client.post(base, json={"ext": "m4a", "started": "2026-10-18T19:30:12"}).json()
    assert rec["id"].startswith("20261018-193012-") and rec["id"].endswith(".m4a")
    url = f"{base}/{rec['id']}"
    assert client.put(f"{url}?offset=0", content=b"abc").json() == {"size": 3}
    assert client.put(f"{url}?offset=0", content=b"abc").json() == {"size": 3}  # a retry
    gap = client.put(f"{url}?offset=5", content=b"zz")
    assert gap.status_code == 409 and gap.json()["detail"] == {"size": 3}
    assert client.put(f"{url}?offset=3", content=b"def").json() == {"size": 6}
    got = client.get(url)
    assert got.content == b"abcdef" and got.headers["content-type"] == "audio/mp4"
    assert [d["recordings"] for d in storage.list_documents(pid, conv_id) if d["filename"] == filename] == [1]

    storage.rename_document(pid, conv_id, filename, "lecture.md")
    assert [r["size"] for r in storage.list_recordings(pid, conv_id, "lecture.md")] == [6]
    other = storage.create_conversation(pid)["id"]
    storage.move_document(pid, conv_id, "lecture.md", other)
    assert len(storage.list_recordings(pid, other, "lecture.md")) == 1
    storage.delete_document(pid, other, "lecture.md")
    assert not (storage._conversations_dir(pid) / other / ".recordings" / "lecture.md").exists()


def test_bad_ids_and_delete(doc):
    pid, conv_id, filename = doc
    client = TestClient(app)
    base = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/recordings"
    assert client.post(base, json={"ext": "exe", "started": "2026-10-18T19:30:12"}).status_code == 400
    assert client.get(f"{base}/..%2Fmeta.json").status_code in (400, 404)
    rec = client.post(base, json={"ext": "webm", "started": "2026-10-18T19:30:12"}).json()
    assert client.delete(f"{base}/{rec['id']}").json() == {"ok": True}
    assert client.get(base).json() == []


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_webm_converted_for_players_that_need_aac(doc, tmp_path):
    pid, conv_id, filename = doc
    src = tmp_path / "tone.webm"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=2", "-c:a", "libopus", str(src)], check=True
    )
    client = TestClient(app)
    base = f"/api/projects/{pid}/conversations/{conv_id}/documents/{filename}/recordings"
    rec = client.post(base, json={"ext": "webm", "started": "2026-10-18T19:30:12"}).json()
    url = f"{base}/{rec['id']}"
    client.put(f"{url}?offset=0", content=src.read_bytes())
    got = client.get(f"{url}?format=m4a")
    assert got.status_code == 200 and got.headers["content-type"] == "audio/mp4"
    assert b"ftyp" in got.content[:16]
    assert client.get(f"{url}?format=m4a").content == got.content  # kept, not redone
    assert len(storage.list_recordings(pid, conv_id, filename)) == 1  # the copy isn't a recording
    client.delete(url)
    assert not list((storage._conversations_dir(pid) / conv_id / ".recordings" / filename / ".play").iterdir())

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.config import settings
from app.main import app


@pytest.fixture
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def client():
    return TestClient(app)


def test_publish_then_fetch_via_public_api(isolated_data_dir, client):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    draft = storage.create_draft(pid, conv_id)
    storage.save_document(pid, conv_id, draft["filename"], "공유할 내용")

    publish_resp = client.post(f"/api/projects/{pid}/conversations/{conv_id}/documents/{draft['filename']}/publish")
    assert publish_resp.status_code == 200
    token = publish_resp.json()["token"]

    public_resp = client.get(f"/api/public/{token}")
    assert public_resp.status_code == 200
    body = public_resp.json()
    assert body["filename"] == draft["filename"]
    assert body["content"] == "공유할 내용"
    assert body["dialect"] == "latex"


def test_public_page_shell_serves_for_any_token(isolated_data_dir, client):
    resp = client.get("/p/whatever-token")
    assert resp.status_code == 200
    assert "public.js" in resp.text


def test_unpublish_invalidates_the_public_api(isolated_data_dir, client):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    draft = storage.create_draft(pid, conv_id)
    token = client.post(
        f"/api/projects/{pid}/conversations/{conv_id}/documents/{draft['filename']}/publish"
    ).json()["token"]

    unpublish_resp = client.delete(f"/api/projects/{pid}/conversations/{conv_id}/documents/{draft['filename']}/publish")
    assert unpublish_resp.status_code == 200

    assert client.get(f"/api/public/{token}").status_code == 404


def test_publishing_system_prompt_is_rejected(isolated_data_dir, client):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]

    resp = client.post(f"/api/projects/{pid}/conversations/{conv_id}/documents/system.md/publish")
    assert resp.status_code == 400


def test_fetching_unknown_token_is_404(isolated_data_dir, client):
    assert client.get("/api/public/no-such-token").status_code == 404


def test_slides_option_round_trips_through_the_public_api(isolated_data_dir, client):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    draft = storage.create_draft(pid, conv_id)
    base = f"/api/projects/{pid}/conversations/{conv_id}/documents/{draft['filename']}/publish"
    token = client.post(base).json()["token"]
    assert client.get(f"/api/public/{token}").json()["slides"] is False

    resp = client.patch(base, json={"slides": True})
    assert resp.status_code == 200
    assert resp.json() == {"token": token, "slides": True}
    assert client.get(f"/api/public/{token}").json()["slides"] is True
    docs = storage.list_documents(pid, conv_id)
    assert next(d for d in docs if d["filename"] == draft["filename"])["publish_slides"] is True

    # Re-publishing keeps both the token and the option.
    assert client.post(base).json()["token"] == token
    assert client.get(f"/api/public/{token}").json()["slides"] is True

    client.patch(base, json={"slides": False})
    assert client.get(f"/api/public/{token}").json()["slides"] is False


def test_slides_option_on_unpublished_document_is_404(isolated_data_dir, client):
    pid = storage.create_project("p")["id"]
    conv_id = storage.create_conversation(pid)["id"]
    draft = storage.create_draft(pid, conv_id)
    resp = client.patch(
        f"/api/projects/{pid}/conversations/{conv_id}/documents/{draft['filename']}/publish",
        json={"slides": True},
    )
    assert resp.status_code == 404


def test_spoken_math_vocabulary_is_readable_without_auth(isolated_data_dir, client, monkeypatch):
    # Auth on: everything outside the public paths needs a session.
    monkeypatch.setattr(settings, "app_passcode", "1234")
    storage.save_global_spoken_math("엑스, x\n")
    assert client.get("/api/spoken-math").status_code in (401, 403)
    resp = client.get("/api/public/spoken-math")
    assert resp.status_code == 200
    assert resp.json() == {"content": "엑스, x\n"}
    assert client.put("/api/public/spoken-math", json={"content": "x"}).status_code == 405

import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import storage
from app.auth import SESSION_COOKIE, _sign_session
from app.config import settings
from app.main import app
from app.routers import document_sync


@pytest.fixture
def document(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "app_passcode", None)
    monkeypatch.setattr(settings, "google_client_id", None)
    document_sync._rooms.clear()
    project = storage.create_project("test")["id"]
    folder = storage.create_conversation(project)["id"]
    filename = storage.create_draft(project, folder)["filename"]
    return project, folder, filename


def endpoint(document, write=False):
    return "/ws/documents/" + "/".join(document) + ("?write=1" if write else "")


def test_saves_before_ack_and_broadcasts_to_reader(document):
    with TestClient(app) as client:
        with client.websocket_connect(endpoint(document, True)) as writer, client.websocket_connect(endpoint(document)) as reader:
            assert writer.receive_json()["type"] == "ready"
            assert reader.receive_json()["type"] == "ready"
            for number, text in enumerate(["가", "각", "한글 👨‍👩‍👧‍👦\n수식 $x$"], 1):
                writer.send_json({"type": "update", "sequence": number, "content": text})
                update = reader.receive_json()
                ack = writer.receive_json()
                assert update["content"] == text
                assert ack == {"type": "ack", "sequence": number, "version": update["version"]}
                assert storage.poll_document(*document)["content"] == text
        with client.websocket_connect(endpoint(document)) as reconnected:
            assert reconnected.receive_json()["content"] == "한글 👨‍👩‍👧‍👦\n수식 $x$"
    assert not document_sync._rooms


def test_auth_and_origin_checks(document, monkeypatch):
    monkeypatch.setattr(settings, "app_passcode", "test-only")
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(endpoint(document)):
                pass
        client.cookies.set(SESSION_COOKIE, _sign_session({"email": "test@example.invalid", "exp": time.time() + 100}))
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(endpoint(document), headers={"origin": "https://other.invalid"}):
                pass
        with client.websocket_connect(endpoint(document), headers={"origin": "http://testserver"}) as reader:
            assert reader.receive_json()["type"] == "ready"


def test_reader_cannot_write_and_invalid_snapshots_are_rejected(document):
    with TestClient(app) as client:
        with client.websocket_connect(endpoint(document)) as reader:
            reader.receive_json()
            reader.send_json({"type": "update", "sequence": 1, "content": "overwrite"})
            assert reader.receive_json()["type"] == "error"
            assert storage.poll_document(*document)["content"] == ""
        with client.websocket_connect(endpoint(document, True)) as writer:
            writer.receive_json()
            for content in [None, "x" * (document_sync.MAX_CONTENT_BYTES + 1)]:
                writer.send_json({"type": "update", "sequence": 1, "content": content})
                assert writer.receive_json()["type"] == "error"
            writer.send_json({"type": "ping"})
            assert writer.receive_json() == {"type": "pong"}


def test_second_writer_is_refused_and_can_reconnect_after_close(document):
    with TestClient(app) as client:
        with client.websocket_connect(endpoint(document, True)) as first:
            first.receive_json()
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(endpoint(document, True)):
                    pass
        with client.websocket_connect(endpoint(document, True)) as second:
            assert second.receive_json()["type"] == "ready"


def test_missing_document_is_refused(document):
    with TestClient(app) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(endpoint((document[0], document[1], "missing.md"))):
            pass

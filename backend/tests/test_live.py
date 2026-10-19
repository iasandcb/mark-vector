import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def with_passcode(monkeypatch):
    monkeypatch.setattr(settings, "app_passcode", "1234")


@pytest.fixture
def without_passcode(monkeypatch):
    monkeypatch.setattr(settings, "app_passcode", None)


class TestAmbientPinGate:
    """/ws/live (no channel) has no unguessable secret of its own the way
    /ws/live/{channel} does - it deliberately mirrors whatever's currently
    live to *anyone* who connects, so it's the one live.py endpoint that
    needs the app's own passcode to avoid leaking to literally anyone who
    finds the URL."""

    def test_rejects_with_no_pin_when_a_passcode_is_configured(self, client, with_passcode):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/live"):
                pass
        assert exc.value.code == 1008

    def test_rejects_the_wrong_pin(self, client, with_passcode):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/live?pin=0000"):
                pass
        assert exc.value.code == 1008

    def test_accepts_the_correct_pin(self, client, with_passcode):
        with client.websocket_connect("/ws/live?pin=1234"):
            pass  # connecting at all is the assertion - no exception raised

    def test_open_with_no_pin_when_no_passcode_is_configured(self, client, without_passcode):
        with client.websocket_connect("/ws/live"):
            pass

    def test_channel_specific_connections_never_need_a_pin(self, client, with_passcode):
        # The channel id itself is the access control there (same model as
        # a publish token) - unaffected by APP_PASSCODE either way.
        with client.websocket_connect("/ws/live/some-channel"):
            pass


class TestCommands:
    """A screen can send a whitelisted command back toward the editor on its
    channel (the glasses D-pad asking for a new slide). Relayed to the
    channel's other sockets, never stored as the channel's state."""

    def test_command_reaches_the_other_sockets_and_is_not_stored(self, client, without_passcode):
        with client.websocket_connect("/ws/live/cmdtest") as editor, client.websocket_connect("/ws/live/cmdtest") as screen:
            editor.send_json({"type": "update", "filename": "a.md", "content": "x"})
            assert screen.receive_json()["filename"] == "a.md"
            screen.send_json({"type": "command", "action": "newSlide", "filename": "a.md"})
            assert editor.receive_json() == {"type": "command", "action": "newSlide", "filename": "a.md"}
            # A newcomer still gets the last *update*, not the command.
            with client.websocket_connect("/ws/live/cmdtest") as late:
                assert late.receive_json()["type"] == "update"

    def test_ambient_screen_command_goes_to_the_channel_it_is_showing(self, client, without_passcode):
        with client.websocket_connect("/ws/live/ambienttarget") as editor:
            editor.send_json({"type": "update", "filename": "b.md", "content": "y"})
            with client.websocket_connect("/ws/live") as ambient:
                assert ambient.receive_json()["filename"] == "b.md"
                ambient.send_json({"type": "command", "action": "newSlide", "filename": "b.md"})
                assert editor.receive_json()["action"] == "newSlide"

    def test_writing_commands_are_relayed(self, client, without_passcode):
        with client.websocket_connect("/ws/live/cmdtidy") as editor, client.websocket_connect("/ws/live/cmdtidy") as screen:
            for action in ("tidySlide", "toggleMath", "lineBreak"):
                screen.send_json({"type": "command", "action": action, "filename": "a.md"})
                assert editor.receive_json()["action"] == action

    def test_unknown_commands_are_dropped(self, client, without_passcode):
        with client.websocket_connect("/ws/live/cmdtest2") as editor, client.websocket_connect("/ws/live/cmdtest2") as screen:
            screen.send_json({"type": "command", "action": "deleteEverything"})
            screen.send_json({"type": "update", "filename": "c.md", "content": "z"})
            assert editor.receive_json()["type"] == "update"


def test_version_endpoint_is_public(client, monkeypatch):
    monkeypatch.setattr(settings, "app_passcode", "1234")
    resp = client.get("/api/public/version")
    assert resp.status_code == 200
    assert len(resp.json()["version"]) == 16


def test_ping_is_answered_to_the_sender_alone(client, without_passcode):
    with client.websocket_connect("/ws/live/pingtest") as editor, client.websocket_connect("/ws/live/pingtest") as screen:
        editor.send_json({"type": "ping"})
        assert editor.receive_json() == {"type": "pong"}
        editor.send_json({"type": "update", "filename": "p.md", "content": "x"})
        assert screen.receive_json()["type"] == "update"  # the ping never reached it


def test_ambient_screen_ping_is_answered(client, without_passcode):
    with client.websocket_connect("/ws/live") as screen:
        screen.send_json({"type": "ping"})
        reply = screen.receive_json()
        if reply.get("type") == "update":  # an earlier test's state, replayed on join
            reply = screen.receive_json()
        assert reply == {"type": "pong"}

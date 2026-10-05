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

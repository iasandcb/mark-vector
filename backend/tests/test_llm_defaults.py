import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    return TestClient(app)


def test_no_defaults_until_set(client):
    assert client.get("/api/providers/defaults").json() == {}


def test_defaults_round_trip(client):
    saved = client.put("/api/providers/defaults", json={"provider": "xai", "model": "grok-4.7", "reasoning_effort": "high"}).json()
    assert saved == {"provider": "xai", "model": "grok-4.7", "reasoning_effort": "high"}
    assert client.get("/api/providers/defaults").json() == saved


def test_empty_fields_are_dropped(client):
    client.put("/api/providers/defaults", json={"provider": "anthropic", "model": "", "reasoning_effort": None})
    assert client.get("/api/providers/defaults").json() == {"provider": "anthropic"}

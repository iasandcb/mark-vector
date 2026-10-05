import asyncio
import json
import os
import time

import pytest

from app import chatgpt_auth
from app.config import settings
from app.providers.chatgpt_provider import ChatGPTProvider


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))


def _record(**overrides):
    record = {
        "email": "user@example.com",
        "subject": "sub-1",
        "client_id": "oaiapp_test",
        "access_token": "old-access",
        "refresh_token": "old-refresh",
        "expires_at": int(time.time()) + 3600,
        "scopes": sorted(chatgpt_auth.SCOPES.split()),
    }
    record.update(overrides)
    return record


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        assert self.status_code == 200


class _FakeAsyncClient:
    calls: list = []
    response: _Resp

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data=None):
        _FakeAsyncClient.calls.append(("POST", url, data))
        return _FakeAsyncClient.response

    async def get(self, url, headers=None):
        _FakeAsyncClient.calls.append(("GET", url, headers))
        return _FakeAsyncClient.response


@pytest.fixture
def fake_http(monkeypatch):
    _FakeAsyncClient.calls = []
    monkeypatch.setattr(chatgpt_auth.httpx2, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


def test_save_credentials_is_owner_only():
    chatgpt_auth.save_credentials(_record())
    assert os.stat(chatgpt_auth.credentials_path()).st_mode & 0o777 == 0o600


def test_available_requires_plan_scope_and_refresh_token():
    creds = chatgpt_auth.ChatGPTCredentials()
    assert not creds.available()
    chatgpt_auth.save_credentials(_record(scopes=["openid", "email"]))
    assert not creds.available()
    chatgpt_auth.save_credentials(_record())
    assert creds.available()
    chatgpt_auth.save_credentials(chatgpt_auth._clear_tokens(_record()))
    assert not creds.available()


def test_fresh_token_is_returned_without_refresh(fake_http):
    chatgpt_auth.save_credentials(_record())
    token = asyncio.run(chatgpt_auth.ChatGPTCredentials().access_token())
    assert token == "old-access"
    assert fake_http.calls == []


def test_expiring_token_is_refreshed_and_rotation_persisted(fake_http):
    chatgpt_auth.save_credentials(_record(expires_at=int(time.time()) + 60))
    fake_http.response = _Resp(
        200, {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600, "token_type": "Bearer"}
    )
    token = asyncio.run(chatgpt_auth.ChatGPTCredentials().access_token())

    assert token == "new-access"
    (_, url, data), = fake_http.calls
    assert url == chatgpt_auth.TOKEN_URL
    assert data == {
        "grant_type": "refresh_token",
        "client_id": "oaiapp_test",
        "refresh_token": "old-refresh",
        "resource": chatgpt_auth.RESOURCE,
    }
    saved = chatgpt_auth.load_credentials()
    assert saved["refresh_token"] == "new-refresh"
    assert saved["expires_at"] > time.time() + 3000


def test_failed_refresh_raises(fake_http):
    chatgpt_auth.save_credentials(_record(expires_at=0))
    fake_http.response = _Resp(400, {"error": "invalid_grant"})
    with pytest.raises(chatgpt_auth.ChatGPTAuthError):
        asyncio.run(chatgpt_auth.ChatGPTCredentials().access_token())


def test_provider_lists_only_picker_models_in_server_order(fake_http, monkeypatch):
    import app.providers.chatgpt_provider as mod

    monkeypatch.setattr(mod.httpx2, "AsyncClient", _FakeAsyncClient)
    chatgpt_auth.save_credentials(_record())
    fake_http.response = _Resp(
        200,
        {
            "models": [
                {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"},
                {"slug": "internal", "display_name": "x", "visibility": "hide"},
                {"slug": "gpt-5.6-luna", "display_name": "GPT-5.6 Luna", "visibility": "list"},
            ]
        },
    )
    models = asyncio.run(ChatGPTProvider(chatgpt_auth.ChatGPTCredentials()).list_models())
    assert models == ["gpt-6.1-sol", "gpt-5.6-luna"]
    assert fake_http.calls[-1][2] == {"Authorization": "Bearer old-access"}

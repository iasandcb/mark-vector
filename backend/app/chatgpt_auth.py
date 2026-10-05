"""Sign in with ChatGPT - lets the "chatgpt" provider run on the user's own
ChatGPT plan instead of an OPENAI_API_KEY.

https://developers.openai.com/siwc/token-sharing-open-source

OpenAI only accepts an http://127.0.0.1 loopback redirect for this flow, so
the Fly machine can never receive the OAuth callback itself. Following the
"Self-hosted VMs" guide instead: sign in on the local machine with

    uv run python -m app.chatgpt_auth login

then hand the credential file to the VM with

    uv run python -m app.chatgpt_auth push

after which the VM owns every later refresh (ChatGPTCredentials below).
`push` clears the local copy's tokens so the two can't race each other over
the same rotating refresh token.

Files live under DATA_DIR/chatgpt/:
  host_id           this host's ext_agent_host_id - never copied between hosts
  credentials.json  issued client_id, tokens, validated identity (0600)
"""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx2
import jwt

from .config import settings

ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
REGISTRATION_CLIENT_ID = "dynamic_agent_client"
AGENT_NAME = "mark-vector"
CALLBACK_PATH = "/auth/callback"
DEFAULT_PORT = 1455

# Access tokens live an hour; refresh this far ahead of expiry so a long
# streamed reply never starts on a token about to lapse.
REFRESH_MARGIN = 300

FLY_APP = "markvector"
FLY_DATA_DIR = "/data"  # fly.toml's volume mount / DATA_DIR


class ChatGPTAuthError(RuntimeError):
    pass


def _dir() -> Path:
    return Path(settings.data_dir) / "chatgpt"


def credentials_path() -> Path:
    return _dir() / "credentials.json"


def host_id() -> str:
    """This host's stable ext_agent_host_id, created on first use. A
    UUID URN is one of the accepted formats and needs no key material."""
    path = _dir() / "host_id"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"urn:uuid:{uuid.uuid4()}", encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def load_credentials() -> dict | None:
    try:
        return json.loads(credentials_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_credentials(record: dict) -> None:
    """Atomic, owner-only write, as the docs require for token files."""
    path = credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".credentials-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def has_plan_access(record: dict | None) -> bool:
    return bool(record and record.get("refresh_token") and PLAN_SCOPE in record.get("scopes", []))


def _apply_token_response(record: dict, token: dict) -> dict:
    """Access token, expiry, scopes and the rotating refresh token are
    always replaced together."""
    now = time.time()
    record.update(
        access_token=token["access_token"],
        refresh_token=token.get("refresh_token", record.get("refresh_token")),
        token_type=token.get("token_type", "Bearer"),
        expires_in=token.get("expires_in", 3600),
        expires_at=int(now + token.get("expires_in", 3600)),
        earliest_refresh_at=token.get("earliest_refresh_at"),
        saved_at=datetime.now(timezone.utc).isoformat(),
    )
    if token.get("scope"):
        record["scopes"] = sorted(token["scope"].split())
    if token.get("id_token"):
        record["id_token"] = token["id_token"]
    return record


def _validate_id_token(id_token: str, client_id: str, nonce: str | None) -> dict:
    discovery = httpx2.get(DISCOVERY_URL, timeout=10).json()
    key = jwt.PyJWKClient(discovery["jwks_uri"]).get_signing_key_from_jwt(id_token)
    claims = jwt.decode(id_token, key.key, algorithms=["RS256"], audience=client_id, issuer=ISSUER)
    if nonce is not None and claims.get("nonce") != nonce:
        raise ChatGPTAuthError("ID token nonce mismatch")
    return claims


# --- runtime (server side) -------------------------------------------------


class ChatGPTCredentials:
    """Hands out a valid access token, refreshing (and persisting the
    rotated refresh token) when it's near expiry. Re-reads the file
    whenever it changes on disk, so a fresh `push` takes effect without a
    restart."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._record: dict | None = None
        self._mtime: float | None = None

    def _reload(self) -> dict | None:
        try:
            mtime = credentials_path().stat().st_mtime
        except FileNotFoundError:
            self._record, self._mtime = None, None
            return None
        if mtime != self._mtime:
            self._record, self._mtime = load_credentials(), mtime
        return self._record

    def available(self) -> bool:
        return has_plan_access(self._reload())

    async def access_token(self) -> str:
        async with self._lock:  # serialize refreshes of the rotating token
            record = self._reload()
            if not has_plan_access(record):
                raise ChatGPTAuthError("ChatGPT 로그인이 필요합니다 (python -m app.chatgpt_auth login)")
            now = time.time()
            if now < record.get("expires_at", 0) - REFRESH_MARGIN:
                return record["access_token"]
            earliest = record.get("earliest_refresh_at")
            if earliest and now < earliest and now < record.get("expires_at", 0):
                return record["access_token"]
            async with httpx2.AsyncClient(timeout=20) as client:
                resp = await client.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": record["client_id"],
                        "refresh_token": record["refresh_token"],
                        "resource": RESOURCE,
                    },
                )
            if resp.status_code != 200:
                raise ChatGPTAuthError(f"ChatGPT 토큰 갱신 실패 ({resp.status_code}): {resp.text[:300]} - 다시 로그인하세요")
            save_credentials(_apply_token_response(record, resp.json()))
            self._reload()
            return record["access_token"]


credentials = ChatGPTCredentials()


# --- CLI (local machine) ---------------------------------------------------


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def _wait_for_callback(server: HTTPServer, timeout: float) -> dict:
    result: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlparse(self.path)
            if url.path != CALLBACK_PATH:
                self.send_response(404)
                self.end_headers()
                return
            result.update({k: v[0] for k, v in parse_qs(url.query).items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>mark-vector: 로그인 완료. 이 창을 닫아도 됩니다.</p>".encode())

        def log_message(self, *args):
            pass

    server.RequestHandlerClass = Handler
    server.timeout = 1
    deadline = time.time() + timeout
    while not result and time.time() < deadline:
        server.handle_request()
    if not result:
        raise ChatGPTAuthError("로그인 시간이 초과되었습니다")
    return result


def cmd_login(args) -> None:
    existing = load_credentials()
    server = HTTPServer(("127.0.0.1", args.port), BaseHTTPRequestHandler)
    redirect_uri = f"http://127.0.0.1:{server.server_port}{CALLBACK_PATH}"
    state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    verifier, challenge = _pkce()

    params = {
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "ext_agent_host_id": host_id(),
    }
    if existing and existing.get("client_id") and not args.new:
        # Reauthorization of the saved registration.
        client_id = existing["client_id"]
        params["client_id"] = client_id
        if existing.get("id_token"):
            params["id_token_hint"] = existing["id_token"]
        if existing.get("email"):
            params["login_hint"] = existing["email"]
    else:
        client_id = None
        params["client_id"] = REGISTRATION_CLIENT_ID
        params["agent_name_hint"] = AGENT_NAME

    url = f"{AUTHORIZE_URL}?{urlencode(params)}"
    print("브라우저에서 ChatGPT 로그인을 진행하세요...")
    if not webbrowser.open(url):
        print("브라우저를 열 수 없습니다. 아래 주소를 직접 여세요:\n" + url)
    try:
        cb = _wait_for_callback(server, timeout=600)
    finally:
        server.server_close()

    if cb.get("state") != state:
        raise ChatGPTAuthError("state 불일치 - 로그인을 다시 시도하세요")
    if cb.get("error"):
        raise ChatGPTAuthError(f"로그인 거부/실패: {cb['error']} {cb.get('error_description', '')}")
    if client_id is None:
        client_id = cb.get("client_id")
        if not client_id or client_id == REGISTRATION_CLIENT_ID:
            raise ChatGPTAuthError("등록이 완료되지 않았습니다 (issued client_id 없음)")
    elif cb.get("client_id") and cb["client_id"] != client_id:
        raise ChatGPTAuthError("콜백의 client_id가 저장된 등록과 다릅니다")

    resp = httpx2.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": cb["code"],
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "resource": RESOURCE,
        },
        timeout=20,
    )
    if resp.status_code != 200:
        raise ChatGPTAuthError(f"토큰 교환 실패 ({resp.status_code}): {resp.text[:300]}")
    token = resp.json()

    claims = _validate_id_token(token["id_token"], client_id, nonce)
    if existing and existing.get("subject") and not args.new and existing["subject"] != claims["sub"]:
        raise ChatGPTAuthError("저장된 계정과 다른 계정으로 로그인했습니다 (새 계정이면 --new)")
    if PLAN_SCOPE not in token.get("scope", "").split():
        raise ChatGPTAuthError("ChatGPT 플랜 사용 권한(chatgpt.tokens.use.direct)이 허용되지 않았습니다")

    record = {"email": claims.get("email"), "issuer": ISSUER, "subject": claims["sub"], "client_id": client_id}
    save_credentials(_apply_token_response(record, token))
    print(f"로그인 완료: {record['email']} → {credentials_path()}")


def cmd_status(args) -> None:
    record = load_credentials()
    if not record:
        print("저장된 ChatGPT 자격증명 없음")
        return
    expires = record.get("expires_at")
    print(f"계정: {record.get('email')}  client_id: {record.get('client_id')}")
    print(f"플랜 사용 가능: {has_plan_access(record)}  scopes: {' '.join(record.get('scopes', []))}")
    if expires:
        print(f"access token 만료: {datetime.fromtimestamp(expires).isoformat(timespec='seconds')}")
    print(f"host id: {host_id()}")


def _revoke(record: dict) -> None:
    endpoint = httpx2.get(DISCOVERY_URL, timeout=10).json()["revocation_endpoint"]
    resp = httpx2.post(
        endpoint,
        data={"token": record["refresh_token"], "token_type_hint": "refresh_token", "client_id": record["client_id"]},
        timeout=20,
    )
    if resp.status_code != 200:
        raise ChatGPTAuthError(f"원격 세션 해지 실패 ({resp.status_code})")


def _clear_tokens(record: dict) -> dict:
    """Keeps the account/client mapping (and id_token as a hint) for the
    next sign-in, drops everything that can authorize a request."""
    for key in ("access_token", "refresh_token", "expires_at", "earliest_refresh_at"):
        record.pop(key, None)
    return record


def cmd_logout(args) -> None:
    record = load_credentials()
    if not record or not record.get("refresh_token"):
        print("해지할 세션이 없습니다")
        return
    try:
        _revoke(record)
        print("원격 세션 해지됨")
    except Exception as exc:
        print(f"원격 해지를 확인하지 못했습니다 ({exc}). ChatGPT 설정에서 앱 연결을 끊어 주세요.")
    save_credentials(_clear_tokens(record))


def _fly(*args: str) -> None:
    subprocess.run(["flyctl", *args], check=True)


def cmd_push(args) -> None:
    """Self-hosted VMs step 3/4: copy the credential file to the Fly volume
    (keeping the VM's own host_id untouched), then drop the local tokens so
    only the VM refreshes from now on."""
    record = load_credentials()
    if not has_plan_access(record):
        raise ChatGPTAuthError("먼저 login 하세요")
    remote_dir = f"{FLY_DATA_DIR}/chatgpt"
    remote_tmp = f"{remote_dir}/.credentials-upload.json"
    _fly("ssh", "console", "-a", args.app, "-C", f"mkdir -p {remote_dir}")
    _fly("ssh", "console", "-a", args.app, "-C", f"rm -f {remote_tmp}")
    _fly("ssh", "sftp", "put", "-a", args.app, str(credentials_path()), remote_tmp)
    _fly(
        "ssh", "console", "-a", args.app, "-C",
        f"sh -c 'chmod 600 {remote_tmp} && mv {remote_tmp} {remote_dir}/credentials.json'",
    )
    save_credentials(_clear_tokens(record))
    print(f"{args.app}에 업로드 완료. 로컬 토큰은 지웠습니다 (갱신은 이제 서버가 담당).")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.chatgpt_auth", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    login = sub.add_parser("login", help="브라우저로 ChatGPT 로그인 (로컬에서 실행)")
    login.add_argument("--port", type=int, default=DEFAULT_PORT)
    login.add_argument("--new", action="store_true", help="저장된 등록을 무시하고 새 계정/워크스페이스로 등록")
    login.set_defaults(func=cmd_login)
    sub.add_parser("status", help="저장된 자격증명 확인").set_defaults(func=cmd_status)
    sub.add_parser("logout", help="세션 해지 후 토큰 삭제").set_defaults(func=cmd_logout)
    push = sub.add_parser("push", help="자격증명을 Fly 볼륨으로 전송")
    push.add_argument("--app", default=FLY_APP)
    push.set_defaults(func=cmd_push)
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except ChatGPTAuthError as exc:
        sys.exit(f"오류: {exc}")


if __name__ == "__main__":
    main()

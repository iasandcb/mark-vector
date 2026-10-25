"""Authenticated, single-writer document transport for the Sebeol iOS editor.

Every acknowledged snapshot is on disk. Readers receive saved snapshots and
reconnect from disk, never from the public live-preview/ambient channels.
"""
import asyncio
import json
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import storage
from ..auth import is_authenticated

router = APIRouter()
_rooms: dict[tuple[str, str, str], dict] = {}
MAX_CONTENT_BYTES = 2 * 1024 * 1024


async def _send(peer: WebSocket, message: dict) -> None:
    await asyncio.wait_for(peer.send_json(message), timeout=5)


@router.websocket("/ws/documents/{project_id}/{conv_id}/{filename}")
async def document_socket(websocket: WebSocket, project_id: str, conv_id: str, filename: str):
    origin = websocket.headers.get("origin")
    if origin:
        source = urlsplit(origin)
        if source.scheme not in {"http", "https"} or source.netloc != websocket.headers.get("host"):
            await websocket.close(code=1008)
            return
    if not is_authenticated(websocket):
        await websocket.close(code=1008)
        return
    try:
        storage.poll_document(project_id, conv_id, filename)
    except (FileNotFoundError, ValueError):
        await websocket.close(code=1008)
        return
    key = (project_id, conv_id, filename)
    room = _rooms.setdefault(key, {"peers": set(), "lock": asyncio.Lock(), "writer": None})
    writing = websocket.query_params.get("write") == "1"
    if writing and room["writer"] is not None:
        await websocket.close(code=1008)
        return
    if writing:
        room["writer"] = websocket
    await websocket.accept()
    try:
        async with room["lock"]:
            current = storage.poll_document(project_id, conv_id, filename)
            await _send(websocket, {"type": "ready", "content": current["content"], "version": current["version"]})
            room["peers"].add(websocket)
        while True:
            raw = await websocket.receive_text()
            if not is_authenticated(websocket):
                await websocket.close(code=1008)
                break
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("type") == "ping":
                await _send(websocket, {"type": "pong"})
                continue
            content = message.get("content")
            sequence = message.get("sequence")
            if message.get("type") != "update" or not writing or not isinstance(content, str) or type(sequence) is not int:
                await _send(websocket, {"type": "error", "message": "Invalid document update"})
                continue
            if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
                await _send(websocket, {"type": "error", "message": "Document exceeds 2 MiB"})
                continue
            async with room["lock"]:
                try:
                    saved = storage.save_document(project_id, conv_id, filename, content)
                except (OSError, ValueError):
                    await _send(websocket, {"type": "error", "message": "Document could not be saved"})
                    continue
                update = {"type": "update", "content": content, "version": saved["version"]}
                peers = tuple(peer for peer in room["peers"] if peer is not websocket)
                results = await asyncio.gather(*(_send(peer, update) for peer in peers), return_exceptions=True)
                for peer, result in zip(peers, results):
                    if isinstance(result, BaseException):
                        room["peers"].discard(peer)
                await _send(websocket, {"type": "ack", "sequence": sequence, "version": saved["version"]})
    except (WebSocketDisconnect, OSError, asyncio.TimeoutError):
        pass
    finally:
        room["peers"].discard(websocket)
        if room["writer"] is websocket:
            room["writer"] = None
        if not room["peers"] and room["writer"] is None:
            _rooms.pop(key, None)

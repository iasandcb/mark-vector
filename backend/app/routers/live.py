import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings

router = APIRouter()

# In-memory pub/sub shared by two independent frontend features: the
# editor's "glasses" checkbox and its "live" checkbox (see frontend's
# app.js - createLiveSocket/glassesSocket/livePublicSocket). Either one
# pushes the buffer currently being edited to a channel, and any number of
# other sockets connected to that same channel render whatever arrives - a
# glasses/app.js screen for the "glasses" feature, or a visitor's
# static/js/public.js page (channel "pub-<publish token>") for the "live"
# one. Nothing here is persisted - a channel exists only as long as at
# least one socket is open on it, and this process restarting drops all of
# them - this is a live mirror of an in-progress edit, not a durable share
# link like routers/public.py's publish tokens (which is exactly what the
# "live" feature's channel id *is* - see app.js's own comment on why that's
# an accepted tradeoff: the channel id is the only access control here, the
# same as it always has been for the glasses feature).
#
# channel -> {"sockets": set[WebSocket], "state": dict | None}
_channels: dict[str, dict] = {}

# Ambient "whatever's live right now" mode for glasses/app.js opened with no
# ?c= - every channel's update below is mirrored here too, so this always
# reflects whichever editor most recently turned live preview on, even
# across different channels/browsers over time. Deliberately never cleaned
# up the way a channel's own entry in _channels is (see the `finally` block
# below) - "most recent" should keep showing the last thing broadcast even
# after that channel's sockets all disconnect, not blank out.
_latest_state: dict | None = None
# The channel _latest_state came from - where a command sent by an
# ambient-mode screen (see below) is delivered.
_latest_channel: str | None = None

# Messages a screen may send back toward the editor on its channel - relayed
# to the channel's other sockets as-is, never stored as its state. The
# glasses screen's D-pad drives the editor the way the gamepad remote does:
# "next" past the last slide opens a new one, select (Enter) tidies the
# slide being built, and in slide view up/down start or leave a math block
# and break a line (see app.js's handleScreenCommand).
_COMMAND_ACTIONS = {"newSlide", "tidySlide", "toggleMath", "lineBreak"}


def _is_command(message: object) -> bool:
    return isinstance(message, dict) and message.get("type") == "command" and message.get("action") in _COMMAND_ACTIONS
_latest_followers: set[WebSocket] = set()


async def _broadcast(sockets: set[WebSocket], message: dict, exclude: WebSocket | None = None) -> None:
    dead = []
    for peer in sockets:
        if peer is exclude:
            continue
        try:
            await peer.send_json(message)
        except Exception:
            dead.append(peer)
    for peer in dead:
        sockets.discard(peer)


@router.websocket("/ws/live/{channel}")
async def live_channel(websocket: WebSocket, channel: str):
    # No auth check here (this is a websocket - AuthMiddleware never even
    # sees it, since Starlette's BaseHTTPMiddleware only wraps http-scope
    # requests). The channel id itself is the access control, the same way a
    # publish token is: unguessable, and known only to whoever the editor's
    # "copy link" button gave it to.
    global _latest_state, _latest_channel
    await websocket.accept()
    entry = _channels.setdefault(channel, {"sockets": set(), "state": None})
    entry["sockets"].add(websocket)
    try:
        # A screen that joins mid-edit still needs to show *something*
        # immediately, not wait for the next keystroke - replay whatever the
        # channel's last update was.
        if entry["state"] is not None:
            await websocket.send_json(entry["state"])
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if _is_command(message):
                await _broadcast(entry["sockets"], message, exclude=websocket)
                continue
            if isinstance(message, dict) and message.get("type") == "ping":
                # The editor or a screen checking its socket is still alive
                # (see LIVE_HEARTBEAT_MS in app.js and glasses/app.js) -
                # answered to it alone.
                await websocket.send_json({"type": "pong"})
                continue
            if not isinstance(message, dict) or message.get("type") != "update":
                continue
            entry["state"] = message
            _latest_state = message
            _latest_channel = channel
            # Broadcast to every other socket on this channel (there may be
            # several glasses screens, or none yet) - never back to the
            # sender, which already has this exact state - and to every
            # ambient/no-channel follower regardless of which channel it is.
            await _broadcast(entry["sockets"], message, exclude=websocket)
            await _broadcast(_latest_followers, message)
    except WebSocketDisconnect:
        pass
    finally:
        entry["sockets"].discard(websocket)
        if not entry["sockets"]:
            _channels.pop(channel, None)


@router.websocket("/ws/live")
async def live_latest(websocket: WebSocket):
    """Ambient mode: a glasses screen opened with no ?c= connects here
    instead of to a specific channel, and always tracks whichever channel
    most recently published an update (see _latest_state/_latest_followers
    above) - "the page that most recently did live-to-glasses", without
    needing to know its channel id.

    Unlike /ws/live/{channel}, there's no unguessable secret standing in
    for access control here - "show me whatever's currently live, from
    anyone" is exactly the point of ambient mode, so without a check here
    it would leak to literally anyone who found this URL, no matter what
    else is locked down. Gated on the app's own passcode (see
    Settings.app_passcode / auth.py) instead - passed as a query param
    (glasses/app.js reads it from the page's own ?pin=, set once when the
    glasses' web app URL itself is configured, since the device has no way
    to type it interactively) rather than a session cookie, since nothing
    else about this websocket goes through AuthMiddleware either (it only
    wraps http-scope requests - see auth.py). A no-op, like every other
    passcode check in this app, until APP_PASSCODE is actually set."""
    if settings.app_passcode and websocket.query_params.get("pin") != settings.app_passcode:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    _latest_followers.add(websocket)
    try:
        if _latest_state is not None:
            await websocket.send_json(_latest_state)
        while True:
            # The only thing a screen sends here is a command (see
            # _COMMAND_ACTIONS). An ambient screen has no channel of its
            # own, so it goes to whichever channel it's currently showing.
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if _is_command(message) and _latest_channel in _channels:
                await _broadcast(_channels[_latest_channel]["sockets"], message)
    except WebSocketDisconnect:
        pass
    finally:
        _latest_followers.discard(websocket)

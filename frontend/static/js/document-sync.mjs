// Read-only saved-snapshot subscription. The iPhone is the sole writer.
export function createDocumentFollower({ onUpdate, WebSocketClass = WebSocket, location = globalThis.location,
  retryMs = 1200, heartbeatMs = 20000 }) {
  let identity = null, socket = null, retry = null, heartbeat = null;
  function disconnect() {
    clearTimeout(retry); clearInterval(heartbeat);
    retry = heartbeat = null;
    if (socket) { socket.onclose = socket.onmessage = socket.onerror = null; socket.close(); socket = null; }
  }
  function connect() {
    if (!identity) return;
    const ref = identity;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const path = [ref.projectId, ref.sessionId, ref.filename].map(encodeURIComponent).join("/");
    const ws = socket = new WebSocketClass(`${scheme}//${location.host}/ws/documents/${path}`);
    ws.onmessage = (event) => {
      if (socket !== ws || identity !== ref) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (["ready", "update"].includes(message.type) && typeof message.content === "string" && typeof message.version === "string") {
        onUpdate(ref, message);
      }
    };
    ws.onopen = () => {
      if (socket !== ws) return;
      heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, heartbeatMs);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (socket !== ws) return;
      clearInterval(heartbeat);
      socket = null;
      if (identity === ref) retry = setTimeout(connect, retryMs);
    };
  }
  return {
    follow(ref) {
      const next = ref && ref.projectId && ref.sessionId && ref.filename ? ref : null;
      const key = value => value && JSON.stringify([value.projectId, value.sessionId, value.filename]);
      if (key(next) === key(identity)) return;
      disconnect(); identity = next ? { ...next } : null; connect();
    },
    close() { disconnect(); identity = null; },
  };
}

const BASE = "/api";

// A session that expired (or was never established) mid-use surfaces here
// as any API call suddenly 401ing, not as a page-load redirect (see
// auth.AuthMiddleware, which only redirects a top-level navigation - an
// in-page fetch() gets a plain 401 instead so this can catch it). Bouncing
// straight to /login is friendlier than every caller's own catch block
// showing a raw "Not authenticated" alert.
function redirectToLoginIfUnauthorized(res) {
  if (res.status === 401) {
    window.location.href = "/login";
    return true;
  }
  return false;
}

async function asJson(res) {
  if (redirectToLoginIfUnauthorized(res)) return new Promise(() => {}); // navigating away
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getProviders() {
  return fetch(`${BASE}/providers`).then(asJson);
}

// ---------- Hermes agent sessions (read-only) ----------
// Proxied through the backend (see routers/hermes.py) so the gateway's own
// API key never reaches the browser.

export function getHermesConfig() {
  return fetch(`${BASE}/hermes/config`).then(asJson);
}

export function getHermesSessions(offset = 0) {
  return fetch(`${BASE}/hermes/sessions?offset=${offset}`).then(asJson);
}

export function getHermesSessionMessages(sessionId) {
  return fetch(`${BASE}/hermes/sessions/${encodeURIComponent(sessionId)}/messages`).then(asJson);
}

// ---------- projects ----------

export function listProjects() {
  return fetch(`${BASE}/projects`).then(asJson);
}

export function createProject(title) {
  return fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(asJson);
}

export function deleteProject(id) {
  return fetch(`${BASE}/projects/${id}`, { method: "DELETE" }).then(asJson);
}

export function renameProject(id, title) {
  return fetch(`${BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(asJson);
}

export function getProjectSystemPrompt(id) {
  return fetch(`${BASE}/projects/${id}/system-prompt`).then(asJson);
}

export function saveProjectSystemPrompt(id, content) {
  return fetch(`${BASE}/projects/${id}/system-prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).then(asJson);
}

// ---------- conversations (sessions), nested under a project ----------

export function listConversations(projectId) {
  return fetch(`${BASE}/projects/${projectId}/conversations`).then(asJson);
}

export function createConversation(projectId, title, parentId = null) {
  return fetch(`${BASE}/projects/${projectId}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, parent_id: parentId }),
  }).then(asJson);
}

export function getConversation(projectId, id) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}`).then(asJson);
}

export function deleteConversation(projectId, id) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}`, { method: "DELETE" }).then(asJson);
}

export function renameConversation(projectId, id, title) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(asJson);
}

export function moveConversation(projectId, id, parentId) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_id: parentId }),
  }).then(asJson);
}

export function listDocuments(projectId, id) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents`).then(asJson);
}

export function createDraft(projectId, id) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents`, { method: "POST" }).then(asJson);
}

export function saveDocument(projectId, id, filename, content) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).then(asJson);
}

// One open document's state on the server, for picking up saves made in
// another browser (see app.js's "edits from elsewhere" section). With
// `since` equal to the server's current version the reply is just
// {changed: false, version} - no content - so polling costs next to nothing.
export function pollDocument(projectId, id, filename, since) {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}${query}`).then(asJson);
}

export function deleteDocument(projectId, id, filename) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  }).then(asJson);
}

export function renameDocument(projectId, id, filename, newFilename) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_filename: newFilename }),
  }).then(asJson);
}

export function moveDocument(projectId, id, filename, targetConvId) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_conv_id: targetConvId }),
  }).then(asJson);
}

export function copyDocument(projectId, id, filename, targetConvId) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_conv_id: targetConvId }),
  }).then(asJson);
}

export function revertToDraft(projectId, id, filename) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/revert-to-draft`, {
    method: "POST",
  }).then(asJson);
}

export function publishDocument(projectId, id, filename) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/publish`, {
    method: "POST",
  }).then(asJson);
}

// See storage.set_publish_slides - only valid for an already-published document.
export function setPublishSlides(projectId, id, filename, slides) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/publish`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slides }),
  }).then(asJson);
}

export function unpublishDocument(projectId, id, filename) {
  return fetch(`${BASE}/projects/${projectId}/conversations/${id}/documents/${encodeURIComponent(filename)}/publish`, {
    method: "DELETE",
  }).then(asJson);
}

export function getGlobalSystemPrompt() {
  return fetch(`${BASE}/system-prompt`).then(asJson);
}

export function saveGlobalSystemPrompt(content) {
  return fetch(`${BASE}/system-prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).then(asJson);
}

export function getCustomSymbols() {
  return fetch(`${BASE}/custom-symbols`).then(asJson);
}

export function saveCustomSymbols(content) {
  return fetch(`${BASE}/custom-symbols`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).then(asJson);
}

export function getSpokenMath() {
  return fetch(`${BASE}/spoken-math`).then(asJson);
}

export function saveSpokenMath(content) {
  return fetch(`${BASE}/spoken-math`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).then(asJson);
}

// On-demand whole-document LaTeX -> AsciiMath2 conversion for the format
// radio in the editor toolbar - not tied to sending a message. The reverse
// direction (AsciiMath2 -> LaTeX) is done client-side; see asciimath-markdown's
// convertAsciiMathToLatex.
export function convertToAsciiMath(content, hybrid = false) {
  return fetch(`${BASE}/convert-to-asciimath`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, hybrid }),
  }).then(asJson);
}

// Shared by sendMessage and inlineComplete below - both endpoints stream
// NDJSON (one JSON object per line) the same way, just with different
// per-line "type"s. Throws with the server's own detail message for a
// non-OK/non-streaming response, same as the old inline version either
// call used to have.
async function streamNdjson(res, onEvent) {
  if (redirectToLoginIfUnauthorized(res)) return new Promise(() => {}); // navigating away
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) await onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) await onEvent(JSON.parse(buffer));
}

// Streams NDJSON lines from the server, invoking onEvent for each parsed
// object: {type: "user_turn"|"delta"|"assistant_turn"|"error", ...}
// provider/model/reasoning_effort/convert_math/contextScope are this turn's
// settings - chosen fresh per message, not fixed for the whole session.
// contextScope ("default"/"sibling"/"descendants" - see the context-scope
// select in the send toolbar) decides how much prior conversation this one
// call includes; the turn itself is always recorded in the session the
// same way regardless.
export async function sendMessage(projectId, id, content, settings, onEvent) {
  const res = await fetch(`${BASE}/projects/${projectId}/conversations/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      provider: settings.provider,
      model: settings.model,
      reasoning_effort: settings.reasoningEffort,
      convert_math: settings.convertMath,
      hybrid_math: settings.hybridMath,
      context_scope: settings.contextScope,
      draft_filename: settings.draftFilename || null,
      retry_turn_id: settings.retryTurnId || null,
      language: settings.language,
    }),
  });
  await streamNdjson(res, onEvent);
}

// app.js's inline-send mode (a draft document, cursor mid-document) - the
// lightest possible sibling of sendMessage: no history/turn settings at
// all, just this one sentence in. Streams {"type": "delta", "text"} the
// same way, ending in {"type": "done", "text": <final text>} instead of
// "assistant_turn" - see routers/conversations.py's inline_complete.
// `history` is the inline thread's earlier turns, parsed client-side out of
// the document itself (see app.js's parseInlineThread) - the thread lives in
// the document, so there's nothing on the server to look it up from.
// `context` is the document text above the question (threads stripped), so
// the question can refer to what it's sitting in.
export async function inlineComplete(projectId, id, content, history, context, settings, onEvent) {
  const res = await fetch(`${BASE}/projects/${projectId}/conversations/${id}/inline-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      history,
      context,
      provider: settings.provider,
      model: settings.model,
      reasoning_effort: settings.reasoningEffort,
      convert_math: settings.convertMath,
      hybrid_math: settings.hybridMath,
    }),
  });
  await streamNdjson(res, onEvent);
}

// ---------- speaker-diarized transcription ----------
// See routers/transcribe.py. XHR rather than fetch() only because fetch has
// no upload-progress event, and a long recording is a big upload. The
// response is the same NDJSON event stream as sendMessage's, read
// incrementally off responseText as it grows: {"type": "status", stage},
// {"type": "heartbeat"}, then {"type": "document", document} or
// {"type": "error", message}.

export function getTranscribeConfig() {
  return fetch(`${BASE}/transcribe/config`).then(asJson);
}

export function transcribeAudio(projectId, id, file, { title, language, audioLanguage }, onEvent, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("title", title || "");
    form.append("language", language || "en");
    form.append("audio_language", audioLanguage || "");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/projects/${projectId}/conversations/${id}/transcribe`);
    let consumed = 0;
    const drain = (final) => {
      const text = xhr.responseText;
      const lines = text.slice(consumed).split("\n");
      const rest = final ? "" : lines.pop();
      consumed = text.length - rest.length;
      for (const line of lines) {
        if (line.trim()) onEvent(JSON.parse(line));
      }
    };
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) onUploadProgress(e.loaded / e.total);
    };
    xhr.onprogress = () => {
      if (xhr.status === 200) drain(false);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (xhr.status !== 200) {
        let detail = `Request failed: ${xhr.status}`;
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {}
        reject(new Error(detail));
        return;
      }
      drain(true);
      resolve();
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

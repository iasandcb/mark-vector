// Split-view voice discussion. Soniox (the same capture path as ✦ dictation)
// turns speech into text; the model selected in the toolbar answers in text
// and, only when asked, edits the open document with the existing edit blocks.
// There is no spoken reply.

import * as api from "./api.js";
import { captureAudio } from "./mic-capture.mjs";
import { startSonioxTranscription } from "./soniox-stt.js";
import { fileErrorText } from "./file-dictation.mjs";
import { createDiscussionController, DEFAULT_SILENCE_MS } from "./discussion-turn.mjs";
import {
  DISCUSS_MAX_MS,
  boundDiscussionHistory,
  discussionDocumentView,
  discussExpired,
  formatDiscussMeter,
  formatDocumentContext,
} from "./discussion-context.mjs";
import { applyEditsToEditor, planDiscussionEdits, undoEditOnEditor } from "./discussion-edits.mjs";
import {
  audioContextNeedsResume,
  discussCaptureAction,
  discussResumeAction,
  discussSocketAction,
} from "./discussion-audio.mjs";

const SILENCE_KEY = "mark-vector:discuss-silence";
// Shorter than Soniox's 2000ms default, so `<end>` usually wins and the
// 1.5s silence timer stays a fallback. Dictation does not pass this.
const ENDPOINT_DELAY_MS = 800;

function storedSilenceMs() {
  try {
    const seconds = Number(localStorage.getItem(SILENCE_KEY));
    if (Number.isFinite(seconds) && seconds >= 0.4 && seconds <= 8) return Math.round(seconds * 1000);
  } catch (err) {
    // private mode — the field just shows the default
  }
  return DEFAULT_SILENCE_MS;
}

export function mountDiscussion(deps) {
  const pane = document.getElementById("discuss-pane");
  const editorPane = document.getElementById("editor-pane");
  const toggleBtn = document.getElementById("discuss-toggle-btn");
  const log = document.getElementById("discuss-log");
  const empty = document.getElementById("discuss-empty");
  const partial = document.getElementById("discuss-partial");
  const statusEl = document.getElementById("discuss-status");
  const markerEl = document.getElementById("discuss-markers");
  const meterEl = document.getElementById("discuss-meter");
  const silenceInput = document.getElementById("discuss-silence");
  const startBtn = document.getElementById("discuss-start");
  const stopBtn = document.getElementById("discuss-stop");
  const muteBtn = document.getElementById("discuss-mute");
  const pttBtn = document.getElementById("discuss-ptt");
  const sendBtn = document.getElementById("discuss-send");
  const undoBtn = document.getElementById("discuss-undo");
  const talkTab = document.getElementById("discuss-tab-talk");
  const docTab = document.getElementById("discuss-tab-doc");
  if (!pane || !toggleBtn) return { listening: () => false, stop() {}, open: () => false };

  const controller = createDiscussionController({
    silenceMs: storedSilenceMs(),
    log(entry) {
      // Whether `<end>` shows up on a real socket is visible here and in the
      // marker line. Headless tests feed the token; they do not open Soniox.
      console.info("[discuss]", entry);
      if (entry.kind === "marker" && markerEl) {
        markerEl.textContent = deps.t("discuss.marker", { end: entry.stats.end, fin: entry.stats.fin });
      }
    },
  });

  const turns = [];
  const undoStack = [];
  const inflight = new Map();
  let lastUser = null;
  let audioContext = null;
  let mic = null;
  let starting = false;
  let userStopped = false;
  let micClaimed = false;
  let reconnects = 0;
  let reconnecting = false;
  let startedAt = 0;
  let ptt = false;
  let muted = false;
  let tickTimer = null;
  let meterTimer = null;
  let flashTimer = null;

  silenceInput.value = String(storedSilenceMs() / 1000);

  function setStatus(text) {
    statusEl.textContent = text || "";
  }

  function editorAdapter() {
    return {
      get value() {
        return deps.readContent();
      },
      replaceRange(from, to, text) {
        deps.applyRange(from, to, text);
      },
      setSelectionRange(start, end) {
        deps.selectRange(start, end);
      },
    };
  }

  function flash(start, end) {
    deps.selectRange(start, end);
    const column = document.getElementById("editor-column");
    if (!column) return;
    column.classList.add("discuss-flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => column.classList.remove("discuss-flash"), 1600);
  }

  function updateUndo() {
    undoBtn.disabled = undoStack.length === 0;
  }

  function addBubble(role, text) {
    empty.hidden = true;
    const row = document.createElement("div");
    row.className = `discuss-bubble discuss-${role}`;
    const who = document.createElement("span");
    who.className = "discuss-who";
    who.textContent = deps.t(role === "user" ? "discuss.you" : "discuss.assistant");
    const body = document.createElement("p");
    body.textContent = text;
    row.append(who, body);
    log.append(row);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function setPartial(text) {
    partial.textContent = text || "";
    partial.hidden = !text;
  }

  function wantMic() {
    return !muted && !ptt;
  }

  function setTracks(on) {
    const stream = mic && mic.stream;
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = on;
    });
  }

  function updateButtons() {
    const live = !!(mic || starting) && !userStopped;
    const resume = !!(audioContext && audioContextNeedsResume(audioContext.state) && !userStopped);
    startBtn.hidden = live && !resume;
    stopBtn.hidden = !live;
    startBtn.textContent = resume ? deps.t("discuss.resume") : deps.t("discuss.start");
    muteBtn.textContent = muted ? deps.t("discuss.unmute") : deps.t("discuss.mute");
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
    pttBtn.setAttribute("aria-pressed", ptt ? "true" : "false");
    sendBtn.disabled = !live;
    muteBtn.disabled = !live;
  }

  function watchTracks(session) {
    const stream = session.stream;
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (mic !== session || userStopped || muted || ptt) return;
        if (document.hidden || (audioContext && audioContextNeedsResume(audioContext.state))) {
          setStatus(deps.t("discuss.interrupted"));
          return;
        }
        reconnect();
      });
    });
  }

  function onContextState() {
    if (!audioContext || userStopped) return;
    const action = discussCaptureAction(audioContext.state, { userStopped, started: !!mic || starting });
    if (action.hold && mic) mic.hold();
    if (action.resumeContext) audioContext.resume().catch(() => {});
    if (audioContext.state === "interrupted") setStatus(deps.t("discuss.interrupted"));
    updateButtons();
  }

  function onVisibility() {
    if (!audioContext || userStopped) return;
    if (document.hidden) {
      if (mic) mic.hold();
      return;
    }
    const action = discussResumeAction({
      contextState: audioContext.state,
      interrupted: audioContext.state === "interrupted",
      sttOpen: !!(mic && mic.alive()),
      reconnects,
      reconnecting,
      started: true,
    });
    if (action.resumeContext) audioContext.resume().catch(() => {});
    if (action.reconnect) reconnect();
    else if (action.giveUp) setStatus(deps.t("discuss.failed", { message: "reconnect" }));
  }

  async function openMic() {
    return startSonioxTranscription({
      language: deps.dictationLanguage(),
      audioContext,
      audio: captureAudio(),
      idleMs: null,
      terms: deps.spokenTerms,
      maxEndpointDelayMs: ENDPOINT_DELAY_MS,
      onTokens(message) {
        if (userStopped) return;
        reconnects = 0;
        handle(controller.push(message.tokens || [], Date.now()));
      },
      onError(error) {
        if (userStopped) return;
        const message = fileErrorText(error);
        const action = discussSocketAction({ message, hidden: document.hidden, reconnects, reconnecting });
        if (action === "reconnect") {
          reconnects += 1;
          reconnect();
          return;
        }
        if (action === "wait") {
          setStatus(deps.t("discuss.interrupted"));
          return;
        }
        if (action === "popup") {
          setStatus(deps.t("discuss.failed", { message: message || "error" }));
          stopMic();
          return;
        }
        if (message) setStatus(message);
      },
    });
  }

  async function reconnect() {
    if (reconnecting || userStopped) return;
    reconnecting = true;
    setStatus(deps.t("discuss.reconnecting"));
    const previous = mic;
    mic = null;
    if (previous) previous.stop({ keepContext: true });
    try {
      const session = await openMic();
      if (userStopped) {
        session.stop({ keepContext: true });
        return;
      }
      mic = session;
      setTracks(wantMic());
      watchTracks(session);
      setStatus(deps.t("discuss.listening"));
    } catch (err) {
      setStatus(deps.t("discuss.failed", { message: err.message }));
    } finally {
      reconnecting = false;
      updateButtons();
    }
  }

  function stopMic() {
    userStopped = true;
    starting = false;
    clearInterval(tickTimer);
    clearInterval(meterTimer);
    tickTimer = meterTimer = null;
    if (mic) mic.stop();
    mic = null;
    if (audioContext) {
      audioContext.removeEventListener("statechange", onContextState);
      audioContext.close().catch(() => {});
    }
    audioContext = null;
    deps.setAwake(false);
    if (micClaimed && deps.setMicLive) {
      deps.setMicLive(false);
      micClaimed = false;
    }
    setPartial("");
    setStatus(deps.t("discuss.idle"));
    if (meterEl) meterEl.textContent = "";
    updateButtons();
  }

  function start() {
    if (mic || starting) return;
    if (!deps.sonioxReady()) {
      setStatus(deps.t("discuss.noSoniox"));
      return;
    }
    if (!deps.documentTarget()) {
      setStatus(deps.t("discuss.noDoc"));
      return;
    }
    userStopped = false;
    starting = true;
    deps.stopDictation();
    deps.setAudioSession("auto");
    // auto, not playback: this open uses the microphone (play-and-record).
    if (!micClaimed && deps.setMicLive) {
      deps.setMicLive(true);
      micClaimed = true;
    }
    // Created inside the click, before any await — iOS will not resume a
    // context that was born after the gesture ended.
    audioContext = new AudioContext();
    audioContext.addEventListener("statechange", onContextState);
    if (audioContextNeedsResume(audioContext.state)) audioContext.resume().catch(() => {});
    deps.setAwake(true);
    startedAt = Date.now();
    setStatus(deps.t("discuss.connecting"));
    updateButtons();
    tickTimer = setInterval(() => {
      handle(controller.tick(Date.now()));
      if (startedAt && discussExpired(Date.now() - startedAt, DISCUSS_MAX_MS)) {
        setStatus(deps.t("discuss.max", { minutes: Math.round(DISCUSS_MAX_MS / 60000) }));
        stopMic();
      }
    }, 200);
    meterTimer = setInterval(() => {
      if (!startedAt) return;
      const shown = formatDiscussMeter(Date.now() - startedAt);
      meterEl.textContent = deps.t("discuss.cost", shown);
    }, 1000);
    openMic()
      .then((session) => {
        starting = false;
        if (userStopped) {
          session.stop();
          return;
        }
        mic = session;
        setTracks(wantMic());
        watchTracks(session);
        setStatus(deps.t("discuss.listening"));
        updateButtons();
      })
      .catch((err) => {
        starting = false;
        setStatus(deps.t("discuss.failed", { message: err.message }));
        stopMic();
      });
  }

  function resume() {
    if (!audioContext) return start();
    audioContext.resume().catch(() => {});
    const action = discussResumeAction({
      contextState: audioContext.state,
      interrupted: true,
      sttOpen: !!(mic && mic.alive()),
      reconnects,
      reconnecting,
      started: true,
    });
    if (action.reconnect) reconnect();
    else setStatus(deps.t("discuss.listening"));
    updateButtons();
  }

  function abortRequest(id) {
    const job = inflight.get(id);
    if (!job) return;
    job.ac.abort();
    inflight.delete(id);
    if (job.applied) deps.restoreContent(job.snapshot);
    if (job.applied) {
      undoStack.splice(Math.max(0, undoStack.length - job.applied), job.applied);
      deps.onDocumentEdited();
    }
    job.assistant.remove();
    updateUndo();
  }

  async function ask(event) {
    const target = deps.documentTarget();
    const model = deps.modelChoice();
    if (!target) {
      setStatus(deps.t("discuss.noDoc"));
      controller.settle(event.requestId);
      return;
    }
    if (!model.provider || !model.model) {
      setStatus(deps.t("discuss.noModel"));
      controller.settle(event.requestId);
      return;
    }
    const reasonKey = event.reason === "endpoint" ? "discuss.endpoint" : event.reason === "manual" ? "discuss.manual" : "discuss.silence";
    setStatus(deps.t(reasonKey));
    if (event.merged && lastUser) lastUser.textContent = event.text;
    else lastUser = addBubble("user", event.text);
    const assistant = addBubble("assistant", "…");
    const snapshot = deps.readContent();
    const job = { ac: new AbortController(), assistant, snapshot, applied: 0, raw: "" };
    inflight.set(event.requestId, job);
    const view = discussionDocumentView(snapshot, event.text);
    const history = boundDiscussionHistory(turns);
    let failed = "";
    try {
      await api.discuss(
        target.projectId,
        target.sessionId,
        {
          content: event.text,
          history: history.history,
          summary: history.summary,
          target_document: { filename: target.filename, content: formatDocumentContext(view) },
          provider: model.provider,
          model: model.model,
          reasoning_effort: model.reasoningEffort || null,
          language: deps.getLanguage(),
        },
        (message) => {
          if (!inflight.has(event.requestId)) return;
          if (message.type === "delta") {
            job.raw += message.text || "";
            assistant.textContent = planDiscussionEdits(snapshot, job.raw, { final: false }).display || "…";
            const plan = planDiscussionEdits(snapshot, job.raw, { final: false });
            const fresh = plan.edits.slice(job.applied);
            if (fresh.length) {
              applyEditsToEditor(editorAdapter(), fresh);
              undoStack.push(...fresh);
              job.applied += fresh.length;
              const last = fresh[fresh.length - 1];
              flash(last.start, last.end);
              deps.onDocumentEdited();
            }
          } else if (message.type === "error") {
            failed = message.message || "error";
          } else if (message.type === "done" && typeof message.text === "string") {
            job.raw = message.text;
          }
        },
        job.ac.signal,
      );
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (!inflight.has(event.requestId)) return;
      assistant.textContent = err.message || String(err);
      inflight.delete(event.requestId);
      controller.settle(event.requestId);
      return;
    }
    if (!inflight.has(event.requestId)) return;
    inflight.delete(event.requestId);
    if (failed) {
      assistant.textContent = failed;
      controller.settle(event.requestId);
      return;
    }
    const plan = planDiscussionEdits(snapshot, job.raw, { final: true });
    const fresh = plan.edits.slice(job.applied);
    if (fresh.length) {
      applyEditsToEditor(editorAdapter(), fresh);
      undoStack.push(...fresh);
      const last = fresh[fresh.length - 1];
      flash(last.start, last.end);
      deps.onDocumentEdited();
    }
    assistant.textContent = plan.display || (plan.applied || job.applied ? deps.t("discuss.edited", { count: plan.applied || job.applied }) : deps.t("discuss.emptyReply"));
    if (plan.failed) setStatus(deps.t("discuss.editFailed", { count: plan.failed }));
    turns.push({ role: "user", content: event.text }, { role: "assistant", content: assistant.textContent });
    if (job.applied || fresh.length) {
      try {
        await deps.save();
      } catch (err) {
        setStatus(err.message);
      }
    }
    controller.settle(event.requestId);
    updateUndo();
    if (mic) setStatus(deps.t("discuss.listening"));
  }

  function handle(events) {
    for (const event of events) {
      if (event.type === "partial") setPartial(event.text);
      else if (event.type === "abort") abortRequest(event.requestId);
      else if (event.type === "send") void ask(event);
    }
  }

  function setOpen(open) {
    pane.hidden = !open;
    editorPane.classList.toggle("discuss-open", open);
    toggleBtn.setAttribute("aria-pressed", open ? "true" : "false");
    if (!open) stopMic();
  }

  toggleBtn.addEventListener("click", () => setOpen(pane.hidden));
  startBtn.addEventListener("click", () => {
    if (audioContext && audioContextNeedsResume(audioContext.state) && !userStopped) resume();
    else start();
  });
  stopBtn.addEventListener("click", stopMic);
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    setTracks(wantMic());
    updateButtons();
  });
  sendBtn.addEventListener("click", () => {
    if (mic && mic.commit) mic.commit();
    handle(controller.sendNow());
  });
  undoBtn.addEventListener("click", () => {
    const edit = undoStack[undoStack.length - 1];
    if (!undoEditOnEditor(editorAdapter(), edit)) {
      setStatus(deps.t("discuss.undoFailed"));
      return;
    }
    undoStack.pop();
    updateUndo();
    deps.onDocumentEdited();
    deps.save().catch((err) => setStatus(err.message));
  });
  silenceInput.addEventListener("change", () => {
    const seconds = Math.min(8, Math.max(0.4, Number(silenceInput.value) || 1.5));
    silenceInput.value = String(seconds);
    controller.setSilenceMs(Math.round(seconds * 1000));
    try {
      localStorage.setItem(SILENCE_KEY, String(seconds));
    } catch (err) {
      // the choice still applies to this page
    }
  });
  talkTab.addEventListener("click", () => {
    editorPane.classList.remove("discuss-show-doc");
    talkTab.setAttribute("aria-selected", "true");
    docTab.setAttribute("aria-selected", "false");
  });
  docTab.addEventListener("click", () => {
    editorPane.classList.add("discuss-show-doc");
    talkTab.setAttribute("aria-selected", "false");
    docTab.setAttribute("aria-selected", "true");
  });

  let pttDown = 0;
  pttBtn.addEventListener("pointerdown", (event) => {
    pttDown = performance.now();
    if (!ptt) return;
    event.preventDefault();
    try {
      pttBtn.setPointerCapture(event.pointerId);
    } catch (err) {
      // the button still receives pointerup
    }
    if (!mic && !starting) start();
    setTracks(true);
  });
  pttBtn.addEventListener("pointerup", () => {
    if (!ptt) return;
    if (performance.now() - pttDown < 250) return;
    setTracks(false);
    if (mic && mic.commit) mic.commit();
    handle(controller.sendNow());
  });
  pttBtn.addEventListener("click", () => {
    if (ptt && performance.now() - pttDown >= 250) return;
    ptt = !ptt;
    if (ptt) setTracks(false);
    else setTracks(!muted);
    updateButtons();
  });
  document.addEventListener("visibilitychange", onVisibility);
  updateUndo();
  updateButtons();

  return {
    listening: () => !!(mic || starting) && !userStopped,
    stop: stopMic,
    open: () => !pane.hidden,
  };
}

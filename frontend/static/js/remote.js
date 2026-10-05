// Gamepad remote: a controller in a plain-gamepad mode (e.g. an 8BitDo
// Micro in its "D" / Android mode) drives app actions through the browser's
// Gamepad API. Unlike a keyboard-mode remote, its buttons never reach the
// focused editor as keystrokes - which is the point while dictation is
// typing into it.
//
// Button numbering differs between controllers, modes and browsers (only a
// pad Chrome recognizes gets the "standard" layout), so bindings are learned
// rather than assumed: the settings dialog asks for a press and records
// whatever moved - a button, or an axis leaving its resting value (a stick,
// or a D-pad that reports itself as a hat-switch axis). The defaults below
// assume the standard layout and are only a starting point.
//
// The Gamepad API has no input events: state is polled every animation
// frame while a pad is connected, and an action fires on the press edge.
// Browsers only expose a pad to the page after one of its buttons has been
// pressed with the page in front, and only deliver input to a visible page.

import { t } from "./i18n.js";

const BINDINGS_KEY = "mark-vector:gamepad-bindings";
const AXIS_PRESS_DELTA = 0.5;
const AXIS_MATCH_TOLERANCE = 0.15;

function loadBindings(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(BINDINGS_KEY) || "null");
    if (saved && typeof saved === "object") return { ...defaults, ...saved };
  } catch (err) {
    // unreadable or unavailable - fall back to the defaults
  }
  return { ...defaults };
}

function saveBindings(bindings) {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
  } catch (err) {
    // the bindings just won't survive a reload
  }
}

function connectedPads() {
  return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
}

function isPressed(pad, binding) {
  if (!binding) return false;
  if (binding.type === "button") {
    const button = pad.buttons[binding.index];
    return !!button && (button.pressed || button.value > 0.5);
  }
  const value = pad.axes[binding.index];
  return value !== undefined && Math.abs(value - binding.value) < AXIS_MATCH_TOLERANCE;
}

function bindingLabel(binding) {
  if (!binding) return t("remote.unbound");
  if (binding.type === "button") return t("remote.button", { n: binding.index });
  return t("remote.axis", { n: binding.index, value: binding.value.toFixed(2) });
}

// `actions`: [{ id, label, defaultBinding }] in the order the settings
// dialog lists them. `onAction(id)` runs on each press. `onConnectionChange
// (pad | null)` reports the first connected pad, for an indicator.
export function createGamepadRemote({ actions, onAction, onConnectionChange }) {
  const defaults = Object.fromEntries(actions.map((a) => [a.id, a.defaultBinding || null]));
  let bindings = loadBindings(defaults);
  const wasPressed = new Map(); // `${padIndex}:${actionId}` -> bool
  let learning = null; // { actionId, baseline: Map(padIndex -> axes[]), done(binding|null) }
  let frame = null;

  function poll() {
    frame = null;
    const pads = connectedPads();
    if (!pads.length) return;
    if (learning) {
      pollLearning(pads);
    } else if (!document.hidden) {
      for (const pad of pads) {
        for (const action of actions) {
          const key = `${pad.index}:${action.id}`;
          const pressed = isPressed(pad, bindings[action.id]);
          if (pressed && !wasPressed.get(key)) onAction(action.id);
          wasPressed.set(key, pressed);
        }
      }
    }
    frame = requestAnimationFrame(poll);
  }

  function pollLearning(pads) {
    for (const pad of pads) {
      const buttonIndex = pad.buttons.findIndex((b) => b.pressed);
      if (buttonIndex !== -1) {
        finishLearning({ type: "button", index: buttonIndex });
        return;
      }
      const baseline = learning.baseline.get(pad.index) || [];
      const axisIndex = pad.axes.findIndex((v, i) => Math.abs(v - (baseline[i] ?? 0)) > AXIS_PRESS_DELTA);
      if (axisIndex !== -1) {
        finishLearning({ type: "axis", index: axisIndex, value: Math.round(pad.axes[axisIndex] * 100) / 100 });
        return;
      }
    }
  }

  function finishLearning(binding) {
    const job = learning;
    learning = null;
    if (binding) {
      // One control, one action: taking a control away from whatever else
      // had it, rather than leaving one press firing two actions.
      for (const id of Object.keys(bindings)) {
        if (id !== job.actionId && JSON.stringify(bindings[id]) === JSON.stringify(binding)) bindings[id] = null;
      }
      bindings[job.actionId] = binding;
      saveBindings(bindings);
    }
    // Whatever was used to bind shouldn't also fire its (new) action the
    // moment learning ends while it's still held down.
    for (const pad of connectedPads()) {
      for (const action of actions) wasPressed.set(`${pad.index}:${action.id}`, isPressed(pad, bindings[action.id]));
    }
    job.done(binding);
  }

  function ensurePolling() {
    if (frame === null && connectedPads().length) frame = requestAnimationFrame(poll);
  }

  window.addEventListener("gamepadconnected", (e) => {
    onConnectionChange(e.gamepad);
    ensurePolling();
  });
  window.addEventListener("gamepaddisconnected", () => {
    onConnectionChange(connectedPads()[0] || null);
  });
  // A pad already exposed before this ran (e.g. after a reload, once a
  // button has been pressed on this origin) fires no "connected" event.
  if (connectedPads().length) {
    onConnectionChange(connectedPads()[0]);
    ensurePolling();
  }

  function openSettings() {
    const overlay = document.createElement("div");
    overlay.className = "quick-open-overlay";
    overlay.innerHTML = `
      <div class="quick-open-panel remote-panel" role="dialog" aria-modal="true">
        <div class="shortcuts-header">
          <span></span>
          <button class="icon-btn" type="button" data-close>×</button>
        </div>
        <div class="remote-body">
          <p class="remote-status" data-status></p>
          <div class="remote-rows" data-rows></div>
          <div class="remote-actions">
            <button type="button" class="secondary-btn" data-reset></button>
          </div>
        </div>
      </div>`;
    const $ = (sel) => overlay.querySelector(sel);
    $(".shortcuts-header span").textContent = t("remote.title");
    $("[data-close]").title = t("ui.close");
    $("[data-reset]").textContent = t("remote.reset");
    document.body.appendChild(overlay);

    const renderStatus = () => {
      const pad = connectedPads()[0];
      $("[data-status]").textContent = pad ? t("remote.connected", { id: pad.id }) : t("remote.notConnected");
    };

    const renderRows = () => {
      const rows = $("[data-rows]");
      rows.innerHTML = "";
      for (const action of actions) {
        const row = document.createElement("div");
        row.className = "remote-row";
        const name = document.createElement("span");
        name.className = "remote-row-name";
        name.textContent = action.label;
        const current = document.createElement("span");
        current.className = "remote-row-binding";
        current.textContent = learning && learning.actionId === action.id ? t("remote.pressNow") : bindingLabel(bindings[action.id]);
        const assign = document.createElement("button");
        assign.type = "button";
        assign.className = "secondary-btn";
        assign.textContent = t("remote.assign");
        assign.disabled = !!learning || !connectedPads().length;
        assign.addEventListener("click", () => {
          learning = {
            actionId: action.id,
            baseline: new Map(connectedPads().map((p) => [p.index, [...p.axes]])),
            done: () => renderRows(),
          };
          ensurePolling();
          renderRows();
        });
        row.append(name, current, assign);
        rows.appendChild(row);
      }
    };

    const close = () => {
      if (learning) finishLearning(null);
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("gamepadconnected", onPadChange);
      window.removeEventListener("gamepaddisconnected", onPadChange);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (learning) finishLearning(null);
      else close();
    };
    const onPadChange = () => {
      renderStatus();
      renderRows();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("gamepadconnected", onPadChange);
    window.addEventListener("gamepaddisconnected", onPadChange);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    $("[data-close]").addEventListener("click", close);
    $("[data-reset]").addEventListener("click", () => {
      bindings = { ...defaults };
      saveBindings(bindings);
      renderRows();
    });
    renderStatus();
    renderRows();
  }

  return { openSettings };
}

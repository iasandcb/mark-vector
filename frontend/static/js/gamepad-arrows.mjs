// Android Chrome registers some keyboards (Bluetooth, a cover keyboard, the
// virtual DPAD device) as joysticks. Once this page has touched the Gamepad
// API, Chrome consumes KEYCODE_DPAD_* before the page sees a keydown, and
// reports the same press as standard D-pad buttons 12-15. Those are the
// presenter remote's previous/next/first/last bindings, so an arrow in the
// editor used to show the gamepad button and "1 / 1" instead of moving the
// caret. A real controller (including an 8BitDo in its Android / D-input
// mode, which often has an empty mapping and a real vendor id) must still
// come through here as a controller.

const KEYBOARD_PAD_NAME = /keyboard|keypad|gpio-keys|qwerty|gboard|swiftkey|uinput|^virtual$|^virtual keyboard$/i;

// Standard layout: 12 up, 13 down, 14 left, 15 right. Chrome's Android
// mapping puts KEYCODE_DPAD_* on these indexes for both recognized pads and
// the "unknown" mapping a keyboard gets.
const DPAD_BUTTONS = [
  ["ArrowUp", 12],
  ["ArrowDown", 13],
  ["ArrowLeft", 14],
  ["ArrowRight", 15],
];

export const ARROW_REPEAT_DELAY = 400;
export const ARROW_REPEAT_INTERVAL = 50;

export function gamepadProductName(id) {
  const text = String(id || "").trim();
  const match = /^(.*?)(?:\s+\((?:STANDARD GAMEPAD|XR-STANDARD GAMEPAD|Vendor:|Extended Gamepad))/i.exec(text);
  return (match ? match[1] : text).trim();
}

export function isKeyboardAsGamepad(pad) {
  if (!pad) return false;
  const id = String(pad.id || "");
  if (KEYBOARD_PAD_NAME.test(gamepadProductName(id))) return true;
  // A pad Chrome recognized (Xbox, Switch, …) keeps working even if the
  // platform left the vendor id blank.
  if (pad.mapping === "standard" || pad.mapping === "xr-standard") return false;
  const ids = /Vendor:\s*([0-9a-f]+)\s+Product:\s*([0-9a-f]+)/i.exec(id);
  // Android's virtual input device, the one that appears the moment an
  // arrow key is pressed, is vendor 0000 product 0000.
  return !!(ids && /^0+$/.test(ids[1]) && /^0+$/.test(ids[2]));
}

function buttonDown(button) {
  if (!button) return false;
  if (typeof button === "number") return button > 0.5;
  return !!(button.pressed || button.value > 0.5);
}

// The direction a keyboard-shaped pad is holding, or null. Buttons win;
// a hat that never became buttons is axes 0/1 at a full -1 or +1.
export function dpadArrow(pad) {
  if (!pad) return null;
  const buttons = pad.buttons || [];
  for (const [key, index] of DPAD_BUTTONS) {
    if (buttonDown(buttons[index])) return key;
  }
  const axes = pad.axes || [];
  const x = Number(axes[0]) || 0;
  const y = Number(axes[1]) || 0;
  if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return null;
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? "ArrowUp" : "ArrowDown";
  return x < 0 ? "ArrowLeft" : "ArrowRight";
}

// `state` is { key, nextAt } while a direction is held. The first sample
// emits immediately; further samples wait out the delay, then the interval,
// so a tap moves once and a hold repeats instead of stepping every frame.
export function nextKeyboardArrow(state, arrow, now, delay = ARROW_REPEAT_DELAY, interval = ARROW_REPEAT_INTERVAL) {
  if (!arrow) return { state: null, emit: null };
  if (!state || state.key !== arrow) {
    return { state: { key: arrow, nextAt: now + delay }, emit: arrow };
  }
  if (now < state.nextAt) return { state, emit: null };
  return { state: { key: arrow, nextAt: now + interval }, emit: arrow };
}

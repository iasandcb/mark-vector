import assert from "node:assert/strict";
import test from "node:test";
import {
  ARROW_REPEAT_DELAY,
  ARROW_REPEAT_INTERVAL,
  dpadArrow,
  gamepadProductName,
  isKeyboardAsGamepad,
  nextKeyboardArrow,
} from "./gamepad-arrows.mjs";

function button(pressed) {
  return { pressed, value: pressed ? 1 : 0 };
}

function pad(id, { mapping = "", buttons = [], axes = [] } = {}) {
  return { id, mapping, buttons, axes, index: 0 };
}

const arrows = () => Array.from({ length: 16 }, () => button(false));

test("product name stops before Chrome's vendor suffix", () => {
  assert.equal(gamepadProductName("8BitDo Micro (Vendor: 2dc8 Product: 3106)"), "8BitDo Micro");
  assert.equal(
    gamepadProductName("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"),
    "Xbox Wireless Controller"
  );
  assert.equal(gamepadProductName("Virtual (Vendor: 0000 Product: 0000)"), "Virtual");
});

test("a keyboard or the Android virtual device is not a controller", () => {
  assert.equal(isKeyboardAsGamepad(pad("Bluetooth Keyboard (Vendor: 05ac Product: 0267)")), true);
  assert.equal(isKeyboardAsGamepad(pad("gpio-keys (Vendor: 0001 Product: 0001)")), true);
  assert.equal(isKeyboardAsGamepad(pad("Gboard (Vendor: 0000 Product: 0000)")), true);
  assert.equal(isKeyboardAsGamepad(pad("Virtual (Vendor: 0000 Product: 0000)")), true);
  assert.equal(isKeyboardAsGamepad(pad(" (Vendor: 0000 Product: 0000)")), true);
});

test("an 8BitDo in Android mode and a recognized pad stay controllers", () => {
  assert.equal(isKeyboardAsGamepad(pad("8BitDo Micro (Vendor: 2dc8 Product: 3106)", { mapping: "" })), false);
  assert.equal(
    isKeyboardAsGamepad(pad("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)", { mapping: "standard" })),
    false
  );
  assert.equal(isKeyboardAsGamepad(pad("Wireless Controller (Vendor: 054c Product: 09cc)", { mapping: "" })), false);
  assert.equal(
    isKeyboardAsGamepad(pad("Unknown (STANDARD GAMEPAD Vendor: 0000 Product: 0000)", { mapping: "standard" })),
    false
  );
});

test("keyboard D-pad buttons are the arrow keys, not slide bindings", () => {
  const buttons = arrows();
  buttons[12] = button(true);
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { buttons })), "ArrowUp");
  buttons[12] = button(false);
  buttons[14] = button(true);
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { buttons })), "ArrowLeft");
  buttons[14] = button(false);
  buttons[15] = button(true);
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { buttons })), "ArrowRight");
  buttons[15] = button(false);
  buttons[13] = button(true);
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { buttons })), "ArrowDown");
});

test("a hat axis is an arrow when the D-pad buttons stay up", () => {
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { axes: [-1, 0] })), "ArrowLeft");
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { axes: [0, 1] })), "ArrowDown");
  assert.equal(dpadArrow(pad("Virtual (Vendor: 0000 Product: 0000)", { axes: [0, 0] })), null);
});

test("a held arrow emits once, then repeats after the delay", () => {
  const first = nextKeyboardArrow(null, "ArrowLeft", 0);
  assert.equal(first.emit, "ArrowLeft");
  const held = nextKeyboardArrow(first.state, "ArrowLeft", ARROW_REPEAT_DELAY - 1);
  assert.equal(held.emit, null);
  const repeat = nextKeyboardArrow(held.state, "ArrowLeft", ARROW_REPEAT_DELAY);
  assert.equal(repeat.emit, "ArrowLeft");
  const again = nextKeyboardArrow(repeat.state, "ArrowLeft", ARROW_REPEAT_DELAY + ARROW_REPEAT_INTERVAL);
  assert.equal(again.emit, "ArrowLeft");
  assert.equal(nextKeyboardArrow(again.state, null, 5000).state, null);
});

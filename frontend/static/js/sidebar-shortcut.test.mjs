import assert from "node:assert/strict";
import test from "node:test";
import { createArrowEcho, createModifierLatch, editorArrowPlan } from "./editor-arrow.mjs";
import { sidebarShortcutAction } from "./sidebar-shortcut.mjs";

// The app notes the event in the capture phase, then reads the latch from
// the bubble-phase shortcut handler. Same order here.
function chord(latch, event) {
  latch.note(event);
  return sidebarShortcutAction(event, latch.snapshot());
}

const held = { shift: false, ctrl: false, alt: false, meta: false };

test("desktop Ctrl+B and Cmd+B toggle the tree, and Alt toggles the preview", () => {
  const latch = createModifierLatch();
  assert.equal(
    chord(latch, { type: "keydown", key: "b", code: "KeyB", keyCode: 66, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    "tree"
  );
  assert.equal(
    sidebarShortcutAction(
      { type: "keydown", key: "b", code: "KeyB", keyCode: 66, ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
      { ...held, meta: true }
    ),
    "tree"
  );
  assert.equal(
    sidebarShortcutAction(
      { type: "keydown", key: "∫", code: "KeyB", keyCode: 66, ctrlKey: false, altKey: true, shiftKey: false, metaKey: true },
      { ...held, alt: true, meta: true }
    ),
    "preview"
  );
  assert.equal(
    sidebarShortcutAction(
      { type: "keydown", key: "b", code: "KeyB", keyCode: 66, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
      { ...held, ctrl: true, alt: true }
    ),
    "preview"
  );
  assert.equal(
    sidebarShortcutAction(
      { type: "keydown", key: "B", code: "KeyB", keyCode: 66, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
      { ...held, ctrl: true, shift: true }
    ),
    null
  );
  assert.equal(
    sidebarShortcutAction(
      { type: "keydown", key: "∫", code: "KeyB", keyCode: 66, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
      { ...held, alt: true }
    ),
    null
  );
  assert.equal(
    sidebarShortcutAction({ type: "keydown", key: "b", code: "KeyB", keyCode: 66, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, held),
    null
  );
});

test("Android Chrome Ctrl+B toggles the tree when code is empty and ctrlKey is missing", () => {
  const latch = createModifierLatch();
  // Control itself still arrives, the way the arrow-modifier latch expects.
  assert.equal(
    chord(latch, { type: "keydown", key: "Unidentified", code: "", keyCode: 17, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );
  // The letter: no `code` (KeyboardEvent.code is off), key Unidentified,
  // legacy keyCode 66, and ctrlKey left false.
  const letter = {
    type: "keydown",
    key: "Unidentified",
    code: "",
    keyCode: 66,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isTrusted: true,
  };
  assert.equal(editorArrowPlan(letter, createArrowEcho(), 0).type, "ignore");
  assert.equal(chord(latch, letter), "tree");
  assert.equal(latch.snapshot().ctrl, true);

  // The same chord when the letter's key survived but `code` did not.
  const named = {
    type: "keydown",
    key: "b",
    code: "",
    keyCode: 66,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isTrusted: true,
  };
  assert.equal(chord(createModifierLatch(), named), "tree");
  assert.equal(
    chord(createModifierLatch(), { ...named, key: "B", keyCode: 229, ctrlKey: true }),
    "tree"
  );

  // Ctrl+Alt+B, both flags omitted, both modifiers latched.
  const both = createModifierLatch();
  chord(both, { type: "keydown", key: "Unidentified", code: "", keyCode: 17, ctrlKey: true, isTrusted: true });
  chord(both, { type: "keydown", key: "Unidentified", code: "", keyCode: 18, altKey: true, isTrusted: true });
  assert.equal(
    chord(both, { type: "keydown", key: "b", code: "", keyCode: 66, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    "preview"
  );

  // Shift stayed down, and the letter event did not repeat shiftKey.
  // Ctrl+Shift+B is the browser's bookmarks bar, so the tree stays put.
  const shifted = createModifierLatch();
  chord(shifted, { type: "keydown", key: "Shift", code: "", shiftKey: true, isTrusted: true });
  chord(shifted, { type: "keydown", key: "Unidentified", code: "", keyCode: 17, ctrlKey: true, isTrusted: true });
  assert.equal(
    chord(shifted, { type: "keydown", key: "b", code: "", keyCode: 66, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );
});

test("Android Ctrl+B does not toggle after Control is released, and a composition key is not B", () => {
  const latch = createModifierLatch();
  chord(latch, { type: "keydown", key: "Unidentified", code: "", keyCode: 17, ctrlKey: true, isTrusted: true });
  chord(latch, { type: "keyup", key: "Unidentified", code: "", keyCode: 17, ctrlKey: false, isTrusted: true });
  assert.equal(
    chord(latch, { type: "keydown", key: "b", code: "", keyCode: 66, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );

  const composing = createModifierLatch();
  chord(composing, { type: "keydown", key: "Control", code: "", keyCode: 17, ctrlKey: true, isTrusted: true });
  assert.equal(
    chord(composing, { type: "keydown", key: "Unidentified", code: "", keyCode: 229, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );
  assert.equal(
    chord(composing, { type: "keydown", key: "c", code: "", keyCode: 66, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );
  assert.equal(
    chord(composing, { type: "keydown", key: "s", code: "", keyCode: 83, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isTrusted: true }),
    null
  );
  assert.equal(
    sidebarShortcutAction({ type: "keyup", key: "b", code: "KeyB", ctrlKey: true }, { ctrl: true }),
    null
  );
});

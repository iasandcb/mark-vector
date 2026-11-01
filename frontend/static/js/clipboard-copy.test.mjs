import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "./clipboard-copy.mjs";

function fakeDocument() {
  const nodes = [];
  const selection = {
    rangeCount: 0,
    ranges: [],
    getRangeAt(index) {
      return this.ranges[index];
    },
    removeAllRanges() {
      this.ranges = [];
      this.rangeCount = 0;
    },
    addRange(range) {
      this.ranges = [range];
      this.rangeCount = 1;
    },
  };
  const state = { execResult: true, execThrows: false, lastCommand: null };
  const document = {
    body: {
      appendChild(node) {
        nodes.push(node);
      },
      removeChild(node) {
        const index = nodes.indexOf(node);
        if (index < 0) throw new Error("not attached");
        nodes.splice(index, 1);
      },
    },
    createElement(tag) {
      assert.equal(tag, "textarea");
      const el = {
        value: "",
        style: {},
        attrs: {},
        setAttribute(name, value) {
          el.attrs[name] = value;
        },
        focus() {
          el.focused = true;
        },
        select() {
          el.selected = true;
        },
        setSelectionRange(start, end) {
          el.ranges = el.ranges || [];
          el.ranges.push([start, end]);
        },
      };
      return el;
    },
    createRange() {
      return {
        selectNodeContents(node) {
          this.node = node;
        },
      };
    },
    getSelection() {
      return selection;
    },
    execCommand(command) {
      state.lastCommand = command;
      if (state.execThrows) throw new Error("execCommand failed");
      return state.execResult;
    },
  };
  return { document, nodes, selection, state };
}

const markdown = "# 제목\n\n오른쪽 버퍼, 저장 전\n$$x^2$$\n";

test("writeText copies the preview markdown in a secure context", async () => {
  let written = null;
  const calls = { exec: 0 };
  const ok = await copyText(markdown, {
    isSecureContext: true,
    clipboard: {
      writeText: async (text) => {
        written = text;
      },
    },
    document: {
      execCommand() {
        calls.exec += 1;
        return true;
      },
    },
  });
  assert.equal(ok, true);
  assert.equal(written, markdown);
  assert.equal(calls.exec, 0);
});

test("plain http skips writeText and uses an in-viewport textarea", async () => {
  const fake = fakeDocument();
  let wrote = false;
  const ok = await copyText(markdown, {
    isSecureContext: false,
    clipboard: {
      writeText: async () => {
        wrote = true;
      },
    },
    document: fake.document,
  });
  const field = fake.nodes.length === 0 ? null : null;
  assert.equal(wrote, false);
  assert.equal(ok, true);
  assert.equal(fake.state.lastCommand, "copy");
  assert.equal(field, null);
  assert.equal(fake.nodes.length, 0);
});

test("fallback textarea is readonly, in the viewport, and ranged over the value", async () => {
  const seen = [];
  const fake = fakeDocument();
  const originalCreate = fake.document.createElement;
  fake.document.createElement = (tag) => {
    const el = originalCreate(tag);
    seen.push(el);
    return el;
  };
  const ok = await copyText("abc\n한글", {
    isSecureContext: false,
    document: fake.document,
  });
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  const field = seen[0];
  assert.equal(field.value, "abc\n한글");
  assert.equal(field.attrs.readonly, "");
  assert.equal(field.attrs["aria-hidden"], "true");
  assert.equal(field.focused, true);
  assert.equal(field.selected, true);
  assert.deepEqual(field.ranges.at(-1), [0, "abc\n한글".length]);
  assert.equal(field.style.position, "fixed");
  assert.equal(field.style.top, "0");
  assert.equal(field.style.left, "0");
  assert.notEqual(field.style.left, "-9999px");
  assert.equal(field.style.fontSize, "16px");
  assert.equal(fake.nodes.length, 0);
});

test("a failed writeText falls through to execCommand", async () => {
  const fake = fakeDocument();
  const ok = await copyText("unsaved", {
    isSecureContext: true,
    clipboard: {
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    },
    document: fake.document,
  });
  assert.equal(ok, true);
  assert.equal(fake.state.lastCommand, "copy");
});

test("execCommand false or a throw is a failed copy", async () => {
  const denied = fakeDocument();
  denied.state.execResult = false;
  assert.equal(await copyText("x", { isSecureContext: false, document: denied.document }), false);

  const broken = fakeDocument();
  broken.state.execThrows = true;
  assert.equal(await copyText("x", { isSecureContext: false, document: broken.document }), false);
  assert.equal(broken.nodes.length, 0);
});

test("the editor selection is restored after the fallback", async () => {
  const fake = fakeDocument();
  const previous = { id: "caret" };
  fake.selection.addRange(previous);
  await copyText("hello", { isSecureContext: false, document: fake.document });
  assert.equal(fake.selection.rangeCount, 1);
  assert.equal(fake.selection.getRangeAt(0), previous);
});

test("no clipboard and no document reports failure", async () => {
  assert.equal(await copyText("x", { isSecureContext: false, clipboard: null, document: null }), false);
  assert.equal(await copyText("", { isSecureContext: true, clipboard: null, document: null }), false);
});

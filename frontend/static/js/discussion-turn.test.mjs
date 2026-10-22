import assert from "node:assert/strict";
import test from "node:test";
import { absorbEcho, createDiscussionController, DEFAULT_SILENCE_MS, sonioxMarkerInfo } from "./discussion-turn.mjs";

function script(controller, steps) {
  const events = [];
  for (const step of steps) {
    const batch = step.tokens ? controller.push(step.tokens, step.at) : step.now ? controller.sendNow() : controller.tick(step.at);
    events.push(...batch);
  }
  return events;
}

const sends = (events) => events.filter((event) => event.type === "send");

test("endpoint marker sends once and never shows <end> or <fin>", () => {
  const seen = [];
  const controller = createDiscussionController({ log: (entry) => seen.push(entry) });
  const events = script(controller, [
    { at: 0, tokens: [{ text: "안녕", is_final: false }] },
    { at: 200, tokens: [{ text: "안녕", is_final: true }, { text: ".", is_final: true }] },
    { at: 400, tokens: [{ text: "<end>", is_final: true }] },
    { at: 500, tokens: [{ text: "<fin>", is_final: true }] },
  ]);
  const sent = sends(events);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "안녕.");
  assert.equal(sent[0].reason, "endpoint");
  assert.equal(sent[0].text.includes("<end>"), false);
  assert.equal(sent[0].text.includes("<fin>"), false);
  assert.equal(controller.stats().end, 1);
  assert.equal(controller.stats().fin, 1);
  assert.equal(seen.some((entry) => entry.kind === "marker" && entry.end && entry.raw.includes("<end>")), true);
  // A period in the finalized words did not send on its own; <end> did,
  // before the silence window.
  assert.ok(400 < DEFAULT_SILENCE_MS);
});

test("a glued <end> is a turn, and a period alone waits for silence", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  const early = script(controller, [
    { at: 0, tokens: [{ text: "하나.", is_final: true }] },
    { at: 1499 },
  ]);
  assert.equal(sends(early).length, 0);
  const waited = controller.tick(1500);
  assert.equal(sends(waited)[0].text, "하나.");
  assert.equal(sends(waited)[0].reason, "silence");

  const endpoint = createDiscussionController();
  const events = script(endpoint, [
    { at: 0, tokens: [{ text: "요<end>", is_final: true }] },
    { at: 10 },
  ]);
  assert.deepEqual(sends(events).map((event) => event.text), ["요"]);
  assert.equal(sends(events)[0].reason, "endpoint");
  assert.equal(controller.tick(10).length, 0);
});

test("silence resets while finals or the hypothesis are still arriving", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  script(controller, [
    { at: 0, tokens: [{ text: "안녕", is_final: true }] },
    { at: 1000, tokens: [{ text: "하", is_final: false }] },
  ]);
  assert.equal(sends(controller.tick(1499)).length, 0);
  assert.equal(sends(controller.tick(2499)).length, 0);
  const sent = sends(controller.tick(2500));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "안녕하");
  assert.equal(sent[0].reason, "silence");
});

test("more speech while a request is in flight aborts it and resends the merged text", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  const first = script(controller, [
    { at: 0, tokens: [{ text: "질문", is_final: true }] },
    { at: 1500 },
  ]);
  assert.equal(sends(first)[0].text, "질문");
  assert.equal(sends(first)[0].requestId, 1);
  const resumed = controller.push([{ text: "추가", is_final: true }], 1600);
  assert.equal(resumed.some((event) => event.type === "abort" && event.requestId === 1), true);
  assert.equal(resumed.find((event) => event.type === "partial").text, "질문 추가");
  const second = sends(controller.tick(3100));
  assert.equal(second.length, 1);
  assert.equal(second[0].text, "질문 추가");
  assert.equal(second[0].merged, true);
  assert.equal(second[0].requestId, 2);
  // The old request finishing must not clear the new one.
  controller.settle(1);
  assert.equal(sends(controller.tick(3200)).length, 0);
});

test("finals that only confirm a silence send are not a second turn", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  const first = script(controller, [
    { at: 0, tokens: [{ text: "hello", is_final: true }, { text: " world", is_final: false }] },
    { at: 1500 },
  ]);
  assert.equal(sends(first)[0].text, "hello world");
  controller.settle(1);
  const echo = controller.push(
    [
      { text: " world", is_final: true },
      { text: "<end>", is_final: true },
    ],
    1800,
  );
  assert.equal(sends(echo).length, 0);
  assert.equal(echo.some((event) => event.type === "abort"), false);
  assert.equal(controller.stats().end, 1);
});

test("words after the echoed tail still merge into the open request", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  script(controller, [
    { at: 0, tokens: [{ text: "hello", is_final: true }, { text: " world", is_final: false }] },
    { at: 1500 },
  ]);
  const more = controller.push([{ text: " world please", is_final: true }], 1700);
  assert.equal(more.some((event) => event.type === "abort"), true);
  const sent = sends(controller.push([{ text: "<end>", is_final: true }], 1800));
  assert.equal(sent[0].text, "hello world please");
  assert.equal(sent[0].merged, true);
});

test("send now flushes without waiting, and an empty buffer does not send", () => {
  const controller = createDiscussionController();
  assert.equal(controller.sendNow().length, 0);
  controller.push([{ text: "지금", is_final: false }], 0);
  const events = controller.sendNow();
  assert.equal(sends(events)[0].text, "지금");
  assert.equal(sends(events)[0].reason, "manual");
  assert.equal(controller.sendNow().length, 0);
});

test("the silence window is configurable and marker text is detected raw", () => {
  const controller = createDiscussionController({ silenceMs: 1500 });
  controller.setSilenceMs(400);
  controller.push([{ text: "가", is_final: true }], 0);
  assert.equal(sends(controller.tick(399)).length, 0);
  assert.equal(sends(controller.tick(400))[0].reason, "silence");
  assert.deepEqual(sonioxMarkerInfo([{ text: "끝<END>", is_final: true }, { text: "<FIN>", is_final: true }]), {
    end: true,
    fin: true,
    raw: ["끝<END>", "<FIN>"],
  });
  const eaten = absorbEcho(" world", " world");
  assert.equal(eaten.extra, "");
  assert.equal(eaten.matched, true);
});

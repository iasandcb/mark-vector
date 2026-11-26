import assert from "node:assert/strict";
import test from "node:test";
import { allowAmbientConnect, liveSocketPath } from "./glasses-ambient.mjs";

test("the websocket path never carries the passcode", () => {
  assert.equal(liveSocketPath(""), "/ws/live");
  assert.equal(liveSocketPath(null), "/ws/live");
  assert.equal(liveSocketPath("abc"), "/ws/live/abc");
  assert.equal(liveSocketPath("a/b"), "/ws/live/a%2Fb");
});

test("a channel skips the passcode exchange", async () => {
  let called = false;
  const decision = await allowAmbientConnect({
    channel: "abc",
    pin: "1234",
    alreadyAllowed: false,
    requestPasscode: async () => {
      called = true;
      return 401;
    },
  });
  assert.equal(called, false);
  assert.deepEqual(decision, { ok: true, remember: false, retry: false });
});

test("ambient posts the pin once and then keeps the session", async () => {
  const calls = [];
  const login = async (pin) => {
    calls.push(pin);
    return 200;
  };
  const first = await allowAmbientConnect({ channel: "", pin: "1234", alreadyAllowed: false, requestPasscode: login });
  assert.deepEqual(first, { ok: true, remember: true, retry: false });
  const second = await allowAmbientConnect({ channel: "", pin: "1234", alreadyAllowed: true, requestPasscode: login });
  assert.deepEqual(calls, ["1234"]);
  assert.equal(second.ok, true);
  assert.equal(second.remember, true);
});

test("passcode auth being off still opens ambient", async () => {
  const decision = await allowAmbientConnect({
    channel: "",
    pin: "1234",
    alreadyAllowed: false,
    requestPasscode: async () => 404,
  });
  assert.deepEqual(decision, { ok: true, remember: true, retry: false });
});

test("a rejected pin is not retried", async () => {
  for (const status of [401, 429]) {
    const decision = await allowAmbientConnect({
      channel: "",
      pin: "0000",
      alreadyAllowed: false,
      requestPasscode: async () => status,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.retry, false);
  }
});

test("a network failure is retried and a missing pin just connects", async () => {
  const offline = await allowAmbientConnect({
    channel: "",
    pin: "1234",
    alreadyAllowed: false,
    requestPasscode: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(offline, { ok: false, remember: false, retry: true });
  const noPin = await allowAmbientConnect({
    channel: "",
    pin: "",
    alreadyAllowed: false,
    requestPasscode: async () => 401,
  });
  assert.equal(noPin.ok, true);
});

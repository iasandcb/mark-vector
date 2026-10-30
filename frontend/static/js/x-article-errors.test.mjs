import test from "node:test";
import assert from "node:assert/strict";
import { createXArticleDraft } from "./api.js";
import { xArticleErrorMessage, xArticleLimitInfo } from "./x-article-errors.mjs";

const now = Date.UTC(2026, 9, 30, 3);
const t = (key, vars) => "translated:" + key + (vars ? " " + JSON.stringify(vars) : "");

test("the draft API keeps safe rate metadata with the error without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ detail: "usageCap" }), { status: 502, headers: {
      "X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String((now + 60_000) / 1000),
    } });
  };
  try {
    await assert.rejects(createXArticleDraft({}), (error) => {
      assert.equal(error.message, "usageCap");
      assert.equal(error.xLimit.resetAt, now + 60_000);
      assert.equal(error.xLimit.limit, 10);
      assert.equal(error.xLimit.remaining, 0);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Retry-After is relative to receipt; the later retry instruction wins", () => {
  const info = xArticleLimitInfo(new Headers({ "X-RateLimit-Reset": String(now / 1000 + 30), "Retry-After": "60" }), now);
  assert.equal(info.resetAt, now + 60_000);
});

test("missing or malformed limit headers do not invent a reset time or zero balance", () => {
  assert.deepEqual(xArticleLimitInfo(new Headers(), now), { resetAt: null, limit: null, remaining: null });
  assert.deepEqual(xArticleLimitInfo(new Headers({ "X-RateLimit-Reset": "NaN", "Retry-After": "-1", "X-RateLimit-Limit": "Infinity", "X-RateLimit-Remaining": "secret" }), now), { resetAt: null, limit: null, remaining: null });
  assert.equal(xArticleLimitInfo(new Headers({ "X-RateLimit-Reset": "0" }), now).resetAt, null);
});

test("a future reset, a past reset, and a missing reset have distinct messages", () => {
  const error = new Error("rateLimit");
  error.xLimit = { resetAt: now + 60_000, limit: 10, remaining: 0 };
  const future = xArticleErrorMessage(error, t, "ko", now);
  assert.match(future, /xArticle\.limit\.resetAt/);
  assert.match(future, /"remaining":0,"limit":10/);
  error.xLimit.resetAt = now - 60_000;
  assert.match(xArticleErrorMessage(error, t, "ko", now), /xArticle\.limit\.resetPassed/);
  error.xLimit.resetAt = null;
  assert.match(xArticleErrorMessage(error, t, "ko", now), /xArticle\.limit\.resetMissing/);
});

test("usage cap errors stay distinct from rate limits and other API errors", () => {
  assert.match(xArticleErrorMessage(new Error("usageCap"), t, "en", now), /^translated:xArticle\.error\.usageCap translated:xArticle\.limit\.resetMissing$/);
  assert.equal(xArticleErrorMessage(new Error("permission"), t, "en", now), "translated:xArticle.error.permission");
});

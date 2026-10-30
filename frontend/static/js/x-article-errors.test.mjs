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
      "X-X-Error-Info": JSON.stringify({ title: "Too Many Requests", errors: [{ code: 88, message: "Rate limit exceeded" }] }),
    } });
  };
  try {
    await assert.rejects(createXArticleDraft({}), (error) => {
      assert.equal(error.message, "usageCap");
      assert.equal(error.xLimit.resetAt, now + 60_000);
      assert.equal(error.xLimit.limit, 10);
      assert.equal(error.xLimit.remaining, 0);
      assert.equal(error.xLimit.diagnostic.errors[0].code, 88);
      assert.match(xArticleErrorMessage(error, t, "en", now), /Too Many Requests/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Retry-After and request-count reset stay separate", () => {
  const info = xArticleLimitInfo(new Headers({ "X-RateLimit-Reset": String(now / 1000 + 30), "Retry-After": "60" }), now);
  assert.equal(info.resetAt, now + 30_000);
  assert.equal(info.retryAt, now + 60_000);
  const message = xArticleErrorMessage({ message: "rateLimit", xLimit: info }, t, "ko", now);
  assert.match(message, /xArticle\.limit\.resetAt/);
  assert.match(message, /xArticle\.limit\.retryAfter/);
  const retryOnly = xArticleLimitInfo(new Headers({ "Retry-After": "60" }), now);
  assert.equal(retryOnly.resetAt, null);
  assert.equal(retryOnly.retryAt, now + 60_000);
});

const emptyLimit = {
  resetAt: null, retryAt: null, limit: null, remaining: null, diagnostic: null,
  authMode: null, accessLevel: null, transactionId: null, counters: [], extras: [],
};

test("missing or malformed limit headers do not invent a reset time or zero balance", () => {
  assert.deepEqual(xArticleLimitInfo(new Headers(), now), emptyLimit);
  assert.deepEqual(xArticleLimitInfo(new Headers({
    "X-RateLimit-Reset": "NaN", "Retry-After": "-1", "X-RateLimit-Limit": "Infinity", "X-RateLimit-Remaining": "secret",
    "X-X-Auth-Mode": "bearer", "X-Access-Level": "read write", "X-Transaction-Id": "has space",
  }), now), emptyLimit);
  assert.equal(xArticleLimitInfo(new Headers({ "X-RateLimit-Reset": "0" }), now).resetAt, null);
});

test("missing, malformed or oversized diagnostic headers do not replace the original error", () => {
  for (const raw of ["not-json", "null", "[]", "true", JSON.stringify({ detail: "x".repeat(6001) })]) {
    const xLimit = xArticleLimitInfo(new Headers({ "X-X-Error-Info": raw }));
    assert.equal(xLimit.diagnostic, null);
    assert.match(xArticleErrorMessage({ message: "rateLimit", xLimit }, t, "en", now), /^translated:xArticle\.error\.rateLimit/);
  }
});

test("a 429 with requests remaining does not imply the displayed window is exhausted", () => {
  const error = { message: "rateLimit", xLimit: { resetAt: now + 60_000, limit: 40000, remaining: 39999 } };
  assert.match(xArticleErrorMessage(error, t, "ko", now), /xArticle\.limit\.otherRestriction/);
  for (const remaining of [0, null]) {
    error.xLimit.remaining = remaining;
    assert.doesNotMatch(xArticleErrorMessage(error, t, "ko", now), /xArticle\.limit\.otherRestriction/);
  }
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

test("an exhausted 24-hour counter is the reset shown to the user", () => {
  const windowReset = now / 1000 + 60;
  const userReset = now / 1000 + 86_400;
  const appReset = now / 1000 + 3_600;
  const headers = new Headers({
    "X-RateLimit-Limit": "40000",
    "X-RateLimit-Remaining": "39999",
    "X-RateLimit-Reset": String(windowReset),
    "X-User-Limit-24hour-Limit": "50",
    "X-User-Limit-24hour-Remaining": "0",
    "X-User-Limit-24hour-Reset": String(userReset),
    "X-App-Limit-24hour-Limit": "1000",
    "X-App-Limit-24hour-Remaining": "10",
    "X-App-Limit-24hour-Reset": String(appReset),
    "X-Endpoint-Limit-Remaining": "7",
    "X-Access-Level": "read-write",
    "X-Transaction-Id": "ab+cd/ef=",
    "X-X-Auth-Mode": "oauth1",
    "X-Response-Time": "12",
  });
  const info = xArticleLimitInfo(headers, now);
  assert.equal(info.remaining, 39999);
  assert.equal(info.authMode, "oauth1");
  assert.equal(info.accessLevel, "read-write");
  assert.equal(info.transactionId, "ab+cd/ef=");
  const message = xArticleErrorMessage({ message: "rateLimit", xLimit: info }, t, "en", now);
  assert.match(message, /xArticle\.limit\.dailyResetAt/);
  assert.match(message, /x-user-limit-24hour/);
  assert.match(message, /03:00:00 UTC/);
  assert.match(message, /12:00:00 GMT\+9 KST/);
  assert.match(message, new RegExp(`\\(${userReset}\\)`));
  assert.doesNotMatch(message, /xArticle\.limit\.resetAt/);
  assert.doesNotMatch(message, /xArticle\.limit\.otherRestriction/);
  assert.equal(message.includes(String(windowReset)), false);
  assert.match(message, /"remaining":39999,"limit":40000/);
  assert.match(message, /x-endpoint-limit-remaining=7/);
  assert.match(message, /xArticle\.limit\.dailyRemaining/);
  assert.match(message, /oauth1/);
  assert.match(message, /read-write/);
  assert.match(message, /ab\+cd\/ef=/);
  assert.doesNotMatch(message, /X-Response-Time|x-response-time/);
});

test("the later exhausted 24-hour reset is shown first", () => {
  const userReset = now / 1000 + 86_400;
  const appReset = now / 1000 + 3_600;
  const info = xArticleLimitInfo(new Headers({
    "X-RateLimit-Reset": String(now / 1000 + 60),
    "X-User-Limit-24hour-Remaining": "0",
    "X-User-Limit-24hour-Reset": String(userReset),
    "X-App-Limit-24hour-Remaining": "0",
    "X-App-Limit-24hour-Reset": String(appReset),
  }), now);
  const message = xArticleErrorMessage({ message: "rateLimit", xLimit: info }, t, "en", now);
  const userAt = message.indexOf(String(userReset));
  const appAt = message.indexOf(String(appReset));
  assert.ok(userAt !== -1 && appAt !== -1 && userAt < appAt);
});

test("a past 24-hour reset stays the relevant message", () => {
  const info = xArticleLimitInfo(new Headers({
    "X-RateLimit-Reset": String(now / 1000 + 60),
    "X-App-Limit-24hour-Remaining": "0",
    "X-App-Limit-24hour-Reset": String(now / 1000 - 60),
  }), now);
  const message = xArticleErrorMessage({ message: "usageCap", xLimit: info }, t, "en", now);
  assert.match(message, /xArticle\.limit\.dailyResetPassed/);
  assert.match(message, /x-app-limit-24hour/);
  assert.doesNotMatch(message, /xArticle\.limit\.resetAt|xArticle\.limit\.resetMissing/);
});

test("a 24-hour counter with no reset does not fall back to the short window", () => {
  const windowReset = now / 1000 + 60;
  const info = xArticleLimitInfo(new Headers({
    "X-RateLimit-Limit": "40000",
    "X-RateLimit-Remaining": "39999",
    "X-RateLimit-Reset": String(windowReset),
    "X-User-Limit-24hour-Limit": "50",
    "X-User-Limit-24hour-Remaining": "0",
  }), now);
  const message = xArticleErrorMessage({ message: "rateLimit", xLimit: info }, t, "en", now);
  assert.match(message, /xArticle\.limit\.dailyResetMissing/);
  assert.doesNotMatch(message, /xArticle\.limit\.resetAt/);
  assert.equal(message.includes(String(windowReset)), false);
});

test("a 24-hour counter that still has remaining keeps the short-window message", () => {
  const info = xArticleLimitInfo(new Headers({
    "X-RateLimit-Limit": "40000",
    "X-RateLimit-Remaining": "39999",
    "X-RateLimit-Reset": String(now / 1000 + 60),
    "X-User-Limit-24hour-Limit": "50",
    "X-User-Limit-24hour-Remaining": "5",
    "X-User-Limit-24hour-Reset": String(now / 1000 + 86_400),
  }), now);
  const message = xArticleErrorMessage({ message: "rateLimit", xLimit: info }, t, "en", now);
  assert.match(message, /xArticle\.limit\.resetAt/);
  assert.match(message, /xArticle\.limit\.otherRestriction/);
  assert.match(message, /xArticle\.limit\.dailyRemaining/);
  assert.doesNotMatch(message, /xArticle\.limit\.dailyResetAt/);
});

test("permission errors can show auth mode and access level without a reset", () => {
  const info = xArticleLimitInfo(new Headers({
    "X-Access-Level": "read", "X-X-Auth-Mode": "oauth2", "X-Transaction-Id": "txn-403",
  }), now);
  const message = xArticleErrorMessage({ message: "permission", xLimit: info }, t, "en", now);
  assert.match(message, /^translated:xArticle\.error\.permission/);
  assert.match(message, /oauth2/);
  assert.match(message, /"level":"read"/);
  assert.match(message, /txn-403/);
  assert.doesNotMatch(message, /resetMissing|resetAt/);
});

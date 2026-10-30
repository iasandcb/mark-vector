// Safe diagnostic headers from our backend, rather than X's raw error body.
export function xArticleLimitInfo(headers, now = Date.now()) {
  const number = (name) => {
    const value = headers.get(name);
    if (value == null || !/^\d{1,12}$/.test(value)) return null;
    return Number(value);
  };
  const reset = number("X-RateLimit-Reset");
  const after = number("Retry-After");
  const validTime = (value) => Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
  let diagnostic = null;
  const raw = headers.get("X-X-Error-Info");
  if (raw && raw.length <= 6000) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) diagnostic = value;
    } catch { /* A malformed diagnostic must not hide the original error. */ }
  }
  return {
    resetAt: validTime(reset == null ? null : reset * 1000),
    retryAt: validTime(after == null ? null : now + after * 1000),
    limit: number("X-RateLimit-Limit"),
    remaining: number("X-RateLimit-Remaining"),
    diagnostic,
  };
}

export function xArticleErrorMessage(error, t, language, now = Date.now()) {
  const key = `xArticle.error.${error.message}`;
  const translated = t(key);
  const parts = [translated === key ? t("xArticle.error.failed") : translated];
  if (!["rateLimit", "usageCap"].includes(error.message)) return parts[0];
  const info = error.xLimit;
  if (info?.resetAt && Number.isFinite(info.resetAt) && Math.abs(info.resetAt) <= 8.64e15) {
    const time = new Intl.DateTimeFormat(language, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    }).format(new Date(info.resetAt));
    parts.push(t(info.resetAt > now ? "xArticle.limit.resetAt" : "xArticle.limit.resetPassed", { time }));
  } else {
    parts.push(t("xArticle.limit.resetMissing"));
  }
  if (info?.retryAt > now && Number.isFinite(info.retryAt) && info.retryAt <= 8.64e15) {
    const time = new Intl.DateTimeFormat(language, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    }).format(new Date(info.retryAt));
    parts.push(t("xArticle.limit.retryAfter", { time }));
  }
  if (info?.limit != null && info?.remaining != null) {
    parts.push(t("xArticle.limit.remaining", { remaining: info.remaining, limit: info.limit }));
  }
  if (error.message === "rateLimit" && info?.remaining > 0) {
    parts.push(t("xArticle.limit.otherRestriction"));
  }
  if (info?.diagnostic) {
    parts.push(t("xArticle.limit.diagnostic", { diagnostic: JSON.stringify(info.diagnostic) }));
  }
  return parts.join(" ");
}

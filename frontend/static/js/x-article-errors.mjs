// Safe diagnostic headers from our backend, rather than X's raw error body.
const LIMIT_NAME = /^x-(?:rate-limit-[a-z0-9]+(?:-[a-z0-9]+)*|[a-z0-9]+(?:-[a-z0-9]+)*-limit-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const INTEGER = /^\d{1,12}$/;

function headerNumber(headers, name) {
  const value = headers.get(name);
  if (value == null || !INTEGER.test(value)) return null;
  return Number(value);
}

function validTime(value) {
  return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
}

function safeToken(headers, name, pattern) {
  const value = headers.get(name);
  return value && pattern.test(value) ? value : null;
}

function collectLimits(headers) {
  // Fetch stores X-RateLimit-Limit as x-ratelimit-limit. The other limit
  // headers keep their hyphens, so map the short window back first.
  const alias = {
    "x-ratelimit-limit": "x-rate-limit-limit",
    "x-ratelimit-remaining": "x-rate-limit-remaining",
    "x-ratelimit-reset": "x-rate-limit-reset",
  };
  const groups = new Map();
  const extras = [];
  for (const [rawName, rawValue] of headers.entries()) {
    const name = alias[rawName.toLowerCase()] || rawName.toLowerCase();
    if (!LIMIT_NAME.test(name) || !INTEGER.test(rawValue)) continue;
    const parts = name.split("-");
    const suffix = parts.pop();
    const prefix = parts.join("-");
    if (suffix !== "limit" && suffix !== "remaining" && suffix !== "reset") {
      extras.push(`${name}=${Number(rawValue)}`);
      continue;
    }
    const group = groups.get(prefix) || { prefix, limit: null, remaining: null, resetAt: null };
    if (suffix === "reset") group.resetAt = validTime(Number(rawValue) * 1000);
    else group[suffix] = Number(rawValue);
    groups.set(prefix, group);
  }
  const counters = [...groups.values()].map((group) => {
    const daily = group.prefix.includes("24hour");
    let scope = null;
    if (daily) {
      if (group.prefix === "x-user-limit-24hour") scope = "user";
      else if (group.prefix === "x-app-limit-24hour") scope = "app";
      else scope = group.prefix.replace(/^x-/, "");
    }
    return { ...group, daily, scope };
  });
  return { counters, extras };
}

export function xArticleLimitInfo(headers, now = Date.now()) {
  const { counters, extras } = collectLimits(headers);
  const window = counters.find((counter) => counter.prefix === "x-rate-limit");
  const after = headerNumber(headers, "Retry-After");
  let diagnostic = null;
  const raw = headers.get("X-X-Error-Info");
  if (raw && raw.length <= 6000) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) diagnostic = value;
    } catch { /* A malformed diagnostic must not hide the original error. */ }
  }
  return {
    resetAt: window?.resetAt ?? null,
    retryAt: validTime(after == null ? null : now + after * 1000),
    limit: window?.limit ?? null,
    remaining: window?.remaining ?? null,
    diagnostic,
    authMode: safeToken(headers, "X-X-Auth-Mode", /^oauth[12]$/),
    accessLevel: safeToken(headers, "X-Access-Level", /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
    transactionId: safeToken(headers, "X-Transaction-Id", /^[A-Za-z0-9+/=_.-]{1,200}$/),
    counters,
    extras,
  };
}

function formatInstant(ms, language) {
  const options = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  };
  const zone = (timeZone, label) => {
    const text = new Intl.DateTimeFormat(language, { ...options, timeZone }).format(new Date(ms));
    return text.includes(label) ? text : `${text} ${label}`;
  };
  return `${zone("UTC", "UTC")} / ${zone("Asia/Seoul", "KST")} (${Math.trunc(ms / 1000)})`;
}

function scopeLabel(scope, t) {
  if (scope !== "user" && scope !== "app") return scope;
  const key = `xArticle.limit.scope.${scope}`;
  const label = t(key);
  return label === key ? scope : label;
}

export function xArticleErrorMessage(error, t, language, now = Date.now()) {
  const key = `xArticle.error.${error.message}`;
  const translated = t(key);
  const parts = [translated === key ? t("xArticle.error.failed") : translated];
  const info = error.xLimit;
  const limited = error.message === "rateLimit" || error.message === "usageCap";
  const counters = info?.counters || [];
  const exhausted = counters.filter((counter) => counter.daily && counter.remaining === 0);
  if (limited) {
    if (!exhausted.length) {
      if (info?.resetAt && Number.isFinite(info.resetAt) && Math.abs(info.resetAt) <= 8.64e15) {
        parts.push(t(info.resetAt > now ? "xArticle.limit.resetAt" : "xArticle.limit.resetPassed", { time: formatInstant(info.resetAt, language) }));
      } else {
        parts.push(t("xArticle.limit.resetMissing"));
      }
    }
    if (info?.retryAt > now && Number.isFinite(info.retryAt) && info.retryAt <= 8.64e15) {
      parts.push(t("xArticle.limit.retryAfter", { time: formatInstant(info.retryAt, language) }));
    }
    if (info?.limit != null && info?.remaining != null) {
      parts.push(t("xArticle.limit.remaining", { remaining: info.remaining, limit: info.limit }));
    }
    if (error.message === "rateLimit" && info?.remaining > 0 && !exhausted.length) {
      parts.push(t("xArticle.limit.otherRestriction"));
    }
  }
  if (info) {
    const ordered = [...exhausted].sort((a, b) => (b.resetAt ?? 0) - (a.resetAt ?? 0) || a.prefix.localeCompare(b.prefix));
    for (const counter of ordered) {
      const vars = { scope: scopeLabel(counter.scope, t), name: counter.prefix };
      if (counter.resetAt && Number.isFinite(counter.resetAt) && Math.abs(counter.resetAt) <= 8.64e15) {
        parts.push(t(counter.resetAt > now ? "xArticle.limit.dailyResetAt" : "xArticle.limit.dailyResetPassed", { ...vars, time: formatInstant(counter.resetAt, language) }));
      } else {
        parts.push(t("xArticle.limit.dailyResetMissing", vars));
      }
    }
    for (const counter of counters) {
      if (!counter.daily || counter.limit == null || counter.remaining == null) continue;
      parts.push(t("xArticle.limit.dailyRemaining", {
        scope: scopeLabel(counter.scope, t), name: counter.prefix, remaining: counter.remaining, limit: counter.limit,
      }));
    }
    const extras = [
      ...(info.extras || []),
      ...counters.filter((counter) => !counter.daily && counter.prefix !== "x-rate-limit").flatMap((counter) => {
        const lines = [];
        if (counter.limit != null) lines.push(`${counter.prefix}-limit=${counter.limit}`);
        if (counter.remaining != null) lines.push(`${counter.prefix}-remaining=${counter.remaining}`);
        if (counter.resetAt != null) lines.push(`${counter.prefix}-reset=${formatInstant(counter.resetAt, language)}`);
        return lines;
      }),
    ];
    if (extras.length) parts.push(t("xArticle.limit.extras", { headers: extras.join(", ") }));
    if (info.authMode) parts.push(t("xArticle.limit.authMode", { mode: info.authMode }));
    if (info.accessLevel) parts.push(t("xArticle.limit.accessLevel", { level: info.accessLevel }));
    if (info.transactionId) parts.push(t("xArticle.limit.transaction", { id: info.transactionId }));
    if (limited && info.diagnostic) parts.push(t("xArticle.limit.diagnostic", { diagnostic: JSON.stringify(info.diagnostic) }));
  }
  return parts.join(" ");
}

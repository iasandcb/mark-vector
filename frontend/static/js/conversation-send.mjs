// Where a send from the split conversation file (`name.c.md`, beside
// `name.md`) is written. The open conversation file keeps the question and
// the reply. A numbered document is not chosen here.

function lastHeadingRole(content, headingRole) {
  let last = null;
  for (const line of String(content ?? "").split("\n")) {
    const role = headingRole(line.trim());
    if (role) last = role;
  }
  return last;
}

function splitPending(rawContent, headingRole) {
  const lines = String(rawContent ?? "").split("\n");
  let lastUserLine = -1;
  lines.forEach((line, index) => {
    if (headingRole(line.trim()) === "user") lastUserLine = index;
  });
  return {
    prefix: lines.slice(0, lastUserLine).join("\n").replace(/\n+$/, ""),
    question: lines.slice(lastUserLine + 1).join("\n").trim(),
    needsHeading: false,
  };
}

export function isConversationFilename(filename) {
  return typeof filename === "string" && filename.endsWith(".c.md");
}

// The last finished exchange, without a trailing newline. A follow-up
// question typed (and even saved) after this still counts as new. An
// unfinished exchange, one that already ends on a user heading, has no
// such snapshot: the pending question is the section already in the file.
export function conversationCompletedSnapshot(filename, role, content, headingRole) {
  if (!isConversationFilename(filename) || role !== "exchange") return null;
  if (lastHeadingRole(content, headingRole) === "user") return null;
  return String(content ?? "").replace(/\n+$/, "");
}

// null means "not a conversation file; the caller keeps the ordinary
// draft / retry / new-turn choice". `blocked` means there is nothing new
// to send, so the caller must not allocate a document either.
export function planConversationSend({
  filename,
  role,
  turnId,
  rawContent,
  savedContent,
  completedContent,
  userHeading,
  headingRole,
}) {
  if (!isConversationFilename(filename)) return null;
  const raw = String(rawContent ?? "");
  if (role !== "exchange" || !turnId) {
    return {
      blocked: false,
      conversationFilename: filename,
      draftFilename: filename,
      retryTurnId: null,
      pending: null,
      content: raw,
    };
  }
  if (lastHeadingRole(raw, headingRole) === "user") {
    return {
      blocked: false,
      conversationFilename: filename,
      draftFilename: null,
      retryTurnId: turnId,
      pending: splitPending(raw, headingRole),
      content: raw,
    };
  }
  const baselineSource = typeof completedContent === "string" ? completedContent : String(savedContent ?? "");
  const baseline = baselineSource.replace(/\n+$/, "");
  if (baseline && (raw === baseline || raw.replace(/\n+$/, "") === baseline)) {
    return { blocked: true };
  }
  if (baseline && raw.startsWith(baseline)) {
    const question = raw.slice(baseline.length).trim();
    if (!question) return { blocked: true };
    return {
      blocked: false,
      conversationFilename: filename,
      draftFilename: null,
      retryTurnId: turnId,
      pending: { prefix: baseline, question, needsHeading: true },
      content: `${baseline}\n\n${userHeading}\n\n${question}`,
    };
  }
  const question = raw.trim();
  if (!question) return { blocked: true };
  return {
    blocked: false,
    conversationFilename: filename,
    draftFilename: null,
    retryTurnId: turnId,
    pending: { prefix: baseline, question, needsHeading: true },
    content: `${baseline ? `${baseline}\n\n` : ""}${userHeading}\n\n${question}`,
  };
}

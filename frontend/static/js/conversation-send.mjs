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

function lineDiff(before, after) {
  const n = before.length;
  const m = after.length;
  const scores = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      scores[i][j] = before[i] === after[j]
        ? scores[i + 1][j + 1] + 1
        : Math.max(scores[i + 1][j], scores[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", line: after[j] });
      i += 1;
      j += 1;
    } else if (scores[i + 1][j] >= scores[i][j + 1]) {
      ops.push({ type: "delete", line: before[i] });
      i += 1;
    } else {
      ops.push({ type: "insert", line: after[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: "delete", line: before[i++] });
  while (j < m) ops.push({ type: "insert", line: after[j++] });
  return ops;
}

// A change inside earlier rounds stays in those rounds. Only lines added
// after the original document, or past a rewritten tail of the same length,
// are the new question. The question is never the whole buffer.
export function separateHistoryAndQuestion(baseline, edited) {
  const base = String(baseline ?? "").replace(/\n+$/, "");
  const text = String(edited ?? "").replace(/\n+$/, "");
  if (text === base) return { history: base, question: "" };
  // A new question starts on its own line. Characters added to the last
  // existing line are an edit of that line, not the question.
  if (base && text.startsWith(base)) {
    const rest = text.slice(base.length);
    if (rest === "" || rest.startsWith("\n")) return { history: base, question: rest.trim() };
  }
  const before = base ? base.split("\n") : [];
  const after = text ? text.split("\n") : [];
  const ops = lineDiff(before, after);
  let lastEqual = -1;
  for (let index = 0; index < ops.length; index++) if (ops[index].type === "equal") lastEqual = index;
  const historyLines = [];
  for (let index = 0; index <= lastEqual; index++) {
    if (ops[index].type !== "delete") historyLines.push(ops[index].line);
  }
  const tail = ops.slice(lastEqual + 1);
  const removed = tail.filter((op) => op.type === "delete").length;
  const added = tail.filter((op) => op.type === "insert");
  historyLines.push(...added.slice(0, removed).map((op) => op.line));
  return { history: historyLines.join("\n"), question: added.slice(removed).map((op) => op.line).join("\n").trim() };
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
  const { history, question } = separateHistoryAndQuestion(baselineSource, raw);
  if (!question) return { blocked: true };
  return {
    blocked: false,
    conversationFilename: filename,
    draftFilename: null,
    retryTurnId: turnId,
    pending: { prefix: history, question, needsHeading: true },
    content: `${history ? `${history}\n\n` : ""}${userHeading}\n\n${question}`,
  };
}

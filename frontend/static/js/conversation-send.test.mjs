import assert from "node:assert/strict";
import test from "node:test";
import { conversationCompletedSnapshot, planConversationSend, separateHistoryAndQuestion } from "./conversation-send.mjs";

const USER = "## 사용자";
const ASSISTANT = "## 어시스턴트";
const headings = { [USER]: "user", [ASSISTANT]: "assistant", "## User": "user", "## Assistant": "assistant" };
const headingRole = (line) => headings[line] || null;

const firstRound = `${USER}\n\n이번 주 뭐가 달라졌지\n\n${ASSISTANT}\n\nok\n`;
const finished = firstRound.replace(/\n+$/, "");

test("a named .c.md draft stays that file and does not pick a numbered document", () => {
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "draft",
    turnId: null,
    rawContent: "이번 주 뭐가 달라졌지",
    savedContent: "",
    completedContent: null,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.blocked, false);
  assert.equal(plan.conversationFilename, "2026-11-04.c.md");
  assert.equal(plan.draftFilename, "2026-11-04.c.md");
  assert.equal(plan.retryTurnId, null);
  assert.equal(plan.content, "이번 주 뭐가 달라졌지");
  assert.equal(plan.content.includes("0001.md"), false);
});

test("a follow-up on the same .c.md keeps the file and attaches a Korean user heading", () => {
  const snapshot = conversationCompletedSnapshot("2026-11-04.c.md", "exchange", firstRound, headingRole);
  assert.equal(snapshot, finished);
  const typed = `${firstRound}이어서 묻기`;
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: typed,
    savedContent: typed,
    completedContent: snapshot,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.conversationFilename, "2026-11-04.c.md");
  assert.equal(plan.draftFilename, null);
  assert.equal(plan.retryTurnId, "turn1");
  assert.equal(plan.pending.question, "이어서 묻기");
  assert.equal(plan.content, `${finished}\n\n${USER}\n\n이어서 묻기`);
  assert.equal(plan.content.includes("\n\n## 사용자\n\n이어서 묻기"), true);
});

test("a second follow-up still targets the original .c.md", () => {
  const afterSecond = `${finished}\n\n${USER}\n\n이어서 묻기\n\n${ASSISTANT}\n\n다음\n`;
  const snapshot = conversationCompletedSnapshot("2026-11-04.c.md", "exchange", afterSecond, headingRole);
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: `${afterSecond}한 번 더`,
    savedContent: afterSecond,
    completedContent: snapshot,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.conversationFilename, "2026-11-04.c.md");
  assert.equal(plan.retryTurnId, "turn1");
  assert.equal(plan.draftFilename, null);
  assert.equal(plan.pending.question, "한 번 더");
  assert.equal(plan.content.endsWith(`\n\n${USER}\n\n한 번 더`), true);
});

test("an unfinished .c.md exchange is continued, not replaced", () => {
  const pendingFile = `${finished}\n\n${USER}\n\n이어서 묻기\n`;
  assert.equal(conversationCompletedSnapshot("2026-11-04.c.md", "exchange", pendingFile, headingRole), null);
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: pendingFile,
    savedContent: pendingFile,
    completedContent: null,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.retryTurnId, "turn1");
  assert.equal(plan.draftFilename, null);
  assert.equal(plan.content, pendingFile);
  assert.equal(plan.pending.question, "이어서 묻기");
});

test("a conversation file with nothing new does not start a send", () => {
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: firstRound,
    savedContent: firstRound,
    completedContent: finished,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.blocked, true);
});

test("a middle edit stays in earlier rounds and only the appended line is the question", () => {
  const edited = `${USER}\n\n이번 주 뭐가 달라졌지?\n\n${ASSISTANT}\n\nok\n새 질문`;
  const split = separateHistoryAndQuestion(finished, edited);
  assert.equal(split.question, "새 질문");
  assert.equal(split.history.includes("이번 주 뭐가 달라졌지?"), true);
  assert.equal(split.history.includes("새 질문"), false);
  assert.equal(split.history.split("이번 주 뭐가 달라졌지").length - 1, 1);
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: edited,
    savedContent: finished,
    completedContent: finished,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.blocked, false);
  assert.equal(plan.conversationFilename, "2026-11-04.c.md");
  assert.equal(plan.draftFilename, null);
  assert.equal(plan.retryTurnId, "turn1");
  assert.equal(plan.pending.question, "새 질문");
  assert.equal(plan.pending.question.includes(ASSISTANT), false);
  assert.equal(plan.content, `${split.history}\n\n${USER}\n\n새 질문`);
  assert.equal(plan.content.split("이번 주 뭐가 달라졌지").length - 1, 1);
  assert.equal(plan.content.split("새 질문").length - 1, 1);
});

test("rewriting the last answer line keeps that line and still appends only the new question", () => {
  const edited = `${USER}\n\n이번 주 뭐가 달라졌지\n\n${ASSISTANT}\n\nok입니다\n새 질문`;
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: edited,
    savedContent: finished,
    completedContent: finished,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.pending.question, "새 질문");
  assert.equal(plan.pending.prefix.includes("ok입니다"), true);
  assert.equal(plan.pending.prefix.includes("\nok\n"), false);
  assert.equal(plan.pending.prefix.includes("새 질문"), false);
  assert.equal(plan.content.split("이번 주 뭐가 달라졌지").length - 1, 1);
  assert.equal(plan.content.split("새 질문").length - 1, 1);
});

test("a middle edit with no appended question does not start a new round", () => {
  const edited = `${USER}\n\n이번 주 뭐가 달라졌지?\n\n${ASSISTANT}\n\nok`;
  const plan = planConversationSend({
    filename: "2026-11-04.c.md",
    role: "exchange",
    turnId: "turn1",
    rawContent: edited,
    savedContent: finished,
    completedContent: finished,
    userHeading: USER,
    headingRole,
  });
  assert.equal(plan.blocked, true);
});

test("an ordinary numbered draft is left to the normal send path", () => {
  assert.equal(planConversationSend({
    filename: "0001.md",
    role: "draft",
    turnId: null,
    rawContent: "질문",
    savedContent: "",
    completedContent: null,
    userHeading: USER,
    headingRole,
  }), null);
  assert.equal(conversationCompletedSnapshot("2026-11-04.md", "exchange", firstRound, headingRole), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCUSS_MAX_MS,
  FULL_DOCUMENT_CHARS,
  boundDiscussionHistory,
  discussExpired,
  discussionDocumentView,
  formatDiscussMeter,
  formatDocumentContext,
} from "./discussion-context.mjs";

test("a short document is sent whole, a long one as an outline and a nearby passage", () => {
  const short = "# 제목\n\n## 본문\n\n한 줄.\n";
  const full = discussionDocumentView(short, "본문");
  assert.equal(full.mode, "full");
  assert.deepEqual(full.outline, ["제목", "  본문"]);
  assert.equal(formatDocumentContext(full).includes("한 줄."), true);

  const section = `${"# 멀리\n\n"}${"가".repeat(FULL_DOCUMENT_CHARS)}\n\n## 가까운\n\n표적 단어가 여기 있다.\n`;
  const excerpt = discussionDocumentView(section, "표적");
  assert.equal(excerpt.mode, "excerpt");
  assert.ok(excerpt.body.includes("표적 단어가 여기 있다."));
  assert.ok(excerpt.body.length < section.length);
  assert.ok(excerpt.outline.some((line) => line.includes("가까운")));
  const formatted = formatDocumentContext(excerpt);
  assert.equal(formatted.includes("only part of a longer document"), true);
  assert.equal(formatted.includes("가".repeat(FULL_DOCUMENT_CHARS)), false);
});

test("older turns collapse into a summary and the recent ones stay verbatim", () => {
  const turns = [];
  for (let i = 0; i < 10; i++) turns.push({ role: i % 2 ? "assistant" : "user", content: `턴 ${i} ${"말".repeat(20)}` });
  const bounded = boundDiscussionHistory(turns, { recent: 4, budget: 500 });
  assert.equal(bounded.history.length <= 4, true);
  assert.equal(bounded.history.at(-1).content, turns.at(-1).content);
  assert.equal(bounded.summary.includes("턴 0"), true);
  assert.equal(bounded.history.some((turn) => turn.content === turns[0].content), false);
});

test("the meter is approximate Soniox time and the session has a cap", () => {
  assert.deepEqual(formatDiscussMeter(0), { time: "00:00", cost: "$0.000" });
  assert.deepEqual(formatDiscussMeter(90_000), { time: "01:30", cost: "$0.003" });
  assert.equal(discussExpired(DISCUSS_MAX_MS - 1), false);
  assert.equal(discussExpired(DISCUSS_MAX_MS), true);
});

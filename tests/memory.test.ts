import assert from "node:assert/strict";
import test from "node:test";
import { inferAnswers } from "../lib/memory";
import type { AnswerContext, Question } from "../lib/schema";

const context: AnswerContext = {
  company: "Example", title: "Developer Intern", location: "Boston", source: "greenhouse", board: "example",
};
const question: Question = {
  key: "current", promptId: "current", label: "Can you use TypeScript?", kind: "select",
  options: ["Yes", "No"], reusable: true,
};
const saved = {
  id: "saved", label: "What languages have you used?", options: [], answer: "I have used TypeScript for two years.",
  context, recordedAt: "2026-11-01",
};
const proposal = {
  questionId: question.promptId, answer: "Yes",
  citations: [{ id: saved.id, quote: "I have used TypeScript" }],
};

test("memory requires actual citations, valid choices and independent approval", async () => {
  let calls = 0;
  const approved = await inferAnswers([question], context, [saved], async (tier, _system, _data, schema) => {
    assert.equal(tier, "memory");
    return schema.parse(++calls === 1 ? { answers: [proposal] } : { approved: [question.promptId] });
  });
  assert.equal(approved.get(question.promptId), "Yes");
  assert.equal(calls, 2);

  const rejected = await inferAnswers([question], context, [saved], async (_tier, _system, data, schema) =>
    schema.parse("candidates" in (data as object) ? { approved: [] } : { answers: [proposal] }));
  assert.equal(rejected.size, 0);

  for (const draft of [
    { ...proposal, citations: [{ id: saved.id, quote: "I know Rust" }] },
    { ...proposal, answer: "Maybe" },
    { ...proposal, citations: [] },
  ]) {
    let invocations = 0;
    const result = await inferAnswers([question], context, [saved], async (_tier, _system, _data, schema) => {
      invocations++;
      return schema.parse({ answers: [draft] });
    });
    assert.equal(result.size, 0);
    assert.equal(invocations, 1);
  }
});

test("conflicting responses, an empty bank and provider failure all leave the field unanswered", async () => {
  const contradiction = { ...saved, id: "conflict", answer: "I have never used TypeScript." };
  const result = await inferAnswers([question], context, [saved, contradiction], async (_tier, _system, _data, schema) =>
    schema.parse({ answers: [proposal] }));
  assert.equal(result.size, 0);
  let called = false;
  assert.equal((await inferAnswers([question], context, [], async () => {
    called = true;
    throw new Error("Unexpected model call");
  })).size, 0);
  assert.equal(called, false);
  assert.equal((await inferAnswers([question], context, [saved], async () => {
    throw new Error("Budget reached");
  })).size, 0);
});

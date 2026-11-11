import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { answerMemory, applications, jobs, qaBank } from "../lib/schema";
import { resolveFromMemory } from "../lib/memory";
import { claimApplication, command, finishApplication } from "../lib/state";

test("parallel approval, duplicate interactions and stale answers keep one application", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 25_000,
}, async (t) => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(url.pathname, /_test$/);
  process.env.DATABASE_URL = url.toString();
  process.env.DAILY_PREVIEWS = "100";
  t.after(() => db().$client.end());
  const identity = randomUUID();
  const [job] = await db().insert(jobs).values({
    source: "greenhouse", board: "fixture", externalId: identity,
    url: `https://example.com/jobs/${identity}`, identity,
    company: `Example ${identity}`, title: "Intern", description: "", location: "", state: "review",
  }).returning();
  const receipts = await Promise.all([
    command(randomUUID(), { type: "approve", jobId: job.id }),
    command(randomUUID(), { type: "approve", jobId: job.id }),
  ]);
  assert.ok(receipts.includes("Queued for a dry-run preview."));
  assert.equal((await db().select().from(applications).where(eq(applications.jobId, job.id))).length, 1);
  const claimed = await Promise.all([claimApplication(), claimApplication()]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const preview = claimed.find(Boolean)!;
  assert.equal(preview.job.id, job.id);
  const question = {
    key: randomUUID(), label: "Do you have experience with TypeScript?", kind: "select" as const,
    options: ["Yes", "No"], reusable: true, promptId: randomUUID(),
  };
  await finishApplication(preview.app.id, randomUUID(), { type: "question", question });
  const [stillPreparing] = await db().select().from(applications).where(eq(applications.id, preview.app.id));
  assert.equal(stillPreparing.state, "preparing");
  await finishApplication(preview.app.id, preview.lease, { type: "question", question });
  const answer = { type: "answer" as const, appId: preview.app.id, promptId: question.promptId, answer: "yes", remember: true };
  assert.match(await command(randomUUID(), { ...answer, promptId: randomUUID() }), /already been handled/);
  const receipt = randomUUID();
  const approved = await command(receipt, answer);
  assert.match(approved, /Answer saved/);
  assert.equal(await command(receipt, { ...answer, answer: "no" }), approved);
  const resumed = await claimApplication();
  assert.equal(resumed?.app.answers[question.key], "Yes");
  const [saved] = await db().select().from(qaBank).where(eq(qaBank.key, question.key));
  assert.equal(saved.answer, "Yes");
  const personal = {
    key: randomUUID(), label: "Which programming languages do you know?", kind: "text" as const,
    options: [], reusable: true, promptId: randomUUID(),
  };
  await finishApplication(resumed!.app.id, resumed!.lease, { type: "question", question: personal });
  const learned = { ...answer, promptId: personal.promptId, answer: "I know TypeScript.", learn: true as const };
  const saveReceipt = randomUUID();
  assert.match(await command(saveReceipt, learned), /saved to memory/);
  await command(saveReceipt, learned);
  const memory = await db().select().from(answerMemory).where(eq(answerMemory.applicationId, preview.app.id));
  assert.equal(memory.length, 1);
  assert.equal(memory[0].label, personal.label);
  assert.equal(memory[0].answer, "I know TypeScript.");
  assert.equal(memory[0].context.company, job.company);
  const next = { ...personal, promptId: randomUUID(), label: "List programming languages you can use." };
  const inferred = await resolveFromMemory([next], memory[0].context, async (_tier, _system, data, schema) => {
    assert.ok((data as { evidence: { id: string }[] }).evidence.some(({ id }) => id === memory[0].id));
    return schema.parse("candidates" in (data as object) ? { approved: [next.promptId] } : { answers: [{
      questionId: next.promptId, answer: "TypeScript", citations: [{ id: memory[0].id, quote: "I know TypeScript." }],
    }] });
  });
  assert.equal(inferred.get(next.promptId), "TypeScript");
  const afterMemory = (await claimApplication())!;
  const privatePrompt = { ...personal, key: randomUUID(), promptId: randomUUID(), label: "Why this job?" };
  await finishApplication(afterMemory.app.id, afterMemory.lease, { type: "question", question: privatePrompt });
  await command(randomUUID(), { ...answer, promptId: privatePrompt.promptId, answer: "I like this team's work.", remember: false });
  assert.equal((await db().select().from(answerMemory).where(eq(answerMemory.questionKey, privatePrompt.key))).length, 0);
  const ready = (await claimApplication())!;
  await finishApplication(ready.app.id, ready.lease, { type: "preview", path: "previews/test.jpg" });
  assert.equal(await command(randomUUID(), { type: "skipcompany", company: job.company.toUpperCase() }), "Company skipped.");
  const [skipped] = await db().select().from(applications).where(eq(applications.id, preview.app.id));
  assert.equal(skipped.state, "skipped");
});

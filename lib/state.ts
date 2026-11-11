import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import { reservePreview } from "./budget";
import { defaultCriteria, type Criteria } from "./config";
import { db, type Transaction } from "./db";
import { normalize } from "./feeds";
import {
  answerMemory, applications, events, jobs, qaBank, settings, skippedCompanies,
  type Notification, type Question,
} from "./schema";
import { withReceipt } from "./receipts";

export async function lockSettings(tx: Transaction) {
  await tx.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
  return { paused: row.paused, criteria: row.criteria ?? defaultCriteria() };
}

export function addEvent(tx: Transaction, kind: string, options: {
  jobId?: string;
  applicationId?: string;
  data?: Record<string, unknown>;
  notification?: Notification;
  deliveryKey?: string;
} = {}) {
  return tx.insert(events).values({ kind, ...options }).onConflictDoNothing();
}

async function queue(tx: Transaction, job: typeof jobs.$inferSelect) {
  const [app] = await tx.insert(applications).values({
    jobId: job.id,
    state: job.source === "greenhouse" ? "queued" : "needs_manual",
  }).onConflictDoNothing().returning();
  if (!app) return;
  await tx.update(jobs).set({ state: "approved" }).where(eq(jobs.id, job.id));
  await addEvent(tx, "application.approved", { jobId: job.id, applicationId: app.id });
  if (app.state === "needs_manual") {
    await addEvent(tx, "application.manual", {
      jobId: job.id, applicationId: app.id,
      notification: { type: "manual", applicationId: app.id, reason: "This job board uses manual application entry." },
    });
  }
}

export async function finishScore(job: typeof jobs.$inferSelect, fit: { score: number; reason: string }) {
  await db().transaction(async (tx) => {
    const { criteria, paused } = await lockSettings(tx);
    if (paused) return;
    const [skip] = await tx.select().from(skippedCompanies).where(eq(skippedCompanies.key, normalize(job.company)));
    const state = skip ? "skipped" : fit.score < criteria.minimumScore ? "filtered" : "review";
    const [updated] = await tx.update(jobs).set({
      ...fit, state, scoreLease: null, scoreLeaseUntil: null,
    }).where(and(eq(jobs.id, job.id), eq(jobs.scoreLease, job.scoreLease!), eq(jobs.state, "discovered"))).returning();
    if (!updated) return;
    const autoPreview = state === "review" && job.source === "greenhouse" && fit.score >= criteria.autoPreviewScore;
    await addEvent(tx, "job.scored", {
      jobId: job.id, data: { score: fit.score, state },
      notification: state === "review" ? { type: "match", jobId: job.id } : undefined,
    });
    if (autoPreview) await queue(tx, updated);
  });
}

export async function claimApplication() {
  return db().transaction(async (tx) => {
    if ((await lockSettings(tx)).paused) return;
    const [row] = await tx.select({ app: applications, job: jobs }).from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(or(eq(applications.state, "queued"), and(eq(applications.state, "preparing"), lt(applications.leaseUntil, sql`now()`))))
      .orderBy(asc(applications.updatedAt)).limit(1).for("update", { of: applications });
    if (!row || !await reservePreview(tx)) return;
    const lease = randomUUID();
    await tx.update(applications).set({
      state: "preparing", lease, leaseUntil: sql`now() + interval '6 minutes'`, updatedAt: new Date(),
    }).where(eq(applications.id, row.app.id));
    await addEvent(tx, "application.preparing", { applicationId: row.app.id, jobId: row.job.id });
    return { ...row, lease };
  });
}

type Outcome =
  | { type: "question"; question: Question }
  | { type: "preview"; path: string; resumeVersion?: string; memoryAnswers?: number }
  | { type: "manual"; reason: string };

export async function finishApplication(id: string, lease: string, outcome: Outcome) {
  await db().transaction(async (tx) => {
    const patch = {
      state: outcome.type === "question" ? "needs_input" : outcome.type === "preview" ? "preview_ready" : "needs_manual",
      question: outcome.type === "question" ? outcome.question : null,
      screenshotPath: outcome.type === "preview" ? outcome.path : null,
      resumeVersion: outcome.type === "preview" ? outcome.resumeVersion : null,
      lease: null, leaseUntil: null, updatedAt: new Date(),
    } as const;
    const [app] = await tx.update(applications).set(patch)
      .where(and(eq(applications.id, id), eq(applications.state, "preparing"), eq(applications.lease, lease)))
      .returning();
    if (!app) return;
    const notification = outcome.type === "question"
      ? { type: outcome.type, applicationId: id, promptId: outcome.question.promptId }
      : { ...outcome, applicationId: id };
    await addEvent(tx, `application.${patch.state}`, {
      applicationId: id, jobId: app.jobId, notification,
    });
  });
}

export type Action =
  | { type: "status" }
  | { type: "pause"; paused: boolean }
  | { type: "criteria"; patch: Partial<Criteria> }
  | { type: "skipcompany"; company: string }
  | { type: "approve" | "skip"; jobId: string }
  | { type: "answer"; appId: string; promptId: string; answer: string; remember: boolean; learn?: true }
  | { type: "record"; thread: string; state: "submitted" | "confirmed" | "rejected" | "interview" };

export function answerFor(question: Pick<Question, "options">, raw: string) {
  const value = raw.trim();
  if (!value || value.length > 1800 || /\u0000/.test(value)) return;
  if (!question.options.length) return value;
  const matches = question.options.filter((option) => normalize(option) === normalize(value));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function command(id: string, action: Action) {
  return withReceipt(id, async (tx) => {
    const current = await lockSettings(tx);
    return applyAction(tx, current, action);
  });
}

async function applyAction(tx: Transaction, current: { paused: boolean; criteria: Criteria }, action: Action) {
  switch (action.type) {
    case "status": {
      const apps = await tx.select({ state: applications.state, total: count() }).from(applications).groupBy(applications.state);
      const [reviews] = await tx.select({ total: count() }).from(jobs).where(eq(jobs.state, "review"));
      return [
        current.paused ? "Paused." : "Running in preview mode.",
        `${reviews.total} matches awaiting review.`,
        ...apps.map(({ state, total }) => `${state.replaceAll("_", " ")} · ${total}`),
      ].join("\n");
    }
    case "pause":
      await tx.update(settings).set({ paused: action.paused }).where(eq(settings.id, 1));
      await addEvent(tx, action.paused ? "system.paused" : "system.resumed");
      return action.paused ? "Paused. In-progress previews may finish." : "Resumed.";
    case "criteria": {
      if (!Object.keys(action.patch).length) {
        const { description, titleTerms, minimumScore, autoPreviewScore } = current.criteria;
        return `Minimum score ${minimumScore}. Auto-preview ${autoPreviewScore === 101 ? "off" : `at ${autoPreviewScore}`}.\nTitles: ${titleTerms.join(", ") || "all"}.\n${description}`.slice(0, 1950);
      }
      const criteria = { ...current.criteria, ...action.patch };
      if (criteria.autoPreviewScore < criteria.minimumScore) return "The auto-preview score must be at least the minimum score.";
      await tx.update(settings).set({ criteria }).where(eq(settings.id, 1));
      await tx.update(jobs).set({ state: "discovered", score: null, reason: null, scoreLease: null, scoreLeaseUntil: null })
        .where(inArray(jobs.state, ["filtered", "discovered"]));
      await addEvent(tx, "criteria.updated");
      return "Criteria updated. New and filtered jobs will be checked against it.";
    }
    case "skipcompany": {
      const key = normalize(action.company);
      if (!key) return "Enter a company name.";
      await tx.insert(skippedCompanies).values({ key }).onConflictDoNothing();
      const companyIds = tx.select({ id: jobs.id }).from(jobs)
        .where(sql`lower(regexp_replace(trim(normalize(${jobs.company}, NFKC)), '[[:space:]]+', ' ', 'g')) = ${key}`);
      await tx.update(applications).set({ state: "skipped", question: null, updatedAt: new Date() })
        .where(and(inArray(applications.jobId, companyIds), inArray(applications.state, ["queued", "preparing", "needs_input", "preview_ready", "needs_manual"])));
      await tx.update(jobs).set({ state: "skipped" })
        .where(and(inArray(jobs.id, companyIds), inArray(jobs.state, ["review", "discovered", "filtered"])));
      await addEvent(tx, "company.skipped", { data: { key } });
      return "Company skipped.";
    }
    case "approve":
    case "skip": {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, action.jobId)).for("update");
      if (!job) return "This match no longer exists.";
      if (job.state !== "review") return `This match is already ${job.state}.`;
      if (action.type === "skip") {
        await tx.update(jobs).set({ state: "skipped" }).where(eq(jobs.id, job.id));
        await addEvent(tx, "job.skipped", { jobId: job.id });
        return "Skipped.";
      }
      await queue(tx, job);
      return job.source === "greenhouse" ? "Queued for a dry-run preview." : "Added to the manual application queue.";
    }
    case "answer": {
      const [app] = await tx.select().from(applications).where(eq(applications.id, action.appId)).for("update");
      if (!app?.question || app.state !== "needs_input" || app.question.promptId !== action.promptId) {
        return "This question has already been handled or replaced.";
      }
      const answer = answerFor(app.question, action.answer);
      if (!answer) return "Enter a valid answer. For a choice, use the option label shown in the thread.";
      if (action.learn && app.question.reusable) {
        const [context] = await tx.select({
          company: jobs.company, title: jobs.title, location: jobs.location, board: jobs.board, source: jobs.source,
        }).from(jobs).where(eq(jobs.id, app.jobId));
        await tx.insert(answerMemory).values({
          applicationId: app.id, questionKey: app.question.key, label: app.question.label,
          options: app.question.options, answer, context,
        }).onConflictDoNothing();
      } else if (action.remember && app.question.reusable) {
        await tx.insert(qaBank).values({ key: app.question.key, answer }).onConflictDoUpdate({
          target: qaBank.key, set: { answer, updatedAt: new Date() },
        });
      }
      await tx.update(applications).set({
        state: "queued", question: null, answers: { ...app.answers, [app.question.key]: answer }, updatedAt: new Date(),
      }).where(eq(applications.id, app.id));
      await addEvent(tx, "application.answered", { applicationId: app.id, jobId: app.jobId });
      return action.learn && app.question.reusable
        ? "Answer saved to memory. The preview will resume from the application queue."
        : "Answer saved. The preview will resume from the application queue.";
    }
    case "record": {
      const [app] = await tx.select().from(applications).where(eq(applications.threadId, action.thread)).for("update");
      if (!app || !["preview_ready", "needs_manual", "submitted", "confirmed", "interview", "rejected"].includes(app.state)) {
        return "Use this command in a thread for an application ready for manual handling.";
      }
      await tx.update(applications).set({
        state: action.state, submittedAt: app.submittedAt ?? new Date(), updatedAt: new Date(),
      }).where(eq(applications.id, app.id));
      await addEvent(tx, `application.${action.state}`, {
        applicationId: app.id, jobId: app.jobId, data: { recordedByOwner: true },
      });
      return `Recorded as ${action.state}.`;
    }
  }
}

export async function makeDigest(day: string) {
  await db().transaction(async (tx) => {
    const counts = await tx.select({ state: applications.state, total: count() }).from(applications).groupBy(applications.state);
    const [reviews] = await tx.select({ total: count() }).from(jobs).where(eq(jobs.state, "review"));
    await addEvent(tx, "digest.ready", {
      deliveryKey: `digest:${day}`,
      notification: { type: "digest", counts: { review: reviews.total, ...Object.fromEntries(counts.map((row) => [row.state, row.total])) } },
    });
  });
}

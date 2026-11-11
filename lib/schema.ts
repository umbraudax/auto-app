import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jobSources, type Board, type Criteria } from "./config";

export const sources = pgEnum("job_source", jobSources);
export const jobStates = pgEnum("job_state", ["discovered", "filtered", "review", "approved", "skipped"]);
export const applicationStates = pgEnum("application_state", [
  "queued", "preparing", "needs_input", "preview_ready", "needs_manual",
  "submitted", "confirmed", "rejected", "interview", "skipped",
]);

export const jobs = pgTable("jobs", {
  id: uuid().primaryKey().defaultRandom(),
  source: sources().notNull(),
  board: text().notNull(),
  externalId: text().notNull(),
  url: text().notNull().unique(),
  identity: text().notNull().unique(),
  company: text().notNull(),
  title: text().notNull(),
  location: text().notNull(),
  description: text().notNull(),
  score: integer(),
  reason: text(),
  state: jobStates().notNull().default("discovered"),
  foundAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  scoreLease: uuid(),
  scoreLeaseUntil: timestamp({ withTimezone: true }),
  reviewMessage: text(),
}, (table) => [
  uniqueIndex().on(table.source, table.board, table.externalId),
  index().on(table.state, table.foundAt),
]);

export type Question = {
  key: string;
  label: string;
  kind: "text" | "select" | "radio";
  options: string[];
  reusable: boolean;
  promptId: string;
};

export const applications = pgTable("applications", {
  id: uuid().primaryKey().defaultRandom(),
  jobId: uuid().notNull().unique().references(() => jobs.id),
  state: applicationStates().notNull().default("queued"),
  question: jsonb().$type<Question>(),
  answers: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  resumeVersion: text(),
  screenshotPath: text(),
  submittedAt: timestamp({ withTimezone: true }),
  threadId: text(),
  lease: uuid(),
  leaseUntil: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.state, table.updatedAt)]);

export const qaBank = pgTable("qa_bank", {
  key: text().primaryKey(),
  answer: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type AnswerContext = Pick<typeof jobs.$inferSelect, "company" | "title" | "location" | "board" | "source">;

export const answerMemory = pgTable("answer_memory", {
  id: uuid().primaryKey().defaultRandom(),
  applicationId: uuid().notNull().references(() => applications.id),
  questionKey: text().notNull(),
  label: text().notNull(),
  options: jsonb().$type<string[]>().notNull(),
  answer: text().notNull(),
  context: jsonb().$type<AnswerContext>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex().on(table.applicationId, table.questionKey),
  index().on(table.questionKey),
]);

export const resumes = pgTable("resumes", {
  id: uuid().primaryKey().defaultRandom(),
  pathname: text().notNull().unique(),
  filename: text().notNull(),
  version: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  uploadedAt: timestamp({ withTimezone: true }),
  deleteRequestedAt: timestamp({ withTimezone: true }),
});

export const resumeSettings = pgTable("resume_settings", {
  id: integer().primaryKey(),
  defaultResumeId: uuid().references(() => resumes.id, { onDelete: "set null" }),
});

export const settings = pgTable("settings", {
  id: integer().primaryKey(),
  paused: boolean().notNull().default(false),
  criteria: jsonb().$type<Criteria>(),
});

export const skippedCompanies = pgTable("skipped_companies", {
  key: text().primaryKey(),
});

export const jobBoards = pgTable("job_boards", {
  key: text().primaryKey(),
  source: sources().$type<Board["source"]>().notNull(),
  slug: text().notNull(),
  company: text().notNull(),
  region: text().$type<Board["region"]>().notNull().default("global"),
  foundVia: text().notNull(),
  addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp({ withTimezone: true }),
  nextCheckAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastError: text(),
}, (table) => [index().on(table.nextCheckAt)]);

export const dailyUsage = pgTable("daily_usage", {
  day: date().primaryKey(),
  claudeMicros: integer().notNull().default(0),
  previews: integer().notNull().default(0),
});

export type Notification =
  | { type: "match"; jobId: string }
  | { type: "discovery"; summary: string }
  | { type: "question"; applicationId: string; promptId: string }
  | { type: "preview"; applicationId: string; path: string; memoryAnswers?: number }
  | { type: "manual"; applicationId: string; reason: string }
  | { type: "digest"; counts: Record<string, number> };

export const events = pgTable("events", {
  id: serial().primaryKey(),
  kind: text().notNull(),
  jobId: uuid().references(() => jobs.id),
  applicationId: uuid().references(() => applications.id),
  data: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  notification: jsonb().$type<Notification>(),
  deliveryKey: text().unique(),
  deliveredAt: timestamp({ withTimezone: true }),
  attempts: integer().notNull().default(0),
  nextAttempt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.nextAttempt, table.id).where(sql`${table.deliveredAt} is null and ${table.notification} is not null`)]);

export const interactions = pgTable("interactions", {
  id: text().primaryKey(),
  reply: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

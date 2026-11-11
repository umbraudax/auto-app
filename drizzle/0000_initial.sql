CREATE TYPE "public"."application_state" AS ENUM('queued', 'preparing', 'needs_input', 'preview_ready', 'needs_manual', 'submitted', 'confirmed', 'rejected', 'interview', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('discovered', 'filtered', 'review', 'approved', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_source" AS ENUM('greenhouse', 'lever', 'ashby');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jobId" uuid NOT NULL,
	"state" "application_state" DEFAULT 'queued' NOT NULL,
	"question" jsonb,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resumeVersion" text,
	"screenshotPath" text,
	"submittedAt" timestamp with time zone,
	"threadId" text,
	"lease" uuid,
	"leaseUntil" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_jobId_unique" UNIQUE("jobId")
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"claudeMicros" integer DEFAULT 0 NOT NULL,
	"previews" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"jobId" uuid,
	"applicationId" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notification" jsonb,
	"deliveryKey" text,
	"deliveredAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttempt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_deliveryKey_unique" UNIQUE("deliveryKey")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"reply" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "job_source" NOT NULL,
	"board" text NOT NULL,
	"externalId" text NOT NULL,
	"url" text NOT NULL,
	"identity" text NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"location" text NOT NULL,
	"description" text NOT NULL,
	"score" integer,
	"reason" text,
	"state" "job_state" DEFAULT 'discovered' NOT NULL,
	"foundAt" timestamp with time zone DEFAULT now() NOT NULL,
	"scoreLease" uuid,
	"scoreLeaseUntil" timestamp with time zone,
	"reviewMessage" text,
	CONSTRAINT "jobs_url_unique" UNIQUE("url"),
	CONSTRAINT "jobs_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE TABLE "qa_bank" (
	"key" text PRIMARY KEY NOT NULL,
	"answer" text NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"criteria" jsonb
);
--> statement-breakpoint
CREATE TABLE "skipped_companies" (
	"key" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_jobId_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_applicationId_applications_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_state_updatedAt_index" ON "applications" USING btree ("state","updatedAt");--> statement-breakpoint
CREATE INDEX "events_nextAttempt_id_index" ON "events" USING btree ("nextAttempt","id") WHERE "events"."deliveredAt" is null and "events"."notification" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_board_externalId_index" ON "jobs" USING btree ("source","board","externalId");--> statement-breakpoint
CREATE INDEX "jobs_state_foundAt_index" ON "jobs" USING btree ("state","foundAt");
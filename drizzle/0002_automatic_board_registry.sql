ALTER TYPE "public"."job_source" ADD VALUE 'smartrecruiters';--> statement-breakpoint
ALTER TYPE "public"."job_source" ADD VALUE 'workable';--> statement-breakpoint
ALTER TYPE "public"."job_source" ADD VALUE 'public_feed';--> statement-breakpoint
CREATE TABLE "job_boards" (
	"key" text PRIMARY KEY NOT NULL,
	"source" "job_source" NOT NULL,
	"slug" text NOT NULL,
	"company" text NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"foundVia" text NOT NULL,
	"addedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastCheckedAt" timestamp with time zone,
	"nextCheckAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastError" text
);
--> statement-breakpoint
CREATE INDEX "job_boards_nextCheckAt_index" ON "job_boards" USING btree ("nextCheckAt");
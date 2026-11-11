CREATE TABLE "answer_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicationId" uuid NOT NULL,
	"questionKey" text NOT NULL,
	"label" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer" text NOT NULL,
	"context" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"defaultResumeId" uuid
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pathname" text NOT NULL,
	"filename" text NOT NULL,
	"version" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"uploadedAt" timestamp with time zone,
	"deleteRequestedAt" timestamp with time zone,
	CONSTRAINT "resumes_pathname_unique" UNIQUE("pathname")
);
--> statement-breakpoint
ALTER TABLE "answer_memory" ADD CONSTRAINT "answer_memory_applicationId_applications_id_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_settings" ADD CONSTRAINT "resume_settings_defaultResumeId_resumes_id_fk" FOREIGN KEY ("defaultResumeId") REFERENCES "public"."resumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_memory_applicationId_questionKey_index" ON "answer_memory" USING btree ("applicationId","questionKey");--> statement-breakpoint
CREATE INDEX "answer_memory_questionKey_index" ON "answer_memory" USING btree ("questionKey");
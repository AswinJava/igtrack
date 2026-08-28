CREATE TYPE "public"."job_outcome" AS ENUM('COMPLETED', 'COMPLETED_EMPTY', 'COMPLETED_PARTIAL', 'UNAVAILABLE', 'SKIPPED_PAUSED', 'SKIPPED_STOPPED');--> statement-breakpoint
CREATE TABLE "scheduler_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitoring_jobs" ADD COLUMN "outcome" "job_outcome";
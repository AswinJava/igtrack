-- Autonomous public-web research (FOUNDING §19, D69). A research run records
-- what the ENGINE attempted — question, focus, enforced bounds, and a
-- per-document outcome including every refusal and failure, which are
-- findings, not noise. Claims extracted by a run live in the existing claims
-- ledger (one ledger, one validation gate); claims.research_run_id is
-- provenance only and deliberately has no FK: runs and claims cascade
-- together on target/user delete, so a dangling reference cannot arise
-- through any code path, and a claim must never die with its run's history.
CREATE TYPE "research_run_status" AS ENUM ('COMPLETED', 'COMPLETED_PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "research_document_outcome" AS ENUM ('FETCHED', 'REUSED', 'FAILED', 'BLOCKED_BY_POLICY', 'BLOCKED_BY_ROBOTS', 'UNSAFE_URL', 'BLOCKED_CONTENT_TYPE', 'TOO_LARGE', 'TIMEOUT', 'NOT_FOUND', 'RATE_LIMITED', 'NETWORK_ERROR');--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_id" text NOT NULL,
	"question" text NOT NULL,
	"focus_intent" text NOT NULL,
	"focus_priorities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"focus_rationale" text NOT NULL,
	"max_sources" integer NOT NULL,
	"max_depth" integer NOT NULL,
	"search_provider" text,
	"search_queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_unavailable_reason" text,
	"operator_url_count" integer DEFAULT 0 NOT NULL,
	"bounds_truncated" integer DEFAULT 0 NOT NULL,
	"status" "research_run_status" NOT NULL,
	"documents_planned" integer DEFAULT 0 NOT NULL,
	"documents_fetched" integer DEFAULT 0 NOT NULL,
	"documents_failed" integer DEFAULT 0 NOT NULL,
	"candidates_found" integer DEFAULT 0 NOT NULL,
	"claims_stored" integer DEFAULT 0 NOT NULL,
	"claims_duplicate" integer DEFAULT 0 NOT NULL,
	"claims_refused" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_runs_user_idx" ON "research_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "research_runs_target_idx" ON "research_runs" USING btree ("target_id","started_at");--> statement-breakpoint
CREATE TABLE "research_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"source_type" text NOT NULL,
	"outcome" "research_document_outcome" NOT NULL,
	"outcome_reason" text,
	"http_status" integer,
	"title" text,
	"content_type" text,
	"byte_size" integer,
	"content_sha256" text,
	"retrieved_at" timestamp with time zone,
	"candidates_found" integer DEFAULT 0 NOT NULL,
	"links_not_followed" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "research_documents" ADD CONSTRAINT "research_documents_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_documents" ADD CONSTRAINT "research_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_documents_url_idx" ON "research_documents" USING btree ("run_id","url");--> statement-breakpoint
CREATE INDEX "research_documents_user_idx" ON "research_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "research_documents_fresh_idx" ON "research_documents" USING btree ("user_id","url","outcome");--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "research_run_id" text;
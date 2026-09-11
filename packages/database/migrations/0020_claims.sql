-- The claims ledger. Operator/agent-submitted findings
-- about an observed account, each with the source that stated it. IGTrack
-- stores claims; it never generates them — there is deliberately no PLATFORM
-- source kind, because a platform read is an observation and belongs in the
-- evidence ledger, not here. Duplicate (target, predicate, value, source_url)
-- rows are refused: re-submitting the same finding is not corroboration.
-- The coalesce folds "no source URL" (operator claims) into one deduplicable
-- value; under Postgres' default NULL semantics the index would otherwise
-- let every repeated operator claim through.
CREATE TYPE "claim_source_kind" AS ENUM ('OPERATOR', 'WEB');--> statement-breakpoint
CREATE TYPE "claim_status" AS ENUM ('ACTIVE', 'RETRACTED');--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_id" text NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"source_kind" "claim_source_kind" NOT NULL,
	"source_url" text,
	"source_title" text,
	"excerpt" text,
	"excerpt_hash" text,
	"stated_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "claim_status" DEFAULT 'ACTIVE' NOT NULL,
	"retracted_at" timestamp with time zone,
	"retraction_reason" text
);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claims_dedup_idx" ON "claims" USING btree ("target_id","predicate","value",coalesce("source_url", ''));--> statement-breakpoint
CREATE INDEX "claims_target_status_idx" ON "claims" USING btree ("target_id","status");--> statement-breakpoint
CREATE INDEX "claims_user_idx" ON "claims" USING btree ("user_id");

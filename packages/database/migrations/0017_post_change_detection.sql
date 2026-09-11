-- Media change detection for owned targets. The posts
-- table is append-only and first-observation-wins, so a caption edit or a post
-- leaving the media listing was undetectable. post_presence is the one mutable
-- state row per stored post (deliberately not append-only: it is current state,
-- not a claim); post_changes is the append-only event family.
-- 'NO_LONGER_OBSERVED' is the honest event name — the graph never tells us a
-- post was deleted, only that a COMPLETE listing no longer contained it.
CREATE TYPE "post_presence_state" AS ENUM ('PRESENT', 'ABSENT');--> statement-breakpoint
CREATE TYPE "post_change_kind" AS ENUM ('CAPTION_EDITED', 'NO_LONGER_OBSERVED');--> statement-breakpoint
CREATE TABLE "post_presence" (
	"post_db_id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"source_id" text NOT NULL,
	"state" "post_presence_state" DEFAULT 'PRESENT' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_scan_at" timestamp with time zone NOT NULL,
	"last_caption" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "post_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"post_db_id" text NOT NULL,
	"change" "post_change_kind" NOT NULL,
	"old_value" text,
	"new_value" text,
	"detected_at" timestamp with time zone NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "post_presence" ADD CONSTRAINT "post_presence_post_db_id_posts_id_fk" FOREIGN KEY ("post_db_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_presence" ADD CONSTRAINT "post_presence_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_presence" ADD CONSTRAINT "post_presence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_changes" ADD CONSTRAINT "post_changes_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_changes" ADD CONSTRAINT "post_changes_post_db_id_posts_id_fk" FOREIGN KEY ("post_db_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_changes" ADD CONSTRAINT "post_changes_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_presence_scope_idx" ON "post_presence" USING btree ("target_id","source_id","state","last_scan_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_changes_idempotency_idx" ON "post_changes" USING btree ("post_db_id","change","detected_at");--> statement-breakpoint
CREATE INDEX "post_changes_target_time_idx" ON "post_changes" USING btree ("target_id","detected_at");--> statement-breakpoint
CREATE TRIGGER "post_changes_no_update" BEFORE UPDATE ON "post_changes" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();

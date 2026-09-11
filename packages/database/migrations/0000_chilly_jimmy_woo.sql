CREATE TYPE "public"."confidence_level" AS ENUM('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."follow_change" AS ENUM('NEW_FOLLOWING', 'LOST_FOLLOWING', 'NEW_FOLLOWER', 'LOST_FOLLOWER');--> statement-breakpoint
CREATE TYPE "public"."follow_direction" AS ENUM('FOLLOWERS', 'FOLLOWING');--> statement-breakpoint
CREATE TYPE "public"."interaction_kind" AS ENUM('COMMENT', 'REPLY', 'MENTION', 'TAG', 'LIKE_SIGNAL');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('IMAGE', 'VIDEO', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."mention_visibility" AS ENUM('VISIBLE', 'POSSIBLY_HIDDEN', 'OFF_CANVAS', 'METADATA_ONLY', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."observation_category" AS ENUM('OBSERVED', 'DERIVED', 'INFERRED', 'UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."retention_state" AS ENUM('RETAINED', 'PENDING_DELETION', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."snapshot_completeness" AS ENUM('COMPLETE', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."source_health_status" AS ENUM('HEALTHY', 'DEGRADED', 'UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('FIXTURE', 'IMPORT', 'GRAPH_API', 'USER_PROVIDED');--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('ACTIVE', 'PAUSED', 'STOPPED');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"observation_kind" text NOT NULL,
	"observation_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_reference" text,
	"provider_version" text,
	"schema_version" text,
	"observed_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"raw_hash" text NOT NULL,
	"normalized_hash" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_raw_hash_length_chk" CHECK (char_length("evidence"."raw_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "follow_deltas" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"direction" "follow_direction" NOT NULL,
	"change" "follow_change" NOT NULL,
	"ig_account_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"from_snapshot_id" text,
	"to_snapshot_id" text NOT NULL,
	"confidence" "confidence_level" DEFAULT 'HIGH' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_snapshot_members" (
	"snapshot_id" text NOT NULL,
	"ig_account_id" text NOT NULL,
	CONSTRAINT "follow_snapshot_members_snapshot_id_ig_account_id_pk" PRIMARY KEY("snapshot_id","ig_account_id")
);
--> statement-breakpoint
CREATE TABLE "follow_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"direction" "follow_direction" NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"source_id" text NOT NULL,
	"completeness" "snapshot_completeness" NOT NULL,
	"total_observed" integer DEFAULT 0 NOT NULL,
	"cursor_state" text,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ig_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_id" text,
	"username" text NOT NULL,
	"username_lower" text NOT NULL,
	"display_name" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"account_type" text,
	"profile_pic_url" text,
	"bio" text,
	"external_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ig_accounts_username_lower_unique" UNIQUE("username_lower")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"kind" "interaction_kind" NOT NULL,
	"post_ref" text,
	"external_ref" text,
	"observed_at" timestamp with time zone NOT NULL,
	"text_meta" text,
	"source_id" text NOT NULL,
	"category" "observation_category" DEFAULT 'OBSERVED' NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_checkpoints" (
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"job_id" text,
	"cursor" text,
	"page" integer DEFAULT 0 NOT NULL,
	"progress" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_checkpoints_target_id_kind_pk" PRIMARY KEY("target_id","kind")
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" "media_type" NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"checksum" text,
	"source_id" text,
	"retention_state" "retention_state" DEFAULT 'RETAINED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "monitoring_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_jobs_attempts_chk" CHECK ("monitoring_jobs"."attempts" >= 0),
	CONSTRAINT "monitoring_jobs_max_attempts_chk" CHECK ("monitoring_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "profile_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"from_snapshot_id" text,
	"to_snapshot_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_id" text NOT NULL,
	"evidence_id" text,
	"username" text NOT NULL,
	"display_name" text,
	"bio" text,
	"profile_pic_url" text,
	"external_url" text,
	"follower_count" integer,
	"following_count" integer,
	"post_count" integer,
	"is_verified" boolean,
	"category" "observation_category" DEFAULT 'OBSERVED' NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_health" (
	"source_id" text NOT NULL,
	"capability" text NOT NULL,
	"status" "source_health_status" NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error_category" text,
	"latency_ms" integer,
	"coverage_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_health_source_id_capability_pk" PRIMARY KEY("source_id","capability")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"provider_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_account_id" text NOT NULL,
	"story_id" text NOT NULL,
	"source_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"media_type" "media_type" NOT NULL,
	"duration_ms" integer,
	"caption" text,
	"has_link" boolean DEFAULT false NOT NULL,
	"sticker_kinds" text[] DEFAULT '{}' NOT NULL,
	"poll" jsonb,
	"question" jsonb,
	"location" jsonb,
	"music" jsonb,
	"category" "observation_category" DEFAULT 'OBSERVED' NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"story_db_id" text NOT NULL,
	"mentioned_account_id" text NOT NULL,
	"position_x" real,
	"position_y" real,
	"width" real,
	"height" real,
	"raw_visibility_flag" boolean,
	"visibility_class" "mention_visibility" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ig_account_id" text NOT NULL,
	"local_name" text,
	"notes" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" "target_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_deltas" ADD CONSTRAINT "follow_deltas_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_deltas" ADD CONSTRAINT "follow_deltas_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_deltas" ADD CONSTRAINT "follow_deltas_from_snapshot_id_follow_snapshots_id_fk" FOREIGN KEY ("from_snapshot_id") REFERENCES "public"."follow_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_deltas" ADD CONSTRAINT "follow_deltas_to_snapshot_id_follow_snapshots_id_fk" FOREIGN KEY ("to_snapshot_id") REFERENCES "public"."follow_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_snapshot_members" ADD CONSTRAINT "follow_snapshot_members_snapshot_id_follow_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."follow_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_snapshot_members" ADD CONSTRAINT "follow_snapshot_members_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_snapshots" ADD CONSTRAINT "follow_snapshots_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_snapshots" ADD CONSTRAINT "follow_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_snapshots" ADD CONSTRAINT "follow_snapshots_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_actor_account_id_ig_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checkpoints" ADD CONSTRAINT "job_checkpoints_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checkpoints" ADD CONSTRAINT "job_checkpoints_job_id_monitoring_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."monitoring_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_jobs" ADD CONSTRAINT "monitoring_jobs_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_from_snapshot_id_profile_snapshots_id_fk" FOREIGN KEY ("from_snapshot_id") REFERENCES "public"."profile_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_changes" ADD CONSTRAINT "profile_changes_to_snapshot_id_profile_snapshots_id_fk" FOREIGN KEY ("to_snapshot_id") REFERENCES "public"."profile_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_mentions" ADD CONSTRAINT "story_mentions_story_db_id_stories_id_fk" FOREIGN KEY ("story_db_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_mentions" ADD CONSTRAINT "story_mentions_mentioned_account_id_ig_accounts_id_fk" FOREIGN KEY ("mentioned_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_mentions" ADD CONSTRAINT "story_mentions_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_observation_unique_idx" ON "evidence" USING btree ("observation_kind","observation_id");--> statement-breakpoint
CREATE INDEX "evidence_source_idx" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_deltas_idempotency_idx" ON "follow_deltas" USING btree ("target_id","direction","change","ig_account_id","to_snapshot_id");--> statement-breakpoint
CREATE INDEX "follow_deltas_target_seen_idx" ON "follow_deltas" USING btree ("target_id","direction","first_seen_at");--> statement-breakpoint
CREATE INDEX "follow_snapshot_members_account_idx" ON "follow_snapshot_members" USING btree ("ig_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_snapshots_idempotency_idx" ON "follow_snapshots" USING btree ("target_id","direction","taken_at","source_id");--> statement-breakpoint
CREATE INDEX "follow_snapshots_target_time_idx" ON "follow_snapshots" USING btree ("target_id","direction","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ig_accounts_ig_id_unique_idx" ON "ig_accounts" USING btree ("ig_id") WHERE "ig_accounts"."ig_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_external_ref_unique_idx" ON "interactions" USING btree ("source_id","external_ref") WHERE "interactions"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "interactions_target_time_idx" ON "interactions" USING btree ("target_id","observed_at");--> statement-breakpoint
CREATE INDEX "interactions_actor_idx" ON "interactions" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "media_assets_retention_idx" ON "media_assets" USING btree ("retention_state");--> statement-breakpoint
CREATE UNIQUE INDEX "monitoring_jobs_idempotency_idx" ON "monitoring_jobs" USING btree ("idempotency_key") WHERE "monitoring_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "monitoring_jobs_claimable_idx" ON "monitoring_jobs" USING btree ("status","available_at") WHERE "monitoring_jobs"."status" IN ('queued', 'retry_wait');--> statement-breakpoint
CREATE INDEX "monitoring_jobs_target_idx" ON "monitoring_jobs" USING btree ("target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_changes_idempotency_idx" ON "profile_changes" USING btree ("ig_account_id","field","to_snapshot_id");--> statement-breakpoint
CREATE INDEX "profile_changes_account_time_idx" ON "profile_changes" USING btree ("ig_account_id","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_snapshots_idempotency_idx" ON "profile_snapshots" USING btree ("ig_account_id","source_id","observed_at");--> statement-breakpoint
CREATE INDEX "profile_snapshots_account_time_idx" ON "profile_snapshots" USING btree ("ig_account_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stories_idempotency_idx" ON "stories" USING btree ("ig_account_id","story_id","source_id");--> statement-breakpoint
CREATE INDEX "stories_account_taken_idx" ON "stories" USING btree ("ig_account_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "story_mentions_idempotency_idx" ON "story_mentions" USING btree ("story_db_id","mentioned_account_id");--> statement-breakpoint
CREATE INDEX "story_mentions_account_idx" ON "story_mentions" USING btree ("mentioned_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_user_account_unique_idx" ON "targets" USING btree ("user_id","ig_account_id");--> statement-breakpoint
CREATE INDEX "targets_user_idx" ON "targets" USING btree ("user_id");--> statement-breakpoint
-- IGTrack append-only enforcement: observation tables must never be mutated.
-- Historical truth survives current-state changes; current state is derived.
-- UPDATE is rejected at the database level. DELETE remains allowed so retention
-- and target-cascade cleanup can purge data lawfully.
CREATE OR REPLACE FUNCTION "igtrack_reject_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'igtrack: table "%" is append-only; updates are forbidden', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "evidence_no_update" BEFORE UPDATE ON "evidence" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "profile_snapshots_no_update" BEFORE UPDATE ON "profile_snapshots" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "profile_changes_no_update" BEFORE UPDATE ON "profile_changes" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "stories_no_update" BEFORE UPDATE ON "stories" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "story_mentions_no_update" BEFORE UPDATE ON "story_mentions" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "follow_snapshots_no_update" BEFORE UPDATE ON "follow_snapshots" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "follow_snapshot_members_no_update" BEFORE UPDATE ON "follow_snapshot_members" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "follow_deltas_no_update" BEFORE UPDATE ON "follow_deltas" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "interactions_no_update" BEFORE UPDATE ON "interactions" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();
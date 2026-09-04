CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"ig_account_id" text NOT NULL,
	"post_id" text NOT NULL,
	"source_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"caption" text,
	"shortcode" text,
	"like_count" integer,
	"comment_count" integer,
	"category" "observation_category" DEFAULT 'OBSERVED' NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_ig_account_id_ig_accounts_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_idempotency_idx" ON "posts" USING btree ("ig_account_id","post_id","source_id");--> statement-breakpoint
CREATE INDEX "posts_target_taken_idx" ON "posts" USING btree ("target_id","taken_at");--> statement-breakpoint
CREATE TABLE "post_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_db_id" text NOT NULL,
	"author_account_id" text NOT NULL,
	"comment_id" text NOT NULL,
	"body" text NOT NULL,
	"commented_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_db_id_posts_id_fk" FOREIGN KEY ("post_db_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_author_account_id_ig_accounts_id_fk" FOREIGN KEY ("author_account_id") REFERENCES "public"."ig_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_comments_idempotency_idx" ON "post_comments" USING btree ("post_db_id","comment_id");--> statement-breakpoint
CREATE INDEX "post_comments_author_idx" ON "post_comments" USING btree ("author_account_id");--> statement-breakpoint
CREATE TRIGGER "posts_no_update" BEFORE UPDATE ON "posts" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
CREATE TRIGGER "post_comments_no_update" BEFORE UPDATE ON "post_comments" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();--> statement-breakpoint
ALTER TABLE "profile_snapshots" ADD COLUMN "is_private" boolean;--> statement-breakpoint
DELETE FROM "follow_scan_staging" WHERE "job_id" NOT IN (SELECT "id" FROM "monitoring_jobs");--> statement-breakpoint
ALTER TABLE "follow_scan_staging" ADD CONSTRAINT "follow_scan_staging_job_id_monitoring_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."monitoring_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_checkpoints_job_idx" ON "job_checkpoints" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "targets_status_created_idx" ON "targets" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "evidence_observed_idx" ON "evidence" USING btree ("observed_at");

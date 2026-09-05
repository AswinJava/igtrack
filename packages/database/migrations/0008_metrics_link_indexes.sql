CREATE TABLE "capability_metrics" (
	"source_id" text NOT NULL,
	"capability" text NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_ok" integer DEFAULT 0 NOT NULL,
	"total_errors" integer DEFAULT 0 NOT NULL,
	"total_timeouts" integer DEFAULT 0 NOT NULL,
	"total_rate_limited" integer DEFAULT 0 NOT NULL,
	"last_latency_ms" integer,
	"last_observed_at" timestamp with time zone,
	CONSTRAINT "capability_metrics_source_id_capability_pk" PRIMARY KEY("source_id","capability")
);--> statement-breakpoint
ALTER TABLE "capability_metrics" ADD CONSTRAINT "capability_metrics_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "link_url" text;--> statement-breakpoint
CREATE INDEX "monitoring_jobs_running_locked_idx" ON "monitoring_jobs" USING btree ("status","locked_at") WHERE "monitoring_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "monitoring_jobs_target_created_idx" ON "monitoring_jobs" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_kind_observed_idx" ON "evidence" USING btree ("observation_kind","observed_at");--> statement-breakpoint
CREATE INDEX "follow_deltas_to_snapshot_idx" ON "follow_deltas" USING btree ("to_snapshot_id");--> statement-breakpoint
CREATE INDEX "follow_deltas_from_snapshot_idx" ON "follow_deltas" USING btree ("from_snapshot_id");--> statement-breakpoint
CREATE INDEX "profile_changes_to_snapshot_idx" ON "profile_changes" USING btree ("to_snapshot_id");--> statement-breakpoint
CREATE INDEX "profile_changes_from_snapshot_idx" ON "profile_changes" USING btree ("from_snapshot_id");--> statement-breakpoint
CREATE INDEX "targets_user_created_idx" ON "targets" USING btree ("user_id","created_at");

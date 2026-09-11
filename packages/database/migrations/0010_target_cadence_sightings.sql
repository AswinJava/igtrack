ALTER TABLE "targets" ADD COLUMN "scan_cadence_mult" numeric;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "scan_kinds" text[];--> statement-breakpoint
CREATE TABLE "story_sightings" (
	"id" text PRIMARY KEY NOT NULL,
	"story_db_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "story_sightings" ADD CONSTRAINT "story_sightings_story_db_id_stories_id_fk" FOREIGN KEY ("story_db_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_sightings" ADD CONSTRAINT "story_sightings_job_id_monitoring_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."monitoring_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "story_sightings_story_observed_idx" ON "story_sightings" USING btree ("story_db_id","observed_at");--> statement-breakpoint
CREATE INDEX "story_sightings_observed_idx" ON "story_sightings" USING btree ("observed_at");

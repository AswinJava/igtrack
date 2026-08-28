CREATE TABLE "follow_scan_staging" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"target_id" text NOT NULL,
	"username" text NOT NULL,
	"username_lower" text NOT NULL,
	"ig_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_scan_staging" ADD CONSTRAINT "follow_scan_staging_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_scan_staging_job_username_idx" ON "follow_scan_staging" USING btree ("job_id","username_lower");--> statement-breakpoint
CREATE INDEX "follow_scan_staging_target_idx" ON "follow_scan_staging" USING btree ("target_id");
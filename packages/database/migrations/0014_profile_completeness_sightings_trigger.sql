-- Invariant 4, profile side: profile snapshots now record completeness so a
-- PARTIAL observation can never be diffed in either direction (mirrors
-- follow_snapshots.completeness). Existing rows were only ever produced by
-- providers that return AVAILABLE or an error, so COMPLETE is the honest
-- backfill.
ALTER TABLE "profile_snapshots" ADD COLUMN "completeness" "snapshot_completeness" NOT NULL DEFAULT 'COMPLETE';--> statement-breakpoint
-- story_sightings joins the append-only evidence family (insert-only since
-- birth; this makes the guarantee structural like the other 12 tables).
CREATE TRIGGER "story_sightings_no_update" BEFORE UPDATE ON "story_sightings" FOR EACH ROW EXECUTE FUNCTION "igtrack_reject_update"();

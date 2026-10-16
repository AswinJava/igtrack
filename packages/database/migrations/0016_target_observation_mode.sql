-- FOUNDING §15 (D47): a target states HOW it is observed, because the two modes
-- are answered by different provider routes and may not borrow each other's
-- scan kinds. OWNED = the operator's own account through the owned-account
-- edges. DISCOVERY = another public professional account, named by the
-- operator, observed through the documented Business Discovery edge.
-- Existing targets are owned by definition, so the default backfills them.
CREATE TYPE "observation_mode" AS ENUM ('OWNED', 'DISCOVERY');--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "observation_mode" "observation_mode" DEFAULT 'OWNED' NOT NULL;

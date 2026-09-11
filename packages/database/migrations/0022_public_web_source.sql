-- Opt-in public-web provider. Logged-out Instagram pages rendered by a local
-- Chrome instance are REAL public-page observations, but they are not official
-- Graph API responses. A dedicated source kind keeps the two classes apart in
-- every evidence row, dossier and relationship query.
ALTER TYPE "source_kind" ADD VALUE IF NOT EXISTS 'PUBLIC_WEB';--> statement-breakpoint

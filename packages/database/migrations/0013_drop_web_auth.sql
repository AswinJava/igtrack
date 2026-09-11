-- The agent surface (CLI/MCP) is the only product surface.
-- Web session auth is deleted wholesale: no session rows, no credential
-- material. The users table stays as pure ownership scope (invariant 9).
DROP TABLE IF EXISTS "sessions";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";

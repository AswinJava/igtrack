-- Drift closure (2026-10-16, verification pass): migration 0010 created
-- targets.scan_cadence_mult as numeric while the declared Drizzle schema says
-- real (packages/database/src/schema/tables.ts). Every read path happened to
-- defend the mismatch (drizzle's real reader parses driver strings; the
-- scheduler's raw SQL wraps Number()), so stored behaviour is unchanged — but
-- the DDL now matches the declaration instead of relying on those defences.
-- Values are bounded 0.25–8 by the PATCH schema, so float4 is exact enough.
ALTER TABLE "targets" ALTER COLUMN "scan_cadence_mult" TYPE real USING "scan_cadence_mult"::real;

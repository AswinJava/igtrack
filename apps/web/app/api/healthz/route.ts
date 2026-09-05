import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/healthz — machine-readable liveness + DB reachability.
// No auth, no secrets, no payloads; the worker and deployment probes use this.
// Never expose credentials, provider payloads, or raw hashes.
export async function GET() {
  const startedAt = Date.now();
  let db: "ok" | "unavailable" = "unavailable";
  let migrations: "ok" | "unknown" = "unknown";
  try {
    const { getSql } = await import("@/lib/db");
    const sql = getSql();
    await sql`SELECT 1`;
    db = "ok";
    // Drizzle's postgres-js migrator tracks state in drizzle.__drizzle_migrations
    // (schema drizzle, table __drizzle_migrations). Query it explicitly: the
    // unqualified `drizzle_migrations` name does not exist and would report
    // "unknown" forever on a healthy database.
    try {
      await sql`SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 1`;
      migrations = "ok";
    } catch {
      migrations = "unknown";
    }
  } catch {
    // db stays "unavailable" — the degraded status below reflects it.
  }
  const latencyMs = Date.now() - startedAt;
  const provider = process.env.IGTRACK_PROVIDER ?? "fixture";
  const production = process.env.NODE_ENV === "production";
  const body = {
    status: db === "ok" ? "ok" : "degraded",
    version: process.env.npm_package_version ?? "0.1.0",
    provider,
    production,
    // Production must never silently run on synthetic data: render.yaml pins
    // fixture for the free-tier deploy, so this flag makes that choice
    // machine-visible alongside the diagnostics banner.
    fixtureInProduction: production && provider === "fixture",
    db,
    migrations,
    latencyMs,
    ts: new Date().toISOString(),
  };
  const status = db === "ok" ? 200 : 503;
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

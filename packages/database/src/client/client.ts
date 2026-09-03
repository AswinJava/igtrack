import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  url?: string;
  max?: number;
}

export function resolveDatabaseUrl(options: CreateDbOptions = {}): string {
  const url =
    options.url ??
    process.env.IGTRACK_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      "Database URL is not configured. Set IGTRACK_DATABASE_URL (or DATABASE_URL).",
    );
  }
  return url;
}

export function createDb(options: CreateDbOptions = {}): DatabaseHandle {
  const url = resolveDatabaseUrl(options);
  // Neon (and other managed PG) requires SSL via `sslmode=require` in the URL.
  // postgres.js does not auto-enable SSL from the URL alone in all versions —
  // set it explicitly when the URL signals it, preserving local non-SSL dev.
  const needsSSL = url.includes("sslmode=require") || url.includes("neon.tech");
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Operational hardening (Phase 10, P2 #6): bound every pool/wire wait so a
    // stalled Postgres cannot wedge the worker or web request forever. Values
    // are conservative for local dev; tighten via DATABASE_URL query params or
    // future IGTRACK_DB_* envs if a deployment needs different bounds.
    connect_timeout: 10,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    ...(needsSSL ? { ssl: "require" as const } : {}),
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 10 }),
  };
}

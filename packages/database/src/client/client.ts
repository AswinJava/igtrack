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
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 10 }),
  };
}

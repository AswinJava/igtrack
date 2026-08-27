import { createDb, type DatabaseHandle } from "@igtrack/database";

let handle: DatabaseHandle | null = null;

export function getDb(): DatabaseHandle {
  if (handle) return handle;
  const url =
    process.env.IGTRACK_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://igtrack:igtrack@localhost:5432/igtrack";
  handle = createDb({ url, max: 5 });
  return handle;
}

export function getDatabase() {
  return getDb().db;
}

export function getSql() {
  return getDb().sql;
}

import postgres from "postgres";
import {
  createDb,
  runMigrations,
  type DatabaseHandle,
} from "../src/index.js";

export const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

export async function probeDatabase(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function createFreshTestDb(): Promise<DatabaseHandle> {
  const handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
  await handle.sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.sql.unsafe(`DROP SCHEMA public CASCADE`);
  await handle.sql.unsafe(`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  return handle;
}

export async function createConnectedDb(): Promise<DatabaseHandle> {
  return createDb({ url: TEST_DATABASE_URL, max: 5 });
}

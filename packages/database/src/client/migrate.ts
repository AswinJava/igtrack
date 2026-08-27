import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client.js";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

export async function runMigrations(
  db: Database,
  migrationsFolder: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

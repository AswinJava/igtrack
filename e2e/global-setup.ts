import { createDb, runMigrations } from "../packages/database/src/index.js";
import { seed } from "../packages/database/src/seed/seed.js";
import { users } from "../packages/database/src/schema/index.js";
import { createTarget } from "../packages/database/src/repositories/targets.js";

// Runs once before the Playwright suite: provisions an isolated database,
// applies migrations fresh, and seeds the dev user + synthetic data the web
// server and tests rely on. Never touches the dev/test databases.
export const DATABASE_URL =
  process.env.IGTRACK_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_e2e";

export default async function globalSetup(): Promise<void> {
  const handle = createDb({ url: DATABASE_URL, max: 5 });
  try {
    await handle.sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await handle.sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
    await handle.sql.unsafe(`CREATE SCHEMA public`);
    await runMigrations(handle.db);
    await seed(handle.db);
    // Cross-user isolation fixture: a second tenant whose target must stay
    // invisible to the dev user in every E2E journey.
    const intruderRows = await handle.db
      .insert(users)
      .values({ email: "intruder@igtrack.local", displayName: "Isolation probe (synthetic)" })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    const intruderId =
      intruderRows[0]?.id ??
      (
        (await handle.sql`SELECT id FROM users WHERE email = 'intruder@igtrack.local' LIMIT 1`) as Array<{
          id: string;
        }>
      )[0]?.id;
    if (intruderId !== undefined) {
      await createTarget(handle.db, {
        userId: intruderId,
        username: "intruder_target",
        localName: "Not yours (synthetic)",
      });
    }
    console.log("[e2e] isolated database migrated and seeded");
  } finally {
    await handle.close();
  }
}
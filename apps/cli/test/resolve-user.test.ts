import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DatabaseHandle } from "@igtrack/database";
import { resolveUser } from "../src/context.js";
import { CliError } from "../src/output.js";

// ---------------------------------------------------------------------------
// Owner resolution is the entry point for every scoped read (invariant 9), and
// it has three outcomes that must stay distinguishable for an agent:
//   * NO_USER         — nothing to scope to (database never seeded, or the
//                       requested email matches nobody) — never a fallback;
//   * AMBIGUOUS_USER  — several owners and no selection: the CLI refuses to
//                       pick arbitrarily, because every read would then be
//                       scoped to a possibly wrong person;
//   * a match         — explicit flag beats IGTRACK_USER_EMAIL, which beats
//                       the single-user default; matching is case-insensitive.
//
// Requires a live test database; skips loudly when it is down.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

async function probe(url: string): Promise<boolean> {
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

const databaseUp = await probe(TEST_DATABASE_URL);

describe.skipIf(!databaseUp)("resolveUser precedence", () => {
  let handle: DatabaseHandle;
  const savedUserEmail = process.env.IGTRACK_USER_EMAIL;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    // Intentionally NOT seeded: the first test pins the empty-database refusal.
    delete process.env.IGTRACK_USER_EMAIL;
  });

  afterAll(async () => {
    if (savedUserEmail === undefined) delete process.env.IGTRACK_USER_EMAIL;
    else process.env.IGTRACK_USER_EMAIL = savedUserEmail;
    await handle?.close();
  });

  async function insertUser(email: string): Promise<void> {
    await handle.sql`INSERT INTO users (id, email) VALUES (${randomUUID()}, ${email})`;
  }

  it("refuses an empty database with NO_USER pointing at setup", async () => {
    try {
      await resolveUser(handle.db, undefined);
      expect.unreachable("resolveUser must refuse an empty database");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("NO_USER");
      expect((err as Error).message).toMatch(/igtrack setup/);
    }
  });

  it("defaults to the only user once exactly one exists", async () => {
    await insertUser("first@owner.test");
    const user = await resolveUser(handle.db, undefined);
    expect(user.email).toBe("first@owner.test");
  });

  it("with two users and no selection, refuses with AMBIGUOUS_USER listing both", async () => {
    await insertUser("second@owner.test");
    delete process.env.IGTRACK_USER_EMAIL;
    try {
      await resolveUser(handle.db, undefined);
      expect.unreachable("a multi-user database must not be picked arbitrarily");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("AMBIGUOUS_USER");
      expect((err as Error).message).toContain("first@owner.test");
      expect((err as Error).message).toContain("second@owner.test");
      expect((err as Error).message).toContain("--user");
    }
  });

  it("resolves IGTRACK_USER_EMAIL case-insensitively among many users", async () => {
    process.env.IGTRACK_USER_EMAIL = "FIRST@OWNER.TEST";
    try {
      const user = await resolveUser(handle.db, undefined);
      expect(user.email).toBe("first@owner.test");
    } finally {
      delete process.env.IGTRACK_USER_EMAIL;
    }
  });

  it("an explicit email beats the environment", async () => {
    process.env.IGTRACK_USER_EMAIL = "first@owner.test";
    try {
      const user = await resolveUser(handle.db, "Second@Owner.Test");
      expect(user.email).toBe("second@owner.test");
    } finally {
      delete process.env.IGTRACK_USER_EMAIL;
    }
  });

  it("an explicit email that matches nobody is NO_USER, never a fallback", async () => {
    try {
      await resolveUser(handle.db, "nobody@owner.test");
      expect.unreachable("an unmatched explicit email must not fall back");
    } catch (err) {
      expect((err as CliError).code).toBe("NO_USER");
      expect((err as Error).message).toMatch(/No user matches "nobody@owner.test"/);
    }
  });
});

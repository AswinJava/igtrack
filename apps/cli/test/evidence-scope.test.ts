import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  runMigrations,
  seed,
  type DatabaseHandle,
} from "@igtrack/database";
import { createContext, type CliContext } from "../src/context.js";
import { runEvidence } from "../src/commands/read.js";
import { UsageError } from "../src/output.js";
import { opEvidence, opTargetAdd, opWork } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The evidence ledger has two different questions it can answer:
//
//   "what does this deployment hold overall?"      — the owner's ledger
//   "what backs the record of THIS account?"       — one target's ledger
//
// Before the username argument existed, the second question was answered with
// the first: the positional was parsed, dropped, and a full ledger came back
// labelled as if it were the account's. An agent quoting those evidence ids
// for one account would have been quoting another account's rows.
//
// The seed observes `target_a`; the fixture provider observes `aurora.wilde`, so
// a run of the work loop gives the two accounts disjoint rows to separate on.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

async function probe(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
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

describe.skipIf(!databaseUp)("evidence ledger scoping", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;

    ctx = await createContext();
    await opTargetAdd(ctx, { username: "aurora.wilde" });
    await opWork(ctx, { skipScheduler: true });
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

  it("gives each account its own rows, not the owner's whole ledger", async () => {
    const aurora = await opEvidence(ctx, { target: "aurora.wilde", limit: 200 });
    const seeded = await opEvidence(ctx, { target: "target_a", limit: 200 });
    if (aurora.mode !== "list" || seeded.mode !== "list") {
      throw new Error("expected a ledger list, not a chain");
    }

    expect(aurora.target).toMatchObject({ username: "aurora.wilde" });
    expect(seeded.target).toMatchObject({ username: "target_a" });
    expect(aurora.rows.length).toBeGreaterThan(0);
    expect(seeded.rows.length).toBeGreaterThan(0);

    // Disjoint: a row about one account is never evidence about the other.
    const overlap = ids(aurora.rows).filter((id) => ids(seeded.rows).includes(id));
    expect(overlap).toEqual([]);

    const owner = await opEvidence(ctx, { limit: 500 });
    if (owner.mode !== "list") throw new Error("expected a ledger list");
    const ownerIds = new Set(ids(owner.rows));
    for (const id of [...ids(aurora.rows), ...ids(seeded.rows)]) {
      expect(ownerIds.has(id)).toBe(true);
    }
  });

  it("names the scope it used, so an owner-wide read is never mistaken for one account", async () => {
    const owner = await opEvidence(ctx, { limit: 5 });
    if (owner.mode !== "list") throw new Error("expected a ledger list");
    expect(owner.target).toBeNull();
  });

  it("says an empty scope is an empty ledger, not a refusal", async () => {
    await opTargetAdd(ctx, { username: "quiet.account" });
    const scoped = await opEvidence(ctx, { target: "quiet.account" });
    if (scoped.mode !== "list") throw new Error("expected a ledger list");
    expect(scoped.rows).toEqual([]);
    expect(scoped.target).not.toBeNull();
  });

  it("types an unknown account and an unusable reference instead of falling back to the full ledger", async () => {
    await expect(opEvidence(ctx, { target: "never.tracked" })).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });
    await expect(opEvidence(ctx, { target: "not a handle!!" })).rejects.toMatchObject({
      code: "TARGET_REFERENCE_INVALID",
    });
  });

  it("refuses a second positional rather than quietly ignoring it", async () => {
    await expect(
      runEvidence({ command: "evidence", positionals: ["aurora.wilde", "extra"], flags: {} }),
    ).rejects.toThrow(UsageError);
  });
});

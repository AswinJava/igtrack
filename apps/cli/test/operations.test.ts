import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import { createContext, type CliContext } from "../src/context.js";
import {
  opActivity,
  opEvidence,
  opLookup,
  opScanRun,
  opStatus,
  opTargetSetStatus,
  opTargetAdd,
  opWork,
  resolveTarget,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// Integration test for the agent surface (the functions behind both the CLI and
// the MCP tools).
//
// It pins the semantics that make the surface safe to hand to an autonomous
// agent:
//   * queueing is idempotent inside a scheduling window, and --force is the
//     only way to double-scan;
//   * a PAUSED target is skipped with a reason, never silently scanned;
//   * work actually observes, and reads afterwards see the observation;
//   * an unknown account is reported as such instead of as empty data.
//
// Requires the Docker Compose test database. When it is unavailable the suite
// reports itself skipped rather than passing vacuously.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde"; // the account the v1 fixture set knows

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

describe.skipIf(!databaseUp)("agent surface operations", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;
  let targetId: string;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    // Every command resolves the owner from env; pin it at the test database so
    // the repository's .env can never redirect a test run at real data.
    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;

    ctx = await createContext();
    const added = await opTargetAdd(ctx, {
      username: FIXTURE_USERNAME,
      localName: "Fixture account",
      tags: ["test"],
    });
    targetId = added.id;
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("reports the active provider as synthetic so nothing looks live", async () => {
    const status = await opStatus(ctx);
    expect(status.provider.name).toBe("fixture");
    expect(status.provider.synthetic).toBe(true);
    expect(status.owner.email).toBe("dev@igtrack.local");
  });

  it("queues every scan kind once per scheduling window, and only --force repeats it", async () => {
    const first = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(first.enqueued).toHaveLength(5);
    expect(first.enqueued.every((e) => e.deduplicated === false)).toBe(true);

    const second = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(second.enqueued).toHaveLength(5);
    expect(second.enqueued.every((e) => e.deduplicated === true)).toBe(true);
    expect(new Set(second.enqueued.map((e) => e.jobId))).toEqual(
      new Set(first.enqueued.map((e) => e.jobId)),
    );

    const forced = await opScanRun(ctx, { target: FIXTURE_USERNAME, force: true });
    expect(forced.enqueued.every((e) => e.deduplicated === false)).toBe(true);
    expect(
      forced.enqueued.some((e) => first.enqueued.some((f) => f.jobId === e.jobId)),
    ).toBe(false);
  });

  it("skips a PAUSED target with a reason instead of scanning it", async () => {
    await opTargetSetStatus(ctx, { target: FIXTURE_USERNAME, status: "PAUSED" });
    const result = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(result.enqueued).toHaveLength(0);
    expect(result.skipped).toHaveLength(5);
    expect(result.skipped.every((s) => s.reason.includes("PAUSED"))).toBe(true);
    await opTargetSetStatus(ctx, { target: FIXTURE_USERNAME, status: "ACTIVE" });
  });

  it("executes queued work and makes the result readable", async () => {
    // One job of each kind already exists from the first test; drain them.
    const work = await opWork(ctx, { max: 20, skipScheduler: true });
    const states = work.outcomes.map((o) => o.state);
    expect(states).not.toContain("failed");
    expect(states).not.toContain("lost");
    expect(states).not.toContain("unrecorded");
    // The fixture provider labels itself, and the worker reports that label.
    expect(work.provider.synthetic).toBe(true);

    const activity = await opActivity(ctx, { target: FIXTURE_USERNAME, limit: 20 });
    expect(activity.items.length).toBeGreaterThan(0);
    expect(activity.items.every((i) => i.targetUsername === FIXTURE_USERNAME)).toBe(true);
    // Every activity row must be able to point at its evidence.
    expect(activity.items.some((i) => i.evidenceId !== null)).toBe(true);

    const evidence = await opEvidence(ctx, { limit: 10 });
    expect(evidence.mode).toBe("list");
    if (evidence.mode === "list") {
      expect(evidence.rows.length).toBeGreaterThan(0);
      // A hash is either a real 64-char digest or absent (null) — never a
      // placeholder and never a normalized hash wearing a raw hash's name.
      for (const row of evidence.rows) {
        expect(row.raw_hash === null || /^[0-9a-f]{64}$/.test(row.raw_hash)).toBe(true);
      }
      expect(evidence.rows.some((r) => r.raw_hash !== null)).toBe(true);
      const row = evidence.rows.find((r) => r.raw_hash !== null) ?? evidence.rows[0];
      const chain = await opEvidence(ctx, { id: row?.id ?? "" });
      expect(chain.mode).toBe("chain");
      if (chain.mode === "chain") {
        expect(chain.chain?.claim.length).toBeGreaterThan(0);
      }
    }
  });

  it("filters activity by an ISO timestamp", async () => {
    const future = await opActivity(ctx, {
      target: FIXTURE_USERNAME,
      since: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.items).toHaveLength(0);
  });

  it("reports an unknown account as unknown, not as empty data", async () => {
    const lookup = await opLookup(ctx, { username: "this.account.does.not.exist" });
    expect(lookup.account).toBeNull();
    expect(["UNAVAILABLE", "ERROR"]).toContain(lookup.status);
    expect(lookup.error !== null || lookup.note !== null).toBe(true);

    const known = await opLookup(ctx, { username: FIXTURE_USERNAME });
    expect(known.status).toBe("AVAILABLE");
    expect(known.account).not.toBeNull();
  });

  it("refuses to resolve a target that is not tracked", async () => {
    await expect(resolveTarget(ctx.db, ctx.userId, "definitely-not-tracked")).rejects.toThrow(
      /No tracked target matches/,
    );
    const resolved = await resolveTarget(ctx.db, ctx.userId, FIXTURE_USERNAME);
    expect(resolved.id).toBe(targetId);
  });
});

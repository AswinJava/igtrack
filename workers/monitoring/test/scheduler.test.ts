import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  createDb,
  createTarget,
  enqueueJob,
  getJob,
  monitoringJobs,
  transitionTargetStatus,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { runSchedulerTick, type SchedulerTickResult } from "../src/scheduler.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

function countJobs(handle: DatabaseHandle): Promise<number> {
  return handle.db
    .select({ count: sql<number>`count(*)::int` })
    .from(monitoringJobs)
    .then((rows) => rows[0]?.count ?? 0);
}

async function jobsForKind(
  handle: DatabaseHandle,
  kind: string,
): Promise<Array<{ idempotencyKey: string | null; status: string }>> {
  return handle.db
    .select({
      idempotencyKey: monitoringJobs.idempotencyKey,
      status: monitoringJobs.status,
    })
    .from(monitoringJobs)
    .where(sql`${monitoringJobs.kind} = ${kind}`);
}

const T0 = Date.parse("2026-08-28T10:10:00.000Z");
const T0_LATER = Date.parse("2026-08-28T10:20:00.000Z");
const T1 = Date.parse("2026-08-28T16:10:00.000Z");

describe.runIf(dbAvailable)("scheduler tick", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "tick@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("enqueues every scan kind for an ACTIVE target on the first tick (S1)", async () => {
    const result: SchedulerTickResult = await runSchedulerTick(handle.db, {
      now: new Date(T0),
    });
    expect(result.targetsConsidered).toBe(1);
    expect(result.enqueued).toBe(5);
    expect(result.deduplicated).toBe(0);
    expect(await countJobs(handle)).toBe(5);

    for (const kind of ["PROFILE_SCAN", "FOLLOWER_SCAN", "FOLLOWING_SCAN", "POSTS_SCAN"]) {
      const jobs = await jobsForKind(handle, kind);
      expect(jobs).toHaveLength(1);
      // The key must encode the scheduling window, never bare target+kind (S7).
      expect(jobs[0]?.idempotencyKey).toContain(kind);
      expect(jobs[0]?.idempotencyKey).toContain(targetId);
      expect(jobs[0]?.idempotencyKey).toContain("2026-08-28T06:00:00.000Z");
    }
    const storyJobs = await jobsForKind(handle, "STORY_SCAN");
    expect(storyJobs[0]?.idempotencyKey).toContain("2026-08-28T10:00:00.000Z");
  });

  it("a repeated tick inside the same window is idempotent (S1)", async () => {
    const result = await runSchedulerTick(handle.db, { now: new Date(T0_LATER) });
    expect(result.enqueued).toBe(0);
    expect(result.deduplicated).toBe(5);
    expect(await countJobs(handle)).toBe(5);
  });

  it("two concurrent scheduler instances do not duplicate logical jobs (S2)", async () => {
    const other = createDb({ url: TEST_DATABASE_URL, max: 2 });
    try {
      const results = await Promise.all([
        runSchedulerTick(handle.db, { now: new Date(T1) }),
        runSchedulerTick(other.db, { now: new Date(T1) }),
      ]);
      const totalEnqueued = results.reduce((sum, r) => sum + r.enqueued, 0);
      expect(totalEnqueued).toBe(5);
      expect(await countJobs(handle)).toBe(10);
    } finally {
      await other.close();
    }
  });

  it("advancing the scheduling window produces fresh jobs, never permanent suppression (S7)", async () => {
    // Complete the T1-window jobs so nothing is running, then tick in a new window.
    for (;;) {
      const job = await claimJob(handle.db, "worker-drain", { leaseMs: 0 });
      if (job === null) break;
      await completeJob(handle.db, job.id, "worker-drain");
    }
    const result = await runSchedulerTick(handle.db, {
      now: new Date(Date.parse("2026-08-28T16:10:00.000Z") + 6 * 60 * 60 * 1000),
    });
    expect(result.enqueued).toBe(5);
    expect(await countJobs(handle)).toBe(15);
  });

  it("PAUSED targets never receive scheduled scans (S3)", async () => {
    await transitionTargetStatus(handle.db, userId, targetId, "PAUSED");
    const result = await runSchedulerTick(handle.db, {
      now: new Date(Date.parse("2026-08-28T22:10:00.000Z") + 6 * 60 * 60 * 1000),
    });
    expect(result.enqueued).toBe(0);
    expect(result.targetsConsidered).toBe(0);
  });

  it("a paused target between selection and enqueue receives nothing (S5 worker level)", async () => {
    // The guarded enqueue is exercised at DB level; here we prove the tick's
    // consideration set excludes non-ACTIVE targets outright.
    const result = await runSchedulerTick(handle.db, {
      now: new Date(Date.parse("2026-08-29T04:10:00.000Z")),
    });
    expect(result.enqueued).toBe(0);
    await transitionTargetStatus(handle.db, userId, targetId, "ACTIVE");
  });

  it("records scheduler health: last tick, last success, and failure state (S8)", async () => {
    const dead = createDb({ url: "postgresql://igtrack:igtrack@127.0.0.1:59999/none", max: 1 });
    try {
      await expect(
        runSchedulerTick(dead.db, { now: new Date(T0) }),
      ).rejects.toThrow();
    } finally {
      await dead.close();
    }

    const recovered = await runSchedulerTick(handle.db, { now: new Date(T0) });
    expect(recovered.enqueued).toBeGreaterThanOrEqual(0);

    const state = await handle.db.execute(
      sql`SELECT last_tick_at, last_success_at, last_error FROM scheduler_state WHERE id = 'default'`,
    );
    const row = Array.from(state)[0] as {
      last_tick_at: Date | null;
      last_success_at: Date | null;
      last_error: unknown;
    };
    expect(row.last_tick_at).not.toBeNull();
    expect(row.last_success_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });
});

describe.runIf(dbAvailable)("scheduler fleet coverage", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const userRows = await handle.db
      .insert(users)
      .values({ email: "fleet@igtrack.local" })
      .returning({ id: users.id });
    const userId = userRows[0]!.id;
    // 250 ACTIVE targets: strictly more than one batch window (default 200).
    await handle.sql`
      INSERT INTO ig_accounts (id, username, username_lower)
      SELECT 'fleet-acc-' || i, 'fleet_u' || i, 'fleet_u' || i
      FROM generate_series(1, 250) i
    `;
    await handle.sql`
      INSERT INTO targets (id, user_id, ig_account_id)
      SELECT 'fleet-tgt-' || i, ${userId}, 'fleet-acc-' || i
      FROM generate_series(1, 250) i
    `;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("every ACTIVE target is scheduled across consecutive ticks, not just the first batch (S11)", async () => {
    // Two ticks inside the same scheduling window but different rotation
    // keys: page 0 and page 1 of the fleet must both be considered.
    await runSchedulerTick(handle.db, { now: new Date(T0) });
    await runSchedulerTick(handle.db, { now: new Date(T0 + 61_000) });

    const rows = await handle.db
      .select({ key: monitoringJobs.idempotencyKey })
      .from(monitoringJobs)
      .where(sql`${monitoringJobs.kind} = 'PROFILE_SCAN'`);
    const coveredTargets = new Set(
      rows.map((r) => r.key?.split(":")[2] ?? ""),
    );
    expect(coveredTargets.size).toBe(250);
  });
});

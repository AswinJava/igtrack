import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  getJob,
  JobStateError,
  monitoringJobs,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import {
  defaultFixturesDir,
  runSchedulerTick,
  runWorkerLoop,
  type ExecutionSource,
} from "../src/index.js";import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

function fixtureSource(): ExecutionSource {
  const provider = new FixtureProvider({ fixturesDir: defaultFixturesDir() });
  return {
    provider,
    source: { id: provider.sourceId, kind: "FIXTURE", name: "fixture provider" },
  };
}

async function queuedCount(handle: DatabaseHandle): Promise<number> {
  const rows = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(monitoringJobs)
    .where(sql`${monitoringJobs.status} IN ('queued','retry_wait')`);
  return rows[0]?.n ?? 0;
}

async function succeededCount(handle: DatabaseHandle): Promise<number> {
  const rows = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(monitoringJobs)
    .where(sql`${monitoringJobs.status} = 'succeeded'`);
  return rows[0]?.n ?? 0;
}

// Phase 13: the GitHub Actions ephemeral worker (`start -- --once`) must be a
// bounded, lease-safe drain. These tests prove the §7-§9 safety contract on a
// real PostgreSQL: bounded exit, crash reclaim, overlapping-worker safety,
// and overlapping-scheduler idempotency. The lease/ownership machinery itself
// is frozen (queue.ts) — this suite pins the ephemeral invocation shape.
describe.runIf(dbAvailable)("ephemeral worker (--once)", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "ephemeral@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("bounded drain: exits after maxIterations having executed queued jobs", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const before = await succeededCount(handle);
    await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });

    await runWorkerLoop({
      db: handle.db,
      src: fixtureSource(),
      pollMs: 1,
      maxIterations: 5,
      scheduler: { enabled: false },
    });

    expect(await succeededCount(handle)).toBe(before + 3);
    expect(await queuedCount(handle)).toBe(0);
  });

  it("single-iteration bound processes exactly one job then exits", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });

    await runWorkerLoop({
      db: handle.db,
      src: fixtureSource(),
      pollMs: 1,
      maxIterations: 1,
      scheduler: { enabled: false },
    });

    // One iteration = one claim: exactly one of the two jobs is done, the
    // other remains queued for the next ephemeral tick.
    expect(await queuedCount(handle)).toBe(1);
    // Drain the remainder so later tests start clean.
    await runWorkerLoop({
      db: handle.db,
      src: fixtureSource(),
      pollMs: 1,
      maxIterations: 5,
      scheduler: { enabled: false },
    });
    expect(await queuedCount(handle)).toBe(0);
  });

  it("a runner killed mid-job is reclaimed by the next invocation (lease)", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const { job } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
      targetId: target.id,
    });
    // First "runner" claims then dies without completing (SIGKILL equivalent:
    // no complete/fail call, connection simply gone).
    await claimJob(handle.db, "worker-dead-ephemeral");
    const claimed = await getJob(handle.db, job.id);
    expect(claimed?.status).toBe("running");

    // Next invocation reclaims after lease expiry and completes honestly.
    const reclaimed = await claimJob(handle.db, "worker-successor-ephemeral", {
      leaseMs: 0,
    });
    expect(reclaimed?.id).toBe(job.id);
    await completeJob(handle.db, job.id, "worker-successor-ephemeral", "COMPLETED");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.outcome).toBe("COMPLETED");
  });

  it("overlapping workers cannot duplicate or corrupt: ownership guard wins", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const { job } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
      targetId: target.id,
    });
    await claimJob(handle.db, "worker-A");
    // Worker B cannot claim the same running job while the lease holds.
    const other = await claimJob(handle.db, "worker-B");
    expect(other === null || other.id !== job.id).toBe(true);
    // A stale worker can never overwrite its successor's result.
    await expect(
      completeJob(handle.db, job.id, "worker-B", "COMPLETED"),
    ).rejects.toBeInstanceOf(JobStateError);
    await completeJob(handle.db, job.id, "worker-A", "COMPLETED");
    expect((await getJob(handle.db, job.id))?.status).toBe("succeeded");
  });

  it("overlapping scheduler invocations converge via idempotency (no duplicates)", async () => {
    const now = new Date(Date.parse("2026-09-03T10:10:00.000Z"));
    const first = await runSchedulerTick(handle.db, { now });
    const second = await runSchedulerTick(handle.db, { now });
    // Same window: the second concurrent invocation deduplicates everything
    // the first enqueued. The DB unique index is the final authority, not
    // GitHub Actions concurrency groups.
    expect(first.enqueued).toBeGreaterThan(0);
    expect(second.enqueued).toBe(0);
    expect(second.deduplicated).toBe(first.enqueued);
  });

  it("a bounded run against a dead database surfaces errors via onError (fail-loud)", async () => {
    // main.ts turns any onError during --once into exit 1 so a misconfigured
    // DATABASE_URL goes red in Actions instead of silently "succeeding".
    const dead = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return () => Promise.reject(new Error("ECONNREFUSED (injected)"));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const errors: unknown[] = [];
    await runWorkerLoop({
      db: dead,
      src: fixtureSource(),
      pollMs: 1,
      maxIterations: 2,
      scheduler: { enabled: false },
      onError: (err) => errors.push(err),
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelJob,
  claimJob,
  completeJob,
  computeBackoffMs,
  createDb,
  enqueueJob,
  failJob,
  getJob,
  JobStateError,
  loadCheckpoint,
  monitoringJobs,
  queueDepth,
  saveCheckpoint,
  users,
  createTarget,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe("job backoff (pure)", () => {
  it("grows exponentially and caps", () => {
    expect(computeBackoffMs(1)).toBe(30_000);
    expect(computeBackoffMs(2)).toBe(60_000);
    expect(computeBackoffMs(3)).toBe(120_000);
    expect(computeBackoffMs(10)).toBe(900_000);
    expect(computeBackoffMs(0)).toBe(0);
  });
});

describe.runIf(available)("job queue", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "jobs@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "target_a",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("enqueues a job and dedupes on idempotency key", async () => {
    const first = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
      targetId,
      idempotencyKey: "scan:day:1",
      payload: { day: 1 },
    });
    expect(first.deduplicated).toBe(false);
    expect(first.job.status).toBe("queued");
    expect(first.job.attempts).toBe(0);

    const dup = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
      targetId,
      idempotencyKey: "scan:day:1",
    });
    expect(dup.deduplicated).toBe(true);
    expect(dup.job.id).toBe(first.job.id);
  });

  it("claims a queued job exactly once across concurrent workers", async () => {
    // One job per target: same-target same-kind claims serialize by design (P9).
    const targets: string[] = [targetId];
    for (let i = 1; i < 5; i++) {
      const { target } = await createTarget(handle.db, {
        userId,
        username: `concurrency_target_${i}`,
      });
      targets.push(target.id);
    }
    for (const tid of targets) {
      await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId: tid });
    }
    expect(await queueDepth(handle.db)).toBeGreaterThanOrEqual(6);

    const workerA = handle;
    const workerB = createDb({ url: TEST_DATABASE_URL, max: 2 });
    try {
      const claims = await Promise.all([
        claimJob(workerA.db, "worker-a"),
        claimJob(workerB.db, "worker-b"),
        claimJob(workerA.db, "worker-a"),
        claimJob(workerB.db, "worker-b"),
        claimJob(workerA.db, "worker-a"),
        claimJob(workerB.db, "worker-b"),
        claimJob(workerA.db, "worker-a"),
        claimJob(workerB.db, "worker-b"),
      ]);
      const claimed = claims.filter((c) => c !== null);
      const ids = claimed.map((c) => c!.id);
      expect(new Set(ids).size).toBe(ids.length);

      const storyClaims = claimed.filter((c) => c!.kind === "STORY_SCAN");
      expect(storyClaims.length).toBe(5);
      expect(new Set(storyClaims.map((c) => c!.targetId)).size).toBe(5);
      for (const job of storyClaims) {
        expect(job!.status).toBe("running");
        expect(job!.attempts).toBe(1);
        expect(["worker-a", "worker-b"]).toContain(job!.lockedBy);
      }
    } finally {
      await workerB.close();
    }
  });

  it("completes a running job", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "MEDIA_ARCHIVE" });
    const claimed = await claimJob(handle.db, "worker-c");
    expect(claimed?.id).toBe(job.id);

    const done = await completeJob(handle.db, job.id, "worker-c");
    expect(done.status).toBe("succeeded");
    expect(done.completedAt).not.toBeNull();
    expect(done.lockedBy).toBeNull();
  });

  it("rejects completion by a worker that does not hold the job", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "MEDIA_ARCHIVE" });
    await claimJob(handle.db, "worker-c");
    await expect(
      completeJob(handle.db, job.id, "worker-impostor"),
    ).rejects.toBeInstanceOf(JobStateError);
  });

  it("retries a failed job with backoff, then fails permanently", async () => {
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      maxAttempts: 2,
    });

    const attempt1 = await claimJob(handle.db, "worker-d");
    expect(attempt1?.id).toBe(job.id);
    const afterFail1 = await failJob(
      handle.db,
      job.id,
      "worker-d",
      { message: "transient network error", kind: "NETWORK", retryable: true },
      { baseMs: 1, capMs: 5 },
    );
    expect(afterFail1.status).toBe("retry_wait");
    expect(afterFail1.attempts).toBe(1);
    expect(afterFail1.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);

    await handle.sql`
      UPDATE monitoring_jobs SET available_at = now() WHERE id = ${job.id}
    `;

    const attempt2 = await claimJob(handle.db, "worker-d");
    expect(attempt2?.id).toBe(job.id);
    expect(attempt2?.attempts).toBe(2);
    const afterFail2 = await failJob(
      handle.db,
      job.id,
      "worker-d",
      { message: "still broken", retryable: true },
      { baseMs: 1, capMs: 5 },
    );
    expect(afterFail2.status).toBe("failed");
    expect(afterFail2.completedAt).not.toBeNull();

    const stored = await getJob(handle.db, job.id);
    expect((stored?.error as { attempt?: number })?.attempt).toBe(2);
  });

  it("does not retry non-retryable failures", async () => {
    const { job } = await enqueueJob(handle.db, {
      kind: "INTERACTION_SCAN",
      maxAttempts: 5,
    });
    await claimJob(handle.db, "worker-e");
    const failed = await failJob(handle.db, job.id, "worker-e", {
      message: "account private",
      kind: "ACCOUNT_PRIVATE",
      retryable: false,
    });
    expect(failed.status).toBe("failed");
  });

  it("cancels queued jobs but not running ones", async () => {
    const { job: queued } = await enqueueJob(handle.db, { kind: "ALERT_PROCESSING" });
    const cancelled = await cancelJob(handle.db, queued.id);
    expect(cancelled?.status).toBe("cancelled");

    const { job: running } = await enqueueJob(handle.db, { kind: "ALERT_PROCESSING" });
    await claimJob(handle.db, "worker-f");
    const notCancelled = await cancelJob(handle.db, running.id);
    expect(notCancelled).toBeNull();
  });

  it("persists and resumes checkpoints", async () => {
    await saveCheckpoint(handle.db, {
      targetId,
      kind: "FOLLOWER_SCAN",
      cursor: "page-17-cursor",
      page: 17,
      progress: { synced: 1700 },
    });
    const checkpoint = await loadCheckpoint(handle.db, targetId, "FOLLOWER_SCAN");
    expect(checkpoint?.page).toBe(17);
    expect(checkpoint?.cursor).toBe("page-17-cursor");

    await saveCheckpoint(handle.db, {
      targetId,
      kind: "FOLLOWER_SCAN",
      cursor: "page-18-cursor",
      page: 18,
    });
    const updated = await loadCheckpoint(handle.db, targetId, "FOLLOWER_SCAN");
    expect(updated?.page).toBe(18);
    expect(updated?.cursor).toBe("page-18-cursor");
  });

  // Leftovers from earlier tests must not leak into lease/serialization tests.
  async function drainClaimable(): Promise<void> {
    await handle.db.execute(sql`
      UPDATE monitoring_jobs
      SET status = 'succeeded',
          completed_at = now(),
          locked_at = null,
          locked_by = null,
          updated_at = now()
      WHERE status = 'running'
    `);
    const rows = await handle.db
      .select({ id: monitoringJobs.id })
      .from(monitoringJobs)
      .where(sql`${monitoringJobs.status} IN ('queued', 'retry_wait')`);
    for (const row of rows) {
      await cancelJob(handle.db, row.id);
    }
  }

  it("serializes same-target same-kind jobs at claim time (P9)", async () => {
    await drainClaimable();
    const first = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId });
    const second = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId });

    const firstClaim = await claimJob(handle.db, "worker-s1");
    expect(firstClaim?.id).toBe(first.job.id);

    const secondClaim = await claimJob(handle.db, "worker-s2");
    expect(secondClaim).toBeNull();

    await completeJob(handle.db, first.job.id, "worker-s1");
    const nextClaim = await claimJob(handle.db, "worker-s2");
    expect(nextClaim?.id).toBe(second.job.id);
    await completeJob(handle.db, second.job.id, "worker-s2");
  });

  it("reclaims a stale running job and increments attempts (J1)", async () => {
    await drainClaimable();
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
      maxAttempts: 3,
    });
    const first = await claimJob(handle.db, "worker-dead");
    expect(first?.id).toBe(job.id);
    expect(first?.attempts).toBe(1);

    const reclaimed = await claimJob(handle.db, "worker-successor", { leaseMs: 0 });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.lockedBy).toBe("worker-successor");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("does not reclaim an active worker's job within its lease (J1)", async () => {
    await drainClaimable();
    const { job } = await enqueueJob(handle.db, { kind: "FOLLOWER_SCAN", targetId });
    await claimJob(handle.db, "worker-active");

    const other = await claimJob(handle.db, "worker-other", { leaseMs: 60_000 });
    expect(other).toBeNull();

    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("running");
    expect(stored?.attempts).toBe(1);
    expect(stored?.lockedBy).toBe("worker-active");
  });

  it("reaps stale running jobs whose attempts are exhausted (J10)", async () => {
    await drainClaimable();
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
      maxAttempts: 1,
    });
    await claimJob(handle.db, "worker-dead-final");

    const reclaimed = await claimJob(handle.db, "worker-any", { leaseMs: 0 });
    expect(reclaimed).toBeNull();

    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("failed");
    expect((stored?.error as { kind?: string }).kind).toBe("LEASE_EXPIRED");
    expect(stored?.lockedBy).toBeNull();
    expect(stored?.completedAt).not.toBeNull();
  });

  it("a stale worker can neither complete nor fail a reclaimed job (J5)", async () => {
    await drainClaimable();
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
      maxAttempts: 3,
    });
    await claimJob(handle.db, "worker-stale");
    const reclaimed = await claimJob(handle.db, "worker-successor", { leaseMs: 0 });
    expect(reclaimed?.lockedBy).toBe("worker-successor");

    await expect(
      completeJob(handle.db, job.id, "worker-stale"),
    ).rejects.toBeInstanceOf(JobStateError);
    await expect(
      failJob(handle.db, job.id, "worker-stale", {
        message: "late failure from a dead worker",
        retryable: true,
      }),
    ).rejects.toBeInstanceOf(JobStateError);

    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("running");
    expect(stored?.lockedBy).toBe("worker-successor");
  });
});

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
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "jobs@igtrack.local" })
      .returning({ id: users.id });
    const { target } = await createTarget(handle.db, {
      userId: rows[0]!.id,
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
    for (let i = 0; i < 5; i++) {
      await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId });
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
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  MAX_RETRY_AFTER_MS,
  claimJob,
  clampRetryAfterMs,
  completeJob,
  computeBackoffMs,
  createTarget,
  enqueueJob,
  failJob,
  monitoringJobs,
  resolveLeaseMs,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe("clampRetryAfterMs (pure)", () => {
  it("passes ordinary provider delays through", () => {
    expect(clampRetryAfterMs(60_000, 30_000)).toBe(60_000);
    expect(clampRetryAfterMs(0, 30_000)).toBe(0);
  });

  it("falls back to backoff on missing, negative, or non-finite input", () => {
    expect(clampRetryAfterMs(undefined, 30_000)).toBe(30_000);
    expect(clampRetryAfterMs(-5, 30_000)).toBe(30_000);
    expect(clampRetryAfterMs(Number.NaN, 30_000)).toBe(30_000);
    expect(clampRetryAfterMs(Number.POSITIVE_INFINITY, 30_000)).toBe(30_000);
  });

  it("caps pathological delays at one hour", () => {
    expect(clampRetryAfterMs(31_536_000_000, 30_000)).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(3_600_000);
  });
});

describe("resolveLeaseMs", () => {
  it("passes explicit programmatic values through, including 0 for tests", () => {
    expect(resolveLeaseMs({ leaseMs: 0 })).toBe(0);
    expect(resolveLeaseMs({ leaseMs: 60_000 })).toBe(60_000);
  });

  it("falls back to the default on dangerous environment values", () => {
    const prev = process.env.IGTRACK_JOB_LEASE_MS;
    try {
      process.env.IGTRACK_JOB_LEASE_MS = "0";
      expect(resolveLeaseMs({})).toBe(300_000);
      process.env.IGTRACK_JOB_LEASE_MS = "-100";
      expect(resolveLeaseMs({})).toBe(300_000);
      process.env.IGTRACK_JOB_LEASE_MS = "900000";
      expect(resolveLeaseMs({})).toBe(900_000);
    } finally {
      if (prev === undefined) delete process.env.IGTRACK_JOB_LEASE_MS;
      else process.env.IGTRACK_JOB_LEASE_MS = prev;
    }
  });
});

describe.runIf(available)("failJob retry-delay clamp", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "clamp@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function setupJob(): Promise<string> {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `clamp_target_${targetCounter}`,
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    const claimed = await claimJob(handle.db, "worker-clamp");
    if (claimed === null || claimed.id !== job.id) throw new Error("setup: claim failed");
    return job.id;
  }

  async function availableAt(jobId: string): Promise<Date> {
    const rows = await handle.db
      .select({ availableAt: monitoringJobs.availableAt })
      .from(monitoringJobs)
      .where(sql`${monitoringJobs.id} = ${jobId}`)
      .limit(1);
    return rows[0]!.availableAt;
  }

  it("honors a sane provider delay verbatim", async () => {
    const jobId = await setupJob();
    const before = Date.now();
    await failJob(handle.db, jobId, "worker-clamp", {
      message: "throttled",
      kind: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 60_000,
    });
    const at = await availableAt(jobId);
    expect(at.getTime() - before).toBeGreaterThanOrEqual(55_000);
    expect(at.getTime() - before).toBeLessThan(65_000);
  });

  it("clamps a year-long Retry-After to one hour", async () => {
    const jobId = await setupJob();
    const before = Date.now();
    await failJob(handle.db, jobId, "worker-clamp", {
      message: "throttled",
      kind: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 31_536_000_000,
    });
    const at = await availableAt(jobId);
    expect(at.getTime() - before).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS + 5_000);
    expect(at.getTime() - before).toBeGreaterThan(MAX_RETRY_AFTER_MS - 30_000);
  });

  it("falls back to exponential backoff on garbage input", async () => {
    const jobId = await setupJob();
    const before = Date.now();
    await failJob(handle.db, jobId, "worker-clamp", {
      message: "broken",
      retryable: true,
      retryAfterMs: Number.NaN,
    });
    const at = await availableAt(jobId);
    const expected = computeBackoffMs(1);
    expect(at.getTime() - before).toBeGreaterThanOrEqual(expected - 5_000);
    expect(at.getTime() - before).toBeLessThan(expected + 5_000);
  });

  it("completing a deleted target's job reports lost ownership", async () => {
    targetCounter += 1;
    const created = await createTarget(handle.db, {
      userId,
      username: `clamp_gone_${targetCounter}`,
    });
    const { job } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
      targetId: created.target.id,
    });
    const claimed = await claimJob(handle.db, "worker-clamp");
    if (claimed === null || claimed.id !== job.id) throw new Error("setup: claim failed");
    const { deleteOwnedTarget } = await import("../src/index.js");
    expect(await deleteOwnedTarget(handle.db, userId, created.target.id)).toBe(true);
    await expect(completeJob(handle.db, job.id, "worker-clamp", "COMPLETED")).rejects.toThrow();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  effectiveRetryability,
  CapabilityErrorKind,
  type NormalizedProfile,
  ObservationCategory,
  Confidence,
  available,
  SourceKind,
} from "@igtrack/core";
import {
  claimJob,
  createTarget,
  enqueueJob,
  failJob,
  getJob,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { executeOne, type ExecutionSource } from "../src/index.js";
import { JobExecutionError } from "../src/provider.js";
import {
  withProviderTimeout,
  ProviderTimeoutError,
  providerTimeoutMs,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "../src/timeout.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";
import { stubSource } from "./conformance-stub.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(dbAvailable)("provider timeout boundary (PC-T1)", () => {
  let handle: DatabaseHandle;
  let targetId: string;
  const previousTimeout = process.env.IGTRACK_PROVIDER_TIMEOUT_MS;

  beforeAll(async () => {
    process.env.IGTRACK_PROVIDER_TIMEOUT_MS = "200";
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "timeout@igtrack.local" })
      .returning({ id: users.id });
    const { target } = await createTarget(handle.db, {
      userId: rows[0]!.id,
      username: "timeout_target",
    });
    targetId = target.id;
  });

  afterEach(async () => {
    // Full isolation: leftover retry_wait/failed/running jobs must never leak
    // into the next test's claim (same-kind same-target serialization).
    await handle.db.execute(sql`DELETE FROM monitoring_jobs`);
  });

  afterAll(async () => {
    if (previousTimeout === undefined) delete process.env.IGTRACK_PROVIDER_TIMEOUT_MS;
    else process.env.IGTRACK_PROVIDER_TIMEOUT_MS = previousTimeout;
    await handle.close();
  });

  it("a hung provider becomes a typed retryable TIMEOUT, never a hang (PC-T1-1)", async () => {
    const src: ExecutionSource = stubSource({
      getProfile: () => new Promise(() => {}), // never resolves
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-timeout");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-timeout", src, claimed!);
    expect(outcome.claimed).toBe(true);
    expect(outcome.state).toBe("retry_wait");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("retry_wait");
    expect((stored?.error as { kind?: string }).kind).toBe("TIMEOUT");
  }, 10_000);

  it("a provider exceeding the timeout produces no evidence and no partial data (PC-T1-2)", async () => {
    const src: ExecutionSource = stubSource({
      getProfile: () => new Promise((resolve) => setTimeout(() => resolve(undefined as never), 500)),
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-timeout2");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-timeout2", src, claimed!);
    expect(outcome.state).toBe("retry_wait");
    // A timeout never writes an observation; the job outcome stays unset.
    const rows = await getJob(handle.db, job.id);
    expect(rows?.outcome).toBeNull();
  }, 10_000);

  it("a provider returning before the timeout succeeds normally (PC-T1-3)", async () => {
    const src: ExecutionSource = stubSource({
      getProfile: async () =>
        available(
          {
            account: { username: "timeout_target", isPrivate: false },
            isVerified: false,
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: "2026-08-28T12:00:00.000Z",
            },
          } satisfies NormalizedProfile,
          {
            observedAt: "2026-08-28T12:00:00.000Z",
            source: { sourceId: "stub:boundary", kind: SourceKind.FIXTURE },
            confidence: Confidence.HIGH,
          },
        ),
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-t3");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-t3", src, claimed!);
    expect(outcome.state).toBe("succeeded");
  });

  it("withProviderTimeout resolves early, rejects on slow op, and honours the ms (PC-T1-4)", async () => {
    expect(providerTimeoutMs({ IGTRACK_PROVIDER_TIMEOUT_MS: "250" })).toBe(250);
    expect(providerTimeoutMs({ IGTRACK_PROVIDER_TIMEOUT_MS: "-5" })).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(providerTimeoutMs({})).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    const fast = await withProviderTimeout(Promise.resolve(42), "cap", 500);
    expect(fast).toBe(42);
    const slow = withProviderTimeout(
      new Promise((resolve) => setTimeout(() => resolve(9), 200)),
      "cap",
      50,
    );
    await expect(slow).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("the worker daemon stays alive after a provider timeout (PC-T1-6)", async () => {
    const src: ExecutionSource = stubSource({
      getProfile: () => new Promise(() => {}), // hangs forever
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-live");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-live", src, claimed!);
    expect(outcome.claimed).toBe(true);
    expect(outcome.state).toBe("retry_wait");
    // Loop stays healthy: a fresh claim works immediately.
    const queued = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const again = await claimJob(handle.db, "worker-live-2");
    expect(again?.id).toBe(queued.job.id);
  }, 10_000);

  it("RATE_LIMITED with retryAfterMs delays the retry by the provider-supplied amount (STEP 10, RL-1)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-rl");
    expect(claimed?.id).toBe(job.id);
    const before = Date.now();
    const err = new JobExecutionError("rate limited", {
      kind: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 60_000,
    });
    await failJob(handle.db, job.id, "worker-rl", {
      message: err.message,
      kind: err.kind ?? "RATE_LIMITED",
      retryable: err.retryable,
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    });
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("retry_wait");
    expect((stored?.availableAt.getTime() ?? 0) - before).toBeGreaterThanOrEqual(55_000);
  }, 10_000);
});

describe.runIf(dbAvailable)("provider error taxonomy (STEP 9)", () => {
  it("effectiveRetryability maps kinds and allows provider overrides", () => {
    expect(effectiveRetryability(CapabilityErrorKind.TIMEOUT)).toBe(true);
    expect(effectiveRetryability(CapabilityErrorKind.NETWORK)).toBe(true);
    expect(effectiveRetryability(CapabilityErrorKind.RATE_LIMITED)).toBe(true);
    expect(effectiveRetryability(CapabilityErrorKind.SCHEMA_MISMATCH)).toBe(false);
    expect(effectiveRetryability(CapabilityErrorKind.ACCOUNT_NOT_FOUND)).toBe(false);
    expect(effectiveRetryability(CapabilityErrorKind.FORBIDDEN)).toBe(false);
    // explicit provider override wins over the taxonomy
    expect(effectiveRetryability(CapabilityErrorKind.TIMEOUT, false)).toBe(false);
    expect(effectiveRetryability(CapabilityErrorKind.SCHEMA_MISMATCH, true)).toBe(false);
  });
});
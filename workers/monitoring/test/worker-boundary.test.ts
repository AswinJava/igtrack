import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  available,
  Confidence,
  ObservationCategory,
  SourceKind,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedProfile,
  type ProviderCapabilities,
} from "@igtrack/core";
import {
  claimJob,
  createTarget,
  enqueueJob,
  getJob,
  getSourceHealth,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { executeOne, pollOnce, runWorkerLoop, type ExecutionSource } from "../src/index.js";
import { JobExecutionError } from "../src/provider.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const PROFILE: NormalizedProfile = {
  account: { username: "target_a", isPrivate: false },
  isVerified: false,
  meta: {
    category: ObservationCategory.OBSERVED,
    confidence: Confidence.HIGH,
    observedAt: "2026-08-27T09:15:00.000Z",
  },
};

// Postgres-shaped error without depending on postgres.js constructor internals.
function postgresError(message: string): Error {
  const err = new Error(message);
  err.name = "PostgresError";
  return err;
}

// Infrastructure failure injection: every query rejects, like a dead Postgres.
function dbFailingOnExecute(real: Parameters<typeof runWorkerLoop>[0]["db"]) {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return () => Promise.reject(new Error("ECONNREFUSED (injected)"));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface StubConfig {
  capabilities?: Partial<ProviderCapabilities>;
  getProfile?: () => Promise<CapabilityResult<NormalizedProfile>>;
}

function stubSource(config: StubConfig = {}): ExecutionSource {
  const sourceRef = { sourceId: "stub:boundary", kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId: "stub:boundary",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      ...config.capabilities,
    }),
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile:
      config.getProfile ??
      (async () =>
        available(PROFILE, {
          observedAt: PROFILE.meta.observedAt,
          source: sourceRef,
          confidence: Confidence.HIGH,
        })),
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async () => {
      throw new Error("stub: getPublicPosts not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "boundary stub" },
  };
}

describe.runIf(dbAvailable)("worker failure boundary", () => {
  let handle: DatabaseHandle;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "boundary@igtrack.local" })
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

  // Claim-time serialization is per (kind, target): a job left running by one
  // test must never block the next test's claim. Close any leftover running
  // jobs after every test.
  afterEach(async () => {
    await handle.db.execute(sql`
      UPDATE monitoring_jobs
      SET status = 'succeeded', completed_at = now(),
          locked_at = null, locked_by = null, updated_at = now()
      WHERE status = 'running'
    `);
  });

  it("survives a dead database while polling and keeps iterating (J3)", async () => {
    const errors: unknown[] = [];
    await runWorkerLoop({
      db: dbFailingOnExecute(handle.db),
      src: stubSource(),
      pollMs: 1,
      maxIterations: 3,
      onError: (err) => errors.push(err),
    });
    expect(errors).toHaveLength(3);
  });

  it("fails unknown job kinds non-retryably without crashing the loop (J11)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "NOT_A_SCAN", targetId });
    const outcome = await pollOnce(handle.db, "worker-boundary-unknown", stubSource());
    expect(outcome.claimed).toBe(true);
    expect(outcome.state).toBe("failed");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("failed");
  });

  it("returns lost instead of throwing when completion loses ownership (J7)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    await claimJob(handle.db, "worker-owner");
    const outcome = await executeOne(handle.db, "worker-impostor", stubSource(), job);
    expect(outcome.state).toBe("lost");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("running");
    expect(stored?.lockedBy).toBe("worker-owner");
  });

  it("returns lost instead of throwing when failure recording loses ownership (J5)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    await claimJob(handle.db, "worker-owner");
    const outcome = await executeOne(
      handle.db,
      "worker-impostor",
      stubSource({
        getProfile: async () => {
          throw new JobExecutionError("provider exploded", { retryable: true, kind: "NETWORK" });
        },
      }),
      job,
    );
    expect(outcome.state).toBe("lost");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("running");
  });

  it("fails unexpected (programming) errors non-retryably as UNEXPECTED", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    await claimJob(handle.db, "worker-unexpected");
    const outcome = await executeOne(
      handle.db,
      "worker-unexpected",
      stubSource({
        getProfile: async () => {
          throw new Error("boom: programming error");
        },
      }),
      job,
    );
    expect(outcome.state).toBe("failed");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("failed");
    expect((stored?.error as { kind?: string }).kind).toBe("UNEXPECTED");
  });

  it("classifies infrastructure errors as retryable DATABASE failures (J4)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    await claimJob(handle.db, "worker-infra");
    const outcome = await executeOne(
      handle.db,
      "worker-infra",
      stubSource({
        getProfile: async () => {
          throw postgresError("connection reset (injected)");
        },
      }),
      job,
    );
    expect(outcome.state).toBe("retry_wait");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("retry_wait");
    expect((stored?.error as { kind?: string }).kind).toBe("DATABASE");
  });

  it("completes UNAVAILABLE capability scans honestly without fabricated data (C3)", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    await claimJob(handle.db, "worker-unavailable");
    const outcome = await executeOne(
      handle.db,
      "worker-unavailable",
      stubSource({ capabilities: { getProfile: false } }),
      job,
    );
    expect(outcome.state).toBe("succeeded");
    const health = await getSourceHealth(handle.db, "stub:boundary");
    const profileHealth = health.find((h) => h.capability === "getProfile");
    expect(profileHealth?.status).toBe("UNAVAILABLE");
    const stored = await getJob(handle.db, job.id);
    expect(stored?.status).toBe("succeeded");
  });
});

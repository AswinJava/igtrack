import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Confidence,
  ObservationCategory,
  SourceKind,
  available,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedFollowPage,
} from "@igtrack/core";
import {
  claimJob,
  createTarget,
  enqueueJob,
  followSnapshots,
  getTarget,
  listProfileSnapshots,
  setTargetStatus,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { sql } from "drizzle-orm";
import { runFollowerScan, runProfileScan, JobExecutionError } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";
const sourceRef = { sourceId: "stub:lease-loss", kind: SourceKind.FIXTURE };

function followerStub(usernames: string[]): ExecutionSource {
  const provider: InstagramProvider = {
    sourceId: "stub:lease-loss",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      getPostChildren: false,
    }),
    resolveAccount: async () => {
      throw new Error("not wired");
    },
    getProfile: async () => {
      throw new Error("not wired");
    },
    getStories: async () => {
      throw new Error("not wired");
    },
    getFollowers: async (
      _ref: NormalizedAccountRef,
      _cursor?: Cursor,
    ): Promise<CapabilityResult<NormalizedFollowPage>> =>
      available(
        {
          entries: usernames.map((username) => ({ username })),
          complete: true,
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: OBSERVED_AT,
          },
        },
        { observedAt: OBSERVED_AT, source: sourceRef, confidence: Confidence.HIGH },
      ),
    getFollowing: async () => {
      throw new Error("not wired");
    },
    getPublicPosts: async () => {
      throw new Error("not wired");
    },
    getPublicComments: async () => {
      throw new Error("not wired");
    },
    getPostChildren: async () => {
      throw new Error("not wired");
    },
  };
  return { provider, source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "stub" } };
}

function profileStub(): ExecutionSource {
  const base = followerStub([]);
  return {
    ...base,
    provider: {
      ...base.provider,
      getProfile: async (account: NormalizedAccountRef) =>
        available(
          {
            account,
            bio: "mid-run bio",
            followerCount: 9,
            followingCount: 9,
            postCount: 9,
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: OBSERVED_AT,
            },
          },
          { observedAt: OBSERVED_AT, source: sourceRef, confidence: Confidence.HIGH },
        ),
    },
  };
}

describe.runIf(dbAvailable)("lease loss and mid-run pause", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "lease-loss@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(): Promise<string> {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `lease_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string, kind: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind, targetId });
    const claimed = await claimJob(handle.db, "worker-lease-loss");
    if (claimed === null || claimed.id !== job.id) throw new Error("setup: claim failed");
    return claimed;
  }

  it("aborts the scan when the lease was reclaimed mid-run", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId, "FOLLOWER_SCAN");
    // Simulate a reclaim winner: the database lock now belongs to a rival,
    // while this worker's in-memory job record still claims the old owner.
    // The per-page heartbeat must detect the loss and abort, not race.
    await handle.db.execute(
      sql`UPDATE monitoring_jobs SET locked_by = 'worker-rival' WHERE id = ${job.id}`,
    );
    await expect(runFollowerScan(handle.db, job, followerStub(["a"]))).rejects.toMatchObject({
      name: "JobExecutionError",
      kind: "LEASE_LOST",
    });
    // Nothing was written for the losing worker: no snapshot, no deltas.
    const rows = await handle.db
      .select({ id: followSnapshots.id })
      .from(followSnapshots)
      .where(sql`${followSnapshots.targetId} = ${targetId}`);
    expect(rows).toHaveLength(0);
  });

  it("a scan claimed before a pause still completes its real observations", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId, "PROFILE_SCAN");
    // Pause lands after the claim: in-flight work finishes (its observations
    // are genuine), while the scheduler stops enqueueing anything new.
    await setTargetStatus(handle.db, targetId, "PAUSED");
    const result = await runProfileScan(handle.db, job, profileStub());
    expect(result).toBe("succeeded");
    const target = await getTarget(handle.db, targetId);
    const snaps = await listProfileSnapshots(handle.db, target!.igAccountId, {});
    expect(snaps.length).toBe(1);
  });

  it("JobExecutionError carries the lease-loss kind non-retryably", () => {
    const err = new JobExecutionError("Job lease lost during follow scan", {
      kind: "LEASE_LOST",
      retryable: false,
    });
    expect(err.retryable).toBe(false);
    expect(err.kind).toBe("LEASE_LOST");
  });
});

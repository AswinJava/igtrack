import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  available,
  Confidence,
  ObservationCategory,
  SourceKind,
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
  evidence as evidenceTable,
  followDeltas,
  followSnapshotMembers,
  followSnapshots,
  saveCheckpoint,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { runFollowerScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T10:00:00.000Z";

interface StubPage {
  usernames: string[];
  complete: boolean;
  nextCursor?: string;
}

// Deterministic paginated provider: pages are served in order; a cursor holds
// the index of the page that declared it.
function paginatedSource(pages: StubPage[]): ExecutionSource {
  const sourceRef = { sourceId: "stub:follow", kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId: "stub:follow",
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
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async (
      _account: NormalizedAccountRef,
      cursor?: Cursor,
    ): Promise<CapabilityResult<NormalizedFollowPage>> => {
      let index = 0;
      if (cursor !== undefined) {
        const owner = pages.findIndex((p) => p.nextCursor === cursor.value);
        if (owner < 0 || owner + 1 >= pages.length) {
          throw new Error(`stub: unknown cursor ${cursor.value}`);
        }
        index = owner + 1;
      }
      const page = pages[index]!;
      return available(
        {
          entries: page.usernames.map((username) => ({ username })),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          complete: page.complete,
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: page.complete ? Confidence.HIGH : Confidence.MEDIUM,
            observedAt: OBSERVED_AT,
          },
        },
        {
          observedAt: OBSERVED_AT,
          source: sourceRef,
          confidence: page.complete ? Confidence.HIGH : Confidence.MEDIUM,
        },
      );
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
    getPostChildren: async () => {
      throw new Error("stub: getPostChildren not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "follower stub" },
  };
}

describe.runIf(dbAvailable)("worker follower scan reliability", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "follower-scan@igtrack.local" })
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
      username: `scan_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
    });
    const claimed = await claimJob(handle.db, "worker-scan");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function followerSnapshotRows(targetId: string) {
    return handle.db
      .select({
        id: followSnapshots.id,
        completeness: followSnapshots.completeness,
        totalObserved: followSnapshots.totalObserved,
        evidenceId: followSnapshots.evidenceId,
      })
      .from(followSnapshots)
      .where(
        sql`${followSnapshots.targetId} = ${targetId}
          AND ${followSnapshots.direction} = 'FOLLOWERS'`,
      );
  }

  async function memberCount(targetId: string): Promise<number> {
    const rows = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followSnapshotMembers)
      .innerJoin(
        followSnapshots,
        sql`${followSnapshots.id} = ${followSnapshotMembers.snapshotId}`,
      )
      .where(
        sql`${followSnapshots.targetId} = ${targetId}
          AND ${followSnapshots.direction} = 'FOLLOWERS'`,
      );
    return rows[0]?.n ?? 0;
  }

  async function deltaCount(targetId: string): Promise<number> {
    const rows = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followDeltas)
      .where(sql`${followDeltas.targetId} = ${targetId}`);
    return rows[0]?.n ?? 0;
  }

  it("keeps every acquired page across a crash/resume and fabricates no losses (P2, P3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedSource([
      { usernames: ["alpha", "bravo", "charlie"], complete: false, nextCursor: "page-2" },
      { usernames: ["delta", "echo"], complete: true },
    ]);

    await expect(
      runFollowerScan(handle.db, job, src, { crashAfterPages: 1 }),
    ).rejects.toThrow(/Simulated interruption/);
    expect(await memberCount(targetId)).toBe(0);

    await runFollowerScan(handle.db, job, src);

    expect(await memberCount(targetId)).toBe(5);
    expect(await followerSnapshotRows(targetId)).toHaveLength(1);
    expect(await deltaCount(targetId)).toBe(0);
  });

  it("a different job never resumes another job's checkpoint (P8, B4)", async () => {
    const targetId = await makeTarget();
    const freshJob = await makeJob(targetId);
    const src = paginatedSource([
      { usernames: ["alpha", "bravo", "charlie"], complete: false, nextCursor: "page-2" },
      { usernames: ["delta", "echo"], complete: true },
    ]);

    // A stale checkpoint owned by a DIFFERENT logical job must be ignored: the
    // current scan starts fresh and produces its own complete snapshot.
    // (job_checkpoints.job_id is an FK, so the "other job" must be a real row —
    // it stays queued while this scan owns the target, which is exactly the
    // scenario the worker would face after a lease reclaim collision.)
    const { job: otherJob } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
    });
    await saveCheckpoint(handle.db, {
      targetId,
      kind: "FOLLOWER_SCAN",
      jobId: otherJob.id,
      cursor: "page-2",
      page: 1,
      progress: {
        cursor: "page-2",
        page: 1,
        entries: [
          { username: "alpha" },
          { username: "bravo" },
          { username: "charlie" },
        ],
      },
    });

    await runFollowerScan(handle.db, freshJob, src);

    expect(await memberCount(targetId)).toBe(5);
    expect(await followerSnapshotRows(targetId)).toHaveLength(1);
  });

  it("re-running the same logical scan is idempotent (P4, C1)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedSource([
      { usernames: ["alpha", "bravo"], complete: false, nextCursor: "page-2" },
      { usernames: ["charlie"], complete: true },
    ]);

    await runFollowerScan(handle.db, job, src);
    expect(await followerSnapshotRows(targetId)).toHaveLength(1);

    await runFollowerScan(handle.db, job, src);
    expect(await followerSnapshotRows(targetId)).toHaveLength(1);
    expect(await memberCount(targetId)).toBe(3);
  });

  it("persists PARTIAL when pagination ends without contractual completion (P6, C2)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedSource([
      { usernames: ["alpha"], complete: false, nextCursor: "page-2" },
      { usernames: ["bravo"], complete: false },
    ]);

    await runFollowerScan(handle.db, job, src);

    const rows = await followerSnapshotRows(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completeness).toBe("PARTIAL");

    const ev = await handle.db
      .select({ metadata: evidenceTable.metadata, rawHash: evidenceTable.rawHash })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${rows[0]?.evidenceId}`);
    expect((ev[0]?.metadata as { completion?: string })?.completion).toBe("PARTIAL");
    // The stub provider transports no raw payload: raw_hash stays honestly
    // unset instead of being faked from normalized data.
    expect(ev[0]?.rawHash).toBeNull();
  });

  it("persists COMPLETE when the provider completes the pagination contract", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedSource([
      { usernames: ["alpha"], complete: false, nextCursor: "page-2" },
      { usernames: ["bravo"], complete: true },
    ]);

    await runFollowerScan(handle.db, job, src);

    const rows = await followerSnapshotRows(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completeness).toBe("COMPLETE");
    expect(await memberCount(targetId)).toBe(2);
  });
});

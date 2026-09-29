import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  available,
  CapabilityErrorKind,
  Confidence,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedFollowPage,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  followDeltas,
  followSnapshotMembers,
  followSnapshots,
  getSourceHealth,
  igAccounts,
  evidence as evidenceTable,
  saveCheckpoint,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import { runFollowingScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import { fixtureSetForAccount } from "./fixture-set.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";

interface StubPage {
  usernames: string[];
  complete: boolean;
  nextCursor?: string;
  note?: string;
}

function paginatedFollowingSource(pages: StubPage[]): ExecutionSource {
  const sourceRef = { sourceId: "stub:following", kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId: "stub:following",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      getPostChildren: false,
      getTags: false,
      getMentionedComment: false,
      getAccountInsights: false,
      discoverAccount: false,
    }),
    getTags: async () => {
      throw new Error("stub: not wired");
    },
    getMentionedComment: async () => {
      throw new Error("stub: not wired");
    },
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async (
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
          ...(page.note !== undefined ? { note: page.note } : {}),
        },
      );
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
    discoverAccount: async () => {
      throw new Error("stub: discoverAccount not wired");
    },
    getAccountInsights: async () => {
      throw new Error("stub: getAccountInsights not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "following stub" },
  };
}

function sourceWithCapability(getFollowing: boolean): ExecutionSource {
  const base = paginatedFollowingSource([{ usernames: ["alpha"], complete: true }]);
  return {
    ...base,
    provider: {
      ...base.provider,
      capabilities: () => ({ ...base.provider.capabilities(), getFollowing }),
    },
  };
}

// Cursor-driven stub for cases a fixed page list cannot express: cursor cycles,
// a provider that echoes the cursor it was handed, and an unbounded stream of
// fresh cursors. `calls` counts provider invocations so a test can assert the
// loop is BOUNDED rather than merely that it eventually returned.
function scriptedFollowingSource(
  script: (calls: number, cursor: string | undefined) => StubPage,
  calls: { count: number },
): ExecutionSource {
  const base = paginatedFollowingSource([{ usernames: [], complete: true }]);
  return {
    ...base,
    provider: {
      ...base.provider,
      getFollowing: async (
        _account: NormalizedAccountRef,
        cursor?: Cursor,
      ): Promise<CapabilityResult<NormalizedFollowPage>> => {
        calls.count += 1;
        const page = script(calls.count, cursor?.value);
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
            source: { sourceId: "stub:following", kind: SourceKind.FIXTURE },
            confidence: page.complete ? Confidence.HIGH : Confidence.MEDIUM,
          },
        );
      },
    },
  };
}

describe.runIf(dbAvailable)("worker FOLLOWING_SCAN", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "following-scan@igtrack.local" })
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
      username: `following_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWING_SCAN",
      targetId,
    });
    const claimed = await claimJob(handle.db, "worker-following");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function followingSnapshotRows(targetId: string) {
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
          AND ${followSnapshots.direction} = 'FOLLOWING'`,
      );
  }

  async function memberUsernames(targetId: string): Promise<string[]> {
    const rows = await handle.db
      .select({ username: igAccounts.username })
      .from(followSnapshotMembers)
      .innerJoin(followSnapshots, sql`${followSnapshots.id} = ${followSnapshotMembers.snapshotId}`)
      .innerJoin(igAccounts, sql`${igAccounts.id} = ${followSnapshotMembers.igAccountId}`)
      .where(
        sql`${followSnapshots.targetId} = ${targetId}
          AND ${followSnapshots.direction} = 'FOLLOWING'`,
      );
    return rows.map((r) => r.username).sort();
  }

  async function deltaCount(targetId: string, change?: string): Promise<number> {
    const rows = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followDeltas)
      .where(
        change === undefined
          ? sql`${followDeltas.targetId} = ${targetId} AND ${followDeltas.direction} = 'FOLLOWING'`
          : sql`${followDeltas.targetId} = ${targetId} AND ${followDeltas.direction} = 'FOLLOWING' AND ${followDeltas.change} = ${change}`,
      );
    return rows[0]?.n ?? 0;
  }

  it("persists a COMPLETE following snapshot with members and evidence (F1)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha", "bravo"], complete: false, nextCursor: "page-2" },
      { usernames: ["delta"], complete: true },
    ]);

    await runFollowingScan(handle.db, job, src);

    const rows = await followingSnapshotRows(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completeness).toBe("COMPLETE");
    expect(await memberUsernames(targetId)).toEqual(["alpha", "bravo", "delta"]);
    expect(rows[0]?.evidenceId).not.toBeNull();
  });

  it("persists PARTIAL when pagination ends without contractual completion (F2)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha"], complete: false, nextCursor: "page-2" },
      { usernames: ["bravo"], complete: false },
    ]);

    await runFollowingScan(handle.db, job, src);

    const rows = await followingSnapshotRows(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completeness).toBe("PARTIAL");
    const ev = await handle.db
      .select({ metadata: evidenceTable.metadata, rawHash: evidenceTable.rawHash })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${rows[0]?.evidenceId}`);
    expect((ev[0]?.metadata as { completion?: string })?.completion).toBe("PARTIAL");
    expect(ev[0]?.rawHash).toBeNull();
  });

  it("stops on a repeated cursor and reports PARTIAL instead of looping", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha"], complete: false, nextCursor: "loop" },
      { usernames: ["bravo"], complete: false, nextCursor: "loop" },
    ]);

    const result = await runFollowingScan(handle.db, job, src);

    expect(result).toBe("succeeded-partial");
    const rows = await followingSnapshotRows(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completeness).toBe("PARTIAL");
    expect(await memberUsernames(targetId)).toEqual(["alpha", "bravo"]);
  });

  it("capability off → no rows, source health UNAVAILABLE (F3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);

    const result = await runFollowingScan(handle.db, job, sourceWithCapability(false));
    expect(result).toBe("unavailable");

    expect(await followingSnapshotRows(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:following");
    expect(health.find((h) => h.capability === "getFollowing")?.status).toBe("UNAVAILABLE");
  });

  it("provider UNAVAILABLE → no rows, no fabricated data (F3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const base = paginatedFollowingSource([{ usernames: ["alpha"], complete: true }]);
    const src: ExecutionSource = {
      ...base,
      provider: {
        ...base.provider,
        getFollowing: async () =>
          unavailable(
            {
              observedAt: OBSERVED_AT,
              source: { sourceId: "stub:unavail", kind: SourceKind.FIXTURE },
            },
            "Following list unavailable from this source.",
          ),
      },
    };

    const result = await runFollowingScan(handle.db, job, src);
    expect(result).toBe("unavailable");
    expect(await followingSnapshotRows(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:following");
    expect(health.find((h) => h.capability === "getFollowing")?.status).toBe("UNAVAILABLE");
  });

  it("malformed fixture → non-retryable SCHEMA_MISMATCH, no rows (F4)", async () => {
    // The malformed set is bound to its own account: a fixture set speaks
    // about exactly one account, and the worker's identity gate refuses a
    // scan of any other target rather than answering it with the set's bytes.
    targetCounter += 1;
    const account = `following_target_${targetCounter}`;
    const set = await fixtureSetForAccount(account, {
      mutate: async (dir: string) => {
        await writeFile(join(dir, "following", "page-1.json"), "{ not valid json !!!");
      },
    });
    const { target } = await createTarget(handle.db, { userId, username: account });
    const job = await makeJob(target.id);
    const before = await followingSnapshotRows(target.id);

    await expect(runFollowingScan(handle.db, job, set.source)).rejects.toMatchObject({
      name: "JobExecutionError",
      kind: CapabilityErrorKind.SCHEMA_MISMATCH,
      retryable: false,
    });
    expect(await followingSnapshotRows(target.id)).toHaveLength(before.length);
  });

  it("keeps every acquired page across crash/resume; fabricates no losses (F5, F6)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha", "bravo", "charlie"], complete: false, nextCursor: "page-2" },
      { usernames: ["delta", "echo"], complete: true },
    ]);

    await expect(
      runFollowingScan(handle.db, job, src, { crashAfterPages: 1 }),
    ).rejects.toThrow(/Simulated interruption/);
    expect(await memberUsernames(targetId)).toHaveLength(0);

    await runFollowingScan(handle.db, job, src);

    expect(await memberUsernames(targetId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    expect(await followingSnapshotRows(targetId)).toHaveLength(1);
    expect(await deltaCount(targetId)).toBe(0);
  });

  it("re-running the same logical scan is idempotent (F7, F8)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha"], complete: false, nextCursor: "page-2" },
      { usernames: ["bravo"], complete: true },
    ]);

    await runFollowingScan(handle.db, job, src);
    await runFollowingScan(handle.db, job, src);

    expect(await followingSnapshotRows(targetId)).toHaveLength(1);
    expect(await memberUsernames(targetId)).toEqual(["alpha", "bravo"]);
  });

  it("a different job never resumes another job's checkpoint (F9)", async () => {
    const targetId = await makeTarget();
    const freshJob = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["alpha", "bravo", "charlie"], complete: false, nextCursor: "page-2" },
      { usernames: ["delta", "echo"], complete: true },
    ]);

    const { job: otherJob } = await enqueueJob(handle.db, {
      kind: "FOLLOWING_SCAN",
      targetId,
    });
    await saveCheckpoint(handle.db, {
      targetId,
      kind: "FOLLOWING_SCAN",
      jobId: otherJob.id,
      cursor: "page-2",
      page: 1,
      progress: {
        cursor: "page-2",
        page: 1,
        entries: [{ username: "alpha" }, { username: "bravo" }, { username: "charlie" }],
      },
    });

    await runFollowingScan(handle.db, freshJob, src);

    expect(await memberUsernames(targetId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    expect(await followingSnapshotRows(targetId)).toHaveLength(1);
  });

  it("derives FOLLOWING deltas against the previous following snapshot only (F10)", async () => {
    const targetId = await makeTarget();

    const job1 = await makeJob(targetId);
    await runFollowingScan(
      handle.db,
      job1,
      paginatedFollowingSource([{ usernames: ["alpha", "bravo"], complete: true }]),
    );
    // Release the target so the second logical scan can be claimed.
    await completeJob(handle.db, job1.id, "worker-following");

    const job2 = await makeJob(targetId);
    await runFollowingScan(
      handle.db,
      job2,
      paginatedFollowingSource([{ usernames: ["bravo", "charlie"], complete: true }]),
    );

    expect(await followingSnapshotRows(targetId)).toHaveLength(2);
    expect(await deltaCount(targetId, "NEW_FOLLOWING")).toBe(1);
    expect(await deltaCount(targetId, "LOST_FOLLOWING")).toBe(1);
    expect(await deltaCount(targetId, "NEW_FOLLOWER")).toBe(0);
    expect(await deltaCount(targetId, "LOST_FOLLOWER")).toBe(0);
  });

  it("stops a cursor cycle (A → B → A) as PARTIAL in a bounded number of fetches", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const calls = { count: 0 };
    const src = scriptedFollowingSource((_n, cursor) => {
      if (cursor === undefined) return { usernames: ["cycle_a"], complete: false, nextCursor: "A" };
      if (cursor === "A") return { usernames: ["cycle_b"], complete: false, nextCursor: "B" };
      return { usernames: ["cycle_c"], complete: false, nextCursor: "A" };
    }, calls);

    const result = await runFollowingScan(handle.db, job, src);

    // Third fetch hands back "A", already consumed: no unseen page remains, so
    // the scan stops rather than cycling.
    expect(result).toBe("succeeded-partial");
    expect(calls.count).toBe(3);
    expect((await followingSnapshotRows(targetId))[0]?.completeness).toBe("PARTIAL");
    expect(await memberUsernames(targetId)).toEqual(["cycle_a", "cycle_b", "cycle_c"]);
  });

  it("a resumed scan stops after one fetch when the provider echoes its own cursor", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    await saveCheckpoint(handle.db, {
      targetId,
      kind: "FOLLOWING_SCAN",
      jobId: job.id,
      cursor: "page-2",
      page: 1,
      progress: { cursor: "page-2", page: 1 },
    });
    const calls = { count: 0 };
    const src = scriptedFollowingSource(
      (_n, cursor) => ({
        usernames: ["echoed"],
        complete: false,
        ...(cursor !== undefined ? { nextCursor: cursor } : { nextCursor: "page-2" }),
      }),
      calls,
    );

    const result = await runFollowingScan(handle.db, job, src);

    // The resumed cursor is already in the consumed set, so the first page
    // proves there was no progress and the scan must not fetch again.
    expect(result).toBe("succeeded-partial");
    expect(calls.count).toBe(1);
    expect((await followingSnapshotRows(targetId))[0]?.completeness).toBe("PARTIAL");
    expect(await memberUsernames(targetId)).toEqual(["echoed"]);
  });

  it("a fresh cursor on every page is stopped by the page cap, never looped", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const calls = { count: 0 };
    const src = scriptedFollowingSource(
      (n) => ({ usernames: [`bound_${n}`], complete: false, nextCursor: `cursor-${n}` }),
      calls,
    );

    process.env.IGTRACK_FOLLOW_MAX_PAGES = "4";
    let result: string;
    try {
      result = await runFollowingScan(handle.db, job, src);
    } finally {
      delete process.env.IGTRACK_FOLLOW_MAX_PAGES;
    }

    expect(result).toBe("succeeded-partial");
    expect(calls.count).toBe(4);

    const rows = await followingSnapshotRows(targetId);
    expect(rows[0]?.completeness).toBe("PARTIAL");
    const evidence = await handle.db
      .select({ metadata: evidenceTable.metadata })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${rows[0]?.evidenceId}`);
    // The evidence names the cap, so PARTIAL states why it stopped.
    expect(evidence[0]?.metadata).toMatchObject({ completion: "PARTIAL", pageCap: 4 });
    // Every page actually read is kept; the unread tail is never claimed.
    expect(await memberUsernames(targetId)).toEqual([
      "bound_1",
      "bound_2",
      "bound_3",
      "bound_4",
    ]);
  });

  it("duplicate members across advancing pages collapse into one member row", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = paginatedFollowingSource([
      { usernames: ["dupe", "one"], complete: false, nextCursor: "page-2" },
      { usernames: ["DUPE", "two"], complete: true },
    ]);

    const result = await runFollowingScan(handle.db, job, src);

    expect(result).toBe("succeeded");
    expect((await followingSnapshotRows(targetId))[0]?.completeness).toBe("COMPLETE");
    expect(await memberUsernames(targetId)).toEqual(["dupe", "one", "two"]);
  });

  it("carries the roster-freshness note onto the snapshot's evidence", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const freshness =
      "Complete roster read from the operator's own Instagram export. These roster files " +
      "record no generation timestamp, so the observation time is when igtrack read them, " +
      "not when Instagram captured the export.";
    const src = paginatedFollowingSource([
      { usernames: ["fresh_one", "fresh_two"], complete: true, note: freshness },
    ]);

    await runFollowingScan(handle.db, job, src);

    const rows = await followingSnapshotRows(targetId);
    expect(rows[0]?.completeness).toBe("COMPLETE");
    const ev = await handle.db
      .select({ metadata: evidenceTable.metadata })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${rows[0]?.evidenceId}`);
    // The stored roster timestamp carries no export date anywhere, so the note
    // that says so must survive into evidence rather than be dropped with the
    // capability result on the floor.
    expect((ev[0]?.metadata as { providerNote?: string })?.providerNote).toBe(freshness);
  });
});

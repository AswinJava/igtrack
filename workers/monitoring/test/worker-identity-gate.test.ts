// ---------------------------------------------------------------------------
// The worker's identity gate.
//
// A provider observes a bounded set of accounts. Before this gate, the worker
// went straight from a target row to a provider capability call, so a scan of
// a real account (@serpaix.ai) with a fixture-set provider wrote the
// FIXTURE's follower roster, insight points and media under that real
// account's row — and every NEW_FOLLOWER / LOST_FOLLOWER delta was derived
// from it.
//
// The gate refuses the job BEFORE anything is written, and its message is
// careful: "this source does not observe that account" is not "that account
// does not exist".
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  available,
  Confidence,
  ObservationCategory,
  SourceKind,
  type CapabilityResult,
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
  monitoringJobs,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { runFollowerScan } from "../src/provider.js";
import { runSchedulerTick } from "../src/scheduler.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);
const OBSERVED_AT = "2026-08-27T10:00:00.000Z";

/**
 * A provider that observes exactly one account and would happily serve a
 * synthetic roster for any other one. The gate must stop it.
 */
function sourceObservingOnly(subject: string): ExecutionSource {
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
      getTags: false,
      getMentionedComment: false,
      getAccountInsights: false,
      discoverAccount: false,
    }),
    observesAccount: async (username: string) => username === subject,
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async (): Promise<CapabilityResult<NormalizedFollowPage>> =>
      available(
        {
          entries: [{ username: "synthetic_member" }],
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
    getTags: async () => {
      throw new Error("stub: getTags not wired");
    },
    getMentionedComment: async () => {
      throw new Error("stub: getMentionedComment not wired");
    },
    getAccountInsights: async () => {
      throw new Error("stub: getAccountInsights not wired");
    },
    discoverAccount: async () => {
      throw new Error("stub: discoverAccount not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "follow stub" },
  };
}

describe.runIf(dbAvailable)("worker identity gate", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let counter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "identity-gate@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(username: string, mode: "OWNED" | "DISCOVERY"): Promise<string> {
    counter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `${username}.${counter}`,
      ...(mode === "DISCOVERY" ? { observationMode: "DISCOVERY" as const } : {}),
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind: "FOLLOWER_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-gate");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function writtenRows(targetId: string) {
    const snapshots = await handle.db
      .select({ id: followSnapshots.id })
      .from(followSnapshots)
      .where(sql`${followSnapshots.targetId} = ${targetId}`);
    const members = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followSnapshotMembers)
      .innerJoin(
        followSnapshots,
        sql`${followSnapshots.id} = ${followSnapshotMembers.snapshotId}`,
      )
      .where(sql`${followSnapshots.targetId} = ${targetId}`);
    const deltas = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followDeltas)
      .where(sql`${followDeltas.targetId} = ${targetId}`);
    const evidence = await handle.db.select({ n: sql<number>`count(*)::int` }).from(evidenceTable);
    return {
      snapshots: snapshots.length,
      members: members[0]?.n ?? 0,
      deltas: deltas[0]?.n ?? 0,
      evidence: evidence[0]?.n ?? 0,
    };
  }

  it("refuses the scan and writes NOTHING when the source does not observe the account", async () => {
    const targetId = await makeTarget("serpaix.ai", "OWNED");
    const job = await makeJob(targetId);
    const before = await writtenRows(targetId);

    await expect(
      runFollowerScan(handle.db, job, sourceObservingOnly("someone.else")),
    ).rejects.toThrow(/does not observe @/);

    // The refusal is permanent: retrying cannot change which accounts a
    // source observes.
    await expect(
      runFollowerScan(handle.db, job, sourceObservingOnly("someone.else")),
    ).rejects.toThrow(/NOT evidence that the account does not exist/);

    const after = await writtenRows(targetId);
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.members).toBe(before.members);
    expect(after.deltas).toBe(before.deltas);
    expect(after.evidence).toBe(before.evidence);
  });

  it("scans normally when the source does observe the account", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const job = await makeJob(target.id);
    const result = await runFollowerScan(handle.db, job, sourceObservingOnly("aurora.wilde"));
    expect(result).toBe("succeeded");
    const after = await writtenRows(target.id);
    expect(after.snapshots).toBe(1);
    expect(after.members).toBe(1);
  });

  it("never queues a scan the configured source cannot answer", async () => {
    // The scheduler is the automatic path, so it carries the same gate: a
    // target the source does not observe is skipped, not queued to fail.
    const { target: foreign } = await createTarget(handle.db, {
      userId,
      username: "unobservable.account",
    });
    const { target: observed } = await createTarget(handle.db, {
      userId,
      username: "observed.account",
    });

    const tick = await runSchedulerTick(handle.db, {
      provider: sourceObservingOnly("observed.account").provider,
    });
    // Every target this file created except the observed one is unobservable.
    expect(tick.skippedUnobservable).toBeGreaterThan(0);

    const queued = await handle.db
      .select({ targetId: monitoringJobs.targetId })
      .from(monitoringJobs);
    const targetIds = new Set(queued.map((r) => r.targetId));
    expect(targetIds.has(foreign.id)).toBe(false);
    expect(targetIds.has(observed.id)).toBe(true);
  });
});

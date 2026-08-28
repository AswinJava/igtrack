import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import {
  completeJob,
  createTarget,
  enqueueJob,
  getJob,
  monitoringJobs,
  stories as storiesTable,
  transitionTargetStatus,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import { claimJob } from "@igtrack/database";
import { defaultFixturesDir, executeOne, pollOnce, runSchedulerTick } from "../src/index.js";
import type { ExecutionSource } from "../src/index.js";
import {
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

async function outcomeOf(handle: DatabaseHandle, jobId: string): Promise<string | null> {
  const job = await getJob(handle.db, jobId);
  return job?.outcome ?? null;
}

// Removes leftover queued jobs (e.g. from scheduler ticks) so a fresh
// enqueue is the next claimable job.
async function drainQueued(handle: DatabaseHandle, workerId: string): Promise<void> {
  for (;;) {
    const j = await claimJob(handle.db, workerId, { leaseMs: 0 });
    if (j === null) break;
    await completeJob(handle.db, j.id, workerId);
  }
}


describe.runIf(dbAvailable)("scheduler + worker integration", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "integration@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("a scheduler-enqueued job is executed by the worker through pollOnce (S1 → worker)", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    await runSchedulerTick(handle.db, { now: new Date("2026-08-28T10:10:00.000Z") });

    // The fixture target only supports profile/follower/following/story scans
    // against its own fixture account; run any claimed job once.
    const outcome = await pollOnce(handle.db, "worker-it", fixtureSource());
    expect(outcome.claimed).toBe(true);
    expect(outcome.state).toBe("succeeded");
    expect(target).toBeDefined();
    void target;
  });

  it("records COMPLETED for a scan with real observations (O3)", async () => {
    await drainQueued(handle, "drain-1");
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const { job } = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId: target.id });
    const claimed = await claimJob(handle.db, "worker-o3");
    expect(claimed?.id).toBe(job.id);

    const outcome = await executeOne(handle.db, "worker-o3", fixtureSource(), claimed!);
    expect(outcome.state).toBe("succeeded");
    expect(await outcomeOf(handle, job.id)).toBe("COMPLETED");

    const storyCount = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(storiesTable);
    expect(storyCount[0]?.n).toBeGreaterThan(0);
  });

  it("records UNAVAILABLE when the provider is unavailable — success is never faked (O1)", async () => {
    await drainQueued(handle, "drain-2");
    const { target } = await createTarget(handle.db, {
      userId,
      username: "no.story.account",
    });
    const { job } = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId: target.id });
    const claimed = await claimJob(handle.db, "worker-unavail");

    const unavailableSource: ExecutionSource = {
      provider: {
        sourceId: "stub:unavail-story",
        capabilities: () => ({
          resolveAccount: true,
          getProfile: true,
          getStories: true,
          getFollowers: true,
          getFollowing: true,
          getPublicPosts: true,
          getPublicComments: true,
        }),
        resolveAccount: async () => {
          throw new Error("stub");
        },
        getProfile: async () => {
          throw new Error("stub");
        },
        getStories: async () => ({
          status: "UNAVAILABLE" as const,
          observedAt: new Date().toISOString(),
          source: { sourceId: "stub:unavail-story", kind: "FIXTURE" as const },
          confidence: "UNKNOWN" as const,
          note: "Stories unavailable from this source.",
        }),
        getFollowers: async () => {
          throw new Error("stub");
        },
        getFollowing: async () => {
          throw new Error("stub");
        },
        getPublicPosts: async () => {
          throw new Error("stub");
        },
        getPublicComments: async () => {
          throw new Error("stub");
        },
      },
      source: { id: "stub:unavail-story", kind: "FIXTURE", name: "unavailable stub" },
    };

    const outcome = await executeOne(handle.db, "worker-unavail", unavailableSource, claimed!);
    expect(outcome.state).toBe("succeeded");
    expect(await outcomeOf(handle, job.id)).toBe("UNAVAILABLE");
  });

  it("a target paused after enqueue is skipped by the worker, never scanned (S6)", async () => {
    await drainQueued(handle, "drain-3");
    const { target } = await createTarget(handle.db, {
      userId,
      username: "paused.person",
    });
    // Simulates the race: the scheduler enqueued while the target was ACTIVE,
    // then the user paused it before the worker claimed the job.
    const { job } = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId: target.id });
    await transitionTargetStatus(handle.db, userId, target.id, "PAUSED");

    const claimed = await claimJob(handle.db, "worker-paused");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-paused", fixtureSource(), claimed!);
    expect(outcome.state).toBe("succeeded");
    expect(await outcomeOf(handle, job.id)).toBe("SKIPPED_PAUSED");

    const storyCount = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(storiesTable)
      .where(sql`${storiesTable.igAccountId} = ${target.igAccountId}`);
    expect(storyCount[0]?.n).toBe(0);

    // Resume so later tests see an ACTIVE fleet.
    await transitionTargetStatus(handle.db, userId, target.id, "ACTIVE");
  });

  it("a reclaimed stale scheduler job completes under the new owner (S6 + lease)", async () => {
    await drainQueued(handle, "drain-4");
    const { target } = await createTarget(handle.db, {
      userId,
      username: "aurora.wilde",
    });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    await claimJob(handle.db, "worker-dead");
    const reclaimed = await claimJob(handle.db, "worker-successor", { leaseMs: 0 });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);

    const outcome = await executeOne(handle.db, "worker-successor", fixtureSource(), reclaimed!);
    expect(outcome.state).toBe("succeeded");
    expect(await outcomeOf(handle, job.id)).toBe("COMPLETED");
    void completeJob;
  });
});

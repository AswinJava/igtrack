import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedComment,
  type NormalizedPost,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  getSourceHealth,
  listCommentsForPostWithAccount,
  listPosts,
  posts as postsTable,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import { JobExecutionError, runPostScan } from "../src/provider.js";
import { executeOne } from "../src/index.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T14:00:00.000Z";

function fixtureSource(): ExecutionSource {
  const fixturesDir = join(process.cwd(), "packages", "ingestion", "fixtures", "v1");
  const provider = new FixtureProvider({ fixturesDir });
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "posts fixture" },
  };
}

function postStub(postId: string): NormalizedPost {
  return {
    postId,
    takenAt: OBSERVED_AT,
    caption: `caption ${postId}`,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: OBSERVED_AT,
    },
  };
}

function stubSource(config: {
  posts?: NormalizedPost[];
  postsStatus?: CapabilityStatus;
  comments?: NormalizedComment[];
  commentsStatus?: CapabilityStatus;
  postsCap?: boolean;
  commentsCap?: boolean;
} = {}): ExecutionSource {
  const sourceId = "stub:posts";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: config.postsCap ?? true,
      getPublicComments: config.commentsCap ?? true,
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
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async (): Promise<CapabilityResult<NormalizedPost[]>> => {
      if ((config.postsStatus ?? CapabilityStatus.AVAILABLE) === CapabilityStatus.UNAVAILABLE) {
        return unavailable({ observedAt: OBSERVED_AT, source: sourceRef }, "No posts here.");
      }
      if ((config.postsStatus ?? CapabilityStatus.AVAILABLE) === CapabilityStatus.ERROR) {
        const { errored, CapabilityErrorKind } = await import("@igtrack/core");
        return errored(
          { observedAt: OBSERVED_AT, source: sourceRef },
          { kind: CapabilityErrorKind.PROVIDER_ERROR, message: "stub boom", retryable: true },
        );
      }
      const { available } = await import("@igtrack/core");
      return available(config.posts ?? [], {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.HIGH,
      });
    },
    getPublicComments: async (): Promise<CapabilityResult<NormalizedComment[]>> => {
      if ((config.commentsStatus ?? CapabilityStatus.AVAILABLE) === CapabilityStatus.UNAVAILABLE) {
        return unavailable({ observedAt: OBSERVED_AT, source: sourceRef }, "No comments here.");
      }
      const { available } = await import("@igtrack/core");
      return available(config.comments ?? [], {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.HIGH,
      });
    },
  };
  return { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "stub" } };
}

describe.runIf(dbAvailable)("worker POSTS_SCAN", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "posts-scan@igtrack.local" })
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
      username: `post_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-posts");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  it("fixture provider → 2 posts, 3 comments on post-1, post-2 comment-less (P1)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const result = await runPostScan(handle.db, job, fixtureSource());
    expect(result).toBe("succeeded");

    const rows = await listPosts(handle.db, targetId);
    expect(rows.map((r) => r.postId).sort()).toEqual(["post-1", "post-2"]);
    for (const r of rows) {
      expect(r.evidenceId).not.toBeNull();
      expect(r.targetId).toBe(targetId);
    }
    const post1 = rows.find((r) => r.postId === "post-1")!;
    const post2 = rows.find((r) => r.postId === "post-2")!;
    expect(await listCommentsForPostWithAccount(handle.db, post1.id)).toHaveLength(3);
    // UNAVAILABLE comments are skipped, never empty-faked into a failure.
    expect(await listCommentsForPostWithAccount(handle.db, post2.id)).toHaveLength(0);
  });

  it("re-running the scan deduplicates posts and comments (P2)", async () => {
    const targetId = await makeTarget();
    const first = await makeJob(targetId);
    expect(await runPostScan(handle.db, first, fixtureSource())).toBe("succeeded");
    await completeJob(handle.db, first.id, "worker-posts");
    const { job: second } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-posts");
    expect(claimed?.id).toBe(second.id);
    expect(await runPostScan(handle.db, claimed!, fixtureSource())).toBe("succeeded");
    expect(await listPosts(handle.db, targetId)).toHaveLength(2);
  });

  it("UNAVAILABLE posts → unavailable with no rows (P3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const result = await runPostScan(
      handle.db,
      job,
      stubSource({ postsStatus: CapabilityStatus.UNAVAILABLE }),
    );
    expect(result).toBe("unavailable");
    expect(await listPosts(handle.db, targetId)).toHaveLength(0);
  });

  it("ERROR posts → retryable JobExecutionError (P4)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    await expect(
      runPostScan(handle.db, job, stubSource({ postsStatus: CapabilityStatus.ERROR })),
    ).rejects.toBeInstanceOf(JobExecutionError);
  });

  it("declared-unavailable capability → unavailable without provider calls (P5)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const result = await runPostScan(handle.db, job, stubSource({ postsCap: false }));
    expect(result).toBe("unavailable");
    const health = await getSourceHealth(handle.db, "stub:posts");
    expect(health.find((h) => h.capability === "getPublicPosts")?.status).toBe("UNAVAILABLE");
  });

  it("executeOne dispatches POSTS_SCAN through the worker boundary (P6)", async () => {
    const targetId = await makeTarget();
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-dispatch");
    expect(claimed?.id).toBe(job.id);
    const outcome = await executeOne(handle.db, "worker-dispatch", fixtureSource(), claimed!);
    expect(outcome.state).toBe("succeeded");
    expect(postsTable).toBeDefined();
    expect(await listPosts(handle.db, targetId)).toHaveLength(2);
  });

  it("empty post list → succeeded-empty, never a failure (P7)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const result = await runPostScan(handle.db, job, stubSource({ posts: [] }));
    expect(result).toBe("succeeded-empty");
  });

  it("a second scan for a target with no new posts writes no duplicates (P8)", async () => {
    const targetId = await makeTarget();
    const commented: NormalizedComment[] = [
      {
        commentId: "k-1",
        postId: "p-9",
        author: { username: "fan_a" },
        text: "nice",
        createdAt: OBSERVED_AT,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: OBSERVED_AT,
        },
      },
    ];
    const src = stubSource({ posts: [postStub("p-9")], comments: commented });
    const first = await makeJob(targetId);
    expect(await runPostScan(handle.db, first, src)).toBe("succeeded");
    await completeJob(handle.db, first.id, "worker-posts");
    const second = await makeJob(targetId);
    expect(await runPostScan(handle.db, second, src)).toBe("succeeded");
    const rows = await listPosts(handle.db, targetId);
    expect(rows).toHaveLength(1);
    expect(await listCommentsForPostWithAccount(handle.db, rows[0]!.id)).toHaveLength(1);
  });
});

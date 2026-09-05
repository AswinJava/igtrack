import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  Confidence,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedComment,
  type NormalizedPost,
  type NormalizedPostChild,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  followDeltas,
  listCommentsForPostWithAccount,
  listPosts,
  listProviderMetrics,
  loadCheckpoint,
  posts as postsTable,
  saveCheckpoint,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { runFollowerScan, runPostScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T14:00:00.000Z";

function post(postId: string): NormalizedPost {
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

function comment(commentId: string, postId: string): NormalizedComment {
  return {
    commentId,
    postId,
    author: { username: "fan" },
    text: `text ${commentId}`,
    createdAt: OBSERVED_AT,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: OBSERVED_AT,
    },
  };
}

interface PostsStubConfig {
  // post pages keyed by incoming cursor ("" = first call)
  postPages: Record<string, { posts: NormalizedPost[]; nextCursor?: string }>;
  // comment pages keyed by `${postId}|${cursor ?? ""}`
  commentPages?: Record<string, { comments: NormalizedComment[]; nextCursor?: string }>;
  commentsUnavailableFor?: string[];
  commentsCap?: boolean;
  childrenCap?: boolean;
  childrenByPost?: Record<string, { children?: NormalizedPostChild[]; unavailable?: boolean }>;
  seenPostCursors?: string[];
}

function postsStub(config: PostsStubConfig): ExecutionSource {
  const sourceId = "stub:posts-paging";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: config.commentsCap ?? true,
      getPostChildren: config.childrenCap ?? true,
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
    getPublicPosts: async (
      _ref,
      cursor?: Cursor,
    ): Promise<CapabilityResult<NormalizedPost[]>> => {
      const key = cursor?.value ?? "";
      config.seenPostCursors?.push(key);
      const page = config.postPages[key];
      if (page === undefined) throw new Error(`stub: unknown posts cursor "${key}"`);
      const { available, partial } = await import("@igtrack/core");
      const base = {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.HIGH,
      };
      if (page.nextCursor === undefined) return available(page.posts, base);
      return partial(page.posts, {
        ...base,
        confidence: Confidence.MEDIUM,
        note: "more pages",
        nextCursor: page.nextCursor,
      });
    },
    getPublicComments: async (
      p: NormalizedPost,
      cursor?: Cursor,
    ): Promise<CapabilityResult<NormalizedComment[]>> => {
      if ((config.commentsUnavailableFor ?? []).includes(p.postId)) {
        return unavailable({ observedAt: OBSERVED_AT, source: sourceRef }, "no source");
      }
      const key = `${p.postId}|${cursor?.value ?? ""}`;
      const page = config.commentPages?.[key] ?? { comments: [] as NormalizedComment[] };
      const { available, partial } = await import("@igtrack/core");
      const base = {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.MEDIUM,
      };
      if (page.nextCursor === undefined) return available(page.comments, base);
      return partial(page.comments, { ...base, note: "more", nextCursor: page.nextCursor });
    },
    getPostChildren: async (
      p: NormalizedPost,
    ): Promise<CapabilityResult<NormalizedPostChild[]>> => {
      const entry = config.childrenByPost?.[p.postId];
      if (entry?.unavailable === true) {
        return unavailable({ observedAt: OBSERVED_AT, source: sourceRef }, "no child source");
      }
      const { available } = await import("@igtrack/core");
      return available(entry?.children ?? [], {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.MEDIUM,
      });
    },
  };
  return { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "stub" } };
}

function followerStub(pages: { usernames: string[]; complete: boolean; nextCursor?: string }[]) {
  const sourceId = "stub:follow-gate";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId,
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
    getFollowers: async (_ref, cursor?: Cursor) => {
      let index = 0;
      if (cursor !== undefined) {
        const owner = pages.findIndex((p) => p.nextCursor === cursor.value);
        index = owner + 1;
      }
      const page = pages[index]!;
      const { available } = await import("@igtrack/core");
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
  return { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "stub" } };
}

describe.runIf(dbAvailable)("worker POSTS_SCAN pagination & comment states", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "posts-paging@igtrack.local" })
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
      username: `paging_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-posts-paging");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function commentStates(targetId: string): Promise<Record<string, string | null>> {
    const rows = await handle.db
      .select({ postId: postsTable.postId, commentsState: postsTable.commentsState })
      .from(postsTable)
      .where(sql`${postsTable.targetId} = ${targetId}`);
    return Object.fromEntries(rows.map((r) => [r.postId, r.commentsState]));
  }

  it("walks every post page and every comment page to a full listing", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const seen: string[] = [];
    const src = postsStub({
      postPages: {
        "": { posts: [post("p-1")], nextCursor: "p2" },
        p2: { posts: [post("p-2")] },
      },
      commentPages: {
        "p-1|": { comments: [comment("c-1", "p-1")], nextCursor: "cc2" },
        "p-1|cc2": { comments: [comment("c-2", "p-1")] },
        "p-2|": { comments: [] },
      },
      seenPostCursors: seen,
    });

    const result = await runPostScan(handle.db, job, src);
    expect(result).toBe("succeeded");
    expect(seen).toEqual(["", "p2"]);
    expect((await listPosts(handle.db, targetId)).map((p) => p.postId).sort()).toEqual([
      "p-1",
      "p-2",
    ]);
    const p1 = (await listPosts(handle.db, targetId)).find((p) => p.postId === "p-1")!;
    expect((await listCommentsForPostWithAccount(handle.db, p1.id)).map((c) => c.commentId).sort()).toEqual([
      "c-1",
      "c-2",
    ]);
    expect(await commentStates(targetId)).toEqual({ "p-1": "OBSERVED", "p-2": "OBSERVED" });
  });

  it("resumes a listing from an owned checkpoint cursor", async () => {
    const targetId = await makeTarget();
    const first = await makeJob(targetId);
    await saveCheckpoint(handle.db, {
      targetId,
      kind: "POSTS_SCAN",
      jobId: first.id,
      cursor: "p2",
      page: 1,
      progress: { cursor: "p2", page: 1 },
    });
    const seen: string[] = [];
    const src = postsStub({
      postPages: { p2: { posts: [post("p-9")] } },
      seenPostCursors: seen,
    });
    const result = await runPostScan(handle.db, first, src);
    expect(result).toBe("succeeded");
    expect(seen).toEqual(["p2"]);
    expect((await listPosts(handle.db, targetId)).map((p) => p.postId)).toEqual(["p-9"]);
  });

  it("stops on a duplicate cursor and reports partial instead of looping", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = postsStub({
      postPages: {
        "": { posts: [post("p-1")], nextCursor: "loop" },
        loop: { posts: [post("p-1")], nextCursor: "loop" },
      },
    });
    const result = await runPostScan(handle.db, job, src);
    expect(result).toBe("succeeded-partial");
    expect((await listPosts(handle.db, targetId))).toHaveLength(1);
  });

  it("records UNAVAILABLE vs NOT_SCANNED comment states honestly", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = postsStub({
      postPages: { "": { posts: [post("p-1"), post("p-2")] } },
      commentsUnavailableFor: ["p-2"],
    });
    await runPostScan(handle.db, job, src);
    expect(await commentStates(targetId)).toEqual({ "p-1": "OBSERVED", "p-2": "UNAVAILABLE" });

    const targetId2 = await makeTarget();
    const job2 = await makeJob(targetId2);
    const noComments = postsStub({
      postPages: { "": { posts: [post("p-3")] } },
      commentsCap: false,
    });
    await runPostScan(handle.db, job2, noComments);
    expect(await commentStates(targetId2)).toEqual({ "p-3": "NOT_SCANNED" });
  });

  it("clears the posts checkpoint when the scan completes", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = postsStub({ postPages: { "": { posts: [post("p-1")] } } });
    await runPostScan(handle.db, job, src);
    const checkpoint = await loadCheckpoint(handle.db, targetId, "POSTS_SCAN");
    expect(checkpoint?.page).toBe(0);
  });

  it("counts provider calls with latency in capability metrics", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = postsStub({ postPages: { "": { posts: [post("p-1")] } } });
    await runPostScan(handle.db, job, src);
    const metrics = await listProviderMetrics(handle.db);
    const postsMetric = metrics.find(
      (m) => m.sourceId === "stub:posts-paging" && m.capability === "getPublicPosts",
    );
    expect(postsMetric).toBeDefined();
    expect(postsMetric!.totalRequests).toBeGreaterThanOrEqual(1);
    expect(postsMetric!.totalOk).toBeGreaterThanOrEqual(1);
    expect(postsMetric!.totalErrors).toBe(0);
    expect(postsMetric!.lastLatencyMs).not.toBeNull();
    const commentsMetric = metrics.find(
      (m) => m.sourceId === "stub:posts-paging" && m.capability === "getPublicComments",
    );
    expect(commentsMetric?.totalRequests).toBeGreaterThanOrEqual(1);
  });
});

describe.runIf(dbAvailable)("worker follow diff completeness gate", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "diff-gate@igtrack.local" })
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
      username: `gate_target_${targetCounter}`,
    });
    return target.id;
  }

  async function scan(targetId: string, src: ExecutionSource) {
    const { job } = await enqueueJob(handle.db, { kind: "FOLLOWER_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-diff-gate");
    if (claimed === null) throw new Error("test setup: claim failed");
    const result = await runFollowerScan(handle.db, claimed, src);
    // Release the same-kind serialization lock between logical scans.
    await completeJob(handle.db, claimed.id, "worker-diff-gate", "COMPLETED");
    return result;
  }

  async function deltaCount(targetId: string): Promise<number> {
    const rows = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(followDeltas)
      .where(sql`${followDeltas.targetId} = ${targetId}`);
    return rows[0]?.n ?? 0;
  }

  it("diffs COMPLETE snapshots normally (control)", async () => {
    const targetId = await makeTarget();
    await scan(targetId, followerStub([{ usernames: ["a", "b"], complete: true }]));
    await scan(targetId, followerStub([{ usernames: ["b", "c"], complete: true }]));
    expect(await deltaCount(targetId)).toBe(2);
  });

  it("never diffs a PARTIAL snapshot (no fabricated LOST_*)", async () => {
    const targetId = await makeTarget();
    await scan(targetId, followerStub([{ usernames: ["a", "b"], complete: true }]));
    await scan(targetId, followerStub([{ usernames: ["b", "c"], complete: false }]));
    expect(await deltaCount(targetId)).toBe(0);
  });
});

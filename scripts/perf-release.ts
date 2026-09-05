// Release performance measurements — synthetic workloads only, never live
// providers. Real PostgreSQL, real worker executors, stub providers.
// Run: pnpm exec tsx scripts/perf-release.ts
// Uses an isolated `igtrack_perf` database on the local Postgres.

import {
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  available,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedFollowPage,
  type NormalizedPost,
} from "../packages/core/src/index.js";
import {
  claimJob,
  createDb,
  createTarget,
  enqueueJob,
  getOwnedTargetDetail,
  getUserActivityFeed,
  runMigrations,
  users,
} from "../packages/database/src/index.js";
import { runSchedulerTick } from "../workers/monitoring/src/scheduler.js";
import { runFollowerScan, runPostScan } from "../workers/monitoring/src/provider.js";

const SERVER_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";
const PERF_URL = SERVER_URL.replace(/\/[^/]*$/, "/igtrack_perf");

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";
const stubSource = { sourceId: "stub:perf", kind: SourceKind.FIXTURE };
let providerCalls = 0;

function notWired(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`stub: ${name} not wired`);
  };
}

function baseProvider(overrides: Partial<InstagramProvider>): InstagramProvider {
  return {
    sourceId: "stub:perf",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
    }),
    resolveAccount: notWired("resolveAccount"),
    getProfile: notWired("getProfile"),
    getStories: notWired("getStories"),
    getFollowers: notWired("getFollowers"),
    getFollowing: notWired("getFollowing"),
    getPublicPosts: notWired("getPublicPosts"),
    getPublicComments: notWired("getPublicComments"),
    ...overrides,
  };
}

function followStub(pages: { usernames: string[]; complete: boolean; nextCursor?: string }[]) {
  const provider = baseProvider({
    getFollowers: async (_ref: NormalizedAccountRef, cursor?: Cursor) => {
      providerCalls += 1;
      let index = 0;
      if (cursor !== undefined) {
        const owner = pages.findIndex((p) => p.nextCursor === cursor.value);
        index = owner + 1;
      }
      const page = pages[index]!;
      const result: CapabilityResult<NormalizedFollowPage> = available(
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
        { observedAt: OBSERVED_AT, source: stubSource, confidence: Confidence.HIGH },
      );
      return result;
    },
  });
  return { provider, source: { id: "stub:perf", kind: SourceKind.FIXTURE, name: "perf" } };
}

function postStub(postCount: number, commentsPerPost: number) {
  const provider = baseProvider({
    getPublicPosts: async (): Promise<CapabilityResult<NormalizedPost[]>> => {
      providerCalls += 1;
      const posts: NormalizedPost[] = Array.from({ length: postCount }, (_, i) => ({
        postId: `perf-post-${i}`,
        takenAt: OBSERVED_AT,
        caption: `caption ${i}`,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: OBSERVED_AT,
        },
      }));
      return available(posts, {
        observedAt: OBSERVED_AT,
        source: stubSource,
        confidence: Confidence.HIGH,
      });
    },
    getPublicComments: async (post: NormalizedPost): Promise<CapabilityResult<NormalizedComment[]>> => {
      providerCalls += 1;
      const comments: NormalizedComment[] = Array.from({ length: commentsPerPost }, (_, i) => ({
        commentId: `${post.postId}-c${i}`,
        postId: post.postId,
        author: { username: `fan${i % 25}` },
        text: `text ${i}`,
        createdAt: OBSERVED_AT,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: OBSERVED_AT,
        },
      }));
      return available(comments, {
        observedAt: OBSERVED_AT,
        source: stubSource,
        confidence: Confidence.HIGH,
      });
    },
  });
  return { provider, source: { id: "stub:perf", kind: SourceKind.FIXTURE, name: "perf" } };
}

async function main(): Promise<void> {
  const bootstrap = createDb({ url: SERVER_URL, max: 1 });
  await bootstrap.sql.unsafe(`CREATE DATABASE igtrack_perf`).catch(() => {});
  await bootstrap.close();

  const handle = createDb({ url: PERF_URL, max: 5 });
  await handle.sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.sql.unsafe(`DROP SCHEMA public CASCADE`);
  await handle.sql.unsafe(`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  const db = handle.db;

  const userRows = await db
    .insert(users)
    .values({ email: "perf@igtrack.local" })
    .returning({ id: users.id });
  const userId = userRows[0]!.id;
  const results: Record<string, unknown> = { scales: [] as unknown[] };

  for (const n of [1, 10, 50, 100]) {
    for (let i = 0; i < n; i += 1) {
      await createTarget(db, { userId, username: `perf_scale_${n}_${i}` });
    }
    const start = Date.now();
    const tick = await runSchedulerTick(db, {
      now: new Date("2026-08-27T10:00:00.000Z"),
      batchLimit: 200,
    });
    (results.scales as unknown[]).push({
      targets: n,
      schedulerTickMs: Date.now() - start,
      enqueued: tick.enqueued,
    });
  }

  // Large roster: 5,000 members across 5 pages on a fresh target.
  const { target: rosterTarget } = await createTarget(db, { userId, username: "perf_roster" });
  const rosterPages = Array.from({ length: 5 }, (_, p) => ({
    usernames: Array.from({ length: 1000 }, (_, i) => `member_${p}_${i}`),
    complete: p === 4,
    ...(p < 4 ? { nextCursor: `rp${p + 1}` } : {}),
  }));
  const { job: followJob } = await enqueueJob(db, { kind: "FOLLOWER_SCAN", targetId: rosterTarget.id });
  // The queue holds hundreds of scheduled jobs; claim until ours surfaces.
  let claimedFollow = null;
  for (let i = 0; i < 3000 && claimedFollow === null; i += 1) {
    const candidate = await claimJob(db, "perf-worker");
    if (candidate === null) break;
    if (candidate.id === followJob.id) claimedFollow = candidate;
  }
  if (claimedFollow === null) throw new Error("claim failed");
  providerCalls = 0;
  const memBefore = process.memoryUsage().heapUsed;
  const followStart = Date.now();
  await runFollowerScan(db, claimedFollow, followStub(rosterPages));
  (results as Record<string, unknown>).largeRoster = {
    members: 5000,
    pages: 5,
    providerCalls,
    scanMs: Date.now() - followStart,
    heapDeltaMb: Number(((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024).toFixed(1)),
  };

  // Large feed: 200 posts x 5 comments.
  const { target: feedTarget } = await createTarget(db, { userId, username: "perf_feed" });
  const { job: postJob } = await enqueueJob(db, { kind: "POSTS_SCAN", targetId: feedTarget.id });
  let claimedPost = null;
  for (let i = 0; i < 3000 && claimedPost === null; i += 1) {
    const candidate = await claimJob(db, "perf-worker");
    if (candidate === null) break;
    if (candidate.id === postJob.id) claimedPost = candidate;
  }
  if (claimedPost === null) throw new Error("claim failed");
  providerCalls = 0;
  const postStart = Date.now();
  await runPostScan(db, claimedPost, postStub(200, 5));
  (results as Record<string, unknown>).largeFeed = {
    posts: 200,
    commentsPerPost: 5,
    providerCalls,
    scanMs: Date.now() - postStart,
  };

  // Read path on the heavy target.
  const detailStart = Date.now();
  const bundle = await getOwnedTargetDetail(db, userId, feedTarget.id);
  (results as Record<string, unknown>).detailBundleMs = Date.now() - detailStart;
  (results as Record<string, unknown>).detailBundleNull = bundle === null;

  const feedStart = Date.now();
  await getUserActivityFeed(db, userId, 30, {});
  (results as Record<string, unknown>).activityFeedMs = Date.now() - feedStart;

  const sizes = await handle.sql`
    SELECT relname, pg_total_relation_size(oid) AS bytes
    FROM pg_class WHERE relname IN ('posts','post_comments','follow_snapshot_members','monitoring_jobs','evidence')
  `;
  (results as Record<string, unknown>).tableBytes = Array.from(sizes).map((r) => ({
    table: (r as { relname: string }).relname,
    bytes: Number((r as { bytes: string }).bytes),
  }));

  await handle.close();
  console.log(JSON.stringify(results, null, 2));
}

await main();

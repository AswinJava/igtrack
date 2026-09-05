import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  claimJob,
  createTarget,
  enqueueJob,
  followSnapshots,
  listStories,
  postComments,
  posts,
  recordFollowSnapshot,
  recordPost,
  recordProfileSnapshot,
  recordStory,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
  providerVersion: "v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

const T0 = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));

function evidenceFor(kind: string, label: string) {
  return {
    observationKind: kind,
    source: SOURCE,
    sourceReference: "test/concurrency",
    schemaVersion: "v1",
    observedAt: T0,
    capturedAt: T0,
    confidence: Confidence.HIGH,
    rawHash: hash(label),
    normalizedHash: hash(`${label}-norm`),
  };
}

describe.runIf(available)("concurrent writers stay idempotent", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "concurrency@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const created = await createTarget(handle.db, { userId, username: "concurrent_target" });
    targetId = created.target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("parallel duplicate profile snapshots collapse to one row", async () => {
    const input = () => ({
      profile: {
        account: { username: "concurrent_target", isPrivate: false },
        bio: "same bio",
        followerCount: 5,
        followingCount: 5,
        postCount: 1,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      evidence: evidenceFor("profile_snapshot", "race-profile"),
    });
    const results = await Promise.all([
      recordProfileSnapshot(handle.db, input()),
      recordProfileSnapshot(handle.db, input()),
    ]);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(1);
  });

  it("parallel duplicate posts collapse to one row", async () => {
    const input = () => ({
      targetId,
      owner: { username: "concurrent_target" },
      commentsState: "NOT_SCANNED" as const,
      post: {
        postId: "race-post",
        takenAt: T0.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      sourceId: SOURCE.id,
      evidence: evidenceFor("post", "race-post"),
    });
    const results = await Promise.all([
      recordPost(handle.db, input()),
      recordPost(handle.db, input()),
    ]);
    const rows = await handle.db
      .select({ id: posts.id })
      .from(posts)
      .where(sql`${posts.postId} = 'race-post'`);
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
  });

  it("parallel duplicate stories collapse to one row", async () => {
    const input = () => ({
      owner: { username: "concurrent_target" },
      sourceId: SOURCE.id,
      story: {
        storyId: "race-story",
        mediaType: "IMAGE" as const,
        takenAt: T0.toISOString(),
        hasLink: false,
        stickerKinds: [],
        mentions: [],
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      evidence: evidenceFor("story", "race-story"),
    });
    const results = await Promise.all([
      recordStory(handle.db, input()),
      recordStory(handle.db, input()),
    ]);
    expect((await listStories(handle.db, results[0]!.story.igAccountId, {})).filter(
      (s) => s.storyId === "race-story",
    )).toHaveLength(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
  });

  it("parallel duplicate follow snapshots collapse to one row", async () => {
    const input = () => ({
      targetId,
      direction: "FOLLOWERS" as const,
      source: SOURCE,
      takenAt: T0,
      page: {
        entries: [{ username: "race_member" }],
        complete: true,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
    });
    const results = await Promise.all([
      recordFollowSnapshot(handle.db, input()),
      recordFollowSnapshot(handle.db, input()),
    ]);
    const rows = await handle.db
      .select({ id: followSnapshots.id })
      .from(followSnapshots)
      .where(sql`${followSnapshots.targetId} = ${targetId}`);
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
  });

  it("two workers cannot hold the same job", async () => {
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId });
    const first = await claimJob(handle.db, "worker-a");
    expect(first?.id).toBe(job.id);
    // Same-kind same-target serialization plus claim exclusivity: nothing left.
    expect(await claimJob(handle.db, "worker-b")).toBeNull();
  });

  it("post comments survive the race with a single row", async () => {
    const recorded = await recordPost(handle.db, {
      targetId,
      owner: { username: "concurrent_target" },
      commentsState: "OBSERVED",
      post: {
        postId: "race-comments",
        takenAt: T0.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      sourceId: SOURCE.id,
      evidence: evidenceFor("post", "race-comments"),
    });
    const input = () => ({
      postDbId: recorded.post.id,
      comment: {
        commentId: "race-c1",
        postId: "race-comments",
        author: { username: "fan" },
        text: "hi",
        createdAt: T0.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      evidence: evidenceFor("post_comment", "race-c1"),
    });
    const { recordPostComment } = await import("../src/index.js");
    const results = await Promise.all([
      recordPostComment(handle.db, input()),
      recordPostComment(handle.db, input()),
    ]);
    const rows = await handle.db
      .select({ id: postComments.id })
      .from(postComments)
      .where(sql`${postComments.postDbId} = ${recorded.post.id}`);
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
  });

  it("dormant tables stay empty: no writer produces interactions or media", async () => {
    const { interactions, mediaAssets } = await import("../src/index.js");
    const irows = await handle.db.select({ id: interactions.id }).from(interactions);
    const mrows = await handle.db.select({ id: mediaAssets.id }).from(mediaAssets);
    expect(irows).toHaveLength(0);
    expect(mrows).toHaveLength(0);
  });
});

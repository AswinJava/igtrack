import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  getTargetActivityTrail,
  persistFollowDiff,
  recordPost,
  recordPostComment,
  recordProfileSnapshot,
  recordStory,
  recordTaggedMedia,
  recordFollowSnapshot,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

// The Activity Report's aggregates are pinned here: one UTC bucket across
// every observed surface, a top commenter per bucket, the complete-roster
// witness that makes a follow zero measured, and end-scoping that keeps a
// historical report from borrowing later observations.

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
  providerVersion: "v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

function evidence(label: string, at: Date, observationKind: string) {
  return {
    observationKind,
    source: SOURCE,
    sourceReference: `test/activity/${label}`,
    schemaVersion: "v1",
    observedAt: at,
    capturedAt: at,
    confidence: Confidence.HIGH,
    rawHash: hash(`raw-${label}`),
    normalizedHash: hash(`norm-${label}`),
  };
}

function meta(at: Date) {
  return {
    category: ObservationCategory.OBSERVED,
    confidence: Confidence.HIGH,
    observedAt: at.toISOString(),
  };
}

function followPage(usernames: string[], at: Date) {
  return {
    entries: usernames.map((username) => ({ username })),
    complete: true,
    meta: meta(at),
  };
}

describe.runIf(available)("activity report ledger reads", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let otherUserId: string;
  let targetId: string;
  const username = "target_activity";
  const aug1 = new Date(Date.UTC(2026, 7, 1, 9, 0, 0));
  const aug2 = new Date(Date.UTC(2026, 7, 2, 9, 0, 0));
  const aug5 = new Date(Date.UTC(2026, 7, 5, 9, 0, 0));
  const aug6 = new Date(Date.UTC(2026, 7, 6, 9, 0, 0));
  const aug7 = new Date(Date.UTC(2026, 7, 7, 9, 0, 0));
  const aug10 = new Date(Date.UTC(2026, 7, 10, 9, 0, 0));
  const aug15 = new Date(Date.UTC(2026, 7, 15, 9, 0, 0));
  const aug20 = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));
  const aug21 = new Date(Date.UTC(2026, 7, 21, 9, 0, 0));
  const aug22 = new Date(Date.UTC(2026, 7, 22, 9, 0, 0));

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const owners = await handle.db
      .insert(users)
      .values([{ email: "activity@igtrack.local" }, { email: "other@igtrack.local" }])
      .returning({ id: users.id });
    userId = owners[0]!.id;
    otherUserId = owners[1]!.id;
    const created = await createTarget(handle.db, {
      userId,
      username,
      localName: "Aurora",
    });
    targetId = created.target.id;

    // Two COMPLETE FOLLOWING rosters: the second adds one account.
    const first = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWING",
      source: SOURCE,
      takenAt: aug1,
      page: followPage(["alpha", "beta", "gamma"], aug1),
    });
    const second = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWING",
      source: SOURCE,
      takenAt: aug15,
      page: followPage(["alpha", "beta", "gamma", "delta"], aug15),
    });
    await persistFollowDiff(handle.db, {
      targetId,
      direction: "FOLLOWING",
      fromSnapshotId: first.snapshot.id,
      toSnapshotId: second.snapshot.id,
    });

    await recordProfileSnapshot(handle.db, {
      profile: {
        account: { username },
        followerCount: 10,
        followingCount: 4,
        postCount: 2,
        meta: meta(aug2),
      },
      evidence: evidence("profile", aug2, "profile_snapshot"),
    });

    const postOne = await recordPost(handle.db, {
      targetId,
      sourceId: SOURCE.id,
      owner: { username },
      commentsState: "OBSERVED",
      post: {
        postId: "post-1",
        takenAt: aug5.toISOString(),
        caption: "sunset #goldenhour",
        likeCount: 7,
        commentCount: 2,
        meta: meta(aug5),
      },
      evidence: evidence("post-1", aug5, "post"),
    });
    const postTwo = await recordPost(handle.db, {
      targetId,
      sourceId: SOURCE.id,
      owner: { username },
      commentsState: "OBSERVED",
      post: {
        postId: "post-2",
        takenAt: aug20.toISOString(),
        caption: "beach day #beach #sunset",
        likeCount: 3,
        commentCount: 1,
        meta: meta(aug20),
      },
      evidence: evidence("post-2", aug20, "post"),
    });

    await recordPostComment(handle.db, {
      postDbId: postOne.post.id,
      comment: {
        commentId: "comment-1",
        postId: "post-1",
        author: { username: "alice" },
        text: "beautiful",
        createdAt: aug6.toISOString(),
        meta: meta(aug6),
      },
      evidence: evidence("comment-1", aug6, "post_comment"),
    });
    await recordPostComment(handle.db, {
      postDbId: postOne.post.id,
      comment: {
        commentId: "comment-2",
        postId: "post-1",
        author: { username: "alice" },
        text: "again",
        createdAt: aug6.toISOString(),
        meta: meta(aug6),
      },
      evidence: evidence("comment-2", aug6, "post_comment"),
    });
    await recordPostComment(handle.db, {
      postDbId: postTwo.post.id,
      comment: {
        commentId: "comment-3",
        postId: "post-2",
        author: { username: "bob" },
        text: "great shot",
        createdAt: aug21.toISOString(),
        meta: meta(aug21),
      },
      evidence: evidence("comment-3", aug21, "post_comment"),
    });

    await recordStory(handle.db, {
      owner: { username },
      sourceId: SOURCE.id,
      story: {
        storyId: "story-1",
        mediaType: "IMAGE",
        takenAt: aug7.toISOString(),
        hasLink: false,
        stickerKinds: [],
        mentions: [],
        meta: meta(aug7),
      },
      evidence: evidence("story-1", aug7, "story"),
    });
    await recordStory(handle.db, {
      owner: { username },
      sourceId: SOURCE.id,
      story: {
        storyId: "story-2",
        mediaType: "VIDEO",
        takenAt: aug22.toISOString(),
        hasLink: false,
        stickerKinds: [],
        mentions: [],
        meta: meta(aug22),
      },
      evidence: evidence("story-2", aug22, "story"),
    });

    await recordTaggedMedia(handle.db, {
      owner: { username },
      sourceId: SOURCE.id,
      evidence: {
        ...evidence("tags", aug10, "tagged_media_listing"),
      },
      tags: [
        {
          mediaId: "media-tag-1",
          ownerUsername: "tagger",
          caption: "tagged #collab",
          meta: meta(aug10),
        },
      ],
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("buckets every observed surface into one UTC month with reportable totals", async () => {
    const trail = await getTargetActivityTrail(
      handle.db,
      userId,
      targetId,
      "month",
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 8, 1)),
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 8, 1)),
    );
    if (trail === null) throw new Error("expected an owned target trail");
    expect(trail.sinceDate).toBe(aug1.toISOString());
    expect(trail.completeRosterSnapshots).toBe(2);
    expect(trail.buckets).toHaveLength(1);
    const august = trail.buckets[0]!;
    expect(august.bucket).toBe("2026-08-01");
    expect(august.newFollowing).toBe(1);
    expect(august.lostFollowing).toBe(0);
    expect(august.posts).toBe(2);
    expect(august.stories).toBe(2);
    expect(august.comments).toBe(3);
    expect(august.tags).toBe(1);
    expect(august.profileSnapshots).toBe(1);
    expect(august.completeFollowingSnapshots).toBe(2);
    // Profile snapshots are stored but are not activity; the total stays
    // reportable (a follow delta, two posts, two stories, three comments, one tag).
    expect(august.total).toBe(9);

    expect(trail.details).not.toBeNull();
    const details = trail.details!;
    expect(details.topCommenterByBucket).toEqual([
      { bucket: "2026-08-01", username: "alice", count: 2 },
    ]);
    expect(details.monthCounts).toEqual({ newFollowing: 1, lostFollowing: 0, posts: 2 });
    expect(details.completeRosterBeforeMonth).toBe(0);
    expect(details.completeRosterInMonth).toBe(2);
    expect(details.topCommenters[0]).toEqual({ username: "alice", count: 2 });
    expect(details.captions).toEqual(["sunset #goldenhour", "beach day #beach #sunset"]);
    expect(details.captionRows).toBe(2);
    expect(details.recentComments.map((row) => row.id.length > 0)).toEqual([true, true, true]);
    expect(details.recentComments[0]?.username).toBe("bob");
    expect(details.followingRosterSize).toBe(4);
  });

  it("reads details as null when only bucket counts are requested", async () => {
    const trail = await getTargetActivityTrail(
      handle.db,
      userId,
      targetId,
      "month",
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 8, 1)),
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 8, 1)),
      { includeDetails: false },
    );
    expect(trail).not.toBeNull();
    expect(trail!.details).toBeNull();
    expect(trail!.buckets).toHaveLength(1);
  });

  it("end-scopes rosters, posts and comments so a past report is reproducible", async () => {
    const aug10Noon = new Date(Date.UTC(2026, 7, 10, 12));
    const trail = await getTargetActivityTrail(
      handle.db,
      userId,
      targetId,
      "month",
      new Date(Date.UTC(2026, 5, 1)),
      aug10Noon,
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 8, 1)),
    );
    if (trail === null) throw new Error("expected an owned target trail");
    const august = trail.buckets[0]!;
    expect(august.posts).toBe(1);
    expect(august.stories).toBe(1);
    expect(august.comments).toBe(2);
    expect(august.tags).toBe(1);
    expect(august.newFollowing).toBe(0);
    expect(august.completeFollowingSnapshots).toBe(1);
    expect(trail.completeRosterSnapshots).toBe(1);
    expect(trail.details?.followingRosterSize).toBe(3);
    expect(trail.details?.captionRows).toBe(1);
    expect(trail.details?.recentComments).toHaveLength(2);
  });

  it("returns null for another owner's target and for an unknown target", async () => {
    const end = new Date(Date.UTC(2026, 8, 1));
    const foreign = await getTargetActivityTrail(
      handle.db,
      otherUserId,
      targetId,
      "month",
      new Date(Date.UTC(2026, 5, 1)),
      end,
      new Date(Date.UTC(2026, 7, 1)),
      end,
    );
    expect(foreign).toBeNull();
    const unknown = await getTargetActivityTrail(
      handle.db,
      userId,
      "00000000-0000-4000-8000-000000000000",
      "month",
      new Date(Date.UTC(2026, 5, 1)),
      end,
      new Date(Date.UTC(2026, 7, 1)),
      end,
    );
    expect(unknown).toBeNull();
  });

  it("supports day and week units for the daily and weekly surfaces", async () => {
    const daily = await getTargetActivityTrail(
      handle.db,
      userId,
      targetId,
      "day",
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 8)),
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 8)),
      { includeDetails: false },
    );
    if (daily === null) throw new Error("expected an owned target trail");
    expect(daily.buckets.map((bucket) => bucket.bucket)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);
    expect(daily.buckets.find((bucket) => bucket.bucket === "2026-08-06")?.comments).toBe(2);

    const weekly = await getTargetActivityTrail(
      handle.db,
      userId,
      targetId,
      "week",
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 17)),
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 17)),
      { includeDetails: false },
    );
    if (weekly === null) throw new Error("expected an owned target trail");
    expect(weekly.buckets.map((bucket) => bucket.bucket)).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    expect(weekly.buckets.find((bucket) => bucket.bucket === "2026-08-03")?.posts).toBe(1);
    expect(weekly.buckets.find((bucket) => bucket.bucket === "2026-08-10")?.newFollowing).toBe(1);
  });
});

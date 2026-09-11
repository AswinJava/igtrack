import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  deleteOwnedTarget,
  enqueueJob,
  getEvidenceChain,
  getUserActivityFeed,
  listCommentsForPostWithAccount,
  listMembersForSnapshot,
  listPosts,
  listProfileSnapshots,
  listScopedEvidence,
  listStories,
  listTargetsForUser,
  recordFollowSnapshot,
  recordPost,
  recordPostComment,
  recordProfileSnapshot,
  recordStory,
  renewJobLease,
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

function profileInput(username: string, bio: string, at: Date) {
  return {
    profile: {
      account: { username, isPrivate: false },
      bio,
      followerCount: 10,
      followingCount: 5,
      postCount: 2,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "profile_snapshot",
      source: SOURCE,
      sourceReference: "test/depth",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`profile-${username}-${at.getTime()}`),
      normalizedHash: hash(`profile-norm-${username}-${at.getTime()}`),
    },
  };
}

function postInput(username: string, postId: string, at: Date) {
  return {
    owner: { username },
    commentsState: "OBSERVED" as const,
    post: {
      postId,
      shortcode: "AxYz001",
      permalink: "https://www.instagram.com/p/AxYz001/",
      takenAt: at.toISOString(),
      caption: `caption ${postId}`,
      likeCount: 42,
      commentCount: 3,
      mediaType: "VIDEO" as const,
      mediaProductType: "REELS",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "post",
      source: SOURCE,
      sourceReference: "test/depth-posts",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`post-${postId}`),
      normalizedHash: hash(`post-norm-${postId}`),
    },
  };
}

function commentInput(postId: string, commentId: string, at: Date, inReplyTo?: string) {
  return {
    comment: {
      commentId,
      postId,
      author: { username: "commenter_a" },
      text: `text ${commentId}`,
      createdAt: at.toISOString(),
      ...(inReplyTo !== undefined ? { inReplyToCommentId: inReplyTo } : {}),
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "post_comment",
      source: SOURCE,
      sourceReference: "test/depth-comments",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`comment-${commentId}`),
      normalizedHash: hash(`comment-norm-${commentId}`),
    },
  };
}

function storyInput(username: string, storyId: string, at: Date) {
  return {
    owner: { username },
    sourceId: SOURCE.id,
    story: {
      storyId,
      mediaType: "IMAGE" as const,
      takenAt: at.toISOString(),
      hasLink: false,
      stickerKinds: [],
      mentions: [],
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "story",
      source: SOURCE,
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`story-${storyId}`),
    },
  };
}

describe.runIf(available)("capability depth: media, comments, evidence, rosters", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "depth@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("persists provider-declared media typing and comment state on posts", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_media" });
    const recorded = await recordPost(handle.db, {
      targetId: target.id,
      sourceId: SOURCE.id,
      ...postInput("depth_media", "post-r1", T0),
    });
    expect(recorded.deduplicated).toBe(false);
    const rows = await listPosts(handle.db, target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaType).toBe("VIDEO");
    expect(rows[0]?.mediaProductType).toBe("REELS");
    expect(rows[0]?.shortcode).toBe("AxYz001");
    expect(rows[0]?.permalink).toBe("https://www.instagram.com/p/AxYz001/");
    expect(rows[0]?.commentsState).toBe("OBSERVED");
  });

  it("persists reply threading and resolves the parent author in one query", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_thread" });
    const recorded = await recordPost(handle.db, {
      targetId: target.id,
      sourceId: SOURCE.id,
      ...postInput("depth_thread", "post-t1", T0),
    });
    await recordPostComment(handle.db, {
      postDbId: recorded.post.id,
      ...commentInput("post-t1", "c-parent", T0),
    });
    await recordPostComment(handle.db, {
      postDbId: recorded.post.id,
      ...commentInput("post-t1", "c-child", T0, "c-parent"),
    });
    const comments = await listCommentsForPostWithAccount(handle.db, recorded.post.id);
    expect(comments).toHaveLength(2);
    const child = comments.find((c) => c.commentId === "c-child");
    expect(child?.inReplyToCommentId).toBe("c-parent");
    expect(child?.replyToUsername).toBe("commenter_a");
    const parent = comments.find((c) => c.commentId === "c-parent");
    expect(parent?.replyToUsername).toBeNull();
  });

  it("exposes post and comment evidence in the ledger and chain", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_evidence" });
    const recorded = await recordPost(handle.db, {
      targetId: target.id,
      sourceId: SOURCE.id,
      ...postInput("depth_evidence", "post-e1", T0),
    });
    await recordPostComment(handle.db, {
      postDbId: recorded.post.id,
      ...commentInput("post-e1", "c-e1", T0),
    });
    const ledger = await listScopedEvidence(handle.db, userId, 50);
    const kinds = new Set(ledger.map((r) => r.observation_kind));
    expect(kinds.has("post")).toBe(true);
    expect(kinds.has("post_comment")).toBe(true);

    expect(recorded.post.evidenceId).not.toBeNull();
    const chain = await getEvidenceChain(handle.db, userId, recorded.post.evidenceId!);
    expect(chain).not.toBeNull();
    expect(chain?.claim).toContain("post-e1");
    expect(chain?.claim).toContain("depth_evidence");
    const labels = (chain?.lineage ?? []).map((l) => l.label);
    expect(labels).toContain("Provider-declared media type");
    expect(labels).toContain("Comment observation state");
  });

  it("links activity feed events to their evidence", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_feed" });
    void target;
    await recordProfileSnapshot(
      handle.db,
      profileInput("depth_feed", "bio one", new Date(Date.UTC(2026, 7, 20, 9))),
    );
    await recordProfileSnapshot(
      handle.db,
      profileInput("depth_feed", "bio two", new Date(Date.UTC(2026, 7, 21, 9))),
    );
    const feed = await getUserActivityFeed(handle.db, userId, 30, { query: "depth_feed" });
    const change = feed.find((f) => f.type === "PROFILE_CHANGED");
    expect(change).toBeDefined();
    expect(change?.evidenceId).not.toBeNull();
  });

  it("returns an auditable member roster for snapshots", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_roster" });
    const snap = await recordFollowSnapshot(handle.db, {
      targetId: target.id,
      direction: "FOLLOWERS",
      source: SOURCE,
      takenAt: T0,
      page: {
        entries: [{ username: "zeta" }, { username: "alpha" }, { username: "mid" }],
        complete: true,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
    });
    const roster = await listMembersForSnapshot(handle.db, snap.snapshot.id, 50);
    expect(roster.map((r) => r.username)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("deleting one user's target preserves another user's shared observations", async () => {
    const other = await handle.db
      .insert(users)
      .values({ email: "depth-other@igtrack.local" })
      .returning({ id: users.id });
    const otherId = other[0]!.id;
    const mine = await createTarget(handle.db, { userId, username: "depth_shared" });
    const theirs = await createTarget(handle.db, { userId: otherId, username: "depth_shared" });
    const at = new Date(Date.UTC(2026, 7, 22, 9));
    await recordProfileSnapshot(handle.db, profileInput("depth_shared", "shared bio", at));
    await recordStory(handle.db, storyInput("depth_shared", "shared-story-1", at));

    expect(await deleteOwnedTarget(handle.db, userId, mine.target.id)).toBe(true);
    // Sibling target still resolves and its shared observations survive.
    const surviving = await listProfileSnapshots(handle.db, theirs.target.igAccountId, {});
    expect(surviving.length).toBeGreaterThan(0);

    expect(await deleteOwnedTarget(handle.db, otherId, theirs.target.id)).toBe(true);
    const gone = await listProfileSnapshots(handle.db, theirs.target.igAccountId, {});
    expect(gone).toHaveLength(0);
  });

  it("renews a live lease and refuses a foreign one", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "depth_lease" });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    const claimed = await claimJob(handle.db, "worker-depth");
    expect(claimed?.id).toBe(job.id);
    expect(await renewJobLease(handle.db, job.id, "worker-depth")).toBe(true);
    expect(await renewJobLease(handle.db, job.id, "worker-impostor")).toBe(false);
    await completeJob(handle.db, job.id, "worker-depth", "COMPLETED");
    expect(await renewJobLease(handle.db, job.id, "worker-depth")).toBe(false);
  });

  it("persists the provider-supplied story link URL", async () => {    const { target } = await createTarget(handle.db, { userId, username: "depth_link" });
    const at = new Date(Date.UTC(2026, 7, 23, 9));
    await recordStory(handle.db, {
      owner: { username: "depth_link" },
      sourceId: SOURCE.id,
      story: {
        storyId: "link-story-1",
        mediaType: "IMAGE",
        takenAt: at.toISOString(),
        hasLink: true,
        linkUrl: "https://example.com/prints",
        stickerKinds: ["link"],
        mentions: [],
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: at.toISOString(),
        },
      },
      evidence: {
        observationKind: "story",
        source: SOURCE,
        observedAt: at,
        capturedAt: at,
        confidence: Confidence.HIGH,
        rawHash: hash("link-story-1"),
      },
    });
    const rows = await listStories(handle.db, target.igAccountId, {});
    const row = rows.find((s) => s.storyId === "link-story-1");
    expect(row?.hasLink).toBe(true);
    expect(row?.linkUrl).toBe("https://example.com/prints");
  });

  it("exposes the latest snapshot source on list targets (never undefined)", async () => {
    const fresh = await createTarget(handle.db, { userId, username: "depth_nosnap" });
    const at = new Date(Date.UTC(2026, 7, 24, 9));
    await recordProfileSnapshot(handle.db, profileInput("depth_media", "bio", at));
    const items = await listTargetsForUser(handle.db, userId);
    const withSnap = items.find((t) => t.username === "depth_media");
    expect(withSnap?.snapshotSourceId).toBe("fixture:v1");
    const withoutSnap = items.find((t) => t.id === fresh.target.id);
    expect(withoutSnap?.snapshotSourceId).toBeNull();
  });
});

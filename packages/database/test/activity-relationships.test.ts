import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  getRelationshipsForUser,
  getUserActivityFeed,
  persistFollowDiff,
  recordFollowSnapshot,
  recordPost,
  recordPostComment,
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

// The ranking's arithmetic is what this file pins. The source class is
// deliberately a LIVE one: a synthetic observation is evidence about the
// fixture, not about a person, so it never contributes to a live ranking (the
// isolation is pinned separately, below).
const SOURCE = {
  id: "graph:owned:v1",
  kind: SourceKind.GRAPH_API,
  name: "Graph owned v1",
} as const;

// A synthetic source, used only to prove it cannot reach a live ranking.
const SYNTHETIC_SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
} as const;

// The two evidence classes a ranking is computed over. A ranking never
// blends them: a caller asks for one class at a time.
const LIVE = ["GRAPH_API"] as const;
const SYNTHETIC = ["FIXTURE"] as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

const T0 = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));
const T1 = new Date(Date.UTC(2026, 7, 21, 9, 0, 0));
// Long-expired story: taken day 0, expired day 1.
const TAKEN = new Date(Date.UTC(2026, 7, 20, 12, 0, 0));
const EXPIRED = new Date(Date.UTC(2026, 7, 21, 12, 0, 0));

function evidenceFor(kind: string, label: string, at: Date) {
  return {
    observationKind: kind,
    source: SOURCE,
    sourceReference: "test/feed",
    schemaVersion: "v1",
    observedAt: at,
    capturedAt: at,
    confidence: Confidence.HIGH,
    rawHash: hash(label),
    normalizedHash: hash(`${label}-norm`),
  };
}

function followPage(usernames: string[], at: Date) {
  return {
    entries: usernames.map((username) => ({ username })),
    complete: true,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: at.toISOString(),
    },
  };
}

describe.runIf(available)("activity timeline expansion", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "timeline@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("emits post, comment, expiry, and mention events with evidence", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "feed_target" });
    const recorded = await recordPost(handle.db, {
      targetId: target.id,
      owner: { username: "feed_target" },
      commentsState: "OBSERVED",
      post: {
        postId: "feed-post-1",
        takenAt: T0.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      sourceId: SOURCE.id,
      evidence: evidenceFor("post", "feed-post", T0),
    });
    await recordPostComment(handle.db, {
      postDbId: recorded.post.id,
      comment: {
        commentId: "feed-c1",
        postId: "feed-post-1",
        author: { username: "commenter_a" },
        text: "nice",
        createdAt: T1.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T1.toISOString(),
        },
      },
      evidence: evidenceFor("post_comment", "feed-c1", T1),
    });
    await recordStory(handle.db, {
      owner: { username: "feed_target" },
      sourceId: SOURCE.id,
      story: {
        storyId: "feed-story-1",
        mediaType: "IMAGE",
        takenAt: TAKEN.toISOString(),
        expiresAt: EXPIRED.toISOString(),
        hasLink: false,
        stickerKinds: [],
        mentions: [
          {
            account: { username: "tagged_friend" },
            visibilityClass: "VISIBLE",
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: TAKEN.toISOString(),
            },
          },
        ],
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: TAKEN.toISOString(),
        },
      },
      evidence: evidenceFor("story", "feed-story", TAKEN),
    });

    const feed = await getUserActivityFeed(handle.db, userId, 50, {});
    const byType = new Map(feed.map((f) => [f.type, f]));
    for (const type of ["POST_PUBLISHED", "COMMENT_POSTED", "STORY_EXPIRED", "MENTION_OBSERVED", "STORY_POSTED"]) {
      const item = byType.get(type);
      expect(item, type).toBeDefined();
      expect(item?.evidenceId, `${type} evidence`).not.toBeNull();
    }
    // Expiry is anchored at the provider timestamp, not at scan time.
    expect(byType.get("STORY_EXPIRED")?.timestamp.toISOString()).toBe(EXPIRED.toISOString());
    expect(byType.get("MENTION_OBSERVED")?.summary).toContain("tagged_friend");
  });

  it("filters the new types without breaking old ones", async () => {
    const only = await getUserActivityFeed(handle.db, userId, 30, {
      types: ["POST_PUBLISHED", "MENTION_OBSERVED"],
    });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((f) => f.type === "POST_PUBLISHED" || f.type === "MENTION_OBSERVED")).toBe(true);
  });
});

describe.runIf(available)("relationship structure (mutual, span)", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "relstruct@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, { userId, username: "rel_target" });
    targetId = target.id;

    // Day 0: followers {alice, bob}, following {alice, carol}.
    const f0 = await recordFollowSnapshot(handle.db, {
      targetId, direction: "FOLLOWERS", source: SOURCE, takenAt: T0,
      page: followPage(["alice", "bob"], T0),
    });
    const g0 = await recordFollowSnapshot(handle.db, {
      targetId, direction: "FOLLOWING", source: SOURCE, takenAt: T0,
      page: followPage(["alice", "carol"], T0),
    });
    // Day 1: bob leaves followers; dave arrives.
    const f1 = await recordFollowSnapshot(handle.db, {
      targetId, direction: "FOLLOWERS", source: SOURCE, takenAt: T1,
      page: followPage(["alice", "dave"], T1),
    });
    await persistFollowDiff(handle.db, {
      targetId, direction: "FOLLOWERS",
      fromSnapshotId: f0.snapshot.id, toSnapshotId: f1.snapshot.id,
    });
    void g0;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("marks mutual and current membership without inventing timestamps", async () => {
    const { ranks } = await getRelationshipsForUser(handle.db, userId, targetId, LIVE);
    const byName = new Map(ranks.map((r) => [r.username, r]));
    const alice = byName.get("alice")!;
    expect(alice.mutual).toBe(true);
    expect(alice.currentlyObserved).toBe(true);
    expect(alice.lastSeenAt).toBe(T1.toISOString());
    // Present since the earliest snapshot, but with no delta event the basis
    // stays honestly weak.
    expect(alice.firstSeenBasis).toBe("snapshot");
    expect(alice.firstSeenAt).toBe(T0.toISOString());

    const bob = byName.get("bob")!;
    expect(bob.mutual).toBe(false);
    expect(bob.currentlyObserved).toBe(false);
    expect(bob.lastSeenAt).toBeNull();
    // Bob's departure IS a delta event: strong basis, exact first-seen.
    expect(bob.firstSeenBasis).toBe("delta");
    expect(bob.firstSeenAt).toBe(T1.toISOString());

    const dave = byName.get("dave")!;
    expect(dave.currentlyObserved).toBe(true);
    expect(dave.firstSeenBasis).toBe("delta");
  });

  it("counts comment authorship on owned media, excluding the owner's own comments", async () => {
    const recorded = await recordPost(handle.db, {
      targetId,
      owner: { username: "rel_target" },
      commentsState: "OBSERVED",
      post: {
        postId: "rel-post-1",
        takenAt: T0.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T0.toISOString(),
        },
      },
      sourceId: SOURCE.id,
      evidence: evidenceFor("post", "rel-post-1", T0),
    });
    const commenters = ["close_friend", "close_friend", "rel_target"] as const;
    for (const [index, author] of commenters.entries()) {
      await recordPostComment(handle.db, {
        postDbId: recorded.post.id,
        comment: {
          commentId: `rel-c${index + 1}`,
          postId: "rel-post-1",
          author: { username: author },
          text: "!",
          createdAt: T1.toISOString(),
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: T1.toISOString(),
          },
        },
        evidence: evidenceFor("post_comment", `rel-c${index + 1}`, T1),
      });
    }

    const { ranks } = await getRelationshipsForUser(handle.db, userId, targetId, LIVE);
    const byName = new Map(ranks.map((r) => [r.username, r]));
    const friend = byName.get("close_friend")!;
    expect(friend.signals.comments).toBe(2);
    expect(friend.signals.mentions).toBe(0);
    // Two stored comment rows × the documented comment weight, nothing else.
    expect(friend.score).toBe(20);
    // D51: the newest stored signal timestamp and the rows behind the count —
    // every rank is traceable to observations.
    expect(friend.lastSignalAt).toBe(T1.toISOString());
    expect(friend.evidence.map((e) => e.kind)).toEqual(["comment", "comment"]);
    expect(friend.evidence[0]!.evidenceId).not.toBeNull();
    expect(friend.evidence[0]!.reference).toBe(recorded.post.id);
    // The owner commenting on their own post is not a relationship signal.
    expect(byName.get("rel_target")?.signals.comments ?? 0).toBe(0);
  });

  it("carries a recency window beside the all-time counts, never inside them (D51)", async () => {
    const oldAt = new Date(Date.now() - 40 * 24 * 3_600_000);
    const recentAt = new Date(Date.now() - 1 * 24 * 3_600_000);
    for (const [label, at, taken] of [
      ["win-old", oldAt, oldAt],
      ["win-new", recentAt, recentAt],
    ] as const) {
      await recordStory(handle.db, {
        owner: { username: "rel_target" },
        sourceId: SOURCE.id,
        story: {
          storyId: label,
          mediaType: "IMAGE",
          takenAt: taken.toISOString(),
          expiresAt: new Date(taken.getTime() + 24 * 3_600_000).toISOString(),
          hasLink: false,
          stickerKinds: [],
          mentions: [
            {
              account: { username: "window_friend" },
              visibilityClass: "VISIBLE",
              meta: {
                category: ObservationCategory.OBSERVED,
                confidence: Confidence.HIGH,
                observedAt: at.toISOString(),
              },
            },
          ],
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: at.toISOString(),
          },
        },
        evidence: evidenceFor("story", label, at),
      });
    }

    const { ranks } = await getRelationshipsForUser(handle.db, userId, targetId, LIVE);
    const ranked = ranks.find((r) => r.username === "window_friend")!;
    // Both stored mentions count; only the one inside the 30-day window is
    // recent. The score uses the all-time count — a decay constant would be
    // an invented number (D51).
    expect(ranked.signals.mentions).toBe(2);
    expect(ranked.signalsWithinWindow.mentions).toBe(1);
    expect(ranked.score).toBe(2 * 12);
    expect(ranked.lastSignalAt).toBe(recentAt.toISOString());
    expect(ranked.evidence).toHaveLength(2);
    expect(ranked.evidence[0]!.kind).toBe("mention");
    expect(ranked.evidence[0]!.observedAt).toBe(recentAt.toISOString());
    // Two mentions outrank one comment pair by weight alone: the order is the
    // documented arithmetic, not a vibe.
    expect(ranks[0]!.username).toBe("window_friend");
    // Two rows is more than zero and not more than two: LOW by the stored-count
    // rule, never rounded up.
    expect(ranks[0]!.confidence).toBe("LOW");
  });

  it("returns [] for unknown targets instead of fabricating ranks", async () => {
    const { ranks } = await getRelationshipsForUser(handle.db, userId, "00000000-0000-0000-0000-000000000000", LIVE);
    expect(ranks).toEqual([]);
  });

  it("never lets a synthetic interaction reach a live ranking", async () => {
    // A synthetic mention on a synthetic story: the fixture's own invented
    // interaction. It must not appear in the LIVE ranking, and it must not be
    // silently dropped either — it belongs in the synthetic ranking, which
    // the caller renders separately and labels.
    await recordStory(handle.db, {
      owner: { username: "rel_target" },
      sourceId: SYNTHETIC_SOURCE.id,
      story: {
        storyId: "synthetic-story",
        mediaType: "IMAGE",
        takenAt: T1.toISOString(),
        expiresAt: new Date(T1.getTime() + 24 * 3_600_000).toISOString(),
        hasLink: false,
        stickerKinds: [],
        mentions: [
          {
            account: { username: "synthetic_friend" },
            visibilityClass: "VISIBLE",
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: T1.toISOString(),
            },
          },
        ],
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: T1.toISOString(),
        },
      },
      evidence: {
        ...evidenceFor("story", "synthetic-story", T1),
        source: SYNTHETIC_SOURCE,
      },
    });

    const live = await getRelationshipsForUser(handle.db, userId, targetId, LIVE);
    expect(live.ranks.find((r) => r.username === "synthetic_friend")).toBeUndefined();
    expect(live.sourceKinds).not.toContain("FIXTURE");

    // The same row IS a real (synthetic) observation — it appears in the
    // synthetic ranking, so "no live observation" is never rendered as "no
    // interaction at all".
    const synthetic = await getRelationshipsForUser(handle.db, userId, targetId, SYNTHETIC);
    expect(synthetic.ranks.find((r) => r.username === "synthetic_friend")).toBeDefined();
    expect(synthetic.sourceKinds).toEqual(["FIXTURE"]);
  });
});

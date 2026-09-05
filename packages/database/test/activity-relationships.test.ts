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

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
} as const;

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
    const ranks = await getRelationshipsForUser(handle.db, userId, targetId);
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

  it("returns [] for unknown targets instead of fabricating ranks", async () => {
    expect(await getRelationshipsForUser(handle.db, userId, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

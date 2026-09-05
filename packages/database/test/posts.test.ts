import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  enqueueJob,
  listChildrenForPost,
  listCommentsForPostWithAccount,
  listPosts,
  loadStagedFollowScanMembers,
  monitoringJobs,
  recordCapabilityFailure,
  recordPost,
  recordPostChildren,
  recordPostComment,
  recordProfileSnapshot,
  listProfileChanges,
  stageFollowScanMembers,
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

function postInput(postId: string, takenAt: Date) {
  return {
    owner: { username: "target_posts" },
    commentsState: "OBSERVED" as const,
    post: {
      postId,
      takenAt: takenAt.toISOString(),
      caption: `caption ${postId}`,
      likeCount: 7,
      commentCount: 2,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: takenAt.toISOString(),
      },
    },
    evidence: {
      observationKind: "post",
      source: SOURCE,
      sourceReference: "test/posts",
      schemaVersion: "v1",
      observedAt: takenAt,
      capturedAt: takenAt,
      confidence: Confidence.HIGH,
      rawHash: hash(`post-${postId}`),
      normalizedHash: hash(`post-norm-${postId}`),
    },
  };
}

function commentInput(commentId: string, at: Date) {
  return {
    comment: {
      commentId,
      postId: "post-1",
      author: { username: "commenter_a" },
      text: `text ${commentId}`,
      createdAt: at.toISOString(),
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "post_comment",
      source: SOURCE,
      sourceReference: "test/comments",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`comment-${commentId}`),
      normalizedHash: hash(`comment-norm-${commentId}`),
    },
  };
}

describe.runIf(available)("posts & comments", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "posts@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const created = await createTarget(handle.db, { userId, username: "target_posts" });
    targetId = created.target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("records a post with evidence and lists it newest-first", async () => {
    const t0 = new Date(Date.UTC(2026, 7, 20, 9));
    const t1 = new Date(Date.UTC(2026, 7, 21, 9));
    await recordPost(handle.db, { targetId, sourceId: "fixture:v1", ...postInput("post-1", t0) });
    const second = await recordPost(handle.db, { targetId, sourceId: "fixture:v1", ...postInput("post-2", t1) });
    expect(second.deduplicated).toBe(false);
    expect(second.post.caption).toBe("caption post-2");

    const again = await recordPost(handle.db, { targetId, sourceId: "fixture:v1", ...postInput("post-1", t0) });
    expect(again.deduplicated).toBe(true);

    const listed = await listPosts(handle.db, targetId);
    expect(listed.map((p) => p.postId)).toEqual(["post-2", "post-1"]);
  });

  it("records comments with author usernames and refuses updates", async () => {
    const listed = await listPosts(handle.db, targetId);
    const post1 = listed.find((p) => p.postId === "post-1")!;
    const at = new Date(Date.UTC(2026, 7, 20, 10));
    await recordPostComment(handle.db, {
      postDbId: post1.id,
      ...commentInput("c-1", at),
    });
    const dup = await recordPostComment(handle.db, {
      postDbId: post1.id,
      ...commentInput("c-1", at),
    });
    expect(dup.deduplicated).toBe(true);

    const comments = await listCommentsForPostWithAccount(handle.db, post1.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.username).toBe("commenter_a");
    expect(comments[0]!.body).toBe("text c-1");

    await expect(
      handle.sql.unsafe(`UPDATE posts SET caption = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      handle.sql.unsafe(`UPDATE post_comments SET body = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });

  it("records comment like counts and resolves reply parents in one join", async () => {
    const listed = await listPosts(handle.db, targetId);
    const post1 = listed.find((p) => p.postId === "post-1")!;
    const at = new Date(Date.UTC(2026, 7, 20, 11));
    await recordPostComment(handle.db, {
      postDbId: post1.id,
      ...commentInput("c-2", at),
      comment: {
        ...commentInput("c-2", at).comment,
        author: { username: "commenter_b" },
        // Provider metadata: a real zero stays zero, absence stays null.
        likeCount: 0,
        inReplyToCommentId: "c-1",
      },
    });
    await recordPostComment(handle.db, {
      postDbId: post1.id,
      ...commentInput("c-3", at),
      comment: {
        ...commentInput("c-3", at).comment,
        author: { username: "commenter_c" },
        likeCount: 12,
      },
    });

    const comments = await listCommentsForPostWithAccount(handle.db, post1.id);
    const byId = new Map(comments.map((c) => [c.commentId, c]));
    // Absence (c-1) reads as null, never zero-filled.
    expect(byId.get("c-1")?.likeCount).toBeNull();
    expect(byId.get("c-2")?.likeCount).toBe(0);
    expect(byId.get("c-3")?.likeCount).toBe(12);
    expect(byId.get("c-2")?.inReplyToCommentId).toBe("c-1");
    expect(byId.get("c-2")?.replyToUsername).toBe("commenter_a");
    expect(byId.get("c-3")?.replyToUsername).toBeNull();
  });

  it("records album children in provider order, idempotently", async () => {
    const listed = await listPosts(handle.db, targetId);
    const post1 = listed.find((p) => p.postId === "post-1")!;
    const children = [
      { childId: "album-a", mediaType: "IMAGE" as const, takenAt: new Date(Date.UTC(2026, 7, 20, 9)).toISOString() },
      {
        childId: "album-b",
        mediaType: "VIDEO" as const,
        shortcode: "BbCc002",
        permalink: "https://www.instagram.com/reel/BbCc002/",
        takenAt: new Date(Date.UTC(2026, 7, 20, 10)).toISOString(),
      },
    ];
    const first = await recordPostChildren(handle.db, { postDbId: post1.id, children });
    expect(first).toEqual({ inserted: 2, deduplicated: 0 });
    const retry = await recordPostChildren(handle.db, { postDbId: post1.id, children });
    expect(retry).toEqual({ inserted: 0, deduplicated: 2 });

    const rows = await listChildrenForPost(handle.db, post1.id);
    expect(rows.map((r) => r.childMediaId)).toEqual(["album-a", "album-b"]);
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    expect(rows[1]?.shortcode).toBe("BbCc002");
    expect(rows[1]?.permalink).toBe("https://www.instagram.com/reel/BbCc002/");

    await expect(
      handle.sql.unsafe(`UPDATE post_children SET position = 9`),
    ).rejects.toThrow(/append-only/);
  });

  it("records nothing for an empty album listing", async () => {
    const listed = await listPosts(handle.db, targetId);
    const post1 = listed.find((p) => p.postId === "post-1")!;
    expect(await recordPostChildren(handle.db, { postDbId: post1.id, children: [] })).toEqual({
      inserted: 0,
      deduplicated: 0,
    });
  });
});

describe.runIf(available)("profile privacy snapshots", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "privacy2@igtrack.local" })
      .returning({ id: users.id });
    await createTarget(handle.db, { userId: rows[0]!.id, username: "target_priv" });
  });

  afterAll(async () => {
    await handle.close();
  });

  function snap(day: number, isPrivate: boolean) {
    const observedAt = new Date(Date.UTC(2026, 7, 20 + day, 9));
    return {
      profile: {
        account: { username: "target_priv", isPrivate },
        bio: "same",
        followerCount: 10,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: observedAt.toISOString(),
        },
      },
      evidence: {
        observationKind: "profile_snapshot",
        source: SOURCE,
        observedAt,
        capturedAt: observedAt,
        confidence: Confidence.HIGH,
        rawHash: hash(`priv-${day}`),
        normalizedHash: hash(`priv-norm-${day}`),
      },
    };
  }

  it("stores is_private per snapshot and derives the privacy flip", async () => {
    const first = await recordProfileSnapshot(handle.db, snap(0, false));
    expect(first.snapshot.isPrivate).toBe(false);
    const second = await recordProfileSnapshot(handle.db, snap(1, true));
    expect(second.snapshot.isPrivate).toBe(true);
    const changes = await listProfileChanges(handle.db, second.snapshot.igAccountId);
    const flip = changes.find((c) => c.field === "isPrivate");
    expect(flip?.oldValue).toBe("false");
    expect(flip?.newValue).toBe("true");
  });

  it("forwards accountType to the account row on insert and refresh", async () => {
    const at = (day: number) => new Date(Date.UTC(2026, 7, 20 + day, 9));
    const withType = (type: string, day: number) => ({
      profile: {
        ...snap(day, false).profile,
        account: { username: "target_priv", isPrivate: false },
        accountType: type,
      },
      evidence: {
        observationKind: "profile_snapshot",
        source: SOURCE,
        observedAt: at(day),
        capturedAt: at(day),
        confidence: Confidence.HIGH,
        rawHash: hash(`type-${day}`),
        normalizedHash: hash(`type-norm-${day}`),
      },
    });
    await recordProfileSnapshot(handle.db, withType("BUSINESS", 2));
    const { getAccountByUsername } = await import("../src/index.js");
    expect((await getAccountByUsername(handle.db, "target_priv"))?.accountType).toBe("BUSINESS");
    // Presence wins on refresh too: the update path must not drop the field.
    await recordProfileSnapshot(handle.db, withType("CREATOR", 3));
    expect((await getAccountByUsername(handle.db, "target_priv"))?.accountType).toBe("CREATOR");
  });
});

describe.runIf(available)("hardening: source-health + staging FK", () => {
  let handle: DatabaseHandle;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "harden@igtrack.local" })
      .returning({ id: users.id });
    const created = await createTarget(handle.db, {
      userId: rows[0]!.id,
      username: "target_harden",
    });
    targetId = created.target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("counts consecutive failures atomically", async () => {
    await recordCapabilityFailure(handle.db, {
      source: SOURCE,
      capability: "getProfile",
      reason: "boom 1",
    });
    const second = await recordCapabilityFailure(handle.db, {
      source: SOURCE,
      capability: "getProfile",
      reason: "boom 2",
    });
    expect(second.consecutiveFailures).toBe(2);
    expect(second.status).toBe("DEGRADED");
  });

  it("cascades staged rows when their job is deleted", async () => {
    const { job } = await enqueueJob(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId,
      idempotencyKey: "harden:job:1",
    });
    await stageFollowScanMembers(handle.db, {
      jobId: job.id,
      targetId,
      entries: [{ username: "staged_a" }, { username: "staged_b" }],
    });
    expect(await loadStagedFollowScanMembers(handle.db, job.id)).toHaveLength(2);
    await handle.db.execute(
      sql`DELETE FROM monitoring_jobs WHERE id = ${job.id}`,
    );
    expect(await loadStagedFollowScanMembers(handle.db, job.id)).toHaveLength(0);
    // Staging references the jobs table now.
    const fk = await handle.sql<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conname = 'follow_scan_staging_job_id_monitoring_jobs_id_fk'
    `;
    expect(fk.map((r) => r.name)).toContain(
      "follow_scan_staging_job_id_monitoring_jobs_id_fk",
    );
  });

  it("rejects staging rows for unknown jobs", async () => {
    await expect(
      stageFollowScanMembers(handle.db, {
        jobId: "00000000-0000-0000-0000-000000000000",
        targetId,
        entries: [{ username: "ghost" }],
      }),
    ).rejects.toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { and, asc, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  NormalizedAccountRef,
  NormalizedComment,
  NormalizedPost,
  NormalizedPostChild,
} from "@igtrack/core";
import { igAccounts, postChildren, postComments, posts } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { ensureSource } from "./sources.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type PostRecord = typeof posts.$inferSelect;
export type PostCommentRecord = typeof postComments.$inferSelect;
export type PostChildRecord = typeof postChildren.$inferSelect;

export type PostCommentState = "OBSERVED" | "UNAVAILABLE" | "NOT_SCANNED";

export interface RecordPostInput {
  targetId: string;
  owner: NormalizedAccountRef;
  post: NormalizedPost;
  sourceId: string;
  evidence: EvidenceRecordInput;
  // How the comment source for THIS post resolved. Recorded at insert time
  // because the posts table is append-only (no later UPDATE possible).
  commentsState: PostCommentState;
}

export interface RecordPostResult {
  post: PostRecord;
  deduplicated: boolean;
}

export async function recordPost(
  db: Database,
  input: RecordPostInput,
): Promise<RecordPostResult> {
  const { post } = input;

  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.evidence.source);

    const owner = await upsertAccount(tx, {
      username: input.owner.username,
      ...(input.owner.igId !== undefined ? { igId: input.owner.igId } : {}),
      ...(input.owner.displayName !== undefined
        ? { displayName: input.owner.displayName }
        : {}),
      seenAt: new Date(post.meta.observedAt),
    });

    const existing = await tx
      .select()
      .from(posts)
      .where(
        and(
          sql`${posts.igAccountId} = ${owner.id}`,
          sql`${posts.postId} = ${post.postId}`,
          sql`${posts.sourceId} = ${input.sourceId}`,
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return { post: existingRow, deduplicated: true };
    }

    const postDbId = randomUUID();
    const evidenceId = await upsertEvidence(tx, postDbId, {
      ...input.evidence,
      observationKind: ObservationKind.POST,
    });

    const rows = await tx
      .insert(posts)
      .values({
        id: postDbId,
        targetId: input.targetId,
        igAccountId: owner.id,
        postId: post.postId,
        sourceId: input.sourceId,
        observedAt: new Date(post.meta.observedAt),
        takenAt: new Date(post.takenAt),
        ...(post.caption !== undefined ? { caption: post.caption } : {}),
        ...(post.shortcode !== undefined ? { shortcode: post.shortcode } : {}),
        ...(post.permalink !== undefined ? { permalink: post.permalink } : {}),
        ...(post.likeCount !== undefined ? { likeCount: post.likeCount } : {}),
        ...(post.commentCount !== undefined ? { commentCount: post.commentCount } : {}),
        ...(post.mediaType !== undefined ? { mediaType: post.mediaType } : {}),
        ...(post.mediaProductType !== undefined
          ? { mediaProductType: post.mediaProductType }
          : {}),
        commentsState: input.commentsState,
        category: post.meta.category,
        confidence: post.meta.confidence,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      .onConflictDoNothing({
        target: [posts.igAccountId, posts.postId, posts.sourceId],
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      // Lost the insert race after the pre-select missed: re-read the
      // winner instead of failing the scan.
      const raced = await tx
        .select()
        .from(posts)
        .where(
          and(
            sql`${posts.igAccountId} = ${owner.id}`,
            sql`${posts.postId} = ${post.postId}`,
            sql`${posts.sourceId} = ${input.sourceId}`,
          ),
        )
        .limit(1);
      const racedRow = raced[0];
      if (racedRow === undefined) {
        throw new Error("igtrack: failed to insert post");
      }
      return { post: racedRow, deduplicated: true };
    }
    return { post: row, deduplicated: false };
  });
}

export interface RecordPostCommentInput {
  postDbId: string;
  comment: NormalizedComment;
  evidence: EvidenceRecordInput;
}

export async function recordPostComment(
  db: Database,
  input: RecordPostCommentInput,
): Promise<{ comment: PostCommentRecord; deduplicated: boolean }> {
  const { comment } = input;

  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.evidence.source);

    const author = await upsertAccount(tx, {
      username: comment.author.username,
      ...(comment.author.igId !== undefined ? { igId: comment.author.igId } : {}),
      seenAt: new Date(comment.meta.observedAt),
    });

    const existing = await tx
      .select()
      .from(postComments)
      .where(
        and(
          sql`${postComments.postDbId} = ${input.postDbId}`,
          sql`${postComments.commentId} = ${comment.commentId}`,
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return { comment: existingRow, deduplicated: true };
    }

    const commentDbId = randomUUID();
    const evidenceId = await upsertEvidence(tx, commentDbId, {
      ...input.evidence,
      observationKind: ObservationKind.POST_COMMENT,
    });

    const rows = await tx
      .insert(postComments)
      .values({
        id: commentDbId,
        postDbId: input.postDbId,
        authorAccountId: author.id,
        commentId: comment.commentId,
        body: comment.text,
        commentedAt: new Date(comment.createdAt),
        observedAt: new Date(comment.meta.observedAt),
        confidence: comment.meta.confidence,
        ...(comment.likeCount !== undefined ? { likeCount: comment.likeCount } : {}),
        ...(comment.inReplyToCommentId !== undefined
          ? { inReplyToCommentId: comment.inReplyToCommentId }
          : {}),
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      .onConflictDoNothing({
        target: [postComments.postDbId, postComments.commentId],
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      const raced = await tx
        .select()
        .from(postComments)
        .where(
          and(
            sql`${postComments.postDbId} = ${input.postDbId}`,
            sql`${postComments.commentId} = ${comment.commentId}`,
          ),
        )
        .limit(1);
      const racedRow = raced[0];
      if (racedRow === undefined) {
        throw new Error("igtrack: failed to insert post comment");
      }
      return { comment: racedRow, deduplicated: true };
    }
    return { comment: row, deduplicated: false };
  });
}

export async function listPosts(
  db: Database,
  targetId: string,
  options: { limit?: number } = {},
): Promise<PostRecord[]> {
  return db
    .select()
    .from(posts)
    .where(sql`${posts.targetId} = ${targetId}`)
    .orderBy(desc(posts.takenAt))
    .limit(options.limit ?? 20);
}

export interface RecordPostChildrenInput {
  postDbId: string;
  children: NormalizedPostChild[];
}

export interface RecordPostChildrenResult {
  inserted: number;
  deduplicated: number;
}

// Persists one album's items in provider order. Idempotent per
// (post, child_media_id): re-scans and reclaimed scans collapse instead of
// duplicating. No separate evidence rows — children are covered by the
// parent post's evidence (they arrive in the same observation).
export async function recordPostChildren(
  db: Database,
  input: RecordPostChildrenInput,
): Promise<RecordPostChildrenResult> {
  if (input.children.length === 0) return { inserted: 0, deduplicated: 0 };
  return withTransaction(db, async (tx) => {
    let inserted = 0;
    let deduplicated = 0;
    let position = 0;
    for (const child of input.children) {
      position += 1;
      const rows = await tx
        .insert(postChildren)
        .values({
          id: randomUUID(),
          postDbId: input.postDbId,
          position,
          childMediaId: child.childId,
          ...(child.mediaType !== undefined ? { mediaType: child.mediaType } : {}),
          ...(child.shortcode !== undefined ? { shortcode: child.shortcode } : {}),
          ...(child.permalink !== undefined ? { permalink: child.permalink } : {}),
          ...(child.takenAt !== undefined ? { takenAt: new Date(child.takenAt) } : {}),
        })
        .onConflictDoNothing({
          target: [postChildren.postDbId, postChildren.childMediaId],
        })
        .returning({ id: postChildren.id });
      if (rows[0] !== undefined) inserted += 1;
      else deduplicated += 1;
    }
    return { inserted, deduplicated };
  });
}

export async function listChildrenForPost(
  db: Database,
  postDbId: string,
): Promise<PostChildRecord[]> {
  return db
    .select()
    .from(postChildren)
    .where(sql`${postChildren.postDbId} = ${postDbId}`)
    .orderBy(asc(postChildren.position));
}

export interface PostCommentWithAccount extends PostCommentRecord {
  username: string;
  // Username of the parent comment's author when this comment is a reply and
  // the parent was observed; null otherwise. Resolved in one self-join, not
  // per-comment queries.
  replyToUsername: string | null;
}

export async function listCommentsForPostWithAccount(
  db: Database,
  postDbId: string,
): Promise<PostCommentWithAccount[]> {
  const parentComments = alias(postComments, "parent_comments");
  const parentAccounts = alias(igAccounts, "parent_accounts");
  return db
    .select({
      id: postComments.id,
      postDbId: postComments.postDbId,
      authorAccountId: postComments.authorAccountId,
      commentId: postComments.commentId,
      body: postComments.body,
      commentedAt: postComments.commentedAt,
      observedAt: postComments.observedAt,
      confidence: postComments.confidence,
      likeCount: postComments.likeCount,
      inReplyToCommentId: postComments.inReplyToCommentId,
      evidenceId: postComments.evidenceId,
      createdAt: postComments.createdAt,
      username: igAccounts.username,
      replyToUsername: parentAccounts.username,
    })
    .from(postComments)
    .innerJoin(igAccounts, sql`${igAccounts.id} = ${postComments.authorAccountId}`)
    .leftJoin(
      parentComments,
      sql`${parentComments.postDbId} = ${postComments.postDbId} AND ${parentComments.commentId} = ${postComments.inReplyToCommentId}`,
    )
    .leftJoin(parentAccounts, sql`${parentAccounts.id} = ${parentComments.authorAccountId}`)
    .where(sql`${postComments.postDbId} = ${postDbId}`)
    .orderBy(desc(postComments.commentedAt));
}

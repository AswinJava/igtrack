import { randomUUID } from "node:crypto";
import { and, desc, sql } from "drizzle-orm";
import type { NormalizedAccountRef, NormalizedComment, NormalizedPost } from "@igtrack/core";
import { igAccounts, postComments, posts } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { ensureSource } from "./sources.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type PostRecord = typeof posts.$inferSelect;
export type PostCommentRecord = typeof postComments.$inferSelect;

export interface RecordPostInput {
  targetId: string;
  owner: NormalizedAccountRef;
  post: NormalizedPost;
  sourceId: string;
  evidence: EvidenceRecordInput;
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
        ...(post.likeCount !== undefined ? { likeCount: post.likeCount } : {}),
        ...(post.commentCount !== undefined ? { commentCount: post.commentCount } : {}),
        category: post.meta.category,
        confidence: post.meta.confidence,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("igtrack: failed to insert post");
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

export interface PostCommentWithAccount extends PostCommentRecord {
  username: string;
}

export async function listCommentsForPostWithAccount(
  db: Database,
  postDbId: string,
): Promise<PostCommentWithAccount[]> {
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
      evidenceId: postComments.evidenceId,
      createdAt: postComments.createdAt,
      username: igAccounts.username,
    })
    .from(postComments)
    .innerJoin(igAccounts, sql`${igAccounts.id} = ${postComments.authorAccountId}`)
    .where(sql`${postComments.postDbId} = ${postDbId}`)
    .orderBy(desc(postComments.commentedAt));
}

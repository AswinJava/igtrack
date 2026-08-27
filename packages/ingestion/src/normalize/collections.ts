import {
  Confidence,
  ObservationCategory,
  type NormalizedComment,
  type NormalizedFollowPage,
  type NormalizedPost,
} from "@igtrack/core";
import type {
  RawCommentsPageV1,
  RawFollowPageV1,
  RawPostsPageV1,
} from "../raw-schemas/v1.js";

export function normalizeFollowPage(raw: RawFollowPageV1): NormalizedFollowPage {
  return {
    entries: raw.users.map((u) => ({
      username: u.username,
      ...(u.id !== undefined ? { igId: u.id } : {}),
    })),
    ...(raw.next_cursor !== null ? { nextCursor: raw.next_cursor } : {}),
    complete: raw.next_cursor === null,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
      observedAt: raw.captured_at,
    },
  };
}

export function normalizePosts(raw: RawPostsPageV1): NormalizedPost[] {
  return raw.posts.map((p) => ({
    postId: p.id,
    ...(p.shortcode !== undefined ? { shortcode: p.shortcode } : {}),
    takenAt: p.taken_at,
    ...(p.caption !== undefined ? { caption: p.caption } : {}),
    ...(p.like_count !== undefined ? { likeCount: p.like_count } : {}),
    ...(p.comment_count !== undefined ? { commentCount: p.comment_count } : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: raw.captured_at,
    },
  }));
}

export function normalizeComments(raw: RawCommentsPageV1): NormalizedComment[] {
  return raw.comments.map((c) => ({
    commentId: c.id,
    postId: raw.post_id,
    author: {
      username: c.user.username,
      ...(c.user.id !== undefined ? { igId: c.user.id } : {}),
      isPrivate: false,
    },
    text: c.text,
    createdAt: c.created_at,
    ...(c.in_reply_to_comment_id !== undefined
      ? { inReplyToCommentId: c.in_reply_to_comment_id }
      : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: raw.captured_at,
    },
  }));
}

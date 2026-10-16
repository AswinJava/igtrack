import {
  Confidence,
  ObservationCategory,
  type MediaType,
  type NormalizedComment,
  type NormalizedFollowPage,
  type NormalizedMentionedComment,
  type NormalizedPost,
  type NormalizedTagPage,
} from "@igtrack/core";
import type {
  RawCommentsPageV1,
  RawFollowPageV1,
  RawMentionedCommentV1,
  RawPostsPageV1,
  RawTagsPageV1,
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
    ...(p.permalink !== undefined ? { permalink: p.permalink } : {}),
    takenAt: p.taken_at,
    ...(p.caption !== undefined ? { caption: p.caption } : {}),
    ...(p.like_count !== undefined ? { likeCount: p.like_count } : {}),
    ...(p.comment_count !== undefined ? { commentCount: p.comment_count } : {}),
    ...(p.reposts_count !== undefined ? { repostsCount: p.reposts_count } : {}),
    ...(p.media_type !== undefined
      ? { mediaType: mapRawMediaType(p.media_type) }
      : {}),
    ...(p.media_product_type !== undefined
      ? { mediaProductType: p.media_product_type }
      : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: raw.captured_at,
    },
  }));
}

/** Provider-declared media type token → MediaType. Unknown tokens stay UNKNOWN. */
export function mapRawMediaType(raw: string): MediaType {
  const token = raw.trim().toUpperCase();
  if (token === "IMAGE") return "IMAGE";
  if (token === "VIDEO") return "VIDEO";
  if (token === "CAROUSEL" || token === "CAROUSEL_ALBUM") return "CAROUSEL";
  return "UNKNOWN";
}

export function normalizeComments(raw: RawCommentsPageV1): NormalizedComment[] {
  return raw.comments.map((c) => ({
    commentId: c.id,
    postId: raw.post_id,
    author: {
      username: c.user.username,
      ...(c.user.id !== undefined ? { igId: c.user.id } : {}),
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

// Tagged media (IG User `tags` edge). Per-item confidence is HIGH wherever the
// provider returned the row — completeness is a PAGE-level fact and travels in
// `complete`, so a partial listing can never masquerade as a complete one.
export function normalizeTagPage(raw: RawTagsPageV1): NormalizedTagPage {
  return {
    items: raw.tags.map((t) => ({
      mediaId: t.id,
      ...(t.username !== undefined ? { ownerUsername: t.username } : {}),
      ...(t.caption !== undefined ? { caption: t.caption } : {}),
      ...(t.permalink !== undefined ? { permalink: t.permalink } : {}),
      ...(t.media_type !== undefined
        ? { mediaType: mapRawMediaType(t.media_type) }
        : {}),
      ...(t.taken_at !== undefined ? { takenAt: t.taken_at } : {}),
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: raw.captured_at,
      },
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

export function normalizeMentionedComment(
  raw: RawMentionedCommentV1,
  capturedAt: string,
): NormalizedMentionedComment {
  return {
    commentId: raw.id,
    text: raw.text,
    createdAt: raw.created_at,
    ...(raw.like_count !== undefined ? { likeCount: raw.like_count } : {}),
    ...(raw.media_id !== undefined ? { mediaId: raw.media_id } : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: capturedAt,
    },
  };
}

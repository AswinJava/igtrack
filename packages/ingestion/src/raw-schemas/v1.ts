import { z } from "zod";

const isoDatetime = z.string().datetime({ offset: true });

export const rawUserV1 = z.object({
  id: z.string().optional(),
  username: z.string().min(1),
});

export const rawProfileV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  profile: z.object({
    id: z.string().optional(),
    username: z.string().min(1),
    full_name: z.string().optional(),
    biography: z.string().optional(),
    follower_count: z.number().int().nonnegative().optional(),
    following_count: z.number().int().nonnegative().optional(),
    media_count: z.number().int().nonnegative().optional(),
    is_verified: z.boolean().optional(),
    is_private: z.boolean().optional(),
    profile_pic_url: z.string().url().optional(),
    external_url: z.string().url().optional(),
  }),
});

export const rawMentionV1 = z.object({
  id: z.string().optional(),
  username: z.string().min(1),
  is_hidden: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const rawStoryV1 = z.object({
  id: z.string().min(1),
  taken_at: isoDatetime,
  expires_at: isoDatetime.optional(),
  media_type: z.enum(["image", "video"]).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
  link_url: z.string().url().optional(),
  stickers: z.array(z.string()).optional(),
  mentions: z.array(rawMentionV1).optional(),
  poll: z
    .object({
      question: z.string().optional(),
      options: z.array(z.string()).optional(),
    })
    .optional(),
  question: z
    .object({
      question: z.string().optional(),
    })
    .optional(),
  location: z
    .object({
      name: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .optional(),
  music: z
    .object({
      title: z.string().optional(),
      artist: z.string().optional(),
    })
    .optional(),
});

export const rawStoriesV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  canvas: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  stories: z.array(rawStoryV1),
});

export const rawFollowPageV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  users: z.array(rawUserV1),
  next_cursor: z.string().nullable(),
});

export const rawPostV1 = z.object({
  id: z.string().min(1),
  shortcode: z.string().optional(),
  permalink: z.string().optional(),
  taken_at: isoDatetime,
  caption: z.string().optional(),
  like_count: z.number().int().nonnegative().optional(),
  comment_count: z.number().int().nonnegative().optional(),
  // Documented IG Media reposts_count (top-level media only; the owner can
  // disable reposts display). Optional: absence is an absence, never a zero.
  reposts_count: z.number().int().nonnegative().optional(),
  // Optional provider-declared media typing (v1 fixture files omit these;
  // future sets and live adapters may carry them). IMAGE/VIDEO/CAROUSEL only.
  media_type: z.string().optional(),
  media_product_type: z.string().optional(),
});

export const rawPostsPageV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  posts: z.array(rawPostV1),
  next_cursor: z.string().nullable(),
});

export const rawCommentV1 = z.object({
  id: z.string().min(1),
  user: rawUserV1,
  text: z.string(),
  created_at: isoDatetime,
  in_reply_to_comment_id: z.string().optional(),
});

export const rawCommentsPageV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  post_id: z.string().min(1),
  comments: z.array(rawCommentV1),
  next_cursor: z.string().nullable(),
});

export const rawInsightPointV1 = z.object({
  metric: z.string().min(1),
  period: z.string().min(1),
  timeframe: z.string().min(1).optional(),
  dimension: z.string().min(1).optional(),
  dimension_value: z.string().min(1).optional(),
  end_time: isoDatetime.optional(),
  value: z.number(),
});

// A metric the platform returned no data for. Reason is mandatory: an absence
// without a reason would be indistinguishable from missing data.
export const rawInsightAbsenceV1 = z.object({
  metric: z.string().min(1),
  period: z.string().min(1),
  reason: z.string().min(1),
});

export const rawInsightsV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  window_since: isoDatetime.optional(),
  window_until: isoDatetime.optional(),
  points: z.array(rawInsightPointV1),
  absences: z.array(rawInsightAbsenceV1),
});

// Another account's public data via the documented Business Discovery edge
//. Every descriptive field is optional: the platform legitimately omits
// what it does not return, and a fixture exercises the absence path by
// omission — never by a zero.
export const rawDiscoveryV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  account: z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    full_name: z.string().optional(),
    biography: z.string().optional(),
    website: z.string().optional(),
    profile_picture_url: z.string().optional(),
    followers_count: z.number().int().nonnegative().optional(),
    follows_count: z.number().int().nonnegative().optional(),
    media_count: z.number().int().nonnegative().optional(),
  }),
  recent_media: z.array(rawPostV1),
});

// Tagged media (documented IG User `tags` edge): media owned by OTHER
// accounts in which the observed account was tagged. The owner username is
// optional — the platform omits what it does not return.
export const rawTaggedMediaV1 = z.object({
  id: z.string().min(1),
  username: z.string().min(1).optional(),
  caption: z.string().optional(),
  permalink: z.string().optional(),
  media_type: z.string().optional(),
  taken_at: isoDatetime.optional(),
});

export const rawTagsPageV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  tags: z.array(rawTaggedMediaV1),
  next_cursor: z.string().nullable(),
});

// Mentioned comments (the webhook-keyed `mentioned_comment` read). No listing
// edge exists, so the fixture set is a set of readable ids; an id the set does
// not declare is UNAVAILABLE, never fabricated.
export const rawMentionedCommentV1 = z.object({
  id: z.string().min(1),
  text: z.string(),
  created_at: isoDatetime,
  like_count: z.number().int().nonnegative().optional(),
  media_id: z.string().min(1).optional(),
});

export const rawMentionedCommentsV1 = z.object({
  schema_version: z.literal("v1"),
  captured_at: isoDatetime,
  comments: z.array(rawMentionedCommentV1),
});

export type RawProfileV1 = z.infer<typeof rawProfileV1>;
export type RawStoriesV1 = z.infer<typeof rawStoriesV1>;
export type RawStoryV1 = z.infer<typeof rawStoryV1>;
export type RawMentionV1 = z.infer<typeof rawMentionV1>;
export type RawFollowPageV1 = z.infer<typeof rawFollowPageV1>;
export type RawPostsPageV1 = z.infer<typeof rawPostsPageV1>;
export type RawCommentsPageV1 = z.infer<typeof rawCommentsPageV1>;
export type RawInsightsV1 = z.infer<typeof rawInsightsV1>;
export type RawDiscoveryV1 = z.infer<typeof rawDiscoveryV1>;
export type RawTaggedMediaV1 = z.infer<typeof rawTaggedMediaV1>;
export type RawTagsPageV1 = z.infer<typeof rawTagsPageV1>;
export type RawMentionedCommentV1 = z.infer<typeof rawMentionedCommentV1>;
export type RawMentionedCommentsV1 = z.infer<typeof rawMentionedCommentsV1>;

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
  taken_at: isoDatetime,
  caption: z.string().optional(),
  like_count: z.number().int().nonnegative().optional(),
  comment_count: z.number().int().nonnegative().optional(),
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

export type RawProfileV1 = z.infer<typeof rawProfileV1>;
export type RawStoriesV1 = z.infer<typeof rawStoriesV1>;
export type RawStoryV1 = z.infer<typeof rawStoryV1>;
export type RawMentionV1 = z.infer<typeof rawMentionV1>;
export type RawFollowPageV1 = z.infer<typeof rawFollowPageV1>;
export type RawPostsPageV1 = z.infer<typeof rawPostsPageV1>;
export type RawCommentsPageV1 = z.infer<typeof rawCommentsPageV1>;

import type { Confidence, ObservationCategory } from "./epistemics.js";

export interface ObservationMeta {
  category: ObservationCategory;
  confidence: Confidence;
  observedAt: string;
  evidenceId?: string;
}

export interface NormalizedAccountRef {
  igId?: string;
  username: string;
  displayName?: string;
  isPrivate?: boolean;
}

export interface NormalizedProfile {
  account: NormalizedAccountRef;
  bio?: string;
  externalUrl?: string;
  profilePicUrl?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  isVerified?: boolean;
  accountType?: string;
  meta: ObservationMeta;
}

export const MediaType = {
  IMAGE: "IMAGE",
  VIDEO: "VIDEO",
  CAROUSEL: "CAROUSEL",
  UNKNOWN: "UNKNOWN",
} as const;

export type MediaType = (typeof MediaType)[keyof typeof MediaType];

export const MentionVisibilityClass = {
  VISIBLE: "VISIBLE",
  POSSIBLY_HIDDEN: "POSSIBLY_HIDDEN",
  OFF_CANVAS: "OFF_CANVAS",
  METADATA_ONLY: "METADATA_ONLY",
  UNKNOWN: "UNKNOWN",
} as const;

export type MentionVisibilityClass =
  (typeof MentionVisibilityClass)[keyof typeof MentionVisibilityClass];

export interface MentionGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  canvasWidth?: number;
  canvasHeight?: number;
}

export interface NormalizedMention {
  account: NormalizedAccountRef;
  geometry?: MentionGeometry;
  rawVisibilityFlag?: boolean;
  visibilityClass: MentionVisibilityClass;
  meta: ObservationMeta;
}

export interface StoryPollMeta {
  question?: string;
  options?: string[];
}

export interface StoryQuestionMeta {
  question?: string;
}

export interface StoryLocationMeta {
  name?: string;
  lat?: number;
  lng?: number;
}

export interface StoryMusicMeta {
  title?: string;
  artist?: string;
}

export interface NormalizedStory {
  storyId: string;
  mediaType: MediaType;
  takenAt: string;
  expiresAt?: string;
  durationMs?: number;
  caption?: string;
  hasLink: boolean;
  // Provider-supplied link target when hasLink is true. Absent when the
  // provider exposes no URL — never fabricated from the boolean.
  linkUrl?: string;
  stickerKinds: string[];
  poll?: StoryPollMeta;
  question?: StoryQuestionMeta;
  location?: StoryLocationMeta;
  music?: StoryMusicMeta;
  mentions: NormalizedMention[];
  meta: ObservationMeta;
}

export interface NormalizedFollowEntry {
  igId?: string;
  username: string;
}

export interface NormalizedFollowPage {
  entries: NormalizedFollowEntry[];
  nextCursor?: string;
  complete: boolean;
  meta: ObservationMeta;
}

export interface NormalizedPostChild {
  /** Provider media id of the album item (source-scoped). */
  childId: string;
  /** Provider-declared type of the item; absent when undeclared. */
  mediaType?: MediaType;
  shortcode?: string;
  /** Full provider-supplied item URL; never reconstructed. */
  permalink?: string;
  takenAt?: string;
}

export interface NormalizedPost {
  postId: string;
  shortcode?: string;
  // Full provider-supplied post URL. Independent of shortcode: only stored
  // when the provider returns it, never reconstructed or guessed.
  permalink?: string;
  takenAt: string;
  caption?: string;
  likeCount?: number;
  commentCount?: number;
  // Provider-declared media typing. IMAGE/VIDEO/CAROUSEL only when the source
  // explicitly identifies the type; mediaProductType preserves the raw product
  // classifier (e.g. FEED, REELS) for reels-vs-post distinction. Never
  // inferred from appearance — absent means the provider did not say.
  mediaType?: MediaType;
  mediaProductType?: string;
  /**
   * Album items, in provider order, present ONLY when the provider returned
   * them for this post. Absent on non-carousels AND on carousels whose
   * children were unavailable or not retrieved — callers must not read
   * absence as "single-item post"; the CAROUSEL mediaType carries that
   * distinction.
   */
  children?: NormalizedPostChild[];
  meta: ObservationMeta;
}

export const InteractionKind = {
  COMMENT: "COMMENT",
  REPLY: "REPLY",
  MENTION: "MENTION",
  TAG: "TAG",
  LIKE_SIGNAL: "LIKE_SIGNAL",
} as const;

export type InteractionKind =
  (typeof InteractionKind)[keyof typeof InteractionKind];

export interface NormalizedComment {
  commentId: string;
  postId: string;
  author: NormalizedAccountRef;
  text: string;
  createdAt: string;
  inReplyToCommentId?: string;
  // Provider-supplied like count on the comment (IG Comment like_count).
  // Absent when the provider omits it (hidden counts, no permission) — never zero-filled.
  likeCount?: number;
  meta: ObservationMeta;
}

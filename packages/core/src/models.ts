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

export interface NormalizedPost {
  postId: string;
  shortcode?: string;
  takenAt: string;
  caption?: string;
  likeCount?: number;
  commentCount?: number;
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
  meta: ObservationMeta;
}

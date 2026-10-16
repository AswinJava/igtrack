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
  /**
   * IG Media `reposts_count` when the provider returned it. Documented as a
   * top-level-only, owner-gated scalar (carousel children never carry it, and
   * a media owner can disable reposts/shares display, in which case the
   * platform omits or zeroes it). Absent means the provider did not return a
   * value — never zero-filled, never inferred from similar-looking content.
   */
  repostsCount?: number;
  meta: ObservationMeta;
}

// ---------------------------------------------------------------------------
// Tagged media (documented IG User `tags` edge). Media owned by OTHER accounts
// in which the observed account was tagged. A reference, not the account's
// media: never diffed against posts and never rendered as "the account's
// posts". Provider-verbatim fields; a field the platform withheld stays
// absent (FOUNDING §17).
// ---------------------------------------------------------------------------

export interface NormalizedTaggedMedia {
  /** Provider media id of the media the account was tagged in. */
  mediaId: string;
  /** Owner of that media (the tagging account) when the provider returned it. */
  ownerUsername?: string;
  caption?: string;
  /** Full provider-supplied permalink; never reconstructed or guessed. */
  permalink?: string;
  /** Provider-declared media typing; absent means the provider did not say. */
  mediaType?: MediaType;
  /** Provider-published time of the tagged media, when returned. */
  takenAt?: string;
  meta: ObservationMeta;
}

export interface NormalizedTagPage {
  items: NormalizedTaggedMedia[];
  nextCursor?: string;
  /** True when the provider declares the listing complete (no further pages). */
  complete: boolean;
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

// The documented IG User `mentioned_comment` field expansion: one comment on
// someone else's media in which the observed account was @mentioned. The
// platform publishes no listing edge — the comment id arrives via Meta
// webhook notifications — so this model is only ever produced for a caller-
// supplied id. Only the documented fields exist here; no author is returned
// by the expansion, so none is invented.
export interface NormalizedMentionedComment {
  commentId: string;
  text?: string;
  createdAt?: string;
  likeCount?: number;
  /** Id of the media the comment was made on, when returned. */
  mediaId?: string;
  meta: ObservationMeta;
}

// ---------------------------------------------------------------------------
// Own-account insights (IG User insights edge). Metrics are aggregate claims,
// so the honesty rules are stricter than usual: a metric the platform does not
// return is an ABSENCE with a reason, never a zero and never a fabricated
// point. Metric/period/dimension names are provider verbatim — this model
// defines no metric vocabulary of its own.
// ---------------------------------------------------------------------------

export interface NormalizedInsightPoint {
  /** Provider metric name, verbatim (e.g. "reach", "follower_count"). */
  metric: string;
  /** Provider period token, verbatim (e.g. "day", "lifetime"). */
  period: string;
  /** Demographics timeframe token when the provider used one, else absent. */
  timeframe?: string;
  /** Breakdown dimension when the provider supplied one (e.g. "country"), else absent. */
  dimension?: string;
  /** The key within the dimension (e.g. "US"); absent for scalar metrics. */
  dimensionValue?: string;
  /** ISO end of the metric bucket for time-series points; absent for total_value points. */
  endTime?: string;
  value: number;
}

export interface NormalizedInsightAbsence {
  metric: string;
  period: string;
  /**
   * Why the metric is absent: the documented platform rule when one applies
   * (e.g. below 100 followers), otherwise that the platform returned no data
   * for it. Never a value claim of any kind.
   */
  reason: string;
}

export interface NormalizedInsightSet {
  points: NormalizedInsightPoint[];
  absences: NormalizedInsightAbsence[];
  /**
   * The since/until window the provider actually requested. Documented
   * platform default is a 24-hour lookback when omitted — recorded so the
   * window is never ambiguous after the fact.
   */
  windowSince?: string;
  windowUntil?: string;
  meta: ObservationMeta;
}

// ---------------------------------------------------------------------------
// Other-account public data (Business Discovery). A PROBE, not a record: the
// lookup path renders it for the caller and persists nothing, so there is no
// evidence row to owe. Only the documented Business Discovery fields exist
// here — profile fields plus the media edge. Nothing is inferred: a field the
// platform withheld stays absent (D42).
// ---------------------------------------------------------------------------

/**
 * The documented Business Discovery media edge takes a `limit` and does not
 * page: the route can return at most this many media rows and the account may
 * have more. The bound travels with the observation (`recentMediaLimit`) so a
 * stored preview row can never be presented as "the account's posts".
 */
export const DISCOVERY_MEDIA_PREVIEW_LIMIT = 12;

export interface NormalizedDiscoveredAccount {
  account: NormalizedAccountRef;
  displayName?: string;
  bio?: string;
  externalUrl?: string;
  profilePicUrl?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  /** Bounded recent-media preview from the discovery media edge, in the order the platform returned it (Business Discovery returns newest first). */
  recentMedia: NormalizedPost[];
  /**
   * The route's ceiling on `recentMedia` when it is a bounded, non-pageable
   * preview: the provider cannot return more than this, and the account may
   * have more. Stored in the evidence of every media row so no surface can
   * render the preview as "the account's posts". Absent means the route
   * declared no ceiling (then nothing may claim one).
   */
  recentMediaLimit?: number;
  meta: ObservationMeta;
}

import { createHash } from "node:crypto";
import {
  available,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  errored,
  partial,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedDiscoveredAccount,
  type NormalizedFollowPage,
  type NormalizedInsightSet,
  type NormalizedMentionedComment,
  type NormalizedPost,
  type NormalizedPostChild,
  type NormalizedProfile,
  type NormalizedStory,
  type NormalizedTagPage,
  type PostReference,
  type ProviderCapabilities,
  type SourceRef,
} from "@igtrack/core";
import { IG_USERNAME_PATTERN } from "../config/readiness.js";
import {
  chromeUnavailableMessage,
  dumpDom,
  findChrome,
  type ChromeRunOptions,
} from "./chrome.js";
import {
  asCount,
  asNumber,
  asString,
  parsePostPage,
  parseProfilePage,
  parseReelsPage,
  reelsPageComplete,
  sanitizeRawNode,
  type PageMeta,
  type JsonRecord,
  type ParsedPostPage,
  type ParsedProfilePage,
  type PublicBioLink,
  type PublicHighlight,
  type PublicListingPost,
  type PublicLocation,
  type PublicMusic,
  type PublicPostNode,
  type PublicProfileNode,
  type PublicTaggedUser,
  type PublicUserReference,
} from "./ssr.js";

// ---------------------------------------------------------------------------
// Opt-in public-web provider.
//
// What it is: a real observation of the pages Instagram serves to a logged-out
// visitor, rendered in a local headless Chrome. What it is not: an official
// Graph API response, an authenticated session, or a way around a login wall.
// The source kind PUBLIC_WEB keeps that distinction in every stored row.
//
// Available (logged-out pages): the public profile (name, bio, links, counts,
// highlights strip), every media item the profile/reels grids expose, and
// each item's public metadata (caption, counts, publication time, owner,
// collaborators, location, tagged users, music, media URLs).
//
// Not available without a session, and reported as UNAVAILABLE with a reason:
// follower/following rosters, the comment list, likers, tagged-media listings,
// highlight contents, stories and insights. A comment COUNT is public; the
// comment LIST is not, and this provider never turns the former into the latter.
// ---------------------------------------------------------------------------

export interface PublicWebProviderConfig {
  /** Browser executable. Defaults to a detected Chrome/Chromium/Edge. */
  chromePath?: string | undefined;
  userAgent?: string | undefined;
  timeoutMs?: number | undefined;
  /** Virtual time for the profile page; media pages use a shorter budget. */
  virtualTimeBudgetMs?: number | undefined;
  /** How long one fetched page is reused (profile + reels + detail calls). */
  cacheTtlMs?: number | undefined;
  /** Test seam: replace the browser transport entirely. */
  fetchHtml?: ((url: string) => Promise<string>) | undefined;
  /** Safety bound on discovered media per dossier. */
  maxPosts?: number | undefined;
  /**
   * Time allowed for reading individual media pages. Past it, remaining items
   * are recorded from the listing alone instead of losing the whole batch to
   * the worker's per-call timeout. Defaults to 120s.
   */
  enrichBudgetMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface PublicWebSourceInfo {
  sourceId: string;
  kind: typeof SourceKind.PUBLIC_WEB;
  profileUrl: string;
  retrieval: "headless-chrome" | "injected-transport";
}

export interface PublicProfileDossier {
  username: string;
  pk?: string;
  igId?: string;
  fullName?: string;
  biography?: string;
  biographyMentions: string[];
  externalUrl?: string;
  profilePicUrl?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  postCountSource?: "all_media_count" | "og_description";
  isPrivate?: boolean;
  isVerified?: boolean;
  isMemorialized?: boolean;
  isUnpublished?: boolean;
  hasAnyClips?: boolean;
  pronouns: string[];
  bioLinks: PublicBioLink[];
  highlights: PublicHighlight[];
  /** True only when the page explicitly declared no further timeline page. */
  timelineComplete?: boolean;
  observedAt: string;
  /** Provider node, with session/tracking plumbing stripped. */
  raw?: unknown;
}

export interface PublicPostDossier {
  shortcode: string;
  postId?: string;
  permalink?: string;
  permalinkSource?: "og:url" | "canonical";
  takenAt?: string;
  observedAt: string;
  caption?: string;
  captionEdited?: boolean;
  likeCount?: number;
  commentCount?: number;
  playCount?: number;
  mediaType?: string;
  mediaTypeCode?: number;
  mediaProductType?: string;
  owner?: PublicUserReference;
  coauthors: PublicUserReference[];
  location?: PublicLocation;
  taggedUsers: PublicTaggedUser[];
  music?: PublicMusic;
  media: {
    displayUrl?: string;
    thumbnailUrl?: string;
    videoUrl?: string;
  };
  accessibilityCaption?: string;
  commentsDisabled?: boolean;
  likeAndViewCountsDisabled?: boolean;
  isPaidPartnership?: boolean;
  sponsorUsers: PublicUserReference[];
  aiLabel?: string;
  /** ENRICHED = its own media page was read; LISTING_ONLY = only grid data. */
  detailStatus: "ENRICHED" | "LISTING_ONLY";
  detailError?: string;
  /** Which logged-out listings exposed the item. */
  discoveredFrom: Array<"profile_timeline" | "reels_tab">;
  /** Fields taken from the grid listing because the media page did not carry them. */
  listingFallbackFields: string[];
  sourceUrl: string;
  /** Provider node, with session/tracking plumbing stripped. */
  raw?: unknown;
}

export interface PublicCoverageRow {
  subject: string;
  status: "OBSERVED" | "PARTIAL" | "UNAVAILABLE";
  value?: string | number | null;
  reason?: string;
}

export interface PublicGap {
  subject: string;
  reason: string;
  howToImprove: string | null;
}

export interface PublicWebDossier {
  requestedAt: string;
  observedAt: string;
  username: string;
  source: PublicWebSourceInfo;
  profile: PublicProfileDossier;
  posts: PublicPostDossier[];
  counts: {
    postsDeclared?: number;
    postsDiscovered: number;
    postsEnriched: number;
    postsListingOnly: number;
    /** Listing items owned by another account, excluded from `posts`. */
    postsSkippedForeign?: number;
    /** Listing items with no observable owner, excluded from `posts`. */
    postsSkippedUnverified?: number;
  };
  coverage: PublicCoverageRow[];
  gaps: PublicGap[];
  notes: string[];
}

export interface PublicWebDossierResult {
  status: CapabilityStatus;
  dossier?: PublicWebDossier;
  note?: string;
  error?: { kind: CapabilityErrorKind; message: string; retryable: boolean };
  observedAt: string;
}

/** The source record of a single media-page read. */
export interface PublicPostSourceInfo {
  sourceId: string;
  kind: typeof SourceKind.PUBLIC_WEB;
  postUrl: string;
  retrieval: "headless-chrome" | "injected-transport";
}

/**
 * One post resolved from its own URL. The post fields are the same shape the
 * dossier uses, so a post read through a link and a post read through its
 * owner's profile are comparable row for row. The comment LIST is kept out of
 * the post object and stated as its own UNAVAILABLE block: the page publishes
 * a comment count, never the comments themselves, and the two must not blur.
 */
export interface PublicSinglePost {
  requestedAt: string;
  observedAt: string;
  shortcode: string;
  kind: PostReference["kind"];
  source: PublicPostSourceInfo;
  post: PublicPostDossier;
  comments: { status: "UNAVAILABLE"; reason: string };
  notes: string[];
}

interface ProfileFetch {
  url: string;
  html: string;
  parsed: ParsedProfilePage;
  observedAt: string;
}

interface DiscoveredItem {
  code: string;
  listing: PublicListingPost;
  from: Array<"profile_timeline" | "reels_tab">;
}

interface CollectedListings {
  items: DiscoveredItem[];
  profileTimelineComplete?: boolean;
  reelsComplete?: boolean;
  reelsError?: string;
  profile: PublicProfileNode;
  profileRaw: JsonRecord;
  profileMeta: PageMeta;
}

class PublicPageFailure extends Error {
  readonly kind: CapabilityErrorKind;
  readonly retryable: boolean;

  constructor(kind: CapabilityErrorKind, message: string, retryable: boolean) {
    super(message);
    this.name = "PublicPageFailure";
    this.kind = kind;
    this.retryable = retryable;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

function profileUrl(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

function reelsUrl(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/reels/`;
}

function mediaUrl(code: string, mediaProductType: string | undefined): string {
  const kind = mediaProductType === "clips" ? "reel" : "p";
  return `https://www.instagram.com/${kind}/${encodeURIComponent(code)}/`;
}

function accountRef(profile: PublicProfileNode): NormalizedAccountRef {
  return {
    username: profile.username,
    ...(profile.igId !== undefined ? { igId: profile.igId } : {}),
    ...(profile.pk !== undefined && profile.igId === undefined ? { igId: profile.pk } : {}),
    ...(profile.fullName !== undefined ? { displayName: profile.fullName } : {}),
    ...(profile.isPrivate !== undefined ? { isPrivate: profile.isPrivate } : {}),
  };
}

function firstExternalLink(profile: PublicProfileNode): string | undefined {
  const external = profile.bioLinks.find((link) => link.linkType === "external");
  return external?.url ?? profile.bioLinks[0]?.url;
}

function profileCompleteness(profile: PublicProfileNode): string[] {
  const missing: string[] = [];
  if (profile.igId === undefined && profile.pk === undefined) missing.push("platform id");
  if (profile.followerCount === undefined) missing.push("follower count");
  if (profile.followingCount === undefined) missing.push("following count");
  if (profile.postCount === undefined) missing.push("post count");
  return missing;
}

type MediaOwnership = "OWN" | "FOREIGN" | "UNKNOWN";

/**
 * Who a listed media item belongs to, from the evidence the pages carry. The
 * logged-out profile timeline is not a pure owner listing: it also returns
 * media owned by other accounts (verified on @nasa, whose grid mixed in
 * other-account posts). A coauthor match counts as OWN — the item legitimately
 * appears on this profile — but an item that merely LOOKS like it belongs is
 * never accepted without an owner. The media page outranks the listing row
 * because it is the detail read; a listing-only row can only prove ownership
 * through its own node.
 */
function mediaOwnership(
  target: string,
  media: PublicPostNode | undefined,
  listing: PublicListingPost,
): MediaOwnership {
  const coauthored =
    media?.coauthors.some((coauthor) => coauthor.username.toLowerCase() === target) ===
    true;
  const owner =
    media?.owner?.username.toLowerCase() ?? listing.owner?.username.toLowerCase();
  if (owner === undefined) return coauthored ? "OWN" : "UNKNOWN";
  if (owner === target || coauthored) return "OWN";
  return "FOREIGN";
}

function postFromListing(
  listing: PublicListingPost,
  observedAt: string,
  permalink: string | undefined,
): NormalizedPost | undefined {
  const postId = listing.postId;
  if (postId === undefined || listing.takenAt === undefined) return undefined;
  return {
    postId,
    shortcode: listing.code,
    ...(permalink !== undefined ? { permalink } : {}),
    takenAt: listing.takenAt,
    ...(listing.caption !== undefined ? { caption: listing.caption } : {}),
    ...(listing.likeCount !== undefined ? { likeCount: listing.likeCount } : {}),
    ...(listing.commentCount !== undefined ? { commentCount: listing.commentCount } : {}),
    ...(listing.mediaType !== undefined && listing.mediaType !== "UNKNOWN"
      ? { mediaType: listing.mediaType }
      : {}),
    ...(listing.mediaProductType !== undefined
      ? { mediaProductType: listing.mediaProductType }
      : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.MEDIUM,
      observedAt,
    },
  };
}

function postFromMedia(
  media: PublicPostNode,
  meta: PageMeta,
  observedAt: string,
): NormalizedPost | undefined {
  if (media.postId === undefined || media.takenAt === undefined) return undefined;
  const permalink = meta.url ?? media.canonicalUrl;
  return {
    postId: media.postId,
    shortcode: media.code,
    ...(permalink !== undefined ? { permalink } : {}),
    takenAt: media.takenAt,
    ...(media.caption !== undefined ? { caption: media.caption } : {}),
    ...(media.likeCount !== undefined ? { likeCount: media.likeCount } : {}),
    ...(media.commentCount !== undefined ? { commentCount: media.commentCount } : {}),
    ...(media.mediaType !== undefined && media.mediaType !== "UNKNOWN"
      ? { mediaType: media.mediaType }
      : {}),
    ...(media.mediaProductType !== undefined
      ? { mediaProductType: media.mediaProductType }
      : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt,
    },
  };
}

function dossierPostFromMedia(
  media: PublicPostNode,
  parsed: ParsedPostPage,
  observedAt: string,
  sourceUrl: string,
  discoveredFrom: Array<"profile_timeline" | "reels_tab">,
  fallback: PublicListingPost | undefined,
): PublicPostDossier {
  const permalink = parsed.meta.url ?? media.canonicalUrl;
  // The media page carries publication time and engagement counts, but the
  // reels tab is the only logged-out surface that carries a play count. A
  // field the detail page lacked may be filled from the grid row that led here;
  // the dossier names every such field so a reader can tell the two apart.
  const likeCount = media.likeCount ?? fallback?.likeCount;
  const commentCount = media.commentCount ?? fallback?.commentCount;
  const playCount = media.playCount ?? fallback?.playCount;
  const fallbackFields: string[] = [];
  if (media.likeCount === undefined && likeCount !== undefined) fallbackFields.push("likeCount");
  if (media.commentCount === undefined && commentCount !== undefined) {
    fallbackFields.push("commentCount");
  }
  if (media.playCount === undefined && playCount !== undefined) fallbackFields.push("playCount");
  return {
    shortcode: media.code,
    ...(media.postId !== undefined ? { postId: media.postId } : {}),
    ...(permalink !== undefined ? { permalink } : {}),
    ...(parsed.meta.url !== undefined
      ? { permalinkSource: "og:url" as const }
      : media.canonicalUrl !== undefined
        ? { permalinkSource: "canonical" as const }
        : {}),
    ...(media.takenAt !== undefined ? { takenAt: media.takenAt } : {}),
    observedAt,
    ...(media.caption !== undefined ? { caption: media.caption } : {}),
    ...(media.captionEdited !== undefined ? { captionEdited: media.captionEdited } : {}),
    ...(likeCount !== undefined ? { likeCount } : {}),
    ...(commentCount !== undefined ? { commentCount } : {}),
    ...(playCount !== undefined ? { playCount } : {}),
    ...(media.mediaType !== undefined ? { mediaType: media.mediaType } : {}),
    ...(media.mediaTypeCode !== undefined ? { mediaTypeCode: media.mediaTypeCode } : {}),
    ...(media.mediaProductType !== undefined
      ? { mediaProductType: media.mediaProductType }
      : {}),
    ...(media.owner !== undefined ? { owner: media.owner } : {}),
    coauthors: media.coauthors,
    ...(media.location !== undefined ? { location: media.location } : {}),
    taggedUsers: media.taggedUsers,
    ...(media.music !== undefined ? { music: media.music } : {}),
    media: {
      ...(media.displayUrl !== undefined ? { displayUrl: media.displayUrl } : {}),
      ...(media.thumbnailUrl !== undefined ? { thumbnailUrl: media.thumbnailUrl } : {}),
      ...(media.videoUrl !== undefined ? { videoUrl: media.videoUrl } : {}),
    },
    ...(media.accessibilityCaption !== undefined
      ? { accessibilityCaption: media.accessibilityCaption }
      : {}),
    ...(media.commentsDisabled !== undefined
      ? { commentsDisabled: media.commentsDisabled }
      : {}),
    ...(media.likeAndViewCountsDisabled !== undefined
      ? { likeAndViewCountsDisabled: media.likeAndViewCountsDisabled }
      : {}),
    ...(media.isPaidPartnership !== undefined
      ? { isPaidPartnership: media.isPaidPartnership }
      : {}),
    sponsorUsers: media.sponsorUsers,
    ...(media.aiLabel !== undefined ? { aiLabel: media.aiLabel } : {}),
    detailStatus: "ENRICHED",
    discoveredFrom,
    listingFallbackFields: fallbackFields,
    sourceUrl,
    ...(parsed.rawMedia !== undefined
      ? { raw: sanitizeRawNode(parsed.rawMedia) }
      : {}),
  };
}

function dossierPostFromListing(
  item: DiscoveredItem,
  observedAt: string,
  error: string | undefined,
): PublicPostDossier {
  const listing = item.listing;
  return {
    shortcode: listing.code,
    ...(listing.postId !== undefined ? { postId: listing.postId } : {}),
    ...(listing.takenAt !== undefined ? { takenAt: listing.takenAt } : {}),
    observedAt,
    ...(listing.caption !== undefined ? { caption: listing.caption } : {}),
    ...(listing.likeCount !== undefined ? { likeCount: listing.likeCount } : {}),
    ...(listing.commentCount !== undefined ? { commentCount: listing.commentCount } : {}),
    ...(listing.playCount !== undefined ? { playCount: listing.playCount } : {}),
    ...(listing.mediaType !== undefined ? { mediaType: listing.mediaType } : {}),
    ...(listing.mediaTypeCode !== undefined ? { mediaTypeCode: listing.mediaTypeCode } : {}),
    ...(listing.mediaProductType !== undefined
      ? { mediaProductType: listing.mediaProductType }
      : {}),
    ...(listing.owner !== undefined ? { owner: listing.owner } : {}),
    coauthors: [],
    taggedUsers: [],
    media: {
      ...(listing.displayUrl !== undefined ? { displayUrl: listing.displayUrl } : {}),
    },
    sponsorUsers: [],
    detailStatus: "LISTING_ONLY",
    ...(error !== undefined ? { detailError: error } : {}),
    discoveredFrom: item.from,
    listingFallbackFields: [],
    sourceUrl: mediaUrl(listing.code, listing.mediaProductType),
  };
}

export class PublicWebProvider implements InstagramProvider {
  readonly sourceId = "public:web:v1";

  private readonly chromePath: string | undefined;
  private readonly userAgent: string | undefined;
  private readonly timeoutMs: number;
  private readonly virtualTimeBudgetMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxPosts: number;
  private readonly enrichBudgetMs: number;
  private readonly now: () => Date;
  private readonly fetchHtml: ((url: string) => Promise<string>) | undefined;
  private readonly pageCache = new Map<string, { fetchedAt: number; html: string }>();

  constructor(config: PublicWebProviderConfig = {}) {
    this.fetchHtml = config.fetchHtml;
    this.chromePath = config.chromePath;
    this.userAgent = config.userAgent;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.virtualTimeBudgetMs = config.virtualTimeBudgetMs ?? 6_000;
    this.cacheTtlMs = config.cacheTtlMs ?? 120_000;
    this.maxPosts = config.maxPosts ?? 60;
    this.enrichBudgetMs = config.enrichBudgetMs ?? 120_000;
    this.now = config.now ?? (() => new Date());
    if (this.fetchHtml === undefined && findChrome(this.chromePath) === undefined) {
      throw new Error(`igtrack public provider: ${chromeUnavailableMessage()}`);
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      [CapabilityName.RESOLVE_ACCOUNT]: true,
      [CapabilityName.GET_PROFILE]: true,
      [CapabilityName.GET_STORIES]: false,
      [CapabilityName.GET_FOLLOWERS]: false,
      [CapabilityName.GET_FOLLOWING]: false,
      [CapabilityName.GET_PUBLIC_POSTS]: true,
      [CapabilityName.GET_PUBLIC_COMMENTS]: false,
      [CapabilityName.GET_POST_CHILDREN]: false,
      [CapabilityName.GET_TAGS]: false,
      [CapabilityName.GET_MENTIONED_COMMENT]: false,
      [CapabilityName.GET_ACCOUNT_INSIGHTS]: false,
      // Discovery is a Graph API route. This provider already reads any public
      // account directly; claiming discovery would make the worker label public
      // pages as `business_discovery`.
      [CapabilityName.DISCOVER_ACCOUNT]: false,
    };
  }

  private meta(reference?: string): { observedAt: string; source: SourceRef } {
    return {
      observedAt: this.now().toISOString(),
      source: {
        sourceId: this.sourceId,
        kind: SourceKind.PUBLIC_WEB,
        ...(reference !== undefined ? { reference } : {}),
      },
    };
  }

  private async page(url: string, virtualTimeBudgetMs: number): Promise<string> {
    const cached = this.pageCache.get(url);
    if (cached !== undefined && this.now().getTime() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.html;
    }
    let html: string;
    try {
      html =
        this.fetchHtml !== undefined
          ? await this.fetchHtml(url)
          : await dumpDom(url, {
              executablePath: this.chromePath,
              userAgent: this.userAgent,
              timeoutMs: this.timeoutMs,
              virtualTimeBudgetMs,
            } satisfies ChromeRunOptions);
    } catch (err) {
      if (err instanceof Error && /Chrome could not load the page: .*budget/i.test(err.message)) {
        throw new PublicPageFailure(CapabilityErrorKind.TIMEOUT, err.message, true);
      }
      throw new PublicPageFailure(
        CapabilityErrorKind.NETWORK,
        err instanceof Error ? err.message : "public page transport failure",
        true,
      );
    }
    this.pageCache.set(url, { fetchedAt: this.now().getTime(), html });
    if (this.pageCache.size > 40) {
      const oldest = [...this.pageCache.entries()].sort(
        (a, b) => a[1].fetchedAt - b[1].fetchedAt,
      )[0];
      if (oldest !== undefined) this.pageCache.delete(oldest[0]);
    }
    return html;
  }

  private async fetchProfile(username: string): Promise<ProfileFetch> {
    const url = profileUrl(username);
    const html = await this.page(url, this.virtualTimeBudgetMs);
    const parsed = parseProfilePage(html, username);
    if (parsed.profile === undefined) {
      if (parsed.notFound) {
        throw new PublicPageFailure(
          CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          `Instagram's logged-out page says @${username} is not available (nonexistent, removed, or not public).`,
          false,
        );
      }
      if (parsed.gated) {
        throw new PublicPageFailure(
          CapabilityErrorKind.AUTH_REQUIRED,
          "Instagram served a login/challenge page instead of the public profile. The logged-out provider does not authenticate or bypass a challenge.",
          false,
        );
      }
      throw new PublicPageFailure(
        CapabilityErrorKind.SCHEMA_MISMATCH,
        "The rendered page did not contain the server-rendered profile object. Nothing was inferred from the page chrome.",
        true,
      );
    }
    return {
      url,
      html,
      parsed,
      observedAt: this.now().toISOString(),
    };
  }

  /**
   * Merge the two logged-out listings: the profile's timeline connection and
   * the dedicated reels tab. Neither is assumed to be the whole account; the
   * dossier states which listings answered and whether each declared an end.
   */
  private async collectListings(username: string): Promise<CollectedListings> {
    const profile = await this.fetchProfile(username);
    const byCode = new Map<string, DiscoveredItem>();
    const add = (
      listing: PublicListingPost | undefined,
      from: "profile_timeline" | "reels_tab",
    ): void => {
      if (listing === undefined) return;
      const existing = byCode.get(listing.code);
      if (existing === undefined) {
        byCode.set(listing.code, { code: listing.code, listing, from: [from] });
      } else {
        if (!existing.from.includes(from)) existing.from.push(from);
        existing.listing = { ...existing.listing, ...listing };
      }
    };
    for (const listing of profile.parsed.timeline) add(listing, "profile_timeline");

    let reelsComplete: boolean | undefined;
    let reelsError: string | undefined;
    try {
      const html = await this.page(reelsUrl(username), this.virtualTimeBudgetMs);
      for (const listing of parseReelsPage(html)) add(listing, "reels_tab");
      reelsComplete = reelsPageComplete(html);
    } catch (err) {
      reelsError = err instanceof Error ? err.message : String(err);
    }

    const profileNode = profile.parsed.profile;
    const profileRaw = profile.parsed.rawProfile;
    if (profileNode === undefined || profileRaw === undefined) {
      throw new PublicPageFailure(
        CapabilityErrorKind.SCHEMA_MISMATCH,
        "The profile page was parsed without a profile node.",
        true,
      );
    }
    return {
      items: [...byCode.values()],
      ...(profile.parsed.timelineComplete !== undefined
        ? { profileTimelineComplete: profile.parsed.timelineComplete }
        : {}),
      ...(reelsComplete !== undefined ? { reelsComplete } : {}),
      ...(reelsError !== undefined ? { reelsError } : {}),
      profile: profileNode,
      profileRaw,
      profileMeta: profile.parsed.meta,
    };
  }

  private async fetchPost(
    item: DiscoveredItem,
  ): Promise<{ item: DiscoveredItem; parsed?: ParsedPostPage; error?: string; url: string }> {
    const url = mediaUrl(item.code, item.listing.mediaProductType);
    try {
      const html = await this.page(url, Math.min(this.virtualTimeBudgetMs, 4_000));
      const parsed = parsePostPage(html, item.code);
      if (parsed.media === undefined) {
        return {
          item,
          url,
          error: parsed.notFound
            ? "the media page says this item is not available"
            : parsed.gated
              ? "the media page was replaced by a login/challenge wall"
              : "the rendered media page did not contain the media object",
        };
      }
      return { item, parsed, url };
    } catch (err) {
      return {
        item,
        url,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Local identity predicate. Any syntactically possible Instagram handle is
   * observable through a public page, so this provider is not bounded to one
   * account the way a fixture set or an export is. It still refuses strings
   * that cannot be usernames, before any URL is built.
   */
  async observesAccount(username: string): Promise<boolean> {
    return IG_USERNAME_PATTERN.test(cleanUsername(username));
  }

  async resolveAccount(username: string): Promise<CapabilityResult<NormalizedAccountRef>> {
    const target = cleanUsername(username);
    const meta = this.meta(target);
    if (!IG_USERNAME_PATTERN.test(target)) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `"${username.trim()}" is not a possible Instagram username (letters, digits, periods, underscores; at most 30 characters) — no page was requested.`,
        retryable: false,
      });
    }
    try {
      const profile = (await this.fetchProfile(target)).parsed.profile;
      if (profile === undefined) {
        return errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: "The profile page produced no profile node.",
          retryable: true,
        });
      }
      return available(accountRef(profile), {
        ...meta,
        confidence: Confidence.HIGH,
        rawReference: profileUrl(target),
      });
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getProfile(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedProfile>> {
    const target = cleanUsername(account.username);
    const meta = this.meta(target);
    try {
      const fetch = await this.fetchProfile(target);
      const profile = fetch.parsed.profile;
      if (profile === undefined) {
        return errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: "The profile page produced no profile node.",
          retryable: true,
        });
      }
      const missing = profileCompleteness(profile);
      const externalUrl = firstExternalLink(profile);
      const normalized: NormalizedProfile = {
        account: accountRef(profile),
        ...(profile.biography !== undefined ? { bio: profile.biography } : {}),
        ...(externalUrl !== undefined ? { externalUrl } : {}),
        ...(profile.profilePicUrl !== undefined
          ? { profilePicUrl: profile.profilePicUrl }
          : {}),
        ...(profile.followerCount !== undefined
          ? { followerCount: profile.followerCount }
          : {}),
        ...(profile.followingCount !== undefined
          ? { followingCount: profile.followingCount }
          : {}),
        ...(profile.postCount !== undefined ? { postCount: profile.postCount } : {}),
        ...(profile.isVerified !== undefined ? { isVerified: profile.isVerified } : {}),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: fetch.observedAt,
        },
      };
      const resultMeta = {
        ...meta,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(fetch.html),
        rawReference: fetch.url,
      };
      if (missing.length === 0) {
        return available(normalized, resultMeta);
      }
      return partial(normalized, {
        ...resultMeta,
        note:
          `The logged-out profile page did not expose: ${missing.join(", ")}. ` +
          (profile.isPrivate === true
            ? "The account is private, so Instagram withholds parts of its public profile."
            : "Those fields stay absent; none is zero-filled."),
      });
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getPublicPosts(
    account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>> {
    const target = cleanUsername(account.username);
    const meta = this.meta(target);
    try {
      const listings = await this.collectListings(target);
      const declared = listings.profile.postCount;
      const capped = listings.items.slice(0, this.maxPosts);
      const posts: NormalizedPost[] = [];
      const failures: string[] = [];
      let foreign = 0;
      let unverified = 0;
      let listingOnly = 0;
      // A sequential media-page read takes seconds per item; without a bound,
      // a 40-post account outlives the worker's per-call timeout and every row
      // read so far is lost with the aborted call. Past the deadline the
      // remaining items are recorded from the listing itself.
      const enrichDeadline = Date.now() + this.enrichBudgetMs;
      for (const item of capped) {
        const detail = Date.now() < enrichDeadline ? await this.fetchPost(item) : undefined;
        const ownership = mediaOwnership(target, detail?.parsed?.media, item.listing);
        if (ownership !== "OWN") {
          if (ownership === "FOREIGN") foreign += 1;
          else unverified += 1;
          continue;
        }
        const normalized =
          detail?.parsed?.media !== undefined
            ? postFromMedia(
                detail.parsed.media,
                detail.parsed.meta,
                this.now().toISOString(),
              )
            : postFromListing(
                item.listing,
                this.now().toISOString(),
                detail?.parsed?.meta.url ?? undefined,
              );
        if (normalized !== undefined) {
          posts.push(normalized);
          if (detail === undefined) listingOnly += 1;
        } else if (detail?.error !== undefined) {
          failures.push(`${item.code}: ${detail.error}`);
        } else {
          failures.push(
            `${item.code}: the provider did not expose a media id and publication time`,
          );
        }
      }
      const observedAt = this.now().toISOString();
      const resultMeta = {
        observedAt,
        source: meta.source,
        confidence: Confidence.HIGH,
        rawReference: `${this.sourceId}/${target}/posts`,
      };
      const reasons: string[] = [];
      if (listings.profileTimelineComplete !== true && listings.reelsComplete !== true) {
        reasons.push(
          "Neither the profile timeline nor the reels tab declared the listing complete",
        );
      }
      if (foreign > 0) {
        reasons.push(
          `${foreign} listing item(s) were media owned by other accounts and are not recorded as this account's posts`,
        );
      }
      if (unverified > 0) {
        reasons.push(
          `${unverified} listing item(s) exposed no owner on either the listing or the media page, so ownership could not be established and they are not recorded as this account's posts`,
        );
      }
      if (listings.reelsError !== undefined) {
        reasons.push(`the reels tab could not be read (${listings.reelsError})`);
      }
      if (declared !== undefined && posts.length < declared) {
        reasons.push(
          `${posts.length} of ${declared} declared post(s) were readable from logged-out pages`,
        );
      }
      if (listings.items.length > this.maxPosts) {
        reasons.push(`the ${this.maxPosts}-post safety bound truncated the listing`);
      }
      if (failures.length > 0) {
        reasons.push(`${failures.length} media page(s) failed to enrich`);
      }
      if (listingOnly > 0) {
        reasons.push(
          `${listingOnly} post(s) were recorded from the profile listing alone (caption and counts) because the ${Math.round(this.enrichBudgetMs / 1000)}s enrichment budget ended before their media pages were read`,
        );
      }
      if (reasons.length > 0) {
        return {
          status: CapabilityStatus.PARTIAL,
          data: posts,
          ...resultMeta,
          confidence: Confidence.MEDIUM,
          note: reasons.join("; ") + ".",
        };
      }
      return available(posts, resultMeta);
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getPublicComments(
    _post: NormalizedPost,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>> {
    return unavailable(
      this.meta(),
      "Instagram's logged-out media page exposes the comment COUNT but not the comment list. The provider does not authenticate, so comments are UNAVAILABLE rather than an empty list.",
    );
  }

  /**
   * One media item resolved from its own permalink. This is the post-link
   * input accepted beside a profile: the page is the
   * same one the profile path enriches each item from, and it is read directly
   * so a post can be inspected without first reading its owner's profile.
   */
  async getPublicPost(reference: PostReference): Promise<CapabilityResult<PublicSinglePost>> {
    const target = `${reference.kind}/${reference.shortcode}`;
    const meta = this.meta(target);
    const url = `https://www.instagram.com/${reference.kind}/${encodeURIComponent(reference.shortcode)}/`;
    try {
      const html = await this.page(url, Math.min(this.virtualTimeBudgetMs, 4_000));
      const parsed = parsePostPage(html, reference.shortcode);
      if (parsed.media === undefined) {
        return errored(meta, {
          kind: parsed.notFound
            ? CapabilityErrorKind.SOURCE_NOT_FOUND
            : parsed.gated
              ? CapabilityErrorKind.AUTH_REQUIRED
              : CapabilityErrorKind.SCHEMA_MISMATCH,
          message: parsed.notFound
            ? `Instagram's logged-out page says the post ${reference.shortcode} is not available (nonexistent, removed, private, or not public). Nothing was inferred.`
            : parsed.gated
              ? "Instagram served a login/challenge page instead of the public media page. The logged-out provider does not authenticate or bypass a challenge."
              : "The rendered media page did not contain the media object. Nothing was inferred from the page chrome.",
          retryable: !parsed.notFound && !parsed.gated,
        });
      }
      const observedAt = this.now().toISOString();
      const post = dossierPostFromMedia(
        parsed.media,
        parsed,
        observedAt,
        url,
        [],
        undefined,
      );
      const commentsDisabled = parsed.media.commentsDisabled === true;
      const single: PublicSinglePost = {
        requestedAt: meta.observedAt,
        observedAt,
        shortcode: reference.shortcode,
        kind: reference.kind,
        source: {
          sourceId: this.sourceId,
          kind: SourceKind.PUBLIC_WEB,
          postUrl: url,
          retrieval: this.fetchHtml === undefined ? "headless-chrome" : "injected-transport",
        },
        post,
        comments: {
          status: "UNAVAILABLE",
          reason:
            "Instagram's logged-out media page exposes the comment COUNT but not the comment list. " +
            "The count above is observed; the rows behind it are unobservable without a session, so none is invented.",
        },
        notes: [
          commentsDisabled
            ? "The media page marks comments as disabled; any stored comment count is what the page published, not an invitation to expect rows."
            : "The comment count is what the media page published. The comment list itself is UNAVAILABLE from a logged-out page.",
          "Read directly from the post's permalink, not derived from a profile listing.",
        ],
      };
      return available(single, {
        observedAt,
        source: meta.source,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(html),
        rawReference: url,
      });
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getPostChildren(
    _post: NormalizedPost,
  ): Promise<CapabilityResult<NormalizedPostChild[]>> {
    return unavailable(
      this.meta(),
      "Carousel child items are not exposed by the logged-out media page. The provider does not reconstruct them from the parent; children remain UNAVAILABLE.",
    );
  }

  async getStories(
    _account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedStory[]>> {
    return unavailable(
      this.meta(),
      "The story tray and its items require a logged-in session. The logged-out page exposes no active-story object, so stories are UNAVAILABLE.",
    );
  }

  async getFollowers(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return unavailable(
      this.meta(),
      "The follower list is not exposed to a logged-out browser. The profile publishes only the follower COUNT; no roster is requested, scraped or inferred.",
    );
  }

  async getFollowing(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return unavailable(
      this.meta(),
      "The following list is not exposed to a logged-out browser. The profile publishes only the following COUNT; no roster is requested, scraped or inferred.",
    );
  }

  async getTags(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedTagPage>> {
    return unavailable(
      this.meta(),
      "Instagram's /tagged/ listing is login-gated for logged-out visitors. Tagged-media rows are UNAVAILABLE; the provider does not infer them from captions.",
    );
  }

  async getMentionedComment(
    _account: NormalizedAccountRef,
    _commentId: string,
  ): Promise<CapabilityResult<NormalizedMentionedComment>> {
    return unavailable(
      this.meta(),
      "A mentioned comment is a webhook-keyed, authenticated Graph API read. The public-web provider has no such route.",
    );
  }

  async getAccountInsights(
    _account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedInsightSet>> {
    return unavailable(
      this.meta(),
      "Account insights are owner-authorized metrics. The logged-out public page exposes no insights edge, so no metric is recorded or zero-filled.",
    );
  }

  async discoverAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedDiscoveredAccount>> {
    const target = cleanUsername(username);
    return unavailable(
      this.meta(target),
      "Business Discovery is a Graph API route, not a public-page route. Select IGTRACK_PROVIDER=graph with IGTRACK_GRAPH_BUSINESS_DISCOVERY=1 for it; the public-web provider observes this account through resolveAccount/getProfile instead.",
    );
  }

  private failure(
    meta: { observedAt: string; source: SourceRef },
    err: unknown,
  ): CapabilityResult<never> {
    if (err instanceof PublicPageFailure) {
      return errored(meta, {
        kind: err.kind,
        message: err.message.slice(0, 500),
        retryable: err.retryable,
      });
    }
    if (err instanceof Error && /Chrome|browser executable/i.test(err.message)) {
      return errored(meta, {
        kind: CapabilityErrorKind.PROVIDER_ERROR,
        message: err.message.slice(0, 500),
        retryable: false,
      });
    }
    const message = err instanceof Error ? err.message : "public-web provider failure";
    return errored(meta, {
      kind: CapabilityErrorKind.INTERNAL,
      message: `public-web provider failure: ${message.slice(0, 300)}`,
      retryable: false,
    });
  }

  /**
   * The full public dossier: every field this provider can actually read,
   * plus the explicit gaps. This is the `igtrack public` payload; the generic
   * provider methods above feed the normal scan pipeline.
   */
  async getDossier(username: string): Promise<PublicWebDossierResult> {
    const target = cleanUsername(username);
    const requestedAt = this.now().toISOString();
    if (!IG_USERNAME_PATTERN.test(target)) {
      return {
        status: CapabilityStatus.ERROR,
        observedAt: requestedAt,
        error: {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: `"${username.trim()}" is not a possible Instagram username (letters, digits, periods, underscores; at most 30 characters) — no page was requested.`,
          retryable: false,
        },
      };
    }
    try {
      const listings = await this.collectListings(target);
      const profile = listings.profile;
      const declared = profile.postCount;
      const items = listings.items.slice(0, this.maxPosts);
      const posts: PublicPostDossier[] = [];
      let enriched = 0;
      let skippedForeign = 0;
      let skippedUnverified = 0;
      const detailErrors: string[] = [];

      const enrichDeadline = Date.now() + this.enrichBudgetMs;
      for (const item of items) {
        const detail = Date.now() < enrichDeadline ? await this.fetchPost(item) : undefined;
        const ownership = mediaOwnership(target, detail?.parsed?.media, item.listing);
        if (ownership !== "OWN") {
          if (ownership === "FOREIGN") skippedForeign += 1;
          else skippedUnverified += 1;
          continue;
        }
        if (detail?.parsed?.media !== undefined) {
          posts.push(
            dossierPostFromMedia(
              detail.parsed.media,
              detail.parsed,
              this.now().toISOString(),
              detail.url,
              item.from,
              item.listing,
            ),
          );
          enriched += 1;
        } else {
          const reason =
            detail?.error ??
            (detail === undefined
              ? `the ${Math.round(this.enrichBudgetMs / 1000)}s enrichment budget ended before this media page was read`
              : undefined);
          if (reason !== undefined) {
            detailErrors.push(`${item.code}: ${reason}`);
          }
          posts.push(
            dossierPostFromListing(item, this.now().toISOString(), reason),
          );
        }
      }

      const observedAt = this.now().toISOString();
      const externalUrl = firstExternalLink(profile);
      const profileDossier: PublicProfileDossier = {
        username: profile.username,
        ...(profile.pk !== undefined ? { pk: profile.pk } : {}),
        ...(profile.igId !== undefined ? { igId: profile.igId } : {}),
        ...(profile.fullName !== undefined ? { fullName: profile.fullName } : {}),
        ...(profile.biography !== undefined ? { biography: profile.biography } : {}),
        biographyMentions: biographyMentionsOf(profile.biography),
        ...(externalUrl !== undefined ? { externalUrl } : {}),
        ...(profile.profilePicUrl !== undefined
          ? { profilePicUrl: profile.profilePicUrl }
          : {}),
        ...(profile.followerCount !== undefined
          ? { followerCount: profile.followerCount }
          : {}),
        ...(profile.followingCount !== undefined
          ? { followingCount: profile.followingCount }
          : {}),
        ...(profile.postCount !== undefined ? { postCount: profile.postCount } : {}),
        ...(profile.postCountSource !== undefined
          ? { postCountSource: profile.postCountSource }
          : {}),
        ...(profile.isPrivate !== undefined ? { isPrivate: profile.isPrivate } : {}),
        ...(profile.isVerified !== undefined ? { isVerified: profile.isVerified } : {}),
        ...(profile.isMemorialized !== undefined
          ? { isMemorialized: profile.isMemorialized }
          : {}),
        ...(profile.isUnpublished !== undefined
          ? { isUnpublished: profile.isUnpublished }
          : {}),
        ...(profile.hasAnyClips !== undefined ? { hasAnyClips: profile.hasAnyClips } : {}),
        pronouns: profile.pronouns,
        bioLinks: profile.bioLinks,
        highlights: profile.highlights,
        ...(listings.profileTimelineComplete !== undefined
          ? { timelineComplete: listings.profileTimelineComplete }
          : {}),
        observedAt,
        ...(listings.profileRaw !== undefined
          ? { raw: sanitizeRawNode(listings.profileRaw) }
          : {}),
      };

      const coverage: PublicCoverageRow[] = [
        {
          subject: "Profile",
          status: profileCompleteness(profile).length === 0 ? "OBSERVED" : "PARTIAL",
          ...(profileCompleteness(profile).length === 0
            ? { value: `@${profile.username}` }
            : { reason: `missing: ${profileCompleteness(profile).join(", ")}` }),
        },
        {
          subject: "Biography and links",
          status:
            profile.biography !== undefined || profile.bioLinks.length > 0
              ? "OBSERVED"
              : "PARTIAL",
          value: `${profile.bioLinks.length} link(s)`,
          ...(profile.biography === undefined && profile.bioLinks.length === 0
            ? { reason: "the page exposed no biography and no bio links" }
            : {}),
        },
        {
          subject: "Highlights (strip metadata)",
          status: profile.highlights.length > 0 ? "OBSERVED" : "PARTIAL",
          value: profile.highlights.length,
          ...(profile.highlights.length === 0
            ? { reason: "no highlight cover was exposed on the profile page" }
            : {}),
        },
        {
          subject: "Highlight contents",
          status: "UNAVAILABLE",
          reason:
            "Opening a highlight requires a logged-in session; the profile page exposes only the cover metadata.",
        },
        {
          subject: "Posts",
          status:
            enriched === posts.length && posts.length > 0 && (declared === undefined || posts.length >= declared)
              ? "OBSERVED"
              : posts.length === 0
                ? "UNAVAILABLE"
                : "PARTIAL",
          value: `${posts.length} discovered / ${enriched} enriched${declared !== undefined ? ` / ${declared} declared` : ""}${
            skippedForeign + skippedUnverified > 0
              ? ` / ${skippedForeign + skippedUnverified} not this account's`
              : ""
          }`,
          ...(declared !== undefined && posts.length < declared
            ? {
                reason: `the logged-out listings exposed ${posts.length} of ${declared} declared post(s)`,
              }
            : posts.length === 0
              ? { reason: "neither logged-out listing exposed a media item" }
              : {}),
        },
        {
          subject: "Comment lists",
          status: "UNAVAILABLE",
          reason:
            "The media page exposes the comment count but not the comment list to a logged-out browser.",
        },
        {
          subject: "Likers",
          status: "UNAVAILABLE",
          reason: "Instagram publishes no liker list to a logged-out browser.",
        },
        {
          subject: "Follower / following rosters",
          status: "UNAVAILABLE",
          reason:
            "The public page exposes only counts; the rosters require a logged-in session (or the operator's own export).",
        },
        {
          subject: "Tagged media",
          status: "UNAVAILABLE",
          reason: "The /tagged/ listing is login-gated for logged-out visitors.",
        },
        {
          subject: "Stories",
          status: "UNAVAILABLE",
          reason: "The story tray requires a logged-in session.",
        },
        {
          subject: "Insights",
          status: "UNAVAILABLE",
          reason: "Insights are owner-authorized metrics, not public-page data.",
        },
      ];

      const gaps: PublicGap[] = [];
      if (declared !== undefined && posts.length < declared) {
        gaps.push({
          subject: "the remaining posts",
          reason:
            `The profile declares ${declared} post(s); the logged-out grid and reels tab exposed ${posts.length}. ` +
            "Instagram limits what a logged-out grid returns and does not page it for this provider.",
          howToImprove:
            "A logged-in session would be required to see the rest; this provider deliberately does not authenticate.",
        });
      }
      if (listings.items.length > this.maxPosts) {
        gaps.push({
          subject: "posts beyond the safety bound",
          reason: `${listings.items.length} items were discovered, but the provider reads at most ${this.maxPosts} per run.`,
          howToImprove: `Raise maxPosts in the provider configuration if the account legitimately has more than ${this.maxPosts} public items.`,
        });
      }
      for (const error of detailErrors) {
        gaps.push({
          subject: `media detail (${error.split(":")[0]})`,
          reason: `The media page could not be enriched: ${error}`,
          howToImprove:
            "Re-run later; the grid row that was readable is still included and labelled LISTING_ONLY.",
        });
      }
      if (skippedForeign > 0) {
        gaps.push({
          subject: "media owned by other accounts",
          reason:
            `${skippedForeign} listing item(s) are owned by another account, with no coauthor evidence naming @${target}, ` +
            "so they are not this account's posts and are not listed.",
          howToImprove:
            "Instagram's logged-out timeline interleaves such media; the provider lists only what this account owns or co-authored.",
        });
      }
      if (skippedUnverified > 0) {
        gaps.push({
          subject: "media with an unobservable owner",
          reason:
            `${skippedUnverified} listing item(s) exposed no owner on either the listing or the media page, ` +
            "so ownership could not be established and they are not listed.",
          howToImprove: "Re-run later; an enriched owner would settle each item.",
        });
      }
      if (listings.reelsError !== undefined) {
        gaps.push({
          subject: "the reels tab",
          reason: `The reels tab could not be read: ${listings.reelsError}`,
          howToImprove:
            "The profile timeline still answered; re-run later if the reels tab is needed for play counts.",
        });
      }
      gaps.push(
        {
          subject: "comment lists",
          reason:
            "The provider can read the comment COUNT on each media page, but Instagram does not expose the list of comments to a logged-out browser.",
          howToImprove:
            "The official Graph API exposes comments for the authorized owned account (IGTRACK_PROVIDER=graph).",
        },
        {
          subject: "follower / following rosters",
          reason:
            "Only counts are public; the roster edges require a logged-in session or the operator's own export.",
          howToImprove:
            "Use IGTRACK_PROVIDER=import with the operator's own Instagram export.",
        },
        {
          subject: "highlight contents, tagged media, stories, insights, likers",
          reason:
            "Each is login-gated or owner-authorized; the logged-out page carries no route to it.",
          howToImprove:
            "A logged-in session or the official Graph API (owned account) would be required; this provider does neither.",
        },
      );

      const notes = [
        "This dossier is a logged-out public-page observation: a local headless browser rendered Instagram's public HTML. It is not an official Graph API response.",
        "Publication times come from the media page (`taken_at`); observation times are when this run read the page. The two are never merged.",
        "A missing field stays absent. No count is zero-filled, and no comment list is inferred from a comment count.",
      ];
      if (profile.isPrivate === true) {
        notes.push(
          "The account is private. Instagram exposes only the public profile shell; media and counts may be withheld.",
        );
      }

      const status =
        gaps.length === 0 && enriched === posts.length
          ? CapabilityStatus.AVAILABLE
          : CapabilityStatus.PARTIAL;
      return {
        status,
        observedAt,
        ...(gaps.length > 0
          ? { note: `${gaps.length} explicit gap(s); see coverage and gaps.` }
          : {}),
        dossier: {
          requestedAt,
          observedAt,
          username: profile.username,
          source: {
            sourceId: this.sourceId,
            kind: SourceKind.PUBLIC_WEB,
            profileUrl: profileUrl(profile.username),
            retrieval: this.fetchHtml === undefined ? "headless-chrome" : "injected-transport",
          },
          profile: profileDossier,
          posts,
          counts: {
            ...(declared !== undefined ? { postsDeclared: declared } : {}),
            postsDiscovered: posts.length,
            postsEnriched: enriched,
            postsListingOnly: posts.length - enriched,
            ...(skippedForeign > 0 ? { postsSkippedForeign: skippedForeign } : {}),
            ...(skippedUnverified > 0
              ? { postsSkippedUnverified: skippedUnverified }
              : {}),
          },
          coverage,
          gaps,
          notes,
        },
      };
    } catch (err) {
      if (err instanceof PublicPageFailure) {
        return {
          status: CapabilityStatus.ERROR,
          observedAt: requestedAt,
          error: {
            kind: err.kind,
            message: err.message.slice(0, 500),
            retryable: err.retryable,
          },
        };
      }
      return {
        status: CapabilityStatus.ERROR,
        observedAt: requestedAt,
        error: {
          kind: CapabilityErrorKind.INTERNAL,
          message:
            err instanceof Error
              ? `public-web dossier failure: ${err.message.slice(0, 400)}`
              : "public-web dossier failure",
          retryable: false,
        },
      };
    }
  }
}

// Kept local to avoid a circular import through the SSR module's public API.
function biographyMentionsOf(biography: string | undefined): string[] {
  if (biography === undefined) return [];
  const found = new Set<string>();
  const re = /@([A-Za-z0-9._]{1,30})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(biography)) !== null) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

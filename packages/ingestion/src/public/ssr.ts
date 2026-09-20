import type { MediaType } from "@igtrack/core";

// ---------------------------------------------------------------------------
// Parsers for Instagram's logged-out, server-rendered profile and media pages.
//
// Instagram embeds the page's data as several `<script type="application/json">`
// blobs (Relay preloaders). The helpers below locate the profile node, the
// timeline/clips connections, the highlights strip and one media node by
// shortcode. Everything is read verbatim: a field the page did not carry is
// absent, never invented. The only transformations are unit conversions
// (Unix seconds -> ISO) and explicit type mappings.
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return undefined;
}

/** All JSON blobs on the page, in document order. Unparseable blobs skipped. */
export function extractJsonScripts(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1];
    if (body === undefined || body.trim() === "") continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // One malformed blob must not hide the rest of the page.
    }
  }
  return out;
}

/** Depth-first walk over every object (not arrays themselves). */
export function walkObjects(value: unknown, visit: (object: JsonRecord) => void): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  const record = value as JsonRecord;
  visit(record);
  for (const child of Object.values(record)) walkObjects(child, visit);
}

export function findFirstObject(
  roots: readonly unknown[],
  predicate: (object: JsonRecord) => boolean,
): JsonRecord | undefined {
  for (const root of roots) {
    let found: JsonRecord | undefined;
    walkObjects(root, (object) => {
      if (found === undefined && predicate(object)) found = object;
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Meta tags
// ---------------------------------------------------------------------------

export interface PageMeta {
  title?: string;
  description?: string;
  url?: string;
  image?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

export function parsePageMeta(html: string): PageMeta {
  const read = (property: string): string | undefined => {
    const patterns = [
      new RegExp(
        `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`,
        "i",
      ),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1] !== undefined) return decodeHtmlEntities(match[1]);
    }
    return undefined;
  };
  const out: PageMeta = {};
  const title = read("og:title");
  const description = read("og:description");
  const url = read("og:url");
  const image = read("og:image");
  if (title !== undefined) out.title = title;
  if (description !== undefined) out.description = description;
  if (url !== undefined) out.url = url;
  if (image !== undefined) out.image = image;
  return out;
}

// ---------------------------------------------------------------------------
// Profile page
// ---------------------------------------------------------------------------

export interface PublicBioLink {
  title?: string;
  url: string;
  linkType?: string;
  isPinned?: boolean;
}

export interface PublicHighlight {
  id: string;
  title: string;
  coverUrl?: string;
  ownerUsername?: string;
}

export interface PublicUserReference {
  username: string;
  pk?: string;
  igId?: string;
  fullName?: string;
  isVerified?: boolean;
  profilePicUrl?: string;
}

export interface PublicLocation {
  name: string;
  pk?: string;
  lat?: number;
  lng?: number;
}

export interface PublicTaggedUser {
  user: PublicUserReference;
  x?: number;
  y?: number;
  positionSource: "usertags";
}

export interface PublicMusic {
  kind: "licensed" | "original";
  title?: string;
  artist?: string;
  audioAssetId?: string;
  isExplicit?: boolean;
}

export interface PublicListingPost {
  code: string;
  postId?: string;
  mediaType?: MediaType;
  mediaTypeCode?: number;
  mediaProductType?: string;
  likeCount?: number;
  commentCount?: number;
  playCount?: number;
  displayUrl?: string;
  caption?: string;
  owner?: PublicUserReference;
  takenAt?: string;
}

export interface PublicProfileNode {
  pk?: string;
  igId?: string;
  username: string;
  fullName?: string;
  biography?: string;
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
  timeline: PublicListingPost[];
  timelineComplete?: boolean;
}

export interface ParsedProfilePage {
  meta: PageMeta;
  profile?: PublicProfileNode;
  /** The provider node the normalized profile was read from. */
  rawProfile?: JsonRecord;
  timeline: PublicListingPost[];
  timelineComplete?: boolean;
  highlights: PublicHighlight[];
  /** A login/challenge wall instead of the profile. */
  gated: boolean;
  /** Instagram's explicit "this page isn't available" answer. */
  notFound: boolean;
}

const USERNAME_IN_TEXT = /@([A-Za-z0-9._]{1,30})/g;

export function biographyMentions(biography: string | undefined): string[] {
  if (biography === undefined) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = USERNAME_IN_TEXT.exec(biography)) !== null) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  USERNAME_IN_TEXT.lastIndex = 0;
  return [...found];
}

function countFromToken(token: string): number | undefined {
  const cleaned = token.replace(/[,.\s]/g, "");
  if (!/^[0-9]+$/.test(cleaned)) return undefined;
  return Number(cleaned);
}

interface MetaCounts {
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
}

/** Parse the public og:description count sentence ("1,234 Followers, ..."). */
export function parseMetaCounts(description: string | undefined): MetaCounts {
  if (description === undefined || description === "") return {};
  const patterns = [
    /([\d.,]+)\s+Followers?,\s*([\d.,]+)\s+Following,\s*([\d.,]+)\s+Posts?/i,
    /([\d.,]+)\s+Followers?/i,
  ];
  const match = patterns[0]?.exec(description);
  const out: MetaCounts = {};
  if (match !== null && match !== undefined) {
    const followerCount = match[1] !== undefined ? countFromToken(match[1]) : undefined;
    const followingCount = match[2] !== undefined ? countFromToken(match[2]) : undefined;
    const postCount = match[3] !== undefined ? countFromToken(match[3]) : undefined;
    if (followerCount !== undefined) out.followerCount = followerCount;
    if (followingCount !== undefined) out.followingCount = followingCount;
    if (postCount !== undefined) out.postCount = postCount;
    return out;
  }
  const followers = /([\d.,]+)\s+Followers?/i.exec(description);
  const following = /([\d.,]+)\s+Following/i.exec(description);
  const posts = /([\d.,]+)\s+Posts?/i.exec(description);
  const followerCount = followers?.[1] !== undefined ? countFromToken(followers[1]) : undefined;
  const followingCount = following?.[1] !== undefined ? countFromToken(following[1]) : undefined;
  const postCount = posts?.[1] !== undefined ? countFromToken(posts[1]) : undefined;
  if (followerCount !== undefined) out.followerCount = followerCount;
  if (followingCount !== undefined) out.followingCount = followingCount;
  if (postCount !== undefined) out.postCount = postCount;
  return out;
}

export function mapMediaType(raw: unknown): MediaType {
  if (raw === 1 || raw === "1" || raw === "IMAGE") return "IMAGE";
  if (raw === 2 || raw === "2" || raw === "VIDEO") return "VIDEO";
  if (raw === 8 || raw === "8" || raw === "CAROUSEL_ALBUM" || raw === "CAROUSEL") {
    return "CAROUSEL";
  }
  return "UNKNOWN";
}

function userReference(raw: unknown): PublicUserReference | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const username = asString(record.username);
  if (username === undefined) return undefined;
  const out: PublicUserReference = { username };
  const pk = asString(record.pk);
  const igId = asString(record.id);
  const fullName = asString(record.full_name);
  const isVerified = asBoolean(record.is_verified);
  const profilePicUrl = asString(record.profile_pic_url);
  if (pk !== undefined) out.pk = pk;
  if (igId !== undefined) out.igId = igId;
  if (fullName !== undefined) out.fullName = fullName;
  if (isVerified !== undefined) out.isVerified = isVerified;
  if (profilePicUrl !== undefined) out.profilePicUrl = profilePicUrl;
  return out;
}

function locationFrom(raw: unknown): PublicLocation | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const name = asString(record.name);
  if (name === undefined) return undefined;
  const out: PublicLocation = { name };
  const numericPk = typeof record.pk === "number" ? String(record.pk) : undefined;
  const pk = asString(record.pk);
  const lat = asNumber(record.lat);
  const lng = asNumber(record.lng);
  if (numericPk !== undefined) out.pk = numericPk;
  else if (pk !== undefined) out.pk = pk;
  if (lat !== undefined) out.lat = lat;
  if (lng !== undefined) out.lng = lng;
  return out;
}

function taggedUsersFrom(raw: unknown): PublicTaggedUser[] {
  const record = asRecord(raw);
  if (record === undefined) return [];
  const out: PublicTaggedUser[] = [];
  for (const item of asArray(record.in)) {
    const tag = asRecord(item);
    if (tag === undefined) continue;
    const user = userReference(tag.user);
    if (user === undefined) continue;
    const position = asArray(tag.position);
    const tagged: PublicTaggedUser = { user, positionSource: "usertags" };
    const x = asNumber(position[0]);
    const y = asNumber(position[1]);
    if (x !== undefined) tagged.x = x;
    if (y !== undefined) tagged.y = y;
    out.push(tagged);
  }
  return out;
}

function musicFrom(media: JsonRecord): PublicMusic | undefined {
  const clips = asRecord(media.clips_metadata);
  if (clips === undefined) return undefined;
  const licensed = asRecord(clips.music_info);
  const asset = asRecord(licensed?.music_asset_info);
  if (asset !== undefined) {
    const out: PublicMusic = { kind: "licensed" };
    const title = asString(asset.title);
    const artist = asString(asset.display_artist);
    const audioAssetId = asString(asset.audio_cluster_id);
    const isExplicit = asBoolean(asset.is_explicit);
    if (title !== undefined) out.title = title;
    if (artist !== undefined) out.artist = artist;
    if (audioAssetId !== undefined) out.audioAssetId = audioAssetId;
    if (isExplicit !== undefined) out.isExplicit = isExplicit;
    return out;
  }
  const original = asRecord(clips.original_sound_info);
  if (original !== undefined) {
    const out: PublicMusic = { kind: "original" };
    const title = asString(original.original_audio_title);
    const artist = asString(asRecord(original.ig_artist)?.username);
    const audioAssetId = asString(original.audio_asset_id);
    if (title !== undefined) out.title = title;
    if (artist !== undefined) out.artist = artist;
    if (audioAssetId !== undefined) out.audioAssetId = audioAssetId;
    return out;
  }
  return undefined;
}

function captionFrom(node: JsonRecord): string | undefined {
  const caption = asRecord(node.caption);
  return asString(caption?.text) ?? asString(node.caption);
}

function listingPostFromNode(node: JsonRecord): PublicListingPost | undefined {
  const code = asString(node.code);
  if (code === undefined) return undefined;
  const out: PublicListingPost = { code };
  const postId = asString(node.pk) ?? asString(node.id);
  const mediaTypeCode = asNumber(node.media_type);
  const mediaProductType = asString(node.product_type);
  const likeCount = asCount(node.like_count);
  const commentCount = asCount(node.comment_count);
  const playCount =
    asCount(node.play_count) ??
    asCount(node.video_view_count);
  const displayUrl = asString(node.display_uri);
  const caption = captionFrom(node);
  const owner = userReference(node.user);
  const takenAt =
    asNumber(node.taken_at) !== undefined
      ? new Date(asNumber(node.taken_at)! * 1000).toISOString()
      : asNumber(node.taken_at_timestamp) !== undefined
        ? new Date(asNumber(node.taken_at_timestamp)! * 1000).toISOString()
        : undefined;
  if (postId !== undefined) out.postId = postId;
  if (mediaTypeCode !== undefined) {
    out.mediaType = mapMediaType(mediaTypeCode);
    out.mediaTypeCode = mediaTypeCode;
  }
  if (mediaProductType !== undefined) out.mediaProductType = mediaProductType;
  if (likeCount !== undefined) out.likeCount = likeCount;
  if (commentCount !== undefined) out.commentCount = commentCount;
  if (playCount !== undefined) out.playCount = playCount;
  if (displayUrl !== undefined) out.displayUrl = displayUrl;
  if (caption !== undefined) out.caption = caption;
  if (owner !== undefined) out.owner = owner;
  if (takenAt !== undefined) out.takenAt = takenAt;
  return out;
}

function listingPostsFromConnection(
  connection: JsonRecord | undefined,
): { timeline: PublicListingPost[]; timelineComplete?: boolean } {
  const timeline: PublicListingPost[] = [];
  for (const edge of asArray(connection?.edges)) {
    const node = asRecord(asRecord(edge)?.node);
    if (node === undefined) continue;
    const listing = listingPostFromNode(node);
    if (listing !== undefined) timeline.push(listing);
  }
  const pageInfo = asRecord(connection?.page_info);
  const timelineComplete =
    connection === undefined ? undefined : asBoolean(pageInfo?.has_next_page) === false;
  return {
    timeline,
    ...(timelineComplete !== undefined ? { timelineComplete } : {}),
  };
}

function profileNodeFrom(raw: JsonRecord): PublicProfileNode {
  const highlights: PublicHighlight[] = [];
  const highlightConnection = asRecord(raw.lox_highlights_connection);
  for (const edge of asArray(highlightConnection?.edges)) {
    const node = asRecord(asRecord(edge)?.node);
    if (node === undefined) continue;
    const id = asString(node.id);
    const title = asString(node.title);
    if (id === undefined || title === undefined) continue;
    const highlight: PublicHighlight = { id, title };
    const coverUrl = asString(node.cover_media_cropped_thumbnail_url);
    const ownerUsername = asString(node.owner_username);
    if (coverUrl !== undefined) highlight.coverUrl = coverUrl;
    if (ownerUsername !== undefined) highlight.ownerUsername = ownerUsername;
    highlights.push(highlight);
  }

  const bioLinks: PublicBioLink[] = [];
  for (const item of asArray(raw.bio_links)) {
    const link = asRecord(item);
    if (link === undefined) continue;
    const url = asString(link.url);
    if (url === undefined) continue;
    const bioLink: PublicBioLink = { url };
    const title = asString(link.title);
    const linkType = asString(link.link_type);
    const isPinned = asBoolean(link.is_pinned);
    if (title !== undefined) bioLink.title = title;
    if (linkType !== undefined) bioLink.linkType = linkType;
    if (isPinned !== undefined) bioLink.isPinned = isPinned;
    bioLinks.push(bioLink);
  }

  const pronouns = asArray(raw.pronouns)
    .map((value) => asString(value))
    .filter((value): value is string => value !== undefined);

  const connection = asRecord(raw.polaris_ordered_timeline_connection);
  const timelineExtract = listingPostsFromConnection(connection);
  const timeline = timelineExtract.timeline;
  const timelineComplete = timelineExtract.timelineComplete;

  const allMediaCount = asCount(raw.all_media_count);
  const out: PublicProfileNode = {
    username: asString(raw.username) ?? "",
    pronouns,
    bioLinks,
    highlights,
    timeline,
  };
  const pk = asString(raw.pk);
  const igId = asString(raw.id);
  const fullName = asString(raw.full_name);
  const biography = asString(raw.biography);
  const profilePicUrl = asString(raw.profile_pic_url);
  const followerCount = asCount(raw.follower_count);
  const followingCount = asCount(raw.following_count);
  const isPrivate = asBoolean(raw.is_private);
  const isVerified = asBoolean(raw.is_verified);
  const isMemorialized = asBoolean(raw.is_memorialized);
  const isUnpublished = asBoolean(raw.is_unpublished);
  const hasAnyClips = asBoolean(raw.has_any_clips);
  if (pk !== undefined) out.pk = pk;
  if (igId !== undefined) out.igId = igId;
  if (fullName !== undefined) out.fullName = fullName;
  if (biography !== undefined) out.biography = biography;
  if (profilePicUrl !== undefined) out.profilePicUrl = profilePicUrl;
  if (followerCount !== undefined) out.followerCount = followerCount;
  if (followingCount !== undefined) out.followingCount = followingCount;
  if (allMediaCount !== undefined) {
    out.postCount = allMediaCount;
    out.postCountSource = "all_media_count";
  }
  if (isPrivate !== undefined) out.isPrivate = isPrivate;
  if (isVerified !== undefined) out.isVerified = isVerified;
  if (isMemorialized !== undefined) out.isMemorialized = isMemorialized;
  if (isUnpublished !== undefined) out.isUnpublished = isUnpublished;
  if (hasAnyClips !== undefined) out.hasAnyClips = hasAnyClips;
  if (timelineComplete !== undefined) out.timelineComplete = timelineComplete;
  return out;
}

/**
 * Parse a profile or reels page. The page may carry the profile object more
 * than once (route params, preloaders); the node with the counts/biography is
 * the profile.
 */
export function parseProfilePage(html: string, username: string): ParsedProfilePage {
  const meta = parsePageMeta(html);
  const roots = extractJsonScripts(html);
  const wanted = username.toLowerCase();
  const user = findFirstObject(roots, (object) => {
    if (asString(object.username)?.toLowerCase() !== wanted) return false;
    return (
      asString(object.pk) !== undefined ||
      asCount(object.follower_count) !== undefined ||
      asString(object.biography) !== undefined
    );
  });

  const gated =
    /(?:log in|login|sign up).{0,80}(?:to see|to continue|to view)/i.test(html) ||
    /"require_login":true/i.test(html) ||
    /checkpoint_required/i.test(html);
  const notFound =
    /Sorry, this page isn't available/i.test(html) ||
    /"status":"fail"/i.test(html) ||
    /page not found/i.test(html);

  if (user === undefined) {
    return { meta, timeline: [], highlights: [], gated, notFound };
  }
  const profile = profileNodeFrom(user);
  // Instagram can split the profile node and its timeline into separate
  // preloaders. The timeline is located structurally and only used when the
  // profile node itself did not carry one, so nothing is invented and no
  // edge is dropped just because of relay plumbing.
  if (profile.timeline.length === 0) {
    const timelineOwner = findFirstObject(roots, (object) => {
      const connection = asRecord(object.polaris_ordered_timeline_connection);
      return connection !== undefined && asArray(connection.edges).length > 0;
    });
    const connection = asRecord(timelineOwner?.polaris_ordered_timeline_connection);
    if (connection !== undefined) {
      const extracted = listingPostsFromConnection(connection);
      profile.timeline = extracted.timeline;
      if (extracted.timelineComplete !== undefined) {
        profile.timelineComplete = extracted.timelineComplete;
      }
    }
  }
  const metaCounts = parseMetaCounts(meta.description);
  if (profile.postCount === undefined && metaCounts.postCount !== undefined) {
    profile.postCount = metaCounts.postCount;
    profile.postCountSource = "og_description";
  }
  return {
    meta,
    profile,
    rawProfile: user,
    timeline: profile.timeline,
    ...(profile.timelineComplete !== undefined
      ? { timelineComplete: profile.timelineComplete }
      : {}),
    highlights: profile.highlights,
    gated,
    notFound,
  };
}

/** Parse the reels tab. The connection is nested under a different preloader
 * than the profile page, so it is located structurally. */
export function parseReelsPage(html: string): PublicListingPost[] {
  const roots = extractJsonScripts(html);
  const connection = findFirstObject(roots, (object) => {
    const candidate = asRecord(object.polaris_clips_connection);
    return candidate !== undefined && Array.isArray(candidate.edges);
  });
  if (connection === undefined) return [];
  const clips = asRecord(connection.polaris_clips_connection);
  const out: PublicListingPost[] = [];
  for (const edge of asArray(clips?.edges)) {
    const node = asRecord(asRecord(edge)?.node);
    if (node === undefined) continue;
    const listing = listingPostFromNode(node);
    if (listing !== undefined) out.push(listing);
  }
  return out;
}

/** True when the reels tab explicitly declares the listing complete. */
export function reelsPageComplete(html: string): boolean | undefined {
  const roots = extractJsonScripts(html);
  const connection = findFirstObject(roots, (object) => {
    const candidate = asRecord(object.polaris_clips_connection);
    return candidate !== undefined && Array.isArray(candidate.edges);
  });
  const pageInfo = asRecord(asRecord(connection?.polaris_clips_connection)?.page_info);
  return asBoolean(pageInfo?.has_next_page) === false ? true : undefined;
}

// ---------------------------------------------------------------------------
// Post page
// ---------------------------------------------------------------------------

export interface PublicPostNode {
  code: string;
  postId?: string;
  canonicalUrl?: string;
  takenAt?: string;
  caption?: string;
  captionEdited?: boolean;
  likeCount?: number;
  commentCount?: number;
  playCount?: number;
  mediaType?: MediaType;
  mediaTypeCode?: number;
  mediaProductType?: string;
  owner?: PublicUserReference;
  coauthors: PublicUserReference[];
  location?: PublicLocation;
  taggedUsers: PublicTaggedUser[];
  music?: PublicMusic;
  displayUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  accessibilityCaption?: string;
  commentsDisabled?: boolean;
  likeAndViewCountsDisabled?: boolean;
  isPaidPartnership?: boolean;
  sponsorUsers: PublicUserReference[];
  aiLabel?: string;
}

export interface ParsedPostPage {
  meta: PageMeta;
  media?: PublicPostNode;
  /** The provider node the normalized media was read from. */
  rawMedia?: JsonRecord;
  gated: boolean;
  notFound: boolean;
}

function firstCandidateUrl(raw: unknown): string | undefined {
  const record = asRecord(raw);
  return asString(asRecord(asArray(record?.candidates)[0])?.url);
}

function aiLabelFrom(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const direct = asString(record.label) ?? asString(record.ai_label);
  if (direct !== undefined) return direct;
  const messages = asArray(record.messages)
    .map((message) => asString(asRecord(message)?.text))
    .filter((value): value is string => value !== undefined);
  return messages.length > 0 ? messages.join(" ") : undefined;
}

export function postNodeFrom(raw: JsonRecord): PublicPostNode | undefined {
  const code = asString(raw.code);
  if (code === undefined) return undefined;
  const coauthors = asArray(raw.coauthor_producers)
    .map(userReference)
    .filter((value): value is PublicUserReference => value !== undefined);
  const sponsorUsers = asArray(raw.sponsor_tags)
    .map((tag) => userReference(asRecord(tag)?.user ?? tag))
    .filter((value): value is PublicUserReference => value !== undefined);
  const takenAt =
    asNumber(raw.taken_at) !== undefined
      ? new Date(asNumber(raw.taken_at)! * 1000).toISOString()
      : asNumber(raw.taken_at_timestamp) !== undefined
        ? new Date(asNumber(raw.taken_at_timestamp)! * 1000).toISOString()
        : undefined;
  const out: PublicPostNode = { code, coauthors, taggedUsers: [], sponsorUsers };
  const postId = asString(raw.pk) ?? asString(raw.id);
  const canonicalUrl = asString(raw.seo_canonical_url);
  const caption = captionFrom(raw);
  const captionEdited = asBoolean(raw.caption_is_edited);
  const likeCount = asCount(raw.like_count);
  const commentCount = asCount(raw.comment_count);
  const playCount = asCount(raw.play_count) ?? asCount(raw.video_view_count) ?? asCount(raw.view_count);
  const mediaTypeCode = asNumber(raw.media_type);
  const mediaProductType = asString(raw.product_type);
  const owner = userReference(raw.user);
  const location = locationFrom(raw.location);
  const taggedUsers = taggedUsersFrom(raw.usertags);
  const music = musicFrom(raw);
  const displayUrl = asString(raw.display_uri);
  const thumbnailUrl = firstCandidateUrl(raw.image_versions2);
  const videoUrl = firstCandidateUrl(raw.video_versions);
  const accessibilityCaption = asString(raw.accessibility_caption);
  const commentsDisabled = asBoolean(raw.commenting_disabled_for_viewer);
  const likeAndViewCountsDisabled = asBoolean(raw.like_and_view_counts_disabled);
  const isPaidPartnership = asBoolean(raw.is_paid_partnership);
  const aiLabel = aiLabelFrom(raw.ai_label_info);
  if (postId !== undefined) out.postId = postId;
  if (canonicalUrl !== undefined) out.canonicalUrl = canonicalUrl;
  if (takenAt !== undefined) out.takenAt = takenAt;
  if (caption !== undefined) out.caption = caption;
  if (captionEdited !== undefined) out.captionEdited = captionEdited;
  if (likeCount !== undefined) out.likeCount = likeCount;
  if (commentCount !== undefined) out.commentCount = commentCount;
  if (playCount !== undefined) out.playCount = playCount;
  if (mediaTypeCode !== undefined) {
    out.mediaType = mapMediaType(mediaTypeCode);
    out.mediaTypeCode = mediaTypeCode;
  }
  if (mediaProductType !== undefined) out.mediaProductType = mediaProductType;
  if (owner !== undefined) out.owner = owner;
  if (location !== undefined) out.location = location;
  out.taggedUsers = taggedUsers;
  if (music !== undefined) out.music = music;
  if (displayUrl !== undefined) out.displayUrl = displayUrl;
  if (thumbnailUrl !== undefined) out.thumbnailUrl = thumbnailUrl;
  if (videoUrl !== undefined) out.videoUrl = videoUrl;
  if (accessibilityCaption !== undefined) out.accessibilityCaption = accessibilityCaption;
  if (commentsDisabled !== undefined) out.commentsDisabled = commentsDisabled;
  if (likeAndViewCountsDisabled !== undefined) {
    out.likeAndViewCountsDisabled = likeAndViewCountsDisabled;
  }
  if (isPaidPartnership !== undefined) out.isPaidPartnership = isPaidPartnership;
  if (aiLabel !== undefined) out.aiLabel = aiLabel;
  return out;
}

/** Parse one media page, selecting the node whose shortcode matches. */
export function parsePostPage(html: string, shortcode: string): ParsedPostPage {
  const meta = parsePageMeta(html);
  const roots = extractJsonScripts(html);
  const candidate = findFirstObject(roots, (object) => asString(object.code) === shortcode);
  // The page wraps the media in `{ pk, code, if_not_gated_logged_out: {...} }`.
  // The wrapper carries no counts or publication time; the nested node is the
  // actual media object. A gated wrapper has no usable nested node.
  const unwrapped = asRecord(candidate?.if_not_gated_logged_out) ?? candidate;
  const media =
    unwrapped !== undefined &&
    (asNumber(unwrapped.taken_at) !== undefined ||
      asNumber(unwrapped.taken_at_timestamp) !== undefined ||
      asNumber(unwrapped.like_count) !== undefined ||
      asString(unwrapped.caption) !== undefined ||
      asRecord(unwrapped.caption) !== undefined)
      ? unwrapped
      : undefined;
  const gated =
    /(?:log in|login|sign up).{0,80}(?:to see|to continue|to view)/i.test(html) ||
    /"require_login":true/i.test(html) ||
    /checkpoint_required/i.test(html);
  const notFound =
    /Sorry, this page isn't available/i.test(html) || /page not found/i.test(html);
  const out: ParsedPostPage = { meta, gated, notFound };
  if (media !== undefined) {
    const node = postNodeFrom(media);
    if (node !== undefined) out.media = node;
    out.rawMedia = media;
  } else if (candidate !== undefined) {
    out.rawMedia = candidate;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raw node projection
// ---------------------------------------------------------------------------

const RAW_DROP = /(?:^__|token$|manifest$|cookie|session|tracking|^organic_)/i;

/**
 * A bounded, JSON-safe copy of the provider node for the dossier's raw
 * appendix. Session/tracking tokens, DASH manifests and Relay module plumbing
 * are omitted; everything that describes the account or media is retained.
 */
export function sanitizeRawNode(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeRawNode(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (RAW_DROP.test(key)) continue;
    const sanitized = sanitizeRawNode(child, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

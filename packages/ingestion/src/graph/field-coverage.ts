// Machine-readable field-dropping audit (§15-feed): RAW RESPONSE → PROVIDER
// TYPE → NORMALIZER → DOMAIN MODEL → DATABASE → QUERY → API → UI.
//
// One row per provider field we considered. `requested` must always agree
// with the GRAPH_*_FIELDS constants in graph-provider.ts (pinned by test);
// `documented` cites the Meta IG Platform reference as of v21.0–v26.0.
// Statuses:
//   MAPPED — requested, normalized, persisted, displayed.
//   INTENTIONALLY_IGNORED — exposed but deliberately not stored, with reason.
//   PROVIDER_ABSENT — no documented field/edge exposes it; never inferred.
//   UNVERIFIED — documented with availability caveats; requesting it blind
//     risks failing the whole call, so it stays out until live verification.
//     (An unknown `fields` name fails the entire Graph request — this is why
//     UNVERIFIED is not requested speculatively.)
import {
  GRAPH_CHILD_FIELDS,
  GRAPH_COMMENT_FIELDS,
  GRAPH_MEDIA_FIELDS,
  GRAPH_PROFILE_FIELDS,
  GRAPH_STORY_FIELDS,
} from "./graph-provider.js";

export const FieldCoverageStatus = {
  MAPPED: "MAPPED",
  INTENTIONALLY_IGNORED: "INTENTIONALLY_IGNORED",
  PROVIDER_ABSENT: "PROVIDER_ABSENT",
  UNVERIFIED: "UNVERIFIED",
} as const;

export type FieldCoverageStatus =
  (typeof FieldCoverageStatus)[keyof typeof FieldCoverageStatus];

export type FieldCoverageArea =
  | "profile"
  | "media"
  | "children"
  | "comments"
  | "stories"
  | "rosters"
  | "highlights"
  | "likes"
  | "interactions"
  | "reposts"
  | "media_bytes";

export interface FieldCoverageRow {
  area: FieldCoverageArea;
  /** Provider field/edge name as documented. */
  graphField: string;
  documented: boolean;
  docsRef: string;
  requested: boolean;
  /** Normalized* slot the field maps to (MAPPED only). */
  mappedTo?: string;
  persistedIn?: string[];
  displayedIn?: string[];
  status: FieldCoverageStatus;
  reason: string;
}

export const REQUESTED_FIELDS_BY_AREA: Record<string, string> = {
  profile: GRAPH_PROFILE_FIELDS,
  media: GRAPH_MEDIA_FIELDS,
  children: GRAPH_CHILD_FIELDS,
  comments: GRAPH_COMMENT_FIELDS,
  stories: GRAPH_STORY_FIELDS,
};

const IG_USER = "Meta IG User reference (v21.0–v26.0)";
const IG_MEDIA = "Meta IG Media reference (v21.0–v26.0)";
const IG_COMMENT = "Meta IG Comment reference (v25.0–v26.0)";
const IG_STORIES = "Meta Stories edge reference (2026-08)";
const IG_USER_MEDIA = "Meta IG User Media reference (2026-08)";

export const GRAPH_FIELD_COVERAGE: readonly FieldCoverageRow[] = [
  // ---- profile (GET /{ig-user-id}) ----
  { area: "profile", graphField: "id", documented: true, docsRef: IG_USER, requested: true, mappedTo: "account.igId", persistedIn: ["igAccounts"], displayedIn: ["overview"], status: "MAPPED", reason: "Stable account reference." },
  { area: "profile", graphField: "username", documented: true, docsRef: IG_USER, requested: true, mappedTo: "account.username", persistedIn: ["igAccounts", "profileSnapshots"], displayedIn: ["overview", "lookup"], status: "MAPPED", reason: "Primary identity." },
  { area: "profile", graphField: "name", documented: true, docsRef: IG_USER, requested: true, mappedTo: "account.displayName", persistedIn: ["igAccounts", "profileSnapshots"], displayedIn: ["overview"], status: "MAPPED", reason: "Display name." },
  { area: "profile", graphField: "biography", documented: true, docsRef: IG_USER, requested: true, mappedTo: "bio", persistedIn: ["igAccounts", "profileSnapshots", "profileChanges"], displayedIn: ["overview"], status: "MAPPED", reason: "Bio with change history." },
  { area: "profile", graphField: "profile_picture_url", documented: true, docsRef: IG_USER, requested: true, mappedTo: "profilePicUrl", persistedIn: ["igAccounts", "profileSnapshots"], displayedIn: ["overview"], status: "MAPPED", reason: "Rendered as an outbound reference; never fetched server-side." },
  { area: "profile", graphField: "followers_count", documented: true, docsRef: IG_USER, requested: true, mappedTo: "followerCount", persistedIn: ["profileSnapshots"], displayedIn: ["overview", "cards"], status: "MAPPED", reason: "Count history via snapshots." },
  { area: "profile", graphField: "follows_count", documented: true, docsRef: IG_USER, requested: true, mappedTo: "followingCount", persistedIn: ["profileSnapshots"], displayedIn: ["overview", "cards"], status: "MAPPED", reason: "Count history via snapshots." },
  { area: "profile", graphField: "media_count", documented: true, docsRef: IG_USER, requested: true, mappedTo: "postCount", persistedIn: ["profileSnapshots"], displayedIn: ["overview", "cards"], status: "MAPPED", reason: "Count history via snapshots." },
  { area: "profile", graphField: "website", documented: true, docsRef: IG_USER, requested: true, mappedTo: "externalUrl", persistedIn: ["igAccounts", "profileSnapshots"], displayedIn: ["overview"], status: "MAPPED", reason: "Recovered 2026-09: the only external-link slot the provider exposes. Rendered as a user-initiated outbound link." },
  { area: "profile", graphField: "account_type", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "No such field on the IG User node. NormalizedProfile.accountType and ig_accounts.account_type stay null until a provider exposes it; snapshot/upsert paths forward it when present." },
  { area: "profile", graphField: "is_verified", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "No verification field on the IG User node. Fixture supplies it synthetically; graph leaves it absent." },
  { area: "profile", graphField: "category", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "No category field on the IG User node." },
  { area: "profile", graphField: "profile permalink", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "No profile-URL field; URLs are never reconstructed from usernames." },
  // ---- media (GET /{ig-user-id}/media) ----
  { area: "media", graphField: "id", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "postId", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Post identity." },
  { area: "media", graphField: "caption", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "caption", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Caption (@-stripping caveat documented by provider)." },
  { area: "media", graphField: "timestamp", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "takenAt", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Post time." },
  { area: "media", graphField: "like_count", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "likeCount", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Provider metadata, labeled as such; omitted by provider when the owner hides counts." },
  { area: "media", graphField: "comments_count", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "commentCount", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Includes replies per provider docs." },
  { area: "media", graphField: "permalink", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "permalink", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "Outbound link behind an http(s) guard." },
  { area: "media", graphField: "shortcode", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "shortcode", persistedIn: ["posts", "postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Recovered 2026-09: provider truth preferred over permalink parsing (kept as fallback)." },
  { area: "media", graphField: "media_type", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "mediaType", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "IMAGE/VIDEO/CAROUSEL_ALBUM mapped; unknown tokens stay UNKNOWN." },
  { area: "media", graphField: "media_product_type", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "mediaProductType", persistedIn: ["posts"], displayedIn: ["content tab"], status: "MAPPED", reason: "REELS marks Reel labels. Facebook-Login-only: absent under Instagram Login, handled as untyped." },
  { area: "media", graphField: "owner", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Redundant: the listing only ever returns the owned account's media." },
  { area: "media", graphField: "username", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Redundant for the same reason; creator is always the owned account." },
  { area: "media", graphField: "media_url", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Expiring CDN URL with documented omission semantics (copyright, reel-download settings). No archival policy: metadata-only by decision. Unlock: stable URLs plus documented download permission and expiry semantics." },
  { area: "media", graphField: "thumbnail_url", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Same CDN policy as media_url." },
  { area: "media", graphField: "is_comment_enabled", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "No model slot; per-post commentsState already answers the observable question. Unlock: trivial boolean column." },
  { area: "media", graphField: "is_shared_to_feed", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Reels-only placement flag; the Reel label already comes from media_product_type." },
  { area: "media", graphField: "is_ai_generated", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "No model slot; low monitoring signal. Unlock: trivial." },
  { area: "media", graphField: "media_audio_type", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "No model slot; low monitoring signal. Unlock: trivial." },
  { area: "media", graphField: "alt_text", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Accessibility text; no model slot. Unlock: trivial." },
  { area: "media", graphField: "view_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Reels-only and availability varies; like/comment counts already cover engagement metadata. Unlock: live verification." },
  { area: "media", graphField: "reposts_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "UNVERIFIED", reason: "Documented but top-level-only, owner-gated, and unverified under this integration's credentials; a bad field fails the whole listing. Unlock: live verification, then a nullable column plus first-class reshare relationship." },
  { area: "media", graphField: "shares_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "UNVERIFIED", reason: "Same caveats as reposts_count. Unlock: live verification." },
  { area: "media", graphField: "saved_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "UNVERIFIED", reason: "Same caveats as reposts_count. Unlock: live verification." },
  { area: "media", graphField: "total_like_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "UNVERIFIED", reason: "Aggregated (ads-inclusive) variant; same verification caveats. Unlock: live verification." },
  { area: "media", graphField: "total_comments_count", documented: true, docsRef: IG_MEDIA, requested: false, status: "UNVERIFIED", reason: "Same caveats as total_like_count. Unlock: live verification." },
  { area: "media", graphField: "location", documented: false, docsRef: IG_MEDIA, requested: false, status: "PROVIDER_ABSENT", reason: "No documented location field on IG Media." },
  // ---- children (GET /{ig-media-id}/children, dedicated edge) ----
  { area: "children", graphField: "id", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "childId", persistedIn: ["postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Album item identity, provider order preserved via position." },
  { area: "children", graphField: "media_type", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "mediaType", persistedIn: ["postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Per-child typing." },
  { area: "children", graphField: "permalink", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "permalink", persistedIn: ["postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Documented as unavailable on some album children; absence-tolerant." },
  { area: "children", graphField: "shortcode", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "shortcode", persistedIn: ["postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Recovered 2026-09: provider truth preferred over permalink parsing." },
  { area: "children", graphField: "timestamp", documented: true, docsRef: IG_MEDIA, requested: true, mappedTo: "takenAt", persistedIn: ["postChildren"], displayedIn: ["content tab"], status: "MAPPED", reason: "Per-child timestamp when exposed." },
  { area: "children", graphField: "media_url", documented: true, docsRef: IG_MEDIA, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Same CDN policy as media_url on top-level media." },
  // ---- comments (GET /{ig-media-id}/comments) ----
  { area: "comments", graphField: "id", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "commentId", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Comment identity." },
  { area: "comments", graphField: "text", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "text", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Comment body." },
  { area: "comments", graphField: "username", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "author.username", persistedIn: ["igAccounts", "postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Requires manage-comments permission since 2024-08; absent falls back to 'unknown', never fabricated." },
  { area: "comments", graphField: "timestamp", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "createdAt", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Comment time." },
  { area: "comments", graphField: "parent_id", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "inReplyToCommentId", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Recovered 2026-09: explicit reply threading; renders as reply badges with parent author resolved in one self-join." },
  { area: "comments", graphField: "replies", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "inReplyToCommentId", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Recovered 2026-09: the listing returns top-level comments only, so one-level field expansion flattens replies in the same call (no per-comment edge fan-out)." },
  { area: "comments", graphField: "like_count", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "likeCount", persistedIn: ["postComments"], displayedIn: ["content tab"], status: "MAPPED", reason: "Recovered 2026-09 (migration 0012): provider metadata, omitted when the owner hides counts — never zero-filled." },
  { area: "comments", graphField: "from", documented: true, docsRef: IG_COMMENT, requested: true, mappedTo: "author.igId", persistedIn: ["igAccounts"], displayedIn: ["evidence"], status: "MAPPED", reason: "Recovered 2026-09: author IGSID enrichment under the same permission tier." },
  { area: "comments", graphField: "hidden", documented: true, docsRef: IG_COMMENT, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Moderation state, not public observation; displaying it needs product semantics. Unlock: nullable column plus UI copy." },
  { area: "comments", graphField: "media", documented: true, docsRef: IG_COMMENT, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Redundant: the media id is the scan context." },
  { area: "comments", graphField: "user", documented: true, docsRef: IG_COMMENT, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Legacy id slot; from.id preferred and only returned for own comments anyway." },
  // ---- stories (GET /{ig-user-id}/stories; story IG Media objects) ----
  { area: "stories", graphField: "id", documented: true, docsRef: IG_STORIES, requested: true, mappedTo: "storyId", persistedIn: ["stories", "storySightings"], displayedIn: ["stories tab"], status: "MAPPED", reason: "Story identity with sighting lifetime." },
  { area: "stories", graphField: "timestamp", documented: true, docsRef: IG_STORIES, requested: true, mappedTo: "takenAt", persistedIn: ["stories"], displayedIn: ["stories tab"], status: "MAPPED", reason: "Story time." },
  { area: "stories", graphField: "media_type", documented: true, docsRef: IG_STORIES, requested: true, mappedTo: "mediaType", persistedIn: ["stories"], displayedIn: ["stories tab"], status: "MAPPED", reason: "IMAGE/VIDEO/UNKNOWN." },
  { area: "stories", graphField: "caption", documented: true, docsRef: IG_STORIES, requested: true, mappedTo: "caption", persistedIn: ["stories"], displayedIn: ["stories tab"], status: "MAPPED", reason: "Recovered 2026-09: at most one caption per story per provider docs; absent stays absent." },
  { area: "stories", graphField: "media_url", documented: true, docsRef: IG_STORIES, requested: false, status: "INTENTIONALLY_IGNORED", reason: "Same CDN policy as media_url on feed media, plus 24h expiry. Metadata-only by decision." },
  { area: "stories", graphField: "user_tags (read)", documented: false, docsRef: IG_USER_MEDIA, requested: false, status: "PROVIDER_ABSENT", reason: "user_tags is a publish-time parameter only; no read field exposes story stickers, mentions, polls, questions, locations, music, or links. The fixture path implements the full pipeline synthetically; graph stays degraded." },
  { area: "stories", graphField: "expiry", documented: false, docsRef: IG_STORIES, requested: false, status: "PROVIDER_ABSENT", reason: "No expiry field; the 24h rule is documented behavior and lifetime derives from sightings (first/last seen)." },
  { area: "stories", graphField: "reshared stories", documented: true, docsRef: IG_STORIES, requested: false, status: "PROVIDER_ABSENT", reason: "Documented limitation: stories created by reshare are not returned." },
  // ---- structural absences (no documented edge at all) ----
  { area: "rosters", graphField: "followers/following list edges", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "The exhaustive IG User edge list contains no roster edge. Counts via profile only; the diff engine activates if a lawful list ever appears." },
  { area: "highlights", graphField: "highlights edge", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "The exhaustive IG User edge list contains no highlights edge. The only known alternative is the undocumented private reels_media endpoint, which is forbidden." },
  { area: "likes", graphField: "liker list edge", documented: false, docsRef: IG_MEDIA, requested: false, status: "PROVIDER_ABSENT", reason: "No liker edge on IG Media or IG Comment (the Facebook Comment likes edge is Facebook-only and must not be conflated). like_count metadata is mapped; actors stay unavailable." },
  { area: "interactions", graphField: "interaction feed", documented: false, docsRef: IG_USER, requested: false, status: "PROVIDER_ABSENT", reason: "No lawful interaction feed. The insights edge yields aggregates without actors or per-event timestamps, which cannot satisfy actor+kind+timestamp evidence — considered and rejected." },
  { area: "reposts", graphField: "repost/reshare edge", documented: false, docsRef: IG_MEDIA, requested: false, status: "PROVIDER_ABSENT", reason: "No repost object or reshare edge; only the UNVERIFIED reposts_count scalar exists. Similar content is never classified as a repost without evidence." },
  { area: "media_bytes", graphField: "archivable media source", documented: false, docsRef: IG_MEDIA, requested: false, status: "PROVIDER_ABSENT", reason: "Neither provider yields archivable asset URLs today. media_assets stays writerless by decision; metadata persists on posts/stories and links render as user-initiated outbound links." },
];

// ---------------------------------------------------------------------------
// Phase 17: new-provider-field detection. Compares an observed key list for
// one area against this audit and reports NEW_PROVIDER_FIELD_NOT_MAPPED
// names instead of silently ignoring them.
//
// Two key spaces (the audit rows carry both ends of every MAPPED row):
//   "provider"   — raw provider object keys (graphField, e.g. like_count).
//                  Runs once raw envelopes are echoed to diagnostics.
//   "normalized" — adapter output keys (mappedTo last segment, e.g.
//                  likeCount). Runs today in the verify harness against
//                  probe field names; flags normalizer drift.
// Envelope keys the normalizer adds itself (meta, account) are caller-
// supplied via `ignore`; they are pipeline shape, not provider fields.
// ---------------------------------------------------------------------------

export type CoverageKeySpace = "provider" | "normalized";

/** Live-probed capability → coverage area (shared with the verify harness). */
export const COVERAGE_AREA_BY_CAPABILITY: Record<string, FieldCoverageArea> = {
  resolveAccount: "profile",
  getProfile: "profile",
  getPublicPosts: "media",
  getPostChildren: "children",
  getPublicComments: "comments",
  getStories: "stories",
};

function normalizedKeyOf(mappedTo: string): string {
  const parts = mappedTo.split(".");
  return parts[parts.length - 1] ?? mappedTo;
}

export function coverageKeysForArea(
  area: FieldCoverageArea,
  keySpace: CoverageKeySpace,
): Set<string> {
  const keys = new Set<string>();
  for (const row of GRAPH_FIELD_COVERAGE) {
    if (row.area !== area || row.status !== "MAPPED") continue;
    if (keySpace === "provider") {
      keys.add(row.graphField);
    } else if (row.mappedTo !== undefined) {
      keys.add(normalizedKeyOf(row.mappedTo));
    }
  }
  return keys;
}

export function findUnmappedFields(
  area: FieldCoverageArea,
  observedKeys: readonly string[],
  keySpace: CoverageKeySpace = "provider",
  ignore: readonly string[] = [],
): string[] {
  const known = coverageKeysForArea(area, keySpace);
  const ignored = new Set(ignore);
  return [...new Set(observedKeys)]
    .filter((key) => !known.has(key) && !ignored.has(key))
    .sort();
}

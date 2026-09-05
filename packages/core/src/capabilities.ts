import type { CapabilityName } from "./provider.js";

// ---------------------------------------------------------------------------
// Capability registry (§21-feed): the single machine-readable map from
// product capability → provider contract → persistence → UI, plus the
// educational notes (§32-feed) that explain HOW each capability works, WHY an
// unavailable one is unavailable, and WHAT would unlock it. Diagnostics
// renders this registry with live status; a consistency test pins that every
// referenced provider method exists on InstagramProvider, every referenced
// table exists in the schema, and every provider method appears somewhere
// here (no silent drift in either direction).
// ---------------------------------------------------------------------------

export const RegistryCapabilityId = {
  PROFILE: "PROFILE",
  COUNTS: "COUNTS",
  STORIES: "STORIES",
  STORY_METADATA: "STORY_METADATA",
  STORY_MENTIONS: "STORY_MENTIONS",
  HIGHLIGHTS: "HIGHLIGHTS",
  POSTS: "POSTS",
  REELS: "REELS",
  CAROUSELS: "CAROUSELS",
  COMMENTS: "COMMENTS",
  REPLIES: "REPLIES",
  FOLLOWERS: "FOLLOWERS",
  FOLLOWING: "FOLLOWING",
  LIKES: "LIKES",
  INTERACTIONS: "INTERACTIONS",
  REPOSTS: "REPOSTS",
  MEDIA: "MEDIA",
} as const;

export type RegistryCapabilityId =
  (typeof RegistryCapabilityId)[keyof typeof RegistryCapabilityId];

export interface CapabilityRegistryEntry {
  id: RegistryCapabilityId;
  label: string;
  /** Provider methods that supply this capability. Empty = no method exists. */
  providerMethods: CapabilityName[];
  /** Account/permission the data requires. */
  permissions: string;
  /** Drizzle schema export names that persist it. */
  persistence: string[];
  /** UI surfaces that render it. */
  ui: string[];
  /** Educational: the pipeline in one paragraph. */
  howItWorks: string;
  /** Exact reason when structurally unavailable; null when obtainable. */
  whyUnavailable: string | null;
  /** What would be required if the provider officially exposes it later. */
  unlock: string | null;
  /**
   * Live-verification state against the real provider (2026-09 review):
   * LIVE_VERIFIED (observed via harness), NOT_VERIFIED (implemented on
   * documented fields, awaiting credentials), DOCUMENTED_ABSENT (the
   * exhaustive Meta reference lists no such field/edge — absence by
   * evidence, not assumption).
   */
  liveState: "LIVE_VERIFIED" | "NOT_VERIFIED" | "DOCUMENTED_ABSENT";
  /** Exact live evidence, or why live verification is outstanding. */
  liveEvidence: string;
}

export const CAPABILITY_REGISTRY: readonly CapabilityRegistryEntry[] = [
  {
    id: "PROFILE",
    label: "Public profile",
    providerMethods: ["resolveAccount", "getProfile"],
    permissions: "Public account; graph observes the owned account only.",
    persistence: ["igAccounts", "profileSnapshots", "profileChanges", "evidence"],
    ui: ["/targets/[id] (overview)", "/lookup", "POST /api/targets/lookup"],
    howItWorks:
      "resolveAccount maps a username to a stable account reference; getProfile returns a normalized profile that is appended to profile_snapshots (never overwritten). The adapter requests only documented IG User fields, including website, which maps to externalUrl. Field-level diffs against the previous snapshot become DERIVED profile_changes rows, each backed by an evidence row.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "No credentials in this environment (harness: NOT_VERIFIED/CREDENTIALS_NOT_CONFIGURED). Request shape is docs-pinned: every requested field exists in the Meta IG User reference; account_type, is_verified, and category have no such field and stay absent.",
  },
  {
    id: "COUNTS",
    label: "Follower / following / post counts",
    providerMethods: ["getProfile"],
    permissions: "Same as PROFILE.",
    persistence: ["profileSnapshots"],
    ui: ["/targets/[id] (overview)", "/targets (cards)", "/lookup"],
    howItWorks:
      "Counts ride inside profile snapshots, so every count has a timestamp, a source, and a history. A missing count renders as unavailable, never zero — zero is a real observation of absence, only valid when the provider returns it.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "Same outstanding live check as PROFILE; the follower/following lists themselves are DOCUMENTED_ABSENT (see FOLLOWERS).",
  },
  {
    id: "STORIES",
    label: "Active stories",
    providerMethods: ["getStories"],
    permissions: "Public account stories; graph returns the owned account's tray.",
    persistence: ["stories", "storySightings", "evidence"],
    ui: ["/targets/[id] (stories tab)"],
    howItWorks:
      "Each scan appends new stories and records a sighting row for every story still present, so first-seen, last-seen, and observable duration are derived from evidence, not guessed. Stories expire after ~24h: a story missing from later scans is EXPIRED, never deleted-history.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "No credentials in this environment. Edge and fields are docs-pinned (GET /{ig-user-id}/stories; 24h-only, no live-video, no reshares).",
  },
  {
    id: "STORY_METADATA",
    label: "Story metadata",
    providerMethods: ["getStories"],
    permissions: "Same as STORIES. Graph exposes id, timestamp, media type, and one caption only.",
    persistence: ["stories"],
    ui: ["/targets/[id] (stories tab)", "evidence chain"],
    howItWorks:
      "Caption (at most one per story, per provider docs), expiry, duration, link, stickers, poll, question, location, and music persist when the provider supplies them (fixture) and stay null when it does not (graph). The UI renders persisted fields only — absence is shown as absence.",
    whyUnavailable: null,
    unlock: "Graph story objects would need richer read fields; until then the degraded path is explicit.",
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "No credentials in this environment. user_tags is publish-only (no story-mention read field exists); expiry has no field (lifetime derives from sightings).",
  },
  {
    id: "STORY_MENTIONS",
    label: "Story mentions and tags",
    providerMethods: ["getStories"],
    permissions: "Same as STORIES. Only provider-exposed mentions are stored.",
    persistence: ["storyMentions", "evidence"],
    ui: ["/targets/[id] (stories tab)", "/relationships"],
    howItWorks:
      "Mentions normalize to username, optional platform id, geometry, and a visibility class (VISIBLE, POSSIBLY_HIDDEN, OFF_CANVAS, METADATA_ONLY, UNKNOWN). Geometry describes where the provider placed the sticker; it is never proof of intent to hide, and the UI says so.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "Fixture path implements the full pipeline synthetically. Graph exposes no story-mention read field (DOCUMENTED_ABSENT for the read path), so live graph stories carry no mentions by provider design.",
  },
  {
    id: "HIGHLIGHTS",
    label: "Story highlights",
    providerMethods: [],
    permissions: "Would require an official highlights edge.",
    persistence: [],
    ui: ["/targets/[id] (highlights tab shows UNAVAILABLE with reason)"],
    howItWorks:
      "There is no provider method, table, pipeline, or UI beyond the honest unavailable state — by decision, not oversight.",
    whyUnavailable:
      "The Instagram Graph API exposes no highlights edge (the exhaustive IG User edge list has none; the stories edge returns last-24h stories only). The only known alternative is the undocumented private reels_media endpoint, which this project forbids: no private endpoints, no session use, no access-control circumvention.",
    unlock:
      "An official, documented highlights edge or object. If one appears: add a provider method, normalize to a highlights table, scan on the story cadence, and render from snapshots like stories.",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "Exhaustive Meta IG User edge reference (v21.0–v26.0) lists no highlights edge. No credentials in this environment, but no credential could unlock an edge that does not exist.",
  },
  {
    id: "POSTS",
    label: "Public posts",
    providerMethods: ["getPublicPosts"],
    permissions: "Public account media; graph returns the owned account's media.",
    persistence: ["posts", "evidence"],
    ui: ["/targets/[id] (content tab)"],
    howItWorks:
      "Listings paginate with opaque cursors; the executor persists a checkpoint per page, resumes after crashes, stops on duplicate cursors (PARTIAL, never a loop), and records idempotently. The provider shortcode is preferred with permalink parsing as fallback. A page without a cursor is a complete listing.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "No credentials in this environment. Request shape is docs-pinned (documented IG Media fields only); pagination and cursor behavior are implemented but not yet observed live.",
  },
  {
    id: "REELS",
    label: "Reels as a distinct type",
    providerMethods: ["getPublicPosts"],
    permissions: "Same as POSTS. media_product_type is Facebook-Login-only.",
    persistence: ["posts"],
    ui: ["/targets/[id] (content tab, Reel label)"],
    howItWorks:
      "A post is labeled Reel only when the provider declares media_product_type REELS. Untyped items render as posts — classification is never inferred from appearance, duration, or dimensions.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "Mapping is the strongest correct one (provider-declared product type). Under Instagram Login the field is unavailable and reels render untyped — absence-tolerant by design, not yet observed live.",
  },
  {
    id: "CAROUSELS",
    label: "Carousels and child media",
    providerMethods: ["getPublicPosts", "getPostChildren"],
    permissions: "Same as POSTS. Per-child detail comes from the dedicated children edge.",
    persistence: ["posts", "postChildren"],
    ui: ["/targets/[id] (content tab, Carousel label plus per-child rows)"],
    howItWorks:
      "A post is labeled Carousel only when the provider declares media_type CAROUSEL_ALBUM. The POSTS_SCAN executor then expands provider-declared carousels through the dedicated children edge (isolated per album, so a children failure degrades the scan to partial without endangering the parent post) and persists items in provider order to post_children, rendered as child rows. Fixture v1 ships no child source, so fixture carousels stay childless by fixture design.",
    whyUnavailable: null,
    unlock:
      "Live verification of the children edge under this integration's credentials; the pipeline, tables, and UI are already in place.",
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "Implemented end-to-end and covered by mocked-edge tests, but the live children edge has never been observed (no credentials). The edge itself is a documented public IG Media edge.",
  },
  {
    id: "COMMENTS",
    label: "Public comments",
    providerMethods: ["getPublicComments"],
    permissions: "Comments on observable media.",
    persistence: ["postComments", "evidence"],
    ui: ["/targets/[id] (content tab, per-post threads)"],
    howItWorks:
      "Each post carries a comment state: OBSERVED (source read, even when empty), UNAVAILABLE (no exposed comment source), NOT_SCANNED (capability off). Comment pages paginate like post pages. Comment like counts and author platform ids persist when the provider supplies them; a missing like count renders as absent, never zero. Empty is never faked and never conflated with unavailable.",
    whyUnavailable: null,
    unlock: null,
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "No credentials in this environment. Request shape is docs-pinned (documented IG Comment fields only, max 50 per query per provider docs).",
  },
  {
    id: "REPLIES",
    label: "Comment replies and threading",
    providerMethods: ["getPublicComments"],
    permissions: "Same as COMMENTS.",
    persistence: ["postComments"],
    ui: ["/targets/[id] (content tab, reply badges)"],
    howItWorks:
      "Threading arrives through the documented replies field expansion (the listing edge returns top-level comments only) plus explicit parent_id values, flattened into rows carrying in_reply_to_comment_id. Replies render with the parent author resolved in one self-join. When the provider returns no threading, threads stay flat — flatness is data, not a bug.",
    whyUnavailable: null,
    unlock: "Live verification under this integration's credentials; the pipeline, column, join, and UI are already in place.",
    liveState: "NOT_VERIFIED",
    liveEvidence:
      "Implemented end-to-end and covered by mocked-expansion tests, but live reply payloads have never been observed (no credentials).",
  },
  {
    id: "FOLLOWERS",
    label: "Follower roster and history",
    providerMethods: ["getFollowers"],
    permissions: "Fixture exposes synthetic rosters. Graph exposes counts only, never lists.",
    persistence: ["followSnapshots", "followSnapshotMembers", "followDeltas", "evidence"],
    ui: ["/targets/[id] (followers tab)", "/relationships", "activity timeline"],
    howItWorks:
      "Each scan appends a snapshot (COMPLETE or PARTIAL) with stable member rows. Diffs derive only between two COMPLETE snapshots: a newcomer is 'newly observed', a disappearance 'no longer observed' — never 'followed at 14:03' unless the provider supplies the event. PARTIAL scans are recorded but never diffed, so truncation cannot fabricate losses.",
    whyUnavailable: null,
    unlock: "A supported list endpoint (the Graph API has none by design).",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "The exhaustive Meta IG User edge reference lists no roster edge — counts-only is provider design, not an auth tier away. Fixture rosters exercise the full pipeline synthetically.",
  },
  {
    id: "FOLLOWING",
    label: "Following roster and history",
    providerMethods: ["getFollowing"],
    permissions: "Same as FOLLOWERS.",
    persistence: ["followSnapshots", "followSnapshotMembers", "followDeltas", "evidence"],
    ui: ["/targets/[id] (following tab)", "/relationships", "activity timeline"],
    howItWorks:
      "Identical mechanics to FOLLOWERS, tracked under the FOLLOWING direction with its own snapshots, pagination, checkpoints, and diffs.",
    whyUnavailable: null,
    unlock: "A supported list endpoint (the Graph API has none by design).",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "Same evidence as FOLLOWERS: no roster edge in the exhaustive reference.",
  },
  {
    id: "LIKES",
    label: "Public like data",
    providerMethods: [],
    permissions: "Would require a public likes feed, which does not exist.",
    persistence: [],
    ui: ["Relationships page states UNAVAILABLE with reason; like counts on posts and comments are labeled provider metadata"],
    howItWorks:
      "There is no writer and no reader for like actors: per-post and per-comment like_count is provider-supplied metadata shown as such, never observed like activity.",
    whyUnavailable:
      "Instagram exposes no liker list through any supported interface: no liker edge exists on IG Media or IG Comment (the Facebook Comment likes edge is Facebook-only and must not be conflated). Anything labeled 'likes' beyond post/comment metadata would be fabricated.",
    unlock: "A documented IG liker feed. Until then the correct state is UNAVAILABLE.",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "Meta IG Media and IG Comment references expose like_count only — no actor edge. No credential could unlock an edge that does not exist.",
  },
  {
    id: "INTERACTIONS",
    label: "Interaction history",
    providerMethods: [],
    permissions: "Would require a lawful interaction feed.",
    persistence: ["interactions"],
    ui: [],
    howItWorks:
      "The interactions table exists as a typed landing zone with a documented rationale in schema comments, but has no writer: no supported source provides interaction actors, counts with history, or timestamps. The relationships page derives association signals from mentions and deltas instead, labeled as observed association — never 'favorite people'.",
    whyUnavailable:
      "No supported provider exposes interaction history. LIKE_SIGNAL in the model describes a shape, not a source. The insights edge was considered and rejected: it yields aggregates without actors or per-event timestamps, which cannot satisfy actor+kind+timestamp evidence.",
    unlock:
      "A lawful interaction source. Activation criteria: a provider method returning actor, kind, timestamp, and evidence; then add the writer, ledger branch, and UI.",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "No interaction feed exists in the IG Platform reference (nodes: IG Comment, IG Container, IG Hashtag, IG Media, IG User, Page).",
  },
  {
    id: "REPOSTS",
    label: "Reposts and reshares",
    providerMethods: [],
    permissions: "Would require explicit repost metadata under this integration's credentials.",
    persistence: [],
    ui: [],
    howItWorks:
      "No verified provider surface in this integration returns repost counts, reshare edges, or original-author attribution, so no repost relationship is stored or shown. Similar-looking content is never classified as a repost without evidence.",
    whyUnavailable:
      "reposts_count (with shares_count/saved_count/total_*) is documented on IG Media but top-level-only, owner-gated, and unverified under this integration's credentials — and an unknown fields name fails the entire listing call, so it is not requested speculatively. There is no repost object or reshare edge at all.",
    unlock:
      "Live verification of repost metadata under this integration's credentials (harness scripts/verify-graph-provider.ts); then persist attribution and render reshare relationships.",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "No repost object or reshare edge in the reference; the scalar alone is UNVERIFIED (see field-coverage audit). Deliberately not probed blind: a failed fields name would break the working media call.",
  },
  {
    id: "MEDIA",
    label: "Media bytes and assets",
    providerMethods: [],
    permissions: "Would require archivable provider URLs plus a storage policy.",
    persistence: ["mediaAssets"],
    ui: ["Provider links render as user-initiated outbound links behind an http(s) guard; bytes are never auto-loaded"],
    howItWorks:
      "Metadata (types, shortcodes, permalinks, link URLs) persists on posts and stories. The media_assets table stays writerless by decision: neither provider yields archivable asset URLs today, and storing bytes without settled expiry, permission, and retention answers would be the real integrity violation. Images are never auto-fetched (no third-party IP leak, no SSRF).",
    whyUnavailable:
      "No archivable source: fixture carries no media URLs and graph media URLs are expiring CDN links with documented omission semantics (copyright, reel-download settings) — never stable enough to archive.",
    unlock:
      "Provider-supplied stable URLs plus documented download permission and expiry semantics; then write metadata-first rows and cache bytes behind retention rules.",
    liveState: "DOCUMENTED_ABSENT",
    liveEvidence:
      "The IG Media reference documents media_url omission rules that rule out archival use. Metadata links render as user-initiated outbound links only.",
  },
];

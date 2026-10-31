import {
  CAPABILITY_REGISTRY,
  RegistryCapabilityId,
  type CapabilityRegistryEntry,
} from "./capabilities.js";

// ---------------------------------------------------------------------------
// The six-tab account viewer, composed from IGTrack's lawful public sources.
//
// Tab order and keys are the fixed viewer contract. Labels are neutral: this
// module knows nothing about any commercial product. Every tab carries its
// evidence classes, observed count and — separately — any count the platform
// declared. Tabs without a lawful source are UNAVAILABLE with a registry
// reason, never an empty list. Pure: no clock, no I/O.
// ---------------------------------------------------------------------------

export const VIEWER_TABS = [
  { key: "story", label: "Stories" },
  { key: "post", label: "Posts" },
  { key: "reels", label: "Reels" },
  { key: "highlights", label: "Highlights" },
  { key: "repost", label: "Reposts" },
  { key: "tagged", label: "Tagged" },
] as const;

export type ViewerTabKey = (typeof VIEWER_TABS)[number]["key"];
export type ViewerTabLabel = (typeof VIEWER_TABS)[number]["label"];
export type ViewerTabStatus = "OBSERVED" | "PARTIAL" | "UNAVAILABLE";
export type ViewerTabReasonKind =
  | "STRUCTURAL"
  | "SOURCE_ERROR"
  | "NOT_REQUESTED"
  | "PRIVATE"
  | "PARTIAL";
export type ViewerEvidenceClass = "PUBLIC_WEB" | "PUBLIC_AGGREGATOR";
export type ViewerDownloads = "public" | "anonstories";

export type ViewerInputKind =
  | "username"
  | "profile_url"
  | "post_url"
  | "reel_url"
  | "story_url"
  | "unsupported";

export interface ViewerInputParse {
  raw: string;
  kind: ViewerInputKind;
  username: string | null;
  /** Tab the input selects, before any --tab override. */
  tab: ViewerTabKey;
  postCode?: string;
  postKind?: "p" | "reel" | "tv";
  storyId?: string;
  reason?: string;
}

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const RESERVED_PATHS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "about",
  "developer",
  "legal",
  "instagram-viewer",
]);

function cleanHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function isUsername(value: string): boolean {
  return (
    USERNAME_RE.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..")
  );
}

function unsupported(raw: string, reason: string): ViewerInputParse {
  return { raw, kind: "unsupported", username: null, tab: "story", reason };
}

/**
 * Input grammar: a username, a profile URL, a post/reel URL (the owner is
 * resolved by the caller), a story URL (owner + story id) or a highlight URL.
 * A highlight URL names no account, so it is refused with the exact reason
 * rather than guessed.
 */
export function parseViewerInput(raw: string): ViewerInputParse {
  const value = raw.trim();
  if (value === "") return unsupported(raw, "The input is empty.");

  const isUrl =
    /^https?:\/\//i.test(value) || /^(www\.)?instagram\.com\//i.test(value);
  if (isUrl) {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return unsupported(raw, `"${raw}" is not a valid URL.`);
    }
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) {
      return unsupported(
        raw,
        `"${url.hostname}" is not instagram.com. Enter an Instagram URL or a username.`,
      );
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const [first = "", second = "", third = ""] = segments.map((s) => decodeURIComponent(s));
    if (first === "stories" && second === "highlights" && third !== "") {
      return unsupported(
        raw,
        "A highlight URL carries only the highlight id, not its owner. Enter the account's username (or profile URL) and select the highlights tab.",
      );
    }
    if (first === "stories" && second !== "") {
      return {
        raw,
        kind: "story_url",
        username: isUsername(second) ? second.toLowerCase() : null,
        tab: "story",
        ...(third !== "" ? { storyId: third } : {}),
      };
    }
    if (first === "p" && second !== "") {
      return {
        raw,
        kind: "post_url",
        username: null,
        tab: "post",
        postCode: second,
        postKind: "p",
      };
    }
    if ((first === "reel" || first === "reels" || first === "tv") && second !== "") {
      return {
        raw,
        kind: "reel_url",
        username: null,
        tab: "reels",
        postCode: second,
        postKind: first === "tv" ? "tv" : "reel",
      };
    }
    if (RESERVED_PATHS.has(first.toLowerCase()) || first === "") {
      return unsupported(
        raw,
        `instagram.com/${first} does not name an account. Enter a profile, post, reel or story URL.`,
      );
    }
    if (isUsername(first)) {
      // Instagram's canonical permalinks carry the owner: /<handle>/p/<code>/.
      // The public dossier emits this form, so the viewer must read it back.
      const section = second.toLowerCase();
      if ((section === "p" || section === "reel" || section === "reels" || section === "tv") && third !== "") {
        const postKind = section === "p" ? "p" : section === "tv" ? "tv" : "reel";
        return {
          raw,
          kind: section === "p" ? "post_url" : "reel_url",
          username: first.toLowerCase(),
          tab: section === "p" ? "post" : "reels",
          postCode: third,
          postKind,
        };
      }
      return { raw, kind: "profile_url", username: first.toLowerCase(), tab: "story" };
    }
    return unsupported(raw, `"${first}" is not a valid Instagram username.`);
  }

  const handle = cleanHandle(value);
  if (!isUsername(handle)) {
    return unsupported(
      raw,
      "Enter a username or an instagram.com profile, post, reel or story URL.",
    );
  }
  return { raw, kind: "username", username: handle, tab: "story" };
}

export interface ViewerMentionRef {
  username: string;
  fullName: string | null;
  isPrivate: boolean | null;
  isVerified: boolean | null;
  isReshareAuthor: boolean;
}

export interface ViewerStoryRow {
  id: string;
  publishedAt: string | null;
  age: string | null;
  mediaType: "image" | "video" | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  linkUrl: string | null;
  mentions: ViewerMentionRef[];
  reshareAuthor: ViewerMentionRef | null;
}

export interface ViewerHighlightRow {
  id: string;
  title: string | null;
  coverUrl: string | null;
  contentsStatus: "READ" | "UNAVAILABLE" | "NOT_READ";
  contentsReason: string | null;
  itemCount: number | null;
  droppedItems: number | null;
  items: ViewerStoryRow[];
  sources: string[];
  evidenceClasses: ViewerEvidenceClass[];
}

export interface ViewerPostRow {
  shortcode: string;
  permalink: string | null;
  takenAt: string | null;
  caption: string | null;
  likeCount: number | null;
  commentCount: number | null;
  playCount: number | null;
  mediaType: string | null;
  productType: string | null;
  displayUrl: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  detailStatus: "ENRICHED" | "LISTING_ONLY";
  discoveredFrom: Array<"profile_timeline" | "reels_tab">;
  ownerUsername: string | null;
}

export interface ViewerMentionRow {
  username: string;
  fullName: string | null;
  isPrivate: boolean | null;
  isVerified: boolean | null;
  isReshareAuthor: boolean;
  seenIn: string[];
  itemCount: number;
}

export interface ViewerProfile {
  username: string;
  fullName: string | null;
  biography: string | null;
  profilePicUrl: string | null;
  followerCount: number | null;
  followingCount: number | null;
  declaredPostCount: number | null;
  isPrivate: boolean | null;
  isVerified: boolean | null;
  sources: string[];
}

export interface ViewerCoverageRow {
  subject: string;
  status: "OBSERVED" | "PARTIAL" | "UNAVAILABLE";
  value?: string | number | null;
  reason?: string | null;
}

export interface ViewerGap {
  subject: string;
  reason: string;
  howToImprove: string | null;
}

export interface ViewerPublicSnapshot {
  sourceId: string;
  observedAt: string;
  profileUrl: string;
  profile: {
    username: string;
    fullName: string | null;
    biography: string | null;
    profilePicUrl: string | null;
    followerCount: number | null;
    followingCount: number | null;
    declaredPostCount: number | null;
    isPrivate: boolean | null;
    isVerified: boolean | null;
    highlights: Array<{
      id: string;
      title: string;
      coverUrl: string | null;
      ownerUsername: string | null;
    }>;
  };
  posts: ViewerPostRow[];
  counts: {
    postsDeclared: number | null;
    postsDiscovered: number;
    postsEnriched: number;
    postsListingOnly: number;
  };
  coverage: ViewerCoverageRow[];
  gaps: ViewerGap[];
  notes: string[];
}

export interface ViewerAnonSnapshot {
  sourceId: string;
  observedAt: string;
  account: {
    username: string;
    fullName: string | null;
    profilePicUrl: string | null;
    followerCount: number | null;
    followingCount: number | null;
    declaredPostCount: number | null;
    isPrivate: boolean | null;
    isVerified: boolean | null;
  };
  stories: ViewerStoryRow[];
  highlights: Array<{
    id: string;
    title: string | null;
    coverUrl: string | null;
    contentsStatus: "READ" | "UNAVAILABLE";
    contentsReason: string | null;
    itemCount: number | null;
    droppedItems: number | null;
    items: ViewerStoryRow[];
  }>;
  mentions: ViewerMentionRow[];
  counts: {
    activeStories: number;
    highlights: number;
    highlightContentsRead: number;
    highlightItems: number;
    mentionedAccounts: number;
  };
  coverage: ViewerCoverageRow[];
  gaps: ViewerGap[];
  notes: string[];
}

export interface ViewerSourceFailure {
  kind: string;
  message: string;
  retryable: boolean;
}

interface ViewerTabBase {
  key: ViewerTabKey;
  label: ViewerTabLabel;
  status: ViewerTabStatus;
  requested: boolean;
  /** Rows observed in this report. Null only when the tab is UNAVAILABLE. */
  count: number | null;
  /** The platform's own number, when it stated one. Never a substitute for count. */
  declaredCount: number | null;
  reason: string | null;
  reasonKind: ViewerTabReasonKind | null;
  sources: string[];
  evidenceClasses: ViewerEvidenceClass[];
  observedAt: string | null;
}

export type ViewerTab =
  | (ViewerTabBase & { key: "story"; label: "Stories"; rows: ViewerStoryRow[] })
  | (ViewerTabBase & {
      key: "post" | "reels";
      label: "Posts" | "Reels";
      rows: ViewerPostRow[];
    })
  | (ViewerTabBase & { key: "highlights"; label: "Highlights"; rows: ViewerHighlightRow[] })
  | (ViewerTabBase & { key: "repost" | "tagged"; label: "Reposts" | "Tagged"; rows: [] });

export interface ViewerMentionFocus {
  username: string;
  matched: boolean;
  itemCount: number;
  storyIds: string[];
  highlightItems: Array<{ highlightId: string; itemIds: string[] }>;
  reason: string | null;
}

export interface ViewerPopularity {
  /** Rows from Posts + Reels, deduplicated by shortcode. */
  sampleSize: number;
  likeSampleSize: number;
  commentSampleSize: number;
  likeTotal: number | null;
  commentTotal: number | null;
  likeAverage: number | null;
  commentAverage: number | null;
  reason: string | null;
}

export interface ViewerRefusal {
  capability: RegistryCapabilityId;
  label: string;
  reason: string;
  unlock: string | null;
}

export interface ViewerReport {
  version: 1;
  generatedAt: string;
  input: ViewerInputParse;
  username: string;
  focus: { tab: ViewerTabKey; postCode: string | null; storyId: string | null };
  requestedSources: ViewerDownloads[];
  profile: ViewerProfile;
  tabs: ViewerTab[];
  mentions: { rows: ViewerMentionRow[]; count: number | null; reason: string | null };
  mentionFocus: ViewerMentionFocus | null;
  popularity: ViewerPopularity;
  refusals: ViewerRefusal[];
  downloadPolicy: { mode: "SOURCE_URL_ONLY"; note: string };
  coverage: ViewerCoverageRow[];
  gaps: ViewerGap[];
  notes: string[];
}

export interface ViewerSourceInput {
  public?: ViewerPublicSnapshot;
  anonstories?: ViewerAnonSnapshot;
  failures?: {
    public?: ViewerSourceFailure;
    anonstories?: ViewerSourceFailure;
  };
}

export interface ViewerReportOptions {
  input: ViewerInputParse;
  /** Resolved account the report describes (post URLs resolve their owner first). */
  username: string;
  generatedAt: string;
  requestedSources: ViewerDownloads[];
  mention?: string | undefined;
  additionalNotes?: string[] | undefined;
}

export const VIEWER_DOWNLOAD_POLICY = {
  mode: "SOURCE_URL_ONLY",
  note: "Media rows carry the original source URLs. This report never proxies, re-hosts or re-serves media, and no download is performed.",
} as const;

function registryEntry(id: RegistryCapabilityId): CapabilityRegistryEntry {
  const entry = CAPABILITY_REGISTRY.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    // The registry is a closed, tested set; a missing entry is a programming error.
    throw new Error(`Capability registry entry ${id} is missing.`);
  }
  return entry;
}

function refusal(id: RegistryCapabilityId, reasonOverride?: string): ViewerRefusal {
  const entry = registryEntry(id);
  return {
    capability: id,
    label: entry.label,
    reason: reasonOverride ?? entry.whyUnavailable ?? entry.permissions,
    unlock: entry.unlock,
  };
}

function digits(value: string): string {
  return value.replace(/\D+/g, "") || value;
}

function mergeMention(
  mention: ViewerMentionRef | undefined,
): ViewerMentionRef | null {
  if (mention === undefined) return null;
  return {
    username: mention.username,
    fullName: mention.fullName ?? null,
    isPrivate: mention.isPrivate ?? null,
    isVerified: mention.isVerified ?? null,
    isReshareAuthor: mention.isReshareAuthor === true,
  };
}

export function buildViewerReport(
  sources: ViewerSourceInput,
  options: ViewerReportOptions,
): ViewerReport {
  const pub = sources.public;
  const anon = sources.anonstories;
  const anonSourceId = anon?.sourceId ?? "";
  const publicRequested = options.requestedSources.includes("public");
  const anonRequested = options.requestedSources.includes("anonstories");
  const publicFailure = sources.failures?.public;
  const anonFailure = sources.failures?.anonstories;

  const isPrivate =
    pub?.profile.isPrivate === true || anon?.account.isPrivate === true;

  const storyRows: ViewerStoryRow[] = (anon?.stories ?? []).map((row) => ({
    ...row,
    mentions: row.mentions.map((mention) => mergeMention(mention)).filter(
      (mention): mention is ViewerMentionRef => mention !== null,
    ),
    reshareAuthor: mergeMention(row.reshareAuthor ?? undefined),
  }));

  const mergedHighlights = new Map<string, ViewerHighlightRow & { order: number }>();
  let order = 0;
  for (const highlight of pub?.profile.highlights ?? []) {
    const key = digits(highlight.id);
    mergedHighlights.set(key, {
      id: highlight.id,
      title: highlight.title === "" ? null : highlight.title,
      coverUrl: highlight.coverUrl ?? null,
      contentsStatus: "NOT_READ",
      contentsReason:
        "The logged-out highlights strip lists each highlight's cover and title but does not read its story items; request the public aggregator source (--source both) to read contents.",
      itemCount: null,
      droppedItems: null,
      items: [],
      sources: pub !== undefined ? [pub.sourceId] : [],
      evidenceClasses: ["PUBLIC_WEB"],
      order: order++,
    });
  }
  for (const highlight of anon?.highlights ?? []) {
    const key = digits(highlight.id);
    const items = highlight.items.map((row) => ({
      ...row,
      mentions: row.mentions.map((mention) => mergeMention(mention)).filter(
        (mention): mention is ViewerMentionRef => mention !== null,
      ),
      reshareAuthor: mergeMention(row.reshareAuthor ?? undefined),
    }));
    const existing = mergedHighlights.get(key);
    const sourcesList = [...new Set([...(existing?.sources ?? []), anonSourceId])];
    mergedHighlights.set(key, {
      id: existing?.id ?? highlight.id,
      title: existing?.title ?? highlight.title,
      coverUrl: existing?.coverUrl ?? highlight.coverUrl,
      contentsStatus: highlight.contentsStatus,
      contentsReason: highlight.contentsReason,
      itemCount: highlight.itemCount,
      droppedItems: highlight.droppedItems,
      items,
      sources: sourcesList,
      evidenceClasses: [...new Set<ViewerEvidenceClass>([
        ...(existing?.evidenceClasses ?? []),
        "PUBLIC_AGGREGATOR",
      ])],
      order: existing?.order ?? order++,
    });
  }
  const highlightRows: ViewerHighlightRow[] = [...mergedHighlights.values()]
    .sort((a, b) => a.order - b.order)
    .map((row) => ({
      id: row.id,
      title: row.title,
      coverUrl: row.coverUrl,
      contentsStatus: row.contentsStatus,
      contentsReason: row.contentsReason,
      itemCount: row.itemCount,
      droppedItems: row.droppedItems,
      items: row.items,
      sources: row.sources,
      evidenceClasses: row.evidenceClasses,
    }));

  const posts = (pub?.posts ?? []).filter((post) =>
    post.discoveredFrom.includes("profile_timeline"),
  );
  const reels = (pub?.posts ?? []).filter((post) =>
    post.discoveredFrom.includes("reels_tab"),
  );

  const declaredPosts =
    pub?.counts.postsDeclared ?? pub?.profile.declaredPostCount ?? null;

  const postPartial = [...posts, ...reels].some(
    (row) => row.detailStatus === "LISTING_ONLY",
  );
  const postReason = postPartial
    ? `${[...posts, ...reels].filter((row) => row.detailStatus === "LISTING_ONLY").length} row(s) were read from the listing only; the media page was not read (detailStatus LISTING_ONLY).`
    : null;

  const privateReason =
    "The account is private. Its profile shell is public; its media, stories and highlight contents are not, and no source in this report can read them without authorization.";

  const storyTab: ViewerTab = (() => {
    const base = {
      key: "story" as const,
      label: "Stories" as const,
      requested: anonRequested,
      declaredCount: null,
      observedAt: anon?.observedAt ?? null,
      sources: anon !== undefined ? [anon.sourceId] : [],
      evidenceClasses: anon !== undefined ? (["PUBLIC_AGGREGATOR"] as ViewerEvidenceClass[]) : [],
      rows: storyRows,
    };
    if (isPrivate) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: privateReason,
        reasonKind: "PRIVATE",
        rows: [],
      };
    }
    if (anon !== undefined) {
      return {
        ...base,
        status: "OBSERVED",
        count: storyRows.length,
        reason: null,
        reasonKind: null,
      };
    }
    if (anonRequested && anonFailure !== undefined) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: anonFailure.message,
        reasonKind: "SOURCE_ERROR",
      };
    }
    return {
      ...base,
      status: "UNAVAILABLE",
      count: null,
      reason:
        "Active stories are read from the public aggregator source, which was not requested. Re-run with --source both (or anonstories).",
      reasonKind: "NOT_REQUESTED",
    };
  })();

  const buildPostTab = (
    key: "post" | "reels",
    rows: ViewerPostRow[],
    label: "Posts" | "Reels",
  ): Extract<ViewerTab, { key: "post" | "reels" }> => {
    const base = {
      key,
      label,
      requested: publicRequested,
      declaredCount: declaredPosts,
      observedAt: pub?.observedAt ?? null,
      sources: pub !== undefined ? [pub.sourceId] : [],
      evidenceClasses: pub !== undefined ? (["PUBLIC_WEB"] as ViewerEvidenceClass[]) : [],
      rows,
    };
    if (isPrivate) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: privateReason,
        reasonKind: "PRIVATE",
        rows: [],
      };
    }
    if (pub !== undefined) {
      const listingOnly = rows.filter((row) => row.detailStatus === "LISTING_ONLY").length;
      const partial = listingOnly > 0;
      return {
        ...base,
        status: partial ? "PARTIAL" : "OBSERVED",
        count: rows.length,
        reason: partial
          ? `${listingOnly} of ${rows.length} row(s) were read from the listing only; the media page was not read (detailStatus LISTING_ONLY).`
          : null,
        reasonKind: partial ? "PARTIAL" : null,
      };
    }
    if (publicRequested && publicFailure !== undefined) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: publicFailure.message,
        reasonKind: "SOURCE_ERROR",
      };
    }
    return {
      ...base,
      status: "UNAVAILABLE",
      count: null,
      reason:
        "Posts and reels are read from the logged-out public profile page, which was not requested. Re-run with --source both (or public).",
      reasonKind: "NOT_REQUESTED",
    };
  };

  const highlightsTab: ViewerTab = (() => {
    const sourcesList = [...new Set([...(pub !== undefined ? [pub.sourceId] : []), ...(anon !== undefined ? [anon.sourceId] : [])])];
    const evidenceClasses = [...new Set<ViewerEvidenceClass>([
      ...(pub !== undefined ? (["PUBLIC_WEB"] as ViewerEvidenceClass[]) : []),
      ...(anon !== undefined ? (["PUBLIC_AGGREGATOR"] as ViewerEvidenceClass[]) : []),
    ])];
    const base = {
      key: "highlights" as const,
      label: "Highlights" as const,
      requested: publicRequested || anonRequested,
      declaredCount: null,
      observedAt: anon?.observedAt ?? pub?.observedAt ?? null,
      sources: sourcesList,
      evidenceClasses,
      rows: highlightRows,
    };
    if (isPrivate) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: privateReason,
        reasonKind: "PRIVATE",
        rows: [],
      };
    }
    if (highlightRows.length > 0) {
      const unread = highlightRows.filter((row) => row.contentsStatus !== "READ").length;
      const partial = unread > 0;
      return {
        ...base,
        status: partial ? "PARTIAL" : "OBSERVED",
        count: highlightRows.length,
        reason: partial
          ? `${unread} highlight(s) were listed but their contents were not read; each row carries its own reason.`
          : null,
        reasonKind: partial ? "PARTIAL" : null,
      };
    }
    if ((publicRequested && publicFailure !== undefined) || (anonRequested && anonFailure !== undefined)) {
      const failure = (publicRequested ? publicFailure : undefined) ?? anonFailure;
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: failure?.message ?? "No requested source answered.",
        reasonKind: "SOURCE_ERROR",
      };
    }
    if (!publicRequested && !anonRequested) {
      return {
        ...base,
        status: "UNAVAILABLE",
        count: null,
        reason: "No source was requested.",
        reasonKind: "NOT_REQUESTED",
      };
    }
    return {
      ...base,
      status: "OBSERVED",
      count: 0,
      reason: null,
      reasonKind: null,
    };
  })();

  const repostEntry = registryEntry(RegistryCapabilityId.RESHARES);
  const repostTab: ViewerTab = {
    key: "repost",
    label: "Reposts",
    status: "UNAVAILABLE",
    requested: false,
    count: null,
    declaredCount: null,
    reason: repostEntry.whyUnavailable ?? repostEntry.permissions,
    reasonKind: "STRUCTURAL",
    sources: [],
    evidenceClasses: [],
    observedAt: null,
    rows: [],
  };

  const tagsEntry = registryEntry(RegistryCapabilityId.TAGS);
  const taggedTab: ViewerTab = {
    key: "tagged",
    label: "Tagged",
    status: "UNAVAILABLE",
    requested: false,
    count: null,
    declaredCount: null,
    reason: `The tags edge is available for the owned account only (${tagsEntry.permissions}). This viewer reads another account, so no tagged-media listing is available; an owned target can use the tags capability with its own authorization.`,
    reasonKind: "STRUCTURAL",
    sources: [],
    evidenceClasses: [],
    observedAt: null,
    rows: [],
  };

  const tabs: ViewerTab[] = [
    storyTab,
    buildPostTab("post", posts, "Posts"),
    buildPostTab("reels", reels, "Reels"),
    highlightsTab,
    repostTab,
    taggedTab,
  ];

  const profile: ViewerProfile = {
    username: pub?.profile.username ?? anon?.account.username ?? options.username,
    fullName: pub?.profile.fullName ?? anon?.account.fullName ?? null,
    biography: pub?.profile.biography ?? null,
    profilePicUrl: pub?.profile.profilePicUrl ?? anon?.account.profilePicUrl ?? null,
    followerCount: pub?.profile.followerCount ?? anon?.account.followerCount ?? null,
    followingCount: pub?.profile.followingCount ?? anon?.account.followingCount ?? null,
    declaredPostCount:
      pub?.profile.declaredPostCount ?? anon?.account.declaredPostCount ?? null,
    isPrivate:
      pub?.profile.isPrivate ?? anon?.account.isPrivate ?? null,
    isVerified:
      pub?.profile.isVerified ?? anon?.account.isVerified ?? null,
    sources: [
      ...(pub !== undefined ? [pub.sourceId] : []),
      ...(anon !== undefined ? [anon.sourceId] : []),
    ],
  };

  const mentionRows = (anon?.mentions ?? []).map((row) => ({
    username: row.username,
    fullName: row.fullName,
    isPrivate: row.isPrivate,
    isVerified: row.isVerified,
    isReshareAuthor: row.isReshareAuthor,
    seenIn: row.seenIn,
    itemCount: row.itemCount,
  }));
  const mentions = {
    rows: mentionRows,
    count: anon !== undefined ? mentionRows.length : null,
    reason:
      anon !== undefined
        ? null
        : anonRequested && anonFailure !== undefined
          ? anonFailure.message
          : "Story mentions are read from the public aggregator source, which was not requested.",
  };

  let mentionFocus: ViewerMentionFocus | null = null;
  if (options.mention !== undefined && options.mention.trim() !== "") {
    const handle = cleanHandle(options.mention);
    const storyIds = storyRows
      .filter((row) => row.mentions.some((mention) => mention.username === handle))
      .map((row) => row.id);
    const highlightItems: Array<{ highlightId: string; itemIds: string[] }> = [];
    for (const highlight of highlightRows) {
      const itemIds = highlight.items
        .filter((row) => row.mentions.some((mention) => mention.username === handle))
        .map((row) => row.id);
      if (itemIds.length > 0) highlightItems.push({ highlightId: highlight.id, itemIds });
    }
    const itemCount =
      storyIds.length + highlightItems.reduce((sum, entry) => sum + entry.itemIds.length, 0);
    mentionFocus = {
      username: handle,
      matched: itemCount > 0,
      itemCount,
      storyIds,
      highlightItems,
      reason:
        itemCount > 0
          ? null
          : `No observed story or highlight item names @${handle}. An empty match is a fact about the observed sample, not proof the account was never mentioned.`,
    };
  }

  const byShortcode = new Map<string, ViewerPostRow>();
  for (const row of [...posts, ...reels]) byShortcode.set(row.shortcode, row);
  const popularityRows = [...byShortcode.values()];
  const likeValues = popularityRows
    .map((row) => row.likeCount)
    .filter((value): value is number => typeof value === "number");
  const commentValues = popularityRows
    .map((row) => row.commentCount)
    .filter((value): value is number => typeof value === "number");
  const sum = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  const average = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100;
  const missingMetrics: string[] = [];
  if (likeValues.length === 0) missingMetrics.push("like counts");
  if (commentValues.length === 0) missingMetrics.push("comment counts");
  const popularity: ViewerPopularity = {
    sampleSize: popularityRows.length,
    likeSampleSize: likeValues.length,
    commentSampleSize: commentValues.length,
    likeTotal: sum(likeValues),
    commentTotal: sum(commentValues),
    likeAverage: average(likeValues),
    commentAverage: average(commentValues),
    reason:
      missingMetrics.length === 0
        ? null
        : popularityRows.length === 0
          ? "No post or reel row was observed, so no engagement aggregate exists. This is not a zero."
          : `No loaded row carried a numeric ${missingMetrics.join(" or ")}; that metric stays unavailable rather than zero.`,
  };

  const refusals: ViewerRefusal[] = [
    refusal(RegistryCapabilityId.RESHARES),
    refusal(
      RegistryCapabilityId.TAGS,
      taggedTab.reason ?? undefined,
    ),
    refusal(RegistryCapabilityId.LIKES),
    refusal(RegistryCapabilityId.AI_INSIGHTS),
  ];

  const coverage: ViewerCoverageRow[] = tabs.map((tab) => ({
    subject: `${tab.label} tab`,
    status: tab.status,
    value: tab.count,
    reason: tab.reason,
  }));

  const gaps: ViewerGap[] = [];
  for (const [name, snapshot] of [
    ["public", pub],
    ["anonstories", anon],
  ] as const) {
    if (snapshot === undefined) continue;
    for (const gap of snapshot.gaps) {
      gaps.push({
        subject: `${name}: ${gap.subject}`,
        reason: gap.reason,
        howToImprove: gap.howToImprove,
      });
    }
  }
  if (postPartial && postReason !== null) {
    gaps.push({
      subject: "post detail coverage",
      reason: postReason,
      howToImprove:
        "Raise --max-posts or rerun when the media pages are reachable; listing-only rows are labelled, never treated as complete.",
    });
  }
  const unreadHighlights = highlightRows.filter(
    (row) => anon !== undefined && row.contentsStatus !== "READ",
  );
  if (unreadHighlights.length > 0) {
    gaps.push({
      subject: "highlight contents",
      reason: `${unreadHighlights.length} highlight(s) were listed without contents. Each row carries its own reason; contents are never reconstructed from the cover.`,
      howToImprove:
        "Raise --max-highlights within the aggregator's rate limit, or retry later; the listing remains valid without contents.",
    });
  }
  if (mentions.count === null) {
    gaps.push({
      subject: "story mentions",
      reason: mentions.reason ?? "The mention index was not read.",
      howToImprove: "Request the anonstories source (--source both).",
    });
  }

  const notes = [
    "count is the number of rows this report observed; declaredCount is the platform's own number and can exceed what any source exposed. They are never merged.",
    VIEWER_DOWNLOAD_POLICY.note,
    "Reposts, tagged media for another account, liker identities and AI inferences are refused with a registry reason; they are not empty results.",
    ...(pub?.notes ?? []),
    ...(anon?.notes ?? []),
    ...(options.additionalNotes ?? []),
  ];

  return {
    version: 1,
    generatedAt: options.generatedAt,
    input: options.input,
    username: profile.username,
    focus: {
      tab: options.input.tab,
      postCode: options.input.postCode ?? null,
      storyId: options.input.storyId ?? null,
    },
    requestedSources: options.requestedSources,
    profile,
    tabs,
    mentions,
    mentionFocus,
    popularity,
    refusals,
    downloadPolicy: { ...VIEWER_DOWNLOAD_POLICY },
    coverage,
    gaps,
    notes,
  };
}

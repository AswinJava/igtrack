import { CapabilityStatus, Confidence, SourceKind } from "@igtrack/core";
import type {
  AnonStoriesDossier,
  AnonStoriesDossierResult,
  AnonStoriesProvider,
  PublicSinglePost,
  PublicWebDossier,
  PublicWebDossierResult,
  PublicWebProvider,
} from "@igtrack/ingestion";

// One account, one observation time, and the smallest payload each login-free
// provider can honestly return. Tests inject these in place of a browser so the
// operations layer is exercised without a network read.

export const OBSERVED = "2026-10-31T11:00:00.000Z";

export function publicDossier(overrides: Partial<PublicWebDossier> = {}): PublicWebDossier {
  return {
    requestedAt: OBSERVED,
    observedAt: OBSERVED,
    username: "aurora.wilde",
    source: {
      sourceId: "public:web:v1",
      kind: SourceKind.PUBLIC_WEB,
      profileUrl: "https://www.instagram.com/aurora.wilde/",
      retrieval: "injected-transport",
    },
    profile: {
      username: "aurora.wilde",
      fullName: "Aurora Wilde",
      biography: "Public account",
      biographyMentions: [],
      pronouns: [],
      bioLinks: [],
      highlights: [{ id: "highlight:1", title: "Trips" }],
      postCount: 12,
      isPrivate: false,
      isVerified: false,
      observedAt: OBSERVED,
    },
    posts: [
      {
        shortcode: "AAA111",
        observedAt: OBSERVED,
        likeCount: 10,
        commentCount: 2,
        mediaType: "image",
        detailStatus: "ENRICHED",
        discoveredFrom: ["profile_timeline"],
        coauthors: [],
        taggedUsers: [],
        sponsorUsers: [],
        media: { displayUrl: "https://example.invalid/a.jpg" },
        listingFallbackFields: [],
        sourceUrl: "https://www.instagram.com/p/AAA111/",
      },
    ],
    counts: {
      postsDeclared: 12,
      postsDiscovered: 1,
      postsEnriched: 1,
      postsListingOnly: 0,
    },
    coverage: [],
    gaps: [],
    notes: ["public note"],
    ...overrides,
  };
}

export function anonDossier(overrides: Partial<AnonStoriesDossier> = {}): AnonStoriesDossier {
  return {
    requestedAt: OBSERVED,
    observedAt: OBSERVED,
    username: "aurora.wilde",
    source: {
      sourceId: "anonstories:v1",
      kind: SourceKind.PUBLIC_AGGREGATOR,
      origin: "https://anonstories.invalid",
      retrieval: "injected-transport",
    },
    account: { username: "aurora.wilde", fullName: "Aurora Wilde", isPrivate: false },
    stories: [
      {
        storyId: "story-1",
        mediaType: "image",
        mediaUrl: "https://example.invalid/s1.jpg",
        mentions: [],
      },
    ],
    droppedStoryItems: 0,
    highlights: [
      {
        id: "1",
        title: "Trips",
        status: "READ",
        itemCount: 1,
        droppedItems: 0,
        items: [{ storyId: "h1-1", mediaType: "image", mediaUrl: "https://example.invalid/h1.jpg", mentions: [] }],
      },
    ],
    mentions: [],
    counts: {
      activeStories: 1,
      highlights: 1,
      highlightContentsRead: 1,
      highlightItems: 1,
      mentionedAccounts: 0,
    },
    coverage: [],
    gaps: [],
    notes: ["anon note"],
    ...overrides,
  };
}

export function publicSinglePost(
  overrides: Partial<PublicSinglePost> = {},
): PublicSinglePost {
  return {
    requestedAt: OBSERVED,
    observedAt: OBSERVED,
    shortcode: "AAA111",
    kind: "p",
    source: {
      sourceId: "public:web:v1",
      kind: SourceKind.PUBLIC_WEB,
      postUrl: "https://www.instagram.com/p/AAA111/",
      retrieval: "injected-transport",
    },
    post: { ...publicDossier().posts[0]! },
    comments: { status: "UNAVAILABLE", reason: "not on the logged-out page" },
    notes: [],
    ...overrides,
  };
}

export function publicOk(dossier: PublicWebDossier = publicDossier()): PublicWebDossierResult {
  return { status: CapabilityStatus.AVAILABLE, dossier, observedAt: OBSERVED };
}

export function anonOk(dossier: AnonStoriesDossier = anonDossier()): AnonStoriesDossierResult {
  return { status: CapabilityStatus.AVAILABLE, dossier, observedAt: OBSERVED };
}

export function fakePublic(
  dossier: PublicWebDossier = publicDossier(),
  single?: PublicSinglePost,
): Pick<PublicWebProvider, "getDossier" | "getPublicPost"> {
  return {
    getDossier: async () => publicOk(dossier),
    getPublicPost: async () => ({
      status: CapabilityStatus.AVAILABLE,
      observedAt: OBSERVED,
      source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
      confidence: Confidence.HIGH,
      ...(single !== undefined ? { data: single } : {}),
    }),
  };
}

export function fakeAnon(
  dossier: AnonStoriesDossier = anonDossier(),
): Pick<AnonStoriesProvider, "getDossier"> {
  return { getDossier: async () => anonOk(dossier) };
}

/** A browser executable path that cannot exist on any platform. */
export const NO_BROWSER = "/nonexistent/igtrack-test-chrome.exe";

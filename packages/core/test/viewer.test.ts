import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY,
  RegistryCapabilityId,
  VIEWER_TABS,
  buildViewerReport,
  parseViewerInput,
  type ViewerAnonSnapshot,
  type ViewerPublicSnapshot,
} from "../src/index.js";

// Behavior tests for the six-tab viewer contract: fixed order, observed vs
// declared counts, registry-cited refusals, and null (never zero) aggregates.

const GENERATED = "2026-10-31T12:00:00.000Z";

function publicSnapshot(overrides: Partial<ViewerPublicSnapshot> = {}): ViewerPublicSnapshot {
  return {
    sourceId: "public:web:v1",
    observedAt: "2026-10-31T11:00:00.000Z",
    profileUrl: "https://www.instagram.com/aurora.wilde/",
    profile: {
      username: "aurora.wilde",
      fullName: "Aurora Wilde",
      biography: "Public account",
      profilePicUrl: "https://example.invalid/avatar.jpg",
      followerCount: 1200,
      followingCount: 300,
      declaredPostCount: 100,
      isPrivate: false,
      isVerified: false,
      highlights: [
        { id: "highlight:1", title: "Trips", coverUrl: "https://example.invalid/h1.jpg", ownerUsername: "aurora.wilde" },
      ],
    },
    posts: [
      {
        shortcode: "AAA111",
        permalink: "https://www.instagram.com/p/AAA111/",
        takenAt: "2026-10-01T00:00:00.000Z",
        caption: "first",
        likeCount: 10,
        commentCount: null,
        playCount: null,
        mediaType: "image",
        productType: "feed",
        displayUrl: "https://example.invalid/a.jpg",
        thumbnailUrl: null,
        videoUrl: null,
        detailStatus: "ENRICHED",
        discoveredFrom: ["profile_timeline"],
        ownerUsername: "aurora.wilde",
      },
      {
        shortcode: "BBB222",
        permalink: "https://www.instagram.com/reel/BBB222/",
        takenAt: "2026-10-02T00:00:00.000Z",
        caption: "second",
        likeCount: 30,
        commentCount: 4,
        playCount: 900,
        mediaType: "video",
        productType: "clips",
        displayUrl: null,
        thumbnailUrl: null,
        videoUrl: "https://example.invalid/b.mp4",
        detailStatus: "LISTING_ONLY",
        discoveredFrom: ["reels_tab"],
        ownerUsername: "aurora.wilde",
      },
    ],
    counts: {
      postsDeclared: 100,
      postsDiscovered: 2,
      postsEnriched: 1,
      postsListingOnly: 1,
    },
    coverage: [],
    gaps: [],
    notes: ["public note"],
    ...overrides,
  };
}

function anonSnapshot(overrides: Partial<ViewerAnonSnapshot> = {}): ViewerAnonSnapshot {
  return {
    sourceId: "anonstories:v1",
    observedAt: "2026-10-31T11:05:00.000Z",
    account: {
      username: "aurora.wilde",
      fullName: "Aurora Wilde",
      profilePicUrl: null,
      followerCount: null,
      followingCount: null,
      declaredPostCount: null,
      isPrivate: false,
      isVerified: false,
    },
    stories: [
      {
        id: "story-1",
        publishedAt: "2026-10-31T09:00:00.000Z",
        age: "2 hours",
        mediaType: "image",
        mediaUrl: "https://example.invalid/s1.jpg",
        thumbnailUrl: null,
        linkUrl: null,
        mentions: [
          { username: "bob", fullName: null, isPrivate: null, isVerified: null, isReshareAuthor: false },
        ],
        reshareAuthor: null,
      },
    ],
    highlights: [
      {
        id: "1",
        title: "Trips",
        coverUrl: "https://example.invalid/h1-agg.jpg",
        contentsStatus: "READ",
        contentsReason: null,
        itemCount: 2,
        droppedItems: 0,
        items: [
          {
            id: "h1-item-1",
            publishedAt: null,
            age: null,
            mediaType: "image",
            mediaUrl: "https://example.invalid/h1-1.jpg",
            thumbnailUrl: null,
            linkUrl: null,
            mentions: [],
            reshareAuthor: null,
          },
        ],
      },
      {
        id: "2",
        title: "Later",
        coverUrl: null,
        contentsStatus: "UNAVAILABLE",
        contentsReason: "rate limited",
        itemCount: 0,
        droppedItems: 0,
        items: [],
      },
    ],
    mentions: [
      {
        username: "bob",
        fullName: "Bob",
        isPrivate: false,
        isVerified: false,
        isReshareAuthor: false,
        seenIn: ["story"],
        itemCount: 1,
      },
    ],
    counts: {
      activeStories: 1,
      highlights: 2,
      highlightContentsRead: 1,
      highlightItems: 2,
      mentionedAccounts: 1,
    },
    coverage: [],
    gaps: [],
    notes: ["anon note"],
    ...overrides,
  };
}

function report(
  sources: { public?: ViewerPublicSnapshot; anonstories?: ViewerAnonSnapshot },
  extra: { mention?: string; sources?: Array<"public" | "anonstories"> } = {},
) {
  return buildViewerReport(sources, {
    input: parseViewerInput("aurora.wilde"),
    username: "aurora.wilde",
    generatedAt: GENERATED,
    requestedSources: extra.sources ?? ["public", "anonstories"],
    ...(extra.mention !== undefined ? { mention: extra.mention } : {}),
  });
}

describe("parseViewerInput", () => {
  it("accepts usernames, profile URLs and selects the implied tab", () => {
    expect(parseViewerInput("@Aurora.Wilde")).toMatchObject({
      kind: "username",
      username: "aurora.wilde",
      tab: "story",
    });
    expect(parseViewerInput("instagram.com/aurora.wilde/")).toMatchObject({
      kind: "profile_url",
      username: "aurora.wilde",
    });
    expect(parseViewerInput("https://www.instagram.com/p/ABC123/")).toMatchObject({
      kind: "post_url",
      tab: "post",
      postCode: "ABC123",
      postKind: "p",
    });
    expect(parseViewerInput("https://www.instagram.com/reel/XYZ987/")).toMatchObject({
      kind: "reel_url",
      tab: "reels",
      postKind: "reel",
    });
    expect(parseViewerInput("https://www.instagram.com/aurora.wilde/p/ABC123/")).toMatchObject({
      kind: "post_url",
      username: "aurora.wilde",
      tab: "post",
      postCode: "ABC123",
      postKind: "p",
    });
    expect(parseViewerInput("https://www.instagram.com/Aurora.Wilde/reel/XYZ987/")).toMatchObject({
      kind: "reel_url",
      username: "aurora.wilde",
      tab: "reels",
      postCode: "XYZ987",
      postKind: "reel",
    });
    expect(parseViewerInput("https://www.instagram.com/stories/aurora.wilde/123/")).toMatchObject({
      kind: "story_url",
      username: "aurora.wilde",
      storyId: "123",
    });
  });

  it("refuses a highlight URL (it names no owner) and non-Instagram hosts", () => {
    expect(parseViewerInput("https://www.instagram.com/stories/highlights/179123/")).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("owner"),
    });
    expect(parseViewerInput("https://example.com/aurora.wilde")).toMatchObject({
      kind: "unsupported",
    });
    expect(parseViewerInput("not a handle!")).toMatchObject({ kind: "unsupported" });
  });
});

describe("buildViewerReport", () => {
  it("returns the six tabs in the fixed order with observed and declared counts kept apart", () => {
    const out = report({ public: publicSnapshot(), anonstories: anonSnapshot() });
    expect(out.tabs.map((tab) => tab.key)).toEqual(VIEWER_TABS.map((tab) => tab.key));
    const posts = out.tabs.find((tab) => tab.key === "post");
    expect(posts).toMatchObject({ status: "OBSERVED", count: 1, declaredCount: 100 });
    const reels = out.tabs.find((tab) => tab.key === "reels");
    expect(reels).toMatchObject({ status: "PARTIAL", count: 1, declaredCount: 100 });
    expect(out.popularity).toMatchObject({
      sampleSize: 2,
      likeSampleSize: 2,
      commentSampleSize: 1,
      likeTotal: 40,
      likeAverage: 20,
      commentTotal: 4,
      commentAverage: 4,
    });
  });

  it("merges the public highlight strip and aggregator contents on digits, preserving per-highlight reasons", () => {
    const out = report({ public: publicSnapshot(), anonstories: anonSnapshot() });
    const highlights = out.tabs.find((tab) => tab.key === "highlights");
    expect(highlights?.status).toBe("PARTIAL");
    expect(highlights?.count).toBe(2);
    if (highlights?.key !== "highlights") throw new Error("wrong tab");
    expect(highlights.rows[0]).toMatchObject({
      id: "highlight:1",
      contentsStatus: "READ",
      itemCount: 2,
      sources: ["public:web:v1", "anonstories:v1"],
      evidenceClasses: ["PUBLIC_WEB", "PUBLIC_AGGREGATOR"],
    });
    expect(highlights.rows[1]).toMatchObject({
      id: "2",
      contentsStatus: "UNAVAILABLE",
      contentsReason: "rate limited",
    });
  });

  it("marks a public-only highlight strip PARTIAL and names why contents were not read", () => {
    const out = report({ public: publicSnapshot() }, { sources: ["public"] });
    const highlights = out.tabs.find((tab) => tab.key === "highlights");
    expect(highlights).toMatchObject({
      status: "PARTIAL",
      reasonKind: "PARTIAL",
      count: 1,
    });
    if (highlights?.key !== "highlights") throw new Error("wrong tab");
    expect(highlights.rows[0]).toMatchObject({ contentsStatus: "NOT_READ" });
    expect(highlights.rows[0]?.contentsReason).toContain("aggregator");
  });

  it("refuses reposts and tagged media with the registry's own reasons", () => {
    const out = report({ public: publicSnapshot(), anonstories: anonSnapshot() });
    const reshare = CAPABILITY_REGISTRY.find((entry) => entry.id === RegistryCapabilityId.RESHARES);
    const tags = CAPABILITY_REGISTRY.find((entry) => entry.id === RegistryCapabilityId.TAGS);
    expect(out.tabs.find((tab) => tab.key === "repost")).toMatchObject({
      status: "UNAVAILABLE",
      reason: reshare?.whyUnavailable,
      reasonKind: "STRUCTURAL",
      count: null,
    });
    const tagged = out.tabs.find((tab) => tab.key === "tagged");
    expect(tagged?.status).toBe("UNAVAILABLE");
    expect(tagged?.reason).toContain("owned account only");
    expect(tagged?.reason).toContain(tags?.permissions.split(" ")[0] ?? "");
    expect(out.refusals.map((refusal) => refusal.capability)).toEqual(
      expect.arrayContaining([
        RegistryCapabilityId.RESHARES,
        RegistryCapabilityId.TAGS,
        RegistryCapabilityId.LIKES,
        RegistryCapabilityId.AI_INSIGHTS,
      ]),
    );
  });

  it("never zero-fills popularity when no numeric metric was observed", () => {
    const out = report({
      public: publicSnapshot({
        posts: [],
        counts: { postsDeclared: 100, postsDiscovered: 0, postsEnriched: 0, postsListingOnly: 0 },
      }),
      anonstories: anonSnapshot({ stories: [], highlights: [], mentions: [] }),
    });
    expect(out.popularity).toMatchObject({
      sampleSize: 0,
      likeTotal: null,
      commentTotal: null,
      likeAverage: null,
      commentAverage: null,
    });
    expect(out.popularity.reason).toContain("not a zero");
  });

  it("refuses every readable tab for a private account but keeps the public shell", () => {
    const out = report({
      public: publicSnapshot({
        profile: { ...publicSnapshot().profile, isPrivate: true },
        posts: [],
      }),
    });
    expect(out.profile).toMatchObject({ username: "aurora.wilde", isPrivate: true });
    for (const key of ["story", "post", "reels", "highlights"] as const) {
      expect(out.tabs.find((tab) => tab.key === key)).toMatchObject({
        status: "UNAVAILABLE",
        reasonKind: "PRIVATE",
        rows: [],
      });
    }
  });

  it("reports a failed source as UNAVAILABLE/SOURCE_ERROR, not as an empty tab", () => {
    const out = buildViewerReport(
      {
        failures: {
          public: { kind: "SOURCE_GATED", message: "login page served", retryable: false },
        },
      },
      {
        input: parseViewerInput("aurora.wilde"),
        username: "aurora.wilde",
        generatedAt: GENERATED,
        requestedSources: ["public"],
      },
    );
    expect(out.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "SOURCE_ERROR",
      reason: "login page served",
      count: null,
    });
    expect(out.tabs.find((tab) => tab.key === "story")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "NOT_REQUESTED",
    });
  });

  it("marks the items that mention a requested account without hiding the rest", () => {
    const out = report(
      { public: publicSnapshot(), anonstories: anonSnapshot() },
      { mention: "@Bob" },
    );
    expect(out.mentionFocus).toMatchObject({
      username: "bob",
      matched: true,
      itemCount: 1,
      storyIds: ["story-1"],
    });
    expect(out.tabs.find((tab) => tab.key === "story")).toMatchObject({ count: 1 });
  });

  it("states that the mention index is unavailable when the aggregator was not requested", () => {
    const out = report({ public: publicSnapshot() }, { sources: ["public"] });
    expect(out.mentions.count).toBeNull();
    expect(out.mentions.reason).toContain("not requested");
  });
});

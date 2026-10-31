import { describe, expect, it } from "vitest";
import { CapabilityStatus, Confidence, SourceKind } from "@igtrack/core";
import type {
  AnonStoriesDossier,
  AnonStoriesDossierResult,
  PublicSinglePost,
  PublicWebDossier,
  PublicWebDossierResult,
  PublicWebProvider,
  AnonStoriesProvider,
} from "@igtrack/ingestion";
import { opViewer } from "../src/tools.js";
import { renderViewerHuman } from "../src/commands/viewer.js";

// Behavior tests for the viewer operation and its human surface, with the two
// providers injected: no browser and no network.

const OBSERVED = "2026-10-31T11:00:00.000Z";

function publicDossier(overrides: Partial<PublicWebDossier> = {}): PublicWebDossier {
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

function anonDossier(overrides: Partial<AnonStoriesDossier> = {}): AnonStoriesDossier {
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

function publicOk(dossier: PublicWebDossier = publicDossier()): PublicWebDossierResult {
  return { status: CapabilityStatus.AVAILABLE, dossier, observedAt: OBSERVED };
}

function anonOk(dossier: AnonStoriesDossier = anonDossier()): AnonStoriesDossierResult {
  return { status: CapabilityStatus.AVAILABLE, dossier, observedAt: OBSERVED };
}

function fakePublic(
  dossier: PublicWebDossier = publicDossier(),
  single?: PublicSinglePost,
): Pick<PublicWebProvider, "getDossier" | "getPublicPost"> {
  return {
    getDossier: async () => publicOk(dossier),
    getPublicPost: async (reference) => ({
      status: CapabilityStatus.AVAILABLE,
      observedAt: OBSERVED,
      source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
      confidence: Confidence.HIGH,
      ...(single !== undefined ? { data: single } : {}),
    }),
  };
}

function fakeAnon(
  dossier: AnonStoriesDossier = anonDossier(),
): Pick<AnonStoriesProvider, "getDossier"> {
  return { getDossier: async () => anonOk(dossier) };
}

describe("opViewer", () => {
  it("composes the six tabs from both sources and keeps declared counts separate", async () => {
    const report = await opViewer(
      { input: "aurora.wilde" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    expect(report.tabs.map((tab) => tab.key)).toEqual([
      "story",
      "post",
      "reels",
      "highlights",
      "repost",
      "tagged",
    ]);
    expect(report.tabs.find((tab) => tab.key === "story")).toMatchObject({
      status: "OBSERVED",
      count: 1,
      evidenceClasses: ["PUBLIC_AGGREGATOR"],
    });
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "OBSERVED",
      count: 1,
      declaredCount: 12,
    });
    expect(report.tabs.find((tab) => tab.key === "highlights")).toMatchObject({
      status: "OBSERVED",
      count: 1,
    });
    expect(report.tabs.find((tab) => tab.key === "repost")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "STRUCTURAL",
    });
    expect(report.mentions.count).toBe(0);
    expect(report.notes).toEqual(
      expect.arrayContaining(["public note", "anon note"]),
    );
  });

  it("reads only the requested source and marks the others NOT_REQUESTED", async () => {
    let publicCalls = 0;
    const publicProvider = fakePublic();
    const spyPublic: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: async (...args) => {
        publicCalls += 1;
        return publicProvider.getDossier(...args);
      },
      getPublicPost: publicProvider.getPublicPost,
    };
    const report = await opViewer(
      { input: "aurora.wilde", source: "anonstories" },
      { publicProvider: spyPublic, anonProvider: fakeAnon() },
    );
    expect(publicCalls).toBe(0);
    expect(report.requestedSources).toEqual(["anonstories"]);
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "NOT_REQUESTED",
      count: null,
    });
  });

  it("keeps a provider refusal as a typed source error, not an empty tab", async () => {
    const report = await opViewer(
      { input: "aurora.wilde", source: "public" },
      {
        publicProvider: {
          getDossier: async () => ({
            status: CapabilityStatus.ERROR,
            observedAt: OBSERVED,
            error: {
              kind: "AUTH_REQUIRED",
              message: "Instagram served a login page.",
              retryable: false,
            },
          }),
          getPublicPost: fakePublic().getPublicPost,
        },
      },
    );
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "SOURCE_ERROR",
      reason: "Instagram served a login page.",
      count: null,
    });
  });

  it("refuses read tabs for a private account while keeping the public shell", async () => {
    const dossier = publicDossier({
      profile: {
        ...publicDossier().profile,
        isPrivate: true,
        highlights: [],
      },
      posts: [],
    });
    const report = await opViewer(
      { input: "aurora.wilde", source: "public" },
      { publicProvider: fakePublic(dossier) },
    );
    expect(report.profile).toMatchObject({ username: "aurora.wilde", isPrivate: true });
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "PRIVATE",
    });
  });

  it("resolves a post URL to its owner through one media-page read", async () => {
    const single: PublicSinglePost = {
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
      post: {
        ...publicDossier().posts[0]!,
        owner: { username: "aurora.wilde" },
      },
      comments: { status: "UNAVAILABLE", reason: "not on the logged-out page" },
      notes: [],
    };
    const report = await opViewer(
      { input: "https://www.instagram.com/p/AAA111/", source: "public" },
      { publicProvider: fakePublic(publicDossier(), single) },
    );
    expect(report.username).toBe("aurora.wilde");
    expect(report.input.postCode).toBe("AAA111");
    expect(report.focus.tab).toBe("post");
    expect(report.notes.join(" ")).toContain("resolved from the post URL's owner");
  });

  it("renders the tab strip, refusals and the observed/declared split", async () => {
    const report = await opViewer(
      { input: "aurora.wilde" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    const human = renderViewerHuman(report, { tab: "all" });
    expect(human).toContain("Stories 1");
    expect(human).toContain("Posts 1 observed / 12 declared");
    expect(human).toContain("Reposts — UNAVAILABLE");
    expect(human).toContain("Refused by design");
    expect(human).toContain("RESHARES");
    expect(human).toContain("SOURCE_URL_ONLY");
  });
});

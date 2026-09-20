import { describe, expect, it } from "vitest";
import {
  CapabilityErrorKind,
  CapabilityStatus,
  MentionVisibilityClass,
  SourceKind,
} from "@igtrack/core";
import {
  anonB64Url,
  anonHighlightStoriesAuth,
  anonStoryAuth,
  classifyAnonResponse,
  parseAnonHighlightRefs,
  parseAnonSubject,
} from "../src/public/anonstories.js";
import { AnonStoriesProvider } from "../src/public/anonstories-provider.js";
import { findChrome } from "../src/public/chrome.js";
import type { AnonHttpResponse, AnonStoriesTransport } from "../src/public/anonstories.js";

// ---------------------------------------------------------------------------
// anonstories.com, pinned from live probes of 2026-10-28. Every fixture below
// is the exact response envelope the aggregator served (trimmed of media URLs
// only). The transport is injected, so no test touches the network; the
// provider's classification, retry, and honesty rules are what is under test.
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");
const NOW_EPOCH = Math.floor(FIXED_NOW.getTime() / 1000);

const CRED = "LTE6Om11cmllbGdhbGxlOjpySlAydEJSS2Y2a3RiUnFQVUJ0UkU5a2xnQldiN2Q-";

function ok(
  body: unknown,
  status = 200,
): AnonHttpResponse {
  return { status, body: JSON.stringify(body) };
}

const SEL_USER_INFO = {
  id: 67606942730,
  username: "sel_win_",
  full_name: "Aswin S",
  is_private: false,
  is_verified: false,
  profile_pic_url: "https://cdn.example/pic.jpg",
  posts: 3,
  followers: 361,
  following: 515,
};

// A real active-story item shape: taken_at_raw present, NO taken_at_timestamp,
// mention usernames NOT index-aligned with mentioned_users (observed live).
const STORY_ITEM_MISALIGNED = {
  id: "3672100000000000000_67606942730",
  pk: "3672100000000000000",
  media_type: "image",
  source: "https://embed.anonstories.com/aHR0cHM6Ly9jZG4xLmV4YW1wbGUvbWVkaWEuanBn",
  thumbnail: "https://embed.anonstories.com/aHR0cHM6Ly9jZG4xLmV4YW1wbGUvdGguanBn",
  taken_at: "23 hours",
  taken_at_raw: String(NOW_EPOCH - 23 * 3600),
  mentions: ["blakong.creative", "codewildtech"],
  mentioned_users: [
    { pk: "5325615985", username: "codewildtech", full_name: "Code Wild", is_private: true },
    { pk: "5325615986", username: "blakong.creative", full_name: "Blakong", is_private: false },
  ],
  link: null,
};

// A real highlight item shape: taken_at_timestamp present (number), no
// taken_at_raw.
const HIGHLIGHT_ITEM = {
  id: "3555100000000000001_67606942730",
  media_type: "image",
  source: "https://embed.anonstories.com/aHR0cHM6Ly9jZG4yLmV4YW1wbGUvaGwuanBn",
  thumbnail: "https://embed.anonstories.com/aHR0cHM6Ly9jZG4yLmV4YW1wbGUvaGx0aC5qcGc",
  taken_at: "2 years",
  taken_at_timestamp: NOW_EPOCH - 63072000,
  mentions: ["pradheeshjp"],
  mentioned_users: [
    {
      pk: "5325615985",
      username: "pradheeshjp",
      full_name: "Pradheesh",
      is_private: true,
      is_verified: false,
    },
  ],
};

const HIGHLIGHT_REFS = [
  {
    node: {
      id: "18481412830118583",
      title: "EVENT",
      cover_media: { thumbnail_src: "https://embed.example/event.jpg" },
    },
  },
  {
    node: {
      id: "18116370953113785",
      title: "CWT",
      cover_media: { thumbnail_src: "https://embed.example/cwt.jpg" },
    },
  },
];

/**
 * A scripted transport: each endpoint holds a FIFO of responses; every call's
 * (endpoint, auth) pair is recorded for assertion. A function may be given
 * instead of a FIFO to answer dynamically.
 */
function scriptedTransport(
  script: Record<string, AnonHttpResponse[]>,
): { transport: AnonStoriesTransport; calls: Array<{ endpoint: string; auth: string }> } {
  const calls: Array<{ endpoint: string; auth: string }> = [];
  const transport: AnonStoriesTransport = {
    async request(endpoint: string, auth: string): Promise<AnonHttpResponse> {
      calls.push({ endpoint, auth });
      const queue = script[endpoint] ?? [];
      const next = queue.shift();
      if (next === undefined) throw new Error(`scripted transport: no response left for ${endpoint}`);
      return next;
    },
    async close(): Promise<void> {},
  };
  return { transport, calls };
}

function providerWith(
  script: Record<string, AnonHttpResponse[]>,
  overrides: Partial<ConstructorParameters<typeof AnonStoriesProvider>[0]> = {},
): { provider: AnonStoriesProvider; calls: Array<{ endpoint: string; auth: string }> } {
  const { transport, calls } = scriptedTransport(script);
  const provider = new AnonStoriesProvider({
    transportFactory: async () => transport,
    // Instant pacing and backoff: the timing policy is asserted separately,
    // the classification and honesty rules here are not timing-dependent.
    sleep: async () => {},
    paceMs: 0,
    rateLimitDelaysMs: [1, 1],
    queueBoundMs: 5_000,
    now: () => FIXED_NOW,
    maxHighlights: 5,
    ...overrides,
  });
  return { provider, calls };
}

const account = { username: "sel_win_" };

describe("anonstories protocol", () => {
  it("builds the site's own auth tokens (base64url with . _ - alphabet)", () => {
    // Story + highlight-list auth: "-1::<username>::" + CRED.
    const story = anonStoryAuth("sel_win_");
    expect(story).toMatch(/^[A-Za-z0-9._-]+$/);
    const decodedStory = Buffer.from(story.replace(/\./g, "+").replace(/_/g, "/").replace(/-/g, "="), "base64").toString("utf8");
    expect(decodedStory).toBe(`-1::sel_win_::${CRED}`);

    // Highlight-contents auth: "<userId>::<username>::<highlightId>::" + CRED.
    const contents = anonHighlightStoriesAuth(67606942730, "sel_win_", "18481412830118583");
    const decoded = Buffer.from(contents.replace(/\./g, "+").replace(/_/g, "/").replace(/-/g, "="), "base64").toString("utf8");
    expect(decoded).toBe(`67606942730::sel_win_::18481412830118583::${CRED}`);
  });

  it("anonB64Url uses . _ - instead of + / =", () => {
    expect(anonB64Url("\xfb\xff")).toBe(Buffer.from("\xfb\xff").toString("base64").replace(/\+/g, ".").replace(/\//g, "_").replace(/=/g, "-"));
  });

  it("classifies the headless-UA decoy: right username, placeholder media", () => {
    const decoy = ok({
      user_info: { ...SEL_USER_INFO, username: "online", id: 1 },
      stories: [{ id: "1", source: "https://example/no-image.jpeg", mentions: [] }],
      message: null,
      ticket: 1,
      queue: null,
    });
    expect(classifyAnonResponse(decoy, "sel_win_").kind).toBe("decoy");
  });

  it("classifies a wrong-subject answer as a decoy even with real media", () => {
    const decoy = ok({ user_info: { ...SEL_USER_INFO, username: "someoneelse" }, stories: [] });
    const cls = classifyAnonResponse(decoy, "sel_win_");
    expect(cls.kind).toBe("decoy");
    if (cls.kind === "decoy") expect(cls.servedUsername).toBe("someoneelse");
  });

  it("classifies the queue epoch, not-found message, invalid username and 429", () => {
    expect(classifyAnonResponse(ok({ queue: NOW_EPOCH + 60 }), "sel_win_").kind).toBe("queued");
    expect(
      classifyAnonResponse(ok({ message: "User not found", user_info: null }), "sel_win_").kind,
    ).toBe("not-found");
    expect(
      classifyAnonResponse(ok({ message: null, ticket: 5, user_info: null }), "sel_win_").kind,
    ).toBe("invalid-username");
    expect(
      classifyAnonResponse({ status: 429, body: '{"message":"Too many requests"}' }, "sel_win_").kind,
    ).toBe("rate-limited");
    // The site also answers the limit with 200 + the same message body.
    expect(
      classifyAnonResponse(ok({ message: "Too many requests" }), "sel_win_").kind,
    ).toBe("rate-limited");
  });

  it("parses the highlight list's { node: {…} } shape and skips junk", () => {
    const refs = parseAnonHighlightRefs([
      ...HIGHLIGHT_REFS,
      { node: { id: "" } },
      { node: null },
      "junk",
    ]);
    expect(refs).toHaveLength(2);
    expect(refs?.[0]?.title).toBe("EVENT");
    expect(refs?.[1]?.id).toBe("18116370953113785");
    expect(parseAnonHighlightRefs("not-an-array")).toBeNull();
  });

  it("parses user_info into the subject record", () => {
    const subject = parseAnonSubject(SEL_USER_INFO);
    expect(subject).toEqual({
      username: "sel_win_",
      pk: "67606942730",
      fullName: "Aswin S",
      isPrivate: false,
      isVerified: false,
      profilePicUrl: "https://cdn.example/pic.jpg",
      postCount: 3,
      followerCount: 361,
      followingCount: 515,
    });
    expect(parseAnonSubject(null)).toBeNull();
  });
});

describe("AnonStoriesProvider — stories", () => {
  it("resolves the account from the aggregator with MEDIUM confidence and PUBLIC_AGGREGATOR source", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ user_info: SEL_USER_INFO, stories: [], message: null, ticket: 12, queue: null })],
    });
    const result = await provider.resolveAccount("sel_win_");
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    if (result.data === undefined) throw new Error("no account data");
    expect(result.data.username).toBe("sel_win_");
    // The aggregator's id is the legacy pk, never the IGSID: writing it as
    // igId conflicts with the same account already bound by public/Graph.
    expect(result.data.igId).toBeUndefined();
    expect(result.confidence).toBe("MEDIUM");
    expect(result.source.kind).toBe(SourceKind.PUBLIC_AGGREGATOR);
    expect(result.source.sourceId).toBe("anonstories:v1");
    expect(result.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("merges mentions by username, never by position (arrays are not aligned)", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ user_info: SEL_USER_INFO, stories: [STORY_ITEM_MISALIGNED] })],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    if (result.data === undefined) throw new Error("no stories");
    expect(result.data).toHaveLength(1);
    const story = result.data[0];
    if (story === undefined) throw new Error("no story");
    // Both accounts survive the union, each with ITS profile record — a
    // positional join would have swapped their identities.
    expect(story.mentions.map((m) => m.account.username).sort()).toEqual([
      "blakong.creative",
      "codewildtech",
    ]);
    const codewild = story.mentions.find((m) => m.account.username === "codewildtech");
    expect(codewild?.account.igId).toBeUndefined();
    expect(codewild?.visibilityClass).toBe(MentionVisibilityClass.METADATA_ONLY);
    // taken_at_raw string → ISO; observedAt is fixed.
    expect(story.takenAt).toBe(new Date((NOW_EPOCH - 23 * 3600) * 1000).toISOString());
    expect(story.meta.confidence).toBe("MEDIUM");
  });

  it("reports an empty tray as AVAILABLE [] — a positive observation, not an error", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ user_info: SEL_USER_INFO, stories: [], message: null, ticket: 12, queue: null })],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    if (result.status !== CapabilityStatus.AVAILABLE) return;
    expect(result.data).toEqual([]);
  });

  it("refuses a private profile with UNAVAILABLE and no rows", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [
        ok({ user_info: { ...SEL_USER_INFO, is_private: true }, stories: [], message: null }),
      ],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(result.note).toMatch(/private/i);
    expect(result.status).not.toBe(CapabilityStatus.AVAILABLE);
  });

  it("carries the server's 'User not found' through as ACCOUNT_NOT_FOUND, non-retryable", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ message: "User not found", user_info: null })],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain("User not found");
  });

  it("treats a numeric ticket with no subject/message as an invalid username", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ message: null, ticket: 20, user_info: null })],
    });
    const result = await provider.getStories({ username: "x y z" });
    // Never even reaches the wire: not a possible username.
    expect(result.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(result.error?.message).toMatch(/not a possible Instagram username/);

    const { provider: p2 } = providerWith({
      "/api/v1/story": [ok({ message: null, ticket: 20, user_info: null })],
    });
    const wire = await p2.getStories(account);
    expect(wire.status).toBe(CapabilityStatus.ERROR);
    expect(wire.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(wire.error?.retryable).toBe(false);
  });

  it("rejects a decoy answer as PROVIDER_ERROR, non-retryable — never stores it", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [
        ok({
          user_info: { ...SEL_USER_INFO, username: "online", id: 1 },
          stories: [{ id: "1", source: "https://example/no-image.jpeg" }],
          ticket: 1,
        }),
      ],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.PROVIDER_ERROR);
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toMatch(/placeholder|decoy/i);
  });

  it("retries the 429 ladder, then reports RATE_LIMITED — never an empty tray", async () => {
    const limited: AnonHttpResponse = { status: 429, body: '{"message":"Too many requests"}' };
    const { provider, calls } = providerWith({
      "/api/v1/story": [limited, limited, limited, limited],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.RATE_LIMITED);
    expect(result.error?.retryable).toBe(true);
    // Initial call + one retry per ladder step ([1, 1] ms under test).
    expect(calls.length).toBe(3);
  });

  it("waits out a queue epoch and re-posts, then answers", async () => {
    const { provider, calls } = providerWith({
      "/api/v1/story": [
        ok({ queue: NOW_EPOCH + 2, message: null }),
        ok({ user_info: SEL_USER_INFO, stories: [] }),
      ],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(calls.length).toBe(2);
  });

  it("gives up on a queue epoch beyond the bound with TIMEOUT — never partial data", async () => {
    const { provider } = providerWith(
      {
        "/api/v1/story": [ok({ queue: NOW_EPOCH + 3600, message: null })],
      },
      { queueBoundMs: 5_000 },
    );
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.TIMEOUT);
    expect(result.error?.retryable).toBe(true);
  });

  it("skips an item with no readable timestamp and reports PARTIAL with the reason", async () => {
    const noTimestamp = { ...STORY_ITEM_MISALIGNED };
    delete (noTimestamp as Record<string, unknown>).taken_at_raw;
    const { provider } = providerWith({
      "/api/v1/story": [ok({ user_info: SEL_USER_INFO, stories: [noTimestamp] })],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.note).toMatch(/publication timestamp/);
  });

  it("keeps every unavailable class explicitly unavailable with its reason", async () => {
    const { provider } = providerWith({});
    const post = {
      postId: "1",
      meta: { observedAt: FIXED_NOW.toISOString(), source: { sourceId: "anonstories:v1", kind: SourceKind.PUBLIC_AGGREGATOR } },
    } as never;
    for (const [name, result] of [
      ["getFollowers", await provider.getFollowers(account as never)],
      ["getFollowing", await provider.getFollowing(account as never)],
      ["getPublicPosts", await provider.getPublicPosts(account as never)],
      ["getTags", await provider.getTags(account as never)],
      ["getAccountInsights", await provider.getAccountInsights(account as never)],
    ] as const) {
      expect(result.status, name).toBe(CapabilityStatus.UNAVAILABLE);
      expect(result.note, name).toBeTruthy();
    }
    expect((await provider.getPublicComments(post)).status).toBe(CapabilityStatus.UNAVAILABLE);
  });

  it("declares exactly the capabilities it can answer", () => {
    const { provider } = providerWith({});
    const caps = provider.capabilities();
    expect(caps.getStories).toBe(true);
    expect(caps.getProfile).toBe(true);
    expect(caps.resolveAccount).toBe(true);
    expect(caps.getFollowers).toBe(false);
    expect(caps.getFollowing).toBe(false);
    expect(caps.getPublicPosts).toBe(false);
    expect(caps.getAccountInsights).toBe(false);
    expect(caps.discoverAccount).toBe(false);
  });
});

describe("AnonStoriesProvider — dossier", () => {
  function dossierScript(highlightResponses?: AnonHttpResponse[]): Record<string, AnonHttpResponse[]> {
    return {
      "/api/v1/story": [
        ok({
          user_info: SEL_USER_INFO,
          stories: [STORY_ITEM_MISALIGNED],
          message: null,
          ticket: 39,
          queue: null,
        }),
      ],
      "/api/v1/highlights": [ok({ user_info: SEL_USER_INFO, highlights: HIGHLIGHT_REFS, message: null })],
      "/api/v1/highlight/stories":
        highlightResponses ??
        [
          ok({
            title: "EVENT",
            cover_media: { thumbnail_src: "https://embed.example/event.jpg" },
            items: [HIGHLIGHT_ITEM],
          }),
          ok({
            title: "CWT",
            items: [
              {
                ...HIGHLIGHT_ITEM,
                id: "3555100000000000002_67606942730",
                mentions: ["pradheeshjp", "extra.account"],
                mentioned_users: [
                  { pk: "5325615985", username: "pradheeshjp", is_private: true },
                ],
              },
            ],
          }),
        ],
    };
  }

  it("builds the full dossier: stories, highlight contents, mention index", async () => {
    const { provider, calls } = providerWith(dossierScript());
    const result = await provider.getDossier("sel_win_");
    expect(result.status).not.toBe(CapabilityStatus.ERROR);
    const dossier = result.dossier;
    if (dossier === undefined) throw new Error(`no dossier: ${JSON.stringify(result.error)}`);

    expect(dossier.username).toBe("sel_win_");
    expect(dossier.source.kind).toBe(SourceKind.PUBLIC_AGGREGATOR);
    expect(dossier.source.origin).toBe("https://anonstories.com");
    expect(dossier.source.retrieval).toBe("injected-transport");
    expect(dossier.stories).toHaveLength(1);
    expect(dossier.counts.activeStories).toBe(1);
    expect(dossier.counts.highlights).toBe(2);
    expect(dossier.counts.highlightContentsRead).toBe(2);

    // Highlight contents parsed: the timestamp field differs from stories
    // (taken_at_timestamp, a number) and must convert too.
    const event = dossier.highlights.find((h) => h.title === "EVENT");
    expect(event?.status).toBe("READ");
    expect(event?.itemCount).toBe(1);
    expect(event?.items[0]?.publishedAt).toBe(
      new Date((NOW_EPOCH - 63072000) * 1000).toISOString(),
    );

    // The mention index merges story + highlight mentions by username. The
    // hidden mention from the CWT highlight is present with its profile data.
    const pradheesh = dossier.mentions.find((m) => m.username === "pradheeshjp");
    expect(pradheesh).toBeDefined();
    expect(pradheesh?.isPrivate).toBe(true);
    expect(pradheesh?.pk).toBe("5325615985");
    expect(pradheesh?.seenIn).toEqual(["highlight:EVENT", "highlight:CWT"]);
    expect(dossier.counts.mentionedAccounts).toBe(dossier.mentions.length);

    // Request order: story, highlight list, then one call per highlight, all
    // on one session; the highlight auth embeds the account id + highlight id.
    expect(calls.map((c) => c.endpoint)).toEqual([
      "/api/v1/story",
      "/api/v1/highlights",
      "/api/v1/highlight/stories",
      "/api/v1/highlight/stories",
    ]);
    expect(calls[2]?.auth).toBe(anonHighlightStoriesAuth(67606942730, "sel_win_", "18481412830118583"));
    expect(calls[3]?.auth).toBe(anonHighlightStoriesAuth(67606942730, "sel_win_", "18116370953113785"));

    // Coverage states every unavailable class explicitly.
    const rosters = dossier.coverage.find((r) => r.subject.includes("rosters"));
    expect(rosters?.status).toBe("UNAVAILABLE");
    expect(rosters?.reason).toBeTruthy();
    expect(dossier.gaps.length).toBeGreaterThan(0);
    expect(dossier.notes.join(" ")).toMatch(/PUBLIC_AGGREGATOR/);
  });

  it("bounds highlight reads and reports the rest UNAVAILABLE with the bound reason", async () => {
    const { provider } = providerWith(
      {
        ...dossierScript(),
        "/api/v1/highlights": [
          ok({
            user_info: SEL_USER_INFO,
            highlights: [...HIGHLIGHT_REFS, { node: { id: "999", title: "THIRD" } }],
          }),
        ],
      },
      { maxHighlights: 2 },
    );
    const result = await provider.getDossier("sel_win_");
    const dossier = result.dossier;
    if (dossier === undefined) throw new Error("no dossier");
    const third = dossier.highlights.find((h) => h.id === "999");
    expect(third?.status).toBe("UNAVAILABLE");
    expect(third?.reason).toMatch(/bounded to 2/);
    expect(dossier.gaps.some((g) => g.subject.includes("beyond the bound"))).toBe(true);
    expect(dossier.counts.highlightContentsRead).toBe(2);
  });

  it("marks a rate-limited highlight UNAVAILABLE and records the gap", async () => {
    const limited: AnonHttpResponse = { status: 429, body: '{"message":"Too many requests"}' };
    const { provider } = providerWith(
      dossierScript([ok({ title: "EVENT", items: [HIGHLIGHT_ITEM] }), limited, limited, limited]),
      { maxHighlights: 2 },
    );
    const result = await provider.getDossier("sel_win_");
    const dossier = result.dossier;
    if (dossier === undefined) throw new Error("no dossier");
    const cwt = dossier.highlights.find((h) => h.title === "CWT");
    expect(cwt?.status).toBe("UNAVAILABLE");
    expect(cwt?.reason).toMatch(/rate-limit/i);
    expect(dossier.gaps.some((g) => g.subject.includes("rate limit"))).toBe(true);
  });

  it("reports a private profile as an unavailable dossier, no rows", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [
        ok({ user_info: { ...SEL_USER_INFO, is_private: true }, stories: [], message: null }),
      ],
    });
    const result = await provider.getDossier("sel_win_");
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(result.dossier).toBeUndefined();
    expect(result.note).toMatch(/private/i);
  });

  it("surfaces a highlight-list failure as an explicit gap, not as 'no highlights'", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [ok({ user_info: SEL_USER_INFO, stories: [] })],
      "/api/v1/highlights": [{ status: 403, body: "forbidden" }],
    });
    const result = await provider.getDossier("sel_win_");
    const dossier = result.dossier;
    if (dossier === undefined) throw new Error("no dossier");
    expect(dossier.counts.highlights).toBe(0);
    const row = dossier.coverage.find((r) => r.subject === "Highlights (list)");
    expect(row?.status).toBe("UNAVAILABLE");
    expect(row?.reason).toBeTruthy();
  });

  it("rejects a malformed envelope with SCHEMA_MISMATCH, not data", async () => {
    const { provider } = providerWith({
      "/api/v1/story": [{ status: 200, body: "<html>challenge</html>" }],
    });
    const result = await provider.getStories(account);
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
  });
});

describe("anonstories transport guardrails", () => {
  it("fails fast at construction when no browser is available", () => {
    expect(
      () => new AnonStoriesProvider({ chromePath: "C:\\nonexistent\\chrome.exe" }),
    ).toThrow(/Chrome|browser/i);
  });

  it("does not fail construction when a transport is injected (tests, fixtures)", () => {
    const { provider } = providerWith({});
    expect(provider.sourceId).toBe("anonstories:v1");
  });

  it.runIf(findChrome() !== undefined)("refuses to launch with a HeadlessChrome UA", async () => {
    // The decoy trigger is the UA string; the transport must refuse it at
    // construction rather than ingest fabricated data.
    const { openAnonStoriesChrome } = await import("../src/public/anonstories-chrome.js");
    await expect(
      openAnonStoriesChrome({
        userAgent: "Mozilla/5.0 HeadlessChrome/156.0.0.0 Safari/537.36",
      }),
    ).rejects.toThrow(/desktop user agent/i);
  });
});

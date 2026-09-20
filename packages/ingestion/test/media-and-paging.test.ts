import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityStatus } from "@igtrack/core";
import {
  FixtureProvider,
  GraphProvider,
  graphConfigFromEnv,
  mapGraphMediaType,
  mapRawMediaType,
  normalizePosts,
  shortcodeFromPermalink,
} from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/v1", import.meta.url));

const ENV = {
  IGTRACK_GRAPH_ACCESS_TOKEN: "test-token",
  IGTRACK_GRAPH_IG_USER_ID: "12345",
  IGTRACK_GRAPH_USERNAME: "owned.account",
};

function graphProvider() {
  return new GraphProvider(graphConfigFromEnv({ ...ENV }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media type mapping", () => {
  it("maps raw fixture tokens, unknown stays UNKNOWN", () => {
    expect(mapRawMediaType("IMAGE")).toBe("IMAGE");
    expect(mapRawMediaType("video")).toBe("VIDEO");
    expect(mapRawMediaType("CAROUSEL_ALBUM")).toBe("CAROUSEL");
    expect(mapRawMediaType("carousel")).toBe("CAROUSEL");
    expect(mapRawMediaType("whatever")).toBe("UNKNOWN");
  });

  it("maps graph media tokens, absent stays UNKNOWN", () => {
    expect(mapGraphMediaType("IMAGE")).toBe("IMAGE");
    expect(mapGraphMediaType("VIDEO")).toBe("VIDEO");
    expect(mapGraphMediaType("CAROUSEL_ALBUM")).toBe("CAROUSEL");
    expect(mapGraphMediaType(undefined)).toBe("UNKNOWN");
    expect(mapGraphMediaType(" resilient ")).toBe("UNKNOWN");
  });

  it("derives shortcodes from permalinks, never guesses", () => {
    expect(shortcodeFromPermalink("https://www.instagram.com/p/AxYz001/")).toBe("AxYz001");
    expect(shortcodeFromPermalink("https://www.instagram.com/reel/Db_12-x/")).toBe("Db_12-x");
    expect(shortcodeFromPermalink("https://www.instagram.com/tv/AbC/")).toBe("AbC");
    expect(shortcodeFromPermalink(undefined)).toBeUndefined();
    expect(shortcodeFromPermalink("https://www.instagram.com/owned.account/")).toBeUndefined();
  });

  it("preserves permalinks verbatim and omits them when absent", () => {
    const [withLink, withoutLink] = normalizePosts({
      schema_version: "v1",
      captured_at: "2026-08-27T09:15:00.000Z",
      next_cursor: null,
      posts: [
        {
          id: "p1",
          taken_at: "2026-08-20T10:00:00.000Z",
          permalink: "https://www.instagram.com/p/AxYz001/",
        },
        { id: "p2", taken_at: "2026-08-20T10:00:00.000Z" },
      ],
    });
    expect(withLink?.permalink).toBe("https://www.instagram.com/p/AxYz001/");
    expect(withoutLink && "permalink" in withoutLink).toBe(false);
  });
});

describe("graph stories carry the declared media type", () => {
  it("maps VIDEO instead of degrading to UNKNOWN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "s-1", timestamp: "2026-08-26T10:00:00+0000", media_type: "VIDEO" }],
        }),
      ),
    );
    const result = await graphProvider().getStories({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.[0]?.mediaType).toBe("VIDEO");
    // Other story surfaces stay degraded until the API exposes them.
    expect(result.data?.[0]?.mentions).toEqual([]);
    expect(result.confidence).toBe("MEDIUM");
  });
});

describe("graph posts preserve media typing, shortcode, and cursors", () => {
  it("returns PARTIAL with nextCursor when more pages exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "m-1",
              caption: "reel here",
              timestamp: "2026-08-20T10:00:00+0000",
              permalink: "https://www.instagram.com/reel/Db_12-x/",
              media_type: "VIDEO",
              media_product_type: "REELS",
            },
          ],
          paging: { cursors: { after: "cursor-2" } },
        }),
      ),
    );
    const result = await graphProvider().getPublicPosts({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.data?.[0]?.shortcode).toBe("Db_12-x");
    expect(result.data?.[0]?.mediaType).toBe("VIDEO");
    expect(result.data?.[0]?.mediaProductType).toBe("REELS");
  });

  it("returns AVAILABLE with no cursor key on the terminal page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "m-2",
              timestamp: "2026-08-19T10:00:00+0000",
              permalink: "https://www.instagram.com/p/AxYz001/",
              media_type: "CAROUSEL_ALBUM",
              media_product_type: "FEED",
            },
          ],
        }),
      ),
    );
    const result = await graphProvider().getPublicPosts({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.nextCursor).toBeUndefined();
    expect(result.data?.[0]?.shortcode).toBe("AxYz001");
    expect(result.data?.[0]?.mediaType).toBe("CAROUSEL");
  });

  it("sends the cursor back as the after parameter", async () => {
    const fetchSpy = vi.fn(async (url: unknown) => {
      void url;
      return jsonResponse({ data: [] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await graphProvider().getPublicPosts({ username: "owned.account" }, { value: "cursor-2" });
    const requested = fetchSpy.mock.calls[0]?.[0];
    expect(String(requested)).toContain("after=cursor-2");
  });
});

describe("graph comments surface paging instead of truncating silently", () => {
  it("returns PARTIAL with nextCursor when more comment pages exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "c-1", text: "hi", username: "fan.one", timestamp: "2026-08-20T11:00:00+0000" }],
          paging: { cursors: { after: "cc-2" } },
        }),
      ),
    );
    const result = await graphProvider().getPublicComments({
      postId: "m-1",
      takenAt: "2026-08-20T10:00:00.000Z",
      meta: { category: "OBSERVED", confidence: "HIGH", observedAt: "2026-08-20T10:00:00.000Z" },
    });
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.nextCursor).toBe("cc-2");
    expect(result.data?.[0]?.commentId).toBe("c-1");
  });

  it("returns AVAILABLE with no cursor on the terminal page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: [{ id: "c-9", text: "last", username: "fan.two" }] }),
      ),
    );
    const result = await graphProvider().getPublicComments({
      postId: "m-1",
      takenAt: "2026-08-20T10:00:00.000Z",
      meta: { category: "OBSERVED", confidence: "HIGH", observedAt: "2026-08-20T10:00:00.000Z" },
    });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("fixture posts expose continuation honestly", () => {
  it("single-file v1 set has no cursor and HIGH confidence", async () => {
    const provider = new FixtureProvider({ fixturesDir });
    const resolved = await provider.resolveAccount("aurora.wilde");
    const posts = await provider.getPublicPosts(resolved.data!);
    expect(posts.status).toBe(CapabilityStatus.AVAILABLE);
    expect(posts.confidence).toBe("HIGH");
    expect(posts.nextCursor).toBeUndefined();
    expect(posts.data).toHaveLength(2);
  });

  it("preserves the provider-supplied story link URL", async () => {
    const provider = new FixtureProvider({ fixturesDir });
    const resolved = await provider.resolveAccount("aurora.wilde");
    const stories = await provider.getStories(resolved.data!);
    const linked = stories.data?.find((s) => s.hasLink);
    expect(linked).toBeDefined();
    expect(linked?.linkUrl).toMatch(/^https:\/\//);
    const plain = stories.data?.find((s) => !s.hasLink);
    expect(plain?.linkUrl).toBeUndefined();
  });
});

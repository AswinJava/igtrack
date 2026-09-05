import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityErrorKind,
  CapabilityStatus,
  Confidence,
  ObservationCategory,
} from "@igtrack/core";
import { GraphProvider, graphConfigFromEnv } from "../src/graph/graph-provider.js";

const ENV = {
  IGTRACK_GRAPH_ACCESS_TOKEN: "test-token",
  IGTRACK_GRAPH_IG_USER_ID: "12345",
  IGTRACK_GRAPH_USERNAME: "Owned.Account",
};

function provider() {
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

describe("graphConfigFromEnv", () => {
  it("fails fast listing every missing credential without printing values", () => {
    expect(() => graphConfigFromEnv({})).toThrow(/missing required env/);
    try {
      graphConfigFromEnv({});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("IGTRACK_GRAPH_ACCESS_TOKEN");
      expect(msg).toContain("IGTRACK_GRAPH_IG_USER_ID");
      expect(msg).toContain("IGTRACK_GRAPH_USERNAME");
      expect(msg).not.toContain("test-token");
    }
  });
});

describe("GraphProvider hostile responses", () => {
  it("maps non-JSON 200 bodies to a typed error without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway nonsense</html>", { status: 200 })),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    // INTERNAL + non-retryable: a body that is not JSON is a broken response,
    // failed fast with a typed error. Recovery happens at scheduler-cadence
    // (fresh windows keep enqueueing), not via hot retry of a broken payload.
    expect(result.error?.kind).toBe(CapabilityErrorKind.INTERNAL);
    expect(result.error?.retryable).toBe(false);
  });

  it("treats wrong-shape JSON as missing data, never fabricated rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: "not-an-array" })));
    const stories = await provider().getStories({ username: "owned.account" });
    // data ?? [] collapses only when the envelope parses; a wrong shape must
    // not throw out of the provider boundary.
    expect(
      stories.status === CapabilityStatus.AVAILABLE || stories.status === CapabilityStatus.ERROR,
    ).toBe(true);
    if (stories.status === CapabilityStatus.AVAILABLE) {
      expect(stories.data).toEqual([]);
    }
  });

  it("maps 500 to a retryable provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "boom", code: 1 } }, 500)),
    );
    const result = await provider().getPublicPosts({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.retryable).toBe(true);
  });

  it("rejects absurdly long usernames before any network call", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchSpy);
    const miss = await provider().resolveAccount(`x${"y".repeat(500)}`);
    // Fixture-style honesty for graph too: unknown names never probe.
    expect(miss.status).toBe(CapabilityStatus.ERROR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GraphProvider", () => {
  it("declares follow lists unavailable without any network call", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchSpy);
    const p = provider();
    expect(p.capabilities().getFollowers).toBe(false);
    expect(p.capabilities().getFollowing).toBe(false);
    const followers = await p.getFollowers({ username: "owned.account" });
    expect(followers.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves only the owned account; others are ACCOUNT_NOT_FOUND without fetch", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchSpy);
    const p = provider();
    const miss = await p.resolveAccount("someone.else");
    expect(miss.status).toBe(CapabilityStatus.ERROR);
    expect(miss.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "12345", username: "owned.account" })),
    );
    const hit = await p.resolveAccount("Owned.Account");
    expect(hit.status).toBe(CapabilityStatus.AVAILABLE);
    expect(hit.data?.igId).toBe("12345");
  });

  it("maps 401 to non-retryable AUTH_REQUIRED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 401),
      ),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.AUTH_REQUIRED);
    expect(result.error?.retryable).toBe(false);
  });

  it("maps 429 to retryable RATE_LIMITED with the Retry-After delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "throttled" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after": "120" },
          }),
      ),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.RATE_LIMITED);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.retryAfterMs).toBe(120_000);
  });

  it("sends the token in the Authorization header, never in the URL", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ id: "12345", username: "owned.account" }));
    vi.stubGlobal("fetch", fetchSpy);
    await provider().resolveAccount("owned.account");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).not.toContain("test-token");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("declares the children capability and fetches album items from the edge", async () => {
    const seenUrls: string[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      seenUrls.push(String(url));
      return jsonResponse({
        data: [
          {
            id: "child-1",
            media_type: "IMAGE",
            permalink: "https://www.instagram.com/p/AxYz001/",
            shortcode: "Direct9",
            timestamp: "2026-08-20T10:00:00+0000",
          },
          { id: "child-2", media_type: "VIDEO" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const p = provider();
    expect(p.capabilities().getPostChildren).toBe(true);
    const result = await p.getPostChildren({
      postId: "album-1",
      takenAt: "2026-08-20T10:00:00.000Z",
      mediaType: "CAROUSEL",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: "2026-08-20T10:00:00.000Z",
      },
    });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data).toHaveLength(2);
    expect(result.data?.[0]).toMatchObject({
      childId: "child-1",
      mediaType: "IMAGE",
      shortcode: "Direct9",
      permalink: "https://www.instagram.com/p/AxYz001/",
      takenAt: "2026-08-20T10:00:00+0000",
    });
    // Sparse child: only the id survives, nothing fabricated.
    expect(result.data?.[1]).toEqual({ childId: "child-2", mediaType: "VIDEO" });
    // Dedicated edge per album, isolated from the /media listing call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(seenUrls[0]).toContain("/album-1/children");
  });

  it("maps children-edge failures without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "unsupported", code: 100 } }, 400)),
    );
    const result = await provider().getPostChildren({
      postId: "album-1",
      takenAt: "2026-08-20T10:00:00.000Z",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: "2026-08-20T10:00:00.000Z",
      },
    });
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
  });

  it("normalizes owned media into posts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "m-1",
              caption: "hello",
              timestamp: "2026-08-20T10:00:00+0000",
              like_count: 5,
              comments_count: 1,
            },
          ],
        }),
      ),
    );
    const result = await provider().getPublicPosts({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.[0]?.postId).toBe("m-1");
    expect(result.data?.[0]?.likeCount).toBe(5);
    expect(result.data?.[0]?.commentCount).toBe(1);
  });

  it("maps the documented website field to externalUrl, absent stays absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ id: "12345", username: "owned.account", website: "https://example.com" }),
      ),
    );
    const hit = await provider().getProfile({ username: "owned.account" });
    expect(hit.status).toBe(CapabilityStatus.AVAILABLE);
    expect(hit.data?.externalUrl).toBe("https://example.com");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "12345", username: "owned.account" })),
    );
    const bare = await provider().getProfile({ username: "owned.account" });
    expect(bare.status).toBe(CapabilityStatus.AVAILABLE);
    expect(bare.data?.externalUrl).toBeUndefined();
  });

  it("prefers the provider shortcode over permalink parsing, with fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "m-1",
              permalink: "https://www.instagram.com/p/Parsed001/",
              shortcode: "Direct002",
              timestamp: "2026-08-20T10:00:00+0000",
            },
            {
              id: "m-2",
              permalink: "https://www.instagram.com/p/Parsed003/",
              timestamp: "2026-08-20T10:00:00+0000",
            },
          ],
        }),
      ),
    );
    const result = await provider().getPublicPosts({ username: "owned.account" });
    expect(result.data?.[0]?.shortcode).toBe("Direct002");
    expect(result.data?.[0]?.permalink).toBe("https://www.instagram.com/p/Parsed001/");
    expect(result.data?.[1]?.shortcode).toBe("Parsed003");
  });

  it("flattens replies-expansion comments into threaded rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            {
              id: "c-1",
              text: "top",
              username: "alice",
              timestamp: "2026-08-20T10:00:00+0000",
              like_count: 4,
              from: { id: "ig-alice", username: "alice" },
              replies: {
                data: [
                  {
                    id: "c-2",
                    text: "reply",
                    username: "bob",
                    timestamp: "2026-08-20T11:00:00+0000",
                    like_count: 0,
                    from: { id: "ig-bob", username: "bob" },
                  },
                  { id: "c-3", timestamp: "2026-08-20T12:00:00+0000" },
                ],
              },
            },
            {
              id: "c-4",
              text: "flat with parent",
              parent_id: "c-1",
              timestamp: "2026-08-20T13:00:00+0000",
            },
          ],
        }),
      ),
    );
    const result = await provider().getPublicComments({
      postId: "m-1",
      takenAt: "2026-08-20T10:00:00.000Z",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: "2026-08-20T10:00:00.000Z",
      },
    });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const byId = new Map((result.data ?? []).map((c) => [c.commentId, c]));
    expect(byId.get("c-1")?.inReplyToCommentId).toBeUndefined();
    expect(byId.get("c-1")?.likeCount).toBe(4);
    expect(byId.get("c-1")?.author).toMatchObject({ username: "alice", igId: "ig-alice" });
    // Nested replies attach to the enclosing comment; zero likes preserved.
    expect(byId.get("c-2")?.inReplyToCommentId).toBe("c-1");
    expect(byId.get("c-2")?.likeCount).toBe(0);
    // Sparse reply: no username anywhere degrades to unknown, never throws.
    expect(byId.get("c-3")?.author.username).toBe("unknown");
    expect(byId.get("c-3")?.inReplyToCommentId).toBe("c-1");
    // Explicit parent_id honored on top-level rows.
    expect(byId.get("c-4")?.inReplyToCommentId).toBe("c-1");
    expect(byId.get("c-4")?.likeCount).toBeUndefined();
  });

  it("maps story captions when the provider returns them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "s-1", timestamp: "2026-08-20T10:00:00+0000", media_type: "IMAGE", caption: "hi" }],
        }),
      ),
    );
    const result = await provider().getStories({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.[0]?.caption).toBe("hi");
  });
});

describe("GraphProvider failure modes", () => {
  it("maps 403 to non-retryable FORBIDDEN (insufficient permission)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "insufficient permission", code: 200 } }, 403)),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.FORBIDDEN);
    expect(result.error?.retryable).toBe(false);
  });

  it("maps network failures to retryable NETWORK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.NETWORK);
    expect(result.error?.retryable).toBe(true);
  });

  it("maps timeouts to retryable TIMEOUT", async () => {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw err;
      }),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.TIMEOUT);
    expect(result.error?.retryable).toBe(true);
  });

  it("maps 429 without Retry-After to retryable RATE_LIMITED with no delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "throttled" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const result = await provider().getProfile({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.RATE_LIMITED);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.retryAfterMs).toBeUndefined();
  });

  it("treats private-looking and deleted-looking usernames as ACCOUNT_NOT_FOUND without fetch", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchSpy);
    for (const name of ["private.person", "deleted_account_99", "someone.else"]) {
      const miss = await provider().resolveAccount(name);
      expect(miss.status).toBe(CapabilityStatus.ERROR);
      expect(miss.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    }
    // The owned-account-only gate never probes: no request for any of them.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a malformed paging envelope as a complete listing, never a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: [{ id: "m-1", timestamp: "2026-08-20T10:00:00+0000" }], paging: "garbage" }),
      ),
    );
    const result = await provider().getPublicPosts({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data).toHaveLength(1);
  });

  it("maps stories-edge rejection to UNAVAILABLE, not a scan failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "unsupported request", code: 100 } }, 400)),
    );
    const result = await provider().getStories({ username: "owned.account" });
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
  });
});

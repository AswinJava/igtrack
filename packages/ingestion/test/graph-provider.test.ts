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

  it("maps documented 400/404 to UNAVAILABLE on EVERY method, not just some", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "unsupported request", code: 100 } }, 400)),
    );
    const profile = await provider().getProfile({ username: "owned.account" });
    expect(profile.status).toBe(CapabilityStatus.UNAVAILABLE);
    const posts = await provider().getPublicPosts({ username: "owned.account" });
    expect(posts.status).toBe(CapabilityStatus.UNAVAILABLE);
    const resolved = await provider().resolveAccount("owned.account");
    expect(resolved.status).toBe(CapabilityStatus.UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Account insights (D36–D41). The contract under test is not "the numbers come
// out" but "a metric the platform did not return becomes an ABSENCE with a
// reason, and a temporary failure never masquerades as one".
// ---------------------------------------------------------------------------

describe("GraphProvider account insights", () => {
  const account = { username: "owned.account" };

  it("splits calls by documented metric_type and normalizes every response shape", async () => {
    const seen: URL[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      seen.push(url);
      const metric = url.searchParams.get("metric") ?? "";
      if (metric === "follower_count,reach") {
        return jsonResponse({
          data: [
            {
              name: "follower_count",
              period: "day",
              values: [
                { value: 101, end_time: "2026-08-26T07:00:00+0000" },
                { value: 102, end_time: "2026-08-27T07:00:00+0000" },
              ],
            },
            {
              name: "reach",
              period: "day",
              values: [{ value: 55, end_time: "2026-08-27T07:00:00+0000" }],
            },
          ],
        });
      }
      if (metric === "accounts_engaged,total_interactions,views") {
        return jsonResponse({
          data: [
            { name: "accounts_engaged", period: "day", total_value: { value: 3421 } },
            { name: "total_interactions", period: "day", total_value: { value: 5187 } },
            { name: "views", period: "day", total_value: { value: 28450 } },
          ],
        });
      }
      return jsonResponse({
        data: [
          {
            name: "follower_demographics",
            period: "lifetime",
            total_value: {
              breakdowns: [
                {
                  dimension_keys: ["timeframe", "country"],
                  results: [
                    { dimension_values: ["this_month", "US"], value: 4210 },
                    { dimension_values: ["this_month", "DE"], value: 2310 },
                  ],
                },
              ],
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const p = provider();
    expect(p.capabilities().getAccountInsights).toBe(true);
    const result = await p.getAccountInsights(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    // Three calls produced this set, so there is no single transported raw
    // representation to hash — a normalized hash must not pretend to be one.
    expect(result.rawPayloadHash).toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const timeSeries = seen.find((u) => u.searchParams.get("metric_type") === "time_series");
    expect(timeSeries?.searchParams.get("metric")).toBe("follower_count,reach");
    expect(timeSeries?.searchParams.get("period")).toBe("day");
    const since = Number(timeSeries?.searchParams.get("since"));
    const until = Number(timeSeries?.searchParams.get("until"));
    expect(until - since).toBe(30 * 24 * 60 * 60);

    const totals = seen.find(
      (u) => u.searchParams.get("metric") === "accounts_engaged,total_interactions,views",
    );
    expect(totals?.searchParams.get("metric_type")).toBe("total_value");

    const demographics = seen.find(
      (u) => u.searchParams.get("metric") === "follower_demographics",
    );
    expect(demographics?.searchParams.get("timeframe")).toBe("this_month");
    expect(demographics?.searchParams.get("breakdown")).toBe("country");

    const set = result.data!;
    expect(set.windowSince).toBeDefined();
    expect(set.windowUntil).toBeDefined();
    expect(set.absences).toEqual([]);

    const followerCount = set.points.filter((pt) => pt.metric === "follower_count");
    expect(followerCount).toHaveLength(2);
    expect(followerCount[1]).toMatchObject({
      metric: "follower_count",
      period: "day",
      endTime: "2026-08-27T07:00:00+0000",
      value: 102,
    });

    // total_value carries no bucket end: no fabricated timestamp.
    expect(set.points.find((pt) => pt.metric === "views")).toEqual({
      metric: "views",
      period: "day",
      value: 28450,
    });

    const breakdown = set.points.filter((pt) => pt.metric === "follower_demographics");
    expect(breakdown).toHaveLength(2);
    // The timeframe is a qualifier on the claim, not a dimension value.
    expect(breakdown[0]).toEqual({
      metric: "follower_demographics",
      period: "lifetime",
      timeframe: "this_month",
      dimension: "country",
      dimensionValue: "US",
      value: 4210,
    });
  });

  it("records a metric the platform did not return as an absence with a reason, never a zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        const metric = url.searchParams.get("metric") ?? "";
        if (metric === "follower_count,reach") {
          // reach is documented time_series-capable but is missing entirely.
          return jsonResponse({
            data: [
              {
                name: "follower_count",
                period: "day",
                values: [{ value: 12480, end_time: "2026-08-27T00:00:00+0000" }],
              },
            ],
          });
        }
        if (metric === "accounts_engaged,total_interactions,views") {
          // Documented behavior: an empty data set instead of 0.
          return jsonResponse({ data: [] });
        }
        return jsonResponse({
          data: [
            {
              name: "follower_demographics",
              period: "lifetime",
              total_value: { breakdowns: [{ dimension_keys: ["country"], results: [] }] },
            },
          ],
        });
      }),
    );

    const result = await provider().getAccountInsights(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const set = result.data!;

    expect(set.points.map((pt) => pt.metric)).toEqual(["follower_count"]);
    expect(set.points[0]?.value).toBe(12480);
    expect(set.absences.map((a) => a.metric).sort()).toEqual([
      "accounts_engaged",
      "follower_demographics",
      "reach",
      "total_interactions",
      "views",
    ]);
    // Every absence carries a reason, and an absent metric has no point at all.
    expect(set.absences.every((a) => a.reason.length > 20)).toBe(true);
    for (const absence of set.absences) {
      expect(set.points.some((pt) => pt.metric === absence.metric)).toBe(false);
    }
    // The documented below-100-followers gate is named where it applies.
    expect(
      set.absences.find((a) => a.metric === "follower_demographics")?.reason,
    ).toContain("fewer than 100 followers");
  });

  it("turns a structural 400 on one call into absences for that call only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        const metric = url.searchParams.get("metric") ?? "";
        if (metric === "follower_count,reach") {
          return jsonResponse(
            { error: { message: "Unsupported metric follower_count", code: 100 } },
            400,
          );
        }
        if (metric === "accounts_engaged,total_interactions,views") {
          return jsonResponse({
            data: [{ name: "views", period: "day", total_value: { value: 28450 } }],
          });
        }
        return jsonResponse({
          data: [
            {
              name: "follower_demographics",
              period: "lifetime",
              total_value: {
                breakdowns: [
                  {
                    dimension_keys: ["country"],
                    results: [{ dimension_values: ["US"], value: 4210 }],
                  },
                ],
              },
            },
          ],
        });
      }),
    );

    const result = await provider().getAccountInsights(account);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const set = result.data!;
    // The two calls that answered still contribute their claims.
    expect(set.points.map((pt) => pt.metric).sort()).toEqual([
      "follower_demographics",
      "views",
    ]);
    const refused = set.absences.filter(
      (a) => a.metric === "follower_count" || a.metric === "reach",
    );
    expect(refused).toHaveLength(2);
    expect(refused.every((a) => a.reason.includes("refused this metric request"))).toBe(true);
    expect(set.absences.map((a) => a.metric).sort()).toEqual([
      "accounts_engaged",
      "follower_count",
      "reach",
      "total_interactions",
    ]);
  });

  it("never records a temporary failure as a platform absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.searchParams.get("metric_type") === "time_series") {
          return jsonResponse({
            data: [
              {
                name: "reach",
                period: "day",
                values: [{ value: 9, end_time: "2026-08-27T00:00:00+0000" }],
              },
            ],
          });
        }
        return jsonResponse({ error: { message: "throttled" } }, 429);
      }),
    );

    const result = await provider().getAccountInsights(account);
    // "Could not look" is not "the platform does not expose this" (invariant 2).
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.RATE_LIMITED);
    expect(result.error?.retryable).toBe(true);
    expect(result.data).toBeUndefined();
  });
});

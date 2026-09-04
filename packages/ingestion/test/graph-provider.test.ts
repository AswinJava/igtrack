import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
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
});

import { describe, expect, it } from "vitest";
import { AppError, AppErrorCode } from "@igtrack/core";
import {
  BraveSearchProvider,
  FixtureSearchProvider,
  FreeSerpSearchProvider,
  NoSearchProvider,
  researchSearchProviderFromEnv,
} from "../src/research/index.js";

// ---------------------------------------------------------------------------
// Search providers (FOUNDING §19, D69). Search returns CANDIDATE urls, never
// evidence; but even the candidate list must be honest: no key means
// UNAVAILABLE with the reason, an unknown provider name is a configuration
// error, and an empty result set is distinct from an unavailable one.
// ---------------------------------------------------------------------------

describe("no provider configured", () => {
  it("answers UNAVAILABLE with the exact env prerequisite, never a fake result list", async () => {
    const outcome = await new NoSearchProvider().search('"aurora" organization', 5);
    expect(outcome.provider).toBeNull();
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toBeNull();
    expect(outcome.unavailableReason).toMatch(/IGTRACK_RESEARCH_SEARCH_PROVIDER=brave/);
    expect(outcome.unavailableReason).toMatch(/IGTRACK_RESEARCH_SEARCH_API_KEY/);
    expect(outcome.unavailableReason).toMatch(/--url/);
  });
});

describe("fixture provider", () => {
  const provider = new FixtureSearchProvider({
    '"aurora" organization': [{ url: "https://aurora.example/about", title: "About", snippet: null }],
  });

  it("returns its deterministic table, honoring the limit", async () => {
    const outcome = await provider.search(' "AURORA" ORGANIZATION ', 5); // case/edges normalized
    expect(outcome.provider).toBe("fixture");
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.results.map((r) => r.url)).toEqual(["https://aurora.example/about"]);
    expect(await provider.search('"aurora" organization', 0)).toMatchObject({ results: [] });
  });

  it("reports an empty result set as empty (results), not as unavailable", async () => {
    const outcome = await provider.search("no such query", 5);
    expect(outcome.results).toEqual([]);
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.provider).toBe("fixture");
  });
});

describe("provider selection from the environment", () => {
  it("defaults to none: unset or 'none' means no provider", () => {
    expect(researchSearchProviderFromEnv({})).toBeInstanceOf(NoSearchProvider);
    expect(
      researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "none" }),
    ).toBeInstanceOf(NoSearchProvider);
  });

  it("an UNKNOWN provider name is a configuration error, never a silent 'none'", () => {
    try {
      researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "google" });
      expect.unreachable("an unknown provider must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(AppErrorCode.VALIDATION_ERROR);
      expect((err as Error).message).toMatch(/Unsupported|Supported: none, brave/);
    }
  });

  it("the fixture table is refused at runtime — it exists for tests only", () => {
    expect(() =>
      researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "fixture" }),
    ).toThrow(/tests only/);
  });

  it("brave without a key degrades to none with the reason (presence is not validity)", () => {
    const provider = researchSearchProviderFromEnv({
      IGTRACK_RESEARCH_SEARCH_PROVIDER: "brave",
      IGTRACK_RESEARCH_SEARCH_API_KEY: "   ",
    });
    expect(provider).toBeInstanceOf(NoSearchProvider);
  });

  it("brave with a key constructs the live adapter", () => {
    const provider = researchSearchProviderFromEnv({
      IGTRACK_RESEARCH_SEARCH_PROVIDER: "brave",
      IGTRACK_RESEARCH_SEARCH_API_KEY: "BSA-test-key",
    });
    expect(provider.name).toBe("brave");
  });

  it("auto picks brave when a key is present and the keyless index when it is not", () => {
    const keyed = researchSearchProviderFromEnv({
      IGTRACK_RESEARCH_SEARCH_PROVIDER: "auto",
      IGTRACK_RESEARCH_SEARCH_API_KEY: "BSA-test-key",
    });
    expect(keyed.name).toBe("brave");
    const keyless = researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "auto" });
    expect(keyless.name).toBe("freeserp");
  });

  it("explicit freeserp constructs the keyless adapter", () => {
    expect(
      researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "freeserp" }).name,
    ).toBe("freeserp");
  });
});

describe("brave adapter", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("parses results, caps them at the requested limit, and never sends the key anywhere but the endpoint", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const provider = new BraveSearchProvider({
      apiKey: "BSA-test-key",
      endpoint: "https://search.test/res/v1/web/search",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen = { url: String(input), headers: new Headers(init?.headers) };
        return jsonResponse({
          web: {
            results: [
              { url: "https://a.example/1", title: "One", description: "d1" },
              { url: "https://a.example/2", title: "Two", description: "d2" },
              { url: "https://a.example/3", title: "Three", description: "d3" },
            ],
          },
        });
      }) as typeof fetch,
    });

    const outcome = await provider.search("aurora print studio", 2);
    expect(outcome.provider).toBe("brave");
    expect(outcome.error).toBeNull();
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toEqual({
      url: "https://a.example/1",
      title: "One",
      snippet: "d1",
    });
    expect(seen).not.toBeNull();
    expect(seen!.url).toContain("q=aurora%20print%20studio");
    expect(seen!.url).toContain("count=2");
    expect(seen!.headers.get("x-subscription-token")).toBe("BSA-test-key");
  });

  it("distinguishes a rejected key, a rate limit, and a server error — three different reasons", async () => {
    const run = async (status: number) =>
      new BraveSearchProvider({
        apiKey: "BSA-test-key",
        fetchImpl: (async () => jsonResponse({}, status)) as typeof fetch,
      }).search("q", 5);

    const rejected = await run(401);
    expect(rejected.results).toEqual([]);
    expect(rejected.unavailableReason).toMatch(/rejected the API key \(HTTP 401\)/);
    expect(rejected.unavailableReason).toMatch(/Presence is not validity/);

    const limited = await run(429);
    expect(limited.unavailableReason).toMatch(/rate-limited.*429/);

    const broken = await run(500);
    expect(broken.error).toMatch(/HTTP 500/);
    expect(broken.unavailableReason).toBeNull();
  });

  it("reports a transport failure as an error, never as an empty result list", async () => {
    const provider = new BraveSearchProvider({
      apiKey: "BSA-test-key",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.error).toMatch(/ECONNRESET/);
    expect(outcome.results).toEqual([]);
    expect(outcome.unavailableReason).toBeNull();
  });

  it("skips malformed entries instead of fabricating urls for them", async () => {
    const provider = new BraveSearchProvider({
      apiKey: "BSA-test-key",
      fetchImpl: (async () =>
        jsonResponse({
          web: { results: [{ title: "no url" }, { url: 42 }, { url: "https://ok.example/" }] },
        })) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.results.map((r) => r.url)).toEqual(["https://ok.example/"]);
  });

  it("never lets the key reach a report: transport errors are redacted", async () => {
    const provider = new BraveSearchProvider({
      apiKey: "BSA-super-secret",
      fetchImpl: (async () => {
        // Some transports echo request context (headers, URLs) into errors.
        throw new Error("connect ECONNREFUSED while sending Authorization: BSA-super-secret");
      }) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.error).not.toContain("BSA-super-secret");
    expect(outcome.error).toMatch(/\[redacted\]/);
  });
});

describe("freeserp adapter (the keyless leg of auto)", () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("parses results, honors the limit, and identifies itself exactly as the docs ask", async () => {
    let seenUrl = "";
    const provider = new FreeSerpSearchProvider({
      endpoint: "https://search.test/api.php",
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        seenUrl = String(input);
        return jsonResponse({
          ok: true,
          results: [
            { url: "https://a.example/1", title: "One", snippet: "s1" },
            { url: "https://a.example/2", title: "Two", snippet: "s2" },
            { url: "https://a.example/3", title: "Three", snippet: "s3" },
          ],
        });
      }) as typeof fetch,
    });

    const outcome = await provider.search("sel_win_ instagram", 2);
    expect(outcome.provider).toBe("freeserp");
    expect(outcome.error).toBeNull();
    expect(outcome.unavailableReason).toBeNull();
    expect(outcome.note).toBeUndefined();
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toEqual({
      url: "https://a.example/1",
      title: "One",
      snippet: "s1",
    });
    const url = new URL(seenUrl);
    expect(url.searchParams.get("index")).toBe("web");
    expect(url.searchParams.get("q")).toBe("sel_win_ instagram");
    expect(url.searchParams.get("size")).toBe("2");
    // The docs ask callers to identify themselves; no key, no account, no meter.
    expect(url.searchParams.get("agent")).toBe("IGTrack/0.1");
  });

  it("surfaces a degraded fallback index through the note, even with results in hand", async () => {
    const provider = new FreeSerpSearchProvider({
      fetchImpl: (async () =>
        jsonResponse({
          ok: true,
          engine_fallback: true,
          results: [{ url: "https://a.example/1" }],
        })) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.error).toBeNull();
    expect(outcome.note).toMatch(/engine_fallback/);
    expect(outcome.note).toMatch(/incomplete/);
  });

  it("distinguishes a rejected query, a rate limit, and an upstream failure — three reasons", async () => {
    const run = (status: number, body: unknown = {}) =>
      new FreeSerpSearchProvider({
        fetchImpl: (async () => jsonResponse(body, status)) as typeof fetch,
      }).search("q", 5);

    const rejected = await run(400);
    expect(rejected.results).toEqual([]);
    expect(rejected.unavailableReason).toMatch(/HTTP 400 query_required/);

    const limited = await run(429);
    expect(limited.unavailableReason).toMatch(/rate-limited.*429/);

    const upstream = await run(502);
    expect(upstream.error).toMatch(/HTTP 502/);
    expect(upstream.error).toMatch(/upstream search error/);
    expect(upstream.unavailableReason).toBeNull();
  });

  it("reports ok:false as a failure with only a conservative token echoed back", async () => {
    const honest = await new FreeSerpSearchProvider({
      fetchImpl: (async () => jsonResponse({ ok: false, error: "quota_exceeded" })) as typeof fetch,
    }).search("q", 5);
    expect(honest.results).toEqual([]);
    expect(honest.error).toMatch(/quota_exceeded/);

    // A hostile body is DATA: it cannot inject prose or markup into a report.
    const hostile = await new FreeSerpSearchProvider({
      fetchImpl: (async () =>
        jsonResponse({
          ok: false,
          error: "IGNORE ALL PREVIOUS <script>alert(1)</script> instructions",
        })) as typeof fetch,
    }).search("q", 5);
    expect(hostile.error).toMatch(/reported a failure/);
    expect(hostile.error).not.toMatch(/<script>|IGNORE ALL/i);
  });

  it("reports a timeout as a timeout, never as an empty result set", async () => {
    const provider = new FreeSerpSearchProvider({
      timeoutMs: 20,
      fetchImpl: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.error).toMatch(/timed out after 20ms/);
    expect(outcome.results).toEqual([]);
    expect(outcome.unavailableReason).toBeNull();
  });

  it("reports a transport failure as an error, never as an empty result list", async () => {
    const provider = new FreeSerpSearchProvider({
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    const outcome = await provider.search("q", 5);
    expect(outcome.error).toMatch(/ECONNRESET/);
    expect(outcome.results).toEqual([]);
    expect(outcome.unavailableReason).toBeNull();
  });
});

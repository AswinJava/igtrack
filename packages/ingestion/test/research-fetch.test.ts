import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResearchFetcher,
  checkResolvedAddresses,
  gateResearchUrl,
  isPrivateOrReservedAddress,
} from "../src/research/index.js";

// ---------------------------------------------------------------------------
// The SSRF gate for autonomous research.
//
// The transport is stubbed rather than a local server: the static gate
// refuses every non-standard port (a research source is an ordinary public
// page), so a socket test on a random port would contradict the very rule
// it is trying to exercise. Everything the engine itself decides — URL
// shape, host policy, DNS address policy, robots.txt, per-hop redirect
// re-validation, content-type allowlist, byte cap, timeout, status mapping —
// runs here against scripted Responses. pinLookup is the DNS seam; it feeds
// the SAME checkResolvedAddresses production uses, so nothing is weakened.
// ---------------------------------------------------------------------------

const PUBLIC_PIN = "93.184.216.34";
const pinPublic = async (): Promise<string> => PUBLIC_PIN;

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function routeTable(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const handler = routes[url.pathname];
    if (handler === undefined) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return handler(url, init);
  };
  return { impl, calls };
}

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

const redirect = (location: string): Response =>
  new Response("", { status: 302, headers: { location } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static URL gate", () => {
  it("refuses anything that is not an ordinary credential-free http(s) URL on a web port", () => {
    const cases: Array<[string, string]> = [
      ["example.com/about", "UNSAFE_URL"],
      ["ftp://example.com/file", "UNSAFE_URL"],
      ["file:///etc/passwd", "UNSAFE_URL"],
      ["https://user:pass@example.com/", "UNSAFE_URL"],
      ["https://example.com:8443/x", "UNSAFE_URL"],
      ["   ", "UNSAFE_URL"],
    ];
    for (const [raw, kind] of cases) {
      const decision = gateResearchUrl(raw);
      expect(decision.allowed, raw).toBe(false);
      if (!decision.allowed) expect(decision.kind).toBe(kind);
    }
  });

  it("refuses Instagram-family and loopback hosts before any DNS work", () => {
    const ig = gateResearchUrl("https://www.instagram.com/someone/");
    expect(ig.allowed).toBe(false);
    if (!ig.allowed) {
      expect(ig.kind).toBe("BLOCKED_BY_POLICY");
      expect(ig.reason).toMatch(/Graph API/);
    }
    const local = gateResearchUrl("http://localhost/admin");
    expect(local.allowed).toBe(false);
    if (!local.allowed) expect(local.reason).toMatch(/loopback/);
  });

  it("extends the blocklist for callers (test seam) without touching core policy", () => {
    expect(gateResearchUrl("https://pinned.test/x").allowed).toBe(true);
    const pinned = gateResearchUrl("https://pinned.test/x", ["pinned.test"]);
    expect(pinned.allowed).toBe(false);
    if (!pinned.allowed) expect(pinned.kind).toBe("BLOCKED_BY_POLICY");
    // Core policy still wins even when the extra list disagrees.
    const ig = gateResearchUrl("https://instagram.com/", ["pinned.test"]);
    expect(ig.allowed).toBe(false);
  });

  it("allows an ordinary public page", () => {
    const ok = gateResearchUrl("https://aurora.example/about?x=1");
    expect(ok.allowed).toBe(true);
    if (ok.allowed) expect(ok.url.hostname).toBe("aurora.example");
  });
});

describe("resolved-address policy", () => {
  it("refuses every private/loopback/link-local/metadata/reserved range, v4 and v6", () => {
    const unsafe = [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::10.0.0.1",
      "not-an-ip",
    ];
    for (const ip of unsafe) {
      expect(isPrivateOrReservedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateOrReservedAddress(ip), ip).toBe(false);
    }
  });

  it("requires ALL resolved addresses to be public — one private answer poisons the host", () => {
    expect(checkResolvedAddresses([])).toEqual({
      safe: false,
      reason: "hostname resolved to no addresses.",
    });
    expect(checkResolvedAddresses([PUBLIC_PIN])).toEqual({ safe: true });
    const mixed = checkResolvedAddresses([PUBLIC_PIN, "10.0.0.5"]);
    expect(mixed.safe).toBe(false);
    if (!mixed.safe) expect(mixed.reason).toMatch(/10\.0\.0\.5/);
    const metadata = checkResolvedAddresses(["169.254.169.254"]);
    expect(metadata.safe).toBe(false);
    if (!metadata.safe) expect(metadata.reason).toMatch(/metadata/);
  });
});

describe("fetchPage through the full gate", () => {
  it("fetches an allowed public page and reports honest transport metadata", async () => {
    const { impl, calls } = routeTable({
      "/ok": () => html("<html><head><title>Aurora</title></head><body>hi</body></html>"),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic }).fetchPage(
      "https://aurora.example/ok",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.httpStatus).toBe(200);
      expect(result.contentType).toMatch(/text\/html/);
      expect(result.body).toContain("<title>Aurora</title>");
      expect(result.byteSize).toBeGreaterThan(0);
      expect(result.robotsChecked).toBe(true);
      expect(result.redirectsFollowed).toBe(0);
      expect(result.finalUrl).toBe("https://aurora.example/ok");
    }
    // robots.txt was consulted (404 = no rules, RFC9309 default) and cached.
    expect(calls.filter((c) => c.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("respects robots.txt Disallow for this user-agent and says exactly that", async () => {
    const { impl } = routeTable({
      "/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /private\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      "/private/page": () => html("<html>secret</html>"),
      "/public/page": () => html("<html>open</html>"),
    });
    vi.stubGlobal("fetch", impl);
    const fetcher = new ResearchFetcher({ pinLookup: pinPublic });

    const blocked = await fetcher.fetchPage("https://aurora.example/private/page");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.kind).toBe("BLOCKED_BY_ROBOTS");
      expect(blocked.reason).toMatch(/robots\.txt disallows \/private/);
    }

    const allowed = await fetcher.fetchPage("https://aurora.example/public/page");
    expect(allowed.ok).toBe(true);
  });

  it("follows a redirect within budget and reports the hop count", async () => {
    const { impl } = routeTable({
      "/start": () => redirect("/ok"),
      "/ok": () => html("<html>landed</html>"),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic }).fetchPage(
      "https://aurora.example/start",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.redirectsFollowed).toBe(1);
  });

  it("stops a redirect chain that exceeds the hop cap", async () => {
    const { impl } = routeTable({
      "/loop": () => redirect("/loop"),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic }).fetchPage(
      "https://aurora.example/loop",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/redirect chain exceeded the 3-hop cap/);
  });

  it("re-validates EVERY redirect hop: an Instagram target is refused mid-chain", async () => {
    const { impl, calls } = routeTable({
      "/start": () => redirect("https://www.instagram.com/someone/"),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic }).fetchPage(
      "https://aurora.example/start",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("BLOCKED_BY_POLICY");
    // The gate ran before any socket: nothing was requested for that host.
    expect(calls.some((c) => c.includes("instagram"))).toBe(false);
  });

  it("re-validates a redirect onto a link-local/metadata address (DNS pin included)", async () => {
    const { impl } = routeTable({
      "/start": () => redirect("http://169.254.169.254/latest/meta-data/"),
    });
    vi.stubGlobal("fetch", impl);

    // The seam simulates DNS: the metadata literal resolves to itself.
    const result = await new ResearchFetcher({
      pinLookup: async (host) => (host === "169.254.169.254" ? host : PUBLIC_PIN),
    }).fetchPage("https://aurora.example/start");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("BLOCKED_BY_POLICY");
      expect(result.reason).toMatch(/private\/loopback\/link-local\/metadata/);
    }
  });

  it("refuses a destination whose pinned DNS answer is private — the seam cannot bypass the check", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must never be reached");
    });
    const result = await new ResearchFetcher({
      pinLookup: async () => "10.0.0.5",
    }).fetchPage("https://aurora.example/ok");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("BLOCKED_BY_POLICY");
      expect(result.reason).toMatch(/10\.0\.0\.5/);
    }
  });

  it("reports a failed DNS lookup as such, never as empty content", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must never be reached");
    });
    const result = await new ResearchFetcher({
      pinLookup: async () => {
        throw new Error("ENOTFOUND aurora.example");
      },
    }).fetchPage("https://aurora.example/ok");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("NETWORK_ERROR");
      expect(result.reason).toMatch(/ENOTFOUND/);
    }
  });

  it("without the seam, a literal loopback URL is refused by REAL DNS resolution", async () => {
    // No stubbed fetch, no pin: production path. The gate passes the URL
    // shape, then dns.lookup proves 127.0.0.1 is not a public page.
    const result = await new ResearchFetcher().fetchPage("http://127.0.0.1/");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("BLOCKED_BY_POLICY");
      expect(result.reason).toMatch(/127\.0\.0\.1/);
    }
    const localhost = await new ResearchFetcher().fetchPage("http://localhost/");
    expect(localhost.ok).toBe(false);
    if (!localhost.ok) expect(localhost.reason).toMatch(/loopback/);
  });

  it("refuses a non-HTML content type — the engine reads pages, not binaries", async () => {
    const { impl } = routeTable({
      "/file.pdf": () =>
        new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic }).fetchPage(
      "https://aurora.example/file.pdf",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("BLOCKED_CONTENT_TYPE");
  });

  it("enforces the byte cap while streaming, never trusting content-length", async () => {
    const { impl } = routeTable({
      "/big": () =>
        new Response(new Uint8Array(64 * 1024), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    vi.stubGlobal("fetch", impl);

    const result = await new ResearchFetcher({ pinLookup: pinPublic, maxBytes: 4096 }).fetchPage(
      "https://aurora.example/big",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TOO_LARGE");
      expect(result.reason).toMatch(/4096-byte per-document cap/);
    }
  });

  it("enforces the wall-clock timeout on a page that never answers", async () => {
    const { impl } = routeTable({
      "/slow": (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    vi.stubGlobal("fetch", impl);

    const started = Date.now();
    const result = await new ResearchFetcher({ pinLookup: pinPublic, timeoutMs: 250 }).fetchPage(
      "https://aurora.example/slow",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TIMEOUT");
      expect(result.reason).toMatch(/250ms per-document timeout/);
    }
  });

  it("maps HTTP statuses honestly: 404 not-found, 429 rate-limited, 5xx network error", async () => {
    const { impl } = routeTable({
      "/missing": () => new Response("", { status: 404 }),
      "/limited": () => new Response("", { status: 429 }),
      "/broken": () => new Response("", { status: 500 }),
    });
    vi.stubGlobal("fetch", impl);
    const fetcher = new ResearchFetcher({ pinLookup: pinPublic });

    const notFound = await fetcher.fetchPage("https://aurora.example/missing");
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.kind).toBe("NOT_FOUND");
      expect(notFound.httpStatus).toBe(404);
    }

    const limited = await fetcher.fetchPage("https://aurora.example/limited");
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.kind).toBe("RATE_LIMITED");

    const broken = await fetcher.fetchPage("https://aurora.example/broken");
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.kind).toBe("NETWORK_ERROR");
      expect(broken.httpStatus).toBe(500);
    }
  });
});

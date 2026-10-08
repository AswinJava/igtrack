import { describe, expect, it } from "vitest";
import type { FetchSuccess } from "@igtrack/ingestion";
import {
  BENCH_CASES,
  BENCH_GROUND_TRUTH_VERIFIED_ON,
  attributionOf,
  captureSearch,
  computeBenchMetrics,
  factSupported,
  ReplayFetcher,
  ReplaySearchProvider,
  type BenchCase,
  type BenchRecording,
} from "../src/bench.js";
import type { AuditWebDocument, AuditWebFact, AuditWebReport } from "../src/tools.js";
import { handleMentioned } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The Phase-3 evaluation harness, offline: the evaluation set's integrity,
// the support checker, attribution strength, metric arithmetic, and the
// recording/replay layer. Live measurement lives in scripts/bench-audit.ts
// (never part of this suite); the assertions here pin everything that can be
// decided without a network.
// ---------------------------------------------------------------------------

const IG_HANDLE_SHAPE = /^[a-z0-9._]{1,30}$/;

describe("benchmark evaluation set", () => {
  it("covers every category the mission names, with distinct well-formed handles", () => {
    const categories = new Set(BENCH_CASES.map((entry) => entry.category));
    expect(categories).toEqual(
      new Set([
        "ORG_LARGE_FOOTPRINT",
        "ORG_EXTERNAL_REFERENCES",
        "SHORT_OR_AMBIGUOUS",
        "HARD_TO_SEARCH",
        "NEGATIVE_NEAR_MISS",
        "NEGATIVE_NONEXISTENT",
      ]),
    );
    const handles = BENCH_CASES.map((entry) => entry.handle);
    expect(new Set(handles).size).toBe(handles.length);
    for (const handle of handles) expect(handle).toMatch(IG_HANDLE_SHAPE);
  });

  it("keeps ground truth and expectations coherent per case", () => {
    for (const entry of BENCH_CASES) {
      expect(entry.rationale.length).toBeGreaterThan(20);
      const gtUrls = new Set(entry.groundTruthPages.map((page) => page.url));
      for (const page of entry.groundTruthPages) {
        // Verified OUTSIDE the pipeline, on a recorded date — never by this benchmark.
        expect(page.verified).toContain(BENCH_GROUND_TRUTH_VERIFIED_ON);
        expect(page.verified).toMatch(/HTTP 200/);
      }
      for (const evidence of entry.expectedEvidence) {
        expect(gtUrls.has(evidence.url)).toBe(true);
        if (evidence.status === "VERIFIED") {
          // A verified expectation must have been observed on a verified page.
          expect(entry.groundTruthPages.some((page) => page.url === evidence.url)).toBe(true);
        }
      }
      if (entry.expectation === "REQUIRE_EVIDENCE") {
        expect(entry.groundTruthPages.length).toBeGreaterThan(0);
        expect(entry.expectedEvidence.some((e) => e.status === "VERIFIED")).toBe(true);
      }
      if (entry.expectation === "FORBID_EVIDENCE") {
        // Ground truth that nothing states the handle: no known pages, no verified evidence.
        expect(entry.groundTruthPages).toHaveLength(0);
        expect(entry.expectedEvidence).toHaveLength(0);
      }
    }
  });

  it("carries an explicit non-claim note for every case that cannot be auto-judged", () => {
    for (const entry of BENCH_CASES) {
      if (entry.expectation === "REVIEW" || entry.category.startsWith("NEGATIVE")) {
        expect(entry.note, `${entry.handle} needs its scope note`).toBeTruthy();
      }
    }
  });
});

describe("fact support checking", () => {
  const body =
    '<html><head><title>x</title><meta property="og:site_name" content="NASA"/></head>' +
    '<script type="application/ld+json">{"@type":"Organization","name":"Smith &amp; Wesson"}</script>' +
    '<a href="https://www.youtube.com/@nasa">yt</a><a href="mailto:info@example.org">mail</a></html>';

  it("accepts a fact whose value and field family are on the page", () => {
    expect(
      factSupported(
        fact({ predicate: "ORGANIZATION_NAME", value: "NASA", field: "meta og:site_name" }),
        body,
      ),
    ).toBe(true);
    expect(
      factSupported(
        fact({ predicate: "ORGANIZATION_NAME", value: "Smith & Wesson", field: "ld+json Organization.name" }),
        body,
      ),
    ).toBe(true);
    expect(
      factSupported(
        fact({ predicate: "RELATED_ACCOUNT_ASSERTED", value: "https://www.youtube.com/@nasa", field: "a[href] (public profile host)" }),
        body,
      ),
    ).toBe(true);
  });

  it("rejects a value the page does not contain", () => {
    expect(
      factSupported(fact({ predicate: "ORGANIZATION_NAME", value: "Not On Page Inc", field: "meta og:site_name" }), body),
    ).toBe(false);
  });

  it("rejects a fact whose cited field family is absent", () => {
    expect(
      factSupported(
        fact({ predicate: "ORGANIZATION_NAME", value: "NASA", field: "ld+json Organization.name" }),
        // no ld+json block in this body, though the string NASA appears
        '<meta property="og:site_name" content="NASA"/>',
      ),
    ).toBe(false);
  });

  it("verifies a truncated value by its retained prefix", () => {
    expect(
      factSupported(
        fact({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: "https://example.org/a-very-long-path-that-was-clamped-by-the-ex…",
          field: "a[href] (public profile host)",
        }),
        '<a href="https://example.org/a-very-long-path-that-was-clamped-by-the-exact-thing">x</a>',
      ),
    ).toBe(true);
  });

  it("sees through JSON-LD escaped slashes and HTML entity escaping on either side", () => {
    // Phase-3 natgeo diagnosis: 5 of 5 "unsupported" facts were escaping
    // asymmetries — parsed values vs `\/` in JSON-LD, `&amp;` in attributes.
    const body =
      '<script type="application/ld+json">{"sameAs":["https:\\/\\/www.linkedin.com\\/company\\/2950300"]}</script>' +
      '<a href="https://x.com/intent/post?text=A&amp;url=B">share</a>';
    expect(
      factSupported(
        fact({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: "https://www.linkedin.com/company/2950300",
          field: "ld+json sameAs[]",
        }),
        body,
      ),
    ).toBe(true);
    // extractor-side value retained the entity form; the body has `&amp;` too
    expect(
      factSupported(
        fact({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: "https://x.com/intent/post?text=A&amp;url=B",
          field: "a[href] (public profile host)",
        }),
        body,
      ),
    ).toBe(true);
    // and the reverse asymmetry: value decoded, body still entity-escaped
    expect(
      factSupported(
        fact({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: "https://x.com/intent/post?text=A&url=B",
          field: "a[href] (public profile host)",
        }),
        body,
      ),
    ).toBe(true);
    // a value that genuinely never appears stays unsupported
    expect(
      factSupported(
        fact({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: "https://x.com/intent/post?text=OTHER&url=B",
          field: "a[href] (public profile host)",
        }),
        body,
      ),
    ).toBe(false);
  });
});

describe("handleMentioned — the delimiter-aware matcher behind the gate", () => {
  it("matches the handle as a delimited token, case-insensitively", () => {
    expect(handleMentioned("About NASA", "nasa")).toBe(true);
    expect(handleMentioned("https://www.nasa.gov/", "nasa")).toBe(true);
    expect(handleMentioned("natgeo-breaks-record", "natgeo")).toBe(true);
    expect(handleMentioned("contact NASA now", "NASA")).toBe(true);
    expect(handleMentioned("end nasa", "nasa")).toBe(true);
  });

  it("rejects the handle inside a longer word or handle-like token", () => {
    expect(handleMentioned("nasal cavity", "nasa")).toBe(false);
    expect(handleMentioned("this said things", "ai")).toBe(false);
    expect(handleMentioned("nasaa_research grantee", "nasaa")).toBe(false);
    expect(handleMentioned("sRGB mode", "rgb")).toBe(false);
    expect(handleMentioned("mysel_win_ tracker", "sel_win_")).toBe(false);
    expect(handleMentioned("sel_win_extra", "sel_win_")).toBe(false);
  });

  it("stays strict on empty handles and partial edges", () => {
    expect(handleMentioned("anything", "")).toBe(false);
    expect(handleMentioned("nasa123", "nasa")).toBe(false);
    expect(handleMentioned("123nasa", "nasa")).toBe(false);
  });
});

describe("attribution levels", () => {
  const handle = "natgeo";
  it("is HOST when the page's own host carries the handle", () => {
    expect(attributionOf({ url: "https://www.natgeo.com/", title: null, mentionsHandle: true }, handle)).toBe("HOST");
    expect(attributionOf({ url: "https://natgeo.com/about", title: null, mentionsHandle: true }, handle)).toBe("HOST");
  });
  it("separates a topical URL path or title from identity", () => {
    expect(attributionOf({ url: "https://example.org/natgeo-breaks-record", title: null, mentionsHandle: true }, handle)).toBe("URL");
    expect(attributionOf({ url: "https://example.org/a", title: "About natgeo", mentionsHandle: true }, handle)).toBe("TITLE");
  });
  it("is BODY when only the body matched", () => {
    expect(attributionOf({ url: "https://example.org/a", title: "Some Page", mentionsHandle: true }, handle)).toBe("BODY");
  });
  it("is null when the page never matched or was never read", () => {
    expect(attributionOf({ url: "https://example.org/a", title: null, mentionsHandle: false }, handle)).toBe(null);
    expect(attributionOf({ url: "https://example.org/a", title: null, mentionsHandle: null }, handle)).toBe(null);
  });
  it("uses delimiter-aware matching: a longer token is not the handle", () => {
    expect(attributionOf({ url: "https://example.org/a", title: "nasaa_research report", mentionsHandle: true }, "nasaa")).toBe("BODY");
    expect(attributionOf({ url: "https://example.org/nasa-lab", title: null, mentionsHandle: true }, "nasa")).toBe("URL");
  });
});

describe("metric computation", () => {
  it("computes precision, support, duplicates, attribution and expectations from one report", () => {
    const nasaPage: FetchSuccess = {
      ok: true,
      finalUrl: "https://www.nasa.gov/",
      httpStatus: 200,
      contentType: "text/html",
      body: '<title>NASA</title><meta property="og:site_name" content="NASA"/><script type="application/ld+json">{"@type":"Organization","name":"NASA"}</script><a href="https://example.org/x">nasa link</a>',
      byteSize: 100,
      fetchedAt: new Date("2026-10-19T00:00:00Z"),
      redirectsFollowed: 0,
      robotsChecked: true,
    };
    const report = makeReport({
      search: { candidateUrls: 4, relevantCandidates: 1 },
      candidates: [
        { url: "https://www.nasa.gov", disposition: "PLANNED", reason: "its result URL names the exact handle" },
        { url: "https://a.example/x", disposition: "PLANNED", reason: "kept only because the document budget had room" },
        { url: "https://b.example/x", disposition: "NOT_FETCHED", reason: "outside the document budget (cap 1)" },
        { url: "https://www.instagram.com/nasa/", disposition: "SKIPPED_BY_POLICY", reason: "Instagram-family host" },
      ],
      documents: [
        doc({ url: "https://www.nasa.gov/", mentionsHandle: true, facts: 3 }),
        doc({ url: "https://a.example/x", mentionsHandle: false }),
      ],
      facts: [
        fact({ predicate: "ORGANIZATION_NAME", value: "NASA", field: "meta og:site_name", sourceUrl: "https://www.nasa.gov/" }),
        // duplicate statement from the same domain via a different field
        fact({ predicate: "ORGANIZATION_NAME", value: "NASA", field: "ld+json Organization.name", sourceUrl: "https://www.nasa.gov/" }),
        // unsupported: not on the page
        fact({ predicate: "CONTACT_CHANNEL", value: "missing@example.org", field: "a[href^=mailto:]", sourceUrl: "https://www.nasa.gov/" }),
      ],
      totals: { planned: 2, fetched: 2, failed: 1, skipped: 1, pagesNamingHandle: 1, facts: 3, refused: 0, unattributed: 0 },
    });

    const metrics = computeBenchMetrics({
      report,
      handle: "nasa",
      benchCase: BENCH_CASES.find((entry) => entry.handle === "nasa") as BenchCase,
      pages: [
        { requestedUrl: "https://www.nasa.gov", result: nasaPage, durationMs: 40 },
        {
          requestedUrl: "https://a.example/x",
          result: { ok: false, kind: "TIMEOUT", reason: "took too long", httpStatus: null, finalUrl: null },
          durationMs: 10_000,
        },
      ],
      searches: [
        { query: '"nasa" instagram', outcome: { provider: "freeserp", query: '"nasa" instagram', results: [], unavailableReason: null, error: null }, durationMs: 500 },
        { query: 'instagram.com/nasa', outcome: { provider: "freeserp", query: 'instagram.com/nasa', results: [], unavailableReason: null, error: null }, durationMs: 100 },
      ],
    });

    expect(metrics.results).toBe(0);
    expect(metrics.uniqueCandidates).toBe(4);
    expect(metrics.candidatePrecision).toBeCloseTo(0.25);
    expect(metrics.planned).toBe(2);
    expect(metrics.plannedRelevant).toBe(1);
    expect(metrics.fetched).toBe(2);
    expect(metrics.retrievalFailureRate).toBeCloseTo(0.5); // 1 failed of 2 attempts
    expect(metrics.namingPages).toBe(1);
    expect(metrics.pagePrecision).toBeCloseTo(0.5);
    expect(metrics.attributionStrong).toBe(1); // URL contains nasa
    expect(metrics.attributionWeak).toBe(0);
    expect(metrics.facts).toBe(3);
    expect(metrics.supported).toBe(2); // value+family on page: NASA meta and ld+json; mailto value absent
    expect(metrics.supportRate).toBeCloseTo(2 / 3);
    expect(metrics.unsupported).toHaveLength(1);
    expect(metrics.unsupported[0]?.value).toBe("missing@example.org");
    expect(metrics.uniqueStatements).toBe(2); // two ORGANIZATION_NAME nasa statements collapse
    expect(metrics.duplicateRate).toBeCloseTo(1 / 3);
    expect(metrics.gtPagesFetched).toBe(1); // trailing-slash canonical match
    expect(metrics.gtPagesInCandidates).toBe(1);
    expect(metrics.expectedVerifiedFound).toBe(1); // host-level match despite www-stripped claim domain
    expect(metrics.expectation).toBe("REQUIRE_EVIDENCE");
    expect(metrics.expectationMet).toBe(true); // facts extracted from the ground-truth page
    expect(metrics.searchP50Ms).toBe(500);
    expect(metrics.searchMaxMs).toBe(500);
    expect(metrics.fetchP50Ms).toBe(10_000);
    expect(metrics.fetchMaxMs).toBe(10_000);
  });

  it("maps expectations honestly: REQUIRE needs evidence, FORBID forbids it, REVIEW never auto-judges", () => {
    const base = { searches: [], pages: [] };
    const evidence = makeReport({ outcomeClass: "EVIDENCE_EXTRACTED" });
    const zero = makeReport({ outcomeClass: "PAGES_IRRELEVANT" });

    const require_ = computeBenchMetrics({ ...base, report: evidence, handle: "nasa", benchCase: caseFor("nasa") });
    expect(require_.expectationMet).toBe(true);
    const requireMissed = computeBenchMetrics({ ...base, report: zero, handle: "nasa", benchCase: caseFor("nasa") });
    expect(requireMissed.expectationMet).toBe(false);

    const forbid = computeBenchMetrics({ ...base, report: zero, handle: "zqwxplm2026", benchCase: caseFor("zqwxplm2026") });
    expect(forbid.expectationMet).toBe(true);
    const forbidBreach = computeBenchMetrics({ ...base, report: evidence, handle: "zqwxplm2026", benchCase: caseFor("zqwxplm2026") });
    expect(forbidBreach.expectationMet).toBe(false);

    const review = computeBenchMetrics({ ...base, report: zero, handle: "rgb", benchCase: caseFor("rgb") });
    expect(review.expectationMet).toBe(null);
  });
});

describe("recording and replay", () => {
  const recording: BenchRecording = {
    handle: "nasa",
    provider: "freeserp",
    recordedAt: "2026-10-19T00:00:00.000Z",
    searches: [
      {
        query: '"nasa" instagram',
        results: [{ url: "https://www.nasa.gov/", title: "NASA", snippet: "nasa" }],
        error: null,
        unavailableReason: null,
      },
      {
        query: 'instagram.com/nasa',
        results: [],
        unavailableReason: null,
        error: "search provider timed out after 15000ms.",
        note: "degraded index",
      },
    ],
    pages: [
      {
        requestedUrl: "https://www.nasa.gov/",
        result: {
          ok: true,
          finalUrl: "https://www.nasa.gov/",
          httpStatus: 200,
          contentType: "text/html",
          body: "<title>NASA</title>",
          byteSize: 14,
          fetchedAt: new Date("2026-10-19T00:00:00Z"),
          redirectsFollowed: 0,
          robotsChecked: true,
        },
      },
    ],
  };

  it("replays provider answers verbatim, including errors and notes", async () => {
    const provider = new ReplaySearchProvider(recording);
    expect(provider.name).toBe("freeserp");
    const ok = await provider.search('"nasa" instagram', 5);
    expect(ok.results).toHaveLength(1);
    expect(ok.error).toBe(null);
    const failed = await provider.search("INSTAGRAM.COM/NASA", 5); // case-insensitive key
    expect(failed.error).toContain("timed out");
    expect(failed.note).toBe("degraded index");
    const unknown = await provider.search("never recorded", 5);
    expect(unknown.error).toContain("not part of this recording");
    expect(unknown.results).toHaveLength(0);
  });

  it("replays captured pages and fails loudly for anything unrecorded", async () => {
    const fetcher = new ReplayFetcher(recording);
    const hit = await fetcher.fetchPage("https://www.nasa.gov/");
    expect(hit.ok).toBe(true);
    const miss = await fetcher.fetchPage("https://example.org/unrecorded");
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.kind).toBe("NETWORK_ERROR");
      expect(miss.reason).toContain("not part of the recording");
    }
  });

  it("captures search answers and latency through the wrapper", async () => {
    const captured = captureSearch(new ReplaySearchProvider(recording));
    await captured.provider.search('"nasa" instagram', 5);
    expect(captured.searches).toHaveLength(1);
    expect(captured.searches[0]?.query).toBe('"nasa" instagram');
    expect(captured.searches[0]?.outcome.results).toHaveLength(1);
    expect(captured.searches[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// --- helpers ----------------------------------------------------------------

function fact(overrides: Partial<AuditWebFact>): AuditWebFact {
  return {
    predicate: "ORGANIZATION_NAME",
    value: "NASA",
    excerpt: "meta og:site_name: NASA",
    field: "meta og:site_name",
    method: "META_TAG",
    provenance: "PUBLIC_WEB_DOCUMENTED",
    sourceUrl: "https://www.nasa.gov/",
    sourceTitle: "NASA",
    sourceDomain: "nasa.gov",
    retrievedAt: "2026-10-19T00:00:00.000Z",
    uncertainty: null,
    ...overrides,
  };
}

function doc(overrides: Partial<AuditWebDocument>): AuditWebDocument {
  return {
    url: "https://www.nasa.gov/",
    outcome: "FETCHED",
    outcomeReason: null,
    httpStatus: 200,
    title: "NASA",
    contentType: "text/html",
    byteSize: 100,
    contentSha256: "0".repeat(64),
    retrievedAt: "2026-10-19T00:00:00.000Z",
    sourceType: "SEARCH_RESULT",
    mentionsHandle: true,
    facts: 0,
    refused: 0,
    discarded: 0,
    unattributed: 0,
    linksNotFollowed: 0,
    ...overrides,
  };
}

function caseFor(handle: string): BenchCase {
  const found = BENCH_CASES.find((entry) => entry.handle === handle);
  if (found === undefined) throw new Error(`no bench case for ${handle}`);
  return found;
}

function makeReport(
  overrides: Omit<Partial<AuditWebReport>, "search"> & {
    search?: Partial<AuditWebReport["search"]>;
  },
): AuditWebReport {
  return {
    attempted: true,
    sourcesAvailable: true,
    retrievalState: "COMPLETED",
    outcomeClass: "EVIDENCE_EXTRACTED",
    bounds: { maxSources: 5, maxDepth: 1, enforced: "test", documentsTruncated: 0 },
    candidates: [],
    documents: [],
    facts: [],
    relations: [],
    rejectedUrls: [],
    totals: { planned: 0, fetched: 0, failed: 0, skipped: 0, pagesNamingHandle: 0, facts: 0, refused: 0, unattributed: 0 },
    inferences: "None.",
    why: "test",
    notes: [],
    ...overrides,
    search: {
      provider: "freeserp",
      state: "SEARCH_SUCCEEDED",
      queries: ['"nasa" instagram', "instagram.com/nasa", '"@nasa"', '"nasa"'],
      perQuery: [],
      candidateUrls: 0,
      relevantCandidates: 0,
      unavailableReason: null,
      note: null,
      ...(overrides.search ?? {}),
    },
  };
}

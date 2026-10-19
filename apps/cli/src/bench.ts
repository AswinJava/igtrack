// ---------------------------------------------------------------------------
// Phase-3 evaluation harness (mission: multi-source intelligence and
// real-world validation). This module is EVALUATION code — the audit command
// never imports it, no capability claims derive from it, and it is never part
// of `pnpm test`'s live path (its own tests run offline against synthetic
// inputs and committed recordings).
//
// Three responsibilities:
//   BENCH_CASES        — the reproducible evaluation set: one handle per
//                        category the mission names (large-footprint orgs,
//                        externally-referenced accounts, hard-to-search
//                        handles, sparse/negative/ambiguous cases), each with
//                        ground truth verified INDEPENDENTLY of the pipeline
//                        (direct HTTP fetches recorded in `verified`), the
//                        expected evidence on those pages, and the honest
//                        expectation for the run (require / forbid / review).
//   metrics            — the measurements: candidate precision, retrieval,
//                        exact-handle matches, SUPPORTED claims (every fact
//                        re-checked against the retrieved page), attribution
//                        strength, duplicate rate, failure rate, latency.
//                        Raw fact count is deliberately NOT a success metric.
//   recording/replay   — capture what a live provider answered and what the
//                        fetcher returned, then replay it deterministically
//                        (saved-response benchmark) without touching the
//                        network.
// ---------------------------------------------------------------------------

import { normalizeClaimValue } from "@igtrack/core";
import {
  decodeEntities,
  type FetchFailure,
  type FetchResult,
  type ResearchFetcher,
  type ResearchSearchProvider,
  type SearchOutcome,
  type SearchResult,
} from "@igtrack/ingestion";
import type { AuditWebOutcomeClass, AuditWebFact, AuditWebReport } from "./tools.js";
import { handleMentioned } from "./tools.js";

// --- Evaluation set ---------------------------------------------------------

export type BenchCategory =
  /** Organizations with substantial web footprints (easy case). */
  | "ORG_LARGE_FOOTPRINT"
  /** Public accounts with independently discoverable external references. */
  | "ORG_EXTERNAL_REFERENCES"
  /** Short or common tokens where "does this page mean the handle?" is hard. */
  | "SHORT_OR_AMBIGUOUS"
  /** Underscores/awkward shapes the index tokenizes badly (known D74 finding). */
  | "HARD_TO_SEARCH"
  /** A near-miss of a real handle: pages about the neighbour must not count. */
  | "NEGATIVE_NEAR_MISS"
  /** A handle with no discoverable public-web presence: an honest zero. */
  | "NEGATIVE_NONEXISTENT";

/**
 * What the case SHOULD honestly produce, judged against ground truth —
 * deliberately not "how many facts" (the mission forbids volume as a metric):
 *   REQUIRE_EVIDENCE — known ground-truth pages name the handle and carry
 *                      extractable structured fields; zero would mean a
 *                      retrieval or extraction defect to investigate.
 *   FORBID_EVIDENCE  — ground truth says nothing in the world states this
 *                      handle; any extracted fact would be a false
 *                      attribution to inspect before trusting.
 *   REVIEW           — the ground truth cannot decide (ambiguous or
 *                      unknowable); the run is scored on precision/support,
 *                      and the verdict is "inspect the facts", not pass/fail.
 */
export type BenchExpectation = "REQUIRE_EVIDENCE" | "FORBID_EVIDENCE" | "REVIEW";

export interface BenchGroundTruthPage {
  url: string;
  /**
   * How the page's exact-handle naming was verified OUTSIDE the pipeline:
   * a direct HTTP fetch with the observed status, byte size and match count.
   * Never derived from the benchmark's own run.
   */
  verified: string;
}

export interface BenchExpectedEvidence {
  /** Page that states it (from groundTruthPages). */
  url: string;
  /** Claim predicate the extractor should emit for it. */
  predicate: string;
  /** The stated value, exactly as the page states it. */
  value: string;
  /** VERIFIED = seen on the page in a direct fetch; ASSUMPTION = expected but not yet observed. */
  status: "VERIFIED" | "ASSUMPTION";
}

export interface BenchCase {
  handle: string;
  category: BenchCategory;
  rationale: string;
  groundTruthPages: BenchGroundTruthPage[];
  expectedEvidence: BenchExpectedEvidence[];
  expectation: BenchExpectation;
  /** What the benchmark explicitly does NOT claim for this case. */
  note?: string;
}

/** Ground-truth verification date shared by this build's records. */
export const BENCH_GROUND_TRUTH_VERIFIED_ON = "2026-10-19";

export const BENCH_CASES: readonly BenchCase[] = [
  {
    handle: "nasa",
    category: "ORG_LARGE_FOOTPRINT",
    rationale: "A large public organization with a substantial, independently verifiable web footprint.",
    groundTruthPages: [
      {
        url: "https://www.nasa.gov/",
        verified: `direct GET ${BENCH_GROUND_TRUTH_VERIFIED_ON}: HTTP 200, 345883 B, "nasa" x1176, og:site_name "NASA", 1 ld+json Organization block, title "NASA"`,
      },
    ],
    expectedEvidence: [
      { url: "https://www.nasa.gov/", predicate: "ORGANIZATION_NAME", value: "NASA", status: "VERIFIED" },
    ],
    expectation: "REQUIRE_EVIDENCE",
    note:
      "The control handle: Phase 2 already produced 41 facts from pages naming it. The Phase-3 question is how many of those are unique, supported and correctly attributed — not how many there are.",
  },
  {
    handle: "natgeo",
    category: "ORG_EXTERNAL_REFERENCES",
    rationale: "A public brand account whose official site links the handle externally; title does NOT contain the handle (body/URL match only).",
    groundTruthPages: [
      {
        url: "https://www.natgeo.com/",
        verified: `direct GET ${BENCH_GROUND_TRUTH_VERIFIED_ON}: HTTP 200, 576942 B, "natgeo" x1675, og:site_name "National Geographic", 1 ld+json Organization block`,
      },
    ],
    expectedEvidence: [
      { url: "https://www.natgeo.com/", predicate: "ORGANIZATION_NAME", value: "National Geographic", status: "VERIFIED" },
    ],
    expectation: "REQUIRE_EVIDENCE",
    note:
      "The existence of the Instagram account itself is not verified here (no platform route is exercised by this benchmark); ground truth is about external web pages naming the handle string.",
  },
  {
    handle: "github",
    category: "SHORT_OR_AMBIGUOUS",
    rationale:
      "Short, extremely common token: any page that merely links to github.com contains it, so the exact-handle gate is at its loosest — the attribution stress case.",
    groundTruthPages: [
      {
        url: "https://github.com/about",
        verified: `direct GET ${BENCH_GROUND_TRUTH_VERIFIED_ON}: HTTP 200, 298727 B, "github" x547, og:site_name "GitHub", title "About GitHub"`,
      },
    ],
    expectedEvidence: [
      { url: "https://github.com/about", predicate: "ORGANIZATION_NAME", value: "GitHub", status: "VERIFIED" },
    ],
    expectation: "REQUIRE_EVIDENCE",
    note:
      "Passing this case means facts were extracted from pages naming github — inspecting WHERE the handle matched (URL/title vs body-only) tells you whether the attribution was earned.",
  },
  {
    handle: "sel_win_",
    category: "HARD_TO_SEARCH",
    rationale:
      "Trailing underscore: the keyless index tokenizes it into sel+win and ignores quotes (D74 diagnosis), so search coverage is known-poor.",
    groundTruthPages: [],
    expectedEvidence: [],
    expectation: "REVIEW",
    note:
      "No page naming this exact handle is known — an assumption, NOT an exhaustive finding. Whatever the run extracts must name the handle literally and be inspected (REVIEW), never assumed wrong or right.",
  },
  {
    handle: "rgb",
    category: "SHORT_OR_AMBIGUOUS",
    rationale:
      "Three-letter token with massive unrelated web presence (color model, brands): any extracted fact is ambiguous by construction.",
    groundTruthPages: [],
    expectedEvidence: [],
    expectation: "REVIEW",
    note:
      "Ambiguous case: pages naming rgb exist but none is known to refer to an Instagram account of that name. Facts are reported with attribution strength for inspection; the benchmark takes no side.",
  },
  {
    handle: "nasaa",
    category: "NEGATIVE_NEAR_MISS",
    rationale:
      "One character off the control: pages about nasa must be DISCARDED by the exact-handle gate — a typo must never inherit the neighbour's evidence. (The original FORBID_EVIDENCE expectation was FALSIFIED by the Phase-3 live run: the string 'nasaa' names real organizations — see the note.)",
    groundTruthPages: [],
    expectedEvidence: [],
    expectation: "REVIEW",
    note:
      "Assumption corrected by evidence (2026-10-19): 'nasaa' is a real string in the world. Independently verified " +
      "outside the pipeline — https://www.nasaa-arts.org/ serves HTTP 200 (191 KB) and uses the NASAA brand 596 times " +
      "(National Assembly of State Arts Agencies); https://www.nasaa.org/ exists but answers HTTP 403 to our fetcher " +
      "even with a browser UA (bot protection — a documented coverage limitation for the securities-regulators site). " +
      "What this case still tests: the near-miss property (no nasa.* page may contribute to nasaa), which the " +
      "delimiter gate enforces; facts from NASAA-branded pages are string-true but IDENTITY-UNVERIFIED, so the " +
      "benchmark reports them for review and passes no verdict.",
  },
  {
    handle: "zqwxplm2026",
    category: "NEGATIVE_NONEXISTENT",
    rationale:
      "Plausible-shape handle with (expected) no public-web presence: the honest-zero case the mission requires.",
    groundTruthPages: [],
    expectedEvidence: [],
    expectation: "FORBID_EVIDENCE",
    note: "Expected outcome is a labelled zero (what was searched, what came back), never invented sources.",
  },
];

// --- Support checking -------------------------------------------------------

/**
 * Does the retrieved page itself support this fact? Two checks, both against
 * the ACTUAL body that was fetched:
 *   1. the stated value appears in the page (after the same entity decoding
 *      extraction applies — a faithful `Smith &amp; Wesson` source must not
 *      look unsupported just because the checker forgot entities);
 *   2. the field family the fact cites is present (an `ld+json …` fact needs
 *      an ld+json block, a `meta …` fact needs a meta tag, a link fact needs
 *      an anchor).
 * Excerpts are constructed evidence (`link "x" → url`), so they are not
 * required verbatim — the VALUE is what must be on the page.
 */
export function factSupported(fact: AuditWebFact, body: string): boolean {
  let needle = fact.value;
  // Values are clamped with an ellipsis by the extractor; a truncated URL
  // cannot be found verbatim, so its retained prefix must be present instead.
  const truncated = needle.endsWith("…");
  if (truncated) needle = needle.slice(0, -1);
  if (needle.length === 0) return false;
  // Canonicalize BOTH sides exactly as extraction saw them: JSON-LD escapes
  // `/` as `\/` and HTML attributes escape `&` as `&amp;`, so comparing a
  // parsed value against a differently-escaped body loses genuinely-present
  // facts (Phase-3 natgeo case: 5 of 5 "unsupported" facts were this
  // asymmetry, not missing evidence).
  const canon = (text: string): string => decodeEntities(text).replaceAll("\\/", "/");
  if (!canon(body).includes(canon(needle))) return false;
  const field = fact.field;
  if (field.startsWith("ld+json")) return /application\/ld\+json/i.test(body);
  if (field.startsWith("meta")) return /<meta\s/i.test(body);
  if (field.startsWith("a[")) return /<a\s/i.test(body);
  if (field.startsWith("mailto")) return /mailto:/i.test(body);
  return true;
}

/**
 * WHERE does the page tie itself to the handle? HOST = the page's own host
 * carries the handle (it presents itself as the account's site — the
 * identity-level attribution); URL = only the path/query names it (a topical
 * article slug, not the page's identity); TITLE = only the document title
 * does; BODY = only the body matched. Only HOST counts as "strong" in the
 * metrics: the Phase-3 natgeo case showed URL matches
 * (`wersm.com/natgeo-breaks-…`) reading STRONG while describing another
 * entity. Levels use the same delimiter-aware match as the relevance gate.
 */
export function attributionOf(
  doc: { url: string; title: string | null; mentionsHandle: boolean | null },
  handle: string,
): "HOST" | "URL" | "TITLE" | "BODY" | null {
  if (doc.mentionsHandle !== true) return null;
  const needle = handle.toLowerCase();
  let path = doc.url;
  try {
    const parsed = new URL(doc.url);
    if (handleMentioned(parsed.hostname, needle)) return "HOST";
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    path = doc.url;
  }
  if (handleMentioned(path, needle)) return "URL";
  if (doc.title !== null && handleMentioned(doc.title, needle)) return "TITLE";
  return "BODY";
}

// --- Recording / replay -----------------------------------------------------

export interface BenchRecordedSearch {
  query: string;
  results: SearchResult[];
  error: string | null;
  unavailableReason: string | null;
  note?: string;
}

/**
 * What a live run actually saw: every provider answer and every fetch result,
 * captured verbatim. Replaying it must reproduce the same report without the
 * network — that is the saved-response layer, separate from both mocked
 * regression tests and live provider runs.
 */
export interface BenchRecording {
  handle: string;
  provider: string;
  recordedAt: string;
  searches: BenchRecordedSearch[];
  pages: Array<{ requestedUrl: string; result: FetchResult }>;
}

/** Answers exactly the queries in the recording; anything else is an error. */
export class ReplaySearchProvider implements ResearchSearchProvider {
  readonly name: string;

  constructor(private readonly recording: BenchRecording) {
    this.name = recording.provider;
  }

  async search(query: string, limit: number): Promise<SearchOutcome> {
    const key = query.trim().toLowerCase();
    const hit = this.recording.searches.find((entry) => entry.query.trim().toLowerCase() === key);
    if (hit === undefined) {
      return {
        provider: this.name,
        query,
        results: [],
        unavailableReason: null,
        error: `replay: "${query}" is not part of this recording (recorded runs answer only what they captured).`,
      };
    }
    return {
      provider: this.name,
      query,
      results: hit.results.slice(0, limit),
      unavailableReason: hit.unavailableReason,
      error: hit.error,
      ...(hit.note !== undefined ? { note: hit.note } : {}),
    };
  }
}

/** Returns only the pages the recording captured; anything else fails loudly. */
export class ReplayFetcher {
  private readonly byUrl = new Map<string, FetchResult>();

  constructor(recording: BenchRecording) {
    for (const page of recording.pages) this.byUrl.set(page.requestedUrl, page.result);
  }

  async fetchPage(url: string): Promise<FetchResult> {
    const hit = this.byUrl.get(url);
    if (hit === undefined) {
      const failure: FetchFailure = {
        ok: false,
        kind: "NETWORK_ERROR",
        reason:
          "this URL is not part of the recording (replay divergence): a saved-response run answers only the pages it captured.",
        httpStatus: null,
        finalUrl: null,
      };
      return failure;
    }
    // JSON round-trips Date to string; the probe calls .toISOString() on it.
    if (hit.ok && typeof hit.fetchedAt !== "object") {
      return { ...hit, fetchedAt: new Date(String(hit.fetchedAt)) };
    }
    return hit;
  }
}

// --- Capture wrappers -------------------------------------------------------

export interface CapturedPage {
  requestedUrl: string;
  result: FetchResult;
  durationMs: number;
}

export interface CapturedSearch {
  query: string;
  outcome: SearchOutcome;
  durationMs: number;
}

/** Wrap a fetcher to keep every result (for support checks) and its latency. */
export function captureFetcher(inner: Pick<ResearchFetcher, "fetchPage">): {
  fetcher: Pick<ResearchFetcher, "fetchPage">;
  pages: CapturedPage[];
} {
  const pages: CapturedPage[] = [];
  return {
    pages,
    fetcher: {
      async fetchPage(url: string): Promise<FetchResult> {
        const started = performance.now();
        const result = await inner.fetchPage(url);
        pages.push({ requestedUrl: url, result, durationMs: performance.now() - started });
        return result;
      },
    },
  };
}

/** Wrap a provider to keep every answer and its per-query latency. */
export function captureSearch(inner: ResearchSearchProvider): {
  provider: ResearchSearchProvider;
  searches: CapturedSearch[];
} {
  const searches: CapturedSearch[] = [];
  return {
    searches,
    provider: {
      name: inner.name,
      async search(query: string, limit: number): Promise<SearchOutcome> {
        const started = performance.now();
        const outcome = await inner.search(query, limit);
        searches.push({ query, outcome, durationMs: performance.now() - started });
        return outcome;
      },
    },
  };
}

// --- Metrics ----------------------------------------------------------------

export interface BenchMetrics {
  handle: string;
  category: BenchCategory | null;
  provider: string;
  queries: number;
  results: number;
  uniqueCandidates: number;
  /** 1 - unique/results: how much the query fan-out duplicated URLs. */
  dedupRate: number | null;
  /** Candidates whose result summary names the exact handle / all candidates. */
  candidatePrecision: number | null;
  planned: number;
  /** Planned candidates whose own summary named the exact handle. */
  plannedRelevant: number;
  fetched: number;
  failed: number;
  /** failed / (fetched + failed): real transport failures, policy skips excluded. */
  retrievalFailureRate: number | null;
  namingPages: number;
  /** naming / fetched: verified relevance of what was actually read. */
  pagePrecision: number | null;
  /** Pages whose HOST carries the handle (identity-level attribution). */
  attributionStrong: number;
  /** Naming pages matched only via URL path / title / body (topical). */
  attributionWeak: number;
  facts: number;
  /** Structured values from machine-found pages not attributed (self-identification). */
  unattributed: number;
  /** Facts re-verified against the retrieved body (value + field family). */
  supported: number;
  unsupported: Array<{ predicate: string; value: string; field: string; sourceUrl: string }>;
  supportRate: number | null;
  /** Distinct (predicate, normalized value, source domain) statements. */
  uniqueStatements: number;
  duplicateRate: number | null;
  relationsCorroborated: number;
  relationsConflicted: number;
  relationsSingleSource: number;
  /** Ground-truth pages whose domain made it into candidates / fetched docs. */
  gtPagesTotal: number;
  gtPagesInCandidates: number;
  gtPagesFetched: number;
  /** VERIFIED expected evidence actually found among the extracted facts. */
  expectedVerified: number;
  expectedVerifiedFound: number;
  outcomeClass: AuditWebOutcomeClass;
  expectation: BenchExpectation | null;
  /** REQUIRE → EVIDENCE_EXTRACTED; FORBID → anything else; REVIEW → null. */
  expectationMet: boolean | null;
  searchP50Ms: number;
  searchMaxMs: number;
  fetchP50Ms: number;
  fetchMaxMs: number;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!);
}

/** Host-level equality (claim domains are www-stripped; ground-truth URLs are not). */
function sameHost(a: string, b: string): boolean {
  const host = (url: string): string => {
    try {
      const value = new URL(url).hostname.toLowerCase();
      return value.startsWith("www.") ? value.slice(4) : value;
    } catch {
      return "";
    }
  };
  const left = host(a);
  return left !== "" && left === host(b);
}

export interface BenchMetricsInput {
  report: AuditWebReport;
  pages: readonly CapturedPage[];
  searches: readonly CapturedSearch[];
  handle: string;
  benchCase?: BenchCase | undefined;
}

export function computeBenchMetrics(input: BenchMetricsInput): BenchMetrics {
  const { report, pages, handle } = input;
  const benchCase = input.benchCase ?? null;

  const results = report.search.perQuery.reduce((total, entry) => total + entry.results, 0);
  const attemptedFetches = pages.length;
  const namingDocs = report.documents.filter((doc) => doc.mentionsHandle === true);
  // Strong = the page's HOST carries the handle (identity-level); everything
  // else (URL path, title, body) is a topical mention an operator should
  // read with the source's own identity in mind.
  const strongDocs = namingDocs.filter((doc) => attributionOf(doc, handle) === "HOST");
  const weakDocs = namingDocs.filter((doc) => {
    const level = attributionOf(doc, handle);
    return level !== null && level !== "HOST";
  });

  // Support: every fact re-checked against the body that actually produced it.
  const bodyByUrl = new Map<string, string>();
  for (const page of pages) {
    if (page.result.ok) bodyByUrl.set(page.result.finalUrl, page.result.body);
  }
  const unsupported: BenchMetrics["unsupported"] = [];
  let supported = 0;
  for (const fact of report.facts) {
    const body = bodyByUrl.get(fact.sourceUrl);
    const ok = body !== undefined && factSupported(fact, body);
    if (ok) supported += 1;
    else {
      unsupported.push({
        predicate: fact.predicate,
        value: fact.value,
        field: fact.field,
        sourceUrl: fact.sourceUrl,
      });
    }
  }

  // Duplicates: the same statement (predicate + normalized value) from the
  // same domain, however many fields emitted it.
  const statementKeys = new Set(
    report.facts.map(
      (fact) => `${fact.predicate}|${normalizeClaimValue(fact.value)}|${fact.sourceDomain ?? fact.sourceUrl}`,
    ),
  );

  const plannedRows = report.candidates.filter((row) => row.disposition === "PLANNED");
  const plannedRelevant = plannedRows.filter((row) => row.reason.includes("names the exact handle")).length;

  const gtPages = benchCase?.groundTruthPages ?? [];
  // Ground truth is matched at HOST level: the independently verified page
  // proves its whole domain, and the probe may reach a different path on it
  // (search ranking / document budget fetch a subpage first — measured:
  // nasa.gov's homepage never entered the plan, a subpage did).
  const gtInCandidates = gtPages.filter((page) =>
    report.candidates.some((row) => sameHost(row.url, page.url)),
  ).length;
  const gtFetched = gtPages.filter((page) =>
    report.documents.some((doc) => doc.outcome === "FETCHED" && sameHost(doc.url, page.url)),
  ).length;

  const expected = (benchCase?.expectedEvidence ?? []).filter((entry) => entry.status === "VERIFIED");
  const expectedFound = expected.filter((entry) =>
    report.facts.some(
      (fact) =>
        fact.predicate === entry.predicate &&
        normalizeClaimValue(fact.value) === normalizeClaimValue(entry.value) &&
        fact.sourceDomain !== null &&
        sameHost(`https://${fact.sourceDomain}`, entry.url),
    ),
  ).length;

  const corroborated = report.relations.filter((rel) => rel.label === "CORROBORATED").length;
  const conflicted = report.relations.filter((rel) => rel.label === "CONFLICTED").length;
  const singleSource = report.relations.filter((rel) => rel.label === "SINGLE_SOURCE").length;

  const expectation = benchCase?.expectation ?? null;
  const expectationMet =
    expectation === null || expectation === "REVIEW"
      ? null
      : expectation === "REQUIRE_EVIDENCE"
        ? report.outcomeClass === "EVIDENCE_EXTRACTED"
        : report.outcomeClass !== "EVIDENCE_EXTRACTED";

  const searchTimings = input.searches.map((entry) => entry.durationMs);
  const fetchTimings = pages.map((entry) => entry.durationMs);

  return {
    handle: input.handle,
    category: benchCase?.category ?? null,
    provider: report.search.provider ?? "none",
    queries: report.search.queries.length,
    results,
    uniqueCandidates: report.search.candidateUrls,
    dedupRate: results > 0 ? 1 - report.search.candidateUrls / results : null,
    candidatePrecision:
      report.search.candidateUrls > 0 ? report.search.relevantCandidates / report.search.candidateUrls : null,
    planned: plannedRows.length,
    plannedRelevant,
    fetched: report.totals.fetched,
    failed: report.totals.failed,
    retrievalFailureRate:
      attemptedFetches > 0 ? report.totals.failed / attemptedFetches : null,
    namingPages: namingDocs.length,
    pagePrecision: report.totals.fetched > 0 ? namingDocs.length / report.totals.fetched : null,
    attributionStrong: strongDocs.length,
    attributionWeak: weakDocs.length,
    facts: report.facts.length,
    unattributed: report.totals.unattributed,
    supported,
    unsupported,
    supportRate: report.facts.length > 0 ? supported / report.facts.length : null,
    uniqueStatements: statementKeys.size,
    duplicateRate: report.facts.length > 0 ? 1 - statementKeys.size / report.facts.length : null,
    relationsCorroborated: corroborated,
    relationsConflicted: conflicted,
    relationsSingleSource: singleSource,
    gtPagesTotal: gtPages.length,
    gtPagesInCandidates: gtInCandidates,
    gtPagesFetched: gtFetched,
    expectedVerified: expected.length,
    expectedVerifiedFound: expectedFound,
    outcomeClass: report.outcomeClass,
    expectation,
    expectationMet,
    searchP50Ms: quantile(searchTimings, 0.5),
    searchMaxMs: quantile(searchTimings, 1),
    fetchP50Ms: quantile(fetchTimings, 0.5),
    fetchMaxMs: quantile(fetchTimings, 1),
  };
}

// ---------------------------------------------------------------------------
// Autonomous public-web research (FOUNDING §19, D69).
//
// The engine researches only what the operator is allowed to research:
// PUBLIC web pages, named either by the operator (--url) or by a configured
// search provider. It never touches Instagram itself — platform data arrives
// through provider adapters only, so instagram.com/facebook.com hosts are in
// the fetch blocklist by policy, not by accident.
//
// This module is pure: the question→intent mapping, the source registry with
// its policies, the machine-enforced bounds, and the candidate types the
// extractor produces. The network lives in @igtrack/ingestion; storage and
// claim validation live one layer up (the engine proposes, the claims
// boundary disposes — an extractor can never bypass the predicate registry).
//
// Pure and dependency-free (core invariant).
// ---------------------------------------------------------------------------

import type { ClaimPredicate } from "./claims.js";

// --- Bounds: the §4.7 protocol, now machine-enforced (D69) -----------------

/**
 * Max documents a single research run may fetch. The Deep Account
 * Intelligence §4.7 protocol documented "10 sources" as an agent guideline;
 * the engine makes it a real ceiling — the plan is truncated and the run
 * reports `boundsTruncated: true` rather than silently fetching more.
 */
export const RESEARCH_MAX_SOURCES = 10;

/**
 * Max pages deep a run may go: 1 = only the URLs the operator named or the
 * search provider returned. Links found inside fetched pages are NEVER
 * followed — that is the difference between "research a named source" and
 * "crawl the web", and the engine does not crawl.
 */
export const RESEARCH_MAX_DEPTH = 1;

/** Per-document fetch ceiling. Kept generous for slow public sites. */
export const RESEARCH_FETCH_TIMEOUT_MS = 10_000;

/** Per-document response cap. A research source is a page, not a mirror. */
export const RESEARCH_MAX_BYTES = 512 * 1024;

/** Redirect hops per document; every hop is re-validated like the first URL. */
export const RESEARCH_MAX_REDIRECTS = 3;

/** A fetched document younger than this is reused, not refetched (D69). */
export const RESEARCH_DOCUMENT_FRESH_HOURS = 24;

// --- Source registry -------------------------------------------------------

export const RESEARCH_SOURCE_TYPES = [
  "OPERATOR_SUPPLIED_URL",
  "SEARCH_RESULT",
] as const;

export type ResearchSourceType = (typeof RESEARCH_SOURCE_TYPES)[number];

export interface ResearchSourcePolicy {
  type: ResearchSourceType;
  label: string;
  /** What this source can provide, in the engine's terms. */
  provides: string;
  /** Whether retrieval needs credentials (search does; direct fetch does not). */
  requiresCredentials: boolean;
  /** Collection restrictions enforced by the fetcher. */
  restrictions: string;
  /** Whether fetched content may be stored: metadata + short excerpts only. */
  retention: string;
  /** Attribution requirement carried into every stored claim. */
  attribution: string;
  /** How freshness is determined for reuse decisions. */
  freshness: string;
}

export const RESEARCH_SOURCE_POLICIES: Record<ResearchSourceType, ResearchSourcePolicy> = {
  OPERATOR_SUPPLIED_URL: {
    type: "OPERATOR_SUPPLIED_URL",
    label: "Operator-supplied public URL",
    provides:
      "Documented facts about the target from a page the operator named (official site, org page, portfolio, public bio).",
    requiresCredentials: false,
    restrictions:
      "Public http(s) only; SSRF-guarded (no private/loopback/link-local/metadata destinations, every redirect re-validated); robots.txt respected; Instagram/Facebook hosts refused outright (platform data is not web research); content types limited to HTML/XHTML/plain text; per-document timeout, size and redirect caps.",
    retention:
      "Document metadata (URL, title, content hash, byte size, retrieval time, outcome) is stored; page bodies are NOT stored — only short excerpts (≤500 chars) travel with individual claims.",
    attribution:
      "Every claim carries the source URL, title, excerpt and its SHA-256.",
    freshness:
      "Documents fetched less than RESEARCH_DOCUMENT_FRESH_HOURS ago are reused, not refetched; claims carry their own 180-day review horizon.",
  },
  SEARCH_RESULT: {
    type: "SEARCH_RESULT",
    label: "Configured search provider result",
    provides:
      "Candidate public pages relevant to the research question, which are then fetched and verified like any operator-supplied URL.",
    requiresCredentials: true,
    restrictions:
      "Only a configured provider (IGTRACK_RESEARCH_SEARCH_PROVIDER + API key); no key means the capability answers UNAVAILABLE with the reason, never a fake result list. Search hits are candidates, never evidence — nothing is stored from search alone.",
    retention: "Query, provider name, result count and per-URL outcome are recorded on the run; result snippets are not stored as evidence.",
    attribution: "The run records the provider and the queries it ran.",
    freshness: "Provider results are treated as fresh for the duration of the run only.",
  },
};

/**
 * Hosts the research engine refuses to fetch. Instagram platform data has one
 * lawful route — the official Graph API, through provider adapters — and
 * scraping the website would sit on the wrong side of FOUNDING §14/§8. This
 * list is policy, enforced by the fetcher before any DNS lookup.
 */
export const RESEARCH_BLOCKED_HOSTS: readonly string[] = [
  "instagram.com",
  "facebook.com",
  "threads.net",
  "whatsapp.com",
];

export type HostPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

function matchesBlockedHost(hostname: string, blocked: string): boolean {
  return hostname === blocked || hostname.endsWith(`.${blocked}`);
}

/** Policy check on a hostname, before any network work. */
export function researchHostPolicy(hostname: string): HostPolicyDecision {
  const host = hostname.toLowerCase();
  if (matchesBlockedHost(host, "localhost")) {
    return {
      allowed: false,
      reason: `"${host}" is a loopback name: the research engine fetches public pages only.`,
    };
  }
  for (const blocked of RESEARCH_BLOCKED_HOSTS) {
    if (matchesBlockedHost(host, blocked)) {
      return {
        allowed: false,
        reason:
          `"${host}" is Instagram-family platform data: it is reachable only through the official ` +
          "Graph API provider adapters (FOUNDING §14/§19, D69), never by web fetch.",
      };
    }
  }
  return { allowed: true };
}

// --- Question-driven intent ------------------------------------------------

/**
 * What a research question is asking the engine to prioritize. The intent
 * narrows the source plan and the extraction emphasis; it never widens the
 * bounds or the permission set.
 */
export const RESEARCH_INTENTS = ["IDENTITY", "ORGANIZATION", "CONNECTIONS", "GENERAL"] as const;
export type ResearchIntent = (typeof RESEARCH_INTENTS)[number];

export interface ResearchFocus {
  intent: ResearchIntent;
  /** Predicates this question most wants answered, in priority order. */
  priorities: ClaimPredicate[];
  /** Human explanation of the mapping, carried into the run record. */
  rationale: string;
}

const ORGANIZATION_PRIORITIES: ClaimPredicate[] = [
  "ORGANIZATION_NAME",
  "ORGANIZATION_KIND",
  "INDUSTRY_OR_FIELD",
  "LOCATION_STATED",
];

const IDENTITY_PRIORITIES: ClaimPredicate[] = [
  "ORGANIZATION_NAME",
  "CONTACT_CHANNEL",
  "RELATED_ACCOUNT_ASSERTED",
  "INSTITUTIONAL_AFFILIATION_STATED",
];

const CONNECTIONS_PRIORITIES: ClaimPredicate[] = [
  "RELATED_ACCOUNT_ASSERTED",
  "INSTITUTIONAL_AFFILIATION_STATED",
  "ORGANIZATION_NAME",
];

const GENERAL_PRIORITIES: ClaimPredicate[] = [
  "ORGANIZATION_NAME",
  "ORGANIZATION_KIND",
  "INDUSTRY_OR_FIELD",
  "LOCATION_STATED",
  "CONTACT_CHANNEL",
  "PRODUCT_OR_SERVICE",
  "RELATED_ACCOUNT_ASSERTED",
];

/**
 * Map a free-text research question to a focus. Keyword buckets, deliberately
 * coarse: the intent only reorders work the engine is already permitted to
 * do, so a mis-bucketed question costs priority, never permission.
 */
export function researchFocusForQuestion(question: string): ResearchFocus {
  const q = question.toLowerCase();
  const mentions = (...words: string[]): boolean => words.some((w) => q.includes(w));
  if (
    mentions("company", "business", "organization", "organisation", "employer", "studio", "agency", "brand", "startup", "founded")
  ) {
    return {
      intent: "ORGANIZATION",
      priorities: ORGANIZATION_PRIORITIES,
      rationale:
        "The question names organizations/businesses, so organization, kind, field and location claims are extracted and ranked first.",
    };
  }
  if (
    mentions("connect", "network", "collaborat", "partner", "related account", "also known", "linked")
  ) {
    return {
      intent: "CONNECTIONS",
      priorities: CONNECTIONS_PRIORITIES,
      rationale:
        "The question asks about connections, so related-account assertions and stated affiliations are prioritized.",
    };
  }
  if (
    mentions("who", "identity", "background", "bio", "profile", "contact", "professional")
  ) {
    return {
      intent: "IDENTITY",
      priorities: IDENTITY_PRIORITIES,
      rationale:
        "The question asks who this account is, so organization, contact channel and related-account claims are prioritized.",
    };
  }
  return {
    intent: "GENERAL",
    priorities: GENERAL_PRIORITIES,
    rationale:
      "No stronger signal in the question: every allowed predicate is in play, in registry order.",
  };
}

// --- Candidate claims ------------------------------------------------------

/**
 * How a candidate was extracted. Recorded on every stored claim's provenance
 * and shown in the report: an agent-submitted claim and a field-mapped
 * extraction are different provenances even when the predicate matches.
 */
export const RESEARCH_EXTRACTION_METHODS = ["JSONLD", "META_TAG", "LINK_HREF", "MAILTO"] as const;
export type ResearchExtractionMethod = (typeof RESEARCH_EXTRACTION_METHODS)[number];

/**
 * A candidate claim proposed by the extractor from one fetched document.
 * The extractor is deliberately DUMB: it maps fixed HTML fields to fixed
 * predicates and never interprets page prose. That is what makes prompt
 * injection in page content structurally inert — page text cannot name a
 * predicate, choose a value, or talk the engine into anything, because the
 * only inputs that ever become candidates are a short list of structured
 * fields, and the claims validation gate re-checks every one of them.
 */
export interface ResearchCandidate {
  predicate: ClaimPredicate;
  value: string;
  /** The short quote from the page that supports the value. */
  excerpt: string;
  /** The field the value came from, e.g. `ld+json Organization.name`. */
  field: string;
  method: ResearchExtractionMethod;
  /**
   * True when the value is written in the page's structured fields — the
   * strongest provenance the engine has. Always true today; the flag exists
   * so an inference-based extractor (if ever added) can be marked honestly
   * rather than blurting "documented" for a guess.
   */
  directlyDocumented: boolean;
  /** Predicate the extractor wanted but could not map confidently, if any. */
  uncertainty?: string | undefined;
}

export type ResearchDocumentOutcome =
  | "FETCHED"
  | "REUSED"
  | "FAILED"
  | "BLOCKED_BY_POLICY"
  | "BLOCKED_BY_ROBOTS"
  | "UNSAFE_URL"
  | "BLOCKED_CONTENT_TYPE"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK_ERROR";

/** Per-document result recorded on the run and shown in source coverage. */
export interface ResearchDocumentResult {
  url: string;
  outcome: ResearchDocumentOutcome;
  outcomeReason: string | null;
  httpStatus: number | null;
  title: string | null;
  contentType: string | null;
  byteSize: number | null;
  contentSha256: string | null;
  retrievedAt: string | null;
  sourceType: ResearchSourceType;
  candidatesFound: number;
  /** URLs discovered on this page that were deliberately NOT followed (depth bound). */
  linksNotFollowed: number;
}

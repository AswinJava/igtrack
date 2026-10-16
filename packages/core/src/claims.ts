// ---------------------------------------------------------------------------
// The claims ledger vocabulary (FOUNDING §18).
//
// IGTrack stores claims; it never generates them. A claim is an operator- or
// agent-submitted finding about an observed account, from a source the
// operator names, stored with its URL, a short excerpt, and the excerpt's
// hash. Claims are never platform facts: the research report keeps them in
// their own section and no claim is ever promoted into an observation.
//
// Two policy lists live here because they are the write-time honesty boundary:
// the closed ALLOWED predicate registry (an unknown predicate is refused, not
// stored under a guessed name) and the SENSITIVE refusals (person-level
// attributes IGTrack declines to store at all — FOUNDING §14/§18).
//
// Pure and dependency-free (core invariant).
// ---------------------------------------------------------------------------

export const CLAIM_PREDICATES = [
  "ORGANIZATION_NAME",
  "ORGANIZATION_KIND",
  "LOCATION_STATED",
  "INDUSTRY_OR_FIELD",
  "CONTACT_CHANNEL",
  "INSTITUTIONAL_AFFILIATION_STATED",
  "PRODUCT_OR_SERVICE",
  "RELATED_ACCOUNT_ASSERTED",
  "HISTORICAL_CHANGE_STATED",
] as const;

export type ClaimPredicate = (typeof CLAIM_PREDICATES)[number];

/** Human labels for the closed predicate registry (reports and tables). */
export const CLAIM_PREDICATE_LABELS: Record<ClaimPredicate, string> = {
  ORGANIZATION_NAME: "Organization name",
  ORGANIZATION_KIND: "Organization kind",
  LOCATION_STATED: "Location (as stated)",
  INDUSTRY_OR_FIELD: "Industry or field",
  CONTACT_CHANNEL: "Public contact channel",
  INSTITUTIONAL_AFFILIATION_STATED: "Institutional affiliation (as stated)",
  PRODUCT_OR_SERVICE: "Product or service",
  RELATED_ACCOUNT_ASSERTED: "Related account (as asserted)",
  HISTORICAL_CHANGE_STATED: "Historical change (as stated)",
};

export const CLAIM_SOURCE_KINDS = ["OPERATOR", "WEB"] as const;
export type ClaimSourceKind = (typeof CLAIM_SOURCE_KINDS)[number];

export const CLAIM_STATUSES = ["ACTIVE", "RETRACTED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Excerpts are short quotations for citation, not article storage. */
export const CLAIM_EXCERPT_MAX_LENGTH = 500;
/** A value is a designation (a name, a city, a URL), not a paragraph. */
export const CLAIM_VALUE_MAX_LENGTH = 500;
/** A claim whose retrieval basis is older than this is flagged DUE_FOR_REVIEW. */
export const CLAIM_REVIEW_HORIZON_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClaimRefusal {
  /** Matched against predicate name tokens by prefix. */
  stem: string;
  label: string;
}

const refusal = (stem: string, label: string): ClaimRefusal => ({ stem, label });

/**
 * Person-level sensitive categories. Matched by token prefix on the predicate
 * name (EMPLOYED_AT → token EMPLOYED starts with EMPLOY → refused). Order is
 * irrelevant; the first matching stem is reported. Checked only after the
 * allowed registry, so an explicitly allowed predicate can never be refused
 * by accident.
 */
export const CLAIM_SENSITIVE_REFUSALS: readonly ClaimRefusal[] = [
  refusal("EMPLOY", "employment status"),
  refusal("JOB", "employment status"),
  refusal("OCCUPAT", "occupation"),
  refusal("HEALTH", "health information"),
  refusal("MEDIC", "medical information"),
  refusal("MENTAL", "mental-health information"),
  refusal("PREGNAN", "pregnancy status"),
  refusal("RELIGI", "religious affiliation"),
  refusal("POLITIC", "political affiliation"),
  refusal("SEXUAL", "sexual orientation"),
  refusal("ORIENTATION", "sexual orientation"),
  refusal("ETHNIC", "ethnicity"),
  refusal("RACE", "race"),
  refusal("CITIZEN", "citizenship"),
  refusal("IMMIGRA", "immigration status"),
  refusal("CRIMIN", "criminal history"),
  refusal("LEGAL", "legal history"),
  refusal("ADDRESS", "home address"),
  refusal("RESIDEN", "home address"),
  refusal("EDUCAT", "education record"),
  refusal("SCHOOL", "school attendance"),
  refusal("DEGREE", "education record"),
  refusal("UNIVERSIT", "education record"),
  refusal("MARITAL", "marital status"),
  refusal("FAMILY", "family relationships"),
  refusal("RELATIONSHIP", "personal relationships"),
];

export function normalizePredicateName(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export type ClaimPredicateClassification =
  | { kind: "ALLOWED"; predicate: ClaimPredicate }
  | { kind: "REFUSED"; label: string; reason: string }
  | { kind: "UNKNOWN"; message: string };

/**
 * Classify a proposed predicate name. Refusal is a feature, not a failure:
 * the sensitive list is the line IGTrack does not store person-level data,
 * and the reason string says so where the caller can read it.
 */
export function classifyClaimPredicate(raw: string): ClaimPredicateClassification {
  const name = normalizePredicateName(raw);
  if ((CLAIM_PREDICATES as readonly string[]).includes(name)) {
    return { kind: "ALLOWED", predicate: name as ClaimPredicate };
  }
  const tokens = name.split(/[^A-Z0-9]+/).filter((t) => t !== "");
  for (const entry of CLAIM_SENSITIVE_REFUSALS) {
    if (tokens.some((token) => token.startsWith(entry.stem))) {
      return {
        kind: "REFUSED",
        label: entry.label,
        reason:
          `"${raw}" is ${entry.label}: person-level sensitive data that IGTrack ` +
          "declines to store, from any source (FOUNDING §14/§18). Ask the person, " +
          "or leave it unclaimed.",
      };
    }
  }
  return {
    kind: "UNKNOWN",
    message:
      `"${raw}" is not in the claim predicate registry. Allowed: ` +
      `${CLAIM_PREDICATES.join(", ")}.`,
  };
}

export type ClaimValueValidation =
  | { ok: true; value: string }
  | { ok: false; message: string };

export function validateClaimValue(raw: string): ClaimValueValidation {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "A claim value is required." };
  if (value.length > CLAIM_VALUE_MAX_LENGTH) {
    return {
      ok: false,
      message:
        `Claim values are capped at ${CLAIM_VALUE_MAX_LENGTH} characters (got ${value.length}); ` +
        "shorten the value and keep the full wording in the source excerpt.",
    };
  }
  return { ok: true, value };
}

export function validateClaimExcerpt(
  raw: string,
): { ok: true; excerpt: string } | { ok: false; message: string } {
  const excerpt = raw.trim();
  if (excerpt === "") return { ok: false, message: "An excerpt cannot be empty when provided." };
  if (excerpt.length > CLAIM_EXCERPT_MAX_LENGTH) {
    return {
      ok: false,
      message:
        `Excerpts are capped at ${CLAIM_EXCERPT_MAX_LENGTH} characters (got ${excerpt.length}); ` +
        "quote the sentence that supports the claim, not the page.",
    };
  }
  return { ok: true, excerpt };
}

export function claimSourceDomain(sourceUrl: string): string | null {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export type ClaimSourceUrlValidation =
  | { ok: true; url: string; domain: string }
  | { ok: false; message: string };

/**
 * Web claims must cite an absolute http(s) URL. Everything else — javascript:,
 * data:, file:, bare hosts — is refused: an agent must not be able to smuggle
 * a non-fetchable or executable scheme into the ledger and have the report
 * render it as a source.
 */
export function validateClaimSourceUrl(raw: string): ClaimSourceUrlValidation {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: `"${trimmed}" is not an absolute URL (http/https required).` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `Only http(s) sources are allowed (got "${url.protocol}").` };
  }
  const domain = claimSourceDomain(url.toString());
  if (domain === null || domain === "") {
    return { ok: false, message: `"${trimmed}" has no host to cite.` };
  }
  return { ok: true, url: url.toString(), domain };
}

export const ClaimRelationLabel = {
  CONFLICTED: "CONFLICTED",
  CORROBORATED: "CORROBORATED",
  SINGLE_SOURCE: "SINGLE_SOURCE",
  OPERATOR_ASSERTED: "OPERATOR_ASSERTED",
} as const;

export type ClaimRelationLabel = (typeof ClaimRelationLabel)[keyof typeof ClaimRelationLabel];

export interface ClaimRelationInput {
  value: string;
  sourceKind: ClaimSourceKind;
  sourceUrl: string | null;
}

export interface ClaimRelation {
  label: ClaimRelationLabel;
  /** Distinct web source domains behind this claim's value (empty for operator-only). */
  sourceDomains: string[];
  /** True when the predicate's active claims disagree on the value. */
  conflicted: boolean;
}

export function normalizeClaimValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Derive the honest relation label for one predicate's ACTIVE claims:
 *  - differing normalized values → CONFLICTED (both sides keep their sources,
 *    nothing is chosen for the operator);
 *  - one value, ≥ 2 distinct web domains → CORROBORATED;
 *  - one value, exactly one web domain → SINGLE_SOURCE;
 *  - one value, operator assertions only → OPERATOR_ASSERTED.
 *
 * There is deliberately no numeric confidence: a score would pretend the
 * sources are commensurable. Operator assertions never count toward
 * corroboration — they are the same single party that is asking.
 */
export function deriveClaimRelation(claims: readonly ClaimRelationInput[]): ClaimRelation {
  const groups = new Set<string>();
  const domains = new Set<string>();
  for (const claim of claims) {
    groups.add(normalizeClaimValue(claim.value));
    if (claim.sourceUrl !== null) {
      const domain = claimSourceDomain(claim.sourceUrl);
      if (domain !== null) domains.add(domain);
    }
  }
  const sourceDomains = [...domains].sort();
  const conflicted = groups.size > 1;
  const label: ClaimRelationLabel = conflicted
    ? ClaimRelationLabel.CONFLICTED
    : sourceDomains.length >= 2
      ? ClaimRelationLabel.CORROBORATED
      : sourceDomains.length === 1
        ? ClaimRelationLabel.SINGLE_SOURCE
        : ClaimRelationLabel.OPERATOR_ASSERTED;
  return { label, sourceDomains, conflicted };
}

/**
 * The retrieval basis for review: retrieved_at when the operator recorded when
 * they read the source, falling back to recorded_at (for operator assertions,
 * entry into the ledger IS the retrieval time in effect). Flagging never
 * hides or auto-retracts a claim — silent deletion is the failure mode this
 * ledger exists to prevent.
 */
export function claimReviewBasis(claim: { retrievedAt: Date | null; recordedAt: Date }): Date {
  return claim.retrievedAt ?? claim.recordedAt;
}

export function isClaimDueForReview(
  claim: { retrievedAt: Date | null; recordedAt: Date },
  now: Date,
): boolean {
  return now.getTime() - claimReviewBasis(claim).getTime() > CLAIM_REVIEW_HORIZON_DAYS * DAY_MS;
}

export function claimAgeDays(
  claim: { retrievedAt: Date | null; recordedAt: Date },
  now: Date,
): number {
  const age = now.getTime() - claimReviewBasis(claim).getTime();
  return age <= 0 ? 0 : Math.floor(age / DAY_MS);
}

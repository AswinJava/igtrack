import { describe, expect, it } from "vitest";
import {
  CLAIM_EXCERPT_MAX_LENGTH,
  CLAIM_PREDICATES,
  claimAgeDays,
  classifyClaimPredicate,
  deriveClaimRelation,
  isClaimDueForReview,
  validateClaimExcerpt,
  validateClaimSourceUrl,
  validateClaimValue,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The claims vocabulary is the write-time honesty boundary:
// what IGTrack is willing to store, what it refuses outright, and how a
// stored row is labelled at read time. Every rule here is a promise the
// research report renders, so each one is pinned.
// ---------------------------------------------------------------------------

describe("claim predicate classification", () => {
  it("allows every predicate in the registry, normalized from loose spellings", () => {
    for (const predicate of CLAIM_PREDICATES) {
      expect(classifyClaimPredicate(predicate)).toEqual({ kind: "ALLOWED", predicate });
    }
    expect(classifyClaimPredicate("organization name")).toEqual({
      kind: "ALLOWED",
      predicate: "ORGANIZATION_NAME",
    });
    expect(classifyClaimPredicate("location-stated")).toEqual({
      kind: "ALLOWED",
      predicate: "LOCATION_STATED",
    });
  });

  it("never refuses a registry predicate token (no stem may shadow an allowed name)", () => {
    for (const predicate of CLAIM_PREDICATES) {
      expect(classifyClaimPredicate(predicate).kind).toBe("ALLOWED");
    }
  });

  it("refuses person-level sensitive predicates with a policy reason", () => {
    for (const raw of [
      "EMPLOYED_AT",
      "EMPLOYMENT_STATUS",
      "JOB_TITLE",
      "OCCUPATION",
      "HEALTH_STATUS",
      "MEDICAL_CONDITION",
      "MENTAL_HEALTH",
      "PREGNANCY",
      "RELIGIOUS_AFFILIATION",
      "POLITICAL_PARTY",
      "SEXUAL_ORIENTATION",
      "ETHNICITY",
      "RACE",
      "CITIZENSHIP",
      "IMMIGRATION_STATUS",
      "CRIMINAL_RECORD",
      "LEGAL_HISTORY",
      "HOME_ADDRESS",
      "RESIDENTIAL_ADDRESS",
      "EDUCATION_STATUS",
      "SCHOOL",
      "UNIVERSITY",
      "DEGREE",
      "MARITAL_STATUS",
      "FAMILY_STATUS",
      "PERSONAL_RELATIONSHIPS",
    ]) {
      const classified = classifyClaimPredicate(raw);
      expect(classified.kind, raw).toBe("REFUSED");
      if (classified.kind === "REFUSED") {
        expect(classified.reason, raw).toContain("person-level sensitive data");
      }
    }
  });

  it("does not refuse an allowed name that merely shares letters with a stem", () => {
    // RELATED_ACCOUNT_ASSERTED contains no RELATIONSHIP token; this pins that
    // refusal is token-prefix based, not substring based.
    expect(classifyClaimPredicate("RELATED_ACCOUNT_ASSERTED").kind).toBe("ALLOWED");
  });

  it("answers UNKNOWN, not REFUSED, for a name outside both lists", () => {
    const classified = classifyClaimPredicate("FAVORITE_COLOR");
    expect(classified.kind).toBe("UNKNOWN");
    if (classified.kind === "UNKNOWN") {
      expect(classified.message).toContain("ORGANIZATION_NAME");
    }
  });
});

describe("claim value and excerpt validation", () => {
  it("requires a non-empty value, trims it, and caps its length", () => {
    expect(validateClaimValue("  Aurora Studio  ")).toEqual({ ok: true, value: "Aurora Studio" });
    expect(validateClaimValue("   ").ok).toBe(false);
    expect(validateClaimValue("x".repeat(501)).ok).toBe(false);
    expect(validateClaimValue("x".repeat(500)).ok).toBe(true);
  });

  it("caps excerpts at the citation length and refuses empty ones when provided", () => {
    expect(validateClaimExcerpt("  quoted sentence  ")).toEqual({
      ok: true,
      excerpt: "quoted sentence",
    });
    expect(validateClaimExcerpt(" ").ok).toBe(false);
    expect(validateClaimExcerpt("x".repeat(CLAIM_EXCERPT_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe("claim source URL validation", () => {
  it("accepts http and https and reports the citable domain", () => {
    expect(validateClaimSourceUrl("https://www.example.org/story")).toEqual({
      ok: true,
      url: "https://www.example.org/story",
      domain: "example.org",
    });
    expect(validateClaimSourceUrl("http://example.net/a").ok).toBe(true);
  });

  it("refuses non-http(s) schemes so the report can never render an executable source", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.org/x"]) {
      const validated = validateClaimSourceUrl(raw);
      expect(validated.ok, raw).toBe(false);
    }
  });

  it("refuses relative or hostless strings", () => {
    expect(validateClaimSourceUrl("example.org/story").ok).toBe(false);
    expect(validateClaimSourceUrl("not a url").ok).toBe(false);
  });
});

describe("claim relation derivation", () => {
  const web = (value: string, url: string) =>
    ({ value, sourceKind: "WEB" as const, sourceUrl: url });

  it("labels a single web source SINGLE_SOURCE", () => {
    const relation = deriveClaimRelation([web("Aurora Studio", "https://a.example.org/x")]);
    expect(relation.label).toBe("SINGLE_SOURCE");
    expect(relation.sourceDomains).toEqual(["a.example.org"]);
    expect(relation.conflicted).toBe(false);
  });

  it("labels equivalent values from two distinct domains CORROBORATED", () => {
    const relation = deriveClaimRelation([
      web("Aurora Studio", "https://a.example.org/x"),
      web("aurora  studio", "https://b.example.net/y"),
    ]);
    expect(relation.label).toBe("CORROBORATED");
    expect(relation.sourceDomains).toEqual(["a.example.org", "b.example.net"]);
    expect(relation.conflicted).toBe(false);
  });

  it("does not count the same domain twice as corroboration", () => {
    const relation = deriveClaimRelation([
      web("Aurora Studio", "https://a.example.org/x"),
      web("Aurora Studio", "https://www.a.example.org/y"),
    ]);
    expect(relation.label).toBe("SINGLE_SOURCE");
  });

  it("labels differing normalized values CONFLICTED and picks no winner", () => {
    const relation = deriveClaimRelation([
      web("Lisbon", "https://a.example.org/x"),
      web("Porto", "https://b.example.net/y"),
    ]);
    expect(relation.label).toBe("CONFLICTED");
    expect(relation.conflicted).toBe(true);
  });

  it("treats case and whitespace differences as the same value, not a conflict", () => {
    const relation = deriveClaimRelation([
      web("Lisbon", "https://a.example.org/x"),
      web("  lisbon ", "https://b.example.net/y"),
    ]);
    expect(relation.conflicted).toBe(false);
    expect(relation.label).toBe("CORROBORATED");
  });

  it("labels operator-only assertions OPERATOR_ASSERTED, never corroborated", () => {
    const relation = deriveClaimRelation([
      { value: "hello@a.example", sourceKind: "OPERATOR", sourceUrl: null },
      { value: "hello@a.example", sourceKind: "OPERATOR", sourceUrl: null },
    ]);
    expect(relation.label).toBe("OPERATOR_ASSERTED");
    expect(relation.sourceDomains).toEqual([]);
  });

  it("does not let an operator assertion corroborate a web source", () => {
    const relation = deriveClaimRelation([
      { value: "Aurora Studio", sourceKind: "OPERATOR", sourceUrl: null },
      web("Aurora Studio", "https://a.example.org/x"),
    ]);
    expect(relation.label).toBe("SINGLE_SOURCE");
  });
});

describe("claim review horizon", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it("flags a claim retrieved more than 180 days ago", () => {
    const claim = { retrievedAt: daysAgo(181), recordedAt: daysAgo(1) };
    expect(isClaimDueForReview(claim, now)).toBe(true);
    expect(claimAgeDays(claim, now)).toBe(181);
  });

  it("does not flag a claim inside the horizon", () => {
    expect(isClaimDueForReview({ retrievedAt: daysAgo(179), recordedAt: daysAgo(1) }, now)).toBe(false);
  });

  it("falls back to recorded_at when retrieved_at is absent", () => {
    expect(isClaimDueForReview({ retrievedAt: null, recordedAt: daysAgo(200) }, now)).toBe(true);
    expect(isClaimDueForReview({ retrievedAt: null, recordedAt: daysAgo(10) }, now)).toBe(false);
  });
});

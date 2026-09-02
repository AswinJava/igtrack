import { describe, expect, it } from "vitest";
import {
  CLAIM_PREDICATES,
  RESEARCH_BLOCKED_HOSTS,
  RESEARCH_DOCUMENT_FRESH_HOURS,
  RESEARCH_EXTRACTION_METHODS,
  RESEARCH_FETCH_TIMEOUT_MS,
  RESEARCH_INTENTS,
  RESEARCH_MAX_BYTES,
  RESEARCH_MAX_DEPTH,
  RESEARCH_MAX_REDIRECTS,
  RESEARCH_MAX_SOURCES,
  RESEARCH_SOURCE_POLICIES,
  RESEARCH_SOURCE_TYPES,
  researchFocusForQuestion,
  researchHostPolicy,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The research engine's pure layer: machine-enforced
// bounds, the host policy that keeps platform data off the web-fetch path,
// and the question→intent mapping. Every value here is a promise the run
// record and the report render, so each is pinned as data, not prose.
// ---------------------------------------------------------------------------

describe("research bounds are enforced constants, not documentation", () => {
  it("pins the §4.7 protocol numbers the engine actually enforces", () => {
    expect(RESEARCH_MAX_SOURCES).toBe(10);
    expect(RESEARCH_MAX_DEPTH).toBe(1);
    expect(RESEARCH_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(RESEARCH_MAX_BYTES).toBe(512 * 1024);
    expect(RESEARCH_MAX_REDIRECTS).toBe(3);
    expect(RESEARCH_DOCUMENT_FRESH_HOURS).toBe(24);
  });

  it("declares both source policies with their credential and retention asymmetry", () => {
    expect(RESEARCH_SOURCE_TYPES).toEqual(["OPERATOR_SUPPLIED_URL", "SEARCH_RESULT"]);
    for (const type of RESEARCH_SOURCE_TYPES) {
      const policy = RESEARCH_SOURCE_POLICIES[type];
      expect(policy.type).toBe(type);
      expect(policy.label.length).toBeGreaterThan(0);
      expect(policy.restrictions.length).toBeGreaterThan(0);
      expect(policy.attribution.length).toBeGreaterThan(0);
      expect(policy.freshness.length).toBeGreaterThan(0);
    }
    // Direct fetch needs no credentials; search does — and without one the
    // capability answers UNAVAILABLE rather than inventing results.
    expect(RESEARCH_SOURCE_POLICIES.OPERATOR_SUPPLIED_URL.requiresCredentials).toBe(false);
    expect(RESEARCH_SOURCE_POLICIES.SEARCH_RESULT.requiresCredentials).toBe(true);
    // Page bodies are never retained; only metadata + short excerpts are.
    expect(RESEARCH_SOURCE_POLICIES.OPERATOR_SUPPLIED_URL.retention).toMatch(/NOT stored/);
  });

  it("declares the four structured extraction methods and the four intents", () => {
    expect(RESEARCH_EXTRACTION_METHODS).toEqual(["JSONLD", "META_TAG", "LINK_HREF", "MAILTO"]);
    expect(RESEARCH_INTENTS).toEqual(["IDENTITY", "ORGANIZATION", "CONNECTIONS", "GENERAL"]);
  });
});

describe("research host policy", () => {
  it("refuses Instagram-family platform data: it is Graph-API-only territory", () => {
    expect(RESEARCH_BLOCKED_HOSTS).toContain("instagram.com");
    for (const host of [
      "instagram.com",
      "www.instagram.com",
      "m.facebook.com",
      "facebook.com",
      "threads.net",
      "www.threads.net",
      "whatsapp.com",
    ]) {
      const decision = researchHostPolicy(host);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toMatch(/Graph API|platform data/);
      }
    }
  });

  it("refuses loopback names before any DNS work", () => {
    for (const host of ["localhost", "app.localhost"]) {
      const decision = researchHostPolicy(host);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toMatch(/loopback/);
    }
  });

  it("allows ordinary public hosts, including ones that merely mention instagram in a path", () => {
    for (const host of ["example.com", "aurora.example", "x.com", "brave.com", "igtrack.dev"]) {
      expect(researchHostPolicy(host)).toEqual({ allowed: true });
    }
  });
});

describe("question → research focus", () => {
  it("maps organization questions to organization priorities, in registry predicates only", () => {
    const focus = researchFocusForQuestion("What company or studio runs this account?");
    expect(focus.intent).toBe("ORGANIZATION");
    expect(focus.priorities[0]).toBe("ORGANIZATION_NAME");
    expect(focus.rationale.length).toBeGreaterThan(0);
    for (const predicate of focus.priorities) {
      expect(CLAIM_PREDICATES).toContain(predicate);
    }
  });

  it("maps connection questions to related-account priorities", () => {
    const focus = researchFocusForQuestion("Which accounts does this one collaborate with?");
    expect(focus.intent).toBe("CONNECTIONS");
    expect(focus.priorities).toContain("RELATED_ACCOUNT_ASSERTED");
  });

  it("maps identity questions to identity priorities", () => {
    const focus = researchFocusForQuestion("Who is behind this profile?");
    expect(focus.intent).toBe("IDENTITY");
    expect(focus.priorities).toContain("CONTACT_CHANNEL");
  });

  it("falls back to GENERAL: every allowed predicate in play, nothing widened", () => {
    const focus = researchFocusForQuestion("what about it");
    expect(focus.intent).toBe("GENERAL");
    expect(focus.priorities.length).toBeGreaterThan(3);
    for (const predicate of focus.priorities) {
      expect(CLAIM_PREDICATES).toContain(predicate);
    }
  });

  it("is deterministic: the same question always yields the same focus", () => {
    const a = researchFocusForQuestion("organization history of this brand");
    const b = researchFocusForQuestion("organization history of this brand");
    expect(a).toEqual(b);
  });

  it("never maps a question onto a refused predicate — intent cannot widen permission", () => {
    for (const question of [
      "who employs this person",
      "what is their political party",
      "list their health status",
      "what is their job title",
    ]) {
      const focus = researchFocusForQuestion(question);
      for (const predicate of focus.priorities) {
        expect(CLAIM_PREDICATES).toContain(predicate);
      }
    }
  });
});

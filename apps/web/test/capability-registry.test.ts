import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY, CapabilityName, type CapabilityName as CapabilityNameType } from "@igtrack/core";
import * as schema from "@igtrack/database";

// Cross-package consistency pin (§21-feed): the registry, the provider
// contract, and the schema must never drift apart silently. A provider
// method with no registry entry is an undocumented capability; a registry
// entry pointing at a nonexistent method or table is a dead reference.

const STUB_PROVIDER_METHODS: CapabilityNameType[] = [
  "resolveAccount",
  "getProfile",
  "getStories",
  "getFollowers",
  "getFollowing",
  "getPublicPosts",
  "getPublicComments",
  "getPostChildren",
];

describe("capability registry consistency", () => {
  it("covers every provider contract method", () => {
    const covered = new Set(
      CAPABILITY_REGISTRY.flatMap((entry) => entry.providerMethods),
    );
    for (const method of STUB_PROVIDER_METHODS) {
      expect(covered.has(method), `provider method ${method} has no registry entry`).toBe(true);
    }
    // No typo'd method names: every referenced method is a real contract key.
    const contractValues = new Set(Object.values(CapabilityName));
    for (const method of covered) {
      expect(contractValues.has(method)).toBe(true);
    }
  });

  it("references only tables that exist in the schema", () => {
    const exports = schema as unknown as Record<string, unknown>;
    for (const entry of CAPABILITY_REGISTRY) {
      for (const table of entry.persistence) {
        expect(exports[table], `${entry.id} references missing table ${table}`).toBeDefined();
      }
    }
  });

  it("has unique ids and complete educational fields", () => {
    const ids = CAPABILITY_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(17);
    for (const entry of CAPABILITY_REGISTRY) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.howItWorks.length).toBeGreaterThan(20);
      expect(entry.permissions.length).toBeGreaterThan(0);
      // Every capability carries its live-verification state: no COMPLETE
      // claim may rest on fixtures alone.
      expect(["LIVE_VERIFIED", "NOT_VERIFIED", "DOCUMENTED_ABSENT"]).toContain(entry.liveState);
      expect(entry.liveEvidence.length, `${entry.id} needs live evidence`).toBeGreaterThan(20);
      if (entry.providerMethods.length === 0) {
        // A capability with no provider path must say exactly why.
        expect(entry.whyUnavailable, `${entry.id} needs a reason`).not.toBeNull();
        expect(entry.unlock, `${entry.id} needs unlock criteria`).not.toBeNull();
      }
    }
  });

  it("marks highlights/likes/reposts/media unavailable with reasons, never silently", () => {
    const byId = new Map(CAPABILITY_REGISTRY.map((e) => [e.id, e]));
    for (const id of ["HIGHLIGHTS", "LIKES", "INTERACTIONS", "REPOSTS"] as const) {
      const entry = byId.get(id)!;
      expect(entry.providerMethods).toEqual([]);
      expect(entry.whyUnavailable).toMatch(/./);
    }
  });
});

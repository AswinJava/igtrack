import { expect } from "vitest";
import type { InstagramProvider } from "@igtrack/core";

// Provider conformance harness (STEP 15): reusable contract checks. Any future
// provider must satisfy these shapes — the FixtureProvider is the canonical
// reference implementation (T0).

export function expectCapabilityShape(provider: InstagramProvider): void {
  const caps = provider.capabilities();
  for (const [name, enabled] of Object.entries(caps)) {
    expect(name).toEqual(expect.any(String));
    expect(typeof enabled).toBe("boolean");
  }
  expect(caps.getProfile).toBeDefined();
  expect(caps.getFollowers).toBeDefined();
  expect(caps.getFollowing).toBeDefined();
  expect(caps.getStories).toBeDefined();
}

export interface ProvenanceShape {
  status: string;
  observedAt?: string;
  source?: unknown;
}

export function expectProvenanceShape(result: ProvenanceShape): void {
  expect(result.status).toBeTruthy();
  expect(result.observedAt).toEqual(expect.any(String));
  expect(Number.isNaN(Date.parse(result.observedAt!))).toBe(false);
  expect(result.source).toBeTruthy();
}

// STEP 6 raw-hash semantics: raw_hash may be a genuine provider-transported
// hash or NULL — it must never be a normalized-data hash.
export function expectRawHashHonest(rawHash: string | null | undefined): void {
  if (rawHash === null || rawHash === undefined) return;
  expect(rawHash).toMatch(/^[0-9a-f]{64}$/);
}
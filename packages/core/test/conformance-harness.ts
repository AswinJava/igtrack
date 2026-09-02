import { expect } from "vitest";
import type { InstagramProvider } from "@igtrack/core";

// Provider conformance harness: reusable contract checks. Every provider must
// satisfy these shapes — FixtureProvider is the canonical example.

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
  expect(caps.resolveAccount).toBeDefined();
  expect(caps.getPublicPosts).toBeDefined();
  expect(caps.getPublicComments).toBeDefined();
  expect(typeof provider.resolveAccount).toBe("function");
  expect(typeof provider.getPublicPosts).toBe("function");
  expect(typeof provider.getPublicComments).toBe("function");
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

// Raw-hash semantics: raw_hash may be a genuine provider-transported
// hash or NULL — it must never be a normalized-data hash.
export function expectRawHashHonest(rawHash: string | null | undefined): void {
  if (rawHash === null || rawHash === undefined) return;
  expect(rawHash).toMatch(/^[0-9a-f]{64}$/);
}
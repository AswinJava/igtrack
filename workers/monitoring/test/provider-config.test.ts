import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../src/provider.js";

describe("provider credential safety (Phase 10 §7)", () => {
  it("fails fast with a configuration error for an unknown provider — never UNAVAILABLE", () => {
    const prev = process.env.IGTRACK_PROVIDER;
    process.env.IGTRACK_PROVIDER = "scraper";
    try {
      expect(() => providerFromEnv()).toThrow(/no provider implementation for "scraper"/);
      // Message must be actionable and must not claim UNAVAILABLE
      try {
        providerFromEnv();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/UNAVAILABLE/i);
        expect(msg).toMatch(/IGTRACK_PROVIDER/i);
      }
    } finally {
      if (prev === undefined) delete process.env.IGTRACK_PROVIDER;
      else process.env.IGTRACK_PROVIDER = prev;
    }
  });

  it("fails fast when graph is selected without credentials — never UNAVAILABLE", () => {
    const prevProvider = process.env.IGTRACK_PROVIDER;
    const prevToken = process.env.IGTRACK_GRAPH_ACCESS_TOKEN;
    const prevId = process.env.IGTRACK_GRAPH_IG_USER_ID;
    const prevUser = process.env.IGTRACK_GRAPH_USERNAME;
    process.env.IGTRACK_PROVIDER = "graph";
    delete process.env.IGTRACK_GRAPH_ACCESS_TOKEN;
    delete process.env.IGTRACK_GRAPH_IG_USER_ID;
    delete process.env.IGTRACK_GRAPH_USERNAME;
    try {
      expect(() => providerFromEnv()).toThrow(/missing required env/);
    } finally {
      if (prevProvider === undefined) delete process.env.IGTRACK_PROVIDER;
      else process.env.IGTRACK_PROVIDER = prevProvider;
      if (prevToken !== undefined) process.env.IGTRACK_GRAPH_ACCESS_TOKEN = prevToken;
      if (prevId !== undefined) process.env.IGTRACK_GRAPH_IG_USER_ID = prevId;
      if (prevUser !== undefined) process.env.IGTRACK_GRAPH_USERNAME = prevUser;
    }
  });

  it("defaults to fixture when IGTRACK_PROVIDER is unset", () => {
    const prev = process.env.IGTRACK_PROVIDER;
    delete process.env.IGTRACK_PROVIDER;
    try {
      const src = providerFromEnv();
      expect(src.provider.sourceId).toBe("fixture:v1");
    } finally {
      if (prev !== undefined) process.env.IGTRACK_PROVIDER = prev;
    }
  });
});

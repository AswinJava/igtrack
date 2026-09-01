import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../src/provider.js";

describe("provider credential safety (Phase 10 §7)", () => {
  it("fails fast with a configuration error for an unknown provider — never UNAVAILABLE", () => {
    const prev = process.env.IGTRACK_PROVIDER;
    process.env.IGTRACK_PROVIDER = "graph";
    try {
      expect(() => providerFromEnv()).toThrow(/no provider implementation for "graph"/);
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

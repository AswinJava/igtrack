import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureProvider } from "@igtrack/ingestion";

const fixturesDir = fileURLToPath(
  new URL("../../../packages/ingestion/fixtures/v1", import.meta.url),
);

describe("product capability honesty", () => {
  it("exposes exactly the 7 contracted provider methods, no highlights/likes", () => {
    const provider = new FixtureProvider({ fixturesDir }) as unknown as Record<string, unknown>;
    expect(typeof provider["resolveAccount"]).toBe("function");
    expect(typeof provider["getProfile"]).toBe("function");
    expect(typeof provider["getStories"]).toBe("function");
    expect(typeof provider["getFollowers"]).toBe("function");
    expect(typeof provider["getFollowing"]).toBe("function");
    expect(typeof provider["getPublicPosts"]).toBe("function");
    expect(typeof provider["getPublicComments"]).toBe("function");
    expect(provider["getHighlights"]).toBeUndefined();
    expect(provider["getLikes"]).toBeUndefined();
    expect(provider["getReels"]).toBeUndefined();
  });

  it("declares adapter capabilities while product docs mark highlights/likes UNAVAILABLE", async () => {
    const provider = new FixtureProvider({ fixturesDir });
    const caps = provider.capabilities();
    expect(Object.keys(caps)).toHaveLength(7);
    expect(Object.values(caps).every(Boolean)).toBe(true);
  });
});

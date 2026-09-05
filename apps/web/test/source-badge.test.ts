import { describe, expect, it } from "vitest";
import { sourceBadgeForSources } from "../lib/source-badge.js";

describe("source badge derivation", () => {
  it("returns null with no observations instead of a false claim", () => {
    expect(sourceBadgeForSources([])).toBeNull();
  });

  it("marks fixture observations synthetic", () => {
    expect(sourceBadgeForSources(["fixture:v1"])).toBe("SYNTHETIC SOURCE");
  });

  it("marks graph observations live", () => {
    expect(sourceBadgeForSources(["graph:v1"])).toBe("LIVE GRAPH SOURCE");
  });

  it("prefers the live badge when both sources are present", () => {
    expect(sourceBadgeForSources(["fixture:v1", "graph:v1"])).toBe(
      "LIVE GRAPH SOURCE",
    );
  });

  it("ignores unknown source ids", () => {
    expect(sourceBadgeForSources(["import:manual"])).toBeNull();
  });

  it("never throws on dirty input", () => {
    expect(sourceBadgeForSources([undefined as unknown as string])).toBeNull();
    expect(
      sourceBadgeForSources([null as unknown as string, "fixture:v1"]),
    ).toBe("SYNTHETIC SOURCE");
  });
});

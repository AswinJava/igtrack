import { describe, expect, it } from "vitest";
import { diffFollowSets } from "../src/diff/follow-diff.js";

describe("diffFollowSets", () => {
  it("detects added and removed accounts", () => {
    const diff = diffFollowSets(["a", "b", "c"], ["b", "c", "d"]);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.unchangedCount).toBe(2);
  });

  it("handles empty previous snapshot (all new)", () => {
    const diff = diffFollowSets([], ["a", "b"]);
    expect(diff.added).toEqual(["a", "b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("handles empty next snapshot (all lost)", () => {
    const diff = diffFollowSets(["a", "b"], []);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["a", "b"]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("deduplicates repeated ids within a snapshot", () => {
    const diff = diffFollowSets(["a", "a"], ["a"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("returns sorted, deterministic output", () => {
    const diff = diffFollowSets(["z"], ["m", "a"]);
    expect(diff.added).toEqual(["a", "m"]);
    expect(diff.removed).toEqual(["z"]);
  });
});

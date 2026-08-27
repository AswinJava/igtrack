import { describe, expect, it } from "vitest";
import { diffProfileFields } from "../src/diff/profile-diff.js";

describe("diffProfileFields", () => {
  it("reports changed counts and bio", () => {
    const changes = diffProfileFields(
      { followerCount: 420, bio: "old", username: "target_a" },
      { followerCount: 427, bio: "new", username: "target_a" },
    );
    expect(changes).toEqual([
      { field: "bio", oldValue: "old", newValue: "new" },
      { field: "followerCount", oldValue: 420, newValue: 427 },
    ]);
  });

  it("returns empty list when nothing changed", () => {
    const same = { username: "target_a", followerCount: 10, isVerified: false };
    expect(diffProfileFields(same, { ...same })).toEqual([]);
  });

  it("treats unknown (undefined) as null and reports first appearance", () => {
    const changes = diffProfileFields(
      { username: "target_a" },
      { username: "target_a", externalUrl: "https://example.com" },
    );
    expect(changes).toEqual([
      { field: "externalUrl", oldValue: null, newValue: "https://example.com" },
    ]);
  });

  it("reports verification flips", () => {
    const changes = diffProfileFields(
      { isVerified: false },
      { isVerified: true },
    );
    expect(changes).toEqual([
      { field: "isVerified", oldValue: false, newValue: true },
    ]);
  });

  it("emits fields in deterministic order", () => {
    const changes = diffProfileFields(
      { postCount: 1, bio: "a", username: "x" },
      { postCount: 2, bio: "b", username: "y" },
    );
    expect(changes.map((c) => c.field)).toEqual([
      "username",
      "bio",
      "postCount",
    ]);
  });
});

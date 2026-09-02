import { describe, expect, it } from "vitest";
import {
  diffProfileFields,
  isMaterialProfileFieldChange,
} from "../src/diff/profile-diff.js";

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

  it("reports privacy flips", () => {
    const changes = diffProfileFields(
      { username: "target_a", isPrivate: false },
      { username: "target_a", isPrivate: true },
    );
    expect(changes).toEqual([
      { field: "isPrivate", oldValue: false, newValue: true },
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

  it("ignores CDN host and query rotation on the profile picture", () => {
    const changes = diffProfileFields(
      {
        profilePicUrl:
          "https://scontent.cdninstagram.com/v/t51.2885-19/abc_n.jpg?_nc_oc=AAA&oh=111&_nc_gid=x",
      },
      {
        profilePicUrl:
          "https://instagram.fmaa1-1.fna.fbcdn.net/v/t51.2885-19/abc_n.jpg?_nc_oc=BBB&oh=222&_nc_gid=y",
      },
    );
    expect(changes).toEqual([]);
  });

  it("still reports a real profile picture replacement with raw values", () => {
    const oldUrl = "https://scontent.cdninstagram.com/v/t51.2885-19/old_n.jpg?oh=1";
    const newUrl = "https://scontent.cdninstagram.com/v/t51.2885-19/new_n.jpg?oh=2";
    const changes = diffProfileFields(
      { profilePicUrl: oldUrl },
      { profilePicUrl: newUrl },
    );
    expect(changes).toEqual([
      { field: "profilePicUrl", oldValue: oldUrl, newValue: newUrl },
    ]);
  });

  it("knows which stored picture changes are material", () => {
    expect(
      isMaterialProfileFieldChange(
        "profilePicUrl",
        "https://a.cdninstagram.com/v/t51.2885-19/abc_n.jpg?oh=1",
        "https://b.fbcdn.net/v/t51.2885-19/abc_n.jpg?_nc_oc=2",
      ),
    ).toBe(false);
    expect(
      isMaterialProfileFieldChange(
        "profilePicUrl",
        "https://a.cdninstagram.com/v/t51.2885-19/abc_n.jpg?oh=1",
        "https://a.cdninstagram.com/v/t51.2885-19/def_n.jpg?oh=1",
      ),
    ).toBe(true);
    expect(isMaterialProfileFieldChange("bio", "a", "b")).toBe(true);
    expect(isMaterialProfileFieldChange("profilePicUrl", null, "https://x/y.jpg")).toBe(true);
  });
});

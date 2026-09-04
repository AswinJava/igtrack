import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityStatus, isUsable } from "@igtrack/core";
import { FixtureProvider } from "../src/fixture/fixture-provider.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/v1", import.meta.url));

// End-to-end user journey at the provider boundary (no DB, no network):
// search → profile → stories → followers → following → posts → comments.
describe("e2e user journey (provider)", () => {
  it("search → profile → stories → follows → posts → comments matches stored fixtures", async () => {
    const provider = new FixtureProvider({ fixturesDir });

    const resolved = await provider.resolveAccount("aurora.wilde");
    expect(isUsable(resolved)).toBe(true);
    if (!isUsable(resolved)) return;
    expect(resolved.data.username).toBe("aurora.wilde");

    const missing = await provider.resolveAccount("nobody.here");
    expect(missing.status).toBe(CapabilityStatus.ERROR);

    const profile = await provider.getProfile(resolved.data);
    expect(isUsable(profile)).toBe(true);
    if (!isUsable(profile)) return;
    expect(profile.data.followerCount).toBe(12480);
    expect(profile.data.followingCount).toBe(312);

    const stories = await provider.getStories(resolved.data);
    if (!isUsable(stories)) throw new Error("stories must be usable");
    expect(stories.data).toHaveLength(3);

    const followers1 = await provider.getFollowers(resolved.data);
    if (!isUsable(followers1)) throw new Error("followers page 1 must be usable");
    expect(followers1.data.complete).toBe(false);
    const cursor = followers1.data.nextCursor;
    expect(cursor).toBeDefined();
    const followers2 = await provider.getFollowers(resolved.data, { value: cursor! });
    if (!isUsable(followers2)) throw new Error("followers page 2 must be usable");
    expect(followers2.data.complete).toBe(true);
    expect([...followers1.data.entries, ...followers2.data.entries]).toHaveLength(5);

    const following = await provider.getFollowing(resolved.data);
    if (!isUsable(following)) throw new Error("following must be usable");
    expect(following.data.entries).toHaveLength(4);

    const posts = await provider.getPublicPosts(resolved.data);
    if (!isUsable(posts)) throw new Error("posts must be usable");
    expect(posts.data).toHaveLength(2);

    const comments1 = await provider.getPublicComments(posts.data[0]!);
    expect(comments1.status).toBe(CapabilityStatus.AVAILABLE);
    if (!isUsable(comments1)) throw new Error("post-1 comments must be usable");
    expect(comments1.data).toHaveLength(3);

    const comments2 = await provider.getPublicComments(posts.data[1]!);
    expect(comments2.status).toBe(CapabilityStatus.UNAVAILABLE);

    const providerAny = provider as unknown as Record<string, unknown>;
    expect(providerAny["getHighlights"]).toBeUndefined();
    expect(providerAny["getLikes"]).toBeUndefined();
  });
});

import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CapabilityErrorKind,
  CapabilityStatus,
  Confidence,
  isUsable,
  MentionVisibilityClass,
  ObservationCategory,
  type NormalizedAccountRef,
  type NormalizedPost,
} from "@igtrack/core";
import { FixtureProvider } from "../src/fixture/fixture-provider.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/v1", import.meta.url));
const FIXED_NOW = new Date("2026-08-27T12:00:00.000Z");

let provider: FixtureProvider;
let target: NormalizedAccountRef;

beforeAll(async () => {
  provider = new FixtureProvider({
    fixturesDir,
    clock: () => FIXED_NOW,
  });
  const resolved = await provider.resolveAccount("aurora.wilde");
  if (!isUsable(resolved)) throw new Error("fixture target must resolve");
  target = resolved.data;
});

describe("FixtureProvider", () => {
  it("declares capabilities honestly, including no child-media source", () => {
    const caps = provider.capabilities();
    expect(caps.getPostChildren).toBe(false);
    for (const [name, on] of Object.entries(caps)) {
      if (name === "getPostChildren") continue;
      expect(on).toBe(true);
    }
  });

  it("reports children UNAVAILABLE instead of an empty album", async () => {
    const result = await provider.getPostChildren({
      postId: "post-1",
      takenAt: "2026-08-25T12:00:00.000Z",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: "2026-08-27T12:00:00.000Z",
      },
    });
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
  });

  it("resolves the fixture target case-insensitively", async () => {
    const result = await provider.resolveAccount("Aurora.Wilde");
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.username).toBe("aurora.wilde");
    expect(result.data?.igId).toBe("9000000001");
  });

  it("returns ACCOUNT_NOT_FOUND for unknown usernames", async () => {
    const result = await provider.resolveAccount("someone.else");
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(result.error?.retryable).toBe(false);
  });

  it("normalizes the profile as OBSERVED/HIGH with genuine raw provenance", async () => {
    const result = await provider.getProfile(target);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const profile = result.data;
    expect(profile).toBeDefined();
    if (!profile) return;
    expect(profile.followerCount).toBe(12480);
    expect(profile.followingCount).toBe(312);
    expect(profile.postCount).toBe(148);
    expect(profile.isVerified).toBe(false);
    expect(profile.meta.category).toBe(ObservationCategory.OBSERVED);
    expect(profile.meta.confidence).toBe(Confidence.HIGH);

    // Raw provenance is the genuine fixture-file hash, not a normalized hash.
    expect(result.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawReference).toBe("fixture:v1/profile.json");
  });

  it("normalizes stories and classifies every mention variant", async () => {
    const result = await provider.getStories(target);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const stories = result.data ?? [];
    expect(stories).toHaveLength(3);

    const byId = new Map(stories.map((s) => [s.storyId, s]));
    const s1 = byId.get("story-1001");
    const s2 = byId.get("story-1002");
    const s3 = byId.get("story-1003");
    expect(s1?.mentions[0]?.visibilityClass).toBe(MentionVisibilityClass.VISIBLE);
    expect(s1?.mentions[0]?.rawVisibilityFlag).toBe(false);
    expect(s1?.location?.name).toBe("Lofoten, Norway");
    expect(s2?.mentions[0]?.visibilityClass).toBe(
      MentionVisibilityClass.POSSIBLY_HIDDEN,
    );
    expect(s2?.durationMs).toBe(12000);
    expect(s2?.music?.title).toBe("Northern Lights");
    expect(s3?.hasLink).toBe(true);
    expect(s3?.poll?.options).toEqual(["Print", "Digital"]);
    expect(s3?.mentions[0]?.visibilityClass).toBe(
      MentionVisibilityClass.OFF_CANVAS,
    );
    expect(s3?.mentions[1]?.visibilityClass).toBe(
      MentionVisibilityClass.METADATA_ONLY,
    );
    expect(s3?.mentions[1]?.meta.confidence).toBe(Confidence.LOW);

            for (const story of stories) {
      expect(story.meta.category).toBe(ObservationCategory.OBSERVED);
      for (const mention of story.mentions) {
        expect(mention.meta.category).toBe(ObservationCategory.OBSERVED);
      }
    }
    // Stories transport the raw fixture file hash + reference.
    expect(result.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawReference).toBe("fixture:v1/stories.json");
  });

  it("paginates followers across fixture pages via cursors", async () => {
    const page1 = await provider.getFollowers(target);
    expect(page1.status).toBe(CapabilityStatus.AVAILABLE);
    expect(page1.data?.entries).toHaveLength(3);
    expect(page1.data?.complete).toBe(false);
    expect(page1.data?.nextCursor).toBe("followers-p2");
    expect(page1.confidence).toBe(Confidence.MEDIUM);

    const cursor = page1.data?.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = await provider.getFollowers(target, { value: cursor! });
    expect(page2.status).toBe(CapabilityStatus.AVAILABLE);
    expect(page2.data?.entries).toHaveLength(2);
    expect(page2.data?.complete).toBe(true);
    expect(page2.confidence).toBe(Confidence.HIGH);

    const usernames = [
      ...(page1.data?.entries ?? []),
      ...(page2.data?.entries ?? []),
    ].map((e) => e.username);
    expect(usernames).toEqual([
      "noah.frames",
      "mira.lens",
      "saga.pixel",
      "elin.moor",
      "theo.north",
    ]);
  });

  it("rejects unknown follow cursors", async () => {
    const result = await provider.getFollowers(target, { value: "bogus" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.INTERNAL);
  });

  it("returns the complete following list", async () => {
    const result = await provider.getFollowing(target);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.entries).toHaveLength(4);
    expect(result.data?.complete).toBe(true);
  });

  it("returns posts and comments with evidence", async () => {
    const posts = await provider.getPublicPosts(target);
    expect(posts.status).toBe(CapabilityStatus.AVAILABLE);
    expect(posts.data).toHaveLength(2);
    const post1 = posts.data?.[0] as NormalizedPost;
    expect(post1.postId).toBe("post-1");

    const comments = await provider.getPublicComments(post1);
    expect(comments.status).toBe(CapabilityStatus.AVAILABLE);
    expect(comments.data).toHaveLength(3);
    expect(comments.data?.[0]?.author.username).toBe("noah.frames");
  });

  it("reports UNAVAILABLE honestly when a post has no comment source", async () => {
    const posts = await provider.getPublicPosts(target);
    const post2 = posts.data?.[1] as NormalizedPost;
    const comments = await provider.getPublicComments(post2);
    expect(comments.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(comments.note).toContain("post-2");
    expect(comments.confidence).toBe(Confidence.UNKNOWN);
  });

  it("transports genuine raw provenance for comments and follow pages", async () => {
    const posts = await provider.getPublicPosts(target);
    const post1 = posts.data?.[0] as NormalizedPost;
    const comments = await provider.getPublicComments(post1);
    expect(comments.status).toBe(CapabilityStatus.AVAILABLE);
    expect(comments.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(comments.rawReference).toBe("fixture:v1/comments/post-1.json");

    const followers = await provider.getFollowers(target);
    expect(followers.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(followers.rawReference).toBe("fixture:v1/followers/page-1.json");
  });

  it("serves the insights fixture with the recorded window and no fabricated absence", async () => {
    const result = await provider.getAccountInsights(target);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const set = result.data;
    expect(set).toBeDefined();
    if (!set) return;

    expect(set.points).toHaveLength(68);
    expect(set.absences).toEqual([]);
    expect(set.windowSince).toBe("2026-07-28T09:15:00.000Z");
    expect(set.windowUntil).toBe("2026-08-27T09:15:00.000Z");
    expect(result.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawReference).toBe("fixture:v1/insights.json");

    // The daily series must agree with the profile it was captured with: a
    // fixture whose series contradicts its own follower count would teach the
    // pipeline a shape the real edge cannot produce.
    const followerCount = set.points.filter((p) => p.metric === "follower_count");
    expect(followerCount.length).toBeGreaterThan(20);
    expect(followerCount[followerCount.length - 1]?.value).toBe(12480);

    const demographics = set.points.filter((p) => p.metric === "follower_demographics");
    expect(demographics).toHaveLength(5);
    expect(demographics.every((p) => p.dimension === "country")).toBe(true);
    expect(demographics.every((p) => p.timeframe === "THIS_MONTH")).toBe(true);
  });

  it("mirrors the documented below-100-followers gate instead of faking the metrics", async () => {
    // D39: the absence branch is exercised by patching the profile the fixture
    // already carries, so the payload stays one shape and the pipeline sees
    // exactly what the platform produces for a small account.
    const dir = mkdtempSync(join(tmpdir(), "igtrack-insights-"));
    cpSync(fixturesDir, dir, { recursive: true });
    const profilePath = join(dir, "profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as {
      profile: { follower_count: number };
    };
    profile.profile.follower_count = 42;
    writeFileSync(profilePath, JSON.stringify(profile));

    const small = new FixtureProvider({ fixturesDir: dir, clock: () => FIXED_NOW });
    const result = await small.getAccountInsights(target);
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const set = result.data;
    expect(set).toBeDefined();
    if (!set) return;

    expect(set.points.some((p) => p.metric === "follower_count")).toBe(false);
    expect(set.points.some((p) => p.metric === "follower_demographics")).toBe(false);
    // The metrics that ARE exposed survive the gate.
    expect(set.points.some((p) => p.metric === "reach")).toBe(true);

    for (const metric of ["follower_count", "follower_demographics"]) {
      const absence = set.absences.find((a) => a.metric === metric);
      expect(absence?.reason).toContain("fewer than 100 followers");
      expect(absence?.reason).toContain("empty data set instead of 0");
    }
  });
});

describe("FixtureProvider provenance honesty", () => {
  it("labels evidence with the directory version it was constructed with", () => {
    const p = new FixtureProvider({ fixturesDir, clock: () => FIXED_NOW });
    expect(p.sourceId).toBe("fixture:v1");
  });

  it("refuses a set whose manifest disagrees with the declared version", async () => {
    const p = new FixtureProvider({ fixturesDir, version: "v2", clock: () => FIXED_NOW });
    const result = await p.resolveAccount("aurora.wilde");
    expect(result.status).toBe(CapabilityStatus.ERROR);
    if (result.status === CapabilityStatus.ERROR) {
      expect(result.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
      expect(result.error?.message).toContain('declares version "v1"');
    }
  });

  it("returns PARTIAL (never complete) when a comments payload declares pages it cannot serve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "igtrack-fixture-"));
    await writeFile(
      join(dir, "comments-post-1.json"),
      JSON.stringify({
        schema_version: "v1",
        captured_at: "2026-08-27T09:15:00.000Z",
        post_id: "post-1",
        comments: [
          {
            id: "c-1",
            user: { username: "commenter" },
            text: "hello",
            created_at: "2026-08-26T10:00:00.000Z",
          },
        ],
        next_cursor: "2",
      }),
      "utf8",
    );
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "v1",
        target_username: "aurora.wilde",
        captured_at: "2026-08-27T09:15:00.000Z",
        files: {
          profile: "unused.json",
          stories: "unused.json",
          followers: [],
          following: [],
          posts: [],
          comments: { "post-1": "comments-post-1.json" },
        },
      }),
      "utf8",
    );
    const p = new FixtureProvider({ fixturesDir: dir, clock: () => FIXED_NOW });
    const result = await p.getPublicComments({
      postId: "post-1",
      takenAt: "2026-08-26T10:00:00.000Z",
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: "2026-08-26T10:00:00.000Z",
      },
    });
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.nextCursor).toBeUndefined();
    expect(result.data).toHaveLength(1);
  });
});

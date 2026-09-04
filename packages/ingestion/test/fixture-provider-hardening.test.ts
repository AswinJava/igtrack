import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
import { FixtureProvider } from "../src/fixture/fixture-provider.js";

const realFixturesDir = fileURLToPath(new URL("../fixtures/v1", import.meta.url));

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "igtrack-fixture-"));
}

describe("FixtureProvider hardening", () => {
  it("returns SOURCE_NOT_FOUND instead of throwing for a missing manifest", async () => {
    const provider = new FixtureProvider({ fixturesDir: emptyDir() });
    const result = await provider.resolveAccount("aurora.wilde");
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SOURCE_NOT_FOUND);
    expect(result.error?.retryable).toBe(false);
  });

  it("returns SCHEMA_MISMATCH for a malformed manifest", async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "v1" }));
    const provider = new FixtureProvider({ fixturesDir: dir });
    const result = await provider.getProfile({ username: "aurora.wilde" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
  });

  it("returns SOURCE_NOT_FOUND for stories when the file is missing", async () => {
    const dir = emptyDir();
    mkdirSync(join(dir, "followers"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "v1",
        target_username: "aurora.wilde",
        captured_at: "2026-08-27T12:00:00.000Z",
        files: {
          profile: "profile.json",
          stories: "stories.json",
          followers: [],
          following: [],
          posts: [],
          comments: {},
        },
      }),
    );
    const provider = new FixtureProvider({ fixturesDir: dir });
    const result = await provider.getStories({ username: "aurora.wilde" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SOURCE_NOT_FOUND);
  });

  it("rejects comment pagination honestly instead of ignoring the cursor", async () => {
    const provider = new FixtureProvider({ fixturesDir: realFixturesDir });
    const posts = await provider.getPublicPosts({ username: "aurora.wilde" });
    expect(posts.status).toBe(CapabilityStatus.AVAILABLE);
    const post1 = posts.data?.[0];
    expect(post1).toBeDefined();
    if (!post1) return;
    const paged = await provider.getPublicComments(post1, { value: "page-2" });
    expect(paged.status).toBe(CapabilityStatus.ERROR);
    expect(paged.error?.kind).toBe(CapabilityErrorKind.INTERNAL);
  });

  it("rejects unknown posts cursors without throwing", async () => {
    const provider = new FixtureProvider({ fixturesDir: realFixturesDir });
    const result = await provider.getPublicPosts({ username: "aurora.wilde" }, { value: "nope.json" });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.INTERNAL);
  });
});

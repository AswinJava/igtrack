import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureProvider } from "@igtrack/ingestion";
import {
  CapabilityErrorKind,
  CapabilityStatus,
} from "@igtrack/core";
import {
  expectCapabilityShape,
  expectProvenanceShape,
  expectRawHashHonest,
} from "../../core/test/conformance-harness.js";

// STEP 14/15: the fixture provider is the canonical conformance reference.
// These checks are the same contract any future lawful provider must pass.
const FIXTURES_DIR = fileURLToPath(
  new URL("../fixtures/v1", import.meta.url),
);

const provider = new FixtureProvider({ fixturesDir: FIXTURES_DIR });

describe("fixture provider conformance", () => {
  it("C1: capability matrix shape", () => {
    expectCapabilityShape(provider);
  });

  it("C2: getProfile carries full provenance and genuine raw hash", async () => {
    const ref = await provider.resolveAccount("aurora.wilde");
    expect(ref.status).toBe(CapabilityStatus.AVAILABLE);
    expectProvenanceShape(ref);
    const profile = await provider.getProfile(ref.data!);
    expect(profile.status).toBe(CapabilityStatus.AVAILABLE);
    expectProvenanceShape(profile);
    // Fixture transports a genuine raw hash of the raw file bytes.
    if (profile.rawPayloadHash !== undefined) {
      expectRawHashHonest(profile.rawPayloadHash);
    }
    expect(profile.data?.account.username).toBe("aurora.wilde");
  });

  it("C4: getFollowers pages and preserves raw representation references", async () => {
    const ref = (await provider.resolveAccount("aurora.wilde")).data!;
    const page1 = await provider.getFollowers(ref);
    expect(page1.status).toBe(CapabilityStatus.AVAILABLE);
    expectProvenanceShape(page1);
    expect(page1.data).toBeDefined();
    expect(page1.data!.entries.length).toBeGreaterThan(0);
    expectRawHashHonest(page1.rawPayloadHash);
    if (page1.data!.nextCursor !== undefined) {
      const page2 = await provider.getFollowers(ref, { value: page1.data!.nextCursor });
      expect(page2.status).toBe(CapabilityStatus.AVAILABLE);
    }
  });

  it("C4: getFollowing honors the same pagination contract", async () => {
    const ref = (await provider.resolveAccount("aurora.wilde")).data!;
    const page = await provider.getFollowing(ref);
    expect(page.status).toBe(CapabilityStatus.AVAILABLE);
    expectProvenanceShape(page);
    expectRawHashHonest(page.rawPayloadHash);
  });

  it("C3: requested-but-missing account → typed ACCOUNT_NOT_FOUND error, never empty data", async () => {
    const result = await provider.resolveAccount("no_such_user");
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(result.error?.retryable).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it("C5: a malformed payload → typed SCHEMA_MISMATCH via the capability model, never a thrown crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "igtrack-conf-bad-"));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "v1",
        target_username: "aurora.wilde",
        captured_at: "2026-08-28T10:00:00.000Z",
        files: { profile: "profile.json", stories: "stories.json", followers: [], following: [], posts: [], comments: {} },
      }),
    );
    await writeFile(join(dir, "profile.json"), "{ broken json");
    await writeFile(join(dir, "stories.json"), "[]");
    const broken = new FixtureProvider({ fixturesDir: dir });
    const result = await broken.getProfile({
      username: "aurora.wilde",
    });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(result.error?.retryable).toBe(false);
    expect(result.data).toBeUndefined();
    // IMPORTANT: never a raw upstream dump — only a normalized message.
    expect(result.error?.message).not.toContain("broken json");
  });
});
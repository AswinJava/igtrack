// ---------------------------------------------------------------------------
// The fixture provider's identity gate.
//
// A fixture set observes exactly ONE account. Before this gate, every
// account-scoped capability except `resolveAccount` served the set's bytes
// for ANY username it was handed — so a scan of a real account (e.g.
// @serpaix.ai) filed the fixture's synthetic follower roster, insight points
// and media under that real account's record. The evidence rows were
// labelled `synthetic: true`, but the ROWS were about a real handle, and
// every follow/unfollow delta and relationship score was derived from them.
//
// These tests pin the refusal at the provider's own boundary, so no caller
// can be the thing that forgets to check.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
import { FixtureProvider } from "../src/fixture/fixture-provider.js";

const realFixturesDir = fileURLToPath(new URL("../fixtures/v1", import.meta.url));
const SUBJECT = "aurora.wilde";
const FOREIGN = "serpaix.ai";

function provider(): FixtureProvider {
  return new FixtureProvider({ fixturesDir: realFixturesDir });
}

/** Every account-scoped capability, called with a foreign account. */
function foreignCalls(p: FixtureProvider): Array<[string, () => Promise<{ status: string; error?: { kind: string; message: string } }>]> {
  const account = { username: FOREIGN };
  return [
    ["getProfile", () => p.getProfile(account)],
    ["getStories", () => p.getStories(account)],
    ["getFollowers", () => p.getFollowers(account)],
    ["getFollowing", () => p.getFollowing(account)],
    ["getPublicPosts", () => p.getPublicPosts(account)],
    ["getTags", () => p.getTags(account)],
    ["getMentionedComment", () => p.getMentionedComment(account, "comment-1")],
    ["getAccountInsights", () => p.getAccountInsights(account)],
  ];
}

describe("FixtureProvider identity gate", () => {
  it("refuses every account-scoped capability for an account the set does not cover", async () => {
    const p = provider();
    for (const [name, call] of foreignCalls(p)) {
      const result = await call();
      expect(result.status, name).toBe(CapabilityStatus.ERROR);
      expect(result.error?.kind, name).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    }
  });

  it("says the refusal is about the DATA SET, never about the account's existence", async () => {
    const p = provider();
    const result = await p.getProfile({ username: FOREIGN });
    expect(result.error?.message).toContain(`only contains @${SUBJECT}`);
    // The sentence a reader must not be able to misread as "the account does
    // not exist": the fixture set not covering a name says nothing about it.
    expect(result.error?.message).toContain("not evidence that");
    expect(result.error?.message).toContain("does not exist");
    expect(result.error?.retryable).toBe(false);
  });

  it("still serves the account the set does cover", async () => {
    const p = provider();
    const profile = await p.getProfile({ username: SUBJECT });
    expect(profile.status).toBe(CapabilityStatus.AVAILABLE);
    const insights = await p.getAccountInsights({ username: SUBJECT });
    expect(insights.status).toBe(CapabilityStatus.AVAILABLE);
  });

  it("matches the cover case-insensitively and with or without the @", async () => {
    const p = provider();
    expect(await p.observesAccount(SUBJECT)).toBe(true);
    expect(await p.observesAccount("@aurora.wilde")).toBe(true);
    expect(await p.observesAccount("AURORA.WILDE")).toBe(true);
    expect(await p.observesAccount(FOREIGN)).toBe(false);
    expect(await p.observesAccount("")).toBe(false);
  });

  it("keeps the discovery probe refusing its own subject", async () => {
    // The probe is a different route (another account's public data); its own
    // subject is still refused, exactly as before.
    const p = provider();
    const result = await p.discoverAccount(SUBJECT);
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
  });

  it("refuses a set whose manifest and profile name DIFFERENT accounts", async () => {
    // A hand-written set could declare one account and carry another's
    // bytes. Serving them together would file one account's data under
    // another's name — the same contamination, reached by configuration.
    // The set is therefore refused, fail-closed.
    const dir = mkdtempSync(join(tmpdir(), "igtrack-fixture-mismatch-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        version: "v1",
        target_username: FOREIGN,
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
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({
        schema_version: "v1",
        captured_at: "2026-08-27T12:00:00.000Z",
        profile: { id: "9000000001", username: SUBJECT, follower_count: 10 },
      }),
    );
    writeFileSync(join(dir, "stories.json"), JSON.stringify({ schema_version: "v1", captured_at: "2026-08-27T12:00:00.000Z", stories: [] }));

    const p = new FixtureProvider({ fixturesDir: dir });
    // Neither name is served: the set does not know what it is about.
    expect(await p.observesAccount(FOREIGN)).toBe(false);
    expect(await p.observesAccount(SUBJECT)).toBe(false);
    const result = await p.getProfile({ username: FOREIGN });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(result.error?.message).toContain("must name one account");
  });
});

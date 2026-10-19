import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CapabilityErrorKind,
  CapabilityStatus,
  Confidence,
  isUsable,
  type NormalizedAccountRef,
} from "@igtrack/core";
import { ImportProvider } from "../src/import/import-provider.js";

const sampleDir = fileURLToPath(new URL("../fixtures/import-sample", import.meta.url));
const OWNER = "sample.owner";
const FIXED_NOW = new Date("2026-10-01T00:00:00.000Z");
const ACCOUNT: NormalizedAccountRef = { username: OWNER };

function providerAt(dir: string): ImportProvider {
  return new ImportProvider({ importDir: dir, username: OWNER, clock: () => FIXED_NOW });
}

/** A temp export dir containing exactly the given files under the roster path. */
async function exportWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "igtrack-import-"));
  const roster = join(dir, "connections", "followers_and_following");
  await mkdir(roster, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(roster, name), content);
  }
  return dir;
}

const sample = providerAt(sampleDir);

describe("ImportProvider (import:v1)", () => {
  it("declares capabilities honestly — rosters only, nothing else", () => {
    expect(sample.capabilities()).toEqual({
      resolveAccount: true,
      getProfile: false,
      getStories: false,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: false,
      getPublicComments: false,
      getPostChildren: false,
      // An export contains no insights edge; the refusal is in the method too.
      getAccountInsights: false,
      // The export describes one account; other-account public data has no
      // route through it (D42) — the method says so with the reason.
      discoverAccount: false,
      // FOUNDING §17: an export carries no tags edge and no mentioned-comment
      // read; both refuse with the reason, never with empty data.
      getTags: false,
      getMentionedComment: false,
    });
  });

  it("observes ONLY the export's owner, case-insensitively", async () => {
    const ok = await sample.resolveAccount("Sample.Owner");
    expect(ok.status).toBe(CapabilityStatus.AVAILABLE);
    expect(ok.data?.username).toBe(OWNER);

    const other = await sample.resolveAccount("mira.codes");
    expect(other.status).toBe(CapabilityStatus.ERROR);
    expect(other.error?.kind).toBe(CapabilityErrorKind.ACCOUNT_NOT_FOUND);
    expect(other.error?.retryable).toBe(false);
  });

  it("pages followers one raw file at a time, complete only on the last, deduped", async () => {
    const p1 = await sample.getFollowers(ACCOUNT);
    expect(p1.status).toBe(CapabilityStatus.AVAILABLE);
    expect(isUsable(p1)).toBe(true);
    // duplicate devon.paints collapses to the first occurrence
    expect(p1.data?.entries.map((e) => e.username)).toEqual([
      "mira.codes",
      "devon.paints",
      "sol.ramos",
    ]);
    expect(p1.data?.complete).toBe(false);
    expect(p1.data?.nextCursor).toBe("followers_2.json");
    expect(p1.confidence).toBe(Confidence.MEDIUM);

    // the raw hash is the genuine sha256 of the actual file bytes
    const bytes = await readFile(
      join(sampleDir, "connections", "followers_and_following", "followers_1.json"),
      "utf8",
    );
    expect(p1.rawPayloadHash).toBe(
      createHash("sha256").update(bytes, "utf8").digest("hex"),
    );
    expect(p1.rawReference).toBe("import:v1/followers_1.json");

    const p2 = await sample.getFollowers(ACCOUNT, { value: "followers_2.json" });
    expect(p2.status).toBe(CapabilityStatus.AVAILABLE);
    expect(p2.data?.entries.map((e) => e.username)).toEqual([
      "kite.studio",
      "noon.archive",
    ]);
    expect(p2.data?.complete).toBe(true);
    expect(p2.data?.nextCursor).toBeUndefined();
    expect(p2.confidence).toBe(Confidence.HIGH);
    expect(p2.rawReference).toBe("import:v1/followers_2.json");

    // a cursor past the last file is a hard error, never a phantom page
    const past = await sample.getFollowers(ACCOUNT, { value: "followers_9.json" });
    expect(past.status).toBe(CapabilityStatus.ERROR);
    expect(past.error?.retryable).toBe(false);
  });

  it("serves the following roster complete in a single page with a freshness note", async () => {
    const f = await sample.getFollowing(ACCOUNT);
    expect(f.status).toBe(CapabilityStatus.AVAILABLE);
    expect(f.data?.complete).toBe(true);
    expect(f.data?.nextCursor).toBeUndefined();
    expect(f.data?.entries.map((e) => e.username)).toEqual([
      "aurora.wilde",
      "noon.archive",
    ]);
    expect(f.confidence).toBe(Confidence.HIGH);
    expect(f.note).toMatch(/record no generation timestamp/);
    expect(f.note).toMatch(/when igtrack read them/);
    expect(f.note).not.toMatch(/freshness equals the export date/);
  });

  it("answers out-of-roster capabilities UNAVAILABLE with the reason — never zero", async () => {
    const profile = await sample.getProfile();
    const stories = await sample.getStories();
    const posts = await sample.getPublicPosts();
    const comments = await sample.getPublicComments();
    const children = await sample.getPostChildren();
    const insights = await sample.getAccountInsights();
    const discovered = await sample.discoverAccount("mira.codes");
    const tags = await sample.getTags();
    const mentioned = await sample.getMentionedComment();
    for (const r of [
      profile,
      stories,
      posts,
      comments,
      children,
      insights,
      discovered,
      tags,
      mentioned,
    ]) {
      expect(r.status).toBe(CapabilityStatus.UNAVAILABLE);
      expect(r.confidence).toBe(Confidence.UNKNOWN);
      expect(r.data).toBeUndefined();
      expect(r.note).toBeTruthy();
    }
    expect(profile.note).toMatch(/no profile snapshot/);
    expect(stories.note).toMatch(/never includes story content/);
    expect(posts.note).toMatch(/not read by this provider version/);
    expect(insights.note).toMatch(/no account insight metrics/i);
    // An export can never describe another account; the refusal names the one
    // lawful route rather than implying the data does not exist (D42).
    expect(discovered.note).toMatch(/Business Discovery/);
    // FOUNDING §17: neither the tags edge nor the mentioned-comment read has
    // an export equivalent; the refusal names the route that does.
    expect(tags.note).toMatch(/tags/);
    expect(mentioned.note).toMatch(/webhook/i);
  });

  it("accepts the roster directory directly as the import dir", async () => {
    const direct = providerAt(
      join(sampleDir, "connections", "followers_and_following"),
    );
    const f = await direct.getFollowing(ACCOUNT);
    expect(f.status).toBe(CapabilityStatus.AVAILABLE);
    expect(f.data?.entries.length).toBe(2);
  });

  it("fails fast on a nonexistent export directory — a config error, not data", () => {
    let message = "";
    try {
      providerAt(join(sampleDir, "does-not-exist"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/export directory not found/);
    expect(message).toMatch(/IGTRACK_IMPORT_DIR/);
    expect(message).not.toMatch(/UNAVAILABLE/);
  });

  it("reports a roster file the export lacks as UNAVAILABLE with the fix", async () => {
    const dir = await exportWith({ "following.json": "[]" });
    const p = await providerAt(dir).getFollowers(ACCOUNT);
    expect(p.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(p.note).toMatch(/Re-download the Instagram export/);
    expect(p.data).toBeUndefined(); // never an empty roster
  });

  it("reports a malformed file as SCHEMA_MISMATCH, never a shrunken roster", async () => {
    const dir = await exportWith({ "following.json": "{not json" });
    const f = await providerAt(dir).getFollowing(ACCOUNT);
    expect(f.status).toBe(CapabilityStatus.ERROR);
    expect(f.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(f.error?.retryable).toBe(false);
    expect(f.data).toBeUndefined();
    // never a raw dump of the broken bytes — only a normalized message
    expect(f.error?.message).not.toContain("{not json");
  });

  it("fails loudly on an entry without a username instead of dropping it", async () => {
    const dir = await exportWith({ "following.json": '[{"title": ""}]' });
    const f = await providerAt(dir).getFollowing(ACCOUNT);
    expect(f.status).toBe(CapabilityStatus.ERROR);
    expect(f.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(f.error?.message).toMatch(/carries no username/);
    expect(f.data).toBeUndefined();
  });
});

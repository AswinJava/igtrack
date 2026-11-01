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
      // route through it — the method says so with the reason.
      discoverAccount: false,
      // an export carries no tags edge and no mentioned-comment
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

  it("pages a sharded following export exactly like a sharded follower export", async () => {
    // Instagram splits BOTH sides of the roster once a list is long:
    // following_1.json, following_2.json … A reader that only accepted a bare
    // following.json told that owner "your export has no following file" while
    // the files sat in the directory in front of it.
    const dir = await exportWith({
      "following_1.json": JSON.stringify([{ string_list_data: [{ value: "edge.one" }] }]),
      "following_2.json": JSON.stringify([{ string_list_data: [{ value: "edge.two" }] }]),
      "followers.json": JSON.stringify([{ string_list_data: [{ value: "fan.one" }] }]),
    });
    const p = providerAt(dir);

    const first = await p.getFollowing(ACCOUNT);
    expect(first.status).toBe(CapabilityStatus.AVAILABLE);
    expect(first.data?.entries.map((e) => e.username)).toEqual(["edge.one"]);
    expect(first.data?.complete).toBe(false);
    expect(first.data?.nextCursor).toBe("following_2.json");

    const second = await p.getFollowing(ACCOUNT, { value: "following_2.json" });
    expect(second.data?.entries.map((e) => e.username)).toEqual(["edge.two"]);
    expect(second.data?.complete).toBe(true);
    expect(second.data?.nextCursor).toBeUndefined();

    // A bare file is still read when it is the only one for its direction.
    const bare = await p.getFollowers(ACCOUNT);
    expect(bare.data?.entries.map((e) => e.username)).toEqual(["fan.one"]);
    expect(bare.data?.complete).toBe(true);
  });

  it("refuses a bare file beside shards for the same direction instead of picking one", async () => {
    // Two Instagram exports unpacked into one folder leave followers.json next
    // to followers_1.json … A reader that silently preferred the shards would
    // report the roster complete on the last shard while the bare file's
    // usernames never entered the snapshot — so the next diff tells the owner
    // they lost followers they still have. The refusal is the honest answer:
    // we cannot know which set of bytes is the current one.
    const dir = await exportWith({
      "followers.json": JSON.stringify([{ string_list_data: [{ value: "old.fan" }] }]),
      "followers_1.json": JSON.stringify([{ string_list_data: [{ value: "new.fan" }] }]),
      "followers_2.json": JSON.stringify([]),
      "following.json": JSON.stringify([{ string_list_data: [{ value: "edge.one" }] }]),
    });
    const p = providerAt(dir);

    const r = await p.getFollowers(ACCOUNT);
    expect(r.status).toBe(CapabilityStatus.ERROR);
    expect(r.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(r.error?.retryable).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.error?.message).toMatch(/cannot be ordered/);
    expect(r.error?.message).toMatch(/followers\.json/);
    expect(r.error?.message).toMatch(/followers_1\.json, followers_2\.json/);
    expect(r.error?.message).toMatch(/Keep exactly one/);
    // no payload bytes in the refusal — the usernames are not echoed
    expect(r.error?.message).not.toContain("old.fan");

    // the direction with one unambiguous file set still reads normally
    const f = await p.getFollowing(ACCOUNT);
    expect(f.status).toBe(CapabilityStatus.AVAILABLE);
    expect(f.data?.complete).toBe(true);
  });

  it("refuses a shard run with a gap rather than calling the roster complete", async () => {
    // An interrupted or hand-pruned download leaves followers_1 and _3 with no
    // _2. Instagram numbers shards as a run from 1, so a gap means a whole page
    // of usernames is missing; reading the two survivors and reporting
    // `complete: true` turns the missing page into fabricated absence.
    const dir = await exportWith({
      "followers_1.json": JSON.stringify([{ string_list_data: [{ value: "a.one" }] }]),
      "followers_3.json": JSON.stringify([{ string_list_data: [{ value: "a.three" }] }]),
    });
    const r = await providerAt(dir).getFollowers(ACCOUNT);
    expect(r.status).toBe(CapabilityStatus.ERROR);
    expect(r.error?.kind).toBe(CapabilityErrorKind.SCHEMA_MISMATCH);
    expect(r.error?.message).toMatch(/followers_2\.json is absent/);
    expect(r.data).toBeUndefined();

    // a shard run missing only its first file is the same defect
    const shifted = await exportWith({
      "followers_2.json": JSON.stringify([{ string_list_data: [{ value: "a.two" }] }]),
      "followers_3.json": JSON.stringify([{ string_list_data: [{ value: "a.three" }] }]),
    });
    const s = await providerAt(shifted).getFollowers(ACCOUNT);
    expect(s.status).toBe(CapabilityStatus.ERROR);
    expect(s.error?.message).toMatch(/followers_1\.json is absent/);
  });

  it("reads a ten-plus shard export in numeric, not lexical, order", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 11; i++) {
      files[`followers_${i}.json`] = JSON.stringify([
        { string_list_data: [{ value: `fan.${i}` }] },
      ]);
    }
    const p = providerAt(await exportWith(files));

    let cursor: { value: string } | undefined;
    const pages: Array<{ readonly file: string; readonly username: string }> = [];
    for (let guard = 0; guard < 20; guard++) {
      const page = await p.getFollowers(ACCOUNT, cursor);
      expect(page.status).toBe(CapabilityStatus.AVAILABLE);
      pages.push({
        file: page.rawReference ?? "",
        username: page.data?.entries[0]?.username ?? "",
      });
      const next = page.data?.nextCursor;
      if (next === undefined) {
        expect(page.data?.complete).toBe(true);
        break;
      }
      expect(page.data?.complete).toBe(false);
      cursor = { value: next };
    }
    expect(pages.map((x) => x.file)).toEqual(
      Array.from({ length: 11 }, (_, i) => `import:v1/followers_${i + 1}.json`),
    );
    expect(pages.map((x) => x.username)).toEqual(
      Array.from({ length: 11 }, (_, i) => `fan.${i + 1}`),
    );
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
    // lawful route rather than implying the data does not exist.
    expect(discovered.note).toMatch(/Business Discovery/);
    // neither the tags edge nor the mentioned-comment read has
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

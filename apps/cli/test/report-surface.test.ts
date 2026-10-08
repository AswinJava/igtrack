import postgres from "postgres";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  createTarget,
  recordProfileSnapshot,
  runMigrations,
  seed,
  type DatabaseHandle,
} from "@igtrack/database";
import { Confidence, ObservationCategory, SourceKind, type PeriodReport } from "@igtrack/core";
import { opAsk } from "../src/ask/execute.js";
import { planAsk } from "../src/ask/parse.js";
import { createContext, type CliContext } from "../src/context.js";
import { CliError, UsageError } from "../src/output.js";
import {
  opAlerts,
  opAudience,
  opDigest,
  opExport,
  opRecent,
  opReport,
  opReports,
  opScanRun,
  opTargetAdd,
  opTargetList,
  opWork,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// Integration test for the periodic-report surfaces (report / reports /
// audience / export / digest) against real stored rows.
//
// The fixture set replays a synthetic August 2026 timeline: profile
// observations and follow snapshots on 20–22 Aug, a post on 20 Aug, another
// post and comments on 25 Aug, stories on 26–27 Aug, and the profile capture
// on 27 Aug. The scans themselves run now (October), so the two window classes
// diverge exactly the way an operator would see after importing backdated
// history — and neither is ever allowed to turn silence into a zero.
//
// Requires the Docker Compose test database; skipped (not passed vacuously)
// when it is unavailable.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde";
const SEEDED_USERNAME = "target_a"; // seed() gives this target the backdated August history
const UNSCANNED_USERNAME = "quiet.account"; // valid handle, deliberately never scanned
const AUGUST_AT = "2026-08-26"; // Wednesday of ISO week 2026-W35
const UTC_DAY_MS = 86_400_000;

async function probe(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

const databaseUp = await probe(TEST_DATABASE_URL);

function section(report: PeriodReport, id: string): PeriodReport["sections"][number] {
  const found = report.sections.find((s) => s.id === id);
  if (found === undefined) throw new Error(`report has no section "${id}"`);
  return found;
}

function fact(
  report: PeriodReport,
  sectionId: string,
  label: string,
): PeriodReport["sections"][number]["facts"][number] {
  const found = section(report, sectionId).facts.find((f) => f.label === label);
  if (found === undefined) throw new Error(`section "${sectionId}" has no fact "${label}"`);
  return found;
}

describe.skipIf(!databaseUp)("periodic report surfaces", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;

    ctx = await createContext();
    await opTargetAdd(ctx, { username: FIXTURE_USERNAME, localName: "Fixture account" });
    await opTargetAdd(ctx, { username: UNSCANNED_USERNAME });

    const scan = await opScanRun(ctx, { target: FIXTURE_USERNAME, force: true });
    expect(scan.enqueued).toHaveLength(7);
    const work = await opWork(ctx, { max: 40, skipScheduler: true });
    const states = work.outcomes.map((o) => o.state);
    expect(states).not.toContain("failed");
    expect(states).not.toContain("lost");
    expect(states).not.toContain("unrecorded");
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("reports the week containing now without turning an empty window into a zero", async () => {
    const result = await opReport(ctx, { target: FIXTURE_USERNAME, period: "weekly" });
    const report = result.report;

    expect(result.period).toBe("weekly");
    expect(report.window.label).toMatch(/^\d{4}-W\d{2}$/);
    expect(new Date(report.window.start).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(report.window.end).getTime()).toBeGreaterThan(Date.now());

    // The fixture timeline ends on 27 August; this week has no profile
    // observation of its own, so the section is EMPTY with the reason, while
    // the last observed counts remain visible as the baseline endpoint.
    const profile = section(report, "profile");
    expect(profile.state).toBe("EMPTY");
    expect(profile.reason).toContain("observed before this window but not inside it");
    expect(fact(report, "profile", "Follower count at window start").value).toBe(12480);
    expect(fact(report, "profile", "Follower count at latest observation").value).toBeNull();
    expect(fact(report, "profile", "Follower count change").value).toBeNull();

    // The fixture published its media in August: this window has no row with a
    // publish time inside it, which is EMPTY with a reason, never "0 posts".
    const content = section(report, "content");
    expect(content.state).toBe("EMPTY");
    expect(content.reason).toContain("nothing was published in this window");

    // Both rosters were scanned at observation time (this week); one COMPLETE
    // snapshot per side cannot produce a movement, and the section says so.
    const audience = section(report, "audience");
    expect(audience.state).toBe("EMPTY");
    expect(audience.summary).toContain("Roster snapshots exist for this window");
    expect(audience.reason).toContain("Zero recorded deltas");

    expect(report.evidence.synthetic).toBe(true);
    expect(report.evidence.evidenceClass).toBe("SYNTHETIC");
    expect(report.evidence.sourceIds).toEqual(["fixture:v1"]);
    expect(result.markdown).toContain(report.window.label);
    expect(result.markdown).toContain("SYNTHETIC");
  });

  it("answers a historical window by publish time, including mentions of its stories", async () => {
    const result = await opReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "weekly",
      at: AUGUST_AT,
    });
    const report = result.report;

    expect(report.window.start).toBe("2026-08-24T00:00:00.000Z");
    expect(report.window.end).toBe("2026-08-31T00:00:00.000Z");
    expect(report.window.label).toBe("2026-W35");

    // The 25 August post is the only one inside the window; a cadence needs two
    // distinct publish times and says so instead of inventing a gap.
    const content = section(report, "content");
    expect(content.state).toBe("DERIVED");
    expect(fact(report, "content", "Posts observed").value).toBe(1);
    expect(fact(report, "content", "Median gap between posts").value).toBeNull();

    expect(section(report, "engagement").state).toBe("DERIVED");
    expect(fact(report, "engagement", "Posts with a returned like count").value).toBe(1);
    expect(fact(report, "engagement", "Likes summed over returned counts").value).toBe(842);

    const stories = section(report, "stories");
    expect(stories.state).toBe("OBSERVED");
    expect(fact(report, "stories", "Stories observed").value).toBe(3);
    const mentioned = fact(report, "stories", "Accounts mentioned in stories").value;
    expect(typeof mentioned).toBe("string");
    expect(mentioned as string).toContain("@noah.frames");

    // A mention belongs to its story's window: the three stories above carry
    // four mention rows, so they appear in this same report rather than in the
    // October window that actually ran the scan.
    const mentions = section(report, "mentions");
    expect(mentions.state).toBe("OBSERVED");
    expect(fact(report, "mentions", "Mention rows observed").value).toBe(4);

    expect(section(report, "comments").state).toBe("OBSERVED");
    expect(fact(report, "comments", "Comments observed").value).toBe(3);

    // The 27 August profile capture is inside the window. This target has no
    // observation before the week, so the baseline stays null instead of being
    // borrowed from another account's history.
    const profile = section(report, "profile");
    expect(profile.state).toBe("OBSERVED");
    expect(fact(report, "profile", "Follower count at window start").value).toBeNull();
    expect(fact(report, "profile", "Follower count at window start").note).toContain(
      "No snapshot at or before the window start",
    );
    expect(fact(report, "profile", "Follower count at latest observation").value).toBe(12480);
    expect(fact(report, "profile", "Follower count change").value).toBeNull();

    // Roster snapshots exist only in the previous week, so this week's silence
    // is an observation gap and is worded as one.
    const audience = section(report, "audience");
    expect(audience.state).toBe("EMPTY");
    expect(audience.reason).toContain("No COMPLETE roster snapshot was taken inside this window");
    expect(report.gaps.some((g) => g.section === "Audience" && g.reason.includes("observation gap"))).toBe(
      true,
    );

    expect(result.markdown).toContain("2026-W35");
  });

  it("says no profile baseline exists for a window before the ledger, instead of claiming one", async () => {
    const result = await opReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "weekly",
      at: "2026-01-15",
    });
    expect(result.report.window.label).toBe("2026-W03");

    const profile = section(result.report, "profile");
    expect(profile.state).toBe("EMPTY");
    expect(profile.reason).toContain("No profile snapshot exists at or before this window");
    expect(profile.reason).not.toContain("observed before this window");

    // Coverage still states when the ledger begins, so a pre-ledger report
    // explains why it is empty rather than implying a quiet account.
    const coverage = section(result.report, "coverage");
    expect(fact(result.report, "coverage", "Ledger begins").value).toBe("20 Aug 2026 09:30 UTC");
    expect(section(result.report, "content").state).toBe("EMPTY");
    expect(section(result.report, "audience").reason).toContain(
      "No COMPLETE roster snapshot was taken inside this window",
    );
  });

  it("compares a stored baseline only when one exists before the window", async () => {
    const result = await opReport(ctx, {
      target: SEEDED_USERNAME,
      period: "weekly",
      at: AUGUST_AT,
    });
    expect(result.report.window.label).toBe("2026-W35");

    // target_a's last August snapshot (22 Aug, 431 followers) predates the
    // week, and no observation falls inside it: the baseline is the endpoint,
    // the latest observation is null, and no change is invented.
    const profile = section(result.report, "profile");
    expect(profile.state).toBe("EMPTY");
    expect(profile.reason).toContain("observed before this window but not inside it");
    expect(fact(result.report, "profile", "Follower count at window start").value).toBe(431);
    expect(fact(result.report, "profile", "Follower count at latest observation").value).toBeNull();
    expect(fact(result.report, "profile", "Follower count change").value).toBeNull();
  });

  it("derives follow movement only in the window where deltas exist", async () => {
    const result = await opReport(ctx, {
      target: SEEDED_USERNAME,
      period: "weekly",
      at: "2026-08-20",
    });
    expect(result.report.window.label).toBe("2026-W34");

    // The seeded history records one FOLLOWING addition and one removal on
    // 22 Aug. Followers were never snapshotted in that window, so their
    // movement is zero recorded events, not an unchanged audience.
    const audience = section(result.report, "audience");
    expect(audience.state).toBe("DERIVED");
    expect(audience.summary).toContain("1 new and 1 lost following");
    expect(fact(result.report, "audience", "New following").value).toBe(1);
    expect(fact(result.report, "audience", "New following").note).toContain("@person_gamma");
    expect(fact(result.report, "audience", "Lost following").note).toContain("@person_beta");
    expect(fact(result.report, "audience", "New followers").value).toBe(0);
    expect(fact(result.report, "audience", "Follower snapshots in window").value).toBe(0);
    expect(fact(result.report, "audience", "Following snapshots in window").value).toBe(2);

    // The relationship ranking is scoped to the window's own signals: the two
    // follow deltas above rank at the delta weight, in the synthetic class.
    const relationships = section(result.report, "relationships");
    expect(relationships.state).toBe("DERIVED");
    expect(relationships.summary).toContain("inside this window");
    const gamma = fact(result.report, "relationships", "@person_gamma");
    expect(gamma.value).toBe(8);
    expect(gamma.note).toContain("SYNTHETIC");
    // person_beta also authored a stored comment inside the week, so its score
    // carries both signals rather than the delta alone.
    const beta = fact(result.report, "relationships", "@person_beta");
    expect(beta.value).toBeGreaterThanOrEqual(8);
    expect(beta.note).toContain("delta(s)");
  });

  it("indexes windows back to the oldest stored row and labels coverage per window", async () => {
    const weeks =
      Math.ceil((Date.now() - Date.parse("2026-08-20T00:00:00.000Z")) / (7 * UTC_DAY_MS)) + 2;
    const index = await opReports(ctx, {
      target: FIXTURE_USERNAME,
      period: "weekly",
      limit: weeks,
    });

    // The index names the class of evidence behind its counts instead of
    // borrowing the configured provider.
    expect(index.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });

    // The ledger begins at the oldest PUBLISH time (the 20 August post), not at
    // the October scan that first read it — otherwise the August windows the
    // report can answer would never be offered.
    expect(index.ledgerStartsAt).toBe("2026-08-20T09:30:00.000Z");
    expect(index.period).toBe("weekly");
    expect(index.windows.length).toBeGreaterThanOrEqual(10);

    // Windows are enumerated newest first.
    expect(index.windows[0]?.state).toBe("IN_PROGRESS");
    const oldest = index.windows[index.windows.length - 1];
    expect(oldest?.window.start).toBe("2026-08-17T00:00:00.000Z");
    expect(oldest?.state).toBe("COVERED");

    const august = index.windows.find((w) => w.window.start === "2026-08-24T00:00:00.000Z");
    expect(august?.window.label).toBe("2026-W35");
    expect(august?.state).toBe("COVERED");
    expect(august?.eventCount).toBeGreaterThanOrEqual(10);
    expect(august?.command).toBe(
      "igtrack report @aurora.wilde --period weekly --at 2026-08-24T00:00:00.000Z",
    );

    // A September window has no stored rows at all. It is EMPTY with a zero
    // event count, and the index note says what that does and does not mean.
    const september = index.windows.find((w) => w.window.start === "2026-09-07T00:00:00.000Z");
    expect(september?.state).toBe("EMPTY");
    expect(september?.eventCount).toBe(0);
    expect(index.note).toContain("COVERED when stored rows fall inside it");
  });

  it("computes audience sets only over COMPLETE rosters", async () => {
    const audience = await opAudience(ctx, { target: FIXTURE_USERNAME });
    expect(audience.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });

    expect(audience.snapshots.followers.complete).toBe(true);
    expect(audience.snapshots.following.complete).toBe(true);
    expect(audience.snapshots.followers.usernames).toHaveLength(5);
    expect(audience.snapshots.following.usernames).toHaveLength(4);

    expect(audience.sets.complete).toBe(true);
    expect(audience.sets.followerCount).toBe(5);
    expect(audience.sets.followingCount).toBe(4);
    expect(audience.sets.mutualCount).toBe(3);
    expect(audience.sets.mutuals).toEqual(["mira.lens", "noah.frames", "theo.north"]);
    expect(audience.sets.notFollowingBack).toEqual(["elin.moor", "saga.pixel"]);
    expect(audience.sets.notFollowedBack).toEqual(["fjord.atlas"]);

    // The only deltas on record are from the backdated August history; the
    // default 30-day window contains none, and that is an empty list, not a
    // claim that the audience stood still.
    expect(audience.recent?.newFollowers).toEqual([]);
    expect(audience.recent?.lostFollowers).toEqual([]);
    expect(audience.recent?.newFollowing).toEqual([]);
    expect(audience.recent?.lostFollowing).toEqual([]);
    // No stored delta in the window formed a mutual. This is computed over two
    // COMPLETE rosters, so it is an empty list, not "cannot tell".
    expect(audience.recent?.newMutuals).toEqual([]);
    expect(audience.notes.join(" ")).toContain("A mutual formed before the ledger began cannot be dated");
    expect(audience.truncated).toBe(false);
  });

  it("refuses one-sided set algebra instead of calling everyone a non-follower", async () => {
    const audience = await opAudience(ctx, { target: SEEDED_USERNAME });

    // The seed records two COMPLETE following rosters but has never read a
    // follower roster. Subtracting the absent side would label every followed
    // account "does not follow back", so the whole answer is refused.
    expect(audience.snapshots.following.complete).toBe(true);
    expect(audience.snapshots.following.usernames.length).toBeGreaterThan(0);
    expect(audience.snapshots.followers.complete).toBe(false);
    expect(audience.sets.complete).toBe(false);
    expect(audience.sets.followingCount).toBe(audience.snapshots.following.usernames.length);
    expect(audience.sets.followerCount).toBeNull();
    expect(audience.sets.mutualCount).toBeNull();
    expect(audience.sets.mutuals).toEqual([]);
    expect(audience.sets.notFollowingBack).toEqual([]);
    expect(audience.sets.notFollowedBack).toEqual([]);
    expect(audience.sets.notes.join(" ")).toContain("absent roster is not an empty audience");
    // With one roster side absent, "newly formed mutual" cannot be computed:
    // the answer is null, never an empty list that would read as "none".
    expect(audience.recent?.newMutuals).toBeNull();

    // Exporting an uncomputed set would produce a header-only file that reads
    // as "empty audience", so the export refuses with the missing roster named.
    await expect(opExport(ctx, { target: SEEDED_USERNAME, kind: "audience" })).rejects.toThrow(
      /cannot be exported.*COMPLETE follower and following snapshot pair/,
    );
  });

  it("exports stored rows but refuses a roster that was never observed", async () => {
    const posts = await opExport(ctx, { target: FIXTURE_USERNAME, kind: "posts" });
    expect(posts.rowCount).toBe(2);
    expect(posts.content.split("\n")[0]).toBe(
      "post_id,taken_at,media_type,caption,like_count,comment_count,evidence_id,evidence_observed_at,source_id,synthetic",
    );
    expect(posts.content).toContain("Fjord light study I");
    expect(posts.content).toContain("842");
    // Provenance: the fixture source is named on every row and labelled synthetic.
    expect(posts.content).toContain("fixture:v1");
    expect(posts.content.split("\n")[1]?.endsWith(",true")).toBe(true);
    expect(posts.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });

    // Comment exports carry the stored text (the viewer's core content) and
    // the search filter narrows by text or author, stating its denominator so
    // an empty result is not mistaken for a source that returned nothing.
    const comments = await opExport(ctx, { target: FIXTURE_USERNAME, kind: "comments" });
    expect(comments.rowCount).toBe(3);
    expect(comments.content.split("\n")[0]).toBe(
      "comment_id,commented_at,author_username,post_db_id,body,evidence_id,evidence_observed_at,source_id,synthetic",
    );
    expect(comments.content).toContain("Unreal light. Teach me.");

    const searched = await opExport(ctx, {
      target: FIXTURE_USERNAME,
      kind: "comments",
      search: "the one",
    });
    expect(searched.rowCount).toBe(1);
    expect(searched.content).toContain("This is the one.");
    expect(searched.content).not.toContain("Unreal light");
    expect(searched.note).toContain("matched 1 of 3");

    const byAuthor = await opExport(ctx, {
      target: FIXTURE_USERNAME,
      kind: "comments",
      search: "NOAH",
    });
    expect(byAuthor.rowCount).toBe(2);

    const noMatch = await opExport(ctx, {
      target: FIXTURE_USERNAME,
      kind: "comments",
      search: "zzz-no-match",
    });
    expect(noMatch.rowCount).toBe(0);
    expect(noMatch.note).toContain("matched 0 of 3");

    const followers = await opExport(ctx, { target: FIXTURE_USERNAME, kind: "followers" });
    expect(followers.rowCount).toBe(5);
    expect(followers.content).toContain("noah.frames");
    expect(followers.note).toContain("latest COMPLETE");

    // The audience export is a derived set, so each row names BOTH snapshot
    // evidence ids; the source cells appear only because both sides resolve
    // to the same fixture source.
    const audience = await opExport(ctx, { target: FIXTURE_USERNAME, kind: "audience" });
    expect(audience.content.split("\n")[0]).toBe(
      "category,username,followers_snapshot_evidence_id,following_snapshot_evidence_id,source_id,synthetic",
    );
    const elinRow = audience.content.split("\n").find((line) => line.includes("elin.moor"));
    expect(elinRow).toBeDefined();
    expect(elinRow?.split(",")[2]).not.toBe("");
    expect(elinRow?.split(",")[3]).not.toBe("");
    expect(elinRow?.endsWith(",fixture:v1,true")).toBe(true);

    const reportJson = await opExport(ctx, {
      target: FIXTURE_USERNAME,
      kind: "report",
      format: "json",
      period: "weekly",
      at: AUGUST_AT,
    });
    const parsed = JSON.parse(reportJson.content) as PeriodReport;
    expect(parsed.window.label).toBe("2026-W35");
    expect(reportJson.rowCount).toBeGreaterThan(5);
    expect(reportJson.note).toContain("stored rows only");

    // A valid handle with no stored roster is refused with an explanation; it
    // is never exported as an empty (or partial) roster.
    try {
      await opExport(ctx, { target: UNSCANNED_USERNAME, kind: "followers" });
      expect.unreachable("a never-observed roster must not export");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain("No COMPLETE followers snapshot exists");
      expect((err as Error).message).toContain("never exported as a roster");
    }

    await expect(
      opExport(ctx, { target: FIXTURE_USERNAME, kind: "nonsense" }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      opExport(ctx, { target: FIXTURE_USERNAME, kind: "posts", format: "xml" }),
    ).rejects.toThrow(/csv or json/);
  });

  it("digests one target with attribution, and the whole ledger without inventing targets", async () => {
    const digest = await opDigest(ctx, {
      target: FIXTURE_USERNAME,
      since: "2026-08-01",
      limit: 200,
    });
    expect(digest.scope).toBe("@aurora.wilde");
    expect(digest.total).toBeGreaterThan(10);
    expect(digest.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });
    expect(digest.items.every((item) => item.target === "@aurora.wilde")).toBe(true);
    expect(digest.counts.POST_PUBLISHED).toBe(2);
    expect(digest.counts.STORY_POSTED).toBe(3);
    expect(digest.counts.COMMENT_POSTED).toBe(3);
    expect(digest.counts.MENTION_OBSERVED).toBe(4);
    expect(digest.counts.TAG_OBSERVED).toBe(2);
    expect(digest.named.newFollowers).toEqual([]);

    const times = digest.items.map((item) => item.timestamp.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(digest.note).toContain("A period with no scans records nothing");

    // The global digest spans every tracked target (including the seeded demo
    // one) and only claims a target for event types it can attribute; a
    // non-null target must be a tracked account, never an invented one.
    const tracked = new Set((await opTargetList(ctx)).map((t) => `@${t.username}`));
    const global = await opDigest(ctx, { since: "2026-08-01", limit: 200 });
    expect(global.scope).toBe("all tracked targets");
    expect(global.total).toBeGreaterThan(0);
    expect(global.items.some((item) => item.target === null)).toBe(true);
    for (const item of global.items) {
      if (item.target !== null) expect(tracked.has(item.target)).toBe(true);
    }
  });

  it("shapes digest events as alerts and writes an idempotent local outbox", async () => {
    const noOutbox = await opAlerts(ctx, {
      target: FIXTURE_USERNAME,
      since: "2026-08-01",
      limit: 200,
    });
    expect(noOutbox.outbox).toBeNull();
    expect(noOutbox.count).toBeGreaterThan(10);
    expect(noOutbox.alerts.every((alert) => alert.id.startsWith("alert:"))).toBe(true);
    expect(noOutbox.alerts.every((alert) => alert.target === "@aurora.wilde")).toBe(true);
    expect(noOutbox.note).toContain("No email, SMS, webhook or daemon");
    expect(noOutbox.types).toBeNull();
    expect(noOutbox.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });

    const onlyProfile = await opAlerts(ctx, {
      target: FIXTURE_USERNAME,
      since: "2026-08-01",
      limit: 200,
      types: ["profile_changed"],
    });
    expect(onlyProfile.types).toEqual(["PROFILE_CHANGED"]);
    expect(onlyProfile.alerts.every((alert) => alert.type === "PROFILE_CHANGED")).toBe(true);
    expect(onlyProfile.count).toBeLessThanOrEqual(noOutbox.count);
    expect(onlyProfile.digestTotal).toBe(noOutbox.digestTotal);
    expect(onlyProfile.note).toContain("Only the requested event types are delivered");

    const digest = await opDigest(ctx, { target: FIXTURE_USERNAME, since: "2026-08-01", limit: 200 });
    expect(noOutbox.count).toBe(Math.min(digest.items.length, 200));

    const dir = mkdtempSync(join(tmpdir(), "igtrack-alerts-"));
    try {
      const first = await opAlerts(ctx, {
        target: FIXTURE_USERNAME,
        since: "2026-08-01",
        limit: 200,
        out: dir,
      });
      expect(first.outbox).toEqual({ dir, written: first.count, existing: 0 });
      const files = readdirSync(dir).sort();
      expect(files).toHaveLength(first.count);
      expect(files.every((name) => /^alert-[a-z_]+-[0-9a-f]{16}\.json$/.test(name))).toBe(true);

      const sample = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")) as {
        id: string;
        type: string;
        evidenceId: string | null;
        observedAt: string;
      };
      expect(sample.id.startsWith("alert:")).toBe(true);
      expect(Number.isNaN(Date.parse(sample.observedAt))).toBe(false);

      // Re-running over the same stored rows rewrites the same files rather
      // than duplicating deliveries: an outbox consumer can poll safely.
      const before = files.map((name) => readFileSync(join(dir, name), "utf8"));
      const second = await opAlerts(ctx, {
        target: FIXTURE_USERNAME,
        since: "2026-08-01",
        limit: 200,
        out: dir,
      });
      expect(second.outbox).toEqual({ dir, written: 0, existing: second.count });
      expect(readdirSync(dir).sort()).toEqual(files);
      expect(files.map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers an unscanned target with an explicit absence, not an empty report", async () => {
    const report = await opReport(ctx, { target: UNSCANNED_USERNAME, period: "weekly" });
    expect(report.report.ledger.earliestAt).toBeNull();
    expect(section(report.report, "profile").state).toBe("EMPTY");
    expect(section(report.report, "profile").reason).toContain("No profile snapshot exists");
    // No stored row means no source to attribute: the report says NONE rather
    // than borrowing the configured provider's label.
    expect(report.report.evidence.evidenceClass).toBe("NONE");
    expect(report.report.evidence.sourceIds).toEqual([]);
    expect(report.markdown).toContain("Evidence class: **NONE**");

    const audience = await opAudience(ctx, { target: UNSCANNED_USERNAME });
    expect(audience.snapshots.followers.complete).toBe(false);
    expect(audience.sets.complete).toBe(false);
    expect(audience.sets.followerCount).toBeNull();
    expect(audience.sets.followingCount).toBeNull();
    expect(audience.sets.mutualCount).toBeNull();
    expect(audience.sets.mutuals).toEqual([]);
    expect(audience.sets.notFollowingBack).toEqual([]);
    expect(audience.sets.notFollowedBack).toEqual([]);
    expect(audience.notes.join(" ")).toContain("No COMPLETE follower snapshot is on record");

    const index = await opReports(ctx, { target: UNSCANNED_USERNAME, period: "weekly", limit: 4 });
    expect(index.ledgerStartsAt).toBeNull();
    expect(index.evidence).toEqual({ sourceIds: [], evidenceClass: "NONE" });
    expect(index.note).toContain("No stored rows exist for this target");
    expect(index.windows.every((w) => w.eventCount === 0)).toBe(true);
  });

  it("refuses an unknown target with a typed error on every new surface", async () => {
    const calls = [
      () => opReport(ctx, { target: "not.tracked.anywhere", period: "weekly" }),
      () => opReports(ctx, { target: "not.tracked.anywhere" }),
      () => opAudience(ctx, { target: "not.tracked.anywhere" }),
      () => opExport(ctx, { target: "not.tracked.anywhere", kind: "posts" }),
      () => opDigest(ctx, { target: "not.tracked.anywhere" }),
      () => opAlerts(ctx, { target: "not.tracked.anywhere" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(CliError);
      await expect(call()).rejects.toThrow(/No tracked target matches/);
    }
  });

  it("answers recent follow activity from stored deltas, with first-seen times and honest absences", async () => {
    const recent = await opRecent(ctx, { target: SEEDED_USERNAME });
    expect(recent.state).toBe("OBSERVED");
    expect(recent.direction).toBe("following");
    // Default window starts at the first COMPLETE snapshot: everything the
    // ledger has seen since tracking began.
    expect(recent.since.toISOString()).toBe("2026-08-21T18:00:00.000Z");
    expect(recent.counts).toEqual({
      newFollowing: 1,
      lostFollowing: 1,
      newFollowers: null,
      lostFollowers: null,
      total: 2,
    });
    // Both edges were first seen at the same diff, so the tie breaks by
    // username, deterministically.
    expect(recent.rows.map((row) => `${row.change}:${row.username}`)).toEqual([
      "LOST_FOLLOWING:person_beta",
      "NEW_FOLLOWING:person_gamma",
    ]);
    for (const row of recent.rows) {
      expect(row.firstSeenAt).toBe("2026-08-22T18:00:00.000Z");
      expect(row.sourceId).toBe("fixture:v1");
      // Per-row classes are the core evidence classes; the aggregate
      // `evidence.evidenceClass` is the report-level SYNTHETIC rollup.
      expect(row.evidenceClass).toBe("SYNTHETIC_FIXTURE");
      expect(row.evidenceId).not.toBeNull();
    }
    // The latest COMPLETE following roster decides presentNow; the follower
    // side was never observed, so mutualNow is null — not false.
    expect(recent.rows.find((row) => row.username === "person_gamma")?.presentNow).toBe(true);
    expect(recent.rows.find((row) => row.username === "person_beta")?.presentNow).toBe(false);
    expect(recent.rows.every((row) => row.mutualNow === null)).toBe(true);
    expect(recent.baseline.following.baselineAt).toBe("2026-08-21T18:00:00.000Z");
    expect(recent.baseline.followers.baselineAt).toBeNull();
    expect(recent.evidence).toEqual({ sourceIds: ["fixture:v1"], evidenceClass: "SYNTHETIC" });
    expect(recent.notes.join(" ")).toContain("not the Instagram follow time");

    // A window after the deltas is a computed empty answer, not a missing one.
    const empty = await opRecent(ctx, { target: SEEDED_USERNAME, since: "2026-08-23" });
    expect(empty.state).toBe("EMPTY");
    expect(empty.rows).toEqual([]);
    expect(empty.counts.total).toBe(0);
    expect(empty.notes.join(" ")).toContain("computed empty answer");

    // The follower side has no COMPLETE roster in the seed: unavailable, with
    // null counts instead of zeros.
    const followers = await opRecent(ctx, { target: SEEDED_USERNAME, direction: "followers" });
    expect(followers.state).toBe("UNAVAILABLE");
    expect(followers.counts).toEqual({
      newFollowing: null,
      lostFollowing: null,
      newFollowers: null,
      lostFollowers: null,
      total: null,
    });
    expect(followers.notes.join(" ")).toContain("No COMPLETE follower snapshot is on record");

    // When both sides are asked for but only the following side has a
    // baseline, the follower counts are null — the ledger never observed
    // them, so a zero would be a claim it cannot support.
    const both = await opRecent(ctx, { target: SEEDED_USERNAME, direction: "both" });
    expect(both.state).toBe("OBSERVED");
    expect(both.counts.newFollowers).toBeNull();
    expect(both.counts.lostFollowers).toBeNull();
    expect(both.counts.newFollowing).toBe(1);

    // The scanned fixture target has both rosters but a single baseline, so the
    // correct answer is EMPTY with a recorded baseline, not UNAVAILABLE.
    const fixture = await opRecent(ctx, { target: FIXTURE_USERNAME, direction: "both" });
    expect(fixture.state).toBe("EMPTY");
    expect(fixture.rows).toEqual([]);
    expect(fixture.baseline.followers.baselineAt).not.toBeNull();
    expect(fixture.baseline.following.baselineAt).not.toBeNull();
    expect(fixture.baseline.following.size).toBeGreaterThan(0);

    await expect(opRecent(ctx, { target: SEEDED_USERNAME, direction: "sideways" })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(opRecent(ctx, { target: "not.tracked.anywhere" })).rejects.toBeInstanceOf(CliError);
  });

  it("routes a recent-follows question to the recent surface, not the full investigation", async () => {
    const plan = planAsk("who did @aurora.wilde recently follow?");
    expect(plan.primary).toBe("recent");
    expect(plan.intents).toContain("recent");
    expect(plan.username).toBe("aurora.wilde");

    const ask = await opAsk(ctx, plan);
    expect(ask.understanding.intents[0]).toBe("recent");
    // The fixture target has a recorded baseline and no diffs, so the honest
    // answer is a computed empty one — and it says the baseline exists.
    expect(ask.answer.join(" ")).toContain("@aurora.wilde");
    expect(ask.answer.join(" ")).toContain("baseline exists and nothing moved");
  });

  it("warns about synthetic rows from the rows themselves, never from the configured provider", async () => {
    // Fixture rows: the step's own evidence class is SYNTHETIC, so the answer
    // says so by name.
    const fixture = await opAsk(ctx, planAsk("what changed on @aurora.wilde since 2026-01-01?"));
    const fixtureText = fixture.answer.join("\n");
    expect(fixtureText).toContain("Synthetic fixture rows: changes");
    expect(fixtureText).toContain("Configured source: the synthetic fixture");
    expect(fixtureText).not.toContain("NOT observing a real account");

    // Live rows read while the fixture provider is configured: the answer is
    // LIVE and must not be labelled synthetic just because the configuration is.
    await createTarget(handle.db, { userId: ctx.userId, username: "live.rows" });
    const at = new Date();
    const snapshot = (observedAt: Date, followers: number) =>
      recordProfileSnapshot(handle.db, {
        profile: {
          account: { username: "live.rows" },
          followerCount: followers,
          followingCount: 10,
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: observedAt.toISOString(),
          },
        },
        evidence: {
          observationKind: "profile_snapshot",
          source: { id: "graph:owned:v1", kind: SourceKind.GRAPH_API, name: "Graph owned v1" },
          sourceReference: "test/ask",
          schemaVersion: "v1",
          observedAt,
          capturedAt: observedAt,
          confidence: Confidence.HIGH,
          rawHash: observedAt.getTime().toString(16).padStart(64, "0"),
          normalizedHash: (observedAt.getTime() + 1).toString(16).padStart(64, "0"),
        },
      });
    await snapshot(at, 100);
    await snapshot(new Date(at.getTime() + 3_600_000), 101);

    const live = await opAsk(ctx, planAsk("what changed on @live.rows since 2026-01-01?"));
    const liveText = live.answer.join("\n");
    expect(liveText).toContain("followerCount changed");
    expect(liveText).not.toContain("Synthetic fixture rows");
    expect(liveText).toContain("Configured source: the synthetic fixture");
    expect(liveText).not.toContain("NOT observing a real account");
  });
});

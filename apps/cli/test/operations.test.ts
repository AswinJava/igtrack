import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import type { InstagramProvider } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { CliError, UsageError } from "../src/output.js";
import {
  opActivity,
  opDossier,
  opEvidence,
  opInsights,
  opLookup,
  opMentionedCommentProbe,
  opScanRun,
  opStatus,
  opTaggedMedia,
  opTargetSetStatus,
  opTargetAdd,
  opWork,
  resolveTarget,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// Integration test for the agent surface (the functions behind both the CLI and
// the MCP tools).
//
// It pins the semantics that make the surface safe to hand to an autonomous
// agent:
//   * queueing is idempotent inside a scheduling window, and --force is the
//     only way to double-scan;
//   * a PAUSED target is skipped with a reason, never silently scanned;
//   * work actually observes, and reads afterwards see the observation;
//   * an unknown account is reported as such instead of as empty data.
//
// Requires the Docker Compose test database. When it is unavailable the suite
// reports itself skipped rather than passing vacuously.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde"; // the account the v1 fixture set knows
const DISCOVERY_USERNAME = "dune.harbor"; // the other account the v1 fixture set can discover

async function probe(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
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

describe.skipIf(!databaseUp)("agent surface operations", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;
  let targetId: string;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    // Every command resolves the owner from env; pin it at the test database so
    // the repository's .env can never redirect a test run at real data.
    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;

    ctx = await createContext();
    const added = await opTargetAdd(ctx, {
      username: FIXTURE_USERNAME,
      localName: "Fixture account",
      tags: ["test"],
    });
    targetId = added.id;
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("reports the active provider as synthetic so nothing looks live", async () => {
    const status = await opStatus(ctx);
    expect(status.provider.name).toBe("fixture");
    expect(status.provider.synthetic).toBe(true);
    expect(status.owner.email).toBe("dev@igtrack.local");
  });

  it("queues every owned scan kind once per scheduling window, and only --force repeats it", async () => {
    const first = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(first.enqueued).toHaveLength(7);
    expect(first.enqueued.every((e) => e.deduplicated === false)).toBe(true);
    // The discovery kind belongs to the other observation mode: refused with a
    // reason at enqueue, never queued to fail (D47).
    expect(first.skipped.map((s) => s.kind)).toEqual(["DISCOVERY_SCAN"]);
    expect(first.skipped[0]?.reason).toContain("DISCOVERY_SCAN observes another account");

    const second = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(second.enqueued).toHaveLength(7);
    expect(second.enqueued.every((e) => e.deduplicated === true)).toBe(true);
    expect(new Set(second.enqueued.map((e) => e.jobId))).toEqual(
      new Set(first.enqueued.map((e) => e.jobId)),
    );

    const forced = await opScanRun(ctx, { target: FIXTURE_USERNAME, force: true });
    expect(forced.enqueued.every((e) => e.deduplicated === false)).toBe(true);
    expect(
      forced.enqueued.some((e) => first.enqueued.some((f) => f.jobId === e.jobId)),
    ).toBe(false);
  });

  it("skips a PAUSED target with a reason instead of scanning it", async () => {
    await opTargetSetStatus(ctx, { target: FIXTURE_USERNAME, status: "PAUSED" });
    const result = await opScanRun(ctx, { target: FIXTURE_USERNAME });
    expect(result.enqueued).toHaveLength(0);
    expect(result.skipped).toHaveLength(8);
    expect(result.skipped.every((s) => s.reason.includes("PAUSED"))).toBe(true);
    await opTargetSetStatus(ctx, { target: FIXTURE_USERNAME, status: "ACTIVE" });
  });

  it("executes queued work and makes the result readable", async () => {
    // One job of each kind already exists from the first test; drain them.
    const work = await opWork(ctx, { max: 20, skipScheduler: true });
    const states = work.outcomes.map((o) => o.state);
    expect(states).not.toContain("failed");
    expect(states).not.toContain("lost");
    expect(states).not.toContain("unrecorded");
    // The fixture provider labels itself, and the worker reports that label.
    expect(work.provider.synthetic).toBe(true);

    const activity = await opActivity(ctx, { target: FIXTURE_USERNAME, limit: 20 });
    expect(activity.items.length).toBeGreaterThan(0);
    expect(activity.items.every((i) => i.targetUsername === FIXTURE_USERNAME)).toBe(true);
    // Every activity row must be able to point at its evidence.
    expect(activity.items.some((i) => i.evidenceId !== null)).toBe(true);

    const evidence = await opEvidence(ctx, { limit: 10 });
    expect(evidence.mode).toBe("list");
    if (evidence.mode === "list") {
      expect(evidence.rows.length).toBeGreaterThan(0);
      // A hash is either a real 64-char digest or absent (null) — never a
      // placeholder and never a normalized hash wearing a raw hash's name.
      for (const row of evidence.rows) {
        expect(row.raw_hash === null || /^[0-9a-f]{64}$/.test(row.raw_hash)).toBe(true);
      }
      expect(evidence.rows.some((r) => r.raw_hash !== null)).toBe(true);
      const row = evidence.rows.find((r) => r.raw_hash !== null) ?? evidence.rows[0];
      const chain = await opEvidence(ctx, { id: row?.id ?? "" });
      expect(chain.mode).toBe("chain");
      if (chain.mode === "chain") {
        expect(chain.chain?.claim.length).toBeGreaterThan(0);
      }
    }
  });

  it("reads recorded insights back, and never answers a never-observed metric with silence", async () => {
    const insights = await opInsights(ctx, { target: FIXTURE_USERNAME });
    expect(insights.target.username).toBe(FIXTURE_USERNAME);
    expect(insights.latest.truncated).toBe(false);
    expect(insights.state.points).toBeGreaterThan(60);
    expect(insights.state.absences).toBe(0);

    // The daily follower_count series is in the ledger now, oldest first, and
    // its last point agrees with the profile the fixture was captured with.
    const series = await opInsights(ctx, {
      target: FIXTURE_USERNAME,
      metric: "follower_count",
    });
    expect(series.series?.metric).toBe("follower_count");
    const points = series.series?.points ?? [];
    expect(points.length).toBeGreaterThan(20);
    expect(points[points.length - 1]?.value).toBe(12480);
    expect(series.series?.absentReason).toBeNull();

    // Demographics keep every country bucket rather than collapsing to one.
    const countries = insights.latest.rows.filter((r) => r.metric === "follower_demographics");
    expect(countries).toHaveLength(5);
    expect(countries.every((r) => r.dimension === "country")).toBe(true);

    // A metric that was never observed is EMPTY, and the empty says which kind
    // of empty it is — never a zero-filled series.
    const unknown = await opInsights(ctx, { target: FIXTURE_USERNAME, metric: "not_a_metric" });
    expect(unknown.series?.points).toEqual([]);
    expect(unknown.series?.absentReason).toBeNull();
  });

  it("filters activity by an ISO timestamp", async () => {
    const future = await opActivity(ctx, {
      target: FIXTURE_USERNAME,
      since: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.items).toHaveLength(0);
  });

  it("reports an unknown account as unknown, not as empty data", async () => {
    const lookup = await opLookup(ctx, { username: "this.account.does.not.exist" });
    expect(lookup.account).toBeNull();
    expect(["UNAVAILABLE", "ERROR"]).toContain(lookup.status);
    expect(lookup.error !== null || lookup.note !== null).toBe(true);

    const known = await opLookup(ctx, { username: FIXTURE_USERNAME });
    expect(known.status).toBe("AVAILABLE");
    expect(known.account).not.toBeNull();
  });

  it("answers another public account through the discovery probe, as a probe", async () => {
    const probe = await opLookup(ctx, { username: "@dune.harbor" });
    expect(probe.via).toBe("discovery");
    expect(probe.status).toBe("AVAILABLE");
    const account = probe.account as {
      followerCount?: number;
      recentMedia?: unknown[];
    } | null;
    expect(account?.followerCount).toBe(18420);
    expect(account?.recentMedia).toHaveLength(2);
    // The probe says what it is: read-through, nothing persisted.
    expect(probe.note).toContain("nothing was persisted");
  });

  it("refuses to resolve a target that is not tracked", async () => {
    await expect(resolveTarget(ctx.db, ctx.userId, "definitely-not-tracked")).rejects.toThrow(
      /No tracked target matches/,
    );
    const resolved = await resolveTarget(ctx.db, ctx.userId, FIXTURE_USERNAME);
    expect(resolved.id).toBe(targetId);
  });

  it("rejects an unknown scan kind with USAGE before anything is enqueued", async () => {
    try {
      await opScanRun(ctx, { target: FIXTURE_USERNAME, kinds: ["nonsense"] });
      expect.unreachable("opScanRun must reject an unknown kind");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("USAGE");
      expect((err as Error).message).toContain('Unknown scan kind "nonsense"');
      expect((err as Error).message).toContain("PROFILE_SCAN");
    }
  });

  it("rejects an unknown activity type instead of silently answering empty", async () => {
    // The MCP schema accepts free strings for types, so the operations layer is
    // the guarantee: an unknown filter must fail loudly with the allowed list.
    try {
      await opActivity(ctx, { types: ["TOTALLY_MADE_UP"] });
      expect.unreachable("opActivity must reject an unknown type");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("USAGE");
      expect((err as Error).message).toContain('Unknown activity type "TOTALLY_MADE_UP"');
      expect((err as Error).message).toContain("PROFILE_CHANGED");
    }

    // A valid filter still resolves, and every returned row matches it.
    const filtered = await opActivity(ctx, { types: ["NEW_FOLLOWER"] });
    expect(filtered.items.every((i) => i.type === "NEW_FOLLOWER")).toBe(true);
  });

  it("refuses --observed for the account this deployment already owns, with the route's reason (D49)", async () => {
    try {
      await opTargetAdd(ctx, { username: FIXTURE_USERNAME, observed: true });
      expect.unreachable("--observed must refuse an account the deployment already observes");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("OBSERVATION_UNAVAILABLE");
      expect((err as Error).message).toContain("cannot be observed through the documented route");
      // The platform's own reason travels into the refusal.
      expect((err as Error).message).toContain("the account this fixture set observes");
    }
  });

  it("reports an unknown --observed username as not found, never as an empty account (D49)", async () => {
    try {
      await opTargetAdd(ctx, { username: "ghost.account", observed: true });
      expect.unreachable("--observed must refuse an unknown username");
    } catch (err) {
      expect((err as CliError).code).toBe("ACCOUNT_NOT_FOUND");
    }
    // Nothing was created behind the refusal (invariant 7: no empty dataset).
    await expect(resolveTarget(ctx.db, ctx.userId, "ghost.account")).rejects.toThrow(
      /No tracked target matches/,
    );
  });

  it("refuses --observed when the configured provider has no documented route (D49)", async () => {
    const noRoute = {
      sourceId: "stub:noroute",
      capabilities: () => ({ discoverAccount: false }),
    } as unknown as InstagramProvider;
    try {
      await opTargetAdd(ctx, { username: "someone.else", observed: true, provider: noRoute });
      expect.unreachable("a provider without the route must refuse before creating anything");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("CAPABILITY_UNAVAILABLE");
    }
    await expect(resolveTarget(ctx.db, ctx.userId, "someone.else")).rejects.toThrow(
      /No tracked target matches/,
    );
  });

  it("records another public account through --observed and reads it back with its bounds (D47/D48/D50)", async () => {
    const added = await opTargetAdd(ctx, { username: DISCOVERY_USERNAME, observed: true });
    expect(added.created).toBe(true);
    expect(added.observationMode).toBe("DISCOVERY");
    expect(added.probe?.status).toBe("AVAILABLE");

    // A DISCOVERY target is answered by exactly one kind; the owned kinds are
    // refused with the mode reason instead of being queued to fail (D47).
    const queued = await opScanRun(ctx, { target: DISCOVERY_USERNAME });
    expect(queued.enqueued.map((e) => e.kind)).toEqual(["DISCOVERY_SCAN"]);
    expect(queued.skipped).toHaveLength(7);
    expect(queued.skipped.every((s) => s.reason.includes("only DISCOVERY_SCAN"))).toBe(true);

    const work = await opWork(ctx, { max: 40, skipScheduler: true });
    expect(
      work.outcomes.some((o) => o.kind === "DISCOVERY_SCAN" && o.state === "succeeded"),
    ).toBe(true);

    const dossier = await opDossier(ctx, { target: DISCOVERY_USERNAME });
    expect(dossier.target.username).toBe(DISCOVERY_USERNAME);
    expect(dossier.target.observationMode).toBe("DISCOVERY");
    expect(dossier.route.providerMethod).toBe("discoverAccount");
    // The preview is read back as the bounded thing it is, with the ceiling on
    // record — never as "the account's posts".
    expect(dossier.media?.storedCount).toBe(2);
    expect(dossier.media?.previewLimit).toBe(12);
    expect(dossier.media?.bounded).toBe(true);
    expect(dossier.media?.boundedStatement).toContain("NOT the account's post history");
    const mediaRow = dossier.media!.rows.find((r) => r.postId === "dune-post-1")!;
    expect(mediaRow.commentsState).toBe("UNAVAILABLE");
    // Published time and first-observed time are two different facts.
    expect(new Date(mediaRow.publishedAt!).getTime()).toBeLessThan(
      new Date(mediaRow.firstObservedAt!).getTime(),
    );

    // The route capability reads OBSERVED with rows behind it (profile snapshot
    // + 2 media rows), qualified by the bound caveat.
    const route = dossier.coverage.find((c) => c.capability === "OTHER_ACCOUNT_PUBLIC")!;
    expect(route.state).toBe("OBSERVED");
    expect(route.observedRows).toBe(3);
    expect(route.caveat).toContain("Bounded preview");
    // An owned-only capability is UNAVAILABLE with the mode's reason, not blank.
    const followers = dossier.coverage.find((c) => c.capability === "FOLLOWERS")!;
    expect(followers.state).toBe("UNAVAILABLE");
    expect(followers.reason).toContain("owned-account edges");

    // The dossier's report is scoped like every other read: another user sees
    // none of it.
    await expect(opDossier(ctx, { target: "definitely-not-tracked" })).rejects.toThrow(
      /No tracked target matches/,
    );
  });

  it("reads tagged media back as another account's media, with the listing's completeness (FOUNDING §17)", async () => {
    const tags = await opTaggedMedia(ctx, { target: FIXTURE_USERNAME });
    // The TAGS_SCAN job drained by the work test above stored the two fixture
    // rows, and the listing that produced them is recorded alongside them.
    expect(tags.listing).not.toBeNull();
    expect(tags.listing?.completion).toBe("COMPLETE");
    expect([...tags.rows.map((r) => r.mediaId)].sort()).toEqual([
      "tag-media-1",
      "tag-media-2",
    ]);

    // Each row names the tagging account, never this one.
    const first = tags.rows.find((r) => r.mediaId === "tag-media-1");
    expect(first?.ownerUsername).toBe("mira.lens");
    // Another account's publish time and our first observation are different facts.
    expect(first?.takenAt).toBe("2026-08-26T15:40:00.000Z");
    expect(first?.observedAt).not.toBe(first?.takenAt);
    // A field the provider did not return stays null, never "".
    expect(tags.rows.find((r) => r.mediaId === "tag-media-2")?.permalink).toBeNull();
    expect(tags.notes.join(" ")).toContain("ANOTHER account");
  });

  it("answers one mentioned comment by id and persists nothing (FOUNDING §17)", async () => {
    // With more than one owned account (the seed's target_a plus this one) the
    // read refuses to guess which account a webhook notification belongs to.
    await expect(
      opMentionedCommentProbe(ctx, { commentId: "mentioned-comment-1" }),
    ).rejects.toThrow(/pass --account/);

    const probe = await opMentionedCommentProbe(ctx, {
      commentId: "mentioned-comment-1",
      account: FIXTURE_USERNAME,
    });
    expect(probe.status).toBe("AVAILABLE");
    expect(probe.account).toBe(FIXTURE_USERNAME);
    const comment = probe.comment as {
      commentId: string;
      likeCount?: number;
      mediaId?: string;
    } | null;
    expect(comment?.commentId).toBe("mentioned-comment-1");
    expect(comment?.likeCount).toBe(12);
    expect(comment?.mediaId).toBe("other-media-77");

    // The read is stateless: an id the set does not declare is UNAVAILABLE
    // with the reason, never a fabricated or empty comment.
    const unknown = await opMentionedCommentProbe(ctx, {
      commentId: "no-such-comment",
      account: FIXTURE_USERNAME,
    });
    expect(unknown.status).toBe("UNAVAILABLE");
    expect(unknown.comment).toBeNull();
    expect(unknown.note).toMatch(/declares no mentioned comment/);
  });

  it("reports tags, the mention-listing gap, and the repost metric exactly as observed (FOUNDING §17)", async () => {
    const dossier = await opDossier(ctx, { target: FIXTURE_USERNAME });

    const tags = dossier.coverage.find((c) => c.capability === "TAGS");
    expect(tags?.state).toBe("OBSERVED");
    expect(tags?.observedRows).toBe(2);

    // No listing edge exists for mentioned comments: the dossier states that
    // with the reason instead of an empty list pretending to be one.
    const mentions = dossier.coverage.find((c) => c.capability === "MENTIONED_COMMENTS");
    expect(mentions?.state).toBe("UNAVAILABLE");
    expect(mentions?.reason).toMatch(/stateless single read/);

    // The repost metric is OBSERVED for exactly the rows that returned it:
    // post-1 carries it, post-2's absence stays absent — never zero.
    const reposts = dossier.coverage.find((c) => c.capability === "REPOSTS");
    expect(reposts?.state).toBe("OBSERVED");
    expect(reposts?.observedRows).toBe(1);
    const post1 = dossier.media?.rows.find((r) => r.postId === "post-1");
    const post2 = dossier.media?.rows.find((r) => r.postId === "post-2");
    expect(post1?.repostsCount).toBe(128);
    expect(post2?.repostsCount).toBeNull();
  });
});

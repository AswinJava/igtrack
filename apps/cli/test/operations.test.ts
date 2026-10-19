import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import type { InstagramProvider } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { runResearch } from "../src/commands/intel.js";
import { runDossier } from "../src/commands/read.js";
import { doctorExitCode, renderDoctorHuman, runDoctor } from "../src/commands/setup.js";
import { CliError, UsageError } from "../src/output.js";
import {
  opActivity,
  type DoctorReport,
  opClaimAdd,
  opClaimList,
  opClaimRetract,
  opDossier,
  opEvidence,
  opInsights,
  opLookup,
  opMentionedCommentProbe,
  opPlan,
  opResearch,
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

  it("separates invalid reference syntax from a valid-but-untracked account", async () => {
    // A hyphenated reference is not username syntax. The answer is a typed
    // usage error naming what was accepted — not a NOT_FOUND an agent retries.
    try {
      await resolveTarget(ctx.db, ctx.userId, "definitely-not-tracked");
      expect.unreachable("a hyphenated reference is not a valid username");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("TARGET_REFERENCE_INVALID");
      expect((err as Error).message).toContain("Accepted:");
    }
    // A valid username that simply is not on record answers NOT_FOUND.
    await expect(resolveTarget(ctx.db, ctx.userId, "not.tracked.anywhere")).rejects.toThrow(
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
    await expect(opDossier(ctx, { target: "not.tracked.anywhere" })).rejects.toThrow(
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

  // -------------------------------------------------------------------------
  // Claims ledger, research report and stateless planner (FOUNDING §18).
  //
  // The claims here are attached to the fixture target this suite owns, so
  // the seed's own claim fixtures on target_a stay untouched.
  // -------------------------------------------------------------------------

  it("resolves a target by id, @handle and profile URL; an account-less URL is its own typed refusal", async () => {
    const byUsername = await resolveTarget(ctx.db, ctx.userId, FIXTURE_USERNAME);
    const byHandle = await resolveTarget(ctx.db, ctx.userId, `@${FIXTURE_USERNAME}`);
    const byUrl = await resolveTarget(
      ctx.db,
      ctx.userId,
      `https://www.instagram.com/${FIXTURE_USERNAME}/?hl=en`,
    );
    const byId = await resolveTarget(ctx.db, ctx.userId, targetId);
    expect(new Set([byUsername.id, byHandle.id, byUrl.id, byId.id])).toEqual(new Set([targetId]));

    // A post URL is a well-formed Instagram URL that does not name an account:
    // the parser says exactly that, so an agent does not retry a NOT_FOUND.
    for (const bad of ["https://www.instagram.com/p/ABC123/", "not a username!!"]) {
      try {
        await resolveTarget(ctx.db, ctx.userId, bad);
        expect.unreachable(`"${bad}" must not resolve`);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe("TARGET_REFERENCE_INVALID");
      }
    }
  });

  it("stores web claims with their source and derives SINGLE_SOURCE → CORROBORATED, never a score", async () => {
    const first = await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "organization-name",
      value: "Aurora Print Studio",
      sourceUrl: "https://alpha.example.com/about",
      excerpt: "Aurora Print Studio is a two-person printing studio.",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(first.claim.predicate).toBe("ORGANIZATION_NAME");
    expect(first.claim.sourceKind).toBe("WEB");
    expect(first.claim.sourceDomain).toBe("alpha.example.com");
    expect(first.claim.excerptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.claim.relation).toBe("SINGLE_SOURCE");

    // A second, distinct domain asserting the same value corroborates it.
    const second = await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceUrl: "https://beta.example.net/studio",
    });
    expect(second.claim.relation).toBe("CORROBORATED");

    // The exact same finding again is refused, and the refusal names the row:
    // re-submission is not a second source.
    try {
      await opClaimAdd(ctx, {
        target: FIXTURE_USERNAME,
        predicate: "ORGANIZATION_NAME",
        value: "Aurora Print Studio",
        sourceUrl: "https://alpha.example.com/about",
      });
      expect.unreachable("a duplicate claim must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("CLAIM_DUPLICATE");
      expect((err as Error).message).toContain(first.claim.id);
    }

    // An operator assertion is stored, labelled as such, and never dressed as
    // a sourced finding.
    const operator = await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "CONTACT_CHANNEL",
      value: "hello@aurora.example",
    });
    expect(operator.claim.sourceKind).toBe("OPERATOR");
    expect(operator.claim.relation).toBe("OPERATOR_ASSERTED");

    // Sensitive person-level predicates and non-http(s) sources are refused
    // at write time, with the reason — not stored and flagged later.
    try {
      await opClaimAdd(ctx, {
        target: FIXTURE_USERNAME,
        predicate: "job-title",
        value: "Barista",
      });
      expect.unreachable("an employment predicate must be refused");
    } catch (err) {
      expect((err as CliError).code).toBe("CLAIM_PREDICATE_REFUSED");
    }
    await expect(
      opClaimAdd(ctx, {
        target: FIXTURE_USERNAME,
        predicate: "LOCATION_STATED",
        value: "Nowhere",
        sourceUrl: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_SOURCE_URL_INVALID" });
  });

  it("keeps conflicting values visible with both sides and reports the contradiction", async () => {
    await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "LOCATION_STATED",
      value: "Lisbon",
      sourceUrl: "https://news.example.org/lisbon",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });
    await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "LOCATION_STATED",
      value: "Porto",
      sourceUrl: "https://blog.example.org/porto",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });

    const listed = await opClaimList(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "LOCATION_STATED",
    });
    const group = listed.groups.find((g) => g.predicate === "LOCATION_STATED");
    expect(group?.relation).toBe("CONFLICTED");
    expect(group?.claims.map((c) => c.value).sort()).toEqual(["Lisbon", "Porto"]);
    // Every member of a conflicted cluster is marked conflicted; none is
    // silently promoted to "the answer".
    expect(group?.claims.every((c) => c.conflicted)).toBe(true);
    expect(group?.sourceDomains.sort()).toEqual(["blog.example.org", "news.example.org"]);

    const research = await opResearch(ctx, { target: FIXTURE_USERNAME });
    const contradiction = research.contradictions.find((c) => c.predicate === "LOCATION_STATED");
    expect(contradiction?.values.map((v) => v.value).sort()).toEqual(["Lisbon", "Porto"]);
    expect(contradiction?.values.flatMap((v) => v.sources).length).toBe(2);
  });

  it("retracts only on explicit confirmation, keeps the row readable, and drops it from relation labels", async () => {
    const added = await opClaimAdd(ctx, {
      target: FIXTURE_USERNAME,
      predicate: "PRODUCT_OR_SERVICE",
      value: "Ceramics",
      sourceUrl: "https://alpha.example.com/shop",
    });
    await expect(
      opClaimRetract(ctx, { claimId: added.claim.id, reason: "discontinued", confirm: false }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });

    const retracted = await opClaimRetract(ctx, {
      claimId: added.claim.id,
      reason: "Service discontinued; source page removed.",
      confirm: true,
    });
    expect(retracted.claim.status).toBe("RETRACTED");

    // Gone from the active view, still readable on request — nothing deleted.
    const active = await opClaimList(ctx, { target: FIXTURE_USERNAME });
    expect(active.groups.some((g) => g.predicate === "PRODUCT_OR_SERVICE")).toBe(false);
    expect(active.totals.retracted).toBeGreaterThan(0);
    const withRetracted = await opClaimList(ctx, {
      target: FIXTURE_USERNAME,
      includeRetracted: true,
    });
    const row = withRetracted.retracted.find((c) => c.id === added.claim.id);
    expect(row?.retractionReason).toContain("discontinued");
    expect(row?.relation).toBeNull();

    // Retracting twice is a typed conflict, never a silent no-op.
    await expect(
      opClaimRetract(ctx, { claimId: added.claim.id, reason: "again", confirm: true }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_RETRACTED" });
  });

  it("states DISCOVERY-target connections as platform-absent, with the reason (FOUNDING §14/§15)", async () => {
    try {
      await opTargetAdd(ctx, { username: DISCOVERY_USERNAME, observed: true });
    } catch {
      // Already tracked by an earlier test — that is exactly the state needed.
    }
    const research = await opResearch(ctx, { target: DISCOVERY_USERNAME });
    expect(research.target.observationMode).toBe("DISCOVERY");
    expect(research.connections.state).toBe("UNAVAILABLE");
    expect((research.connections.reason ?? "").length).toBeGreaterThan(0);
    expect(research.connections.ranks).toEqual([]);
    // Mode-absent sections say why, and carry null — never 0 — where a figure
    // was never read: audience and change detection are owned-account edges.
    expect(research.audience.state).toBe("UNAVAILABLE");
    expect(research.audience.points).toBeNull();
    expect(research.audience.absences).toBeNull();
    expect(research.audience.reason).toMatch(/owned-account edge/);
    expect(research.changes.state).toBe("UNAVAILABLE");
    expect(research.changes.profileChanges).toBeNull();
    expect(research.changes.postChanges).toBeNull();
    expect(research.changes.followDeltas).toBeNull();
    // Derived figures that exist carry the bounded-preview caveat with them.
    if (research.themes.state === "DERIVED") {
      expect(research.themes.note).toContain("BOUNDED discovery media preview");
    }
    if (research.cadence.state === "DERIVED") {
      expect(research.cadence.note).toContain("BOUNDED discovery media preview");
    }
    // Claims and platform observations appear as separate sections; with no
    // claims yet the section says exactly that, without implying the account
    // has no footprint.
    expect(research.claims.statement).toMatch(/No claims are recorded/);
    expect(research.computedAt.length).toBeGreaterThan(0);
  });

  it("plans from stored state: owned-only vs discovery kinds, claims status, and an actionable next step", async () => {
    const plan = await opPlan(ctx, { target: FIXTURE_USERNAME });
    expect(plan.goal).toBe("FULL");
    const byId = new Map(plan.steps.map((step) => [step.id, step]));

    // D47 at plan time: an OWNED target is never asked to run DISCOVERY_SCAN.
    const discoveryStep = byId.get("observe:DISCOVERY_SCAN");
    expect(discoveryStep?.status).toBe("NOT_APPLICABLE");
    expect(discoveryStep?.reason).toMatch(/DISCOVERY_SCAN observes another account/);

    // Claims were added earlier in this suite, so the step is DONE with the
    // count as evidence — the planner reads rows, it does not assume.
    const claimsStep = byId.get("claims:record");
    expect(claimsStep?.status).toBe("DONE");
    expect(claimsStep?.evidence[0]).toMatch(/active claim/);

    expect(byId.get("report:research")?.tool).toBe("igtrack_research");
    // Whatever the next action is, it is a tool name plus params an agent can
    // execute verbatim — or null when nothing is left to run.
    if (plan.nextAction !== null) {
      expect(plan.nextAction.tool.startsWith("igtrack_")).toBe(true);
      expect(plan.nextAction.because.length).toBeGreaterThan(0);
    }

    const discoveryPlan = await opPlan(ctx, { target: DISCOVERY_USERNAME });
    const discoveryById = new Map(discoveryPlan.steps.map((step) => [step.id, step]));
    expect(discoveryById.get("observe:DISCOVERY_SCAN")?.status).not.toBe("NOT_APPLICABLE");
    expect(discoveryById.get("observe:PROFILE_SCAN")?.status).toBe("NOT_APPLICABLE");
    expect(discoveryById.get("observe:PROFILE_SCAN")?.reason).toMatch(/only DISCOVERY_SCAN/);

    await expect(opPlan(ctx, { target: FIXTURE_USERNAME, goal: "SPY" })).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("derives themes and cadence from the stored corpus and names that corpus", async () => {
    const research = await opResearch(ctx, { target: FIXTURE_USERNAME });
    const mediaRows = research.platform.media?.rows ?? [];

    if (research.themes.state === "DERIVED") {
      // The corpus in the note is the same corpus the counts came from.
      expect(research.themes.note).toContain(`corpus: ${mediaRows.length} stored media row(s)`);
      const counts = research.themes.terms.map((t) => t.count);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      for (const term of research.themes.terms) {
        expect(term.term).toBe(term.term.toLowerCase());
      }
      expect(research.themes.captionRows).toBeGreaterThan(0);
      expect(research.themes.captionRows).toBeLessThanOrEqual(mediaRows.length);
    } else {
      expect((research.themes.reason ?? "").length).toBeGreaterThan(0);
      expect(research.themes.terms).toEqual([]);
    }

    if (research.cadence.state === "DERIVED") {
      const distinct = new Set(
        mediaRows.map((row) => row.publishedAt).filter((v): v is string => v !== null),
      ).size;
      // This fixture stores two media rows, well under the dossier preview cap,
      // so the stored corpus equals what the report shows.
      expect(research.cadence.timestampRows).toBe(distinct);
      expect(research.cadence.medianGapDays === null).toBe(distinct < 2);
      expect(research.cadence.note).toContain("provider times, not first-observed");
    } else {
      expect((research.cadence.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("counts recorded change events in a stated window and never reads a gap as 'nothing happened'", async () => {
    const research = await opResearch(ctx, { target: FIXTURE_USERNAME });
    expect(research.changes.state).toBe("OBSERVED");
    expect(research.changes.windowDays).toBe(90);
    expect(research.changes.since).not.toBeNull();
    expect(research.changes.profileChanges).not.toBeNull();
    expect(research.changes.postChanges).not.toBeNull();
    expect(research.changes.followDeltas).not.toBeNull();
    expect(research.changes.note).toMatch(/never evidence that nothing happened/);
  });

  it("surfaces platform-reported insight absences and never infers audience numbers", async () => {
    const research = await opResearch(ctx, { target: FIXTURE_USERNAME });
    expect(research.audience.state).toBe("OBSERVED");
    expect(research.audience.latestObservedAt).not.toBeNull();
    for (const point of research.audience.latest) {
      expect(Number.isFinite(point.value)).toBe(true);
    }
    if ((research.audience.absences ?? 0) > 0) {
      expect(research.audience.note).toContain("ABSENT");
      expect(research.audience.latestAbsences.length).toBeGreaterThan(0);
      for (const absence of research.audience.latestAbsences) {
        expect(absence.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("narrows only the claims section with --since and states what it omitted", async () => {
    const all = await opResearch(ctx, { target: FIXTURE_USERNAME });
    const cutoff = "2026-10-05T00:00:00.000Z";
    const filtered = await opResearch(ctx, { target: FIXTURE_USERNAME, since: cutoff });

    const allRows = [...all.claims.groups.flatMap((g) => g.claims), ...all.claims.retracted];
    const expectedOmitted = allRows.filter(
      (claim) => new Date(claim.retrievedAt ?? claim.recordedAt).getTime() < Date.parse(cutoff),
    ).length;
    // The suite's fixture claims straddle the cutoff, so the assertion bites.
    expect(expectedOmitted).toBeGreaterThan(0);
    expect(expectedOmitted).toBeLessThan(allRows.length);

    expect(filtered.claims.since).toBe(cutoff);
    expect(filtered.claims.omittedBefore).toBe(expectedOmitted);
    const visible = [
      ...filtered.claims.groups.flatMap((g) => g.claims),
      ...filtered.claims.retracted,
    ];
    expect(visible.length).toBe(allRows.length - expectedOmitted);
    // The filter states itself in the notes; nothing is silently dropped.
    expect(filtered.notes.some((note) => note.includes("filtered the CLAIMS section only"))).toBe(
      true,
    );
    // Platform sections are untouched by a claims filter.
    expect(filtered.platform.counts).toEqual(all.platform.counts);
    // Both LOCATION_STATED claims predate the cutoff, so the contradiction is
    // out of view — and comes back the moment the filter is dropped.
    expect(filtered.contradictions).toEqual([]);
    expect(all.contradictions.some((c) => c.predicate === "LOCATION_STATED")).toBe(true);
  });

  it("is deterministic: two consecutive reports differ only in computedAt", async () => {
    const first = await opResearch(ctx, { target: FIXTURE_USERNAME });
    const second = await opResearch(ctx, { target: FIXTURE_USERNAME });
    expect(second).toEqual({ ...first, computedAt: second.computedAt });
  });

  it("refuses --json together with --format md before it touches a database", async () => {
    await expect(
      runResearch({
        command: "research",
        positionals: [FIXTURE_USERNAME],
        flags: { json: true, format: "md" },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

// ---------------------------------------------------------------------------
// Provider readiness and report honesty (config layer).
  //
  // The defect these pin: a presence check answered "are the credentials set?"
  // while the deployment still held the literal `PASTE_..._HERE` markers a
  // fresh `.env` ships with, so an unusable configuration read as ready. Same
  // class of lie as drawing absence as zero.
  // ---------------------------------------------------------------------------

/** The markers a fresh `.env` ships with — set explicitly so no test depends on the developer's file. */
const GRAPH_PLACEHOLDERS = {
  IGTRACK_PROVIDER: "graph",
  IGTRACK_GRAPH_ACCESS_TOKEN: "PASTE_LONG_LIVED_TOKEN_HERE",
  IGTRACK_GRAPH_IG_USER_ID: "PASTE_IG_USER_ID_HERE",
  IGTRACK_GRAPH_USERNAME: "PASTE_OWNED_USERNAME_HERE",
};
const GRAPH_PLACEHOLDER_VALUES = [
  GRAPH_PLACEHOLDERS.IGTRACK_GRAPH_ACCESS_TOKEN,
  GRAPH_PLACEHOLDERS.IGTRACK_GRAPH_IG_USER_ID,
  GRAPH_PLACEHOLDERS.IGTRACK_GRAPH_USERNAME,
];

/** Swap the graph configuration in for the body of a test, restoring exactly what was there. */
async function withGraphConfig<T>(body: () => Promise<T>): Promise<T> {
  const keys = Object.keys(GRAPH_PLACEHOLDERS);
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(GRAPH_PLACEHOLDERS)) process.env[k] = v;
  try {
    return await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Capture what a command actually writes, so JSON and human output can be compared. */
async function captureOutput(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write");
  spy.mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await run();
    return { code, out: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(!databaseUp)("provider readiness", () => {
  let ctx: CliContext;

  beforeAll(async () => {
    // Same test database the suite above migrated and seeded; this describe
    // runs after it, so its recorded targets are on record here too. The
    // provider is pinned to fixture so the repository's own .env can never
    // redirect a test run at real data.
    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;
    ctx = await createContext();

    // Assert on both targets this describe reads. Registering them here makes
    // the block self-contained instead of inheriting whatever the suite above
    // happened to get through: `targets add` is idempotent, so a target the
    // earlier suite already recorded is simply reused.
    await opTargetAdd(ctx, { username: FIXTURE_USERNAME });
    await opTargetAdd(ctx, { username: DISCOVERY_USERNAME, observed: true });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("6. answers a known fixture account as local synthetic data, not a live request", async () => {
    const result = await opLookup(ctx, { username: FIXTURE_USERNAME });
    expect(result.provider).toBe("fixture");
    expect(result.sourceKind).toBe("local");
    expect(result.businessDiscovery).toBeNull();
    expect(result.status).toBe("AVAILABLE");
    expect(result.account).not.toBeNull();
    expect(result.why).toMatch(/local data set|synthetic/i);
  });

  it("7. distinguishes 'not in the fixture set' from 'Instagram said no'", async () => {
    const result = await opLookup(ctx, { username: "sel_win_" });
    expect(result.status).toBe("ERROR");
    expect(result.error?.kind).toBe("ACCOUNT_NOT_FOUND");
    expect(result.sourceKind).toBe("local");
    expect(result.account).toBeNull();
    // The sentence a bare ACCOUNT_NOT_FOUND would otherwise let an agent
    // over-read: this is an absence from local rows, not a platform verdict.
    expect(result.why).toContain("never contacts Instagram");
    expect(result.why).toContain("not evidence that the account does not exist");
  });

  it("11. never falls back to fixture data when the graph configuration is unusable", async () => {
    await withGraphConfig(async () => {
      const fresh = await createContext();
      try {
        expect(fresh.provider.name).toBe("graph");
        expect(fresh.provider.provider).toBeNull();
        expect(fresh.provider.sourceId).toBeNull();
        // The failure names variables and fixes — never the values themselves.
        expect(fresh.provider.error).toMatch(/PLACEHOLDER/);
        for (const value of GRAPH_PLACEHOLDER_VALUES) {
          expect(fresh.provider.error).not.toContain(value);
        }
        await expect(opLookup(fresh, { username: FIXTURE_USERNAME })).rejects.toMatchObject({
          code: "PROVIDER_UNAVAILABLE",
        });
      } finally {
        await fresh.close();
      }
    });
  });

  it("12. refuses a live registration attempt while the graph credentials are placeholders", async () => {
    const before = await opStatus(ctx);
    await withGraphConfig(async () => {
      const fresh = await createContext();
      try {
        await expect(
          opTargetAdd(fresh, { username: "sel_win_", observed: true }),
        ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      } finally {
        await fresh.close();
      }
    });
    const after = await opStatus(ctx);
    expect(after.targets.items.length).toBe(before.targets.items.length);
    expect(after.targets.items.map((t) => t.username)).not.toContain("sel_win_");
  });

  it("12. a failed discovery probe leaves the database unchanged", async () => {
    const before = await opStatus(ctx);
    await expect(
      opTargetAdd(ctx, { username: "sel_win_", observed: true }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    const after = await opStatus(ctx);
    expect(after.targets.items.length).toBe(before.targets.items.length);
    expect(after.targets.items.map((t) => t.username)).not.toContain("sel_win_");
    await expect(resolveTarget(ctx.db, ctx.userId, "sel_win_")).rejects.toThrow(
      /No tracked target matches/,
    );
  });

  it("8. reports the same configuration in JSON as on the human screen", async () => {
    await withGraphConfig(async () => {
      const human = await captureOutput(() =>
        runDoctor({ command: "doctor", positionals: [], flags: {} }),
      );
      const json = await captureOutput(() =>
        runDoctor({ command: "doctor", positionals: [], flags: { json: true } }),
      );
      const parsed = JSON.parse(json.out) as { ok: boolean; data: DoctorReport };
      expect(parsed.ok).toBe(true);

      const cfg = parsed.data.env.config;
      expect(cfg.status).toBe("PLACEHOLDER");
      // Readiness is local by construction — the payload says so itself.
      expect(cfg.networkCallMade).toBe(false);
      expect(cfg.problems.length).toBeGreaterThan(0);

      // Same object, two renderings: the screen is exactly what the JSON says.
      expect(human.out).toBe(`${renderDoctorHuman(parsed.data)}\n`);
      expect(human.out).toContain(`BLOCKED (${cfg.status})`);
      expect(human.out).toContain("NOT_VERIFIED — doctor makes no network request");
      for (const variable of cfg.variables) expect(human.out).toContain(variable.name);

      // And the exit code follows from the same report on both paths.
      expect(doctorExitCode(parsed.data)).toBe(3);
      expect(human.code).toBe(3);
      expect(json.code).toBe(3);
      for (const value of GRAPH_PLACEHOLDER_VALUES) {
        expect(human.out).not.toContain(value);
        expect(json.out).not.toContain(value);
      }
    });
    // Both paths build a full doctor report; the budget follows the work, not
    // the machine's mood.
  }, 30_000);

  it("9. stays exit 0 for the fixture workflow and non-zero when graph readiness is claimed but absent", async () => {
    const fixtureRun = await captureOutput(() =>
      runDoctor({ command: "doctor", positionals: [], flags: {} }),
    );
    // Fixtures are legitimate; doctor must keep working for them.
    expect(fixtureRun.code).toBe(0);
    expect(fixtureRun.out).toContain("IGTRACK_PROVIDER=fixture");
    expect(fixtureRun.out).toContain("NOT_VERIFIED — doctor makes no network request");

    // A switch to graph on the example text must not read as healthy.
    await withGraphConfig(async () => {
      const graphRun = await captureOutput(() =>
        runDoctor({ command: "doctor", positionals: [], flags: {} }),
      );
      expect(graphRun.code).toBe(3);
      expect(graphRun.out).toContain("BLOCKED (PLACEHOLDER)");
      expect(graphRun.out).toContain("no API request was made");
    });
    // Two full doctor passes, each opening its own context: generous under
    // load rather than a silent 5s default.
  }, 30_000);

  it("13. labels the dossier's evidence and names the provider it came from", async () => {
    const dossier = await opDossier(ctx, { target: FIXTURE_USERNAME });
    expect(dossier.route.observingSources.every((s) => s.startsWith("fixture:"))).toBe(true);

    const human = await captureOutput(() =>
      runDossier({ command: "dossier", positionals: [FIXTURE_USERNAME], flags: {} }),
    );
    expect(human.out).toContain("Evidence");
    expect(human.out).toContain("SYNTHETIC — generated fixture data");
    expect(human.out).toContain("Not live Instagram evidence");

    const json = await captureOutput(() =>
      runDossier({ command: "dossier", positionals: [FIXTURE_USERNAME], flags: { json: true } }),
    );
    const parsed = JSON.parse(json.out) as {
      data: { route: { observingSources: string[] } };
      _meta: { synthetic: boolean; provider: string };
    };
    expect(parsed._meta.synthetic).toBe(true);
    expect(parsed._meta.provider).toBe("fixture");
    expect(parsed.data.route.observingSources.every((s) => s.startsWith("fixture:"))).toBe(true);
    // One dossier read plus two CLI renders; the timeout follows the work.
  }, 30_000);

  it("14. reports coverage per capability with a reason, never an empty row or an implied zero", async () => {
    const dossier = await opDossier(ctx, { target: DISCOVERY_USERNAME });
    expect(dossier.coverage.length).toBeGreaterThan(0);
    const unobserved = dossier.coverage.filter((row) => row.state !== "OBSERVED");
    expect(unobserved.length).toBeGreaterThan(0);
    for (const row of dossier.coverage) {
      if (row.state === "OBSERVED") {
        // An observed state must have rows behind it, or it is a claim.
        expect(row.observedRows, row.capability).not.toBeNull();
        expect(row.observedRows as number).toBeGreaterThan(0);
      } else {
        // Not observed and unavailable are both stated with their reason —
        // registry text or a recorded route note, never silence.
        expect(row.reason, `${row.capability} has no reason`).toBeTruthy();
        expect((row.reason ?? "").length).toBeGreaterThan(0);
      }
    }
    // The refusals are on record alongside what was observed.
    expect(dossier.coverage.some((r) => r.state === "UNAVAILABLE")).toBe(true);
    expect(dossier.route.observingSources.every((s) => s.startsWith("fixture:"))).toBe(true);
    // A whole-dossier coverage pass over every registry row; the timeout
    // follows the work rather than the machine's mood.
  }, 30_000);
});

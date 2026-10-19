import postgres from "postgres";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import { CAPABILITY_REGISTRY, isCapabilityAvailable } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { CliError } from "../src/output.js";
import { opClaimAdd, opResearch, opTargetAdd, type ResearchResult } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The DEEP-ACCOUNT-INTELLIGENCE §7.2 benchmark: twelve fixed questions run
// against the seeded database, plus the §7.3 metric pins.
//
// Each test states the answer CLASS the product must produce for its question —
// a stored observation with its time, a labelled claim, or a refusal/reason.
// "Plausible but unbacked" fails here by construction: there is nothing in the
// payload to assert against except stored rows and their stated bounds.
//
// The seeded DB is exactly `pnpm igtrack setup` state: target_a (OWNED) with
// three profile snapshots, follow signals, and the scripted claim set; no posts
// and no insights, so the unobserved sections must say so with a reason.
//
// Requires the Postgres test database; when it is unavailable the suite reports
// itself skipped rather than passing vacuously.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const SEEDED_USERNAME = "target_a"; // the seed's owned account, claims attached
const DISCOVERY_USERNAME = "dune.harbor"; // the other account the fixture set can discover

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

describe.skipIf(!databaseUp)("research benchmark (§7.2 questions, §7.3 metrics)", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;
  let research: ResearchResult;

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
    research = await opResearch(ctx, { target: SEEDED_USERNAME });
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  // -------------------------------------------------------------------------
  // §7.2 — the twelve questions.
  // -------------------------------------------------------------------------

  it("Q1 follower count now — the latest stored observation, never a guess", () => {
    expect(typeof research.platform.profile.latest?.followerCount).toBe("number");
    expect(research.platform.profile.latest?.followerCount).toBe(431); // seed's newest snapshot
    expect(research.platform.profile.snapshotCount).toBe(3);
    expect(research.platform.profile.latest?.observedAt.length).toBeGreaterThan(0);
  });

  it("Q2 who runs the account — labelled claims with sources, or 'no claims recorded'", () => {
    const org = research.claims.groups.find((g) => g.predicate === "ORGANIZATION_NAME");
    if (org === undefined) {
      expect(research.claims.statement).toMatch(/No claims are recorded/);
      return;
    }
    expect(org.claims.map((c) => c.value)).toEqual(["Aurora Print Studio", "Aurora Print Studio"]);
    // Two distinct domains asserting the same value: CORROBORATED, never a score.
    expect(org.relation).toBe("CORROBORATED");
    expect(org.sourceDomains).toHaveLength(2);
    for (const claim of org.claims) {
      expect(claim.sourceKind).toBe("WEB");
      expect(claim.sourceUrl).toMatch(/^https?:\/\//);
    }
  });

  it("Q3 where based — the LOCATION_STATED claims (both sides), or a refusal with reason", () => {
    const location = research.claims.groups.find((g) => g.predicate === "LOCATION_STATED");
    expect(location?.claims.map((c) => c.value).sort()).toEqual(["Lisbon", "Porto"]);
    expect(location?.relation).toBe("CONFLICTED");
  });

  it("Q4 themes — derived only from a stated corpus, or UNAVAILABLE with the reason", () => {
    // The seed stores no posts, so the honest answer is the reason plus an
    // empty (not fabricated) term list.
    expect(research.themes.state).toBe("UNAVAILABLE");
    expect((research.themes.reason ?? "").length).toBeGreaterThan(0);
    expect(research.themes.terms).toEqual([]);
    expect(research.themes.hashtags).toEqual([]);
    expect(research.cadence.state).toBe("UNAVAILABLE");
    expect((research.cadence.reason ?? "").length).toBeGreaterThan(0);
    expect(research.cadence.medianGapDays).toBeNull();
  });

  it("Q5 closest contacts — evidence-ranked for OWNED, platform-absent for DISCOVERY", async () => {
    expect(research.connections.state).toBe("OBSERVED");
    expect(research.connections.method).not.toBeNull();

    await opTargetAdd(ctx, { username: DISCOVERY_USERNAME, observed: true }).catch(() => undefined);
    const discovery = await opResearch(ctx, { target: DISCOVERY_USERNAME });
    expect(discovery.connections.state).toBe("UNAVAILABLE");
    expect((discovery.connections.reason ?? "").length).toBeGreaterThan(0);
    expect(discovery.connections.ranks).toEqual([]);
  });

  it("Q6 who liked the last post — refused: no liker edge exists, and none is invented", () => {
    // No available capability exposes like actors; the registry carries the
    // documented-absent reason, and a report row for it says UNAVAILABLE.
    const likes = CAPABILITY_REGISTRY.find((entry) => entry.id === "LIKES");
    expect(likes).toBeDefined();
    expect(isCapabilityAvailable(likes!)).toBe(false);
    expect((likes?.whyUnavailable ?? "").length).toBeGreaterThan(0);

    const likesRow = research.coverage.find((row) => row.capability === "LIKES");
    if (likesRow !== undefined) {
      expect(likesRow.state).toBe("UNAVAILABLE");
      expect((likesRow.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("Q7 other accounts — leads only (labelled 'not claims'), never inferred relationships", () => {
    expect(research.leads.state).toBe("OBSERVED");
    expect(research.leads.note).toMatch(/not claims/i);
    // The seeded corpus asserts no relation between accounts, and the report
    // does not manufacture one.
    expect(research.claims.groups.some((g) => g.predicate === "RELATED_ACCOUNT_ASSERTED")).toBe(
      false,
    );
  });

  it("Q8 employed at where — a refused predicate names its refusal (FOUNDING), stores nothing", async () => {
    try {
      await opClaimAdd(ctx, {
        target: SEEDED_USERNAME,
        predicate: "job-title",
        value: "Barista",
      });
      expect.unreachable("an employment predicate must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("CLAIM_PREDICATE_REFUSED");
      expect((err as Error).message).toContain("FOUNDING");
    }
  });

  it("Q9 follower count 30 days ago — stored snapshot history only, no backward projection", () => {
    // Follower counts arrive through profile snapshots (follower_snapshots is
    // the follow-list machinery, a different table); three are stored.
    const snapshots = research.platform.counts.profileSnapshots;
    expect(snapshots?.count).toBe(3);
    expect(snapshots?.latestAt).not.toBeNull();
    // The report exposes history as a count of stored rows plus the latest
    // observation time; it never renders a value for a date it did not observe.
    expect(Object.keys(research.platform.counts)).not.toContain("followerCount30dAgo");
  });

  it("Q10 join date — the HISTORICAL_CHANGE_STATED claim, flagged for review when stale", () => {
    const historical = research.claims.groups.find(
      (g) => g.predicate === "HISTORICAL_CHANGE_STATED",
    );
    const claim = historical?.claims[0];
    expect(claim?.value).toBe("Moved from Lisbon to Porto");
    // Past the 180-day horizon: flagged DUE_FOR_REVIEW, kept visible — stale is
    // not false, and it is never auto-retracted.
    expect(claim?.dueForReview).toBe(true);
    expect(claim?.ageDays).toBeGreaterThan(180);
  });

  it("Q11 contradictions — both sides shown with their sources, no winner", () => {
    const contradiction = research.contradictions.find((c) => c.predicate === "LOCATION_STATED");
    expect(contradiction?.values.map((v) => v.value).sort()).toEqual(["Lisbon", "Porto"]);
    expect(contradiction?.values.every((v) => v.sources.length > 0)).toBe(true);
  });

  it("Q12 anything retracted — visible as retracted with its reason, never deleted", () => {
    const retracted = research.claims.retracted.find((c) => c.value === "Ceramics");
    expect(retracted?.status).toBe("RETRACTED");
    expect(retracted?.retractionReason).toMatch(/discontinued/);
    // Retracted rows do not participate in relation labels.
    expect(retracted?.relation).toBeNull();
    expect(research.claims.totals.retracted).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // §7.3 — metric pins.
  // -------------------------------------------------------------------------

  it("§7.3 citation completeness 100% — every claim carries its kind; WEB claims their URL", () => {
    const all = [...research.claims.groups.flatMap((g) => g.claims), ...research.claims.retracted];
    expect(all.length).toBeGreaterThan(0);
    for (const claim of all) {
      expect(["OPERATOR", "WEB"]).toContain(claim.sourceKind);
      if (claim.sourceKind === "WEB") {
        expect(claim.sourceUrl).toMatch(/^https?:\/\//);
        expect(claim.sourceDomain).not.toBeNull();
        expect(claim.excerptHash).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(claim.sourceUrl).toBeNull();
      }
    }
  });

  it("§7.3 reason coverage 100% — every UNAVAILABLE section carries a non-empty reason", () => {
    let unavailableNodes = 0;
    const walk = (value: unknown, path: string[]): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...path, String(index)]));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const node = value as Record<string, unknown>;
      if (node["state"] === "UNAVAILABLE") {
        unavailableNodes += 1;
        const reason = node["reason"];
        expect(
          typeof reason === "string" && reason.length > 0,
          `${path.join(".")} states UNAVAILABLE without a reason`,
        ).toBe(true);
      }
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    };
    walk(research, []);
    // The walk must actually have met UNAVAILABLE sections or it proves nothing.
    expect(unavailableNodes).toBeGreaterThan(0);
  });

  it("§7.3 determinism — two consecutive reports are identical modulo computedAt", async () => {
    const first = await opResearch(ctx, { target: SEEDED_USERNAME });
    const second = await opResearch(ctx, { target: SEEDED_USERNAME });
    expect(second).toEqual({ ...first, computedAt: second.computedAt });
  });

  it("§7.3 dedup enforced — the exact seeded finding cannot be submitted twice", async () => {
    await expect(
      opClaimAdd(ctx, {
        target: SEEDED_USERNAME,
        predicate: "ORGANIZATION_NAME",
        value: "Aurora Print Studio",
        sourceUrl: "https://auroraprint.example.org/about",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_DUPLICATE" });
  });

  it("§7.3 no-zero-fill — never-observed figures are null or a reasoned refusal, never 0", async () => {
    // No media rows are stored for target_a: the section is null, not an
    // object of zeros pretending to be an empty account.
    expect(research.platform.media).toBeNull();
    // For an observed account, mode-absent counts are null: never read ≠ zero.
    const discovery = await opResearch(ctx, { target: DISCOVERY_USERNAME });
    expect(discovery.audience.points).toBeNull();
    expect(discovery.audience.absences).toBeNull();
    expect(discovery.changes.profileChanges).toBeNull();
    expect(discovery.changes.postChanges).toBeNull();
    expect(discovery.changes.followDeltas).toBeNull();
  });

  it("§7.3 latency P95 < 1500 ms — the report is a synchronous read, not a scrape", async () => {
    await opResearch(ctx, { target: SEEDED_USERNAME }); // warm up
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      await opResearch(ctx, { target: SEEDED_USERNAME });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1] as number;
    expect(p95).toBeLessThan(1500);
  });
});

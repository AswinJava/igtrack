import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import { createContext, providerMeta, type CliContext } from "../src/context.js";
import { CliError, display } from "../src/output.js";
import {
  opCapabilities,
  opClaimAdd,
  opClaimList,
  opClaimRetract,
  opDossier,
  opPlan,
  opResearch,
  opScanRun,
  opStatus,
  opTargetAdd,
  opWork,
  resolveTarget,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// Acceptance suite: the mission's end-to-end scenarios, numbered, over one
// freshly migrated + seeded database.
//
// EVERY row this suite touches is synthetic fixture data: the provider is the
// fixture provider, `ctx.meta.synthetic` is true, and A01 pins that so no
// reader can mistake these results for a live account observation. There is
// no live-account verification here and none is claimed.
//
// Scenarios run in order against one database (like the rest of this repo's
// integration tests) because a research session is inherently stateful: claims
// added in A11–A18 are what make A22's plan step DONE.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const OWNED = "aurora.wilde"; // the account the fixture set observes
const OBSERVED = "dune.harbor"; // the other public account the fixture can discover

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

describe.skipIf(!databaseUp)("acceptance scenarios", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;

  beforeAll(async () => {
    handle = await createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;

    ctx = await createContext();
    await opTargetAdd(ctx, { username: OWNED, localName: "Acceptance owned target" });
    await opTargetAdd(ctx, { username: OBSERVED, observed: true });
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("A01 every envelope is labelled synthetic — fixture data can never read as live", async () => {
    const status = await opStatus(ctx);
    expect(status.provider.name).toBe("fixture");
    expect(status.provider.synthetic).toBe(true);
    expect(ctx.meta.synthetic).toBe(true);
    expect(providerMeta(ctx.provider).note).toContain("Synthetic fixture data");
  });

  it("A02 absence is printed as unavailable, never as zero", async () => {
    expect(display(null)).toBe("unavailable");
    expect(display(undefined)).toBe("unavailable");
    expect(display(0)).toBe("0"); // a real zero survives; only absence is relabelled

    // Every UNAVAILABLE coverage row carries the reason it is unavailable —
    // an agent reading rows can never receive a bare gap.
    const dossier = await opDossier(ctx, { target: OWNED });
    const unavailable = dossier.coverage.filter((row) => row.state === "UNAVAILABLE");
    expect(unavailable.length).toBeGreaterThan(0);
    expect(
      unavailable.every((row) => typeof row.reason === "string" && row.reason.length > 0),
    ).toBe(true);
  });

  it("A03 an unusable provider is a configuration failure, visible on the meta and in every plan", async () => {
    const previous = process.env.IGTRACK_PROVIDER;
    process.env.IGTRACK_PROVIDER = "definitely-not-a-provider";
    const broken = await createContext();
    try {
      expect(broken.provider.provider).toBeNull();
      expect(broken.provider.error).not.toBeNull();
      expect(providerMeta(broken.provider).note).toContain("Provider is not usable");

      const plan = await opPlan(broken, { target: OWNED });
      const blocked = plan.steps.filter((step) => step.status === "BLOCKED");
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((step) => (step.reason ?? "").includes("not usable"))).toBe(true);
    } finally {
      await broken.close();
      if (previous === undefined) delete process.env.IGTRACK_PROVIDER;
      else process.env.IGTRACK_PROVIDER = previous;
    }
  });

  it("A04 the capability registry names operator submissions as the route, not a provider method", async () => {
    const report = opCapabilities();
    const research = report.capabilities.find((c) => c.id === "ACCOUNT_RESEARCH");
    expect(research?.available).toBe(true);
    // The honesty cell: available, yet with zero provider methods — the
    // operator supplies it. A capability claim this file pins against drift.
    expect(research?.providerMethods).toEqual([]);
  });

  it("A05 id, @handle and profile URL resolve to the one tracked target", async () => {
    const list = await opStatus(ctx);
    const owned = list.targets.items.find((t) => t.username === OWNED);
    expect(owned).toBeDefined();
    const byId = await resolveTarget(ctx.db, ctx.userId, owned?.id ?? "");
    const byHandle = await resolveTarget(ctx.db, ctx.userId, `@${OWNED}`);
    const byUrl = await resolveTarget(
      ctx.db,
      ctx.userId,
      `https://www.instagram.com/${OWNED}/?utm=1`,
    );
    expect(new Set([byId.id, byHandle.id, byUrl.id])).toEqual(new Set([owned?.id]));
  });

  it("A06 a URL that names no account is its own typed refusal, not a not-found", async () => {
    try {
      await resolveTarget(ctx.db, ctx.userId, "https://www.instagram.com/p/SHORTCODE/");
      expect.unreachable("a post URL must not resolve");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("TARGET_REFERENCE_INVALID");
    }
  });

  it("A07 a well-formed reference to an untracked account is TARGET_NOT_FOUND — a different answer from A06", async () => {
    await expect(resolveTarget(ctx.db, ctx.userId, "no.one.tracks.this")).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });
  });

  it("A08 recording another public account stores DISCOVERY mode, and the scan refuses at enqueue", async () => {
    const status = await opStatus(ctx);
    const observed = status.targets.items.find((t) => t.username === OBSERVED);
    expect(observed?.observationMode).toBe("DISCOVERY");

    // The kind that belongs to the other mode is refused BEFORE a job exists.
    const run = await opScanRun(ctx, { target: OBSERVED, kinds: ["PROFILE_SCAN"] });
    expect(run.enqueued).toHaveLength(0);
    expect(run.skipped[0]?.reason).toContain("only DISCOVERY_SCAN is answerable");
  });

  it("A09 an OWNED target is never asked to run DISCOVERY_SCAN", async () => {
    const run = await opScanRun(ctx, { target: OWNED, kinds: ["DISCOVERY_SCAN"] });
    expect(run.enqueued).toHaveLength(0);
    expect(run.skipped[0]?.reason).toContain("DISCOVERY_SCAN observes another account");
  });

  it("A10 a web claim stores its source URL, excerpt and hash, and reports SINGLE_SOURCE", async () => {
    const added = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceUrl: "https://alpha.example.com/about",
      excerpt: "Aurora Print Studio is a two-person printing studio.",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(added.claim.sourceKind).toBe("WEB");
    expect(added.claim.sourceDomain).toBe("alpha.example.com");
    expect(added.claim.excerpt).toContain("printing studio");
    expect(added.claim.excerptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(added.claim.relation).toBe("SINGLE_SOURCE");
  });

  it("A11 a second distinct domain is CORROBORATED — and the response itself says so", async () => {
    // Regression pin: the label is the predicate CLUSTER's label, so the
    // response to the second source must already read CORROBORATED.
    const second = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceUrl: "https://beta.example.net/studio",
    });
    expect(second.claim.relation).toBe("CORROBORATED");

    const listed = await opClaimList(ctx, { target: OWNED, predicate: "ORGANIZATION_NAME" });
    const group = listed.groups.find((g) => g.predicate === "ORGANIZATION_NAME");
    expect(group?.relation).toBe("CORROBORATED");
    expect(group?.sourceDomains).toEqual(["alpha.example.com", "beta.example.net"]);
  });

  it("A12 re-submitting the same finding is refused and names the existing claim", async () => {
    try {
      await opClaimAdd(ctx, {
        target: OWNED,
        predicate: "ORGANIZATION_NAME",
        value: "Aurora Print Studio",
        sourceUrl: "https://alpha.example.com/about",
      });
      expect.unreachable("a duplicate submission must be refused");
    } catch (err) {
      expect((err as CliError).code).toBe("CLAIM_DUPLICATE");
      expect((err as Error).message).toMatch(/claim [0-9a-f-]{36}/);
    }
  });

  it("A13 sensitive person-level predicates are refused at write time, with the reason", async () => {
    const before = await opClaimList(ctx, { target: OWNED, includeRetracted: true });
    try {
      await opClaimAdd(ctx, { target: OWNED, predicate: "job-title", value: "Barista" });
      expect.unreachable("employment predicates must be refused");
    } catch (err) {
      expect((err as CliError).code).toBe("CLAIM_PREDICATE_REFUSED");
      expect((err as Error).message).toContain("person-level sensitive data");
    }
    const after = await opClaimList(ctx, { target: OWNED, includeRetracted: true });
    expect(after.totals.active).toBe(before.totals.active); // nothing was stored
  });

  it("A14 an operator assertion is labelled as such and cannot corroborate a value", async () => {
    const operator = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "CONTACT_CHANNEL",
      value: "hello@aurora.example",
    });
    expect(operator.claim.sourceKind).toBe("OPERATOR");
    expect(operator.claim.relation).toBe("OPERATOR_ASSERTED");

    // A web source agreeing with an operator assertion is still one domain:
    // the operator's own word never counts as a second source.
    const web = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "CONTACT_CHANNEL",
      value: "hello@aurora.example",
      sourceUrl: "https://alpha.example.com/contact",
    });
    expect(web.claim.relation).toBe("SINGLE_SOURCE");
  });

  it("A15 conflicting values stay visible with both sides; nothing picks a winner", async () => {
    await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "LOCATION_STATED",
      value: "Lisbon",
      sourceUrl: "https://news.example.org/lisbon",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });
    await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "LOCATION_STATED",
      value: "Porto",
      sourceUrl: "https://blog.example.org/porto",
      retrievedAt: "2026-10-01T00:00:00.000Z",
    });
    const listed = await opClaimList(ctx, { target: OWNED, predicate: "LOCATION_STATED" });
    const group = listed.groups[0];
    expect(group?.relation).toBe("CONFLICTED");
    expect(group?.claims.map((c) => c.value).sort()).toEqual(["Lisbon", "Porto"]);
    expect(group?.claims.every((c) => c.conflicted)).toBe(true);

    const research = await opResearch(ctx, { target: OWNED });
    const contradiction = research.contradictions.find((c) => c.predicate === "LOCATION_STATED");
    expect(contradiction?.values.map((v) => v.value).sort()).toEqual(["Lisbon", "Porto"]);
  });

  it("A16 retraction demands confirmation, keeps the row readable, and leaves relation labels", async () => {
    const added = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "PRODUCT_OR_SERVICE",
      value: "Ceramics",
      sourceUrl: "https://alpha.example.com/shop",
    });
    await expect(
      opClaimRetract(ctx, { claimId: added.claim.id, reason: "discontinued", confirm: false }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });

    await opClaimRetract(ctx, {
      claimId: added.claim.id,
      reason: "Service discontinued; source page removed.",
      confirm: true,
    });
    const active = await opClaimList(ctx, { target: OWNED });
    expect(active.groups.some((g) => g.predicate === "PRODUCT_OR_SERVICE")).toBe(false);
    const withRetracted = await opClaimList(ctx, { target: OWNED, includeRetracted: true });
    const row = withRetracted.retracted.find((c) => c.id === added.claim.id);
    expect(row?.retractionReason).toContain("discontinued");
    expect(row?.relation).toBeNull();
    await expect(
      opClaimRetract(ctx, { claimId: added.claim.id, reason: "again", confirm: true }),
    ).rejects.toMatchObject({ code: "CLAIM_ALREADY_RETRACTED" });
  });

  it("A17 a claim past the 180-day review horizon is flagged, never hidden or auto-retracted", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const added = await opClaimAdd(ctx, {
      target: OWNED,
      predicate: "HISTORICAL_CHANGE_STATED",
      value: "Rebranded from an earlier name",
      sourceUrl: "https://chron.example.com/story",
      retrievedAt: old,
    });
    expect(added.claim.dueForReview).toBe(true);
    expect(added.claim.status).toBe("ACTIVE");
    const listed = await opClaimList(ctx, { target: OWNED, predicate: "HISTORICAL_CHANGE_STATED" });
    const row = listed.groups[0]?.claims.find((c) => c.id === added.claim.id);
    expect(row?.dueForReview).toBe(true);
  });

  it("A18 the research report keeps observations and claims in separate sections", async () => {
    const research = await opResearch(ctx, { target: OWNED });
    // Platform section: row counts keyed by observation kind (the raw material)
    // — never follower/following/post numbers pulled from a claim.
    expect(Object.keys(research.platform.counts)).toContain("profileSnapshots");
    expect(Object.keys(research.platform.counts)).toContain("followerSnapshots");
    expect(research.claims.totals.active).toBeGreaterThan(0);
    expect(research.claims.statement).toMatch(/not platform observations/);
    // Leads are rows that exist, and the note says nothing was researched.
    expect(research.leads.note).toMatch(/not claims/);
  });

  it("A19 research on a DISCOVERY target states connections as platform-absent with the reason", async () => {
    const research = await opResearch(ctx, { target: OBSERVED });
    expect(research.target.observationMode).toBe("DISCOVERY");
    expect(research.connections.state).toBe("UNAVAILABLE");
    expect((research.connections.reason ?? "").length).toBeGreaterThan(0);
    expect(research.connections.ranks).toEqual([]);
  });

  it("A20 the report is deterministic: two calls differ only in the computed timestamp", async () => {
    const first = await opResearch(ctx, { target: OWNED });
    const second = await opResearch(ctx, { target: OWNED });
    const strip = (r: typeof first): string =>
      JSON.stringify({ ...r, computedAt: "REDACTED" });
    const a = strip(first);
    const b = strip(second);
    if (a !== b) {
      // Locate the first divergence so a failure names the field, not "objects differ".
      const at = [...a].findIndex((ch, i) => ch !== b[i]);
      const window = (s: string): string => s.slice(Math.max(0, at - 80), at + 80);
      throw new Error(`report differs at offset ${at}: "${window(a)}" | "${window(b)}"`);
    }
  });

  it("A21 the plan refuses an unknown goal with USAGE instead of guessing one", async () => {
    await expect(opPlan(ctx, { target: OWNED, goal: "SPY" })).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("A22 plan reads stored state: discovery kinds are NOT_APPLICABLE, claims are DONE, next step is actionable", async () => {
    const plan = await opPlan(ctx, { target: OWNED });
    const steps = new Map(plan.steps.map((step) => [step.id, step]));
    expect(steps.get("observe:DISCOVERY_SCAN")?.status).toBe("NOT_APPLICABLE");
    expect(steps.get("claims:record")?.status).toBe("DONE");
    expect(steps.get("report:research")?.tool).toBe("igtrack_research");
    if (plan.nextAction !== null) {
      expect(plan.nextAction.tool).toMatch(/^igtrack_/);
      expect(plan.nextAction.because.length).toBeGreaterThan(0);
    }
  });

  it("A23 the plan is stateless: recomputation over unchanged rows is identical", async () => {
    const first = await opPlan(ctx, { target: OWNED });
    const second = await opPlan(ctx, { target: OWNED });
    expect(second.steps.map((s) => `${s.id}:${s.status}`)).toEqual(
      first.steps.map((s) => `${s.id}:${s.status}`),
    );
  });

  it("A24 goal filtering: RESEARCH keeps claims + report and one identity-grounded profile step", async () => {
    const plan = await opPlan(ctx, { target: OWNED, goal: "RESEARCH" });
    // Exactly this goal's steps: identity, one PROFILE_SCAN to ground identity,
    // the claims step and the report. No POSTS/STORY/TAG/INSIGHTS observation.
    expect(plan.steps.map((s) => s.id)).toEqual([
      "target",
      "observe:PROFILE_SCAN",
      "claims:record",
      "report:research",
    ]);
  });

  it("A25 queueing is local and execution is what observes: queue → plan PENDING → work → plan DONE", async () => {
    // The profile counts below come from a scan of the OWNED account itself.
    // The seeded demo data belongs to a different (also fictional) account,
    // and the fixture set observes exactly one account — so a scan of any
    // other target is refused rather than answered with the wrong bytes.
    await opScanRun(ctx, { target: OWNED, kinds: ["PROFILE_SCAN"] });
    const run = await opScanRun(ctx, { target: OWNED, kinds: ["STORY_SCAN"] });
    expect(run.enqueued).toHaveLength(1);
    const queued = await opPlan(ctx, { target: OWNED });
    const pending = queued.steps.find((s) => s.id === "observe:STORY_SCAN");
    expect(pending?.status).toBe("PENDING");
    expect(queued.nextAction?.tool).toBe("igtrack_work");

    const work = await opWork(ctx, { max: 20, skipScheduler: true });
    expect(work.outcomes.some((o) => o.state === "failed")).toBe(false);

    const done = await opPlan(ctx, { target: OWNED });
    expect(done.steps.find((s) => s.id === "observe:STORY_SCAN")?.status).toBe("DONE");

    // The post-work report carries the recorded counts (the renderer reads the
    // latest profile snapshot, so known data can never print "unavailable").
    const research = await opResearch(ctx, { target: OWNED });
    expect(research.platform.profile.latest?.followerCount).toBe(12480);
    expect(research.platform.profile.latest?.followingCount).toBe(312);
    expect(research.platform.profile.latest?.postCount).toBe(148);
  });

  it("A26 the dossier's researched capability counts the rows the ledger actually holds", async () => {
    const dossier = await opDossier(ctx, { target: OWNED });
    const row = dossier.coverage.find((c) => c.capability === "ACCOUNT_RESEARCH");
    expect(row?.state).toBe("OBSERVED");
    // The coverage count is ACTIVE rows only (a retracted row is withdrawn
    // evidence, counted separately in the ledger view).
    const listed = await opClaimList(ctx, { target: OWNED, includeRetracted: true });
    expect(row?.observedRows).toBe(listed.totals.active);
    expect(listed.totals.retracted).toBeGreaterThan(0);
  });
});

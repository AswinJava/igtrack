import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLAIM_PREDICATES, classifyClaimPredicate } from "@igtrack/core";
import type {
  FetchFailureKind,
  FetchResult,
  FetchSuccess,
  ResearchFetcher,
} from "@igtrack/ingestion";
import { FixtureSearchProvider, NoSearchProvider, type ResearchSearchProvider } from "@igtrack/ingestion";
import {
  createDb,
  runMigrations,
  seed,
  type DatabaseHandle,
} from "@igtrack/database";
import { createContext, type CliContext } from "../src/context.js";
import { AUDIT_HELP, auditExitCode, renderAuditHuman, runAudit } from "../src/commands/audit.js";
import { capabilityLines } from "../src/output.js";
import {
  opAudit,
  opScanRun,
  opStatus,
  opTargetAdd,
  opTargetRemove,
  opWork,
  resolveTarget,
  type AuditReport,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// Integration test for `igtrack audit` — the read-only command that unifies
// lookup/scan/work/dossier/research into one evidence-honest report.
//
// It pins the semantics the report exists to protect:
//   * configuration is checked before anything is observed, and a blocked
//     configuration is CONFIGURATION_ERROR (exit 3) — never an empty result,
//     never a silent fallback to another source;
//   * a probe that finds nothing is NOT_OBSERVED with the "not proof the
//     account does not exist" sentence, and registers no target;
//   * fixture answers are labelled SYNTHETIC, import answers IMPORTED;
//   * the human screen is the same report as the --json envelope;
//   * the audit mutates nothing: targets and queue are byte-identical after.
//
// Requires the Docker Compose test database; the suite skips loudly without it.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const OWNED_USERNAME = "aurora.wilde"; // the account the v1 fixture set knows
const DISCOVERY_USERNAME = "dune.harbor"; // discoverable through the fixture probe
const ABSENT_USERNAME = "sel_win_"; // in no fixture file: a data-set gap

const IMPORT_SAMPLE_DIR = fileURLToPath(
  new URL("../../../packages/ingestion/fixtures/import-sample", import.meta.url),
);

/** The markers a fresh `.env` ships with — set explicitly, restored exactly. */
const GRAPH_PLACEHOLDERS: Record<string, string> = {
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

/** Swap env vars in for the body of a test, restoring exactly what was there. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

/**
 * Everything but the run timestamp must match between renderings. Two separate
 * runs carry two separate `generatedAt` values, so the one timestamped line is
 * normalized before the screens are compared — nothing else is.
 */
function stripGenerated(text: string): string {
  return text.replace(/^Generated\s+\S+$/m, "Generated <timestamp>");
}

describe.skipIf(!databaseUp)("audit command", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    // Pin the owner and the provider at the test database so the repository's
    // .env can never redirect a test run at real data or real credentials.
    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;
    // Deterministic web phase: a test that wants search injects a provider
    // double; the repository's .env must never send this suite to the network.
    // `none` — not a delete: createContext() loads the repo .env, which re-fills
    // any UNSET variable (it now ships IGTRACK_RESEARCH_SEARCH_PROVIDER=auto),
    // and only an explicit non-empty value survives that.
    process.env.IGTRACK_RESEARCH_SEARCH_PROVIDER = "none";
    delete process.env.IGTRACK_RESEARCH_SEARCH_API_KEY;

    ctx = await createContext();
    await opTargetAdd(ctx, { username: OWNED_USERNAME, localName: "Fixture account" });
    await opTargetAdd(ctx, { username: DISCOVERY_USERNAME, observed: true });

    // Store real rows for both targets so the audit's read-back sections are
    // exercised against evidence, not against an empty ledger.
    await opScanRun(ctx, { target: OWNED_USERNAME });
    await opScanRun(ctx, { target: DISCOVERY_USERNAME });
    const work = await opWork(ctx, { max: 40, skipScheduler: true });
    const states = work.outcomes.map((o) => o.state);
    expect(states).not.toContain("failed");
    expect(states).not.toContain("lost");
    expect(states).not.toContain("unrecorded");
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("audits the owned account as synthetic evidence with coverage behind every stored figure", async () => {
    const before = await opStatus(ctx);
    const report = await opAudit(ctx, { username: `@${OWNED_USERNAME}` });
    const after = await opStatus(ctx);

    // Read-only by construction: same targets, same queue, same scan count.
    expect(after.targets.total).toBe(before.targets.total);
    expect(JSON.stringify(after.queue)).toBe(JSON.stringify(before.queue));
    expect(after.scans.total).toBe(before.scans.total);

    // Reference normalization: "@name" arrives as a HANDLE and normalizes.
    expect(report.requested).toBe(`@${OWNED_USERNAME}`);
    expect(report.username).toBe(OWNED_USERNAME);
    expect(report.referenceForm).toBe("HANDLE");

    // Phase 1 — local configuration, no request, honest evidence label.
    expect(report.config.state).toBe("NOT_APPLICABLE");
    expect(report.config.provider).toBe("fixture");
    expect(report.config.usable).toBe(true);
    expect(report.config.synthetic).toBe(true);
    expect(report.config.sourceKind).toBe("local");
    expect(report.config.evidence).toContain("SYNTHETIC");
    expect(report.config.readiness.networkCallMade).toBe(false);

    // Phase 2 — one stateless probe that answered.
    expect(report.probe.attempted).toBe(true);
    expect(report.probe.state).toBe("OBSERVED");
    expect(report.probe.via).toBe("resolve");
    expect(report.probe.status).toBe("AVAILABLE");
    expect(report.probe.sourceKind).toBe("local");
    expect(report.probe.businessDiscovery).toBeNull(); // a graph-only switch
    expect(report.probe.why).toContain("persists nothing");

    // Phase 3 - the stored read-back, with rows behind every observed state.
    expect(report.record.tracked).toBe(true);
    // The record is SYNTHETIC, not OBSERVED: the rows exist, but every one of
    // them is generated data, so the record is a data set's footprint and not
    // a reading of the account. "There are rows" and "the account was
    // observed" are different facts.
    expect(report.record.state).toBe("SYNTHETIC");
    expect(report.record.route?.evidenceClass).toBe("SYNTHETIC");
    expect(report.record.reason).toContain("SYNTHETIC");
    expect(report.record.reason).toContain("not a reading of this account");
    expect(report.record.target?.observationMode).toBe("OWNED");
    expect(report.record.identity?.username).toBe(OWNED_USERNAME);
    expect(report.record.route?.observingSources.every((s) => s.startsWith("fixture:"))).toBe(true);
    expect(report.record.profile).not.toBeNull();
    expect(report.record.media).not.toBeNull();
    expect(report.record.media?.storedCount).toBeGreaterThan(0);
    // Owned fixture listings carry no preview bound — a bound would be a claim.
    expect(report.record.media?.bounded).not.toBe(true);
    const totalRows = Object.values(report.record.counts).reduce((t, c) => t + c.count, 0);
    expect(totalRows).toBeGreaterThan(0);
    expect(report.record.claims?.statement.length).toBeGreaterThan(0);
    expect(report.record.firstRecordedAt).not.toBeNull();

    const coverage = report.record.coverage ?? [];
    expect(coverage.length).toBeGreaterThan(0);
    for (const row of coverage) {
      if (row.state === "OBSERVED") {
        // An observed state must have rows behind it, or it is a claim.
        expect(row.observedRows, row.capability).not.toBeNull();
        expect(row.observedRows as number).toBeGreaterThan(0);
      } else {
        expect(row.reason, `${row.capability} has no reason`).toBeTruthy();
      }
    }

    // Phase 4 — the registry's refusals travel with the report, and the next
    // steps never end in a dead end.
    const refused = capabilityLines().filter((line) => !line.available);
    expect(refused.length).toBeGreaterThan(0);
    expect(report.unsupported.map((u) => u.id).sort()).toEqual(refused.map((l) => l.id).sort());
    expect(report.limitations.some((l) => l.includes("read-only"))).toBe(true);
    expect(report.limitations.some((l) => l.includes("FOUNDING §14"))).toBe(true);
    expect(report.nextSteps.some((s) => s.action === `igtrack research ${OWNED_USERNAME}`)).toBe(
      true,
    );
    expect(report.errors).toEqual([]);
    expect(auditExitCode(report)).toBe(0);
  }, 30_000);

  it("names stale evidence instead of letting it read as current", async () => {
    // The claim fixtures (including the one past the review horizon) are
    // attached to the seed's own target — `target_a`, not the fixture account.
    const report = await opAudit(ctx, { username: "@target_a" });

    // The seed files a claim whose retrieval basis is older than the 180-day
    // review horizon. Staleness must surface as a count, a limitation and a
    // human line — never as an expiry, a retraction, a downgrade or a drop.
    expect(report.record.tracked).toBe(true);
    expect(report.record.claims).not.toBeNull();
    const claims = report.record.claims;
    if (claims === null) throw new Error("the seeded target must carry its ledger");
    expect(claims.active).toBeGreaterThan(1);
    expect(claims.dueForReview).toBeGreaterThan(0);
    expect(claims.dueForReview).toBeLessThan(claims.active);
    expect(claims.statement).toContain("not platform observations");

    const limitation = report.limitations.find((l) => l.startsWith("Stale evidence:"));
    expect(limitation).toContain("DUE_FOR_REVIEW");
    expect(limitation).toContain("kept exactly as recorded");

    const claimRow = report.summary.classes.find(
      (row) => row.evidence === "Third-party claim (stored)",
    );
    expect(claimRow?.detail).toContain("DUE_FOR_REVIEW");

    const human = renderAuditHuman(report);
    expect(human).toContain("STALE —");
    expect(human).toContain("past the 180-day review horizon");
  }, 30_000);

  it("reads the discovery target back as a bounded preview, never as the account's posts", async () => {
    const report = await opAudit(ctx, { username: `@${DISCOVERY_USERNAME}` });
    expect(report.referenceForm).toBe("HANDLE");
    expect(report.probe.state).toBe("OBSERVED");
    expect(report.probe.via).toBe("discovery");
    expect(report.record.tracked).toBe(true);
    expect(report.record.target?.observationMode).toBe("DISCOVERY");
    expect(report.record.media?.storedCount).toBe(2);
    expect(report.record.media?.bounded).toBe(true);
    expect(report.record.media?.previewLimit).toBe(12);
    // The bound and the published-vs-observed distinction travel as limitations.
    expect(report.limitations.some((l) => l.includes("bounded preview (ceiling 12 rows)"))).toBe(
      true,
    );
    expect(report.limitations.some((l) => l.includes("Business Discovery route"))).toBe(true);
    expect(report.nextSteps.some((s) => s.action === `igtrack research ${DISCOVERY_USERNAME}`)).toBe(
      true,
    );
    expect(auditExitCode(report)).toBe(0);
  }, 30_000);

  it("reports an absent account as not observed — never as non-existent — and registers nothing", async () => {
    const before = await opStatus(ctx);
    const report = await opAudit(ctx, { username: ABSENT_USERNAME });
    const after = await opStatus(ctx);

    // One probe was spent; its answer is a statement about one source.
    expect(report.probe.attempted).toBe(true);
    expect(report.probe.state).toBe("NOT_OBSERVED");
    expect(report.probe.error?.kind).toBe("ACCOUNT_NOT_FOUND");
    expect(report.probe.why).toContain("never contacts Instagram");
    expect(report.probe.why).toContain("not evidence that the account does not exist");
    expect(report.errors.some((e) => e.step === "probe" && e.code === "ACCOUNT_NOT_FOUND")).toBe(
      true,
    );

    // Nothing stored, and the reason says what that does and does not mean.
    expect(report.record.tracked).toBe(false);
    expect(report.record.state).toBe("NOT_OBSERVED");
    expect(report.record.reason).toContain("not evidence that the account does not exist");
    expect(report.record.coverage).toBeNull();

    // A failed/inconclusive probe leaves this deployment unchanged: no target,
    // no job, no scan record.
    expect(after.targets.total).toBe(before.targets.total);
    expect(JSON.stringify(after.queue)).toBe(JSON.stringify(before.queue));
    expect(after.scans.total).toBe(before.scans.total);
    await expect(resolveTarget(ctx.db, ctx.userId, ABSENT_USERNAME)).rejects.toThrow(
      /No tracked target matches/,
    );

    // Next steps point at the registry's lawful sources, not at nothing.
    expect(report.nextSteps[0]?.action).toBe("igtrack capabilities");
    // Exit 4, not 0: the report was produced, but NO observation was made.
    // A report that generates successfully is not the same thing as an
    // account that was observed, and a script must be able to tell them
    // apart without reading the report.
    expect(report.observation.observed).toBe(false);
    expect(report.observation.evidenceClass).toBe("NONE");
    expect(report.observation.statement).toContain("NO OBSERVATION");
    expect(auditExitCode(report)).toBe(4);
  }, 30_000);

  it("separates 'tracked' from 'observed' for a target that has never been scanned", async () => {
    // Registration alone stores no observation: the report must say a tracked
    // account is not an observed one, rather than implying evidence exists.
    const neverScanned = "never.scanned.here";
    await opTargetAdd(ctx, { username: neverScanned });
    try {
      const report = await opAudit(ctx, { username: neverScanned });
      expect(report.record.tracked).toBe(true);
      expect(report.record.state).toBe("NOT_OBSERVED");
      expect(report.record.reason).toContain("no scan has stored rows");
      expect(report.record.reason).toContain("a tracked account is not an observed one");
      // Coverage is the full capability table, every row honestly unobserved:
      // a registered target must not imply evidence for any capability.
      expect(report.record.coverage).not.toBeNull();
      expect(report.record.coverage!.length).toBeGreaterThan(0);
      for (const row of report.record.coverage!) {
        expect(row.state).not.toBe("OBSERVED");
        expect(row.reason).toBeTruthy();
      }
      // The source holds nothing either — one probe, honestly labelled.
      expect(report.probe.attempted).toBe(true);
      expect(report.probe.state).toBe("NOT_OBSERVED");
      // Tracked means the planner has steps to offer; no dead end.
      expect(report.nextSteps.some((s) => s.action === `igtrack research ${neverScanned}`)).toBe(
        true,
      );
      expect(report.nextSteps.length).toBeGreaterThan(0);
      // A tracked account that was never observed is still "not observed":
      // exit 4 says so, so a script cannot read a registration as evidence.
      expect(report.observation.observed).toBe(false);
      expect(auditExitCode(report)).toBe(4);
    } finally {
      // Leave the suite's target list as the other tests found it.
      await opTargetRemove(ctx, neverScanned);
    }
  }, 30_000);

  it("normalizes @handle, bare username and profile URL to one report", async () => {
    const bare = await opAudit(ctx, { username: ABSENT_USERNAME });
    const handleForm = await opAudit(ctx, { username: `@${ABSENT_USERNAME}` });
    const urlForm = await opAudit(ctx, {
      username: `https://www.instagram.com/${ABSENT_USERNAME}/`,
    });

    expect(bare.referenceForm).toBe("USERNAME");
    expect(handleForm.referenceForm).toBe("HANDLE");
    expect(urlForm.referenceForm).toBe("PROFILE_URL");
    expect(bare.requested).toBe(ABSENT_USERNAME);
    expect(handleForm.requested).toBe(`@${ABSENT_USERNAME}`);

    // Same account, same answers — only the requested spelling differs.
    for (const report of [bare, handleForm, urlForm]) {
      expect(report.username).toBe(ABSENT_USERNAME);
      expect(report.probe.state).toBe(bare.probe.state);
      expect(report.record.tracked).toBe(bare.record.tracked);
    }
  }, 30_000);

  it("rejects an invalid reference with usage exit 2 before anything is observed", async () => {
    const invalid = opAudit(ctx, { username: "not a handle!" });
    await expect(invalid).rejects.toMatchObject({ code: "USAGE", exitCode: 2 });
    // An account-less invocation is the same class of error: usage, not data.
    await expect(
      runAudit({ command: "audit", positionals: [], flags: {} }),
    ).rejects.toMatchObject({ code: "USAGE", exitCode: 2 });
  });

  it("blocks on placeholder graph configuration: no probe, no fixture fallback, exit 3", async () => {
    await withEnv(GRAPH_PLACEHOLDERS, async () => {
      const human = await captureOutput(() =>
        runAudit({ command: "audit", positionals: [ABSENT_USERNAME], flags: {} }),
      );
      const json = await captureOutput(() =>
        runAudit({ command: "audit", positionals: [ABSENT_USERNAME], flags: { json: true } }),
      );
      const parsed = JSON.parse(json.out) as { ok: boolean; data: AuditReport };
      expect(parsed.ok).toBe(true);

      const cfg = parsed.data.config;
      expect(cfg.state).toBe("CONFIGURATION_ERROR");
      expect(cfg.provider).toBe("graph");
      expect(cfg.usable).toBe(false);
      // Configuration was checked locally first, so nothing was attempted —
      // and the configured source is graph, never a silent fixture fallback.
      expect(parsed.data.probe.attempted).toBe(false);
      expect(parsed.data.probe.state).toBe("NOT_ATTEMPTED");
      expect(parsed.data.probe.why).toContain("No request was made");
      expect(parsed.data.probe.why).toContain(
        "Configuration is checked before anything is observed",
      );
      expect(parsed.data.probe.sourceKind).toBeNull();
      expect(parsed.data.probe.account).toBeNull();
      expect(parsed.data.errors[0]?.step).toBe("configuration");
      expect(parsed.data.errors[0]?.retryable).toBe(false);
      expect(parsed.data.nextSteps[0]?.action).toBe("igtrack doctor");

      // Same report on both screens, and the exit code follows from the report.
      expect(auditExitCode(parsed.data)).toBe(3);
      expect(human.code).toBe(3);
      expect(json.code).toBe(3);
      expect(stripGenerated(human.out)).toBe(
        stripGenerated(`${renderAuditHuman(parsed.data)}\n`),
      );
      // No credential value ever reaches either rendering.
      for (const value of GRAPH_PLACEHOLDER_VALUES) {
        expect(human.out).not.toContain(value);
        expect(json.out).not.toContain(value);
      }
    });
  }, 30_000);

  it("runs on the import provider and labels its evidence IMPORTED, never live", async () => {
    await withEnv(
      {
        IGTRACK_PROVIDER: "import",
        IGTRACK_IMPORT_DIR: IMPORT_SAMPLE_DIR,
        IGTRACK_IMPORT_USERNAME: "sample.owner",
      },
      async () => {
        const importCtx = await createContext();
        try {
          const report = await opAudit(importCtx, { username: "sample.owner" });
          expect(report.config.state).not.toBe("CONFIGURATION_ERROR");
          expect(report.config.provider).toBe("import");
          expect(report.config.synthetic).toBe(false);
          expect(report.config.sourceId).toBe("import:v1");
          expect(report.config.sourceKind).toBe("local");
          expect(report.config.evidence).toContain("IMPORTED");
          expect(report.config.evidence).toContain("never a live observation");

          expect(report.probe.attempted).toBe(true);
          expect(report.probe.state).toBe("OBSERVED");
          expect(report.probe.via).toBe("resolve");
          expect(report.probe.sourceKind).toBe("local");

          // The export's owner is observable but not tracked: nothing about
          // the account was registered by the probe.
          expect(report.record.tracked).toBe(false);
          expect(report.record.state).toBe("NOT_OBSERVED");
          expect(report.nextSteps[0]?.action).toBe("igtrack targets add sample.owner");
          expect(auditExitCode(report)).toBe(0);
        } finally {
          await importCtx.close();
        }
      },
    );
  }, 30_000);

  it("reports a missing export directory as CONFIGURATION_ERROR, never as empty data", async () => {
    await withEnv(
      {
        IGTRACK_PROVIDER: "import",
        IGTRACK_IMPORT_DIR: `${IMPORT_SAMPLE_DIR}/does-not-exist`,
        IGTRACK_IMPORT_USERNAME: "sample.owner",
      },
      async () => {
        const json = await captureOutput(() =>
          runAudit({ command: "audit", positionals: ["sample.owner"], flags: { json: true } }),
        );
        const parsed = JSON.parse(json.out) as { ok: boolean; data: AuditReport };
        expect(parsed.ok).toBe(true);
        expect(parsed.data.config.state).toBe("CONFIGURATION_ERROR");
        expect(parsed.data.config.error).toMatch(/IGTRACK_IMPORT_DIR|export directory not found/);
        expect(parsed.data.probe.attempted).toBe(false);
        expect(parsed.data.probe.state).toBe("NOT_ATTEMPTED");
        expect(parsed.data.errors.some((e) => e.step === "configuration")).toBe(true);
        expect(parsed.data.nextSteps[0]?.action).toBe("igtrack doctor");
        // The report is still produced; the exit code says configuration failed.
        expect(json.code).toBe(3);
        expect(auditExitCode(parsed.data)).toBe(3);
      },
    );
  }, 30_000);

  it("sends a non-retryable source failure to doctor, and the exit code says nothing was observed", async () => {
    await withEnv(
      { IGTRACK_FIXTURES_DIR: `${IMPORT_SAMPLE_DIR}/does-not-exist` },
      async () => {
        const brokenCtx = await createContext();
        try {
          const report = await opAudit(brokenCtx, { username: OWNED_USERNAME });
          // The provider CONSTRUCTS (it never reads at construction time), so
          // configuration is fine; the probe itself failed to read the source.
          expect(report.config.state).not.toBe("CONFIGURATION_ERROR");
          expect(report.config.usable).toBe(true);
          expect(report.probe.attempted).toBe(true);
          expect(report.probe.state).toBe("PROVIDER_ERROR");
          expect(report.probe.error?.kind).toBe("SOURCE_NOT_FOUND");
          expect(report.probe.error?.retryable).toBe(false);
          expect(report.errors.some((e) => e.step === "probe" && e.code === "SOURCE_NOT_FOUND")).toBe(
            true,
          );
          // A non-retryable failure has a real remedy and no dead end.
          expect(report.nextSteps[0]?.action).toBe("igtrack doctor");
          // The report is still produced, but the source answered with a
          // failure, not with an observation: exit 4 says "no observation",
          // which is the truth a script needs. (Exit 0 would have claimed
          // the account was observed.)
          expect(report.observation.observed).toBe(false);
          expect(auditExitCode(report)).toBe(4);
        } finally {
          await brokenCtx.close();
        }
      },
    );
  }, 30_000);

  it("prints exactly the report the --json envelope carries, on the fixture workflow", async () => {
    const human = await captureOutput(() =>
      runAudit({ command: "audit", positionals: [OWNED_USERNAME], flags: {} }),
    );
    const json = await captureOutput(() =>
      runAudit({ command: "audit", positionals: [OWNED_USERNAME], flags: { json: true } }),
    );
    const parsed = JSON.parse(json.out) as {
      ok: boolean;
      data: AuditReport;
      _meta: { provider: string; synthetic: boolean };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed._meta.provider).toBe("fixture");
    expect(parsed._meta.synthetic).toBe(true);
    expect(parsed.data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Same object, two renderings: everything but the run timestamp matches.
    expect(stripGenerated(human.out)).toBe(stripGenerated(`${renderAuditHuman(parsed.data)}\n`));
    expect(human.out).toContain("SYNTHETIC");
    expect(human.out).toContain("Unavailable by decision");
    expect(human.out).toContain("Next steps");

    // Exit-code parity: the report is healthy on both paths.
    expect(human.code).toBe(0);
    expect(json.code).toBe(0);
    expect(auditExitCode(parsed.data)).toBe(0);
  }, 30_000);

  it("documents its arguments, phases and exit codes in --help", () => {
    expect(AUDIT_HELP).toContain("igtrack audit <username|@handle|profile-url>");
    expect(AUDIT_HELP).toContain("--json");
    expect(AUDIT_HELP).toContain("--url URL[,URL…]");
    expect(AUDIT_HELP).toContain("queues no scan, writes no row");
    // The exit-code contract is documented, including the distinction the
    // command exists to make: a report that generated is not an account that
    // was observed.
    expect(AUDIT_HELP).toContain("Exit codes: 0 report produced AND the configured source returned an observation");
    expect(AUDIT_HELP).toContain("4 report produced but NO observation");
    expect(AUDIT_HELP).toContain("igtrack audit sel_win_");
    expect(AUDIT_HELP).toContain("NEVER");
  });

  // -------------------------------------------------------------------------
  // The public-web phase (FOUNDING §19, D70). The founder's question is about
  // an ARBITRARY handle — one this deployment has never seen and may never be
  // able to observe through the platform — so the workflow must be able to
  // read what the public web states about it without registering a target,
  // without storing anything, and without ever presenting a page's statement
  // as a platform observation. The transport is scripted; the planning,
  // gating, extraction, validation, derivation and honesty behaviour are the
  // engine's own and run for real.
  // -------------------------------------------------------------------------

  describe("public-web phase", () => {
    function ok(url: string, body: string): FetchSuccess {
      return {
        ok: true,
        finalUrl: url,
        httpStatus: 200,
        contentType: "text/html; charset=utf-8",
        body,
        byteSize: body.length,
        fetchedAt: new Date(),
        redirectsFollowed: 0,
        robotsChecked: true,
      };
    }

    function down(kind: FetchFailureKind, reason: string): FetchResult {
      return { ok: false, kind, reason, httpStatus: null, finalUrl: null };
    }

    function scripted(script: (url: string) => FetchResult): {
      fetcher: Pick<ResearchFetcher, "fetchPage">;
      calls: string[];
    } {
      const calls: string[] = [];
      const fetcher: Pick<ResearchFetcher, "fetchPage"> = {
        fetchPage: async (url: string): Promise<FetchResult> => {
          calls.push(url);
          return script(url);
        },
      };
      return { fetcher, calls };
    }

    /** A page whose claim-worthy content lives ONLY in structured fields. */
    const orgPage = (name: string, locality: string): string => `<!doctype html>
<html><head>
  <title>${name}</title>
  <script type="application/ld+json">
  {"@type":"Organization","name":"${name}","address":{"addressLocality":"${locality}","addressCountry":"GB"},"knowsAbout":"Risograph printing"}
  </script>
</head><body></body></html>`;

    const noSearch = new NoSearchProvider();

    /** Row count straight from the ledger: the probe must leave it untouched. */
    async function researchRunCount(): Promise<number> {
      const rows = (await handle.sql`select count(*)::int as n from research_runs`) as Array<{
        n: number;
      }>;
      return rows[0]?.n ?? 0;
    }

    it("reads named public pages, labels every fact a third-party statement, and stores nothing", async () => {
      const runsBefore = await researchRunCount();
      const statusBefore = await opStatus(ctx);
      const { fetcher, calls } = scripted((url) => ok(url, orgPage("Selwin Works", "Leeds")));

      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, urls: ["https://selwin.example/about"] },
        { fetcher, search: noSearch },
      );

      // The phase ran, and it says exactly what it planned and why.
      expect(report.web.attempted).toBe(true);
      expect(report.web.sourcesAvailable).toBe(true);
      expect(report.web.bounds.maxDepth).toBe(1);
      expect(report.web.bounds.enforced).toContain("depth 1");
      expect(report.web.bounds.enforced).toContain("Instagram-family hosts are refused by policy");
      expect(calls).toEqual(["https://selwin.example/about"]);

      // One document, fully evidenced: hash, bytes, retrieval time, outcome.
      expect(report.web.documents).toHaveLength(1);
      const doc = report.web.documents[0]!;
      expect(doc.outcome).toBe("FETCHED");
      expect(doc.httpStatus).toBe(200);
      expect(doc.byteSize).toBeGreaterThan(0);
      expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(doc.sourceType).toBe("OPERATOR_SUPPLIED_URL");

      // Every fact is a citation, not an observation of the account.
      expect(report.web.facts.length).toBeGreaterThan(0);
      for (const fact of report.web.facts) {
        expect(fact.provenance).toBe("PUBLIC_WEB_DOCUMENTED");
        expect(fact.sourceUrl).toBe("https://selwin.example/about");
        expect(fact.sourceDomain).toBe("selwin.example");
        expect(fact.sourceTitle).toBe("Selwin Works");
        expect(fact.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(fact.field.length).toBeGreaterThan(0);
        expect(CLAIM_PREDICATES).toContain(fact.predicate);
        expect(classifyClaimPredicate(fact.predicate).kind).toBe("ALLOWED");
      }
      expect(report.web.facts.map((f) => f.predicate)).toContain("ORGANIZATION_NAME");

      // The summary keeps the six evidence classes apart, and the inference
      // row is an absence by design.
      const classes = Object.fromEntries(
        report.summary.classes.map((row) => [row.evidence, row]),
      );
      expect(classes["Public-web statement"]?.state).toBe("OBSERVED");
      expect(classes["Platform observation"]?.state).toBe("NOT_OBSERVED");
      expect(classes["Platform observation"]?.detail).toContain("SYNTHETIC (fixture)");
      expect(classes["Inference"]?.state).toBe("NONE");
      expect(classes["Inference"]?.detail).toContain(
        "never proof that a particular person or organization operates the account",
      );
      expect(report.summary.headline).toMatch(/public-web statement\(s\) across 1 page\(s\)/);

      // The separation travels as a limitation: a page's statement is never
      // an observation, and identity is never inferred from a handle match.
      expect(
        report.limitations.some((l) => l.includes("THIRD-PARTY STATEMENTS")),
      ).toBe(true);
      expect(report.limitations.some((l) => l.includes("read-only"))).toBe(true);

      // Read-only to the byte: no run record, no target, no queued job.
      expect(await researchRunCount()).toBe(runsBefore);
      const statusAfter = await opStatus(ctx);
      expect(statusAfter.targets.total).toBe(statusBefore.targets.total);
      expect(JSON.stringify(statusAfter.queue)).toBe(JSON.stringify(statusBefore.queue));
      expect(statusAfter.scans.total).toBe(statusBefore.scans.total);
      await expect(resolveTarget(ctx.db, ctx.userId, ABSENT_USERNAME)).rejects.toThrow(
        /No tracked target matches/,
      );

      // And a fact worth keeping has a lawful next step, with its citation.
      expect(report.nextSteps.some((s) => s.action.includes("targets add sel_win_ --observed"))).toBe(
        true,
      );
      expect(report.nextSteps.some((s) => s.action.includes("claims add"))).toBe(true);
      // The web phase produced statements, but the PLATFORM produced nothing
      // for this handle: exit 4 reports that the account was not observed,
      // so a public statement is never mistaken for a platform observation.
      expect(report.observation.observed).toBe(false);
      expect(report.observation.evidenceClass).toBe("NONE");
      expect(auditExitCode(report)).toBe(4);
    }, 30_000);

    it("derives corroboration across independent sources and contradiction without picking a winner", async () => {
      // The third page also asserts two different social profiles: three URLs
      // from ONE domain are three statements, not a contradiction between
      // sources, and the label must not say otherwise (a live probe of a real
      // site tripped exactly this before the correction).
      const twoLinksPage = `${orgPage("Selwin Printing House Ltd", "Leeds").replace(
        "</body>",
        `<a href="https://x.com/selwin">X</a><a href="https://www.youtube.com/@selwin">YT</a></body>`,
      )}`;
      const { fetcher } = scripted((url) => {
        if (url.startsWith("https://a.example"))
          return ok(url, orgPage("Selwin Works", "Leeds"));
        if (url.startsWith("https://b.example"))
          return ok(url, orgPage("Selwin Works", "Leeds"));
        return ok(url, twoLinksPage);
      });

      const report = await opAudit(
        ctx,
        {
          username: ABSENT_USERNAME,
          urls: ["https://a.example/about", "https://b.example/about", "https://c.example/about"],
        },
        { fetcher, search: noSearch },
      );

      const byPredicate = Object.fromEntries(
        report.web.relations.map((relation) => [relation.predicate, relation]),
      );
      // Two independent domains state the same organization name…
      expect(byPredicate["ORGANIZATION_NAME"]?.label).toBe("CONFLICTED");
      expect(byPredicate["ORGANIZATION_NAME"]?.values).toHaveLength(2);
      // …so the third page's different name is a CONFLICT, not a correction.
      expect(byPredicate["ORGANIZATION_NAME"]?.sourceDomains).toHaveLength(3);
      // Both values are shown, in the facts, with their own citations.
      const names = report.web.facts
        .filter((fact) => fact.predicate === "ORGANIZATION_NAME")
        .map((fact) => fact.value);
      expect(names).toContain("Selwin Works");
      expect(names).toContain("Selwin Printing House Ltd");
      // Two sources agree on the location: that is corroboration, derived the
      // same way the claims ledger derives it.
      expect(byPredicate["LOCATION_STATED"]?.label).toBe("CORROBORATED");
      expect(byPredicate["LOCATION_STATED"]?.sourceDomains).toEqual([
        "a.example",
        "b.example",
        "c.example",
      ]);
      // A contradiction needs two INDEPENDENT sources. One page listing two
      // social profiles is multiple statements from one source: the differing
      // values still show, but the label is SINGLE_SOURCE, never CONFLICTED.
      expect(byPredicate["RELATED_ACCOUNT_ASSERTED"]?.label).toBe("SINGLE_SOURCE");
      expect(byPredicate["RELATED_ACCOUNT_ASSERTED"]?.values).toHaveLength(2);
      expect(byPredicate["RELATED_ACCOUNT_ASSERTED"]?.sourceDomains).toEqual(["c.example"]);
      // The refusal to choose is stated, not implied.
      expect(
        report.limitations.some((l) => l.includes("no winner is chosen")),
      ).toBe(true);
      // No numeric confidence anywhere in the report.
      expect(JSON.stringify(report.web)).not.toMatch(/"confidence"/);
    }, 30_000);

    it("refuses an Instagram-family URL with the real gate, and reports the refusal as a refusal", async () => {
      // No fetcher double: the REAL gate decides, and its host policy is
      // static, so this opens no socket. Platform data has one lawful route.
      const rejected = "not-an-absolute-url";
      const report = await opAudit(
        ctx,
        {
          username: ABSENT_USERNAME,
          urls: [`https://www.instagram.com/${ABSENT_USERNAME}/`, rejected],
        },
        { search: noSearch },
      );

      const doc = report.web.documents.find((d) => d.url.includes("instagram.com"));
      expect(doc?.outcome).toBe("BLOCKED_BY_POLICY");
      expect(doc?.outcomeReason).toContain("Instagram-family");
      // A structural refusal is SKIPPED, never a failed fetch: the request was
      // never made, so it must not inflate the failure count (D74).
      expect(report.web.totals.skipped).toBe(1);
      expect(report.web.totals.failed).toBe(0);
      expect(report.web.retrievalState).toBe("COMPLETED_PARTIAL");
      expect(report.web.outcomeClass).toBe("CANDIDATES_INACCESSIBLE");
      expect(report.web.totals.facts).toBe(0);
      expect(report.web.rejectedUrls).toHaveLength(1);
      expect(report.web.rejectedUrls[0]?.url).toBe(rejected);
      expect(report.web.rejectedUrls[0]?.reason).toContain("not an absolute http(s) URL");
      expect(report.web.notes.some((n) => n.includes("Not planned"))).toBe(true);
    }, 30_000);

    it("reports a failed document as failed — never as an absence of facts", async () => {
      const { fetcher } = scripted((url) =>
        url.includes("down.example")
          ? down("NETWORK_ERROR", "fetch failed: ECONNREFUSED 93.184.216.34:443")
          : ok(url, orgPage("Selwin Works", "Leeds")),
      );
      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, urls: ["https://down.example/about"] },
        { fetcher, search: noSearch },
      );
      expect(report.web.documents[0]?.outcome).toBe("FAILED");
      expect(report.web.totals.failed).toBe(1);
      expect(report.web.totals.fetched).toBe(0);
      expect(report.web.totals.facts).toBe(0);
      // PARTIAL coverage is reported as incomplete, never as "nothing found".
      expect(report.web.documents[0]?.outcomeReason).toContain("ECONNREFUSED");
      expect(report.summary.classes.find((c) => c.evidence === "Public-web statement")?.state).toBe(
        "NOT_OBSERVED",
      );
    }, 30_000);

    it("reports NOT_ATTEMPTED with the exact remedy when no public-web source exists", async () => {
      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { search: noSearch });
      expect(report.web.attempted).toBe(false);
      expect(report.web.sourcesAvailable).toBe(false);
      expect(report.web.documents).toEqual([]);
      expect(report.web.facts).toEqual([]);
      expect(report.web.search.provider).toBeNull();
      expect(report.web.search.unavailableReason).toContain(
        "IGTRACK_RESEARCH_SEARCH_PROVIDER",
      );
      expect(report.web.why).toContain("No public-web source was available to plan");
      expect(report.web.inferences).toContain("None.");
      expect(
        report.limitations.some((l) => l.includes("public-web phase did not run")),
      ).toBe(true);
      // The remedy is exact: name a page, or configure a provider.
      const step = report.nextSteps.find((s) => s.action.includes("--url"));
      expect(step?.action).toContain("https://example.org/about");
      expect(step?.because).toContain("IGTRACK_RESEARCH_SEARCH_API_KEY");
      expect(report.summary.classes.find((c) => c.evidence === "Public-web statement")?.state).toBe(
        "NOT_ATTEMPTED",
      );
    }, 30_000);

    it("reports a genuine zero as SEARCH_NO_RESULTS — a search that RAN, never one that did not", async () => {
      // An empty table is an ANSWER ("nothing matched"), not an absence of a
      // source: the search state must say the provider was asked and answered.
      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME },
        { search: new FixtureSearchProvider({}) },
      );
      expect(report.web.search.state).toBe("SEARCH_NO_RESULTS");
      expect(report.web.search.provider).toBe("fixture");
      expect(report.web.search.unavailableReason).toBeNull();
      // D74: the four distinct query forms, in their fixed order — the budget
      // is part of the contract, not an implementation detail.
      expect(report.web.search.queries).toEqual([
        `"${ABSENT_USERNAME}" instagram`,
        `instagram.com/${ABSENT_USERNAME}`,
        `"@${ABSENT_USERNAME}"`,
        `"${ABSENT_USERNAME}"`,
      ]);
      expect(report.web.search.perQuery).toHaveLength(4);
      expect(report.web.search.perQuery.every((entry) => entry.results === 0)).toBe(true);
      expect(report.web.outcomeClass).toBe("SEARCH_NO_CANDIDATES");
      expect(report.web.attempted).toBe(false);
      expect(report.web.retrievalState).toBe("NOT_ATTEMPTED");
      expect(report.web.why).toContain("answered all 4 query(ies) with zero results");
      // The remedy for a genuine zero is a named page — not an API key the
      // deployment already has (that is the NOT_CONFIGURED remedy's job).
      const step = report.nextSteps.find((s) => s.action.includes("--url"));
      expect(step?.because).toContain("genuine zero");
      expect(step?.because).not.toContain("IGTRACK_RESEARCH_SEARCH_API_KEY");
    }, 30_000);

    it("reports a provider that could not answer as SEARCH_FAILED — never as zero results", async () => {
      const failing: ResearchSearchProvider = {
        name: "broken",
        search: async (query) => ({
          provider: "broken",
          query,
          results: [],
          unavailableReason: null,
          error: "search provider returned HTTP 502. (upstream search error — retry with backoff)",
        }),
      };
      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { search: failing });
      expect(report.web.search.state).toBe("SEARCH_FAILED");
      expect(report.web.search.provider).toBe("broken");
      expect(report.web.search.unavailableReason).toContain("HTTP 502");
      expect(report.web.outcomeClass).toBe("SEARCH_FAILED");
      expect(report.web.search.perQuery.every((entry) => entry.error !== null)).toBe(true);
      expect(report.web.why).toContain("Search failed");
      expect(report.web.why).toContain("HTTP 502");
      expect(report.web.why).not.toContain("zero results");
      expect(report.web.retrievalState).toBe("NOT_ATTEMPTED");
      // A failure is reported as a failure: never "the account has no web presence",
      // and never dressed up as a phase that never ran either.
      expect(
        report.limitations.some((l) => l.includes("A search step RAN (SEARCH_FAILED via broken")),
      ).toBe(true);
      expect(
        report.limitations.some((l) => l.includes("never as proof that nothing exists")),
      ).toBe(true);
    }, 30_000);

    it("keeps facts only from a search page that names the handle, and gates one that does not", async () => {
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: "https://named.example/about", title: "About", snippet: null },
          { url: "https://unrelated.example/about", title: "Other", snippet: null },
        ],
      });
      const { fetcher } = scripted((url) =>
        url.startsWith("https://named.example")
          ? ok(
              url,
              // the site names itself after the handle → its org-name value
              // involves @sel_win_ and may be attributed; its locality and
              // industry do not and must be counted as not attributed.
              orgPage(`Selwin Works ${ABSENT_USERNAME}`, "Leeds").replace(
                "</body>",
                "<p>For bookings contact @sel_win_ directly.</p></body>",
              ),
            )
          : ok(url, orgPage("Unrelated Org", "Leeds")),
      );

      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { fetcher, search });

      const named = report.web.documents.find((d) => d.url.startsWith("https://named.example"));
      expect(named?.mentionsHandle).toBe(true);
      expect(named?.facts).toBeGreaterThan(0);
      // Self-identification: values that name only the SOURCE page (its
      // locality, its industry) are counted, never attributed.
      expect(named?.unattributed).toBeGreaterThan(0);
      expect(report.web.totals.unattributed).toBeGreaterThan(0);
      expect(report.web.notes.some((note) => note.includes("were NOT attributed"))).toBe(true);
      const unrelated = report.web.documents.find((d) =>
        d.url.startsWith("https://unrelated.example"),
      );
      expect(unrelated?.mentionsHandle).toBe(false);
      expect(unrelated?.facts).toBe(0);
      expect(unrelated?.discarded).toBeGreaterThan(0);
      // Only the naming page's statements became facts about the handle.
      expect(report.web.facts.every((f) => f.sourceUrl.startsWith("https://named.example"))).toBe(
        true,
      );
      expect(report.web.notes.some((n) => n.includes("never named @sel_win_"))).toBe(true);
      expect(report.web.retrievalState).toBe("COMPLETED");
      expect(report.web.outcomeClass).toBe("EVIDENCE_EXTRACTED");
      expect(report.web.totals.pagesNamingHandle).toBe(1);
    }, 30_000);

    it("never attributes a naming page's SOURCE-identity values to the handle", async () => {
      // The measured Phase-3 bug (natgeo case): a third-party article about
      // the account also describes its own publisher — og:site_name, the
      // publisher's locality, its industry. The page names the handle (so it
      // IS relevant), but those values name the SOURCE page, so zero facts
      // are attributed, and the refusal is counted and explained.
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: "https://publisher.example/article", title: `About ${ABSENT_USERNAME}`, snippet: null },
        ],
      });
      const { fetcher } = scripted((url) =>
        ok(
          url,
          orgPage("WeRSM Example", "London").replace(
            "</body>",
            `<p>The account @${ABSENT_USERNAME} broke a record.</p></body>`,
          ),
        ),
      );

      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { fetcher, search });

      const doc = report.web.documents.find((d) => d.url.startsWith("https://publisher.example"));
      expect(doc?.mentionsHandle).toBe(true);
      expect(doc?.discarded).toBe(0); // passed the page gate — this is not irrelevance
      expect(doc?.facts).toBe(0); // ...but no stored value involved the handle
      expect(doc?.unattributed).toBeGreaterThan(0);
      expect(report.web.totals.unattributed).toBeGreaterThan(0);
      expect(report.web.facts).toHaveLength(0);
      expect(report.web.outcomeClass).toBe("RELEVANT_NO_FACTS");
      expect(report.web.notes.some((n) => n.includes("were NOT attributed"))).toBe(true);
      expect(report.web.notes.some((n) => n.includes("never named @sel_win_"))).toBe(false);
    }, 30_000);

    it("lets an operator-named page through both checks — relevance and self-identification are the operator's assertion", async () => {
      // Same source-identity page as above (no value involves the handle, the
      // host does not carry it): via --url the operator asserted this page's
      // relevance, so both machine checks are bypassed — exactly like the
      // mention gate already was.
      const { fetcher } = scripted((url) => ok(url, orgPage("Selwin Works", "Leeds")));
      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, urls: ["https://selwin.example/about"] },
        { fetcher, search: noSearch },
      );
      expect(report.web.documents[0]?.facts).toBeGreaterThan(0);
      expect(report.web.totals.unattributed).toBe(0);
    }, 30_000);

    it("counts search candidates, caps the plan, and never stores a search hit as evidence", async () => {
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: "https://one.example/a", title: "One", snippet: null },
          { url: "https://two.example/b", title: "Two", snippet: null },
          { url: `https://www.instagram.com/${ABSENT_USERNAME}/`, title: "IG", snippet: null },
        ],
      });
      const { fetcher, calls } = scripted((url) => ok(url, orgPage("Selwin Works", "Leeds")));

      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, maxSources: 2 },
        { fetcher, search },
      );
      expect(report.web.search.provider).toBe("fixture");
      expect(report.web.search.queries).toHaveLength(4);
      // Per-query counts say exactly which question produced the candidates.
      expect(report.web.search.perQuery[0]).toEqual({
        query: `"${ABSENT_USERNAME}" instagram`,
        results: 3,
        error: null,
      });
      expect(report.web.search.perQuery.slice(1).every((entry) => entry.results === 0)).toBe(true);
      expect(report.web.search.candidateUrls).toBe(3);
      // The cap is enforced and REPORTED: one candidate was not fetched.
      expect(report.web.totals.planned).toBe(2);
      expect(report.web.bounds.documentsTruncated).toBe(1);
      expect(report.web.notes.some((n) => n.includes("capped at 2"))).toBe(true);
      // A truncated pass is PARTIAL coverage — reported as such, never as a
      // clean "nothing was skipped".
      expect(report.web.retrievalState).toBe("COMPLETED_PARTIAL");
      // Every planned document came from search, and none of them was stored.
      expect(calls).toEqual(["https://one.example/a", "https://two.example/b"]);
      expect(report.web.documents.every((d) => d.sourceType === "SEARCH_RESULT")).toBe(true);
      expect(await researchRunCount()).toBe(0);
    }, 30_000);

    it("deduplicates a tracking-variant and its canonical URL into one candidate", async () => {
      // The same page reached through campaign parameters and through a
      // trailing slash is ONE candidate: the budget must not be spent twice
      // on a page we have already planned.
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: "https://one.example/a?utm_source=news&utm_medium=feed", title: "One", snippet: null },
        ],
        '"sel_win_"': [{ url: "https://one.example/a/", title: "One again", snippet: null }],
      });
      const { fetcher, calls } = scripted((url) => ok(url, orgPage("Selwin Works", "Leeds")));

      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { fetcher, search });

      expect(report.web.search.candidateUrls).toBe(1);
      expect(report.web.totals.planned).toBe(1);
      expect(calls).toEqual(["https://one.example/a"]);
      expect(report.web.candidates.map((c) => c.url)).toEqual(["https://one.example/a"]);
    }, 30_000);

    it("spends a tight document budget on the candidate whose summary names the handle", async () => {
      // Explainable ranking: the title that names the handle outranks a
      // provider-order result that matches nothing, so the single available
      // slot goes to the page that can actually pass the gate.
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: "https://noise.example/blog", title: "Wine tips for 2026", snippet: "best wine picks" },
          { url: "https://named.example/profile", title: `Contact ${ABSENT_USERNAME}`, snippet: null },
        ],
      });
      const { fetcher, calls } = scripted((url) =>
        url.startsWith("https://named.example")
          ? ok(
              url,
              orgPage(`Selwin Works ${ABSENT_USERNAME}`, "Leeds").replace(
                "</body>",
                `<p>Bookings via @${ABSENT_USERNAME}.</p></body>`,
              ),
            )
          : ok(url, orgPage("Unrelated Org", "Leeds")),
      );

      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, maxSources: 1 },
        { fetcher, search },
      );

      expect(calls).toEqual(["https://named.example/profile"]);
      expect(report.web.bounds.documentsTruncated).toBe(1);
      expect(report.web.totals.pagesNamingHandle).toBe(1);
      expect(report.web.outcomeClass).toBe("EVIDENCE_EXTRACTED");
      expect(report.web.candidates.find((c) => c.url.includes("named.example"))?.reason).toContain(
        "title names the exact handle",
      );
      expect(report.web.candidates.find((c) => c.url.includes("noise.example"))?.disposition).toBe(
        "NOT_FETCHED",
      );
      // The human screen carries the same diagnosis, not just the counts.
      const human = renderAuditHuman(report);
      expect(human).toContain("Queries issued");
      expect(human).toContain("Candidates (why each ranked");
      expect(human).toContain("EVIDENCE_EXTRACTED");
    }, 30_000);

    it("never lets a similar username pass for the exact handle — near-miss is a candidate, not a match", async () => {
      // `sel_win` without the trailing underscore is a DIFFERENT identifier.
      // It may be reported as a page that did not match; it may never supply
      // a fact about @sel_win_.
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          {
            url: "https://mirror.example/u/selwin",
            title: "sel_win profile mirror",
            snippet: "latest posts by sel_win",
          },
        ],
      });
      const { fetcher } = scripted((url) =>
        ok(
          url,
          orgPage("Selwin Works", "Leads").replace(
            "</body>",
            "<p>Archived posts from sel_win, an unrelated account.</p></body>",
          ),
        ),
      );

      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { fetcher, search });

      expect(report.web.search.relevantCandidates).toBe(0);
      const doc = report.web.documents[0];
      expect(doc?.mentionsHandle).toBe(false);
      expect(doc?.facts).toBe(0);
      expect(doc?.discarded).toBeGreaterThan(0);
      expect(report.web.totals.pagesNamingHandle).toBe(0);
      expect(report.web.outcomeClass).toBe("PAGES_IRRELEVANT");
      expect(report.web.facts).toEqual([]);
      // The remedy names weak COVERAGE of one index — never "evidence does
      // not exist" (a zero result is not a verdict).
      const step = report.nextSteps.find((s) => s.action.includes("--url"));
      expect(step?.because).toContain("WEAK COVERAGE");
      expect(step?.because).toContain("not proof that no public evidence exists");
    }, 30_000);

    it("counts a search-sourced policy refusal as skipped — a structural limit, never a failed fetch", async () => {
      // No fetcher double: the REAL gate decides, and its host policy is
      // static, so this opens no socket. The candidate is still reported —
      // ordered last, dispositioned SKIPPED_BY_POLICY — and the run must not
      // read as "the network failed".
      const search = new FixtureSearchProvider({
        '"sel_win_" instagram': [
          { url: `https://www.instagram.com/${ABSENT_USERNAME}`, title: "IG", snippet: null },
        ],
      });

      const report = await opAudit(ctx, { username: ABSENT_USERNAME }, { search });

      expect(report.web.totals.planned).toBe(1);
      expect(report.web.totals.skipped).toBe(1);
      expect(report.web.totals.failed).toBe(0);
      expect(report.web.retrievalState).toBe("COMPLETED_PARTIAL");
      expect(report.web.outcomeClass).toBe("CANDIDATES_INACCESSIBLE");
      expect(report.web.candidates[0]?.disposition).toBe("SKIPPED_BY_POLICY");
      expect(report.web.candidates[0]?.reason).toContain("policy");
      expect(
        report.web.notes.some((n) => n.includes("refused by policy before any request was made")),
      ).toBe(true);
      expect(
        report.limitations.some((l) => l.includes("refused by policy without a request")),
      ).toBe(true);
      // The sparse-result next step points at widening coverage, not at a key.
      const step = report.nextSteps.find((s) => s.action.includes("--url"));
      expect(step?.because).toContain("policy-skipped");
      expect(step?.because).toContain("nothing here describes the handle");
    }, 30_000);

    it("never proposes a sensitive predicate a page tries to smuggle in", async () => {
      const personPage = `<html><head>
        <title>Mira Lane</title>
        <script type="application/ld+json">{"@type":"Person","name":"Mira Lane","jobTitle":"Founder","email":"mira@selwin.example"}</script>
        </head><body><p>Member of the Green party; awaiting medical results.</p></body></html>`;
      const { fetcher } = scripted((url) => ok(url, personPage));
      const report = await opAudit(
        ctx,
        { username: ABSENT_USERNAME, urls: ["https://person.example/page"] },
        { fetcher, search: noSearch },
      );
      for (const fact of report.web.facts) {
        expect(fact.value).not.toMatch(/IGNORE ALL|Green party|medical|CEO/i);
        expect(classifyClaimPredicate(fact.predicate).kind).toBe("ALLOWED");
      }
      expect(report.web.facts.some((f) => f.predicate === "EMPLOYMENT_STATUS")).toBe(false);
      expect(report.web.facts.some((f) => f.predicate === "POLITICAL_AFFILIATION")).toBe(false);
    }, 30_000);

    it("reports a broken search-provider configuration as CONFIGURATION_ERROR — exit 3, not 'no sources'", async () => {
      await withEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "not-a-provider" }, async () => {
        // No double injected: the environment decides, exactly as a real run.
        const json = await captureOutput(() =>
          runAudit({
            command: "audit",
            positionals: [ABSENT_USERNAME],
            flags: { json: true },
          }),
        );
        const parsed = JSON.parse(json.out) as { ok: boolean; data: AuditReport };
        expect(parsed.ok).toBe(true);
        expect(parsed.data.web.attempted).toBe(false);
        expect(parsed.data.web.search.unavailableReason).toContain("not-a-provider");
        expect(parsed.data.errors.some((e) => e.step === "web" && e.code === "CONFIGURATION_ERROR")).toBe(
          true,
        );
        // A variable that is WRONG is a configuration failure, not an absence
        // of public-web sources (invariant 7).
        expect(auditExitCode(parsed.data)).toBe(3);
        expect(json.code).toBe(3);
      });
    }, 30_000);

    it("renders the same web section on the human screen as in the JSON envelope", async () => {
      const { fetcher } = scripted((url) => ok(url, orgPage("Selwin Works", "Leeds")));
      const captured = await captureOutput(async () => {
        const report = await opAudit(
          ctx,
          { username: ABSENT_USERNAME, urls: ["https://selwin.example/about"] },
          { fetcher, search: noSearch },
        );
        const human = renderAuditHuman(report);
        expect(human).toContain("Summary (one row per evidence class");
        expect(human).toContain("Public web (bounded, read-only probe");
        expect(human).toContain("Facts (what a source STATES");
        expect(human).toContain("Corroboration and contradiction");
        expect(human).toContain("ORGANIZATION_NAME");
        expect(human).toContain("sha256 ");
        expect(human).toContain("selwin.example");
        // Never mistyped as an observation of the account.
        expect(human).toContain("never platform observations, never stored");
        return 0;
      });
      expect(captured.code).toBe(0);
    }, 30_000);
  });

  it("carries the STALE label when the stored evidence behind a plan step is older than its cadence", async () => {
    // Runs last: it backdates the owned target's successful PROFILE_SCAN so the
    // planner must call the step STALE, and the audit must carry that word —
    // a stale observation shown as an ordinary recommendation is exactly the
    // confusion this report exists to prevent.
    await handle.sql.unsafe(
      `UPDATE monitoring_jobs SET completed_at = now() - interval '30 days' WHERE kind = 'PROFILE_SCAN' AND status = 'succeeded'`,
    );
    const report = await opAudit(ctx, { username: `@${OWNED_USERNAME}` });
    const stale = report.nextSteps.find((step) => step.because.startsWith("STALE —"));
    expect(stale).toBeDefined();
    expect(stale?.because).toContain("cadence");
    // The stale row is still a row: staleness labels evidence, it never drops it.
    expect(report.record.state).toBe("SYNTHETIC");
  }, 30_000);
});

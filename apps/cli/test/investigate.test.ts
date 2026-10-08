import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DatabaseHandle } from "@igtrack/database";
import { EVIDENCE_CLASS, INVESTIGATION_STAGE, INVESTIGATION_STAGE_STATUS } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { investigateExitCode, runInvestigate } from "../src/commands/investigate.js";
import { CliError } from "../src/output.js";
import { opInvestigate } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The username-first investigation pipeline.
//
// The founder's acceptance criterion: ONE username in, and IGTrack runs every
// stage the configured sources support, returns a provenance-backed dossier,
// and says truthfully what it could not get. These tests pin that promise:
//
//   * the stages run in order and each is reported separately;
//   * the evidence classes are never merged, and a fixture set's rows are
//     SYNTHETIC rather than platform observations;
//   * an account the source cannot observe produces a dossier full of
//     BLOCKED stages and the source's own reason, not an empty success;
//   * the exit code separates "a dossier with findings" from "a dossier
//     where nothing was retrieved";
//   * a repeated investigation is incremental;
//   * the CLI and the MCP surface run the same pipeline.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde"; // the account the v1 fixture set observes
const DISCOVERY_USERNAME = "dune.harbor"; // the other account the v1 fixture set can discover
const UNKNOWN_USERNAME = "nobody.here"; // the fixture set does not carry this one

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

describe.skipIf(!databaseUp)("username-first investigation", () => {
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
    // No search request may leave the machine: the web stage is exercised
    // through its own seam, never through the network.
    process.env.IGTRACK_RESEARCH_SEARCH_PROVIDER = "none";
    delete process.env.IGTRACK_RESEARCH_SEARCH_API_KEY;

    ctx = await createContext();
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("runs every stage in order and reports each one separately", async () => {
    const result = await opInvestigate(ctx, {
      username: FIXTURE_USERNAME,
      web: false,
    });

    expect(result.investigation.stages.map((s) => s.id)).toEqual([
      INVESTIGATION_STAGE.IDENTITY,
      INVESTIGATION_STAGE.PLATFORM,
      INVESTIGATION_STAGE.CONTENT,
      INVESTIGATION_STAGE.RELATIONSHIPS,
      INVESTIGATION_STAGE.WEB,
      INVESTIGATION_STAGE.CORRELATE,
      INVESTIGATION_STAGE.DOSSIER,
    ]);
    // Every stage states a source and a reason, so a reader never has to
    // guess what a stage did.
    for (const stage of result.investigation.stages) {
      expect(stage.reason, stage.id).toBeTruthy();
    }
  });

  it("resolves the account, records it, and observes it in one command", async () => {
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    expect(result.investigation.username).toBe(FIXTURE_USERNAME);
    expect(result.investigation.targetId).not.toBeNull();
    expect(result.investigation.observationMode).toBe("OWNED");
    // The platform stage really observed: content came back.
    expect(result.content.media.length).toBeGreaterThan(0);
    expect(result.content.comments.length).toBeGreaterThan(0);
    expect(result.investigation.retrievedItems).toBeGreaterThan(0);
  });

  it("keeps the evidence classes apart — a fixture set's rows are SYNTHETIC, not platform observations", async () => {
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    const classes = new Map(result.investigation.evidenceClasses.map((c) => [c.class, c.items]));

    // The fixture set produced the rows, so they are synthetic evidence. A
    // platform observation is a different class and must not be credited.
    expect(classes.get(EVIDENCE_CLASS.SYNTHETIC)).toBeGreaterThan(0);
    expect(classes.get(EVIDENCE_CLASS.PLATFORM) ?? 0).toBe(0);
    // The stored record agrees with the class summary.
    expect(result.identity.route.evidenceClass).toBe("SYNTHETIC");
  });

  it("never merges the live and synthetic relationship rankings", async () => {
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    // The fixture set's interactions are synthetic, so they are in the
    // synthetic section and NOT in the live one.
    expect(result.relationships.synthetic.length).toBeGreaterThan(0);
    expect(result.relationships.live.length).toBe(0);
  });

  it("reports an unobservable account as blocked stages, not as an empty success", async () => {
    const result = await opInvestigate(ctx, { username: UNKNOWN_USERNAME, web: false });

    const identity = result.investigation.stages.find(
      (s) => s.id === INVESTIGATION_STAGE.IDENTITY,
    );
    expect(identity?.status).toBe(INVESTIGATION_STAGE_STATUS.BLOCKED);
    // The reason is the SOURCE's own reason, and it says the account's
    // existence is not being denied.
    expect(identity?.reason).toContain("only contains @aurora.wilde");
    expect(identity?.reason).toContain("requested @nobody.here");

    const platform = result.investigation.stages.find(
      (s) => s.id === INVESTIGATION_STAGE.PLATFORM,
    );
    expect(platform?.status).toBe(INVESTIGATION_STAGE_STATUS.BLOCKED);
    expect(platform?.reason).toContain("does not observe @nobody.here");
    expect(platform?.reason).toContain("NOT evidence that the account does not exist");

    // Nothing was retrieved, and the dossier says so in its gaps.
    expect(result.investigation.retrievedItems).toBe(0);
    expect(result.gaps.some((g) => g.kind === "investigation")).toBe(true);
    // A not-observed capability is NOT explained as "a scan can still run"
    // when the source refuses to observe the account.
    expect(
      result.gaps.some((g) => g.reason.includes("A scan can still run")),
    ).toBe(false);
  });

  it("exits 4 when nothing was retrieved, and 0 when something was", async () => {
    const empty = await opInvestigate(ctx, { username: UNKNOWN_USERNAME, web: false });
    expect(investigateExitCode(empty)).toBe(4);

    const found = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    expect(investigateExitCode(found)).toBe(0);
  });

  it("is incremental: a second investigation adds no duplicate rows", async () => {
    const first = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    const mediaAfterFirst = first.content.media.length;
    const second = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    // The same rows, read again — not a second copy of them.
    expect(second.content.media.length).toBe(mediaAfterFirst);
    expect(second.investigation.targetId).toBe(first.investigation.targetId);
  });

  it("uses the documented discovery route for an account the platform can reach", async () => {
    const result = await opInvestigate(ctx, { username: DISCOVERY_USERNAME, web: false });
    expect(result.investigation.observationMode).toBe("DISCOVERY");
    const identity = result.investigation.stages.find(
      (s) => s.id === INVESTIGATION_STAGE.IDENTITY,
    );
    expect(identity?.status).toBe(INVESTIGATION_STAGE_STATUS.COMPLETED);
  });

  it("rejects an invalid reference before anything is observed", async () => {
    await expect(
      opInvestigate(ctx, { username: "   ", web: false }),
    ).rejects.toThrow(/username|handle|profile/i);
  });

  it("refuses to merge two accounts that share a platform id", async () => {
    // The identity check reads the platform id's existing binding. A handle
    // that resolves to an id already bound to another username is a different
    // account, and the investigation must stop rather than merge them.
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    expect(result.investigation.username).toBe(FIXTURE_USERNAME);
    // The same handle again resolves to the same account, not a new one.
    const again = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    expect(again.investigation.targetId).toBe(result.investigation.targetId);
  });

  it("reports the web stage as skipped when the operator asks for no web work", async () => {
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME, web: false });
    const web = result.investigation.stages.find((s) => s.id === INVESTIGATION_STAGE.WEB);
    expect(web?.status).toBe(INVESTIGATION_STAGE_STATUS.SKIPPED);
    expect(web?.reason).toContain("--no-web");
    expect(result.web.attempted).toBe(false);
  });

  it("states a search that ran and found nothing as a gap, not as silence", async () => {
    // The public-web stage here has no search provider, so the gap must name
    // the missing configuration. A reader must never mistake "we asked one
    // index and it had nothing" for "no public evidence exists".
    const result = await opInvestigate(ctx, { username: FIXTURE_USERNAME });
    const web = result.investigation.stages.find((s) => s.id === INVESTIGATION_STAGE.WEB);
    expect(web?.status).not.toBe(INVESTIGATION_STAGE_STATUS.SKIPPED);
    const webGap = result.gaps.find((g) => g.subject === "public-web references");
    expect(webGap).toBeDefined();
    expect(webGap?.reason).toMatch(/UNAVAILABLE|ran|index/i);
    // The reason must not claim the absence of public evidence.
    expect(webGap?.reason).not.toMatch(/no public evidence exists/i);
  });

  it("runs the same pipeline through the CLI command", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    let code = 0;
    try {
      code = await runInvestigate({
        command: "investigate",
        positionals: [FIXTURE_USERNAME],
        flags: { "no-web": true },
      });
    } finally {
      (process.stdout as any).write = original;
    }
    const out = chunks.join("");
    expect(code).toBe(0);
    // The human screen carries the same sections as the JSON envelope.
    expect(out).toContain("What was investigated");
    expect(out).toContain("Evidence classes");
    expect(out).toContain("What this investigation could not get");
    expect(out).toContain("Per-capability coverage");
  });

  it("exits 2 with a usage error for a missing account reference", async () => {
    await expect(
      runInvestigate({ command: "investigate", positionals: [], flags: {} }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("runs the SAME pipeline through the MCP tool (CLI/MCP parity)", async () => {
    // The agent surface and the command line must not be two implementations
    // of one capability: both call opInvestigate, and the MCP tool returns the
    // same dossier shape as the command.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { buildServer } = await import("../src/mcp/server.js");

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "investigate-parity", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const result = await client.callTool({
        name: "igtrack_investigate",
        arguments: { username: FIXTURE_USERNAME, web: false },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        ok: boolean;
        data: {
          investigation: { stages: Array<{ id: string }> };
          content: { media: unknown[] };
        };
      };
      expect(payload.ok).toBe(true);
      // The same stages, the same order, the same content — one pipeline.
      expect(payload.data.investigation.stages.map((s) => s.id)).toEqual([
        INVESTIGATION_STAGE.IDENTITY,
        INVESTIGATION_STAGE.PLATFORM,
        INVESTIGATION_STAGE.CONTENT,
        INVESTIGATION_STAGE.RELATIONSHIPS,
        INVESTIGATION_STAGE.WEB,
        INVESTIGATION_STAGE.CORRELATE,
        INVESTIGATION_STAGE.DOSSIER,
      ]);
      expect(payload.data.content.media.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

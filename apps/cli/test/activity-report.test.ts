import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDb,
  runMigrations,
  seed,
  type DatabaseHandle,
} from "@igtrack/database";
import type { ActivityReport } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { CliError, UsageError } from "../src/output.js";
import { buildServer, closeServerContext } from "../src/mcp/server.js";
import {
  opActivityReport,
  opScanRun,
  opTargetAdd,
  opWork,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// The Activity Report surface over real stored rows. The fixture account
// replays an August 2026 timeline, so a report selected with --at 2026-08-26
// must read that month, never today's empty ledger. What is pinned here is the
// published contract (data types, tab order, ids, inventory accounting, MCP
// parity) and the negative contract (a metric with no lawful source is null +
// UNAVAILABLE), not the fixture's prose.
//
// Requires the Docker Compose test database; skipped (not passed vacuously)
// when it is unavailable.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde";
const UNSCANNED_USERNAME = "quiet.account";
const AUGUST_AT = "2026-08-26";

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

describe.skipIf(!databaseUp)("activity report surfaces", () => {
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
    await closeServerContext();
    await ctx?.close();
    await handle?.close();
  });

  it("composes the four tabs for the selected August month", async () => {
    const result = await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const report = result.report;

    expect(result.period).toBe("monthly");
    expect(report.feature).toBe("igtrack.activity-report");
    expect(report.data_type).toBe("MONTH");
    expect(report.begin_time).toBe("2026-08-01T00:00:00.000Z");
    expect(report.end_time).toBe("2026-09-01T00:00:00.000Z");
    expect(report.data_id).toBe(
      `igtrack:${result.target.id}:monthly:2026-08-01T00:00:00.000Z`,
    );
    expect(report.report_id).toBe(
      `igtrack-report:${result.target.id}:monthly:2026-08-01T00:00:00.000Z`,
    );

    // The four tabs exist in the audited order; reordering them is a contract
    // change for anything reading the JSON.
    expect(Object.keys(report.tabs)).toEqual([
      "activity_analytics",
      "ties_and_trails",
      "stories_highlights",
      "ai_insights",
    ]);

    // Stored August rows make the period delivered, never the configured
    // provider's promises or a generated document.
    expect(report.has_data).toBe(true);
    expect(report.period_state).toBe("DELIVERED");
    expect(report.tabs.activity_analytics.post_num.value).toBe(2);
    expect(report.tabs.activity_analytics.post_num.state).toBe("DERIVED");

    // Absent metrics carry the registry reason, not a zero.
    expect(report.tabs.activity_analytics.like_num.value).toBeNull();
    expect(report.tabs.activity_analytics.like_num.state).toBe("UNAVAILABLE");
    expect(report.tabs.activity_analytics.like_num.reason).not.toBeNull();
    expect(report.tabs.activity_analytics.like_user_num.value).toBeNull();
    expect(report.tabs.ai_insights).toMatchObject({
      has_insights: false,
      state: "UNAVAILABLE",
    });
    expect(report.tabs.ai_insights.reason.length).toBeGreaterThan(0);

    expect(report.evidence.evidenceClass).toBe("SYNTHETIC");
    expect(report.evidence.synthetic).toBe(true);
    expect(report.evidence.sourceIds).toEqual(["fixture:v1"]);
    expect(result.markdown).toContain("SYNTHETIC");
    expect(result.markdown).toContain("AI Insights");
  });

  it("lists the period inventory with badges, delivered count and exact commands", async () => {
    const result = await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const report = result.report;

    const august = report.periods.find((entry) => entry.begin_time === report.begin_time);
    expect(august).toBeDefined();
    expect(august?.selected).toBe(true);
    expect(august?.state).toBe("DELIVERED");
    expect(august?.badge).toBe("Monthly Report");
    expect(august?.data_id).toBe(report.data_id);
    expect(august?.command).toBe(
      `igtrack activity-report @${FIXTURE_USERNAME} --period monthly --at 2026-08-01`,
    );

    // reports_delivered is the count of non-daily periods that closed with
    // stored activity, not the number of generated documents.
    const delivered = report.periods.filter(
      (entry) => entry.data_type !== "DAILY" && entry.has_data,
    ).length;
    expect(report.reports_delivered).toBe(delivered);
    expect(report.reports_delivered).toBeGreaterThan(0);
    expect(report.periods.every((entry) => entry.data_type === "MONTH")).toBe(true);
    expect(report.periods_note).toBe(result.inventoryNote);
  });

  it("selects an exact period by data_id and refuses foreign or conflicting ids", async () => {
    const selected = await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const byId = await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      dataId: selected.report.data_id,
    });
    expect(byId.period).toBe("monthly");
    expect(byId.window.start).toBe(selected.report.begin_time);
    expect(byId.report.data_id).toBe(selected.report.data_id);

    await expect(
      opActivityReport(ctx, {
        target: FIXTURE_USERNAME,
        dataId: "igtrack:someone-else:monthly:2026-08-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UsageError);

    await expect(
      opActivityReport(ctx, {
        target: FIXTURE_USERNAME,
        dataId: selected.report.data_id,
        period: "weekly",
      }),
    ).rejects.toThrow(/does not start on a .* boundary|--period asked for/);

    await expect(
      opActivityReport(ctx, {
        target: FIXTURE_USERNAME,
        dataId: "igtrack:malformed",
      }),
    ).rejects.toThrow(/does not belong to this target/);
  });

  it("is read-only: composing a report writes no job or evidence row", async () => {
    const jobsBefore = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM monitoring_jobs
    `;
    const evidenceBefore = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const jobsAfter = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM monitoring_jobs
    `;
    const evidenceAfter = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    expect(jobsAfter[0]!.n).toBe(jobsBefore[0]!.n);
    expect(evidenceAfter[0]!.n).toBe(evidenceBefore[0]!.n);
  });

  it("refuses an unscanned target and an unknown target without fabricating a report", async () => {
    const quiet = await opActivityReport(ctx, {
      target: UNSCANNED_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    expect(quiet.report.has_data).toBe(false);
    expect(quiet.report.period_state).toBe("EMPTY");
    expect(quiet.report.evidence.evidenceClass).toBe("NONE");
    expect(quiet.report.reports_delivered).toBe(0);
    // Unreadable is not zero: the metric keeps its refusal and reason.
    expect(quiet.report.tabs.activity_analytics.like_num.value).toBeNull();
    expect(quiet.report.tabs.activity_analytics.like_num.state).toBe("UNAVAILABLE");

    await expect(
      opActivityReport(ctx, { target: "not.tracked.anywhere", period: "monthly" }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("returns the same report through MCP as the CLI operation", async () => {
    const direct = await opActivityReport(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activity-report-test", version: "1.0.0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "igtrack_activity_report",
        arguments: { target: FIXTURE_USERNAME, period: "monthly", at: AUGUST_AT },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        ok: boolean;
        data: { report: ActivityReport; markdown: string };
        _meta: { synthetic: boolean; provider: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.report.data_id).toBe(direct.report.data_id);
      expect(payload.data.report.tabs.activity_analytics.post_num.value).toBe(2);
      expect(Object.keys(payload.data.report.tabs)).toEqual(Object.keys(direct.report.tabs));
      expect(payload.data.report.tabs.ai_insights.state).toBe("UNAVAILABLE");
      expect(payload._meta.synthetic).toBe(true);
      expect(payload._meta.provider).toBe("fixture");
    } finally {
      await client.close();
      await closeServerContext();
    }
  });
});

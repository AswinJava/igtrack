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
import type { TrackerCard } from "@igtrack/core";
import { createContext, type CliContext } from "../src/context.js";
import { UsageError } from "../src/output.js";
import { buildServer, closeServerContext } from "../src/mcp/server.js";
import {
  opScanRun,
  opTargetAdd,
  opTracker,
  opWork,
} from "../src/tools.js";

// ---------------------------------------------------------------------------
// The tracker surface over real stored rows. It composes the same ledger as
// igtrack activity-report, so the contract pinned here is the watchlist shape
// (one card per account, latest closed window by default, explicit --at
// windows) plus the negative contract: a metric no source measured is null +
// UNAVAILABLE with its reason, never zero. Fixture rows replay August 2026.
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

describe.skipIf(!databaseUp)("tracker surfaces", () => {
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

  it("builds the August card from stored rows with measured counts", async () => {
    const result = await opTracker(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    expect(result.mode).toBe("target");
    expect(result.period).toBe("monthly");
    expect(result.window.start).toBe("2026-08-01T00:00:00.000Z");
    expect(result.window.end).toBe("2026-09-01T00:00:00.000Z");

    const card = result.card as TrackerCard;
    expect(card).not.toBeNull();
    expect(card.feature).toBe("igtrack.tracker");
    expect(card.mode).toBe("target");
    expect(card.target.username).toBe(FIXTURE_USERNAME);
    expect(card.period.data_type).toBe("MONTH");
    expect(card.period.badge).toBe("Monthly Report");
    expect(card.period.state).toBe("DELIVERED");
    expect(card.period.has_data).toBe(true);
    expect(card.period.provisional).toBe(false);
    expect(card.period.data_id).toBe(
      `igtrack:${card.target.id}:monthly:2026-08-01T00:00:00.000Z`,
    );
    expect(card.period.report_id).toBe(
      `igtrack-report:${card.target.id}:monthly:2026-08-01T00:00:00.000Z`,
    );

    // Counts are the stored August rows, identical to activity-report.
    expect(card.kpis.posts).toMatchObject({ value: 2, state: "DERIVED" });
    expect(card.kpis.stories).toMatchObject({ value: 3, state: "DERIVED" });
    expect(card.kpis.comments).toMatchObject({ value: 3, state: "DERIVED" });
    expect(card.kpis.tags).toMatchObject({ value: 2, state: "DERIVED" });
    expect(card.kpis.mentions).toMatchObject({ value: 4, state: "DERIVED" });
    expect(card.kpis.posts.evidenceCount).toBe(2);

    // No COMPLETE following roster was compared in this window: a null with a
    // reason, not a zero that would read as "nobody followed".
    for (const key of ["new_followings", "un_follows"] as const) {
      expect(card.kpis[key].value).toBeNull();
      expect(card.kpis[key].state).toBe("UNAVAILABLE");
      expect(card.kpis[key].reason).toBeTruthy();
      expect(card[key].state).toBe("UNAVAILABLE");
      expect(card[key].rows).toEqual([]);
    }

    // Refused families keep registry reasons and never become empty lists.
    for (const key of ["accounts_liked", "highlights", "verified_follows"] as const) {
      expect(card.kpis[key].value).toBeNull();
      expect(card.kpis[key].state).toBe("UNAVAILABLE");
      expect(card.kpis[key].reason).toBeTruthy();
    }
    expect(card.ai_insights).toMatchObject({
      has_insights: false,
      state: "UNAVAILABLE",
      sub_type: "NOT_APPLICABLE",
    });
    expect(card.ai_insights.reason.length).toBeGreaterThan(0);

    expect(card.refusals.map((refusal) => refusal.capability)).toEqual([
      "ACCOUNTS_LIKED",
      "HIGHLIGHTS",
      "VERIFIED_FOLLOWS",
      "AI_INSIGHTS",
      "EXTERNAL_PLATFORMS",
      "PLACES",
      "EMAIL_DELIVERY",
    ]);
    expect(card.delivery).toMatchObject({
      mode: "LOCAL",
      email: null,
      email_state: "UNAVAILABLE",
    });
    expect(card.delivery.digest_command).toBe(
      `igtrack digest @${FIXTURE_USERNAME} --since 2026-08-01`,
    );

    // Rosters and comments, newest first.
    expect(card.top_commenters.rows).toEqual([
      { username: "noah.frames", count: 2 },
      { username: "mira.lens", count: 1 },
    ]);
    expect(card.recent_comments.rows.map((row) => row.commented_at)).toEqual([
      "2026-08-26T08:10:00.000Z",
      "2026-08-25T14:22:00.000Z",
      "2026-08-25T13:05:00.000Z",
    ]);
    expect(card.recent_comments.rows.every((row) => row.like_count === null)).toBe(true);
    expect(card.recent_comments.like_count_note).toContain("not that it had zero likes");

    // Media is referenced, never re-served.
    expect(card.posts.total).toBe(2);
    expect(card.posts.rows.every((row) => row.media_url_state === "UNAVAILABLE")).toBe(true);

    // Captions were read and carry no hashtags: EMPTY is measured, not refused.
    expect(card.hashtags).toMatchObject({ state: "EMPTY", caption_rows: 2, rows: [] });

    expect(card.target.next_scan.state).toBe("UNAVAILABLE");
    expect(card.target.next_scan.reason).toBeTruthy();

    expect(card.commands.tracker).toBe(
      `igtrack tracker @${FIXTURE_USERNAME} --period monthly --at 2026-08-01`,
    );
    expect(card.commands.activity_report).toBe(
      `igtrack activity-report @${FIXTURE_USERNAME} --period monthly --at 2026-08-01`,
    );

    expect(card.evidence.evidenceClass).toBe("SYNTHETIC");
    expect(card.evidence.synthetic).toBe(true);
    expect(card.evidence.sourceIds).toEqual(["fixture:v1"]);
    expect(card.note).toContain("Counts match igtrack activity-report");
  });

  it("selects the latest closed window by default and keeps an explicit open one", async () => {
    const latest = await opTracker(ctx, { target: FIXTURE_USERNAME, period: "weekly" });
    expect(new Date(latest.window.end).getTime()).toBeLessThanOrEqual(Date.now());
    const card = latest.card as TrackerCard;
    expect(card.period.state).toBe("EMPTY");
    expect(card.kpis.posts).toMatchObject({ value: 0, state: "EMPTY" });

    const open = await opTracker(ctx, {
      target: FIXTURE_USERNAME,
      period: "weekly",
      at: new Date().toISOString().slice(0, 10),
    });
    const openCard = open.card as TrackerCard;
    expect(openCard.period.state).toBe("IN_PROGRESS");
    expect(openCard.period.provisional).toBe(true);
  });

  it("lists the watchlist and projects the same card values as the detail view", async () => {
    const overview = await opTracker(ctx, { period: "monthly", at: AUGUST_AT });
    expect(overview.mode).toBe("overview");
    expect(overview.card).toBeNull();
    const list = overview.overview;
    expect(list).not.toBeNull();
    if (list === null) return;

    expect(list.feature).toBe("igtrack.tracker");
    expect(list.mode).toBe("overview");
    expect(list.window.start).toBe("2026-08-01T00:00:00.000Z");
    // The seeded demo account is also tracked; totals count it, so pin the
    // invariants rather than a fixture-specific number.
    expect(list.totals.tracked).toBeGreaterThanOrEqual(2);
    expect(list.totals.active).toBe(list.totals.tracked);
    expect(list.totals.displayed).toBe(list.cards.length);

    const fixture = list.cards.find((entry) => entry.target.username === FIXTURE_USERNAME);
    expect(fixture).toBeDefined();
    expect(fixture?.period.state).toBe("DELIVERED");
    expect(fixture?.kpis.posts.value).toBe(2);
    expect(fixture?.kpis.new_followings.state).toBe("UNAVAILABLE");

    const quiet = list.cards.find((entry) => entry.target.username === UNSCANNED_USERNAME);
    expect(quiet).toBeDefined();
    expect(quiet?.period.state).toBe("EMPTY");
    expect(quiet?.period.has_data).toBe(false);
    expect(quiet?.kpis.posts).toMatchObject({ value: 0, state: "EMPTY" });
    expect(quiet?.kpis.stories).toMatchObject({ value: 0, state: "EMPTY" });
    expect(quiet?.kpis.new_followings).toMatchObject({
      value: null,
      state: "UNAVAILABLE",
    });
    expect(quiet?.evidence.evidenceClass).toBe("NONE");

    // Detail and list read the same builder: the shared watchlist KPIs cannot
    // disagree, and the list intentionally omits families it does not display.
    const detail = await opTracker(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const sharedKpis = [
      "new_followings",
      "un_follows",
      "posts",
      "stories",
      "comments",
      "tags",
      "mentions",
    ] as const;
    expect(Object.keys(fixture?.kpis ?? {})).toEqual([...sharedKpis]);
    for (const key of sharedKpis) {
      expect(fixture?.kpis[key]).toEqual((detail.card as TrackerCard).kpis[key]);
    }

    // Limit truncates the printed cards, not the tracked totals.
    const limited = await opTracker(ctx, { period: "monthly", at: AUGUST_AT, limit: 1 });
    expect(limited.overview?.cards).toHaveLength(1);
    expect(limited.overview?.totals.tracked).toBe(list.totals.tracked);
    expect(limited.overview?.totals.displayed).toBe(1);

    expect(list.note).toContain("never scans or queues work");
  });

  it("is read-only: composing cards writes no job or evidence row", async () => {
    const jobsBefore = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM monitoring_jobs
    `;
    const evidenceBefore = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    await opTracker(ctx, { period: "monthly", at: AUGUST_AT });
    await opTracker(ctx, { target: FIXTURE_USERNAME, period: "monthly", at: AUGUST_AT });
    const jobsAfter = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM monitoring_jobs
    `;
    const evidenceAfter = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    expect(jobsAfter[0]!.n).toBe(jobsBefore[0]!.n);
    expect(evidenceAfter[0]!.n).toBe(evidenceBefore[0]!.n);
  });

  it("rejects unknown periods and out-of-range limits without reading rows", async () => {
    await expect(
      opTracker(ctx, { period: "fortnightly", at: AUGUST_AT }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      opTracker(ctx, { period: "monthly", at: AUGUST_AT, limit: 0 }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      opTracker(ctx, { period: "monthly", at: AUGUST_AT, limit: 51 }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("returns the same card through MCP as the CLI operation", async () => {
    const direct = await opTracker(ctx, {
      target: FIXTURE_USERNAME,
      period: "monthly",
      at: AUGUST_AT,
    });
    const directCard = direct.card as TrackerCard;

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tracker-test", version: "1.0.0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "igtrack_tracker",
        arguments: { target: FIXTURE_USERNAME, period: "monthly", at: AUGUST_AT },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        ok: boolean;
        data: { mode: string; card: TrackerCard };
        _meta: { synthetic: boolean; provider: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.mode).toBe("target");
      expect(payload.data.card.period.data_id).toBe(directCard.period.data_id);
      expect(payload.data.card.kpis).toEqual(directCard.kpis);
      expect(payload.data.card.refusals).toEqual(directCard.refusals);
      expect(payload.data.card.evidence).toEqual(directCard.evidence);
      expect(payload._meta.synthetic).toBe(true);
      expect(payload._meta.provider).toBe("fixture");
    } finally {
      await client.close();
      await closeServerContext();
    }
  });
});

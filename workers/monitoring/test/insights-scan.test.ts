import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  available,
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedInsightSet,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  evidence as evidenceTable,
  getSourceHealth,
  igAccounts,
  insightPoints,
  targets,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { runInsightsScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

// ---------------------------------------------------------------------------
// ACCOUNT_INSIGHTS scan. The behaviour worth pinning is not "points get
// stored" — it is the three-way split the honesty invariants demand:
//   * a metric the platform returned    → a stored value with evidence;
//   * a metric the platform refused     → a stored ABSENCE with its reason,
//     which is data, not a failure, and never a zero;
//   * the source not exposing insights  → UNAVAILABLE, no rows at all.
// Plus the property the 6-hour cadence depends on: re-recording the same
// observation must not duplicate the ledger.
// ---------------------------------------------------------------------------

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T09:15:00.000Z";
const WINDOW_SINCE = "2026-07-28T09:15:00.000Z";
const WINDOW_UNTIL = "2026-08-27T09:15:00.000Z";

function pointSet(): NormalizedInsightSet {
  return {
    points: [
      {
        metric: "follower_count",
        period: "day",
        endTime: "2026-08-26T00:00:00.000Z",
        value: 12455,
      },
      {
        metric: "follower_count",
        period: "day",
        endTime: "2026-08-27T00:00:00.000Z",
        value: 12469,
      },
      { metric: "views", period: "day", value: 28450 },
      {
        metric: "follower_demographics",
        period: "lifetime",
        timeframe: "THIS_MONTH",
        dimension: "country",
        dimensionValue: "US",
        value: 4210,
      },
    ],
    absences: [],
    windowSince: WINDOW_SINCE,
    windowUntil: WINDOW_UNTIL,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.MEDIUM,
      observedAt: OBSERVED_AT,
    },
  };
}

function absenceOnlySet(): NormalizedInsightSet {
  return {
    points: [],
    absences: [
      {
        metric: "follower_count",
        period: "day",
        reason:
          "The platform returned no data for this metric (documented: not returned for accounts with fewer than 100 followers). Recorded as an absence, never as 0.",
      },
      {
        metric: "views",
        period: "day",
        reason:
          "The platform returned an empty data set for this metric in the requested window (documented behavior: the API returns an empty set instead of 0).",
      },
    ],
    windowSince: WINDOW_SINCE,
    windowUntil: WINDOW_UNTIL,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.MEDIUM,
      observedAt: OBSERVED_AT,
    },
  };
}

interface InsightsSourceConfig {
  set?: NormalizedInsightSet;
  status?: CapabilityStatus;
  note?: string;
  rawPayloadHash?: string;
  rawReference?: string;
  capabilityAvailable?: boolean;
  sourceId?: string;
}

function insightsSource(config: InsightsSourceConfig = {}): ExecutionSource {
  const sourceId = config.sourceId ?? "stub:insights";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const status = config.status ?? CapabilityStatus.AVAILABLE;
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      getPostChildren: false,
      getTags: false,
      getMentionedComment: false,
      getAccountInsights: config.capabilityAvailable ?? true,
      discoverAccount: false,
    }),
    getTags: async () => {
      throw new Error("stub: not wired");
    },
    getMentionedComment: async () => {
      throw new Error("stub: not wired");
    },
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async () => {
      throw new Error("stub: getPublicPosts not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
    getPostChildren: async () => {
      throw new Error("stub: getPostChildren not wired");
    },
    discoverAccount: async () => {
      throw new Error("stub: discoverAccount not wired");
    },
    getAccountInsights: async (): Promise<CapabilityResult<NormalizedInsightSet>> => {
      if (status === CapabilityStatus.UNAVAILABLE) {
        return unavailable(
          { observedAt: OBSERVED_AT, source: sourceRef },
          config.note ?? "Account insights unavailable from this source.",
        );
      }
      return available(config.set ?? pointSet(), {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.MEDIUM,
        ...(config.rawPayloadHash !== undefined
          ? { rawPayloadHash: config.rawPayloadHash }
          : {}),
        ...(config.rawReference !== undefined
          ? { rawReference: config.rawReference }
          : {}),
      });
    },
  };
  return {
    provider,
    source: { id: sourceId, kind: SourceKind.FIXTURE, name: "insights stub" },
  };
}

describe.runIf(dbAvailable)("worker INSIGHTS_SCAN", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "insights-scan@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(): Promise<string> {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `insights_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind: "INSIGHTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-insights");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function insightRows(targetId: string) {
    return handle.db
      .select({
        metric: insightPoints.metric,
        period: insightPoints.period,
        timeframe: insightPoints.timeframe,
        dimension: insightPoints.dimension,
        dimensionValue: insightPoints.dimensionValue,
        endTime: insightPoints.endTime,
        value: insightPoints.value,
        unavailableReason: insightPoints.unavailableReason,
        evidenceId: insightPoints.evidenceId,
      })
      .from(insightPoints)
      .innerJoin(igAccounts, sql`${igAccounts.id} = ${insightPoints.igAccountId}`)
      .innerJoin(targets, sql`${targets.igAccountId} = ${insightPoints.igAccountId}`)
      .where(sql`${targets.id} = ${targetId}`)
      .orderBy(insightPoints.metric, insightPoints.endTime);
  }

  it("AVAILABLE with points → ledger rows with evidence, success (IN1)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = insightsSource({
      rawPayloadHash: "c".repeat(64),
      rawReference: "fixture:v1/insights.json",
    });

    const result = await runInsightsScan(handle.db, job, src);
    expect(result).toBe("succeeded");

    const rows = await insightRows(targetId);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.evidenceId !== null)).toBe(true);
    expect(rows.every((r) => r.unavailableReason === null)).toBe(true);

    const followers = rows.filter((r) => r.metric === "follower_count");
    expect(followers.map((r) => r.value)).toEqual([12455, 12469]);
    expect(followers[0]?.period).toBe("day");

    // A breakdown row keeps its dimension; a total_value row keeps no endTime.
    const demographics = rows.find((r) => r.metric === "follower_demographics");
    expect(demographics?.dimension).toBe("country");
    expect(demographics?.dimensionValue).toBe("US");
    expect(demographics?.timeframe).toBe("THIS_MONTH");
    const views = rows.find((r) => r.metric === "views");
    expect(views?.value).toBe(28450);
    expect(views?.endTime).toBeNull();

    const health = await getSourceHealth(handle.db, "stub:insights");
    expect(health.find((h) => h.capability === "getAccountInsights")?.status).toBe("HEALTHY");
  });

  it("records the requested window in evidence, so a stored point is never ambiguous (IN2)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = insightsSource({
      rawPayloadHash: "d".repeat(64),
      rawReference: "fixture:v1/insights.json",
    });

    await runInsightsScan(handle.db, job, src);

    const row = (await insightRows(targetId))[0]!;
    const ev = await handle.db
      .select()
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${row.evidenceId}`);
    expect(ev[0]?.rawHash).toBe("d".repeat(64));
    expect(ev[0]?.sourceReference).toBe("fixture:v1/insights.json");
    expect(ev[0]?.observationKind).toBe("account_insights");
    const metadata = ev[0]?.metadata as
      | { windowSince?: string; windowUntil?: string; points?: number; absences?: number }
      | undefined;
    expect(metadata?.windowSince).toBe(WINDOW_SINCE);
    expect(metadata?.windowUntil).toBe(WINDOW_UNTIL);
    expect(metadata?.points).toBe(4);
    expect(metadata?.absences).toBe(0);
  });

  it("stores an absence as a reason row with NO value — never a zero, never a failure (IN3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = insightsSource({ set: absenceOnlySet() });

    const result = await runInsightsScan(handle.db, job, src);
    // Nothing was observed, but the platform's refusal was: that is data.
    expect(result).toBe("succeeded-empty");

    const rows = await insightRows(targetId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.value === null)).toBe(true);
    expect(rows.every((r) => (r.unavailableReason ?? "").length > 20)).toBe(true);
    expect(rows.map((r) => r.metric).sort()).toEqual(["follower_count", "views"]);

    const health = await getSourceHealth(handle.db, "stub:insights");
    expect(health.find((h) => h.capability === "getAccountInsights")?.status).toBe("HEALTHY");
  });

  it("UNAVAILABLE → no rows at all, source health says why (IN4)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = insightsSource({
      status: CapabilityStatus.UNAVAILABLE,
      note: "This source does not expose account insights.",
    });

    const result = await runInsightsScan(handle.db, job, src);
    expect(result).toBe("unavailable");

    // An unexposed capability is not an empty observation: nothing is written.
    expect(await insightRows(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:insights");
    const row = health.find((h) => h.capability === "getAccountInsights");
    expect(row?.status).toBe("UNAVAILABLE");
    expect(row?.coverageNote).toContain("does not expose account insights");
  });

  it("capability off → UNAVAILABLE with no provider call (IN4)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = insightsSource({ capabilityAvailable: false });

    const result = await runInsightsScan(handle.db, job, src);
    expect(result).toBe("unavailable");
    expect(await insightRows(targetId)).toHaveLength(0);
  });

  it("re-recording the same observation dedupes instead of duplicating the ledger (IN5)", async () => {
    const targetId = await makeTarget();
    const src = insightsSource();

    const first = await makeJob(targetId);
    expect(await runInsightsScan(handle.db, first, src)).toBe("succeeded");
    await completeJob(handle.db, first.id, "worker-insights");

    // Same provider, same observedAt: the platform window has not moved, so the
    // second scan re-states the same claims. The ledger must not grow.
    const second = await makeJob(targetId);
    expect(await runInsightsScan(handle.db, second, src)).toBe("succeeded");

    expect(await insightRows(targetId)).toHaveLength(4);
    // Distinct evidence rows are fine and expected (two scans were performed);
    // what must not happen is a duplicated claim.
    const evidenceIds = new Set((await insightRows(targetId)).map((r) => r.evidenceId));
    expect(evidenceIds.size).toBe(1);
  });
});

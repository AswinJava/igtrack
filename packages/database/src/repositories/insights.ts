import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { NormalizedAccountRef, NormalizedInsightSet } from "@igtrack/core";
import { insightPoints } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { upsertEvidence } from "./evidence.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";

export type InsightPointRecord = typeof insightPoints.$inferSelect;

export interface RecordInsightSetInput {
  account: NormalizedAccountRef;
  sourceId: string;
  evidence: EvidenceRecordInput;
  set: NormalizedInsightSet;
}

// One transaction per insight set: account identity, the evidence row the
// points hang from, then the points themselves. Points and absences land in
// the same table because both are claims about a metric; the XOR constraint
// keeps them distinct kinds of claim. Retried or reclaimed scans collapse on
// the idempotency index (ON CONFLICT DO NOTHING catches it even though the
// index is expression-based, so no conflict target is named).
export async function recordInsightSet(
  db: Database,
  input: RecordInsightSetInput,
): Promise<void> {
  const { set } = input;

  await withTransaction(db, async (tx) => {
    const account = await upsertAccount(tx, {
      username: input.account.username,
      ...(input.account.igId !== undefined ? { igId: input.account.igId } : {}),
      ...(input.account.displayName !== undefined
        ? { displayName: input.account.displayName }
        : {}),
      ...(input.account.isPrivate !== undefined
        ? { isPrivate: input.account.isPrivate }
        : {}),
      seenAt: new Date(set.meta.observedAt),
    });

    const evidenceId = await upsertEvidence(tx, `insights:${account.username}@${set.meta.observedAt}`, {
      ...input.evidence,
      observationKind: ObservationKind.ACCOUNT_INSIGHTS,
    });

    if (set.points.length === 0 && set.absences.length === 0) return;

    const observedAt = new Date(set.meta.observedAt);
    const rows = [
      ...set.points.map((point) => ({
        id: randomUUID(),
        igAccountId: account.id,
        sourceId: input.sourceId,
        observedAt,
        metric: point.metric,
        period: point.period,
        timeframe: point.timeframe ?? null,
        dimension: point.dimension ?? null,
        dimensionValue: point.dimensionValue ?? null,
        endTime: point.endTime === undefined ? null : new Date(point.endTime),
        value: point.value,
        unavailableReason: null,
        confidence: set.meta.confidence,
        evidenceId,
      })),
      ...set.absences.map((absence) => ({
        id: randomUUID(),
        igAccountId: account.id,
        sourceId: input.sourceId,
        observedAt,
        metric: absence.metric,
        period: absence.period,
        timeframe: null,
        dimension: null,
        dimensionValue: null,
        endTime: null,
        value: null,
        unavailableReason: absence.reason,
        confidence: set.meta.confidence,
        evidenceId,
      })),
    ];

    await tx.insert(insightPoints).values(rows).onConflictDoNothing();
  });
}

export interface InsightSeriesPoint {
  metric: string;
  period: string;
  endTime: Date | null;
  value: number;
}

/** Time-series points for one metric, oldest first. Absence rows are excluded
 * by construction: a chart line must be built from observed values only. */
export async function listInsightSeries(
  db: Database,
  igAccountId: string,
  metric: string,
  options: { limit?: number } = {},
): Promise<InsightSeriesPoint[]> {
  const rows = await db
    .select({
      metric: insightPoints.metric,
      period: insightPoints.period,
      endTime: insightPoints.endTime,
      value: insightPoints.value,
    })
    .from(insightPoints)
    .where(
      and(
        eq(insightPoints.igAccountId, igAccountId),
        eq(insightPoints.metric, metric),
        isNotNull(insightPoints.value),
      ),
    )
    .orderBy(desc(insightPoints.endTime))
    .limit(options.limit ?? 500);
  return rows
    .reverse()
    .map((row) => ({
      metric: row.metric,
      period: row.period,
      endTime: row.endTime,
      value: row.value ?? 0,
    }));
}

export interface InsightLatestPoint {
  metric: string;
  period: string;
  timeframe: string | null;
  dimension: string | null;
  dimensionValue: string | null;
  value: number;
  endTime: Date | null;
  observedAt: Date;
}

/** The most recently observed value for each (metric, dimension, value) bucket,
 * as one query. DISTINCT ON keeps the cost independent of how long the series
 * has been accumulating; without the dimension columns a demographic breakdown
 * would collapse to one arbitrary country. */
export async function insightLatest(
  db: Database,
  igAccountId: string,
): Promise<InsightLatestPoint[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (metric, coalesce(dimension, ''), coalesce(dimension_value, ''))
           metric, period, timeframe, dimension, dimension_value,
           value, end_time, observed_at
    FROM insight_points
    WHERE ig_account_id = ${igAccountId}
      AND value IS NOT NULL
    ORDER BY metric, coalesce(dimension, ''), coalesce(dimension_value, ''),
             end_time DESC NULLS LAST, observed_at DESC
  `);
  return Array.from(
    rows as unknown as Array<{
      metric: string;
      period: string;
      timeframe: string | null;
      dimension: string | null;
      dimension_value: string | null;
      value: number;
      end_time: Date | string | null;
      observed_at: Date | string;
    }>,
  ).map((row) => ({
    metric: row.metric,
    period: row.period,
    timeframe: row.timeframe,
    dimension: row.dimension,
    dimensionValue: row.dimension_value,
    value: Number(row.value),
    endTime: row.end_time === null ? null : new Date(row.end_time),
    observedAt: new Date(row.observed_at),
  }));
}

export interface InsightLatestState {
  latestObservedAt: Date | null;
  points: number;
  absences: number;
  latestAbsences: Array<{ metric: string; period: string; reason: string }>;
}

/** Aggregate status for one account: how much was recorded and which metrics
 * were most recently reported absent (with their reasons). Aggregation happens
 * in SQL so the cost does not grow with the ledger. */
export async function insightState(
  db: Database,
  igAccountId: string,
): Promise<InsightLatestState> {
  const totals = await db.execute(sql`
    SELECT max(observed_at) AS latest_observed_at,
           count(*) FILTER (WHERE value IS NOT NULL)::int AS points,
           count(*) FILTER (WHERE unavailable_reason IS NOT NULL)::int AS absences
    FROM insight_points
    WHERE ig_account_id = ${igAccountId}
  `);
  const row = Array.from(
    totals as unknown as Array<{
      latest_observed_at: Date | string | null;
      points: number;
      absences: number;
    }>,
  )[0];
  if (row === undefined || row.latest_observed_at === null) {
    return { latestObservedAt: null, points: 0, absences: 0, latestAbsences: [] };
  }
  const latest = await db.execute(sql`
    SELECT metric, period, unavailable_reason AS reason
    FROM insight_points
    WHERE ig_account_id = ${igAccountId}
      AND unavailable_reason IS NOT NULL
      AND observed_at = ${new Date(row.latest_observed_at).toISOString()}
    ORDER BY metric, period
  `);
  return {
    latestObservedAt: new Date(row.latest_observed_at),
    points: Number(row.points),
    absences: Number(row.absences),
    latestAbsences: Array.from(
      latest as unknown as Array<{ metric: string; period: string; reason: string }>,
    ),
  };
}

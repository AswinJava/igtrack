import { sql } from "drizzle-orm";
import { capabilityMetrics } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { ensureSource } from "./sources.js";
import type { SourceInput } from "./types.js";

export type ProviderMetricRecord = typeof capabilityMetrics.$inferSelect;

export interface RecordProviderMetricsInput {
  source: SourceInput;
  capability: string;
  // Outcome of one provider call. Timeouts and rate limits get their own
  // counters because they drive capacity decisions; both also count as errors.
  ok: boolean;
  timedOut?: boolean;
  rateLimited?: boolean;
  latencyMs?: number;
  // Required: the wall-clock time of the provider call being counted.
  // Callers pass the call start time explicitly so the stored timestamp is
  // labeled by construction instead of a silent `new Date()` fallback.
  observedAt: Date;
}

// Best-effort operational counters per provider capability. Single upsert,
// atomic increments — safe under concurrent workers. Callers must tolerate
// failure: metrics must never break a scan.
export async function recordProviderMetrics(
  db: Database,
  input: RecordProviderMetricsInput,
): Promise<void> {
  await ensureSource(db, input.source);
  const latency =
    input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
      ? Math.floor(input.latencyMs)
      : null;
  await db
    .insert(capabilityMetrics)
    .values({
      sourceId: input.source.id,
      capability: input.capability,
      totalRequests: 1,
      totalOk: input.ok ? 1 : 0,
      totalErrors: input.ok ? 0 : 1,
      totalTimeouts: input.timedOut === true ? 1 : 0,
      totalRateLimited: input.rateLimited === true ? 1 : 0,
        ...(latency !== null ? { lastLatencyMs: latency } : {}),
        lastObservedAt: input.observedAt,
      })
      .onConflictDoUpdate({
      target: [capabilityMetrics.sourceId, capabilityMetrics.capability],
      set: {
        totalRequests: sql`${capabilityMetrics.totalRequests} + 1`,
        totalOk: sql`${capabilityMetrics.totalOk} + ${input.ok ? 1 : 0}`,
        totalErrors: sql`${capabilityMetrics.totalErrors} + ${input.ok ? 0 : 1}`,
        totalTimeouts: sql`${capabilityMetrics.totalTimeouts} + ${input.timedOut === true ? 1 : 0}`,
        totalRateLimited: sql`${capabilityMetrics.totalRateLimited} + ${input.rateLimited === true ? 1 : 0}`,
        ...(latency !== null ? { lastLatencyMs: latency } : {}),
        lastObservedAt: input.observedAt,
      },
    });
}

export async function listProviderMetrics(
  db: Database,
): Promise<ProviderMetricRecord[]> {
  return db
    .select()
    .from(capabilityMetrics)
    .orderBy(capabilityMetrics.sourceId, capabilityMetrics.capability);
}

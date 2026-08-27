import { sql } from "drizzle-orm";
import { sourceHealth } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { ensureSource } from "../repositories/sources.js";
import type { SourceInput } from "../repositories/types.js";

export type SourceHealthRecord = typeof sourceHealth.$inferSelect;
export type SourceHealthStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export interface CapabilityOutcomeInput {
  source: SourceInput;
  capability: string;
  latencyMs?: number;
}

export async function recordCapabilitySuccess(
  db: Database,
  input: CapabilityOutcomeInput,
): Promise<SourceHealthRecord> {
  await ensureSource(db, input.source);
  const rows = await db
    .insert(sourceHealth)
    .values({
      sourceId: input.source.id,
      capability: input.capability,
      status: "HEALTHY",
      lastSuccessAt: new Date(),
      consecutiveFailures: 0,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    })
    .onConflictDoUpdate({
      target: [sourceHealth.sourceId, sourceHealth.capability],
      set: {
        status: "HEALTHY",
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("igtrack: failed to record success");
  return row;
}

export interface CapabilityFailureInput extends CapabilityOutcomeInput {
  reason: string;
  errorCategory?: string;
}

export async function recordCapabilityFailure(
  db: Database,
  input: CapabilityFailureInput,
): Promise<SourceHealthRecord> {
  await ensureSource(db, input.source);
  const existingRows = await db
    .select()
    .from(sourceHealth)
    .where(
      sql`${sourceHealth.sourceId} = ${input.source.id}
        AND ${sourceHealth.capability} = ${input.capability}`,
    )
    .limit(1);
  const existing = existingRows[0];
  const nextFailures = (existing?.consecutiveFailures ?? 0) + 1;

  const rows = await db
    .insert(sourceHealth)
    .values({
      sourceId: input.source.id,
      capability: input.capability,
      status: "DEGRADED",
      lastFailureAt: new Date(),
      lastFailureReason: input.reason,
      consecutiveFailures: nextFailures,
      ...(input.errorCategory !== undefined
        ? { errorCategory: input.errorCategory }
        : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    })
    .onConflictDoUpdate({
      target: [sourceHealth.sourceId, sourceHealth.capability],
      set: {
        status: "DEGRADED",
        lastFailureAt: new Date(),
        lastFailureReason: input.reason,
        consecutiveFailures: nextFailures,
        ...(input.errorCategory !== undefined
          ? { errorCategory: input.errorCategory }
          : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("igtrack: failed to record failure");
  return row;
}

export async function markCapabilityUnavailable(
  db: Database,
  input: CapabilityOutcomeInput & { coverageNote?: string },
): Promise<SourceHealthRecord> {
  await ensureSource(db, input.source);
  const rows = await db
    .insert(sourceHealth)
    .values({
      sourceId: input.source.id,
      capability: input.capability,
      status: "UNAVAILABLE",
      ...(input.coverageNote !== undefined
        ? { coverageNote: input.coverageNote }
        : {}),
    })
    .onConflictDoUpdate({
      target: [sourceHealth.sourceId, sourceHealth.capability],
      set: {
        status: "UNAVAILABLE",
        ...(input.coverageNote !== undefined
          ? { coverageNote: input.coverageNote }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("igtrack: failed to mark unavailable");
  return row;
}

export async function getSourceHealth(
  db: Database,
  sourceId?: string,
): Promise<SourceHealthRecord[]> {
  if (sourceId === undefined) {
    return db.select().from(sourceHealth).orderBy(sql`${sourceHealth.updatedAt} DESC`);
  }
  return db
    .select()
    .from(sourceHealth)
    .where(sql`${sourceHealth.sourceId} = ${sourceId}`)
    .orderBy(sql`${sourceHealth.capability} ASC`);
}

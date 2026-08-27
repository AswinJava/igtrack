import { and, eq } from "drizzle-orm";
import { evidence } from "../schema/index.js";
import type { DatabaseTx } from "../transactions.js";
import { ensureSource } from "./sources.js";
import type { EvidenceRecordInput } from "./types.js";

export type EvidenceRecord = typeof evidence.$inferSelect;

export async function upsertEvidence(
  tx: DatabaseTx,
  observationId: string,
  input: EvidenceRecordInput,
): Promise<string> {
  await ensureSource(tx, input.source);
  const rows = await tx
    .insert(evidence)
    .values({
      observationKind: input.observationKind,
      observationId,
      sourceId: input.source.id,
      ...(input.sourceReference !== undefined
        ? { sourceReference: input.sourceReference }
        : {}),
      ...(input.source.providerVersion !== undefined
        ? { providerVersion: input.source.providerVersion }
        : {}),
      ...(input.schemaVersion !== undefined
        ? { schemaVersion: input.schemaVersion }
        : {}),
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      confidence: input.confidence,
      rawHash: input.rawHash,
      ...(input.normalizedHash !== undefined
        ? { normalizedHash: input.normalizedHash }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    })
    .onConflictDoNothing({
      target: [evidence.observationKind, evidence.observationId],
    })
    .returning({ id: evidence.id });
  const inserted = rows[0];
  if (inserted !== undefined) return inserted.id;

  const existing = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        eq(evidence.observationKind, input.observationKind),
        eq(evidence.observationId, observationId),
      ),
    )
    .limit(1);
  const existingRow = existing[0];
  if (existingRow === undefined) {
    throw new Error("igtrack: evidence upsert failed without conflict row");
  }
  return existingRow.id;
}

export async function getEvidenceByObservation(
  tx: DatabaseTx,
  observationKind: string,
  observationId: string,
): Promise<EvidenceRecord | null> {
  const rows = await tx
    .select()
    .from(evidence)
    .where(
      and(
        eq(evidence.observationKind, observationKind),
        eq(evidence.observationId, observationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

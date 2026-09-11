import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Confidence } from "@igtrack/core";
import { postChanges, postPresence } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { ensureSource } from "./sources.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type PostPresenceRecord = typeof postPresence.$inferSelect;
export type PostChangeRecord = typeof postChanges.$inferSelect;

// ---------------------------------------------------------------------------
//  Media change detection for owned targets.
//
// The posts table is append-only and first-observation-wins, so caption edits
// and posts leaving the media listing were undetectable. post_presence is the
// one mutable state row per stored post; post_changes is the append-only event
// family. Every `detected_at` is OUR logical scan instant (job.startedAt,
// stable across retries and lease reclaims), which is both the honest
// observation bound ("first seen different at T") and the retry dedup key.
// ---------------------------------------------------------------------------

function listingObservationId(targetId: string, scanObservedAt: Date): string {
  return `posts_listing:${targetId}@${scanObservedAt.toISOString()}`;
}

export interface RecordPostPresenceInput {
  targetId: string;
  postDbId: string;
  sourceId: string;
  /** Our logical scan instant (job.startedAt) — never the provider's clock. */
  scanObservedAt: Date;
  /** The post row's first-observation time, recorded on first presence. */
  firstSeenAt: Date;
  /**
   * The caption this observation read, when the provider exposed one. An
   * omitted field is "not exposed in this observation": it never edits and
   * never clears the stored value.
   */
  caption?: string;
  confidence: Confidence;
  evidence: EvidenceRecordInput;
}

export interface RecordPostPresenceResult {
  /** Non-null only when a `CAPTION_EDITED` row was newly recorded. */
  change: PostChangeRecord | null;
}

/**
 * Records that a media listing observed this post at the logical scan instant.
 * First observation inserts the presence row silently; a caption that differs
 * from the last-read caption records one `CAPTION_EDITED` event (old/new
 * exact); a post returning after absence flips back to PRESENT silently.
 */
export async function recordPostPresence(
  db: Database,
  input: RecordPostPresenceInput,
): Promise<RecordPostPresenceResult> {
  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.evidence.source);

    const existing = await tx
      .select()
      .from(postPresence)
      .where(eq(postPresence.postDbId, input.postDbId))
      .limit(1);
    const row = existing[0];

    if (row === undefined) {
      await tx
        .insert(postPresence)
        .values({
          postDbId: input.postDbId,
          targetId: input.targetId,
          sourceId: input.sourceId,
          state: "PRESENT",
          firstSeenAt: input.firstSeenAt,
          lastScanAt: input.scanObservedAt,
          ...(input.caption !== undefined ? { lastCaption: input.caption } : {}),
        })
        .onConflictDoNothing();
      return { change: null };
    }

    // A caption difference is a fact we READ, not an absence claim, so it is
    // recorded from any observation — but only against a stored
    // previous value: a first-ever caption is not an edit.
    const captionChanged =
      input.caption !== undefined &&
      row.lastCaption !== null &&
      row.lastCaption !== input.caption;

    await tx
      .update(postPresence)
      .set({
        state: "PRESENT",
        lastScanAt: input.scanObservedAt,
        ...(input.caption !== undefined ? { lastCaption: input.caption } : {}),
        updatedAt: new Date(),
      })
      .where(eq(postPresence.postDbId, input.postDbId));

    if (!captionChanged) return { change: null };

    const evidenceId = await upsertEvidence(
      tx,
      listingObservationId(input.targetId, input.scanObservedAt),
      { ...input.evidence, observationKind: ObservationKind.POSTS_LISTING },
    );
    const inserted = await tx
      .insert(postChanges)
      .values({
        id: randomUUID(),
        targetId: input.targetId,
        postDbId: input.postDbId,
        change: "CAPTION_EDITED",
        oldValue: row.lastCaption,
        newValue: input.caption ?? null,
        detectedAt: input.scanObservedAt,
        confidence: input.confidence,
        evidenceId,
      })
      .onConflictDoNothing({
        target: [postChanges.postDbId, postChanges.change, postChanges.detectedAt],
      })
      .returning();
    return { change: inserted[0] ?? null };
  });
}

export interface FinalizePostPresenceInput {
  targetId: string;
  sourceId: string;
  /** Our logical scan instant (job.startedAt). */
  scanObservedAt: Date;
  /**
   * Whether this scan's MEDIA listing completed. Only a COMPLETE listing may
   * claim an absence — comment/children truncation must not gate this.
   */
  complete: boolean;
  confidence: Confidence;
  evidence: EvidenceRecordInput;
}

export interface FinalizePostPresenceResult {
  /** Newly recorded `NO_LONGER_OBSERVED` events (empty on retry or partial). */
  removed: PostChangeRecord[];
}

/**
 * Ends a logical scan. When the media listing was COMPLETE, every PRESENT
 * presence row not observed this scan (last_scan_at < scanObservedAt) flips to
 * ABSENT and yields one `NO_LONGER_OBSERVED` event: "absent from a complete
 * media listing at T", never "deleted". A partial listing returns empty
 * and changes nothing.
 */
export async function finalizePostPresence(
  db: Database,
  input: FinalizePostPresenceInput,
): Promise<FinalizePostPresenceResult> {
  if (!input.complete) return { removed: [] };

  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.evidence.source);

    const absent = await tx
      .update(postPresence)
      .set({ state: "ABSENT", updatedAt: new Date() })
      .where(
        and(
          eq(postPresence.targetId, input.targetId),
          eq(postPresence.sourceId, input.sourceId),
          eq(postPresence.state, "PRESENT"),
          lt(postPresence.lastScanAt, input.scanObservedAt),
        ),
      )
      .returning();
    if (absent.length === 0) return { removed: [] };

    const evidenceId = await upsertEvidence(
      tx,
      listingObservationId(input.targetId, input.scanObservedAt),
      { ...input.evidence, observationKind: ObservationKind.POSTS_LISTING },
    );
    // Chunk to stay under Postgres max parameters (65534) — ~9 params per row.
    const BATCH = 2000;
    const removed: PostChangeRecord[] = [];
    for (let i = 0; i < absent.length; i += BATCH) {
      const batch = absent.slice(i, i + BATCH);
      const inserted = await tx
        .insert(postChanges)
        .values(
          batch.map((row) => ({
            id: randomUUID(),
            targetId: input.targetId,
            postDbId: row.postDbId,
            change: "NO_LONGER_OBSERVED" as const,
            oldValue: row.lastCaption,
            newValue: null,
            detectedAt: input.scanObservedAt,
            confidence: input.confidence,
            evidenceId,
          })),
        )
        .onConflictDoNothing({
          target: [postChanges.postDbId, postChanges.change, postChanges.detectedAt],
        })
        .returning();
      removed.push(...inserted);
    }
    return { removed };
  });
}

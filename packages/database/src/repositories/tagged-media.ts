import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import type { NormalizedAccountRef, NormalizedTaggedMedia } from "@igtrack/core";
import { evidence, taggedMedia } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type TaggedMediaRecord = typeof taggedMedia.$inferSelect;

export interface RecordTaggedMediaInput {
  owner: NormalizedAccountRef;
  sourceId: string;
  /**
   * One scan-keyed evidence row covers every tag row of one logical scan
   * (FOUNDING §17): the artifact is the listing, not each row. `observedAt`
   * must be the logical scan instant (job.startedAt) so a retried scan reuses
   * its evidence and a later scan is honestly a new observation.
   */
  evidence: EvidenceRecordInput;
  tags: NormalizedTaggedMedia[];
}

export interface RecordTaggedMediaResult {
  inserted: number;
  deduplicated: number;
}

// Scan-keyed evidence identity: a retried scan reuses its row; a later scan is
// a new observation of the same listing.
function listingObservationId(
  igAccountId: string,
  scanObservedAt: Date,
): string {
  return `tagged_media_listing:${igAccountId}@${scanObservedAt.toISOString()}`;
}

/**
 * Append-only first-observation records for the documented IG User `tags`
 * edge. Rows dedup on (account, media, source) with DO NOTHING — a re-scan
 * never rewrites a stored observation and never claims a removal. No diff
 * state exists here on purpose (FOUNDING §17).
 */
export async function recordTaggedMedia(
  db: Database,
  input: RecordTaggedMediaInput,
): Promise<RecordTaggedMediaResult> {
  if (input.tags.length === 0) {
    // Nothing to store and nothing to claim: the empty-listing observation is
    // carried by the job outcome and capability success, not by a row.
    return { inserted: 0, deduplicated: 0 };
  }

  return withTransaction(db, async (tx) => {
    const owner = await upsertAccount(tx, {
      username: input.owner.username,
      ...(input.owner.igId !== undefined ? { igId: input.owner.igId } : {}),
      ...(input.owner.displayName !== undefined
        ? { displayName: input.owner.displayName }
        : {}),
      ...(input.owner.isPrivate !== undefined
        ? { isPrivate: input.owner.isPrivate }
        : {}),
      seenAt: input.evidence.observedAt,
    });

    const evidenceId = await upsertEvidence(
      tx,
      listingObservationId(owner.id, input.evidence.observedAt),
      { ...input.evidence, observationKind: ObservationKind.TAGGED_MEDIA_LISTING },
    );

    let inserted = 0;
    let deduplicated = 0;
    for (const tag of input.tags) {
      const rows = await tx
        .insert(taggedMedia)
        .values({
          id: randomUUID(),
          igAccountId: owner.id,
          sourceId: input.sourceId,
          mediaId: tag.mediaId,
          ...(tag.ownerUsername !== undefined
            ? { ownerUsername: tag.ownerUsername }
            : {}),
          ...(tag.caption !== undefined ? { caption: tag.caption } : {}),
          ...(tag.permalink !== undefined ? { permalink: tag.permalink } : {}),
          ...(tag.mediaType !== undefined ? { mediaType: tag.mediaType } : {}),
          ...(tag.takenAt !== undefined ? { takenAt: new Date(tag.takenAt) } : {}),
          observedAt: new Date(tag.meta.observedAt),
          confidence: tag.meta.confidence,
          evidenceId,
        })
        .onConflictDoNothing({
          target: [
            taggedMedia.igAccountId,
            taggedMedia.mediaId,
            taggedMedia.sourceId,
          ],
        })
        .returning({ id: taggedMedia.id });
      if (rows[0] !== undefined) inserted += 1;
      else deduplicated += 1;
    }
    return { inserted, deduplicated };
  });
}

/**
 * Tagged-media rows for one account, newest observation first. Read-only;
 * each row carries its own confidence and evidence link.
 */
export async function listTaggedMedia(
  db: Database,
  igAccountId: string,
  limit = 50,
): Promise<TaggedMediaRecord[]> {
  return db
    .select()
    .from(taggedMedia)
    .where(eq(taggedMedia.igAccountId, igAccountId))
    .orderBy(desc(taggedMedia.observedAt))
    .limit(limit);
}

export interface TagsListingEvidence {
  observedAt: Date;
  completion: string | null;
  pages: number | null;
  pageCap: number | null;
}

/**
 * The most recent tags listing evidence for one account, so consumers can say
 * how complete the last read was (COMPLETE vs PARTIAL/capped) — a bounded
 * listing must say so where the claim lives (D48's rule, applied here).
 * Observation ids are scan-keyed by this module, so the lookup is exact and
 * stays scoped to the account.
 */
export async function latestTagsListingEvidence(
  db: Database,
  igAccountId: string,
): Promise<TagsListingEvidence | null> {
  const rows = await db
    .select({ observedAt: evidence.observedAt, metadata: evidence.metadata })
    .from(evidence)
    .where(
      and(
        eq(evidence.observationKind, ObservationKind.TAGGED_MEDIA_LISTING),
        like(evidence.observationId, `tagged_media_listing:${igAccountId}@%`),
      ),
    )
    .orderBy(desc(evidence.observedAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null
      ? (row.metadata as Record<string, unknown>)
      : null;
  return {
    observedAt: row.observedAt,
    completion: typeof metadata?.["completion"] === "string" ? (metadata["completion"] as string) : null,
    pages: typeof metadata?.["pages"] === "number" ? (metadata["pages"] as number) : null,
    pageCap: typeof metadata?.["pageCap"] === "number" ? (metadata["pageCap"] as number) : null,
  };
}

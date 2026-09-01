import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  diffFollowSets,
  type FollowDiff,
  type NormalizedFollowPage,
} from "@igtrack/core";
import {
  followDeltas,
  followSnapshotMembers,
  followSnapshots,
  igAccounts,
} from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { ensureSource } from "./sources.js";
import { upsertEvidence } from "./evidence.js";
import type { SourceInput, EvidenceRecordInput } from "./types.js";

export type FollowSnapshotRecord = typeof followSnapshots.$inferSelect;
export type FollowDeltaRecord = typeof followDeltas.$inferSelect;

export type FollowDirection = "FOLLOWERS" | "FOLLOWING";

export interface RecordFollowSnapshotInput {
  targetId: string;
  direction: FollowDirection;
  page: NormalizedFollowPage;
  source: SourceInput;
  takenAt?: Date;
  // When provided, an evidence row is created and linked to the snapshot at
  // insert time — snapshots are append-only and can never be patched with
  // provenance afterwards.
  evidence?: EvidenceRecordInput;
}

export interface RecordFollowSnapshotResult {
  snapshot: FollowSnapshotRecord;
  memberCount: number;
  deduplicated: boolean;
}

export async function recordFollowSnapshot(
  db: Database,
  input: RecordFollowSnapshotInput,
): Promise<RecordFollowSnapshotResult> {
  const takenAt = input.takenAt ?? new Date(input.page.meta.observedAt);

  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.source);

    const existing = await tx
      .select()
      .from(followSnapshots)
      .where(
        and(
          eq(followSnapshots.targetId, input.targetId),
          eq(followSnapshots.direction, input.direction),
          eq(followSnapshots.takenAt, takenAt),
          eq(followSnapshots.sourceId, input.source.id),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return {
        snapshot: existingRow,
        memberCount: input.page.entries.length,
        deduplicated: true,
      };
    }

    const accountIds: string[] = [];
    for (const entry of input.page.entries) {
      const account = await upsertAccount(tx, {
        username: entry.username,
        ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
        seenAt: takenAt,
      });
      accountIds.push(account.id);
    }

    const snapshotId = randomUUID();
    let evidenceId: string | undefined;
    if (input.evidence !== undefined) {
      evidenceId = await upsertEvidence(tx, snapshotId, input.evidence);
    }

    const snapshotRows = await tx
      .insert(followSnapshots)
      .values({
        id: snapshotId,
        targetId: input.targetId,
        direction: input.direction,
        takenAt,
        sourceId: input.source.id,
        completeness: input.page.complete ? "COMPLETE" : "PARTIAL",
        totalObserved: input.page.entries.length,
        ...(input.page.nextCursor !== undefined
          ? { cursorState: input.page.nextCursor }
          : {}),
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      .returning();
    const snapshot = snapshotRows[0];
    if (snapshot === undefined) {
      throw new Error("igtrack: failed to insert follow snapshot");
    }

    if (accountIds.length > 0) {
      // Chunk to stay under Postgres max parameters (65534) — 2 params per row → ~32k max per statement.
      // Batching at 5k (≈10k params) keeps us safely under the limit and bounded for 500k snapshots.
      const BATCH = 5000;
      for (let i = 0; i < accountIds.length; i += BATCH) {
        const batch = accountIds.slice(i, i + BATCH);
        await tx
          .insert(followSnapshotMembers)
          .values(
            batch.map((igAccountId) => ({
              snapshotId: snapshot.id,
              igAccountId,
            })),
          )
          .onConflictDoNothing();
      }
    }

    return {
      snapshot,
      memberCount: accountIds.length,
      deduplicated: false,
    };
  });
}

export async function latestFollowSnapshot(
  db: Database,
  targetId: string,
  direction: FollowDirection,
): Promise<FollowSnapshotRecord | null> {
  const rows = await db
    .select()
    .from(followSnapshots)
    .where(
      and(
        sql`${followSnapshots.targetId} = ${targetId}`,
        sql`${followSnapshots.direction} = ${direction}`,
      ),
    )
    .orderBy(desc(followSnapshots.takenAt))
    .limit(1);
  return rows[0] ?? null;
}

async function snapshotMemberIds(
  db: Database,
  snapshotId: string,
): Promise<string[]> {
  const rows = await db
    .select({ igAccountId: followSnapshotMembers.igAccountId })
    .from(followSnapshotMembers)
    .where(sql`${followSnapshotMembers.snapshotId} = ${snapshotId}`);
  return rows.map((r) => r.igAccountId);
}

export interface PersistFollowDiffResult {
  diff: FollowDiff;
  insertedDeltas: number;
}

export async function persistFollowDiff(
  db: Database,
  input: {
    targetId: string;
    direction: FollowDirection;
    fromSnapshotId: string;
    toSnapshotId: string;
  },
): Promise<PersistFollowDiffResult> {
  const [fromIds, toIds, toSnapshot] = await Promise.all([
    snapshotMemberIds(db, input.fromSnapshotId),
    snapshotMemberIds(db, input.toSnapshotId),
    db
      .select()
      .from(followSnapshots)
      .where(sql`${followSnapshots.id} = ${input.toSnapshotId}`)
      .limit(1),
  ]);
  const toRow = toSnapshot[0];
  if (toRow === undefined) {
    throw new Error(`igtrack: snapshot ${input.toSnapshotId} not found`);
  }

  const diff = diffFollowSets(fromIds, toIds);

  const addChange =
    input.direction === "FOLLOWERS" ? "NEW_FOLLOWER" : "NEW_FOLLOWING";
  const removeChange =
    input.direction === "FOLLOWERS" ? "LOST_FOLLOWER" : "LOST_FOLLOWING";

  const deltaValues = [
    ...diff.added.map((igAccountId) => ({
      targetId: input.targetId,
      direction: input.direction,
      change: addChange as typeof followDeltas.$inferSelect.change,
      igAccountId,
      firstSeenAt: toRow.takenAt,
      fromSnapshotId: input.fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
    })),
    ...diff.removed.map((igAccountId) => ({
      targetId: input.targetId,
      direction: input.direction,
      change: removeChange as typeof followDeltas.$inferSelect.change,
      igAccountId,
      firstSeenAt: toRow.takenAt,
      fromSnapshotId: input.fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
    })),
  ];

  let insertedDeltas = 0;
  if (deltaValues.length > 0) {
    const rows = await db
      .insert(followDeltas)
      .values(deltaValues)
      .onConflictDoNothing({
        target: [
          followDeltas.targetId,
          followDeltas.direction,
          followDeltas.change,
          followDeltas.igAccountId,
          followDeltas.toSnapshotId,
        ],
      })
      .returning({ id: followDeltas.id });
    insertedDeltas = rows.length;
  }

  return { diff, insertedDeltas };
}

export interface DeltaWithAccount extends FollowDeltaRecord {
  username: string;
  displayName: string | null;
}

export async function listRecentDeltas(
  db: Database,
  targetId: string,
  options: { direction?: FollowDirection; limit?: number; since?: Date } = {},
): Promise<DeltaWithAccount[]> {
  const conditions = [eq(followDeltas.targetId, targetId)];
  if (options.direction !== undefined) {
    conditions.push(eq(followDeltas.direction, options.direction));
  }
  if (options.since !== undefined) {
    conditions.push(gte(followDeltas.firstSeenAt, options.since));
  }

  return db
    .select({
      id: followDeltas.id,
      targetId: followDeltas.targetId,
      direction: followDeltas.direction,
      change: followDeltas.change,
      igAccountId: followDeltas.igAccountId,
      firstSeenAt: followDeltas.firstSeenAt,
      fromSnapshotId: followDeltas.fromSnapshotId,
      toSnapshotId: followDeltas.toSnapshotId,
      confidence: followDeltas.confidence,
      createdAt: followDeltas.createdAt,
      username: igAccounts.username,
      displayName: igAccounts.displayName,
    })
    .from(followDeltas)
    .innerJoin(igAccounts, sql`${igAccounts.id} = ${followDeltas.igAccountId}`)
    .where(and(...conditions))
    .orderBy(desc(followDeltas.firstSeenAt))
    .limit(options.limit ?? 50);
}

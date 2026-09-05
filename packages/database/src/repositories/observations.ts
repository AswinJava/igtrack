import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  diffProfileFields,
  type Confidence,
  type NormalizedProfile,
  type ProfileFieldChange,
} from "@igtrack/core";
import { evidence, profileChanges, profileSnapshots } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import type { EvidenceRecordInput } from "./types.js";
import { ObservationKind } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type ProfileSnapshotRecord = typeof profileSnapshots.$inferSelect;
export type ProfileChangeRecord = typeof profileChanges.$inferSelect;

function snapshotFieldSet(row: ProfileSnapshotRecord) {
  return {
    username: row.username,
    displayName: row.displayName ?? undefined,
    bio: row.bio ?? undefined,
    profilePicUrl: row.profilePicUrl ?? undefined,
    externalUrl: row.externalUrl ?? undefined,
    followerCount: row.followerCount ?? undefined,
    followingCount: row.followingCount ?? undefined,
    postCount: row.postCount ?? undefined,
    isVerified: row.isVerified ?? undefined,
    isPrivate: row.isPrivate ?? undefined,
  };
}

export interface RecordProfileSnapshotInput {
  profile: NormalizedProfile;
  evidence: EvidenceRecordInput;
}

export interface RecordProfileSnapshotResult {
  snapshot: ProfileSnapshotRecord;
  changes: ProfileChangeRecord[];
  deduplicated: boolean;
}

export async function recordProfileSnapshot(
  db: Database,
  input: RecordProfileSnapshotInput,
): Promise<RecordProfileSnapshotResult> {
  const { profile } = input;
  const observedAt = new Date(profile.meta.observedAt);

  return withTransaction(db, async (tx) => {
    const account = await upsertAccount(tx, {
      username: profile.account.username,
      ...(profile.account.igId !== undefined
        ? { igId: profile.account.igId }
        : {}),
      ...(profile.account.displayName !== undefined
        ? { displayName: profile.account.displayName }
        : {}),
      ...(profile.account.isPrivate !== undefined
        ? { isPrivate: profile.account.isPrivate }
        : {}),
      ...(profile.isVerified !== undefined
        ? { isVerified: profile.isVerified }
        : {}),
      ...(profile.profilePicUrl !== undefined
        ? { profilePicUrl: profile.profilePicUrl }
        : {}),
      ...(profile.bio !== undefined ? { bio: profile.bio } : {}),
      ...(profile.externalUrl !== undefined
        ? { externalUrl: profile.externalUrl }
        : {}),
      seenAt: observedAt,
    });

    const existing = await tx
      .select()
      .from(profileSnapshots)
      .where(
        and(
          eq(profileSnapshots.igAccountId, account.id),
          eq(profileSnapshots.sourceId, input.evidence.source.id),
          eq(profileSnapshots.observedAt, observedAt),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return { snapshot: existingRow, changes: [], deduplicated: true };
    }

    const snapshotId = randomUUID();
    const evidenceId = await upsertEvidence(tx, snapshotId, {
      ...input.evidence,
      observationKind: ObservationKind.PROFILE_SNAPSHOT,
    });

    const snapshotRows = await tx
      .insert(profileSnapshots)
      .values({
        id: snapshotId,
        igAccountId: account.id,
        observedAt,
        sourceId: input.evidence.source.id,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
        username: profile.account.username,
        ...(profile.account.displayName !== undefined
          ? { displayName: profile.account.displayName }
          : {}),
        ...(profile.bio !== undefined ? { bio: profile.bio } : {}),
        ...(profile.profilePicUrl !== undefined
          ? { profilePicUrl: profile.profilePicUrl }
          : {}),
        ...(profile.externalUrl !== undefined
          ? { externalUrl: profile.externalUrl }
          : {}),
        ...(profile.followerCount !== undefined
          ? { followerCount: profile.followerCount }
          : {}),
        ...(profile.followingCount !== undefined
          ? { followingCount: profile.followingCount }
          : {}),
        ...(profile.postCount !== undefined
          ? { postCount: profile.postCount }
          : {}),
        ...(profile.isVerified !== undefined
          ? { isVerified: profile.isVerified }
          : {}),
        ...(profile.account.isPrivate !== undefined
          ? { isPrivate: profile.account.isPrivate }
          : {}),
        category: profile.meta.category,
        confidence: profile.meta.confidence,
      })
      .onConflictDoNothing({
        target: [
          profileSnapshots.igAccountId,
          profileSnapshots.sourceId,
          profileSnapshots.observedAt,
        ],
      })
      .returning();
    const snapshot = snapshotRows[0];
    if (snapshot === undefined) {
      // Lost the insert race after the pre-select missed (reclaim overlap):
      // re-read the winner instead of failing the scan.
      const raced = await tx
        .select()
        .from(profileSnapshots)
        .where(
          and(
            eq(profileSnapshots.igAccountId, account.id),
            eq(profileSnapshots.sourceId, input.evidence.source.id),
            eq(profileSnapshots.observedAt, observedAt),
          ),
        )
        .limit(1);
      const racedRow = raced[0];
      if (racedRow === undefined) {
        throw new Error("igtrack: failed to insert profile snapshot");
      }
      return { snapshot: racedRow, changes: [], deduplicated: true };
    }

    const previousRows = await tx
      .select()
      .from(profileSnapshots)
      .where(
        and(
          eq(profileSnapshots.igAccountId, account.id),
          lt(profileSnapshots.observedAt, observedAt),
        ),
      )
      .orderBy(desc(profileSnapshots.observedAt))
      .limit(1);
    const previous = previousRows[0];

    const changes: ProfileChangeRecord[] = [];
    if (previous !== undefined) {
      const fieldChanges = diffProfileFields(
        snapshotFieldSet(previous),
        snapshotFieldSet(snapshot),
      );
      if (fieldChanges.length > 0) {
        const insertedChanges = await tx
          .insert(profileChanges)
          .values(
            fieldChanges.map((change: ProfileFieldChange) => ({
              igAccountId: account.id,
              field: change.field,
              ...(change.oldValue !== null
                ? { oldValue: String(change.oldValue) }
                : {}),
              ...(change.newValue !== null
                ? { newValue: String(change.newValue) }
                : {}),
              fromSnapshotId: previous.id,
              toSnapshotId: snapshot.id,
              detectedAt: observedAt,
            })),
          )
          .onConflictDoNothing({
            target: [
              profileChanges.igAccountId,
              profileChanges.field,
              profileChanges.toSnapshotId,
            ],
          })
          .returning();
        changes.push(...insertedChanges);
      }
    }

    return { snapshot, changes, deduplicated: false };
  });
}

export async function listProfileSnapshots(
  db: Database,
  igAccountId: string,
  options: { limit?: number } = {},
): Promise<ProfileSnapshotRecord[]> {
  return db
    .select()
    .from(profileSnapshots)
    .where(sql`${profileSnapshots.igAccountId} = ${igAccountId}`)
    .orderBy(desc(profileSnapshots.observedAt))
    .limit(options.limit ?? 100);
}

export async function listProfileChanges(
  db: Database,
  igAccountId: string,
  options: { limit?: number } = {},
): Promise<ProfileChangeRecord[]> {
  return db
    .select()
    .from(profileChanges)
    .where(sql`${profileChanges.igAccountId} = ${igAccountId}`)
    .orderBy(desc(profileChanges.detectedAt))
    .limit(options.limit ?? 100);
}

export async function getEvidenceForObservation(
  db: Database,
  observationKind: string,
  observationId: string,
) {
  const rows = await db
    .select()
    .from(evidence)
    .where(
      and(
        sql`${evidence.observationKind} = ${observationKind}`,
        sql`${evidence.observationId} = ${observationId}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

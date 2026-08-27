import { z } from "zod";
import { and, inArray, sql } from "drizzle-orm";
import {
  evidence,
  followDeltas,
  followSnapshots,
  interactions,
  profileSnapshots,
  stories,
  storyMentions,
  targets,
} from "../schema/index.js";
import type { Database } from "../client/client.js";
import type { DatabaseTx } from "../transactions.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import type { TargetStatus } from "./target-types.js";

const createTargetSchema = z.object({
  userId: z.string().uuid(),
  username: z.string().min(1),
  localName: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export interface CreateTargetInput {
  userId: string;
  username: string;
  localName?: string;
  notes?: string;
  tags?: string[];
}

export type TargetRecord = typeof targets.$inferSelect;

export async function createTarget(
  db: Database,
  input: CreateTargetInput,
): Promise<{ target: TargetRecord; created: boolean }> {
  const parsed = createTargetSchema.parse(input);

  return withTransaction(db, async (tx) => {
    const account = await upsertAccount(tx, { username: parsed.username });

    const existing = await tx
      .select()
      .from(targets)
      .where(
        and(
          sql`${targets.userId} = ${parsed.userId}`,
          sql`${targets.igAccountId} = ${account.id}`,
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return { target: existingRow, created: false };
    }

    const rows = await tx
      .insert(targets)
      .values({
        userId: parsed.userId,
        igAccountId: account.id,
        ...(parsed.localName !== undefined ? { localName: parsed.localName } : {}),
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
        tags: parsed.tags ?? [],
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("igtrack: failed to create target");
    }
    return { target: row, created: true };
  });
}

export async function listTargets(
  db: DatabaseTx | Database,
  userId: string,
): Promise<TargetRecord[]> {
  return db
    .select()
    .from(targets)
    .where(sql`${targets.userId} = ${userId}`)
    .orderBy(sql`${targets.createdAt} ASC`);
}

export async function getTarget(
  db: DatabaseTx | Database,
  targetId: string,
): Promise<TargetRecord | null> {
  const rows = await db
    .select()
    .from(targets)
    .where(sql`${targets.id} = ${targetId}`)
    .limit(1);
  return rows[0] ?? null;
}

export async function setTargetStatus(
  db: Database,
  targetId: string,
  status: TargetStatus,
): Promise<TargetRecord> {
  const rows = await db
    .update(targets)
    .set({ status, updatedAt: new Date() })
    .where(sql`${targets.id} = ${targetId}`)
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`igtrack: target ${targetId} not found`);
  }
  return row;
}

export async function updateTargetMeta(
  db: Database,
  targetId: string,
  updates: { localName?: string; notes?: string; tags?: string[] },
): Promise<TargetRecord> {
  const rows = await db
    .update(targets)
    .set({
      ...(updates.localName !== undefined ? { localName: updates.localName } : {}),
      ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
      updatedAt: new Date(),
    })
    .where(sql`${targets.id} = ${targetId}`)
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`igtrack: target ${targetId} not found`);
  }
  return row;
}

export async function deleteTargetWithObservations(
  db: Database,
  targetId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const target = await getTarget(tx, targetId);
    if (target === null) return;
    const accountId = target.igAccountId;

    const mentionIds = await tx
      .select({ id: storyMentions.id })
      .from(storyMentions)
      .innerJoin(stories, sql`${stories.id} = ${storyMentions.storyDbId}`)
      .where(sql`${stories.igAccountId} = ${accountId}`);

    const deletedSnapshotIds = await tx
      .delete(profileSnapshots)
      .where(sql`${profileSnapshots.igAccountId} = ${accountId}`)
      .returning({ id: profileSnapshots.id });
    const deletedStoryIds = await tx
      .delete(stories)
      .where(sql`${stories.igAccountId} = ${accountId}`)
      .returning({ id: stories.id });
    const deletedInteractionIds = await tx
      .delete(interactions)
      .where(sql`${interactions.targetId} = ${targetId}`)
      .returning({ id: interactions.id });
    const deletedFollowSnapshotIds = await tx
      .delete(followSnapshots)
      .where(sql`${followSnapshots.targetId} = ${targetId}`)
      .returning({ id: followSnapshots.id });
    await tx
      .delete(followDeltas)
      .where(sql`${followDeltas.targetId} = ${targetId}`);

    const observationIds = [
      ...deletedSnapshotIds.map((r) => r.id),
      ...deletedStoryIds.map((r) => r.id),
      ...deletedInteractionIds.map((r) => r.id),
      ...deletedFollowSnapshotIds.map((r) => r.id),
      ...mentionIds.map((r) => r.id),
    ];
    if (observationIds.length > 0) {
      await tx
        .delete(evidence)
        .where(inArray(evidence.observationId, observationIds));
    }

    await tx.delete(targets).where(sql`${targets.id} = ${targetId}`);
  });
}

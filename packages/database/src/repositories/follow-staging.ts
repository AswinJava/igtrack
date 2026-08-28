import { sql } from "drizzle-orm";
import type { NormalizedFollowEntry } from "@igtrack/core";
import { followScanStaging } from "../schema/index.js";
import type { Database } from "../client/client.js";

// PC-T2: durable acquired-member staging for follow scans. The checkpoint
// stores only cursor/page; members accumulate append-only here. See
// docs/phase-8-failure-matrix.md for the correctness contract.

export interface StagedFollowMember {
  username: string;
  igId?: string;
}

export interface StageFollowScanMembersInput {
  jobId: string;
  targetId: string;
  entries: NormalizedFollowEntry[];
}

// Idempotent append: duplicate pages and reclaim re-execution dedupe on the
// (job_id, username_lower) unique index. Returns the number of NEW rows.
export async function stageFollowScanMembers(
  db: Database,
  input: StageFollowScanMembersInput,
): Promise<number> {
  if (input.entries.length === 0) return 0;
  const inserted = await db
    .insert(followScanStaging)
    .values(
      input.entries.map((entry) => ({
        jobId: input.jobId,
        targetId: input.targetId,
        username: entry.username,
        usernameLower: entry.username.toLowerCase(),
        ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
      })),
    )
    .onConflictDoNothing({
      target: [followScanStaging.jobId, followScanStaging.usernameLower],
    })
    .returning({ id: followScanStaging.id });
  return inserted.length;
}

// Abandoned staging from other (crashed/superseded) jobs of this target is
// removed at scan start. The current job's rows — the resume basis for a
// reclaim — are preserved.
export async function clearForeignFollowScanStaging(
  db: Database,
  input: { targetId: string; keepJobId: string },
): Promise<void> {
  await db
    .delete(followScanStaging)
    .where(
      sql`${followScanStaging.targetId} = ${input.targetId}
        AND ${followScanStaging.jobId} <> ${input.keepJobId}`,
    );
}

export async function clearStagedFollowScanMembers(
  db: Database,
  jobId: string,
): Promise<void> {
  await db
    .delete(followScanStaging)
    .where(sql`${followScanStaging.jobId} = ${jobId}`);
}

// First-acquisition order (id asc) feeds snapshot construction on completion.
export async function loadStagedFollowScanMembers(
  db: Database,
  jobId: string,
): Promise<StagedFollowMember[]> {
  const rows = await db
    .select({
      username: followScanStaging.username,
      igId: followScanStaging.igId,
    })
    .from(followScanStaging)
    .where(sql`${followScanStaging.jobId} = ${jobId}`)
    .orderBy(followScanStaging.id);
  return rows.map((r) => ({
    username: r.username,
    ...(r.igId !== null ? { igId: r.igId } : {}),
  }));
}

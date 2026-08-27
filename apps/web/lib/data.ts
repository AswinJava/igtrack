import {
  listTargetsForUser,
  getDashboardOverview,
  getUserActivityFeed,
  getOwnedTargetDetail,
  getRelationshipsForUser,
  listScopedEvidence,
  getEvidenceChain,
  getOperationsSnapshot,
  type TargetDetailBundle,
  type EvidenceChainDetail,
  type OperationsSnapshot,
} from "@igtrack/database";
import { requirePageUser } from "./auth";
import { getDatabase } from "./db.js";

export type { TargetListItem } from "@igtrack/database";
export type { ActivityItem } from "@igtrack/database";
export type { RelationshipRank } from "@igtrack/database";
export type { DashboardOverview } from "@igtrack/database";
export type { JobQueueSummary } from "@igtrack/database";

export async function getTargets() {
  const session = await requirePageUser();
  return listTargetsForUser(getDatabase(), session.userId);
}

export async function getDashboardData() {
  const session = await requirePageUser();
  return getDashboardOverview(getDatabase(), session.userId);
}

export async function getTargetById(id: string): Promise<TargetDetailBundle | null> {
  const session = await requirePageUser();
  return getOwnedTargetDetail(getDatabase(), session.userId, id);
}

export async function getActivityFeed(limit = 30) {
  const session = await requirePageUser();
  return getUserActivityFeed(getDatabase(), session.userId, limit);
}

export async function getRelationships(targetId: string) {
  const session = await requirePageUser();
  return getRelationshipsForUser(getDatabase(), session.userId, targetId);
}

// Pages consume snake_case evidence rows from Phase 3; this is a presentation
// mapping only — filtering/scoping happens in the database repository.
function toLegacyEvidenceRow(r: Awaited<ReturnType<typeof listScopedEvidence>>[number]) {
  return {
    id: r.id,
    observation_kind: r.observation_kind,
    observation_id: r.observation_id,
    source_id: r.source_id,
    observed_at: r.observed_at,
    captured_at: r.captured_at,
    confidence: r.confidence,
    raw_hash: r.raw_hash,
    normalized_hash: r.normalized_hash,
  };
}

export async function getEvidenceList(limit = 30) {
  const session = await requirePageUser();
  const rows = await listScopedEvidence(getDatabase(), session.userId, limit);
  return rows.map(toLegacyEvidenceRow);
}

export type LegacyEvidenceRow = ReturnType<typeof toLegacyEvidenceRow>;

export async function getEvidenceDetail(
  id: string,
): Promise<EvidenceChainDetail | null> {
  const session = await requirePageUser();
  return getEvidenceChain(getDatabase(), session.userId, id);
}

export type { EvidenceChainDetail, OperationsSnapshot };

export async function getDiagnostics(): Promise<OperationsSnapshot> {
  await requirePageUser();
  return getOperationsSnapshot(getDatabase());
}

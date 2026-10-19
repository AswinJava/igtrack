import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { researchDocuments, researchRuns } from "../schema/index.js";
import type { Database } from "../client/client.js";

// ---------------------------------------------------------------------------
// Research runs and their per-document coverage (FOUNDING §19, D69).
//
// A run records what the ENGINE attempted and what came of it — refusals and
// failures included, because "we could not fetch this, and here is exactly
// why" is a finding. Claims extracted by the run go to the claims ledger
// through the same validation gate as operator claims; nothing is written
// here that bypasses it.
// ---------------------------------------------------------------------------

export type ResearchRunRecord = typeof researchRuns.$inferSelect;
export type ResearchDocumentRecord = typeof researchDocuments.$inferSelect;

export interface CreateResearchRunInput {
  userId: string;
  targetId: string;
  question: string;
  focusIntent: string;
  focusPriorities: readonly string[];
  focusRationale: string;
  maxSources: number;
  maxDepth: number;
  searchProvider: string | null;
  searchQueries: readonly string[];
  searchUnavailableReason: string | null;
  operatorUrlCount: number;
  boundsTruncated: number;
  startedAt: Date;
}

export interface FinishResearchRunInput {
  runId: string;
  userId: string;
  status: "COMPLETED" | "COMPLETED_PARTIAL" | "FAILED";
  documentsPlanned: number;
  documentsFetched: number;
  documentsFailed: number;
  candidatesFound: number;
  claimsStored: number;
  claimsDuplicate: number;
  claimsRefused: number;
  finishedAt: Date;
}

export interface AddResearchDocumentInput {
  runId: string;
  userId: string;
  url: string;
  sourceType: string;
  outcome:
    | "FETCHED"
    | "REUSED"
    | "FAILED"
    | "BLOCKED_BY_POLICY"
    | "BLOCKED_BY_ROBOTS"
    | "UNSAFE_URL"
    | "BLOCKED_CONTENT_TYPE"
    | "TOO_LARGE"
    | "TIMEOUT"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "NETWORK_ERROR";
  outcomeReason: string | null;
  httpStatus: number | null;
  title: string | null;
  contentType: string | null;
  byteSize: number | null;
  contentSha256: string | null;
  retrievedAt: Date | null;
  candidatesFound: number;
  linksNotFollowed: number;
}

export async function createResearchRun(
  db: Database,
  input: CreateResearchRunInput,
): Promise<ResearchRunRecord> {
  const rows = await db
    .insert(researchRuns)
    .values({
      id: randomUUID(),
      userId: input.userId,
      targetId: input.targetId,
      question: input.question,
      focusIntent: input.focusIntent,
      focusPriorities: [...input.focusPriorities],
      focusRationale: input.focusRationale,
      maxSources: input.maxSources,
      maxDepth: input.maxDepth,
      searchProvider: input.searchProvider,
      searchQueries: [...input.searchQueries],
      searchUnavailableReason: input.searchUnavailableReason,
      operatorUrlCount: input.operatorUrlCount,
      boundsTruncated: input.boundsTruncated,
      status: "COMPLETED_PARTIAL",
      startedAt: input.startedAt,
      finishedAt: input.startedAt,
    })
    .returning();
  const created = rows[0];
  if (created === undefined) throw new Error("research run insert returned no row");
  return created;
}

export async function finishResearchRun(
  db: Database,
  input: FinishResearchRunInput,
): Promise<ResearchRunRecord> {
  const rows = await db
    .update(researchRuns)
    .set({
      status: input.status,
      documentsPlanned: input.documentsPlanned,
      documentsFetched: input.documentsFetched,
      documentsFailed: input.documentsFailed,
      candidatesFound: input.candidatesFound,
      claimsStored: input.claimsStored,
      claimsDuplicate: input.claimsDuplicate,
      claimsRefused: input.claimsRefused,
      finishedAt: input.finishedAt,
    })
    .where(and(eq(researchRuns.id, input.runId), eq(researchRuns.userId, input.userId)))
    .returning();
  const updated = rows[0];
  if (updated === undefined) throw new Error("research run finish returned no row");
  return updated;
}

export async function addResearchDocument(
  db: Database,
  input: AddResearchDocumentInput,
): Promise<ResearchDocumentRecord> {
  const rows = await db
    .insert(researchDocuments)
    .values({
      id: randomUUID(),
      runId: input.runId,
      userId: input.userId,
      url: input.url,
      sourceType: input.sourceType,
      outcome: input.outcome,
      outcomeReason: input.outcomeReason,
      httpStatus: input.httpStatus,
      title: input.title,
      contentType: input.contentType,
      byteSize: input.byteSize,
      contentSha256: input.contentSha256,
      retrievedAt: input.retrievedAt,
      candidatesFound: input.candidatesFound,
      linksNotFollowed: input.linksNotFollowed,
    })
    .returning();
  const created = rows[0];
  if (created === undefined) throw new Error("research document insert returned no row");
  return created;
}

export async function listResearchRuns(
  db: Database,
  input: { userId: string; targetId: string; limit?: number },
): Promise<ResearchRunRecord[]> {
  return db
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.userId, input.userId), eq(researchRuns.targetId, input.targetId)))
    .orderBy(desc(researchRuns.startedAt), desc(researchRuns.id))
    .limit(input.limit ?? 10);
}

export async function getResearchRun(
  db: Database,
  input: { userId: string; runId: string },
): Promise<ResearchRunRecord | null> {
  const rows = await db
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.userId, input.userId), eq(researchRuns.id, input.runId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listResearchDocuments(
  db: Database,
  input: { userId: string; runId: string },
): Promise<ResearchDocumentRecord[]> {
  return db
    .select()
    .from(researchDocuments)
    .where(and(eq(researchDocuments.userId, input.userId), eq(researchDocuments.runId, input.runId)))
    .orderBy(desc(researchDocuments.recordedAt), desc(researchDocuments.id));
}

/**
 * Freshness lookup (D69): the most recent FETCHED document for this URL by
 * this user, regardless of target — a page fetched five minutes ago for one
 * account is still fresh for another. The caller enforces the window.
 */
export async function findFreshFetchedDocument(
  db: Database,
  input: { userId: string; url: string; since: Date },
): Promise<ResearchDocumentRecord | null> {
  const rows = await db
    .select()
    .from(researchDocuments)
    .where(
      and(
        eq(researchDocuments.userId, input.userId),
        eq(researchDocuments.url, input.url),
        eq(researchDocuments.outcome, "FETCHED"),
        gte(researchDocuments.retrievedAt, input.since),
      ),
    )
    .orderBy(desc(researchDocuments.retrievedAt))
    .limit(1);
  return rows[0] ?? null;
}

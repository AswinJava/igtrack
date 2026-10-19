import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  AppError,
  AppErrorCode,
  type ClaimPredicate,
  type ClaimSourceKind,
} from "@igtrack/core";
import { claims } from "../schema/index.js";
import type { Database } from "../client/client.js";

// ---------------------------------------------------------------------------
// The claims ledger (FOUNDING §18, D67). Writes only: a claim carries its
// source, and a duplicate submission is REFUSED — re-submitting the same
// finding is not corroboration, so the dedup index is an honesty mechanism,
// not a convenience. Policy (which predicates exist, which are refused) lives
// in @igtrack/core; this repository enforces shape and ownership.
// ---------------------------------------------------------------------------

export type ClaimRecord = typeof claims.$inferSelect;

export interface AddClaimInput {
  userId: string;
  targetId: string;
  predicate: ClaimPredicate;
  value: string;
  sourceKind: ClaimSourceKind;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  excerpt?: string | null;
  statedAt?: Date | null;
  retrievedAt?: Date | null;
  /** The research run that extracted this claim (provenance only; no FK). */
  researchRunId?: string | null;
}

export interface ListClaimsInput {
  userId: string;
  targetId: string;
  predicate?: ClaimPredicate | undefined;
  includeRetracted?: boolean | undefined;
}

export interface RetractClaimInput {
  userId: string;
  claimId: string;
  reason: string;
  now?: Date | undefined;
}

export function hashClaimExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt, "utf8").digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: unknown }).code;
  if (direct === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}

async function findDuplicate(
  db: Database,
  input: Pick<AddClaimInput, "targetId" | "predicate" | "value" | "sourceUrl">,
): Promise<ClaimRecord | undefined> {
  const sourceUrl =
    input.sourceUrl === undefined || input.sourceUrl === null
      ? isNull(claims.sourceUrl)
      : eq(claims.sourceUrl, input.sourceUrl);
  const rows = await db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.targetId, input.targetId),
        eq(claims.predicate, input.predicate),
        eq(claims.value, input.value),
        sourceUrl,
      ),
    )
    .limit(1);
  return rows[0];
}

export async function addClaim(db: Database, input: AddClaimInput): Promise<ClaimRecord> {
  const sourceUrl = input.sourceUrl ?? null;
  const excerpt = input.excerpt ?? null;
  try {
    const rows = await db
      .insert(claims)
      .values({
        userId: input.userId,
        targetId: input.targetId,
        predicate: input.predicate,
        value: input.value,
        sourceKind: input.sourceKind,
        sourceUrl,
        ...(input.sourceTitle !== undefined && input.sourceTitle !== null
          ? { sourceTitle: input.sourceTitle }
          : {}),
        ...(excerpt !== null
          ? { excerpt, excerptHash: hashClaimExcerpt(excerpt) }
          : {}),
        ...(input.statedAt !== undefined && input.statedAt !== null
          ? { statedAt: input.statedAt }
          : {}),
        ...(input.retrievedAt !== undefined && input.retrievedAt !== null
          ? { retrievedAt: input.retrievedAt }
          : {}),
        ...(input.researchRunId !== undefined && input.researchRunId !== null
          ? { researchRunId: input.researchRunId }
          : {}),
      })
      .returning();
    const created = rows[0];
    if (created === undefined) {
      throw new AppError(AppErrorCode.DATABASE_ERROR, "Claim insert returned no row");
    }
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await findDuplicate(db, {
      targetId: input.targetId,
      predicate: input.predicate,
      value: input.value,
      sourceUrl,
    });
    throw new AppError(
      AppErrorCode.CONFLICT,
      existing === undefined
        ? "This claim is already recorded."
        : `This claim is already recorded (claim ${existing.id}).`,
      existing === undefined ? {} : { details: { existingClaimId: existing.id } },
    );
  }
}

export async function listClaims(
  db: Database,
  input: ListClaimsInput,
): Promise<ClaimRecord[]> {
  return db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.userId, input.userId),
        eq(claims.targetId, input.targetId),
        ...(input.predicate !== undefined ? [eq(claims.predicate, input.predicate)] : []),
        ...(input.includeRetracted === true ? [] : [eq(claims.status, "ACTIVE")]),
      ),
    )
    .orderBy(asc(claims.recordedAt), asc(claims.id));
}

export async function getClaimForUser(
  db: Database,
  input: { userId: string; claimId: string },
): Promise<ClaimRecord | null> {
  const rows = await db
    .select()
    .from(claims)
    .where(and(eq(claims.userId, input.userId), eq(claims.id, input.claimId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function retractClaim(
  db: Database,
  input: RetractClaimInput,
): Promise<ClaimRecord> {
  const existing = await getClaimForUser(db, {
    userId: input.userId,
    claimId: input.claimId,
  });
  if (existing === null) {
    throw new AppError(AppErrorCode.NOT_FOUND, `No claim ${input.claimId} is recorded for this owner.`);
  }
  if (existing.status === "RETRACTED") {
    throw new AppError(
      AppErrorCode.CONFLICT,
      `Claim ${input.claimId} is already retracted (reason: ${existing.retractionReason ?? "none recorded"}).`,
    );
  }
  const rows = await db
    .update(claims)
    .set({
      status: "RETRACTED",
      retractedAt: input.now ?? new Date(),
      retractionReason: input.reason,
    })
    .where(and(eq(claims.userId, input.userId), eq(claims.id, input.claimId)))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new AppError(AppErrorCode.DATABASE_ERROR, "Claim retraction returned no row");
  }
  return updated;
}

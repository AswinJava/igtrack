import { sql } from "drizzle-orm";
import { jobCheckpoints, monitoringJobs } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { computeBackoffMs, type BackoffOptions } from "./backoff.js";

export type JobRecord = typeof monitoringJobs.$inferSelect;
export type JobStatus = typeof monitoringJobs.$inferSelect.status;

export class JobStateError extends Error {
  constructor(
    readonly jobId: string,
    message: string,
  ) {
    super(message);
    this.name = "JobStateError";
  }
}

export interface EnqueueJobInput {
  kind: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
  idempotencyKey?: string;
}

export interface EnqueueJobResult {
  job: JobRecord;
  deduplicated: boolean;
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

export async function enqueueJob(
  db: Database,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
  if (input.idempotencyKey !== undefined) {
    const existing = await db
      .select()
      .from(monitoringJobs)
      .where(sql`${monitoringJobs.idempotencyKey} = ${input.idempotencyKey}`)
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      return { job: existingRow, deduplicated: true };
    }
  }

  try {
    const rows = await db
      .insert(monitoringJobs)
      .values({
        kind: input.kind,
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        payload: input.payload ?? {},
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.maxAttempts !== undefined
          ? { maxAttempts: input.maxAttempts }
          : {}),
        ...(input.availableAt !== undefined
          ? { availableAt: input.availableAt }
          : {}),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("igtrack: failed to enqueue job");
    }
    return { job: row, deduplicated: false };
  } catch (err) {
    if (input.idempotencyKey !== undefined && isUniqueViolation(err)) {
      const existing = await db
        .select()
        .from(monitoringJobs)
        .where(sql`${monitoringJobs.idempotencyKey} = ${input.idempotencyKey}`)
        .limit(1);
      const existingRow = existing[0];
      if (existingRow !== undefined) {
        return { job: existingRow, deduplicated: true };
      }
    }
    throw err;
  }
}

interface ClaimableJobRow {
  id: string;
  kind: string;
  target_id: string | null;
  idempotency_key: string | null;
  payload: unknown;
  priority: number;
  status: JobStatus;
  outcome: (typeof monitoringJobs.$inferSelect)["outcome"];
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  error: unknown;
  created_at: Date;
  updated_at: Date;
}

function mapJobRow(row: ClaimableJobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    priority: row.priority,
    status: row.status,
    outcome: row.outcome,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ClaimJobOptions {
  // Lease duration for `running` jobs. A job whose lock is older than the
  // lease is considered abandoned and may be reclaimed (attempts permitting).
  // Deterministic tests pass leaseMs: 0 to reclaim immediately.
  leaseMs?: number;
}

const DEFAULT_LEASE_MS = 300_000;

function resolveLeaseMs(options: ClaimJobOptions): number {
  const raw =
    options.leaseMs ??
    Number(process.env.IGTRACK_JOB_LEASE_MS ?? DEFAULT_LEASE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LEASE_MS;
}

export async function claimJob(
  db: Database,
  workerId: string,
  options: ClaimJobOptions = {},
): Promise<JobRecord | null> {
  const leaseSeconds = resolveLeaseMs(options) / 1000;

  // Terminal reap: stale running jobs with no attempts left fail outright, so
  // an exhausted job can never churn through reclaim cycles forever.
  await db.execute(sql`
    UPDATE monitoring_jobs
    SET status = 'failed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        updated_at = now(),
        error = coalesce(
          monitoring_jobs.error,
          jsonb_build_object(
            'message', 'worker lease expired after the final attempt',
            'kind', 'LEASE_EXPIRED',
            'retryable', false
          )
        )
    WHERE monitoring_jobs.status = 'running'
      AND monitoring_jobs.locked_at IS NOT NULL
      AND monitoring_jobs.locked_at < now() - make_interval(secs => ${leaseSeconds})
      AND monitoring_jobs.attempts >= monitoring_jobs.max_attempts
  `);

  // Claim due queued/retry_wait jobs, or reclaim stale running jobs that still
  // have attempts left. Same-kind same-target serialization: never two running
  // jobs of the same kind against the same target (checkpoint isolation).
  const rows = await db.execute(sql<ClaimableJobRow>`
    UPDATE monitoring_jobs
    SET status = 'running',
        attempts = monitoring_jobs.attempts + 1,
        locked_at = now(),
        locked_by = ${workerId},
        started_at = coalesce(monitoring_jobs.started_at, now()),
        updated_at = now()
    WHERE monitoring_jobs.id = (
      SELECT monitoring_jobs.id
      FROM monitoring_jobs
      WHERE (
        (monitoring_jobs.status IN ('queued', 'retry_wait')
          AND monitoring_jobs.available_at <= now())
        OR
        (monitoring_jobs.status = 'running'
          AND monitoring_jobs.locked_at IS NOT NULL
          AND monitoring_jobs.locked_at < now() - make_interval(secs => ${leaseSeconds})
          AND monitoring_jobs.attempts < monitoring_jobs.max_attempts)
      )
      AND NOT EXISTS (
        SELECT 1 FROM monitoring_jobs other
        WHERE other.kind = monitoring_jobs.kind
          AND other.target_id IS NOT DISTINCT FROM monitoring_jobs.target_id
          AND other.status = 'running'
          AND other.id <> monitoring_jobs.id
      )
      ORDER BY monitoring_jobs.priority DESC,
               monitoring_jobs.available_at ASC,
               monitoring_jobs.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING monitoring_jobs.*
  `);
  const row = Array.from(rows)[0] as ClaimableJobRow | undefined;
  if (row === undefined) return null;
  return mapJobRow(row);
}

export async function completeJob(
  db: Database,
  jobId: string,
  workerId: string,
  outcome?: typeof monitoringJobs.$inferSelect.outcome,
): Promise<JobRecord> {
  const rows = await db
    .update(monitoringJobs)
    .set({
      status: "succeeded",
      outcome: outcome ?? null,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(
      sql`${monitoringJobs.id} = ${jobId}
        AND ${monitoringJobs.status} = 'running'
        AND ${monitoringJobs.lockedBy} = ${workerId}`,
    )
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new JobStateError(
      jobId,
      `job ${jobId} is not running under worker ${workerId}`,
    );
  }
  return row;
}

export interface FailJobInput {
  message: string;
  kind?: string;
  retryable?: boolean;
  // Provider-supplied retry delay (STEP 10): honored verbatim as the retry's
  // availability time instead of exponential backoff.
  retryAfterMs?: number;
}

export async function failJob(
  db: Database,
  jobId: string,
  workerId: string,
  error: FailJobInput,
  backoff: BackoffOptions = {},
): Promise<JobRecord> {
  const current = await db
    .select()
    .from(monitoringJobs)
    .where(
      sql`${monitoringJobs.id} = ${jobId}
        AND ${monitoringJobs.status} = 'running'
        AND ${monitoringJobs.lockedBy} = ${workerId}`,
    )
    .limit(1);
  const job = current[0];
  if (job === undefined) {
    throw new JobStateError(
      jobId,
      `job ${jobId} is not running under worker ${workerId}`,
    );
  }

  const retryable = error.retryable ?? true;
  const willRetry = retryable && job.attempts < job.maxAttempts;

  const rows = await db
    .update(monitoringJobs)
    .set({
      status: willRetry ? "retry_wait" : "failed",
      ...(willRetry
        ? {
            availableAt: new Date(
              Date.now() +
                (error.retryAfterMs ?? computeBackoffMs(job.attempts, backoff)),
            ),
          }
        : { completedAt: new Date() }),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
      error: {
        message: error.message,
        ...(error.kind !== undefined ? { kind: error.kind } : {}),
        retryable,
        failedAt: new Date().toISOString(),
        attempt: job.attempts,
      },
    })
    // Ownership re-checked in the UPDATE itself: a lease reclaim that happened
    // between the SELECT and here must never be clobbered by a stale worker.
    .where(
      sql`${monitoringJobs.id} = ${jobId}
        AND ${monitoringJobs.status} = 'running'
        AND ${monitoringJobs.lockedBy} = ${workerId}`,
    )
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new JobStateError(
      jobId,
      `job ${jobId} is not running under worker ${workerId}`,
    );
  }
  return row;
}

export async function cancelJob(
  db: Database,
  jobId: string,
): Promise<JobRecord | null> {
  const rows = await db
    .update(monitoringJobs)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(
      sql`${monitoringJobs.id} = ${jobId}
        AND ${monitoringJobs.status} IN ('queued', 'retry_wait')`,
    )
    .returning();
  return rows[0] ?? null;
}

export async function getJob(
  db: Database,
  jobId: string,
): Promise<JobRecord | null> {
  const rows = await db
    .select()
    .from(monitoringJobs)
    .where(sql`${monitoringJobs.id} = ${jobId}`)
    .limit(1);
  return rows[0] ?? null;
}

export async function queueDepth(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(monitoringJobs)
    .where(sql`${monitoringJobs.status} IN ('queued', 'retry_wait', 'running')`);
  return rows[0]?.count ?? 0;
}

// Production retention: terminal job rows (succeeded/failed/cancelled) grow
// unbounded otherwise. Default 90 days via IGTRACK_JOBS_RETENTION_DAYS.
// Only rows with completed_at older than the cutoff are removed; running or
// retryable rows are never touched. Returns the deleted count for logging.
export function resolveJobsRetentionDays(raw?: string): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  const fromEnv = Number(process.env.IGTRACK_JOBS_RETENTION_DAYS ?? Number.NaN);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 90;
}

export async function purgeTerminalJobs(
  db: Database,
  retentionDays?: number,
): Promise<number> {
  const days = resolveJobsRetentionDays(
    retentionDays === undefined ? undefined : String(retentionDays),
  );
  const rows = await db
    .delete(monitoringJobs)
    .where(
      sql`${monitoringJobs.status} IN ('succeeded', 'failed', 'cancelled')
        AND ${monitoringJobs.completedAt} IS NOT NULL
        AND ${monitoringJobs.completedAt} < now() - make_interval(days => ${days})`,
    )
    .returning({ id: monitoringJobs.id });
  return rows.length;
}

export interface CheckpointInput {
  targetId: string;
  kind: string;
  jobId?: string;
  cursor?: string;
  page?: number;
  progress?: Record<string, unknown>;
}

export async function saveCheckpoint(
  db: Database,
  input: CheckpointInput,
): Promise<void> {
  await db
    .insert(jobCheckpoints)
    .values({
      targetId: input.targetId,
      kind: input.kind,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobCheckpoints.targetId, jobCheckpoints.kind],
      set: {
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        updatedAt: new Date(),
      },
    });
}

export async function loadCheckpoint(
  db: Database,
  targetId: string,
  kind: string,
): Promise<typeof jobCheckpoints.$inferSelect | null> {
  const rows = await db
    .select()
    .from(jobCheckpoints)
    .where(
      sql`${jobCheckpoints.targetId} = ${targetId}
        AND ${jobCheckpoints.kind} = ${kind}`,
    )
    .limit(1);
  return rows[0] ?? null;
}

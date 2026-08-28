import { PostgresError } from "postgres";
import {
  claimJob,
  completeJob,
  failJob,
  getTarget,
  JobStateError,
  type Database,
  type FailJobInput,
  type JobRecord,
} from "@igtrack/database";
import {
  JobExecutionError,
  runFollowerScan,
  runFollowingScan,
  runProfileScan,
  runStoryScan,
  type ExecutionSource,
  type JobResult,
} from "./provider.js";

export type { ExecutionSource, JobResult, FollowerScanOptions } from "./provider.js";
export { createExecutionSource, providerFromEnv, defaultFixturesDir } from "./provider.js";

export type RunOutcomeState =
  | "succeeded"
  | "retry_wait"
  | "failed"
  | "lost"
  | "unrecorded"
  | "none";

export interface RunOutcome {
  claimed: boolean;
  jobId: string | null;
  kind: string | null;
  state: RunOutcomeState;
}

function truncate(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? truncate(err.message) : truncate(String(err));
}

// Structured, secret-free worker logging: event + context only, never
// provider payloads, credentials, or job data.
function logWorker(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// postgres.js surfaces connection/server failures as PostgresError; drizzle
// passes them through, sometimes behind a cause chain.
function isInfrastructureError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof PostgresError) return true;
    if (typeof current === "object" && (current as { name?: unknown }).name === "PostgresError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function lostOutcome(job: JobRecord, reason: string): RunOutcome {
  logWorker("warn", "job_ownership_lost", { jobId: job.id, kind: job.kind, reason });
  return { claimed: true, jobId: job.id, kind: job.kind, state: "lost" };
}

async function recordFailure(
  db: Database,
  workerId: string,
  job: JobRecord,
  failure: FailJobInput,
): Promise<RunOutcome> {
  try {
    const row = await failJob(db, job.id, workerId, failure);
    return {
      claimed: true,
      jobId: job.id,
      kind: job.kind,
      state: row.status === "retry_wait" ? "retry_wait" : "failed",
    };
  } catch (err) {
    if (err instanceof JobStateError) {
      return lostOutcome(job, "failure rejected: job is no longer owned by this worker");
    }
    logWorker("error", "job_failure_unrecorded", {
      jobId: job.id,
      kind: job.kind,
      reason: messageOf(err),
    });
    return { claimed: true, jobId: job.id, kind: job.kind, state: "unrecorded" };
  }
}


// Executes a claimed job through the execute → complete/fail boundary.
// Never throws: failures are classified and surfaced through RunOutcome.state
// so one bad job or one infrastructure blip can never kill the daemon.
//   execution failure  → JobExecutionError semantics (retry_wait or failed)
//   ownership race     → "lost" (job belongs to another worker now)
//   infrastructure     → retryable DATABASE failure; "unrecorded" when even
//                        recording fails (job stays running; lease reclaims it)
//   programming error  → non-retryable UNEXPECTED failure
export async function executeOne(
  db: Database,
  workerId: string,
  src: ExecutionSource,
  job: JobRecord,
): Promise<RunOutcome> {
  // Target lifecycle guard: scans only run for ACTIVE targets. A pause that
  // happened after the scheduler enqueued the job must never produce a scan.
  if (job.targetId !== null) {
    const target = await getTarget(db, job.targetId);
    if (target !== null && target.status !== "ACTIVE") {
      const outcome = target.status === "PAUSED" ? "SKIPPED_PAUSED" : "SKIPPED_STOPPED";
      try {
        await completeJob(db, job.id, workerId, outcome);
        logWorker("info", "job_skipped_target_inactive", {
          jobId: job.id,
          kind: job.kind,
          targetStatus: target.status,
        });
        return { claimed: true, jobId: job.id, kind: job.kind, state: "succeeded" };
      } catch (err) {
        if (err instanceof JobStateError) {
          return lostOutcome(job, "skip rejected: job is no longer owned by this worker");
        }
        logWorker("error", "job_skip_unrecorded", {
          jobId: job.id,
          kind: job.kind,
          reason: messageOf(err),
        });
        return { claimed: true, jobId: job.id, kind: job.kind, state: "unrecorded" };
      }
    }
  }

  let result: JobResult = "failure";
  try {
    if (job.kind === "PROFILE_SCAN") {
      result = await runProfileScan(db, job, src);
    } else if (job.kind === "FOLLOWER_SCAN") {
      result = await runFollowerScan(db, job, src);
    } else if (job.kind === "FOLLOWING_SCAN") {
      result = await runFollowingScan(db, job, src);
    } else if (job.kind === "STORY_SCAN") {
      result = await runStoryScan(db, job, src);
    } else {
      return await recordFailure(db, workerId, job, {
        message: `Unknown job kind ${job.kind}`,
        kind: "UNKNOWN_JOB",
        retryable: false,
      });
    }
  } catch (err) {
    if (err instanceof JobStateError) {
      return lostOutcome(job, "execution interrupted: job is no longer owned by this worker");
    }
    if (err instanceof JobExecutionError) {
      return await recordFailure(db, workerId, job, {
        message: err.message,
        ...(err.kind !== undefined ? { kind: err.kind } : {}),
        retryable: err.retryable,
      });
    }
    if (isInfrastructureError(err)) {
      return await recordFailure(db, workerId, job, {
        message: `Infrastructure error during job: ${messageOf(err)}`,
        kind: "DATABASE",
        retryable: true,
      });
    }
    logWorker("error", "unexpected_job_error", {
      jobId: job.id,
      kind: job.kind,
      errorName: err instanceof Error ? err.name : typeof err,
      message: messageOf(err),
    });
    return await recordFailure(db, workerId, job, {
      message: `Unexpected worker error: ${messageOf(err)}`,
      kind: "UNEXPECTED",
      retryable: false,
    });
  }

  try {
    // D4 outcome dimension: a succeeded scan with real observations must be
    // distinguishable from an unavailable provider on the job row itself.
    const outcome =
      result === "succeeded"
        ? "COMPLETED"
        : result === "succeeded-empty"
          ? "COMPLETED_EMPTY"
          : result === "succeeded-partial"
            ? "COMPLETED_PARTIAL"
            : result === "unavailable"
              ? "UNAVAILABLE"
              : null;
    await completeJob(db, job.id, workerId, outcome);
    logWorker("info", "job_succeeded", { jobId: job.id, kind: job.kind, outcome });
    return { claimed: true, jobId: job.id, kind: job.kind, state: "succeeded" };
  } catch (err) {
    if (err instanceof JobStateError) {
      return lostOutcome(job, "completion rejected: job is no longer owned by this worker");
    }
    logWorker("error", "job_completion_unrecorded", {
      jobId: job.id,
      kind: job.kind,
      reason: messageOf(err),
    });
    return { claimed: true, jobId: job.id, kind: job.kind, state: "unrecorded" };
  }
}

export async function pollOnce(
  db: Database,
  workerId: string,
  src: ExecutionSource,
): Promise<RunOutcome> {
  const job = await claimJob(db, workerId);
  if (job === null) {
    return { claimed: false, jobId: null, kind: null, state: "none" };
  }
  return executeOne(db, workerId, src, job);
}

export function makeWorkerId(): string {
  return `worker-${process.pid}-${Date.now()}`;
}

// The daemon loop never terminates on recoverable errors: infrastructure
// failures, malformed jobs, and ownership races are logged (never silently
// swallowed) and polling resumes after a backoff sleep.
export async function runWorkerLoop(opts: {
  db: Database;
  src: ExecutionSource;
  pollMs?: number;
  maxIterations?: number;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const { db, src } = opts;
  const pollMs = opts.pollMs ?? Number(process.env.IGTRACK_JOB_POLL_MS ?? 5000);
  const maxIterations = opts.maxIterations ?? Number(process.env.IGTRACK_JOB_MAX_ITER ?? Infinity);
  const workerId = makeWorkerId();
  let iterations = 0;
  for (;;) {
    if (maxIterations !== Infinity && iterations >= maxIterations) break;
    try {
      await pollOnce(db, workerId, src);
    } catch (err) {
      logWorker("warn", "worker_poll_error", { worker: workerId, message: messageOf(err) });
      opts.onError?.(err);
      await delay(pollMs);
    }
    iterations += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


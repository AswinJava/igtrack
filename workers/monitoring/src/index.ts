import { createDb, claimJob, completeJob, failJob, type Database, type JobRecord } from "@igtrack/database";
import {
  runProfileScan,
  runFollowerScan,
  JobExecutionError,
  type ExecutionSource,
} from "./provider.js";

export type { ExecutionSource, JobResult, FollowerScanOptions } from "./provider.js";

export interface RunOutcome {
  claimed: boolean;
  jobId: string | null;
  kind: string | null;
  state: "succeeded" | "retry_wait" | "failed" | "none";
}

// Executes a single job through the full claim → execute → complete/fail loop.
// Provider UNAVAILABLE is completed honestly (not failed): the capability is
// recorded unavailable and nothing is fabricated.
export async function executeOne(
  db: Database,
  workerId: string,
  src: ExecutionSource,
  job: JobRecord,
): Promise<RunOutcome> {
  try {
    if (job.kind === "PROFILE_SCAN") {
      await runProfileScan(db, job, src);
    } else if (job.kind === "FOLLOWER_SCAN") {
      await runFollowerScan(db, job, src);
    } else {
      await failJob(db, job.id, workerId, {
        message: `Unknown job kind ${job.kind}`,
        kind: "UNKNOWN_JOB",
        retryable: false,
      });
      return { claimed: true, jobId: job.id, kind: job.kind, state: "failed" };
    }
    await completeJob(db, job.id, workerId);
    return { claimed: true, jobId: job.id, kind: job.kind, state: "succeeded" };
  } catch (err) {
    const isExec =
      err instanceof JobExecutionError;
    await failJob(db, job.id, workerId, {
      message: isExec ? err.message : `Unexpected worker error: ${String(err)}`,
      kind: isExec ? err.kind : "INTERNAL",
      retryable: isExec ? err.retryable : true,
    });
    const state = isExec && err.retryable ? "retry_wait" : "failed";
    return { claimed: true, jobId: job.id, kind: job.kind, state };
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

export async function runWorkerLoop(opts: {
  db: Database;
  src: ExecutionSource;
  pollMs?: number;
  maxIterations?: number;
}): Promise<void> {
  const { db, src } = opts;
  const pollMs = opts.pollMs ?? Number(process.env.IGTRACK_JOB_POLL_MS ?? 5000);
  const maxIterations = opts.maxIterations ?? Number(process.env.IGTRACK_JOB_MAX_ITER ?? Infinity);
  const workerId = makeWorkerId();
  let iterations = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (maxIterations !== Infinity && iterations >= maxIterations) break;
    const outcome = await pollOnce(db, workerId, src);
    if (!outcome.claimed) {
      await delay(pollMs);
    }
    iterations += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

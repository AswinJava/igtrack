import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJob,
  enqueueJob,
  failJob,
  getOperationsSnapshot,
  listQueueJobs,
  recordSchedulerTickFailure,
  recordSchedulerTickSuccess,
  type DatabaseHandle,
} from "../src/index.js";
import { TEST_DATABASE_URL, createFreshTestDb, probeDatabase } from "./helpers.js";

// ---------------------------------------------------------------------------
// A failure reason is the operator's only lead. Two ways this repo could lose
// one while the data is intact: a reader that asks a flattened text column for
// a `.message` property (always undefined, so the surface reports "no error"
// that was never absent — invariant 7), and a summary that cuts a sentence in
// mid-word so a half instruction reads as the whole recorded reason. Both are
// pinned here against the health surface the CLI and MCP actually render.
// ---------------------------------------------------------------------------

const databaseUp = await probeDatabase(TEST_DATABASE_URL);

describe.skipIf(!databaseUp)("recorded failure reasons reach the health surface", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("surfaces a scheduler failure instead of reporting a false absence", async () => {
    await recordSchedulerTickFailure(handle.db, new Date(), {
      message: "scheduler tick failed: connection refused at 127.0.0.1:5432",
      failedAt: new Date().toISOString(),
    });

    const snapshot = await getOperationsSnapshot(handle.db);
    expect(snapshot.scheduler.lastError).toContain("scheduler tick failed");
    expect(snapshot.scheduler.lastError).toContain("connection refused");
  });

  it("clears the recorded scheduler error after a successful tick", async () => {
    await recordSchedulerTickSuccess(handle.db, new Date());
    const snapshot = await getOperationsSnapshot(handle.db);
    expect(snapshot.scheduler.lastError).toBeNull();
  });

  it("passes a job's own typed reason through whole", async () => {
    const reason =
      'Provider "fixture:v1" does not observe @someone, so nothing was recorded for this target. ' +
      "This is a provider/identity mismatch — it is NOT evidence that the account does not exist.";
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", maxAttempts: 1 });
    const claimed = await claimJob(handle.db, "worker-reason-intact");
    expect(claimed?.id).toBe(job.id);
    await failJob(handle.db, job.id, "worker-reason-intact", {
      message: reason,
      retryable: false,
    });

    const [row] = await listQueueJobs(handle.db, { statuses: ["failed"], limit: 5 });
    expect(row?.errorMessage).toBe(reason.replace(/\s+/g, " ").trim());
  });

  it("marks a long reason as truncated rather than cutting it mid-word", async () => {
    const long = `provider rejected the request. ${"configure a source that covers this account ".repeat(60)}`;
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", maxAttempts: 1 });
    const claimed = await claimJob(handle.db, "worker-reason-truncated");
    expect(claimed?.id).toBe(job.id);
    await failJob(handle.db, job.id, "worker-reason-truncated", {
      message: long,
      retryable: false,
    });

    const rows = await listQueueJobs(handle.db, { statuses: ["failed"], limit: 10 });
    const summary = rows.find((r) => r.id === job.id)?.errorMessage ?? "";
    // A reader must be able to tell the reason continues beyond what it sees.
    expect(summary).toContain("reason truncated in the queue summary");
    expect(summary.length).toBeLessThan(long.length);
    // The kept text stops at a space: never "…with th".
    const kept = summary.split(" … (reason truncated")[0] ?? "";
    expect(kept.endsWith(" ")).toBe(false);
    expect(kept.split(" ").length).toBeGreaterThan(10);
    expect(long.startsWith(kept)).toBe(true);
  });

  it("says where a cut scheduler reason actually lives, not in a job", async () => {
    // The queue summary's note points at the job row that stores the whole text.
    // A scheduler tick has no job: the scheduler_state row IS the record, so the
    // shared note told the operator to go look for a job that never existed.
    const long = `scheduler tick failed. ${"raise the batch limit or shorten the scan interval ".repeat(40)}`;
    await recordSchedulerTickFailure(handle.db, new Date(), {
      message: long,
      failedAt: new Date().toISOString(),
    });

    const snapshot = await getOperationsSnapshot(handle.db);
    const reason = snapshot.scheduler.lastError ?? "";
    expect(reason.length).toBeLessThan(long.length);
    expect(reason).not.toContain("the job stores the full text");
    expect(reason).toContain("the scheduler row holds the recorded reason");
    const kept = reason.split(" … (cut for this summary")[0] ?? "";
    expect(kept.endsWith(" ")).toBe(false);
    expect(long.startsWith(kept)).toBe(true);

    await recordSchedulerTickSuccess(handle.db, new Date());
  });
});

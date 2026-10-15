import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  enqueueJob,
  getJob,
  purgeTerminalJobs,
  resolveJobsRetentionDays,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(available)("maintenance retention", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    // Ownership scope row only: no credentials exist anywhere in the schema.
    await handle.db
      .insert(users)
      .values({ email: "maintenance@igtrack.local" })
      .onConflictDoNothing({ target: users.email });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("purges only old terminal jobs, never queued or recent terminals", async () => {
    const { job: oldJob } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
    });
    await claimJob(handle.db, "maintenance-worker");
    await completeJob(handle.db, oldJob.id, "maintenance-worker", "COMPLETED");
    await handle.sql`UPDATE monitoring_jobs SET completed_at = now() - make_interval(days => 100) WHERE id = ${oldJob.id}`;

    const { job: recentJob } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
    });
    await claimJob(handle.db, "maintenance-worker");
    await completeJob(handle.db, recentJob.id, "maintenance-worker", "COMPLETED");

    const { job: queuedJob } = await enqueueJob(handle.db, {
      kind: "PROFILE_SCAN",
    });

    const purged = await purgeTerminalJobs(handle.db, 90);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await getJob(handle.db, oldJob.id)).toBeNull();
    expect(await getJob(handle.db, recentJob.id)).not.toBeNull();
    expect(await getJob(handle.db, queuedJob.id)).not.toBeNull();
  });

  it("resolves retention days from explicit value, env, and default", () => {
    expect(resolveJobsRetentionDays("30")).toBe(30);
    expect(resolveJobsRetentionDays("0")).toBe(90);
    expect(resolveJobsRetentionDays("nope")).toBe(90);
  });
});

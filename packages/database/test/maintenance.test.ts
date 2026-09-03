import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJob,
  completeJob,
  enqueueJob,
  getJob,
  issueSession,
  purgeExpiredSessions,
  purgeTerminalJobs,
  resolveJobsRetentionDays,
  resolveSession,
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
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "maintenance@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("purges only expired sessions and keeps valid ones resolvable", async () => {
    const expired = await issueSession(handle.db, userId, -1000);
    const valid = await issueSession(handle.db, userId);
    expect(await resolveSession(handle.db, expired.token)).toBeNull();

    const purged = await purgeExpiredSessions(handle.db);
    expect(purged).toBeGreaterThanOrEqual(1);

    const resolved = await resolveSession(handle.db, valid.token);
    expect(resolved?.userId).toBe(userId);
    expect(await purgeExpiredSessions(handle.db)).toBe(0);
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

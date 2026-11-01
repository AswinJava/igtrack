import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  available,
  partial,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedProfile,
} from "@igtrack/core";
import {
  claimJob,
  createTarget,
  enqueueJob,
  getTarget,
  monitoringJobs as jobsTable,
  profileSnapshots,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { executeOne, type ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

// ---------------------------------------------------------------------------
// A job outcome is the operator's only summary of a scan, and it carries three
// distinct claims: COMPLETED (read the whole thing), COMPLETED_EMPTY (read the
// whole thing and found nothing), COMPLETED_PARTIAL (did not finish reading).
// The second is a positive observation of absence, so an unfinished read must
// never land there — that is invariant 7 wearing a job row. PROFILE_SCAN is
// where this repo could lose it silently: the snapshot row already stores
// completeness PARTIAL, while the job row said "succeeded", so the surfaces
// that count partial jobs (investigate, scans list) under-reported exactly the
// scans whose data the writer had already refused to diff.
// ---------------------------------------------------------------------------

const databaseUp = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T14:00:00.000Z";

function profileSource(
  status: CapabilityStatus,
  withheld?: "followerCount" | "followingCount" | "postCount",
): ExecutionSource {
  const sourceId = "stub:profile-outcome";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const profile = (account: NormalizedAccountRef): NormalizedProfile => ({
    account,
    bio: "stub bio",
    ...(withheld === "followerCount" ? {} : { followerCount: 120 }),
    ...(withheld === "followingCount" ? {} : { followingCount: 80 }),
    ...(withheld === "postCount" ? {} : { postCount: 7 }),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: OBSERVED_AT,
    },
  });
  const unwired = (name: string) => async (): Promise<never> => {
    throw new Error(`stub: ${name} not wired`);
  };
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: false,
      getFollowers: false,
      getFollowing: false,
      getPublicPosts: false,
      getPublicComments: false,
      getPostChildren: false,
      getTags: false,
      getMentionedComment: false,
      getAccountInsights: false,
      discoverAccount: false,
    }),
    resolveAccount: unwired("resolveAccount"),
    getProfile: async (account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedProfile>> =>
      status === CapabilityStatus.PARTIAL
        ? partial(profile(account), {
            observedAt: OBSERVED_AT,
            source: sourceRef,
            confidence: Confidence.MEDIUM,
            note: "Provider returned a subset of the profile fields",
          })
        : available(profile(account), {
            observedAt: OBSERVED_AT,
            source: sourceRef,
            confidence: Confidence.HIGH,
          }),
    getStories: unwired("getStories"),
    getFollowers: unwired("getFollowers"),
    getFollowing: unwired("getFollowing"),
    getPublicPosts: unwired("getPublicPosts"),
    getPublicComments: unwired("getPublicComments"),
    getPostChildren: unwired("getPostChildren"),
    getTags: unwired("getTags"),
    getMentionedComment: unwired("getMentionedComment"),
    getAccountInsights: unwired("getAccountInsights"),
    discoverAccount: unwired("discoverAccount"),
  };
  return { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "profile stub" } };
}

describe.skipIf(!databaseUp)("job outcome states agree with stored completeness", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "partial-outcome@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function makeJob(): Promise<{ targetId: string; igAccountId: string; workerId: string; job: JobRecord }> {
    targetCounter += 1;
    const username = `partial_outcome_${targetCounter}`;
    const { target } = await createTarget(handle.db, { userId, username });
    const { job } = await enqueueJob(handle.db, { kind: "PROFILE_SCAN", targetId: target.id });
    const workerId = `worker-outcome-${targetCounter}`;
    const claimed = await claimJob(handle.db, workerId);
    if (claimed === null || claimed.id !== job.id) throw new Error("setup: claim failed");
    const stored = await getTarget(handle.db, target.id);
    if (stored === null) throw new Error("setup: target vanished");
    return { targetId: target.id, igAccountId: stored.igAccountId, workerId, job: claimed };
  }

  async function storedJob(jobId: string) {
    const rows = await handle.db.select().from(jobsTable);
    return rows.find((r) => r.id === jobId);
  }

  it("records a COMPLETE profile read as COMPLETED", async () => {
    const { igAccountId, workerId, job } = await makeJob();
    const outcome = await executeOne(
      handle.db,
      workerId,
      profileSource(CapabilityStatus.AVAILABLE),
      job,
    );
    expect(outcome.state).toBe("succeeded");
    const row = await storedJob(job.id);
    expect(row?.outcome).toBe("COMPLETED");

    const snaps = await handle.db
      .select({ completeness: profileSnapshots.completeness })
      .from(profileSnapshots)
      .where(sql`${profileSnapshots.igAccountId} = ${igAccountId}`);
    expect(snaps.map((s) => s.completeness)).toEqual(["COMPLETE"]);
  });

  it("records a PARTIAL profile read as COMPLETED_PARTIAL, matching the snapshot", async () => {
    const { igAccountId, workerId, job } = await makeJob();
    const outcome = await executeOne(
      handle.db,
      workerId,
      profileSource(CapabilityStatus.PARTIAL),
      job,
    );

    // The snapshot row says PARTIAL and refuses to be diffed; the job row must
    // say the same thing, or the scan reports a finished look at data the
    // writer knowingly left unfinished.
    const row = await storedJob(job.id);
    expect(row?.outcome).toBe("COMPLETED_PARTIAL");
    expect(row?.status).toBe("succeeded");
    expect(outcome.state).toBe("succeeded");

    const snaps = await handle.db
      .select({ completeness: profileSnapshots.completeness })
      .from(profileSnapshots)
      .where(sql`${profileSnapshots.igAccountId} = ${igAccountId}`);
    expect(snaps.map((s) => s.completeness)).toEqual(["PARTIAL"]);
  });

  it("marks an AVAILABLE read that withheld a count PARTIAL, not diffable", async () => {
    const { igAccountId, workerId, job } = await makeJob();
    const outcome = await executeOne(
      handle.db,
      workerId,
      profileSource(CapabilityStatus.AVAILABLE, "followerCount"),
      job,
    );

    // The status word said "the whole thing", the payload held back the number
    // every follower-change claim is built from. Diffed against a complete
    // baseline that absence reads as `followerCount 120 -> null` — a lost
    // follower the platform never reported — so completeness is decided by the
    // fields, not by the status.
    const row = await storedJob(job.id);
    expect(row?.outcome).toBe("COMPLETED_PARTIAL");
    expect(outcome.state).toBe("succeeded");

    const snaps = await handle.db
      .select({ completeness: profileSnapshots.completeness })
      .from(profileSnapshots)
      .where(sql`${profileSnapshots.igAccountId} = ${igAccountId}`);
    expect(snaps.map((s) => s.completeness)).toEqual(["PARTIAL"]);
  });
});

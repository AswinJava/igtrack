import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  CapabilityStatus,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedDiscoveredAccount,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  enqueueScheduledScan,
  getSourceHealth,
  getTarget,
  getTargetDossier,
  listProfileSnapshots,
  listPosts,
  markCapabilityUnavailable,
  monitoringJobs as jobsTable,
  schedulingWindowStart,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import { JobExecutionError, runDiscoveryScan } from "../src/provider.js";
import { executeOne } from "../src/index.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

// ---------------------------------------------------------------------------
// DISCOVERY_SCAN — the recording half of the documented Business Discovery
// route (FOUNDING §15 D47/D48). The claims this suite pins:
//   * the profile is recorded as a COMPLETE, diffable snapshot;
//   * the media preview is stored with its ceiling IN THE EVIDENCE, and the
//     scan can only ever report COMPLETED_PARTIAL because that listing cannot
//     page;
//   * published time and first-observed time stay two different facts;
//   * the two observation modes never run each other's kinds — refused at
//     enqueue AND at execute, so a mode change cannot smuggle a job through;
//   * a route that answers UNAVAILABLE produces a reason, not empty rows.
// ---------------------------------------------------------------------------

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const DISCOVERY_USERNAME = "dune.harbor";

function fixtureSource(): ExecutionSource {
  const fixturesDir = join(process.cwd(), "packages", "ingestion", "fixtures", "v1");
  const provider = new FixtureProvider({ fixturesDir });
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "discovery fixture" },
  };
}

function stubSource(
  config: { status?: CapabilityStatus; cap?: boolean; limit?: number } = {},
): ExecutionSource {
  const sourceId = "stub:discovery";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      getPostChildren: false,
      getAccountInsights: false,
      discoverAccount: config.cap ?? true,
    }),
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async () => {
      throw new Error("stub: getPublicPosts not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
    getPostChildren: async () => {
      throw new Error("stub: getPostChildren not wired");
    },
    getAccountInsights: async () => {
      throw new Error("stub: getAccountInsights not wired");
    },
    discoverAccount: async (): Promise<CapabilityResult<NormalizedDiscoveredAccount>> => {
      if ((config.status ?? CapabilityStatus.AVAILABLE) === CapabilityStatus.UNAVAILABLE) {
        return unavailable(
          { observedAt: "2026-08-27T14:00:00.000Z", source: sourceRef },
          "This account is a consumer account; the documented edge cannot answer.",
        );
      }
      const { available } = await import("@igtrack/core");
      return available(
        {
          account: { username: DISCOVERY_USERNAME, igId: "17841400000000002" },
          displayName: "Dune Harbor Studio",
          followerCount: 42,
          recentMedia: [
            {
              postId: "stub-post-1",
              takenAt: "2026-08-26T10:00:00.000Z",
              meta: {
                category: "OBSERVED",
                confidence: "HIGH",
                observedAt: "2026-08-27T14:00:00.000Z",
              },
            },
          ],
          ...(config.limit !== undefined ? { recentMediaLimit: config.limit } : {}),
          meta: {
            category: "OBSERVED",
            confidence: "HIGH",
            observedAt: "2026-08-27T14:00:00.000Z",
          },
        },
        {
          observedAt: "2026-08-27T14:00:00.000Z",
          source: sourceRef,
          confidence: "HIGH",
        },
      );
    },
  };
  return { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "stub" } };
}

describe.runIf(dbAvailable)("worker DISCOVERY_SCAN", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let counter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "discovery@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(mode: "OWNED" | "DISCOVERY", username?: string): Promise<string> {
    counter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: username ?? `discovery_target_${counter}`,
      ...(mode === "DISCOVERY" ? { observationMode: "DISCOVERY" as const } : {}),
    });
    return target.id;
  }

  async function claimMine(workerId: string, expectedJobId: string): Promise<JobRecord> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claimed = await claimJob(handle.db, workerId);
      if (claimed === null) {
        throw new Error("test setup: nothing claimable while waiting for the expected job");
      }
      if (claimed.id === expectedJobId) return claimed;
      // A job an earlier test left queued: finish it so this claim is
      // deterministic (the queue picks the oldest available job).
      await completeJob(handle.db, claimed.id, workerId);
    }
    throw new Error("test setup: expected job never surfaced within 10 claims");
  }

  async function makeJob(targetId: string, kind = "DISCOVERY_SCAN"): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, { kind, targetId });
    return claimMine("worker-discovery", job.id);
  }

  it("records the profile COMPLETE and the media preview as a bounded, partial scan (D1)", async () => {
    const targetId = await makeTarget("DISCOVERY", DISCOVERY_USERNAME);
    const job = await makeJob(targetId);
    const target = await getTarget(handle.db, targetId);
    const result = await runDiscoveryScan(handle.db, job, fixtureSource());
    // The media edge cannot page, so the media half is knowingly incomplete.
    expect(result).toBe("succeeded-partial");

    const snaps = await listProfileSnapshots(handle.db, target!.igAccountId, {});
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.completeness).toBe("COMPLETE");
    expect(snaps[0]?.followerCount).toBe(18420);
    // The platform id is an output of the observation; the account row keeps it.
    const posts = await listPosts(handle.db, targetId);
    expect(posts.map((p) => p.postId).sort()).toEqual(["dune-post-1", "dune-post-2"]);
    await completeJob(handle.db, job.id, "worker-discovery");
  });

  it("keeps published time and first-observed time apart, and the ceiling in the evidence (D2)", async () => {
    const targetId = await makeTarget("DISCOVERY", DISCOVERY_USERNAME);
    const job = await makeJob(targetId);
    await runDiscoveryScan(handle.db, job, fixtureSource());
    await completeJob(handle.db, job.id, "worker-discovery");
    const posts = await listPosts(handle.db, targetId);
    const post = posts.find((p) => p.postId === "dune-post-1")!;
    // published = the fixture's taken_at; observed = when the provider fetched.
    expect(post.takenAt.toISOString()).toBe("2026-08-26T10:00:00.000Z");
    expect(post.observedAt.toISOString()).toBe("2026-08-27T09:15:00.000Z");
    // No documented route returns another account's media comments: UNAVAILABLE,
    // never "no comments".
    expect(post.commentsState).toBe("UNAVAILABLE");

    const meta = await handle.db.execute(
      sql`SELECT metadata FROM evidence WHERE id = ${post.evidenceId}`,
    );
    const row = Array.from(meta as unknown as Array<{ metadata: Record<string, unknown> }>)[0];
    expect(row?.metadata["previewBounded"]).toBe(true);
    expect(row?.metadata["previewLimit"]).toBe(12);
    expect(row?.metadata["previewPosition"]).toBe(0);
    expect(row?.metadata["observationMode"]).toBe("DISCOVERY");
  });

  it("re-running deduplicates rows instead of duplicating history (D3)", async () => {
    const targetId = await makeTarget("DISCOVERY", DISCOVERY_USERNAME);
    const target = await getTarget(handle.db, targetId);
    const first = await makeJob(targetId);
    expect(await runDiscoveryScan(handle.db, first, fixtureSource())).toBe("succeeded-partial");
    await completeJob(handle.db, first.id, "worker-discovery");
    const second = await makeJob(targetId);
    expect(await runDiscoveryScan(handle.db, second, fixtureSource())).toBe("succeeded-partial");
    await completeJob(handle.db, second.id, "worker-discovery");
    expect(await listPosts(handle.db, targetId)).toHaveLength(2);
    expect(await listProfileSnapshots(handle.db, target!.igAccountId, {})).toHaveLength(1);
  });

  it("a route that answers UNAVAILABLE yields a reason, not rows (D4)", async () => {
    // No discovery file in the fixture set declared for this stub: UNAVAILABLE.
    const targetId = await makeTarget("DISCOVERY");
    const job = await makeJob(targetId);
    const result = await runDiscoveryScan(handle.db, job, stubSource({ status: CapabilityStatus.UNAVAILABLE }));
    expect(result).toBe("unavailable");
    expect(await listPosts(handle.db, targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:discovery");
    const row = health.find((h) => h.capability === "discoverAccount");
    expect(row?.status).toBe("UNAVAILABLE");
    expect(row?.coverageNote ?? "").toContain("consumer account");
    await completeJob(handle.db, job.id, "worker-discovery");
  });

  it("a provider without the route declares it unavailable instead of guessing (D5)", async () => {
    const targetId = await makeTarget("DISCOVERY");
    const job = await makeJob(targetId);
    expect(await runDiscoveryScan(handle.db, job, stubSource({ cap: false }))).toBe("unavailable");
    const health = await getSourceHealth(handle.db, "stub:discovery");
    expect(health.find((h) => h.capability === "discoverAccount")?.status).toBe("UNAVAILABLE");
    await completeJob(handle.db, job.id, "worker-discovery");
  });

  it("refuses to run for an OWNED target, non-retryably (D6)", async () => {
    const ownedId = await makeTarget("OWNED");
    const job = await makeJob(ownedId);
    await expect(runDiscoveryScan(handle.db, job, fixtureSource())).rejects.toMatchObject({
      retryable: false,
    });
    const target = await getTarget(handle.db, ownedId);
    expect(await listProfileSnapshots(handle.db, target!.igAccountId, {})).toHaveLength(0);
    await completeJob(handle.db, job.id, "worker-discovery");
  });

  it("refuses the wrong mode at ENQUEUE, so no job can only fail (D7)", async () => {
    const ownedId = await makeTarget("OWNED");
    const discoveryId = await makeTarget("DISCOVERY");
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const window = schedulingWindowStart(now, 24 * 3_600_000);

    const ownedDiscovery = await enqueueScheduledScan(handle.db, {
      kind: "DISCOVERY_SCAN",
      targetId: ownedId,
      windowStart: window,
    });
    expect(ownedDiscovery.enqueued).toBe(false);

    const wrongOwnedKind = await enqueueScheduledScan(handle.db, {
      kind: "PROFILE_SCAN",
      targetId: discoveryId,
      windowStart: window,
    });
    expect(wrongOwnedKind.enqueued).toBe(false);

    const rightKind = await enqueueScheduledScan(handle.db, {
      kind: "DISCOVERY_SCAN",
      targetId: discoveryId,
      windowStart: window,
    });
    expect(rightKind.enqueued).toBe(true);

    // Nothing was silently written for either refusal.
    const jobs = await handle.db.select().from(jobsTable);
    const refused = jobs.filter(
      (j) =>
        (j.targetId === ownedId && j.kind === "DISCOVERY_SCAN") ||
        (j.targetId === discoveryId && j.kind === "PROFILE_SCAN"),
    );
    expect(refused).toHaveLength(0);
  });

  it("dispatches through the worker boundary as COMPLETED_PARTIAL (D8)", async () => {
    const targetId = await makeTarget("DISCOVERY", DISCOVERY_USERNAME);
    const { job } = await enqueueJob(handle.db, { kind: "DISCOVERY_SCAN", targetId });
    const claimed = await claimMine("worker-dispatch", job.id);
    const outcome = await executeOne(handle.db, "worker-dispatch", fixtureSource(), claimed);
    expect(outcome.state).toBe("succeeded");
    const rows = await handle.db.select().from(jobsTable);
    const stored = rows.find((r) => r.id === job.id);
    expect(stored?.outcome).toBe("COMPLETED_PARTIAL");
    expect(stored?.status).toBe("succeeded");
  });

  it("a failing route surfaces as a retryable job failure, never as absence (D9)", async () => {
    const targetId = await makeTarget("DISCOVERY");
    const job = await makeJob(targetId);
    const base = stubSource();
    const failing: ExecutionSource = {
      ...base,
      provider: {
        ...base.provider,
        discoverAccount: async () => {
          const { errored, CapabilityErrorKind } = await import("@igtrack/core");
          return errored(
            {
              observedAt: "2026-08-27T14:00:00.000Z",
              source: { sourceId: "stub:discovery", kind: SourceKind.FIXTURE },
            },
            {
              kind: CapabilityErrorKind.RATE_LIMITED,
              message: "rate limited",
              retryable: true,
            },
          );
        },
      },
    };
    let thrown: unknown = null;
    try {
      await runDiscoveryScan(handle.db, job, failing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JobExecutionError);
    expect((thrown as JobExecutionError).retryable).toBe(true);
    expect(await listPosts(handle.db, targetId)).toHaveLength(0);
    await completeJob(handle.db, job.id, "worker-discovery");
  });

  it("the dossier reads the recorded discovery facts back through the owner scope (D10)", async () => {
    const targetId = await makeTarget("DISCOVERY", DISCOVERY_USERNAME);
    const dossier = (await getTargetDossier(handle.db, userId, targetId))!;
    expect(dossier.account.username).toBe(DISCOVERY_USERNAME);
    expect(dossier.counts.posts.count).toBe(2);
    expect(dossier.latestProfileSnapshot?.followerCount).toBe(18420);
    // The ceiling is reported as the ceiling: never "the account's posts".
    expect(dossier.media?.storedCount).toBe(2);
    expect(dossier.media?.previewLimit).toBe(12);
    expect(dossier.media?.previewBounded).toBe(true);
    const row = dossier.media!.rows.find((r) => r.postId === "dune-post-1")!;
    expect(row.previewPosition).toBe(0);
    expect(row.commentsState).toBe("UNAVAILABLE");
    // Published time and first-observed time stay two different facts.
    expect(row.publishedAt!.getTime()).toBeLessThan(row.firstObservedAt!.getTime());
    expect(dossier.observingSources).toContain("fixture:v1");
    // A route the source answered AVAILABLE is not a gap.
    expect(
      dossier.routeUnavailability.some((r) => r.capability === "discoverAccount"),
    ).toBe(false);

    // A route gap the source itself reported does surface, with its reason.
    await markCapabilityUnavailable(handle.db, {
      source: { id: "fixture:v1", kind: SourceKind.FIXTURE, name: "Fixture v1" },
      capability: "getPublicComments",
      coverageNote: "No documented route returns another account's media comments.",
    });
    const after = (await getTargetDossier(handle.db, userId, targetId))!;
    expect(
      after.routeUnavailability.find((r) => r.capability === "getPublicComments")?.note,
    ).toContain("No documented route");
  });
});

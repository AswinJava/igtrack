import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  Confidence,
  ObservationCategory,
  SourceKind,
  available,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedFollowPage,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  loadStagedFollowScanMembers,
  followScanStaging,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { runFollowingScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-28T09:00:00.000Z";

interface StubPage {
  usernames: string[];
  complete: boolean;
  nextCursor?: string;
}

function paginatedSource(pages: StubPage[]): ExecutionSource {
  const sourceRef = { sourceId: "stub:staging", kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId: "stub:staging",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
    }),
    resolveAccount: async () => {
      throw new Error("stub: not wired");
    },
    getProfile: async () => {
      throw new Error("stub: not wired");
    },
    getStories: async () => {
      throw new Error("stub: not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: not wired");
    },
    getFollowing: (_acct, cursor) =>
      pageFor(pages, sourceRef, cursor),
    getPublicPosts: async () => {
      throw new Error("stub: not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "staging stub" },
  };
}

function pageFor(
  pages: StubPage[],
  sourceRef: { sourceId: string; kind: SourceKind },
  cursor?: Cursor,
): Promise<CapabilityResult<NormalizedFollowPage>> {
  let index = 0;
  if (cursor !== undefined) {
    const owner = pages.findIndex((p) => p.nextCursor === cursor.value);
    index = Math.max(0, owner + 1);
  }
  const page = pages[index];
  if (page === undefined) {
    return Promise.resolve(
      available(
        { entries: [], complete: true, meta: { category: ObservationCategory.OBSERVED, confidence: Confidence.HIGH, observedAt: OBSERVED_AT } },
        { observedAt: OBSERVED_AT, source: sourceRef, confidence: Confidence.HIGH },
      ),
    );
  }
  return Promise.resolve(
    available(
      {
        entries: page.usernames.map((username) => ({ username })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        complete: page.complete,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: page.complete ? Confidence.HIGH : Confidence.MEDIUM,
          observedAt: OBSERVED_AT,
        },
      },
      {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: page.complete ? Confidence.HIGH : Confidence.MEDIUM,
      },
    ),
  );
}

describe.runIf(dbAvailable)("checkpoint staging (PC-T2)", () => {
  let handle: DatabaseHandle;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "staging@igtrack.local" })
      .returning({ id: users.id });
    const { target } = await createTarget(handle.db, {
      userId: rows[0]!.id,
      username: "staging_target",
    });
    targetId = target.id;
  });

  afterEach(async () => {
    await handle.db.execute(sql`DELETE FROM monitoring_jobs`);
    await handle.db.execute(sql`DELETE FROM follow_scan_staging`);
    // Per-test isolation for the shared target: wipe snapshots/deltas/evidence
    // so each test measures only its own scan.
    await handle.db.execute(sql`DELETE FROM follow_deltas`);
    await handle.db.execute(sql`DELETE FROM follow_snapshot_members`);
    await handle.db.execute(sql`DELETE FROM follow_snapshots`);
    await handle.db.execute(sql`DELETE FROM evidence`);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeJob() {
    return (await enqueueJob(handle.db, { kind: "FOLLOWING_SCAN", targetId })).job;
  }

  async function stagedUsernames(jobId: string): Promise<string[]> {
    return (await loadStagedFollowScanMembers(handle.db, jobId)).map((m) => m.username);
  }

  async function snapshotMembers(): Promise<string[]> {
    const rows = await handle.db.execute(sql`
      SELECT ia.username
      FROM follow_snapshot_members m
      JOIN follow_snapshots s ON s.id = m.snapshot_id
      JOIN ig_accounts ia ON ia.id = m.ig_account_id
      WHERE s.target_id = ${targetId} AND s.direction = 'FOLLOWING'
      ORDER BY m.snapshot_id, m.ig_account_id
    `);
    return (Array.from(rows) as Array<{ username: string }>).map((r) => r.username);
  }

  it("stages members durably page by page; crash keeps them and resume completes without loss (T2-1)", async () => {
    const job = await makeJob();
    const src = paginatedSource([
      { usernames: ["a1", "a2", "a3"], complete: false, nextCursor: "p2" },
      { usernames: ["b1", "b2"], complete: true },
    ]);
    await expect(
      runFollowingScan(handle.db, job, src, { crashAfterPages: 1 }),
    ).rejects.toThrow(/Simulated interruption/);
    // Page 1 rows are durable in staging, not lost.
    expect(await stagedUsernames(job.id)).toEqual(["a1", "a2", "a3"]);
    // Resume from the persisted cursor: completion produces the full set.
    await runFollowingScan(handle.db, job, src);
    expect(await stagedUsernames(job.id)).toEqual([]);
    const members = await snapshotMembers();
    expect(members.sort()).toEqual(["a1", "a2", "a3", "b1", "b2"].sort());
    // Staging is cleared on completion.
    const stale = await handle.db.select().from(followScanStaging);
    expect(stale).toHaveLength(0);
  });

  it("duplicate and reordered pages dedupe; no duplicate members reach the snapshot (T2-2)", async () => {
    const job = await makeJob();
    const src = paginatedSource([
      { usernames: ["a1", "a2"], complete: false, nextCursor: "p2" },
      // Same members reordered + one repeat — dedupe via the unique index.
      { usernames: ["a2", "a1"], complete: false, nextCursor: "p3" },
      { usernames: ["c1"], complete: true },
    ]);
    await runFollowingScan(handle.db, job, src);
    const members = await snapshotMembers();
    expect(members.sort()).toEqual(["a1", "a2", "c1"].sort());
    expect(members).toHaveLength(3);
    // And the staging table emits no duplicates either (unique job+username).
    const rows = await handle.db.execute(sql`
      SELECT count(*)::int AS n FROM follow_scan_staging WHERE job_id = ${job.id}
    `);
    // Staging is cleared on completion, so 0 rows remain — the dedupe itself
    // is proven by the snapshot containing exactly one of each username.
    expect(Array.from(rows)[0]).toMatchObject({ n: 0 });
  });

  it("partial final page stays PARTIAL and never fabricates completeness (T2-3)", async () => {
    const job = await makeJob();
    const src = paginatedSource([
      { usernames: ["a1"], complete: false, nextCursor: "p2" },
      { usernames: ["b1"], complete: false }, // no cursor, not complete
    ]);
    const result = await runFollowingScan(handle.db, job, src);
    expect(result).toBe("succeeded-partial");
    const snap = await handle.db.execute(sql`
      SELECT completeness::text AS completeness FROM follow_snapshots
      WHERE target_id = ${targetId} AND direction = 'FOLLOWING'
    `);
    const row = Array.from(snap)[0] as { completeness: string };
    expect(row.completeness).toBe("PARTIAL");
  });

  it("a genuinely empty list is an honest positive observation, not a failure (F8-2/T2-4)", async () => {
    const job = await makeJob();
    const src = paginatedSource([{ usernames: [], complete: true }]);
    const result = await runFollowingScan(handle.db, job, src);
    expect(result).toBe("succeeded-empty");
    const snap = await handle.db.execute(sql`
      SELECT total_observed::int AS total FROM follow_snapshots
      WHERE target_id = ${targetId} AND direction = 'FOLLOWING'
    `);
    const row = Array.from(snap)[0] as { total: number };
    expect(row.total).toBe(0);
  });

  it("stale-lease reclaim re-executes the same logical scan idempotently (T2-5)", async () => {
    const job = await makeJob();
    const src = paginatedSource([
      { usernames: ["a1"], complete: false, nextCursor: "p2" },
      { usernames: ["b1"], complete: true },
    ]);
    await expect(
      runFollowingScan(handle.db, job, src, { crashAfterPages: 1 }),
    ).rejects.toThrow(/Simulated interruption/);
    // Lease expired: reclaim the same logical job (startedAt preserved), then
    // re-execute — no duplicate history.
    const reclaimed = await claimJob(handle.db, "worker-reclaim", { leaseMs: 0 });
    expect(reclaimed?.id).toBe(job.id);
    await runFollowingScan(handle.db, reclaimed!, src);
    const rows = await handle.db.execute(sql`
      SELECT count(*)::int AS n FROM follow_snapshots
      WHERE target_id = ${targetId} AND direction = 'FOLLOWING'
    `);
    expect(Array.from(rows)[0]).toMatchObject({ n: 1 });
  });

  it("same-target serialization: a running scan blocks a second scan of the same kind (T2-6)", async () => {
    await makeJob();
    const first = await claimJob(handle.db, "worker-serial");
    expect(first).not.toBeNull();
    await makeJob();
    const second = await claimJob(handle.db, "worker-serial-2");
    expect(second).toBeNull();
    await completeJob(handle.db, first!.id, "worker-serial");
  });
});
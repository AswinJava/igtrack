import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  createTarget,
  listPosts,
  listProfileSnapshots,
  recordPost,
  recordProfileSnapshot,
  runMigrations,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

// Release gate §14: migrations must apply cleanly in order on a fresh
// database, re-apply idempotently on a populated one without losing history,
// and expose the expected indexes and constraints.
describe.runIf(available)("migration safety", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("applies 0000 through 0009 in journal order", async () => {
    const rows = (await handle.sql`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `) as Array<{ hash: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it("re-migrating a populated database preserves every observation", async () => {
    const userRows = await handle.db
      .insert(users)
      .values({ email: "migrate@igtrack.local" })
      .returning({ id: users.id });
    const userId = userRows[0]!.id;
    const { target } = await createTarget(handle.db, { userId, username: "migrate_target" });
    const at = new Date(Date.UTC(2026, 7, 20, 9));
    await recordProfileSnapshot(handle.db, {
      profile: {
        account: { username: "migrate_target", isPrivate: false },
        bio: "history must survive",
        followerCount: 7,
        followingCount: 3,
        postCount: 1,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: at.toISOString(),
        },
      },
      evidence: {
        observationKind: "profile_snapshot",
        source: { id: "fixture:v1", kind: SourceKind.FIXTURE, name: "x", providerVersion: "v1" },
        sourceReference: "test/migrate",
        schemaVersion: "v1",
        observedAt: at,
        capturedAt: at,
        confidence: Confidence.HIGH,
        rawHash: "0".repeat(64),
        normalizedHash: "1".repeat(64),
      },
    });
    await recordPost(handle.db, {
      targetId: target.id,
      owner: { username: "migrate_target" },
      commentsState: "NOT_SCANNED",
      post: {
        postId: "m-post",
        takenAt: at.toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: at.toISOString(),
        },
      },
      sourceId: "fixture:v1",
      evidence: {
        observationKind: "post",
        source: { id: "fixture:v1", kind: SourceKind.FIXTURE, name: "x", providerVersion: "v1" },
        sourceReference: "test/migrate",
        schemaVersion: "v1",
        observedAt: at,
        capturedAt: at,
        confidence: Confidence.HIGH,
        rawHash: "2".repeat(64),
        normalizedHash: "3".repeat(64),
      },
    });

    await runMigrations(handle.db);

    const snaps = await listProfileSnapshots(handle.db, target.igAccountId, {});
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.bio).toBe("history must survive");
    const posts = await listPosts(handle.db, target.id);
    expect(posts).toHaveLength(1);
    // Pre-permalink rows read back with nulls, never fabricated values.
    expect(posts[0]?.permalink).toBeNull();
    expect(posts[0]?.mediaType).toBeNull();
    expect(posts[0]?.commentsState).toBe("NOT_SCANNED");
  });

  it("creates the release-gate indexes and constraints", async () => {
    const indexes = (await handle.sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `) as Array<{ indexname: string }>;
    const names = new Set(indexes.map((r) => r.indexname));
    for (const expected of [
      "monitoring_jobs_running_locked_idx",
      "monitoring_jobs_target_created_idx",
      "evidence_kind_observed_idx",
      "follow_deltas_to_snapshot_idx",
      "follow_deltas_from_snapshot_idx",
      "profile_changes_to_snapshot_idx",
      "profile_changes_from_snapshot_idx",
      "targets_user_created_idx",
      "posts_idempotency_idx",
      "follow_deltas_idempotency_idx",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    const fks = (await handle.sql`
      SELECT conname FROM pg_constraint WHERE contype = 'f'
    `) as Array<{ conname: string }>;
    expect(fks.length).toBeGreaterThan(20);
  });

  it("refuses to boot a database handle without a configured URL", async () => {
    const savedTest = process.env.IGTRACK_TEST_DATABASE_URL;
    const savedMain = process.env.IGTRACK_DATABASE_URL;
    const savedBare = process.env.DATABASE_URL;
    delete process.env.IGTRACK_TEST_DATABASE_URL;
    delete process.env.IGTRACK_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { createDb: makeDb } = await import("../src/index.js");
      expect(() => makeDb()).toThrow(/Database URL is not configured/);
    } finally {
      if (savedTest !== undefined) process.env.IGTRACK_TEST_DATABASE_URL = savedTest;
      if (savedMain !== undefined) process.env.IGTRACK_DATABASE_URL = savedMain;
      if (savedBare !== undefined) process.env.DATABASE_URL = savedBare;
    }
  });
});

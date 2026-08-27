import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  getEvidenceForObservation,
  listProfileChanges,
  listProfileSnapshots,
  recordProfileSnapshot,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
  providerVersion: "v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

function profileInput(day: number, followerCount: number, bio: string) {
  const observedAt = new Date(Date.UTC(2026, 7, 20 + day, 9, 0, 0));
  return {
    profile: {
      account: {
        username: "target_a",
        igId: "9100000001",
        displayName: "Target A",
        isPrivate: false,
      },
      bio,
      followerCount,
      followingCount: 87,
      postCount: 12,
      isVerified: false,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: observedAt.toISOString(),
      },
    },
    evidence: {
      observationKind: "profile_snapshot",
      source: SOURCE,
      sourceReference: "test/profile",
      schemaVersion: "v1",
      observedAt,
      capturedAt: observedAt,
      confidence: Confidence.HIGH,
      rawHash: hash(`profile-${day}`),
      normalizedHash: hash(`profile-norm-${day}`),
    },
  };
}

describe.runIf(available)("observations & evidence", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "test@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("creates a target with its canonical account", async () => {
    const { target, created } = await createTarget(handle.db, {
      userId,
      username: "target_a",
    });
    expect(created).toBe(true);
    expect(target.status).toBe("ACTIVE");

    const again = await createTarget(handle.db, {
      userId,
      username: "TARGET_A",
    });
    expect(again.created).toBe(false);
    expect(again.target.id).toBe(target.id);
  });

  it("records a profile snapshot with attached evidence", async () => {
    const result = await recordProfileSnapshot(handle.db, profileInput(0, 420, "bio v1"));
    expect(result.deduplicated).toBe(false);
    expect(result.snapshot.followerCount).toBe(420);
    expect(result.snapshot.category).toBe("OBSERVED");
    expect(result.changes).toEqual([]);

    const evidence = await getEvidenceForObservation(
      handle.db,
      "profile_snapshot",
      result.snapshot.id,
    );
    expect(evidence).not.toBeNull();
    expect(evidence?.rawHash).toBe(hash("profile-0"));
    expect(evidence?.normalizedHash).toBe(hash("profile-norm-0"));
    expect(evidence?.sourceId).toBe("fixture:v1");
    expect(evidence?.schemaVersion).toBe("v1");
  });

  it("deduplicates an identical re-ingestion", async () => {
    const first = await recordProfileSnapshot(handle.db, profileInput(0, 420, "bio v1"));
    expect(first.deduplicated).toBe(true);

    const snapshots = await listProfileSnapshots(handle.db, first.snapshot.igAccountId);
    expect(snapshots).toHaveLength(1);
  });

  it("keeps both historical snapshots and derives the change", async () => {
    const day0 = await recordProfileSnapshot(handle.db, profileInput(0, 420, "bio v1"));
    const day1 = await recordProfileSnapshot(handle.db, profileInput(1, 427, "bio v2"));
    expect(day1.deduplicated).toBe(false);
    expect(day1.snapshot.id).not.toBe(day0.snapshot.id);

    const snapshots = await listProfileSnapshots(handle.db, day0.snapshot.igAccountId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.followerCount)).toEqual([427, 420]);

    const changes = await listProfileChanges(handle.db, day0.snapshot.igAccountId);
    const followerChange = changes.find((c) => c.field === "followerCount");
    expect(followerChange?.oldValue).toBe("420");
    expect(followerChange?.newValue).toBe("427");
    expect(followerChange?.fromSnapshotId).toBe(day0.snapshot.id);
    expect(followerChange?.toSnapshotId).toBe(day1.snapshot.id);
    const bioChange = changes.find((c) => c.field === "bio");
    expect(bioChange?.oldValue).toBe("bio v1");
    expect(bioChange?.newValue).toBe("bio v2");
  });

  it("refuses to mutate stored snapshots (append-only)", async () => {
    await expect(
      handle.sql.unsafe(`UPDATE profile_snapshots SET bio = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });
});

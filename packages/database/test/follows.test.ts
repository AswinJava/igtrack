import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  latestFollowSnapshot,
  listRecentDeltas,
  persistFollowDiff,
  recordFollowSnapshot,
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
} as const;

function page(usernames: string[], takenAt: Date) {
  return {
    entries: usernames.map((username) => ({ username })),
    complete: true,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: takenAt.toISOString(),
    },
  };
}

describe.runIf(available)("follow snapshots & diffs", () => {
  let handle: DatabaseHandle;
  let targetId: string;
  const day1 = new Date(Date.UTC(2026, 7, 21, 9, 0, 0));
  const day2 = new Date(Date.UTC(2026, 7, 22, 9, 0, 0));

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "follows@igtrack.local" })
      .returning({ id: users.id });
    const { target } = await createTarget(handle.db, {
      userId: rows[0]!.id,
      username: "target_a",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("persists follower and following snapshots as normalized members", async () => {
    const followers = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWERS",
      source: SOURCE,
      takenAt: day1,
      page: page(["person_alpha", "person_beta"], day1),
    });
    expect(followers.deduplicated).toBe(false);
    expect(followers.memberCount).toBe(2);
    expect(followers.snapshot.completeness).toBe("COMPLETE");

    const following = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWING",
      source: SOURCE,
      takenAt: day1,
      page: page(["person_gamma"], day1),
    });
    expect(following.memberCount).toBe(1);

    const memberRows = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM follow_snapshot_members
    `;
    expect(memberRows[0]!.n).toBe(3);
  });

  it("deduplicates a snapshot re-taken at the same instant", async () => {
    const again = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWERS",
      source: SOURCE,
      takenAt: day1,
      page: page(["person_alpha", "person_beta"], day1),
    });
    expect(again.deduplicated).toBe(true);
  });

  it("persists the core diff engine's result as deltas", async () => {
    const snap1 = await latestFollowSnapshot(handle.db, targetId, "FOLLOWERS");
    const snap2Result = await recordFollowSnapshot(handle.db, {
      targetId,
      direction: "FOLLOWERS",
      source: SOURCE,
      takenAt: day2,
      page: page(["person_alpha", "person_gamma"], day2),
    });
    expect(snap1).not.toBeNull();

    const result = await persistFollowDiff(handle.db, {
      targetId,
      direction: "FOLLOWERS",
      fromSnapshotId: snap1!.id,
      toSnapshotId: snap2Result.snapshot.id,
    });
    expect(result.diff.added).toHaveLength(1);
    expect(result.diff.removed).toHaveLength(1);
    expect(result.insertedDeltas).toBe(2);

    const deltas = await listRecentDeltas(handle.db, targetId, {
      direction: "FOLLOWERS",
    });
    expect(deltas).toHaveLength(2);
    const added = deltas.find((d) => d.change === "NEW_FOLLOWER");
    const lost = deltas.find((d) => d.change === "LOST_FOLLOWER");
    expect(added?.username).toBe("person_gamma");
    expect(lost?.username).toBe("person_beta");
  });

  it("re-persisting the same diff is idempotent", async () => {
    const snap2 = await latestFollowSnapshot(handle.db, targetId, "FOLLOWERS");
    const snaps = await handle.sql<{ id: string }[]>`
      SELECT id FROM follow_snapshots
      WHERE target_id = ${targetId} AND direction = 'FOLLOWERS'
      ORDER BY taken_at ASC
    `;
    const result = await persistFollowDiff(handle.db, {
      targetId,
      direction: "FOLLOWERS",
      fromSnapshotId: snaps[0]!.id,
      toSnapshotId: snap2!.id,
    });
    expect(result.insertedDeltas).toBe(0);

    const deltas = await listRecentDeltas(handle.db, targetId, {
      direction: "FOLLOWERS",
    });
    expect(deltas).toHaveLength(2);
  });
});

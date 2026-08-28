import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTarget,
  deleteOwnedTarget,
  enqueueScheduledScan,
  listActiveTargetIds,
  resolveScanIntervals,
  scanIdempotencyKey,
  schedulingWindowStart,
  transitionTargetStatus,
  users,
  createDb,
  runMigrations,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  createConnectedDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe("scan schedule config (pure)", () => {
  it("exposes deterministic development defaults (6h lists, 30min stories)", () => {
    const intervals = resolveScanIntervals({});
    expect(intervals.PROFILE_SCAN).toBe(6 * 60 * 60 * 1000);
    expect(intervals.FOLLOWER_SCAN).toBe(6 * 60 * 60 * 1000);
    expect(intervals.FOLLOWING_SCAN).toBe(6 * 60 * 60 * 1000);
    expect(intervals.STORY_SCAN).toBe(30 * 60 * 1000);
  });

  it("reads overrides from environment configuration", () => {
    const intervals = resolveScanIntervals({
      IGTRACK_SCAN_STORY_MS: "600000",
    });
    expect(intervals.STORY_SCAN).toBe(600_000);
    expect(intervals.PROFILE_SCAN).toBe(6 * 60 * 60 * 1000);
  });

  it("computes deterministic window starts and keys", () => {
    const interval = 3_600_000;
    const a = schedulingWindowStart(Date.parse("2026-08-28T10:20:00.000Z"), interval);
    const b = schedulingWindowStart(Date.parse("2026-08-28T10:50:00.000Z"), interval);
    expect(a.toISOString()).toBe("2026-08-28T10:00:00.000Z");
    expect(b.toISOString()).toBe(a.toISOString());

    const key = scanIdempotencyKey("STORY_SCAN", "target-1", a);
    expect(key).toBe("sched:STORY_SCAN:target-1:2026-08-28T10:00:00.000Z");
  });
});

describe.runIf(available)("guarded scheduled-scan enqueue", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;
  const window = new Date("2026-08-28T10:00:00.000Z");

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "scheduler@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "sched_target",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("enqueues a scan for an ACTIVE target (S5 happy path)", async () => {
    const result = await enqueueScheduledScan(handle.db, {
      kind: "PROFILE_SCAN",
      targetId,
      windowStart: window,
    });
    expect(result.enqueued).toBe(true);

    const again = await enqueueScheduledScan(handle.db, {
      kind: "PROFILE_SCAN",
      targetId,
      windowStart: window,
    });
    expect(again.enqueued).toBe(false);
  });

  it("refuses to enqueue for a PAUSED target (S5)", async () => {
    await transitionTargetStatus(handle.db, userId, targetId, "PAUSED");
    const result = await enqueueScheduledScan(handle.db, {
      kind: "STORY_SCAN",
      targetId,
      windowStart: window,
    });
    expect(result.enqueued).toBe(false);
    await transitionTargetStatus(handle.db, userId, targetId, "ACTIVE");
  });

  it("refuses to enqueue for a deleted target (S4)", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "sched_doomed",
    });
    await deleteOwnedTarget(handle.db, userId, target.id);
    const result = await enqueueScheduledScan(handle.db, {
      kind: "FOLLOWER_SCAN",
      targetId: target.id,
      windowStart: window,
    });
    expect(result.enqueued).toBe(false);
  });

  it("enqueues independently per scan kind and window", async () => {
    const w1 = new Date("2026-08-28T12:00:00.000Z");
    const w2 = new Date("2026-08-28T18:00:00.000Z");
    expect(
      (await enqueueScheduledScan(handle.db, { kind: "FOLLOWING_SCAN", targetId, windowStart: w1 })).enqueued,
    ).toBe(true);
    expect(
      (await enqueueScheduledScan(handle.db, { kind: "FOLLOWING_SCAN", targetId, windowStart: w2 })).enqueued,
    ).toBe(true);
    expect(
      (await enqueueScheduledScan(handle.db, { kind: "STORY_SCAN", targetId, windowStart: w1 })).enqueued,
    ).toBe(true);
  });

  it("lists active targets with a bounded batch (S10)", async () => {
    const ids = await listActiveTargetIds(handle.db, 1);
    expect(ids.length).toBe(1);
  });

  it("concurrent scheduler instances never duplicate a logical job (S9)", async () => {
    const other = createDb({ url: TEST_DATABASE_URL, max: 2 });
    try {
      const results = await Promise.all([
        enqueueScheduledScan(handle.db, {
          kind: "PROFILE_SCAN",
          targetId,
          windowStart: new Date("2026-08-28T14:00:00.000Z"),
        }),
        enqueueScheduledScan(other.db, {
          kind: "PROFILE_SCAN",
          targetId,
          windowStart: new Date("2026-08-28T14:00:00.000Z"),
        }),
      ]);
      const enqueued = results.filter((r) => r.enqueued).length;
      expect(enqueued).toBe(1);
    } finally {
      await other.close();
    }
  });
});

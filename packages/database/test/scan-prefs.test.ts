import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTarget,
  effectiveIntervalMs,
  kindsForTarget,
  listActiveTargetPrefs,
  upcomingScansForTarget,
  upcomingWindowStart,
  updateOwnedTargetMeta,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe("per-target scan preferences (pure)", () => {
  it("effectiveIntervalMs scales the base and clamps garbage", () => {
    expect(effectiveIntervalMs(3_600_000, null)).toBe(3_600_000);
    expect(effectiveIntervalMs(3_600_000, 1)).toBe(3_600_000);
    expect(effectiveIntervalMs(3_600_000, 0.5)).toBe(1_800_000);
    expect(effectiveIntervalMs(3_600_000, 2)).toBe(7_200_000);
    // Out-of-range raw values clamp instead of producing storms or gaps.
    expect(effectiveIntervalMs(3_600_000, 0.01)).toBe(900_000);
    expect(effectiveIntervalMs(3_600_000, 100)).toBe(28_800_000);
    expect(effectiveIntervalMs(3_600_000, Number.NaN)).toBe(3_600_000);
  });

  it("kindsForTarget defaults to all kinds and drops unknown entries", () => {
    expect(kindsForTarget(null)).toEqual([
      "PROFILE_SCAN",
      "FOLLOWER_SCAN",
      "FOLLOWING_SCAN",
      "STORY_SCAN",
      "POSTS_SCAN",
    ]);
    expect(kindsForTarget(["STORY_SCAN", "POSTS_SCAN"])).toEqual([
      "STORY_SCAN",
      "POSTS_SCAN",
    ]);
    expect(kindsForTarget(["STORY_SCAN", "NOPE"])).toEqual(["STORY_SCAN"]);
  });

  it("upcomingWindowStart always strictly advances", () => {
    const at = Date.parse("2026-08-28T10:00:00.000Z");
    expect(upcomingWindowStart(at, 3_600_000).toISOString()).toBe(
      "2026-08-28T11:00:00.000Z",
    );
    expect(
      upcomingWindowStart(Date.parse("2026-08-28T10:20:00.000Z"), 3_600_000).toISOString(),
    ).toBe("2026-08-28T11:00:00.000Z");
    expect(() => upcomingWindowStart(at, 0)).toThrow();
  });

  it("upcomingScansForTarget forecasts every enabled kind deterministically", () => {
    const intervals = {
      PROFILE_SCAN: 6 * 3_600_000,
      FOLLOWER_SCAN: 6 * 3_600_000,
      FOLLOWING_SCAN: 6 * 3_600_000,
      STORY_SCAN: 1_800_000,
      POSTS_SCAN: 6 * 3_600_000,
    };
    const now = Date.parse("2026-08-28T10:10:00.000Z");
    const scans = upcomingScansForTarget(
      "target-1",
      { scanCadenceMult: null, scanKinds: null },
      now,
      intervals,
    );
    expect(scans.map((s) => s.kind)).toEqual([
      "PROFILE_SCAN",
      "FOLLOWER_SCAN",
      "FOLLOWING_SCAN",
      "STORY_SCAN",
      "POSTS_SCAN",
    ]);
    const story = scans.find((s) => s.kind === "STORY_SCAN")!;
    expect(story.nextWindowStart.toISOString()).toBe("2026-08-28T10:30:00.000Z");
    expect(story.nextAvailableAt.getTime()).toBeGreaterThanOrEqual(
      story.nextWindowStart.getTime(),
    );
    expect(story.nextAvailableAt.getTime()).toBeLessThan(
      story.nextWindowStart.getTime() + story.intervalMs,
    );
    // Same inputs forecast the same schedule the scheduler will enqueue.
    expect(
      upcomingScansForTarget("target-1", { scanCadenceMult: null, scanKinds: null }, now, intervals),
    ).toEqual(scans);
    // Multiplier and kind filters apply.
    const filtered = upcomingScansForTarget(
      "target-1",
      { scanCadenceMult: 2, scanKinds: ["STORY_SCAN"] },
      now,
      intervals,
    );
    expect(filtered.map((s) => s.kind)).toEqual(["STORY_SCAN"]);
    expect(filtered[0]?.intervalMs).toBe(3_600_000);
  });
});

describe.runIf(available)("per-target scan preferences (persisted)", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "prefs@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "prefs_target",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("defaults to standard cadence and all kinds", async () => {
    const prefs = await listActiveTargetPrefs(handle.db, 10, 0);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.scanCadenceMult).toBeNull();
    expect(prefs[0]?.scanKinds).toBeNull();
  });

  it("stores cadence and kind prefs via PATCH path", async () => {
    const updated = await updateOwnedTargetMeta(handle.db, {
      userId,
      targetId,
      scanCadenceMult: 0.5,
      scanKinds: ["STORY_SCAN", "POSTS_SCAN"],
    });
    expect(updated.scanCadenceMult).toBeCloseTo(0.5);
    expect(updated.scanKinds).toEqual(["STORY_SCAN", "POSTS_SCAN"]);
    const prefs = await listActiveTargetPrefs(handle.db, 10, 0);
    expect(prefs[0]?.scanCadenceMult).toBeCloseTo(0.5);
  });

  it("rejects out-of-range cadence and unknown kinds", async () => {
    await expect(
      updateOwnedTargetMeta(handle.db, { userId, targetId, scanCadenceMult: 100 }),
    ).rejects.toThrow();
    await expect(
      updateOwnedTargetMeta(handle.db, { userId, targetId, scanKinds: ["NOPE"] }),
    ).rejects.toThrow();
  });

  it("normalizes an empty kind set back to default-all", async () => {
    const updated = await updateOwnedTargetMeta(handle.db, {
      userId,
      targetId,
      scanKinds: [],
    });
    expect(updated.scanKinds).toBeNull();
  });

  it("clears prefs back to defaults with null", async () => {
    const updated = await updateOwnedTargetMeta(handle.db, {
      userId,
      targetId,
      scanCadenceMult: null,
      scanKinds: null,
    });
    expect(updated.scanCadenceMult).toBeNull();
    expect(updated.scanKinds).toBeNull();
  });
});

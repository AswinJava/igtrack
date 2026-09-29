import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTarget,
  monitoringJobs,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { runSchedulerTick, staggerMs } from "../src/scheduler.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

describe("scheduler stagger (pure)", () => {
  it("is deterministic and bounded by the interval", () => {
    const a = staggerMs("target-1", 1_800_000);
    expect(staggerMs("target-1", 1_800_000)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1_800_000);
  });

  it("spreads distinct targets across the window", () => {
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => staggerMs(`spread-target-${i}`, 1_800_000)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(dbAvailable)("scheduler stagger (integration)", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "stagger@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("staggers availability instead of releasing the whole batch at once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { target } = await createTarget(handle.db, {
        userId,
        username: `stagger_target_${i}`,
      });
      ids.push(target.id);
    }
    const now = new Date("2026-08-27T10:00:00.000Z");
    const result = await runSchedulerTick(handle.db, { now, batchLimit: 200 });
    expect(result.targetsConsidered).toBe(4);
    const rows = await handle.db
      .select({ targetId: monitoringJobs.targetId, availableAt: monitoringJobs.availableAt })
      .from(monitoringJobs)
      .where(
        sql`${monitoringJobs.targetId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ${monitoringJobs.kind} = 'STORY_SCAN'`,
      );
    expect(rows).toHaveLength(4);
    const times = rows.map((r) => r.availableAt.getTime());
    // Window start anchors all four; the stagger spreads them within it.
    const windowStart = Math.floor(now.getTime() / 1_800_000) * 1_800_000;
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(windowStart);
      expect(t).toBeLessThan(windowStart + 1_800_000);
    }
    expect(new Set(times).size).toBeGreaterThan(1);
  });
});

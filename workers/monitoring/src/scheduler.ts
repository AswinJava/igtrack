import {
  countActiveTargets,
  effectiveIntervalMs,
  enqueueScheduledScan,
  kindsForTarget,
  listActiveTargetPrefs,
  recordSchedulerTickFailure,
  recordSchedulerTickStart,
  recordSchedulerTickSuccess,
  resolveScanIntervals,
  schedulingWindowStart,
  staggerMs,
  SCHEDULABLE_KINDS,
  type SchedulableScanKind,
  type ScanIntervalConfig,
} from "@igtrack/database";

// Re-exported for compatibility: the canonical implementation lives in
// @igtrack/database (schedule.ts) so the web layer can forecast the
// identical schedule for "next scan" display.
export { staggerMs };

// Scheduler = orchestration only. It decides WHICH scans are due and enqueues
// them; it never executes provider work and contains no provider logic.

export interface SchedulerTickOptions {
  now?: Date;
  intervals?: ScanIntervalConfig;
  // Bounded batch per tick (S10): a large fleet is scheduled across ticks.
  batchLimit?: number;
}

export interface SchedulerTickResult {
  targetsConsidered: number;
  enqueued: number;
  deduplicated: number;
  perKind: Record<SchedulableScanKind, { enqueued: number; deduplicated: number }>;
}

const DEFAULT_BATCH_LIMIT = 200;

function resolveBatchLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_BATCH_LIMIT;
}

export function schedulerEnabled(): boolean {
  return process.env.IGTRACK_SCHEDULER_ENABLED !== "false";
}

export function schedulerTickIntervalMs(): number {
  const parsed = Number(process.env.IGTRACK_SCHEDULER_TICK_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

export async function runSchedulerTick(
  db: Parameters<typeof recordSchedulerTickStart>[0],
  options: SchedulerTickOptions = {},
): Promise<SchedulerTickResult> {
  const now = options.now ?? new Date();
  const intervals = options.intervals ?? resolveScanIntervals(process.env);
  const batchLimit =
    options.batchLimit ?? resolveBatchLimit(process.env.IGTRACK_SCHEDULER_BATCH);

  const result: SchedulerTickResult = {
    targetsConsidered: 0,
    enqueued: 0,
    deduplicated: 0,
    perKind: Object.fromEntries(
      SCHEDULABLE_KINDS.map((kind) => [kind, { enqueued: 0, deduplicated: 0 }]),
    ) as SchedulerTickResult["perKind"],
  };

  try {
    await recordSchedulerTickStart(db, now);
    // Fleet rotation (S11): the per-tick batch is bounded, but WHICH window of
    // the fleet is considered rotates deterministically with the clock. A
    // stable ORDER BY with a fixed LIMIT would starve every target beyond the
    // first batch forever — targets are considered once per pageCount ticks.
    const totalTargets = await countActiveTargets(db);
    const pageCount = Math.max(1, Math.ceil(totalTargets / batchLimit));
    const ROTATION_GRANULARITY_MS = 60_000;
    const rotationKey = Math.floor(now.getTime() / ROTATION_GRANULARITY_MS);
    const offset = (rotationKey % pageCount) * batchLimit;
    const prefs = await listActiveTargetPrefs(db, batchLimit, offset);
    result.targetsConsidered = prefs.length;

    for (const target of prefs) {
      // Per-target cadence: the window is computed against this target's
      // effective interval, so a 2x target lands in half as many windows
      // while a 0.5x target lands in twice as many. Kinds outside the
      // target's enabled set are never enqueued here (manual sync can still
      // run them explicitly).
      const kinds = kindsForTarget(target.scanKinds);
      for (const kind of kinds) {
        const interval = effectiveIntervalMs(intervals[kind], target.scanCadenceMult);
        const windowStart = schedulingWindowStart(now.getTime(), interval);
        const { enqueued } = await enqueueScheduledScan(db, {
          kind,
          targetId: target.id,
          windowStart,
          availableAt: new Date(windowStart.getTime() + staggerMs(target.id, interval)),
        });
        if (enqueued) {
          result.enqueued += 1;
          result.perKind[kind].enqueued += 1;
        } else {
          result.deduplicated += 1;
          result.perKind[kind].deduplicated += 1;
        }
      }
    }

    await recordSchedulerTickSuccess(db, now);
    return result;
  } catch (err) {
    // Best-effort diagnostics recording; the original error still propagates.
    await recordSchedulerTickFailure(db, now, {
      message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      failedAt: new Date().toISOString(),
    });
    throw err;
  }
}

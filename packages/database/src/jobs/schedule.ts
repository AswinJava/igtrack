import { sql } from "drizzle-orm";
import type { Database } from "../client/client.js";

// ---------------------------------------------------------------------------
// Deterministic scan scheduling primitives. This module owns persistence and
// the guarded enqueue; tick orchestration lives in workers/monitoring.
// ---------------------------------------------------------------------------

export type SchedulableScanKind =
  | "PROFILE_SCAN"
  | "FOLLOWER_SCAN"
  | "FOLLOWING_SCAN"
  | "STORY_SCAN"
  | "POSTS_SCAN"
  | "INSIGHTS_SCAN"
  | "TAGS_SCAN"
  | "DISCOVERY_SCAN";

export const SCHEDULABLE_KINDS: readonly SchedulableScanKind[] = [
  "PROFILE_SCAN",
  "FOLLOWER_SCAN",
  "FOLLOWING_SCAN",
  "STORY_SCAN",
  "POSTS_SCAN",
  "INSIGHTS_SCAN",
  "TAGS_SCAN",
  "DISCOVERY_SCAN",
];

// Which scan kinds a target's observation mode may legally run (FOUNDING §15
// D47). The two modes are answered by different provider routes, so a kind that
// cannot succeed for a mode is refused when the job is ENQUEUED, not discovered
// as a repeated provider failure later.
export type ObservationMode = "OWNED" | "DISCOVERY";

export const OWNED_ONLY_KINDS: readonly SchedulableScanKind[] = [
  "PROFILE_SCAN",
  "FOLLOWER_SCAN",
  "FOLLOWING_SCAN",
  "STORY_SCAN",
  "POSTS_SCAN",
  "INSIGHTS_SCAN",
  "TAGS_SCAN",
];

export const KINDS_BY_OBSERVATION_MODE: Record<
  ObservationMode,
  readonly SchedulableScanKind[]
> = {
  OWNED: OWNED_ONLY_KINDS,
  DISCOVERY: ["DISCOVERY_SCAN"],
};

export function isScanKindAllowedForMode(
  kind: SchedulableScanKind,
  mode: ObservationMode,
): boolean {
  return KINDS_BY_OBSERVATION_MODE[mode].includes(kind);
}

export interface ScanIntervalConfig {
  PROFILE_SCAN: number;
  FOLLOWER_SCAN: number;
  FOLLOWING_SCAN: number;
  STORY_SCAN: number;
  POSTS_SCAN: number;
  INSIGHTS_SCAN: number;
  TAGS_SCAN: number;
  DISCOVERY_SCAN: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// MVP cadence: stories expire after 24h, so they are polled every 30 minutes
// (a missed poll is a permanent ephemerality gap); profile, follow lists,
// posts, and insights move slowly and are polled every 6 hours. TAGS_SCAN is
// owned-account and slow-moving (FOUNDING §17): a tag appearing a day late is
// not a missed observation, so the documented tags edge is listed once a day.
// DISCOVERY_SCAN is the slowest on purpose: it is the one kind that spends
// another account's Platform Rate Limit budget (200 × users per hour) and the
// data it watches — a public profile's fields and its recent media — does not
// move faster than daily.
export const DEFAULT_SCAN_INTERVALS_MS: ScanIntervalConfig = {
  PROFILE_SCAN: 6 * HOUR,
  FOLLOWER_SCAN: 6 * HOUR,
  FOLLOWING_SCAN: 6 * HOUR,
  STORY_SCAN: 30 * MINUTE,
  POSTS_SCAN: 6 * HOUR,
  INSIGHTS_SCAN: 6 * HOUR,
  TAGS_SCAN: 24 * HOUR,
  DISCOVERY_SCAN: 24 * HOUR,
};

const INTERVAL_ENV: Record<SchedulableScanKind, string> = {
  PROFILE_SCAN: "IGTRACK_SCAN_PROFILE_MS",
  FOLLOWER_SCAN: "IGTRACK_SCAN_FOLLOWERS_MS",
  FOLLOWING_SCAN: "IGTRACK_SCAN_FOLLOWING_MS",
  STORY_SCAN: "IGTRACK_SCAN_STORY_MS",
  POSTS_SCAN: "IGTRACK_SCAN_POSTS_MS",
  INSIGHTS_SCAN: "IGTRACK_SCAN_INSIGHTS_MS",
  TAGS_SCAN: "IGTRACK_SCAN_TAGS_MS",
  DISCOVERY_SCAN: "IGTRACK_SCAN_DISCOVERY_MS",
};

export function resolveScanIntervals(
  env: Record<string, string | undefined>,
): ScanIntervalConfig {
  const resolved = {} as ScanIntervalConfig;
  for (const kind of SCHEDULABLE_KINDS) {
    const raw = env[INTERVAL_ENV[kind]];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    resolved[kind] =
      Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_SCAN_INTERVALS_MS[kind];
  }
  return resolved;
}

// The scheduling window anchors the idempotency key: floor(now / interval).
// A completed job permanently holds its window's key, so the key MUST encode
// the window — a bare `targetId + kind` key would suppress all future scans.
export function schedulingWindowStart(nowMs: number, intervalMs: number): Date {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("igtrack: scan interval must be a positive number");
  }
  return new Date(Math.floor(nowMs / intervalMs) * intervalMs);
}

export function scanIdempotencyKey(
  kind: SchedulableScanKind,
  targetId: string,
  windowStart: Date,
): string {
  return `sched:${kind}:${targetId}:${windowStart.toISOString()}`;
}

export interface EnqueueScheduledScanInput {
  kind: SchedulableScanKind;
  targetId: string;
  windowStart: Date;
  availableAt?: Date;
}

export interface EnqueueScheduledScanResult {
  // false means the target was not ACTIVE (paused/deleted/missing) or the
  // window's job already exists — both are scheduler no-ops by design.
  enqueued: boolean;
}

// Race-safe enqueue: a single INSERT…SELECT guarded on target status AND
// observation mode. A target paused, deleted, or mode-changed between scheduler
// selection and this statement can never receive a job, and a kind illegal for
// the target's mode is refused here — before it enters the queue (D47). The
// mode is read in the same statement that inserts, so it cannot go stale.
// Unique-idempotency conflicts resolve to `enqueued: false`.
export async function enqueueScheduledScan(
  db: Database,
  input: EnqueueScheduledScanInput,
): Promise<EnqueueScheduledScanResult> {
  const key = scanIdempotencyKey(input.kind, input.targetId, input.windowStart);
  const availableAt = input.availableAt ?? new Date();
  const result = await db.execute(sql`
    INSERT INTO monitoring_jobs
      (id, kind, target_id, idempotency_key, payload, status, available_at)
    SELECT
      gen_random_uuid()::text,
      ${input.kind},
      targets.id,
      ${key},
      '{}'::jsonb,
      'queued',
      ${availableAt.toISOString()}
    FROM targets
    WHERE targets.id = ${input.targetId}
      AND targets.status = 'ACTIVE'
      AND (targets.observation_mode = 'DISCOVERY') = (${input.kind} = 'DISCOVERY_SCAN')
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING monitoring_jobs.id
  `);
  return { enqueued: Array.from(result).length > 0 };
}

// Deterministic per-target stagger: without it every target in a tick shares
// one windowStart AND one availableAt, so the whole fleet becomes claimable
// in the same instant (thundering herd to the provider). Spreading each
// target's availability across its window by a stable hash of its id keeps
// single-tick bursts bounded while remaining fully deterministic and
// observable via the job's available_at. Lives here (not the worker) so the
// web layer can forecast the identical schedule for "next scan" display.
export function staggerMs(targetId: string, intervalMs: number): number {
  let hash = 2166136261;
  for (let i = 0; i < targetId.length; i += 1) {
    hash ^= targetId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % intervalMs;
}

export interface UpcomingScan {
  kind: SchedulableScanKind;
  intervalMs: number;
  nextWindowStart: Date;
  nextAvailableAt: Date;
}

/** Forecast per-kind upcoming scans for one target. Pure and deterministic:
 * the same inputs the scheduler tick uses, so the UI shows exactly what the
 * scheduler will do. Paused targets are the caller's concern (no jobs). */
export function upcomingScansForTarget(
  targetId: string,
  prefs: {
    scanCadenceMult: number | null;
    scanKinds: string[] | null;
    observationMode?: ObservationMode;
  } | null,
  nowMs: number,
  intervals: ScanIntervalConfig,
): UpcomingScan[] {
  const mult = prefs?.scanCadenceMult ?? null;
  return kindsForTarget(
    prefs?.scanKinds ?? null,
    prefs?.observationMode ?? "OWNED",
  ).map((kind) => {
    const interval = effectiveIntervalMs(intervals[kind], mult);
    const nextWindowStart = upcomingWindowStart(nowMs, interval);
    return {
      kind,
      intervalMs: interval,
      nextWindowStart,
      nextAvailableAt: new Date(nextWindowStart.getTime() + staggerMs(targetId, interval)),
    };
  });
}
// Bounded consideration set for one scheduler tick (S10). The scheduler never
// loads every target into memory; large fleets are handled across ticks.
// `offset` supports fleet rotation (S11): consecutive ticks page through the
// fleet so targets beyond the first window are never starved.
export async function listActiveTargetIds(
  db: Database,
  limit: number,
  offset = 0,
): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT id::text AS id
    FROM targets
    WHERE status = 'ACTIVE'
    ORDER BY created_at ASC, id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return Array.from(rows as unknown as Array<{ id: string }>).map((row) => row.id);
}

export interface TargetScanPrefs {
  id: string;
  /** The account this target is about — the scheduler's identity gate needs it. */
  username: string;
  /** Effective cadence multiplier (>= 0.25); NULL/1 = deployment default. */
  scanCadenceMult: number | null;
  /** Explicit enabled scan kinds; NULL = all schedulable kinds. */
  scanKinds: string[] | null;
  /** How this target is observed; decides which kinds are even legal (D47). */
  observationMode: ObservationMode;
}

function normalizeCadenceMult(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw)) return 1;
  return Math.min(8, Math.max(0.25, raw));
}

/** Effective per-kind interval for one target: global base × target multiplier. */
export function effectiveIntervalMs(
  baseMs: number,
  scanCadenceMult: number | null,
): number {
  return Math.max(1, Math.floor(baseMs * normalizeCadenceMult(scanCadenceMult)));
}

/**
 * Schedulable kinds enabled for one target (unknown entries dropped).
 *
 * The observation mode is a hard filter applied BEFORE the caller's explicit
 * subset: a DISCOVERY target can never be scheduled for an owned-account scan
 * kind, whatever its `scan_kinds` says (D47). Refusing here means the queue
 * never holds a job that is guaranteed to fail.
 */
export function kindsForTarget(
  scanKinds: string[] | null,
  observationMode: ObservationMode = "OWNED",
): SchedulableScanKind[] {
  const legal = KINDS_BY_OBSERVATION_MODE[observationMode];
  if (scanKinds === null) return [...legal];
  return legal.filter((k) => scanKinds.includes(k));
}

/** Next window start strictly after now for a per-target effective interval. */
export function upcomingWindowStart(nowMs: number, intervalMs: number): Date {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("igtrack: scan interval must be a positive number");
  }
  return new Date((Math.floor(nowMs / intervalMs) + 1) * intervalMs);
}

export async function listActiveTargetPrefs(
  db: Database,
  limit: number,
  offset = 0,
): Promise<TargetScanPrefs[]> {
  const rows = await db.execute(sql`
    SELECT t.id::text AS id, ia.username, t.scan_cadence_mult, t.scan_kinds, t.observation_mode
    FROM targets t
    JOIN ig_accounts ia ON ia.id = t.ig_account_id
    WHERE t.status = 'ACTIVE'
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return Array.from(
    rows as unknown as Array<{
      id: string;
      username: string;
      scan_cadence_mult: string | number | null;
      scan_kinds: string[] | null;
      observation_mode: string | null;
    }>,
  ).map((row) => ({
    id: row.id,
    username: row.username,
    scanCadenceMult:
      row.scan_cadence_mult === null ? null : Number(row.scan_cadence_mult),
    scanKinds: row.scan_kinds,
    // The column is NOT NULL with an OWNED default; the fallback only covers a
    // row read from a database that has not run migration 0016 yet.
    observationMode: row.observation_mode === "DISCOVERY" ? "DISCOVERY" : "OWNED",
  }));
}

export async function countActiveTargets(db: Database): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM targets
    WHERE status = 'ACTIVE'
  `);
  const row = Array.from(rows as unknown as Array<{ n: number }>)[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Scheduler health (diagnostics singleton). Best-effort by design: recording a
// failure must never mask the original error.
// ---------------------------------------------------------------------------

export const SCHEDULER_STATE_ID = "default";

export interface SchedulerErrorInput {
  message: string;
  failedAt: string;
}

export async function recordSchedulerTickStart(
  db: Database,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO scheduler_state (id, last_tick_at, updated_at)
    VALUES (${SCHEDULER_STATE_ID}, ${at.toISOString()}, now())
    ON CONFLICT (id) DO UPDATE
    SET last_tick_at = ${at.toISOString()}, updated_at = now()
  `);
}

export async function recordSchedulerTickSuccess(
  db: Database,
  at: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO scheduler_state (id, last_tick_at, last_success_at, last_error, updated_at)
    VALUES (${SCHEDULER_STATE_ID}, ${at.toISOString()}, ${at.toISOString()}, null, now())
    ON CONFLICT (id) DO UPDATE
    SET last_success_at = ${at.toISOString()},
        last_error = null,
        updated_at = now()
  `);
}

export async function recordSchedulerTickFailure(
  db: Database,
  at: Date,
  error: SchedulerErrorInput,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO scheduler_state (id, last_tick_at, last_error, updated_at)
      VALUES (${SCHEDULER_STATE_ID}, ${at.toISOString()},
              jsonb_build_object('message', ${error.message}, 'failedAt', ${error.failedAt}),
              now())
      ON CONFLICT (id) DO UPDATE
      SET last_tick_at = ${at.toISOString()},
          last_error = jsonb_build_object('message', ${error.message}, 'failedAt', ${error.failedAt}),
          updated_at = now()
    `);
  } catch {
    // Best-effort: the original tick error is more important than this record.
  }
}

export interface SchedulerStateRecord {
  lastTickAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: { message: string; failedAt: string } | null;
  updatedAt: Date | null;
}

export async function getSchedulerState(
  db: Database,
): Promise<SchedulerStateRecord | null> {
  const rows = await db.execute(sql`
    SELECT last_tick_at, last_success_at, last_error, updated_at
    FROM scheduler_state
    WHERE id = ${SCHEDULER_STATE_ID}
    LIMIT 1
  `);
  const row = Array.from(rows)[0] as
    | {
        last_tick_at: Date | string | null;
        last_success_at: Date | string | null;
        last_error: { message?: string; failedAt?: string } | null;
        updated_at: Date | string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    lastTickAt: row.last_tick_at === null ? null : new Date(row.last_tick_at),
    lastSuccessAt:
      row.last_success_at === null ? null : new Date(row.last_success_at),
    lastError:
      row.last_error && row.last_error.message
        ? {
            message: row.last_error.message,
            failedAt: row.last_error.failedAt ?? "",
          }
        : null,
    updatedAt: row.updated_at === null ? null : new Date(row.updated_at),
  };
}

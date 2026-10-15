import {
  CAPABILITY_REGISTRY,
  CapabilityStatus,
  type CapabilityResult,
  type InstagramProvider,
  type RegistryCapabilityId,
} from "@igtrack/core";
import {
  ACTIVITY_TYPES,
  createTarget,
  deleteOwnedTarget,
  enqueueJob,
  getDashboardOverview,
  getEvidenceChain,
  getOperationsSnapshot,
  getOwnedTarget,
  getUserActivityFeed,
  getRelationshipsForUser,
  listJobsForTarget,
  listProviderMetrics,
  listQueueJobs,
  listScopedEvidence,
  listTargets,
  listTargetsForUser,
  resolveScanIntervals,
  schedulingWindowStart,
  transitionTargetStatus,
  type ActivityType,
  type Database,
  type DashboardOverview,
  type RelationshipRank,
  type ScopedEvidenceRow,
  type TargetListItem,
} from "@igtrack/database";
import {
  makeWorkerId,
  pollOnce,
  providerFromEnv,
  runSchedulerTick,
  schedulerEnabled,
  type ExecutionSource,
  type RunOutcome,
} from "@igtrack/monitoring";
import type { TargetStatus } from "@igtrack/core";
import type { CliContext } from "./context.js";
import { capabilityLines, CliError, UsageError } from "./output.js";

// ---------------------------------------------------------------------------
// The operations layer.
//
// Every capability of IGTrack's agent surface is defined exactly once, here,
// as a plain async function over a CliContext returning JSON-serializable data.
// The CLI renders it for humans; the MCP server returns it verbatim to an
// agent. Neither surface owns business logic, so they cannot drift apart.
//
// Non-negotiables encoded here:
//   * `null` means "not observable", never 0. Counts that were never observed
//     stay null through every layer.
//   * Every payload is scoped to the resolved owner user id.
//   * A configuration failure throws; it is never reported as an empty result.
// ---------------------------------------------------------------------------

const SCAN_KINDS = [
  "PROFILE_SCAN",
  "FOLLOWER_SCAN",
  "FOLLOWING_SCAN",
  "STORY_SCAN",
  "POSTS_SCAN",
] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

export function isScanKind(value: string): value is ScanKind {
  return (SCAN_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Target resolution — accepts an id or a @username, always ownership-scoped.
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  id: string;
  username: string;
  status: string;
  igAccountId: string;
}

export async function resolveTarget(
  db: Database,
  userId: string,
  reference: string,
): Promise<ResolvedTarget> {
  const cleaned = reference.trim().replace(/^@/, "");
  if (cleaned === "") {
    throw new UsageError("A target id or username is required.");
  }
  const rows = await listTargetsForUser(db, userId);
  const match =
    rows.find((r) => r.id === cleaned) ??
    rows.find((r) => r.username.toLowerCase() === cleaned.toLowerCase());
  if (match === undefined) {
    throw new CliError(
      "TARGET_NOT_FOUND",
      `No tracked target matches "${reference}". Run \`igtrack targets list\` to see what this deployment tracks.`,
      2,
    );
  }
  const full = await getOwnedTarget(db, userId, match.id);
  if (full === null) {
    throw new CliError("TARGET_NOT_FOUND", `Target "${reference}" is not owned by this user.`, 2);
  }
  return {
    id: full.id,
    username: match.username,
    status: full.status,
    igAccountId: full.igAccountId,
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusReport {
  owner: { id: string; email: string };
  provider: {
    name: string;
    sourceId: string | null;
    synthetic: boolean;
    usable: boolean;
    error: string | null;
  };
  targets: {
    total: number;
    active: number;
    paused: number;
    items: TargetListItem[];
  };
  queue: DashboardOverview["queue"];
  scans: {
    total: number;
    // Null = no scan job has ever been recorded for this deployment.
    lastCompletedAt: Date | null;
    lastOutcome: string | null;
  };
  sourceHealth: Array<{
    sourceId: string;
    capability: string;
    status: string;
    consecutiveFailures: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    updatedAt: Date;
  }>;
}

export async function opStatus(ctx: CliContext): Promise<StatusReport> {
  const [overview, operations, targets] = await Promise.all([
    getDashboardOverview(ctx.db, ctx.userId),
    getOperationsSnapshot(ctx.db).catch(() => null),
    listTargetsForUser(ctx.db, ctx.userId),
  ]);

  const outcomes = operations === null ? [] : [operations.runningJobs, operations.retryWaitJobs, operations.failedJobs].flat();
  const latest = [...outcomes].sort(
    (a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
  )[0];

  return {
    owner: { id: ctx.userId, email: ctx.userEmail },
    provider: {
      name: ctx.provider.name,
      sourceId: ctx.provider.sourceId,
      synthetic: ctx.provider.synthetic,
      usable: ctx.provider.error === null,
      error: ctx.provider.error,
    },
    targets: {
      total: targets.length,
      active: targets.filter((t) => t.status === "ACTIVE").length,
      paused: targets.filter((t) => t.status !== "ACTIVE").length,
      items: targets,
    },
    queue: overview.queue,
    scans: {
      total: overview.recentSnapshots + overview.followChanges + overview.storiesObserved,
      lastCompletedAt: latest?.completedAt ?? null,
      lastOutcome: latest?.outcome ?? null,
    },
    sourceHealth: overview.sourceHealth.map((h) => ({
      sourceId: h.sourceId,
      capability: h.capability,
      status: h.status,
      consecutiveFailures: h.consecutiveFailures,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      lastFailureReason: h.lastFailureReason,
      updatedAt: h.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

export async function opTargetList(ctx: CliContext): Promise<TargetListItem[]> {
  return listTargetsForUser(ctx.db, ctx.userId);
}

export interface TargetAddInput {
  username: string;
  localName?: string | undefined;
  tags?: string[] | undefined;
}

export async function opTargetAdd(
  ctx: CliContext,
  input: TargetAddInput,
): Promise<{ id: string; username: string; created: boolean; note: string }> {
  const username = input.username.trim().replace(/^@/, "");
  if (username === "") throw new UsageError("targets add requires a username.");
  const { target, created } = await createTarget(ctx.db, {
    userId: ctx.userId,
    username,
    ...(input.localName !== undefined ? { localName: input.localName } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
  });
  return {
    id: target.id,
    username,
    created,
    note: created
      ? "Target created ACTIVE. The scheduler enqueues the first scans on the next tick (`igtrack work` runs one now)."
      : "Target already tracked for this user; nothing changed.",
  };
}

export async function opTargetSetStatus(
  ctx: CliContext,
  input: { target: string; status: TargetStatus },
): Promise<{ id: string; username: string; status: string; previous: string }> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const updated = await transitionTargetStatus(ctx.db, ctx.userId, resolved.id, input.status);
  return {
    id: updated.id,
    username: resolved.username,
    status: updated.status,
    previous: resolved.status,
  };
}

export async function opTargetRemove(
  ctx: CliContext,
  target: string,
): Promise<{ id: string; username: string; deleted: boolean }> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, target);
  const deleted = await deleteOwnedTarget(ctx.db, ctx.userId, resolved.id);
  return { id: resolved.id, username: resolved.username, deleted };
}

// ---------------------------------------------------------------------------
// scans
// ---------------------------------------------------------------------------

export interface EnqueuedScan {
  kind: ScanKind;
  targetId: string;
  username: string;
  jobId: string;
  deduplicated: boolean;
}

export interface ScanRunResult {
  enqueued: EnqueuedScan[];
  skipped: Array<{ kind: ScanKind; username: string; reason: string }>;
  note: string;
}

export async function opScanRun(
  ctx: CliContext,
  input: { target?: string | undefined; kinds?: string[] | undefined; force?: boolean | undefined },
): Promise<ScanRunResult> {
  const all = await listTargetsForUser(ctx.db, ctx.userId);
  if (all.length === 0) {
    throw new CliError(
      "NO_TARGETS",
      "This deployment tracks nothing yet. Add one with `igtrack targets add <username>`.",
      2,
    );
  }
  const selected =
    input.target === undefined
      ? all
      : [await resolveTarget(ctx.db, ctx.userId, input.target)];

  const requested = input.kinds ?? [];
  for (const kind of requested) {
    if (!isScanKind(kind)) {
      throw new UsageError(
        `Unknown scan kind "${kind}". Allowed: ${SCAN_KINDS.join(", ")}.`,
      );
    }
  }
  const kinds: ScanKind[] = requested.length > 0 ? (requested as ScanKind[]) : [...SCAN_KINDS];
  const intervals = resolveScanIntervals(process.env);
  const now = Date.now();

  const enqueued: EnqueuedScan[] = [];
  const skipped: ScanRunResult["skipped"] = [];

  for (const target of selected) {
    const full = await getOwnedTarget(ctx.db, ctx.userId, target.id);
    if (full === null) continue;
    if (full.status !== "ACTIVE") {
      for (const kind of kinds) {
        skipped.push({ kind, username: target.username, reason: `target is ${full.status}` });
      }
      continue;
    }
    // Per-target scan preferences: an explicit kind subset narrows the set.
    const allowed =
      full.scanKinds === null || full.scanKinds.length === 0
        ? kinds
        : kinds.filter((k) => (full.scanKinds ?? []).includes(k));

    for (const kind of kinds) {
      if (!allowed.includes(kind)) {
        skipped.push({ kind, username: target.username, reason: "excluded by target scan preferences" });
        continue;
      }
      const windowStart = schedulingWindowStart(now, intervals[kind]);
      const result = await enqueueJob(ctx.db, {
        kind,
        targetId: full.id,
        // Without --force this collapses into the scheduler's own window, so
        // an agent asking for a scan can never double-scan one target.
        ...(input.force === true
          ? {}
          : { idempotencyKey: `cli:${kind}:${full.id}:${windowStart.toISOString()}` }),
      });
      enqueued.push({
        kind,
        targetId: full.id,
        username: target.username,
        jobId: result.job.id,
        deduplicated: result.deduplicated,
      });
    }
  }

  return {
    enqueued,
    skipped,
    note:
      "Jobs are queued, not run. Execute them with `igtrack work` (foreground, bounded) or run the worker daemon.",
  };
}

export async function opScanList(
  ctx: CliContext,
  input: { target?: string | undefined; limit?: number | undefined },
): Promise<{ jobs: Awaited<ReturnType<typeof listJobsForTarget>>; scope: string }> {
  const limit = input.limit ?? 20;
  if (input.target === undefined) {
    // Ownership-scoped (invariant 9): job rows carry usernames and error
    // messages, so the owner sees only jobs belonging to their own targets —
    // never the deployment-wide queue.
    const jobs = await listQueueJobs(ctx.db, {
      statuses: ["running", "retry_wait", "failed"],
      limit,
      userId: ctx.userId,
    });
    return {
      scope: "your targets (queue: running + retry + failed)",
      jobs,
    };
  }
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  return {
    scope: `@${resolved.username}`,
    jobs: await listJobsForTarget(ctx.db, resolved.id, limit),
  };
}

// ---------------------------------------------------------------------------
// work — run the worker in the foreground
// ---------------------------------------------------------------------------

export interface WorkResult {
  schedulerTick: "ok" | "skipped" | "error";
  schedulerError: string | null;
  outcomes: RunOutcome[];
  stopped: "queue-empty" | "max-jobs";
  provider: { sourceId: string; synthetic: boolean };
}

export async function opWork(
  ctx: CliContext,
  input: { max?: number | undefined; skipScheduler?: boolean | undefined } = {},
): Promise<WorkResult> {
  const src: ExecutionSource = providerFromEnv();
  const max = input.max ?? 25;
  let schedulerTick: WorkResult["schedulerTick"] = "skipped";
  let schedulerError: string | null = null;

  if (input.skipScheduler !== true) {
    try {
      await runSchedulerTick(ctx.db);
      schedulerTick = "ok";
    } catch (err) {
      // A scheduler failure must not stop already-queued work from draining.
      schedulerTick = "error";
      schedulerError = err instanceof Error ? err.message : String(err);
    }
  }

  const workerId = makeWorkerId();
  const outcomes: RunOutcome[] = [];
  let stopped: WorkResult["stopped"] = "max-jobs";
  for (let i = 0; i < max; i += 1) {
    const outcome = await pollOnce(ctx.db, workerId, src);
    outcomes.push(outcome);
    if (outcome.state === "none") {
      stopped = "queue-empty";
      break;
    }
  }

  return {
    schedulerTick,
    schedulerError,
    outcomes,
    stopped,
    provider: {
      sourceId: src.provider.sourceId,
      synthetic: src.source.id.includes("fixture"),
    },
  };
}

// ---------------------------------------------------------------------------
// activity / relationships / evidence
// ---------------------------------------------------------------------------

export interface ActivityQuery {
  since?: string | undefined;
  limit?: number | undefined;
  target?: string | undefined;
  types?: string[] | undefined;
  query?: string | undefined;
}

export interface ActivityResult {
  items: Awaited<ReturnType<typeof getUserActivityFeed>>;
  since: Date | null;
  scope: string;
  // Honest bound: the feed is fetched with a bounded scan and then filtered
  // client-side, so `truncated` says whether the fetch limit was reached.
  truncated: boolean;
}

export async function opActivity(ctx: CliContext, input: ActivityQuery): Promise<ActivityResult> {
  const limit = input.limit ?? 30;
  const since = parseSinceDate(input.since);
  const targetFilter = input.target === undefined
    ? null
    : (await resolveTarget(ctx.db, ctx.userId, input.target)).username.toLowerCase();
  // An unknown filter value must be an error, never a silent drop: downstream
  // filtering would show "no events of that type" as if the type had matched
  // nothing, which is exactly the empty-data-as-answer lie the surface forbids.
  const types: ActivityType[] = [];
  for (const t of input.types ?? []) {
    if (t.length === 0) continue;
    if (!(ACTIVITY_TYPES as readonly string[]).includes(t)) {
      throw new UsageError(
        `Unknown activity type "${t}". Allowed: ${ACTIVITY_TYPES.join(", ")}.`,
      );
    }
    types.push(t as ActivityType);
  }

  const fetchLimit = since !== null || targetFilter !== null ? Math.min(limit * 10, 500) : limit;
  const items = await getUserActivityFeed(ctx.db, ctx.userId, fetchLimit, {
    ...(types.length > 0 ? { types } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
  });

  const filtered = items
    .filter((item) => (since === null ? true : item.timestamp.getTime() >= since.getTime()))
    .filter((item) =>
      targetFilter === null ? true : item.targetUsername.toLowerCase() === targetFilter,
    )
    .slice(0, limit);

  return {
    items: filtered,
    since,
    scope: targetFilter === null ? "all tracked targets" : `@${targetFilter}`,
    truncated: items.length >= fetchLimit,
  };
}

export async function opRelationships(
  ctx: CliContext,
  input: { target: string; limit?: number | undefined },
): Promise<{ target: ResolvedTarget; ranks: RelationshipRank[] }> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const ranks = await getRelationshipsForUser(ctx.db, ctx.userId, resolved.id);
  return { target: resolved, ranks: ranks.slice(0, input.limit ?? 25) };
}

export interface EvidenceQuery {
  id?: string | undefined;
  limit?: number | undefined;
}

export async function opEvidence(
  ctx: CliContext,
  input: EvidenceQuery,
): Promise<
  | { mode: "list"; rows: ScopedEvidenceRow[] }
  | { mode: "chain"; chain: Awaited<ReturnType<typeof getEvidenceChain>> }
> {
  if (input.id !== undefined) {
    const chain = await getEvidenceChain(ctx.db, ctx.userId, input.id);
    if (chain === null) {
      throw new CliError("EVIDENCE_NOT_FOUND", `No evidence row ${input.id} is visible to this user.`, 2);
    }
    return { mode: "chain", chain };
  }
  return { mode: "list", rows: await listScopedEvidence(ctx.db, ctx.userId, input.limit ?? 20) };
}

// ---------------------------------------------------------------------------
// capabilities / doctor — the honesty surface
// ---------------------------------------------------------------------------

export interface CapabilityReport {
  capabilities: Array<{
    id: RegistryCapabilityId;
    label: string;
    available: boolean;
    why: string | null;
    liveState: string;
    providerMethods: string[];
  }>;
  summary: { available: number; unavailable: number; total: number };
}

export function opCapabilities(): CapabilityReport {
  const lines = capabilityLines();
  const full = CAPABILITY_REGISTRY.map((entry) => ({
    id: entry.id,
    label: entry.label,
    available: entry.whyUnavailable === null && entry.providerMethods.length > 0,
    why: entry.whyUnavailable,
    liveState: entry.liveState as string,
    providerMethods: [...entry.providerMethods],
  }));
  return {
    capabilities: full,
    summary: {
      available: lines.filter((l) => l.available).length,
      unavailable: lines.filter((l) => !l.available).length,
      total: lines.length,
    },
  };
}

export interface DoctorReport {
  provider: {
    name: string;
    sourceId: string | null;
    usable: boolean;
    error: string | null;
    capabilities: Record<string, boolean> | null;
    synthetic: boolean;
  };
  env: {
    databaseUrl: "set" | "unset";
    // Presence only. Presence is NOT validity: a wrong or expired token still
    // reads as "all-set" here, and shows up as a DEGRADED source-health row on
    // the provider's next call. No heuristic ever guesses whether a credential
    // is real.
    graphCredentials: "all-set" | "partial" | "none";
    nodeEnv: string;
    production: boolean;
    fixtureInProduction: boolean;
  };
  scheduler: { enabled: boolean; intervalsMs: Record<string, number> };
  database: {
    reachable: boolean;
    migrationsApplied: boolean;
    error: string | null;
  };
  sourceHealth: Array<{
    sourceId: string;
    capability: string;
    status: string;
    consecutiveFailures: number;
    lastFailureReason: string | null;
    coverageNote: string | null;
    updatedAt: Date;
  }>;
  metrics: Awaited<ReturnType<typeof listProviderMetrics>>;
  findings: string[];
}

export async function opDoctor(ctx: CliContext): Promise<DoctorReport> {
  const production = process.env.NODE_ENV === "production";
  const graphVars = [
    process.env.IGTRACK_GRAPH_ACCESS_TOKEN,
    process.env.IGTRACK_GRAPH_IG_USER_ID,
    process.env.IGTRACK_GRAPH_USERNAME,
  ].filter((v) => v !== undefined && v !== "");
  const graphCredentials =
    graphVars.length === 0 ? "none" : graphVars.length === 3 ? "all-set" : "partial";

  let sourceHealth: DoctorReport["sourceHealth"] = [];
  let metrics: DoctorReport["metrics"] = [];
  let database: DoctorReport["database"] = {
    reachable: false,
    migrationsApplied: false,
    error: null,
  };
  try {
    const operations = await getOperationsSnapshot(ctx.db);
    database = {
      reachable: operations.database.connected,
      migrationsApplied: operations.database.migrationsApplied,
      error: operations.error ?? null,
    };
    sourceHealth = operations.sources.map((h) => ({
      sourceId: h.sourceId,
      capability: h.capability,
      status: h.status,
      consecutiveFailures: h.consecutiveFailures,
      lastFailureReason: h.lastFailureReason,
      coverageNote: h.coverageNote,
      updatedAt: h.updatedAt,
    }));
    metrics = await listProviderMetrics(ctx.db).catch(() => []);
  } catch (err) {
    database.error = err instanceof Error ? err.message : String(err);
  }

  const findings: string[] = [];
  if (ctx.provider.error !== null) {
    findings.push(`Provider is not usable: ${ctx.provider.error}`);
  }
  if (!database.reachable) {
    findings.push("Database is unreachable. Start Postgres and re-run `igtrack setup`.");
  } else if (!database.migrationsApplied) {
    findings.push("Migrations have not been applied. Run `igtrack setup`.");
  }
  if (production && ctx.provider.synthetic) {
    findings.push(
      "This deployment is running NODE_ENV=production on synthetic fixture data. Every payload is marked _meta.synthetic=true.",
    );
  }
  // Credential findings only matter for the provider that consumes them.
  if (ctx.provider.name === "graph" && graphCredentials !== "all-set") {
    findings.push(
      "The graph provider is selected but its credentials are " +
        `${graphCredentials}. It needs IGTRACK_GRAPH_ACCESS_TOKEN, IGTRACK_GRAPH_IG_USER_ID and IGTRACK_GRAPH_USERNAME together.`,
    );
  }
  for (const h of sourceHealth.filter((row) => row.status !== "HEALTHY")) {
    // UNAVAILABLE rows land here too (status DEGRADED, no failures): the
    // coverage note explains the structural gap, which is information, not
    // breakage. Never report a gap as a failure without saying which it is.
    const detail =
      h.coverageNote ?? h.lastFailureReason ?? "no reason recorded for this row";
    const failures =
      h.consecutiveFailures > 0 ? ` — ${h.consecutiveFailures} consecutive failures` : "";
    findings.push(`${h.sourceId} · ${h.capability}: ${detail}${failures}`);
  }

  let caps: Record<string, boolean> | null = null;
  if (ctx.provider.provider !== null) {
    caps = ctx.provider.provider.capabilities();
  }

  return {
    provider: {
      name: ctx.provider.name,
      sourceId: ctx.provider.sourceId,
      usable: ctx.provider.error === null,
      error: ctx.provider.error,
      capabilities: caps,
      synthetic: ctx.provider.synthetic,
    },
    env: {
      databaseUrl:
        process.env.IGTRACK_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined
          ? "set"
          : "unset",
      graphCredentials,
      nodeEnv: process.env.NODE_ENV ?? "development",
      production,
      fixtureInProduction: production && ctx.provider.synthetic,
    },
    scheduler: {
      enabled: schedulerEnabled(),
      intervalsMs: resolveScanIntervals(process.env) as unknown as Record<string, number>,
    },
    database,
    sourceHealth,
    metrics,
    findings,
  };
}

// ---------------------------------------------------------------------------
// lookup — ask the configured source about one account, persist nothing
// ---------------------------------------------------------------------------

export interface LookupResult {
  username: string;
  sourceId: string;
  status: string;
  confidence: string | null;
  observedAt: string | null;
  account: unknown;
  note: string | null;
  error: { kind: string; message: string; retryable: boolean } | null;
}

export async function opLookup(
  ctx: CliContext,
  input: { username: string; provider?: InstagramProvider | undefined },
): Promise<LookupResult> {
  const username = input.username.trim().replace(/^@/, "");
  if (username === "") throw new UsageError("lookup requires a username.");
  const provider = input.provider ?? ctx.provider.provider;
  if (provider === null) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `Provider "${ctx.provider.name}" is not usable: ${ctx.provider.error ?? "unknown reason"}`,
      3,
    );
  }
  const result: CapabilityResult<unknown> = await provider.resolveAccount(username);
  return {
    username,
    sourceId: provider.sourceId,
    status: result.status,
    confidence:
      result.status === CapabilityStatus.ERROR ? null : (result.confidence as string),
    observedAt: result.status === CapabilityStatus.ERROR ? null : result.observedAt,
    account: result.status === CapabilityStatus.AVAILABLE || result.status === CapabilityStatus.PARTIAL ? result.data : null,
    note: result.note ?? null,
    error:
      result.error === undefined
        ? null
        : {
            kind: result.error.kind,
            message: result.error.message,
            retryable: result.error.retryable,
          },
  };
}

// ---------------------------------------------------------------------------

function parseSinceDate(raw: string | undefined): Date | null {
  if (raw === undefined || raw === "") return null;
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const unitMs =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`--since expects 7d/24h/30m or an ISO date, received "${raw}"`);
  }
  return parsed;
}

export { SCAN_KINDS };

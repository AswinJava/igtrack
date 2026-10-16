import {
  CAPABILITY_REGISTRY,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  RegistryCapabilityId,
  type CapabilityResult,
  type InstagramProvider,
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
  getTargetDossier,
  insightLatest,
  insightState,
  isScanKindAllowedForMode,
  listInsightSeries,
  listJobsForTarget,
  listProviderMetrics,
  listQueueJobs,
  listScopedEvidence,
  listTargets,
  listTargetsForUser,
  RELATIONSHIP_RECENCY_WINDOW_DAYS,
  RELATIONSHIP_SIGNAL_WEIGHTS,
  resolveScanIntervals,
  schedulingWindowStart,
  transitionTargetStatus,
  type ActivityType,
  type Database,
  type DashboardOverview,
  type RelationshipRank,
  type ScopedEvidenceRow,
  type TargetDossier,
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
  "INSIGHTS_SCAN",
  "DISCOVERY_SCAN",
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
  /**
   * `--observed`: track another public account through the documented Business
   * Discovery edge (D47/D49). The route is probed FIRST; if it answers
   * UNAVAILABLE the target is refused and the platform's reason (or the unlock
   * flag) is printed — a target that can never be scanned is not created.
   */
  observed?: boolean | undefined;
  provider?: InstagramProvider | undefined;
}

export interface TargetAddResult {
  id: string;
  username: string;
  created: boolean;
  observationMode: "OWNED" | "DISCOVERY";
  note: string;
  /** What the one-time probe confirmed, verbatim from the provider (a probe result, not a stored claim). */
  probe: { status: string; observedAt: string | null; note: string | null } | null;
}

export async function opTargetAdd(
  ctx: CliContext,
  input: TargetAddInput,
): Promise<TargetAddResult> {
  const username = input.username.trim().replace(/^@/, "");
  if (username === "") throw new UsageError("targets add requires a username.");

  let probe: TargetAddResult["probe"] = null;
  if (input.observed === true) {
    probe = await probeObservedAccount(ctx, input.provider, username);
  }

  const { target, created } = await createTarget(ctx.db, {
    userId: ctx.userId,
    username,
    ...(input.localName !== undefined ? { localName: input.localName } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.observed === true ? { observationMode: "DISCOVERY" as const } : {}),
  });
  return {
    id: target.id,
    username,
    created,
    observationMode: input.observed === true ? "DISCOVERY" : "OWNED",
    note:
      input.observed === true
        ? created
          ? "Observed target created ACTIVE (DISCOVERY mode). Only DISCOVERY_SCAN can run for it; the scheduler enqueues it on the next tick (`igtrack work` runs one now), and `igtrack dossier <username>` reads back what was recorded."
          : "Target already tracked for this user; nothing changed. (`--observed` records through the same target row.)"
        : created
          ? "Target created ACTIVE. The scheduler enqueues the first scans on the next tick (`igtrack work` runs one now)."
          : "Target already tracked for this user; nothing changed.",
    probe,
  };
}

/**
 * One probe of the documented route before a DISCOVERY target exists (D49).
 * The probe is the gate, not a permission check: a route that says UNAVAILABLE
 * — switched off, a consumer account, a private account, age-gated, or the
 * account the deployment already observes — must refuse the target HERE, with
 * the platform's reason, instead of queueing scans that can never succeed.
 * A transport failure is retryable and is reported as such, never as absence.
 */
async function probeObservedAccount(
  ctx: CliContext,
  injected: InstagramProvider | undefined,
  username: string,
): Promise<{ status: string; observedAt: string | null; note: string | null }> {
  const provider = injected ?? ctx.provider.provider;
  if (provider === null) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `Provider "${ctx.provider.name}" is not usable: ${ctx.provider.error ?? "unknown reason"}`,
      3,
    );
  }
  if (provider.capabilities()[CapabilityName.DISCOVER_ACCOUNT] !== true) {
    throw new CliError(
      "CAPABILITY_UNAVAILABLE",
      `Provider "${ctx.provider.name}" cannot read another account's public data (no documented route). Nothing was created.`,
      3,
    );
  }
  const result = await provider.discoverAccount(username);
  if (result.status === CapabilityStatus.ERROR) {
    throw new CliError(
      result.error?.kind ?? "PROVIDER_ERROR",
      `The probe of @${username} failed: ${result.error?.message ?? "provider error"}${
        result.error?.retryable === true ? " (retryable — nothing was created)" : " (nothing was created)"
      }`,
      3,
    );
  }
  if (result.status !== CapabilityStatus.AVAILABLE) {
    throw new CliError(
      "OBSERVATION_UNAVAILABLE",
      `@${username} cannot be observed through the documented route, so no target was created: ${
        result.note ?? "the platform returned no public data for this account"
      }`,
      3,
    );
  }
  return {
    status: result.status,
    observedAt: result.observedAt,
    note: result.note ?? null,
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
  const all = await listTargetsForUser(ctx.db, ctx.userId);  if (all.length === 0) {
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
      // Refused at enqueue, before a job exists (D47): the two observation
      // modes are answered by different provider routes, so a kind belonging
      // to the other mode could never succeed for this target.
      if (!isScanKindAllowedForMode(kind, full.observationMode)) {
        skipped.push({
          kind,
          username: target.username,
          reason:
            full.observationMode === "DISCOVERY"
              ? "DISCOVERY target: only DISCOVERY_SCAN is answerable for another account"
              : "OWNED target: DISCOVERY_SCAN observes another account, not this one",
        });
        continue;
      }
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

export interface RelationshipsResult {
  target: ResolvedTarget;
  /**
   * How every score was computed, stated with the data (D51). The weights and
   * the recency window come from the same constants the ranking code uses, so
   * the description cannot drift from the arithmetic.
   */
  method: {
    signals: Array<{ kind: "mention" | "comment" | "delta"; weight: number; means: string }>;
    scoreFormula: string;
    recencyWindowDays: number;
    recencyNote: string;
    evidenceNote: string;
  };
  // Honest bound: ranks are capped after ranking, so say when the cap hid rows.
  truncated: boolean;
  ranks: RelationshipRank[];
}

export async function opRelationships(
  ctx: CliContext,
  input: { target: string; limit?: number | undefined },
): Promise<RelationshipsResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const ranks = await getRelationshipsForUser(ctx.db, ctx.userId, resolved.id);
  const limit = input.limit ?? 25;
  return {
    target: resolved,
    method: {
      signals: [
        {
          kind: "mention",
          weight: RELATIONSHIP_SIGNAL_WEIGHTS.mention,
          means: "the account was named in one of the target's stories (one story counts once)",
        },
        {
          kind: "comment",
          weight: RELATIONSHIP_SIGNAL_WEIGHTS.comment,
          means: "the account authored a comment on media the operator owns",
        },
        {
          kind: "delta",
          weight: RELATIONSHIP_SIGNAL_WEIGHTS.delta,
          means: "a recorded follow/unfollow change by name (a change event, not an inferred timeline)",
        },
      ],
      scoreFormula: `score = mentions × ${RELATIONSHIP_SIGNAL_WEIGHTS.mention} + comments × ${RELATIONSHIP_SIGNAL_WEIGHTS.comment} + deltas × ${RELATIONSHIP_SIGNAL_WEIGHTS.delta}`,
      recencyWindowDays: RELATIONSHIP_RECENCY_WINDOW_DAYS,
      recencyNote:
        "Each rank also carries lastSignalAt and the same three counts restricted to the recency window. Recency is NOT folded into the score: this product counts stored rows, it does not invent a decay constant.",
      evidenceNote:
        "Each rank carries up to three stored rows behind its counts. An empty evidence list is a structural membership fact (present in the follow snapshots) with no signal event — not missing data.",
    },
    truncated: ranks.length > limit,
    ranks: ranks.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// dossier — everything recorded about one target, read back with its gaps
// ---------------------------------------------------------------------------

/**
 * Which stored surfaces a registry capability is durable in. The state is not
 * a claim in itself: it is computed from row counts, so "OBSERVED" always has
 * rows behind it and "NOT_OBSERVED" never means empty data.
 */
const CAPABILITY_SURFACES: Partial<
  Record<RegistryCapabilityId, Array<keyof TargetDossier["counts"]>>
> = {
  PROFILE: ["profileSnapshots"],
  COUNTS: ["profileSnapshots"],
  ACCOUNT_INSIGHTS: ["insightPoints"],
  // The discovery route's profile fields land in profileSnapshots; its media
  // preview lands in posts.
  OTHER_ACCOUNT_PUBLIC: ["profileSnapshots", "posts"],
  STORIES: ["stories"],
  STORY_METADATA: ["stories"],
  STORY_MENTIONS: ["storyMentions"],
  MENTION_INTELLIGENCE: ["storyMentions", "interactions"],
  POSTS: ["posts", "postChanges"],
  REELS: ["posts"],
  CAROUSELS: ["posts", "postChildren"],
  COMMENTS: ["postComments"],
  REPLIES: ["postComments"],
  FOLLOWERS: ["followerSnapshots", "followDeltas"],
  FOLLOWING: ["followingSnapshots", "followDeltas"],
};

export interface DossierCoverageRow {
  capability: string;
  label: string;
  state: "OBSERVED" | "UNAVAILABLE" | "NOT_OBSERVED";
  /** Rows stored for this capability's surfaces on this target. Null when the capability has no writer. */
  observedRows: number | null;
  latestObservedAt: string | null;
  /** Why it is unavailable / why nothing is observed. Never a guess: registry text or a recorded route note. */
  reason: string | null;
  /** What would change the answer, from the registry. */
  unlock: string | null
  /** Tables the capability persists into, from the registry. */
  persistence: string[];
  /** Bound or route caveat that qualifies an OBSERVED state (e.g. a bounded media preview). */
  caveat: string | null;
}

export interface DossierResult {
  target: ResolvedTarget & {
    observationMode: "OWNED" | "DISCOVERY";
    createdAt: string;
    tags: string[];
    localName: string | null;
  };
  account: {
    id: string;
    username: string;
    igId: string | null;
    displayName: string | null;
    isPrivate: boolean | null;
    isVerified: boolean | null;
    accountType: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  /** How this target is observed and what that route can answer. */
  route: {
    observationMode: "OWNED" | "DISCOVERY";
    providerMethod: string;
    scope: string;
    observingSources: string[];
  };
  counts: Record<string, { count: number; latestAt: string | null }>;
  profile: {
    snapshotCount: number;
    latest: {
      observedAt: string;
      sourceId: string;
      completeness: string | null;
      followerCount: number | null;
      followingCount: number | null;
      postCount: number | null;
      biography: string | null;
      externalUrl: string | null;
      isVerified: boolean | null;
    } | null;
    changeCount: number;
  };
  /**
   * The media rows stored for this target. For a DISCOVERY target they are a
   * bounded, non-pageable preview — the ceiling recorded with the rows is
   * repeated here, and `publishedAt` (platform) is kept apart from
   * `firstObservedAt` (us).
   */
  media: {
    storedCount: number;
    previewLimit: number | null;
    bounded: boolean | null;
    boundedStatement: string | null;
    oldestPublishedAt: string | null;
    newestPublishedAt: string | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    rows: Array<{
      postId: string;
      caption: string | null;
      permalink: string | null;
      publishedAt: string | null;
      firstObservedAt: string | null;
      likeCount: number | null;
      commentCount: number | null;
      mediaType: string | null;
      mediaProductType: string | null;
      commentsState: string;
      evidenceId: string | null;
    }>;
    truncated: boolean;
  } | null;
  coverage: DossierCoverageRow[];
  /** Routes that answered UNAVAILABLE for the sources observing this target, with their reasons. */
  routeUnavailability: Array<{
    sourceId: string;
    capability: string;
    note: string | null;
    updatedAt: string;
  }>;
  notes: string[];
}

export async function opDossier(
  ctx: CliContext,
  input: { target: string },
): Promise<DossierResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const dossier = await getTargetDossier(ctx.db, ctx.userId, resolved.id);
  if (dossier === null) {
    throw new CliError(
      "TARGET_NOT_FOUND",
      `No stored observations for "${input.target}" under this user.`,
      2,
    );
  }

  const mode = dossier.target.observationMode;
  const discoveryEntry = CAPABILITY_REGISTRY.find(
    (e) => e.id === RegistryCapabilityId.OTHER_ACCOUNT_PUBLIC,
  );
  const isObserved = (entry: (typeof CAPABILITY_REGISTRY)[number]): boolean =>
    mode === "DISCOVERY"
      ? entry.providerMethods.includes(CapabilityName.DISCOVER_ACCOUNT)
      : entry.providerMethods.some((m) => m !== CapabilityName.DISCOVER_ACCOUNT);

  const boundedStatement =
    dossier.media !== null && dossier.media.previewBounded === true
      ? `Bounded preview: the platform edge returns at most ${
          dossier.media.previewLimit ?? "a fixed number of"
        } media rows and does not page, so these rows are NOT the account's post history. Stored rows: ${
          dossier.media.storedCount
        }.`
      : null;

  const coverage: DossierCoverageRow[] = CAPABILITY_REGISTRY.map((entry) => {
    const surfaces = CAPABILITY_SURFACES[entry.id] ?? [];
    let rows = 0;
    let latest: Date | null = null;
    for (const key of surfaces) {
      const surface = dossier.counts[key];
      rows += surface.count;
      if (surface.latestAt !== null && (latest === null || surface.latestAt > latest)) {
        latest = surface.latestAt;
      }
    }
    const hasWriter = surfaces.length > 0;
    const routeNote = dossier.routeUnavailability.find((u) =>
      entry.providerMethods.includes(u.capability as (typeof entry.providerMethods)[number]),
    );
    const caveat =
      entry.id === RegistryCapabilityId.POSTS || entry.id === RegistryCapabilityId.OTHER_ACCOUNT_PUBLIC
        ? boundedStatement
        : null;

    let state: DossierCoverageRow["state"];
    let reason: string | null = null;
    if (hasWriter && rows > 0) {
      state = "OBSERVED";
    } else if (entry.whyUnavailable !== null) {
      state = "UNAVAILABLE";
      reason = entry.whyUnavailable;
    } else if (routeNote !== undefined) {
      state = "UNAVAILABLE";
      reason = routeNote.note ?? "The route reported this capability unavailable for this source.";
    } else if (!isObserved(entry)) {
      state = "UNAVAILABLE";
      reason =
        mode === "DISCOVERY"
          ? `A DISCOVERY target is read through the documented route only, and that route covers: ${
              discoveryEntry?.label ?? "another account's public profile and recent media"
            }. This capability belongs to the owned-account edges.`
          : "No owned-account route for this capability in the configured provider.";
    } else if (!hasWriter) {
      state = "UNAVAILABLE";
      reason =
        entry.howItWorks !== "" ? entry.howItWorks : "No provider surface writes this capability.";
    } else {
      state = "NOT_OBSERVED";
      reason =
        mode === "DISCOVERY"
          ? "Not observed yet: no scan through the documented route has stored rows for this capability."
          : "Not observed yet: no scan has stored rows for this capability. A scan can still run.";
    }

    return {
      capability: entry.id,
      label: entry.label,
      state,
      observedRows: hasWriter ? rows : null,
      latestObservedAt: latest === null ? null : latest.toISOString(),
      reason,
      unlock: entry.unlock,
      persistence: entry.persistence,
      caveat,
    };
  });

  const notes: string[] = [];
  if (mode === "DISCOVERY") {
    notes.push(
      "This target is observed through the documented Business Discovery route. Only public Business/Creator accounts are reachable; consumer and private accounts are unreachable, and age-gated accounts return nothing.",
    );
  }
  if (boundedStatement !== null) notes.push(boundedStatement);
  notes.push(
    "publishedAt is when the platform published a row; firstObservedAt is when this deployment first saw it. A row discovered later was not necessarily created later (FOUNDING §15.1).",
  );
  if (dossier.media !== null && dossier.media.storedCount > dossier.media.rows.length) {
    notes.push(
      `The media list below is capped at ${dossier.media.rows.length} rows for this report; ${dossier.media.storedCount} are stored.`,
    );
  }
  notes.push(
    "Capabilities this product refuses by decision (likers, other accounts' rosters, highlights, reposts) are recorded in FOUNDING §14 — they are platform-absent, not unimplemented.",
  );

  return {
    target: {
      ...resolved,
      observationMode: mode,
      createdAt: dossier.target.createdAt.toISOString(),
      tags: dossier.target.tags,
      localName: dossier.target.localName,
    },
    account: {
      id: dossier.account.id,
      username: dossier.account.username,
      igId: dossier.account.igId,
      displayName: dossier.account.displayName,
      isPrivate: dossier.account.isPrivate,
      isVerified: dossier.account.isVerified,
      accountType: dossier.account.accountType,
      firstSeenAt: dossier.account.firstSeenAt.toISOString(),
      lastSeenAt: dossier.account.lastSeenAt.toISOString(),
    },
    route: {
      observationMode: mode,
      providerMethod: mode === "DISCOVERY" ? "discoverAccount" : "owned-account edges",
      scope:
        mode === "DISCOVERY"
          ? "Another account's documented public fields: profile fields plus a bounded recent-media preview."
          : "The account this deployment observes: profile, posts, stories, follow rosters (provider permitting), insights.",
      observingSources: dossier.observingSources,
    },
    counts: Object.fromEntries(
      Object.entries(dossier.counts).map(([key, v]) => [
        key,
        { count: v.count, latestAt: v.latestAt === null ? null : v.latestAt.toISOString() },
      ]),
    ),
    profile: {
      snapshotCount: dossier.counts.profileSnapshots.count,
      latest:
        dossier.latestProfileSnapshot === null
          ? null
          : {
              observedAt: dossier.latestProfileSnapshot.observedAt.toISOString(),
              sourceId: dossier.latestProfileSnapshot.sourceId,
              completeness: dossier.latestProfileSnapshot.completeness,
              followerCount: dossier.latestProfileSnapshot.followerCount,
              followingCount: dossier.latestProfileSnapshot.followingCount,
              postCount: dossier.latestProfileSnapshot.postCount,
              biography: dossier.latestProfileSnapshot.bio,
              externalUrl: dossier.latestProfileSnapshot.externalUrl,
              isVerified: dossier.latestProfileSnapshot.isVerified,
            },
      changeCount: dossier.counts.profileChanges.count,
    },
    media:
      dossier.media === null
        ? null
        : {
            storedCount: dossier.media.storedCount,
            previewLimit: dossier.media.previewLimit,
            bounded: dossier.media.previewBounded,
            boundedStatement,
            oldestPublishedAt: isoOrNull(dossier.media.oldestPublishedAt),
            newestPublishedAt: isoOrNull(dossier.media.newestPublishedAt),
            firstObservedAt: isoOrNull(dossier.media.firstObservedAt),
            lastObservedAt: isoOrNull(dossier.media.lastObservedAt),
            rows: dossier.media.rows.map((r) => ({
              postId: r.postId,
              caption: r.caption,
              permalink: r.permalink,
              publishedAt: isoOrNull(r.publishedAt),
              firstObservedAt: isoOrNull(r.firstObservedAt),
              likeCount: r.likeCount,
              commentCount: r.commentCount,
              mediaType: r.mediaType,
              mediaProductType: r.mediaProductType,
              commentsState: r.commentsState,
              evidenceId: r.evidenceId,
            })),
            truncated: dossier.media.storedCount > dossier.media.rows.length,
          },
    coverage,
    routeUnavailability: dossier.routeUnavailability.map((u) => ({
      sourceId: u.sourceId,
      capability: u.capability,
      note: u.note,
      updatedAt: u.updatedAt.toISOString(),
    })),
    notes,
  };
}

function isoOrNull(v: Date | null): string | null {
  return v === null ? null : v.toISOString();
}

export interface InsightsQuery {
  target: string;
  metric?: string | undefined;
  limit?: number | undefined;
}

export interface InsightsResult {
  target: ResolvedTarget;
  state: Awaited<ReturnType<typeof insightState>>;
  latest: {
    rows: Awaited<ReturnType<typeof insightLatest>>;
    // Honest bound, like opActivity: the bucket list is sliced after the fact,
    // so say when the slice hid rows.
    truncated: boolean;
  };
  series: {
    metric: string;
    points: Awaited<ReturnType<typeof listInsightSeries>>;
    /**
     * Why the metric has no values here: the reason the platform reported in the
     * most recent scan, or null when this deployment has never recorded an
     * absence for it — "the platform said absent" and "we never looked" must not
     * read the same.
     */
    absentReason: string | null;
  } | null;
}

// Insights are the one observation family the platform does NOT keep for us: the
// Graph API retains roughly 90 days, and demographics only as a current-state
// snapshot. So the answer here is "what this deployment recorded while it was
// visible", which is why the accumulation window (`state`) ships with the data.
export async function opInsights(
  ctx: CliContext,
  input: InsightsQuery,
): Promise<InsightsResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const limit = input.limit ?? 200;
  if (limit < 1) throw new UsageError("--limit must be at least 1.");

  const [state, latestRows] = await Promise.all([
    insightState(ctx.db, resolved.igAccountId),
    insightLatest(ctx.db, resolved.igAccountId),
  ]);

  let series: InsightsResult["series"] = null;
  if (input.metric !== undefined) {
    const metric = input.metric.trim();
    if (metric === "") throw new UsageError("--metric expects a metric name, e.g. reach.");
    const points = await listInsightSeries(ctx.db, resolved.igAccountId, metric, {
      limit,
    });
    series = {
      metric,
      points,
      absentReason: state.latestAbsences.find((a) => a.metric === metric)?.reason ?? null,
    };
  }

  return {
    target: resolved,
    state,
    latest: { rows: latestRows.slice(0, limit), truncated: latestRows.length > limit },
    series,
  };
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
  /**
   * Which route answered. "resolve" = the account this deployment observes;
   * "discovery" = the documented Business Discovery probe of another account
   * (D42), rendered as a probe and persisted nowhere. Null only when neither
   * route answered at all.
   */
  via: "resolve" | "discovery" | null;
  status: string;
  confidence: string | null;
  observedAt: string | null;
  account: unknown;
  note: string | null;
  error: { kind: string; message: string; retryable: boolean } | null;
}

function asLookupResult(
  username: string,
  sourceId: string,
  via: LookupResult["via"],
  result: CapabilityResult<unknown>,
): LookupResult {
  return {
    username,
    sourceId,
    via,
    status: result.status,
    confidence:
      result.status === CapabilityStatus.ERROR ? null : (result.confidence as string),
    observedAt: result.status === CapabilityStatus.ERROR ? null : result.observedAt,
    account:
      result.status === CapabilityStatus.AVAILABLE || result.status === CapabilityStatus.PARTIAL
        ? result.data
        : null,
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
  const resolved: CapabilityResult<unknown> = await provider.resolveAccount(username);
  const notOwned =
    resolved.status === CapabilityStatus.ERROR &&
    resolved.error?.kind === CapabilityErrorKind.ACCOUNT_NOT_FOUND;
  if (notOwned && provider.capabilities()[CapabilityName.DISCOVER_ACCOUNT]) {
    // Another account's public data has exactly one lawful route (D42); the
    // probe answers with the data or with the platform's reason, which is a
    // strictly better answer than "this provider does not observe @you". When
    // the route is switched off, the probe's refusal names the unlock.
    const probe = await provider.discoverAccount(username);
    return asLookupResult(username, provider.sourceId, "discovery", probe);
  }
  return asLookupResult(username, provider.sourceId, "resolve", resolved);
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

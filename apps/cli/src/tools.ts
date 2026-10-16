import {
  AppError,
  AppErrorCode,
  CAPABILITY_REGISTRY,
  CLAIM_PREDICATES,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  RegistryCapabilityId,
  claimAgeDays,
  claimSourceDomain,
  classifyClaimPredicate,
  deriveCadence,
  deriveClaimRelation,
  deriveThemes,
  isCapabilityAvailable,
  isClaimDueForReview,
  normalizeClaimValue,
  parseAccountReference,
  validateClaimExcerpt,
  validateClaimSourceUrl,
  validateClaimValue,
  type CapabilityResult,
  type ClaimPredicate,
  type ClaimRelation,
  type ClaimRelationLabel,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedMentionedComment,
  type SynthesisTerm,
} from "@igtrack/core";
import {
  ACTIVITY_TYPES,
  addClaim,
  createTarget,
  deleteOwnedTarget,
  enqueueJob,
  getDashboardOverview,
  getEvidenceChain,
  getOperationsSnapshot,
  getOwnedTarget,
  getUserActivityFeed,
  getRelationshipsForUser,
  getTargetChangeSummary,
  getTargetDossier,
  insightLatest,
  insightState,
  isScanKindAllowedForMode,
  latestTagsListingEvidence,
  listClaims,
  listInsightSeries,
  listJobsForTarget,
  listProviderMetrics,
  listQueueJobs,
  listScopedEvidence,
  listStoredPostTexts,
  listTaggedMedia,
  listTargets,
  listTargetsForUser,
  RELATIONSHIP_RECENCY_WINDOW_DAYS,
  RELATIONSHIP_SIGNAL_WEIGHTS,
  resolveScanIntervals,
  retractClaim,
  schedulingWindowStart,
  transitionTargetStatus,
  type ActivityType,
  type ClaimRecord,
  type Database,
  type DashboardOverview,
  type JobQueueSummary,
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
  "TAGS_SCAN",
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
  const trimmed = reference.trim();
  if (trimmed === "") {
    throw new UsageError("A target id or username is required.");
  }
  const rows = await listTargetsForUser(db, userId);
  // Ids are matched first: a uuid-shaped reference must never have to satisfy
  // username syntax. Only then does the parser run — so "invalid reference"
  // and "valid but not tracked" stay different, typed answers instead of one
  // silent NOT_FOUND that an agent retries forever.
  let match = rows.find((r) => r.id === trimmed);
  if (match === undefined) {
    const parsed = parseAccountReference(trimmed);
    if (!parsed.ok) {
      throw new CliError(
        "TARGET_REFERENCE_INVALID",
        `${parsed.message} Accepted: a tracked target id, a username, an @handle, or an instagram.com/<username> profile URL.`,
        2,
      );
    }
    const candidate = parsed.reference.username.toLowerCase();
    match = rows.find((r) => r.username.toLowerCase() === candidate);
  }
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
  const parsed = parseAccountReference(input.username);
  if (!parsed.ok) {
    throw new UsageError(
      `${parsed.message} \`targets add\` accepts a username, an @handle, or an instagram.com profile URL.`,
    );
  }
  const username = parsed.reference.username;

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
  // FOUNDING §17: tagged-media rows are their own surface (media by other
  // accounts), never folded into the posts surface. REPOSTS is written only by
  // posts that carry a provider-supplied repost count, so its observedRows
  // counts exactly those rows — zero is "never returned", not "no reposts".
  TAGS: ["taggedMedia"],
  REPOSTS: ["repostsObserved"],
  // FOUNDING §18: the claims ledger is written by the operator/agent, not by a
  // provider, so its surface is the claims table itself.
  ACCOUNT_RESEARCH: ["claims"],
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
      /** Provider-supplied repost count when present; null = not returned, never zero-filled (FOUNDING §17). */
      repostsCount: number | null;
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
    entry.operatorSupplied === true
      ? true // supplied by the operator in every mode (FOUNDING §18)
      : mode === "DISCOVERY"
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
        entry.operatorSupplied === true
          ? "No claims recorded yet: a claim exists only when a source states it and the operator or their agent submits it (`igtrack claims add`). IGTrack never generates claims, so an empty ledger is the honest state, not a gap."
          : mode === "DISCOVERY"
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
    "Capabilities this product refuses by decision (likers, other accounts' rosters, highlights) are recorded in FOUNDING §14 — they are platform-absent, not unimplemented.",
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
              repostsCount: r.repostsCount,
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

// ---------------------------------------------------------------------------
// tags — media by OTHER accounts in which the tracked account was tagged
// (FOUNDING §17). Read-only over stored rows; the live edge is read by
// TAGS_SCAN.
// ---------------------------------------------------------------------------

export interface TaggedMediaRowView {
  mediaId: string;
  ownerUsername: string | null;
  caption: string | null;
  permalink: string | null;
  mediaType: string | null;
  /** Provider-published time of the tagged media; null when not returned. */
  takenAt: string | null;
  /** When THIS deployment first observed the row. Never conflated with takenAt. */
  observedAt: string;
  confidence: string;
  evidenceId: string | null;
}

export interface TaggedMediaResult {
  target: Pick<ResolvedTarget, "id" | "username" | "status">;
  rowCount: number;
  /**
   * How complete the most recent tags listing read was; null when no listing
   * has ever been read. A PARTIAL listing must say so where the rows are.
   */
  listing: {
    observedAt: string;
    completion: string | null;
    pages: number | null;
    pageCap: number | null;
  } | null;
  rows: TaggedMediaRowView[];
  truncated: boolean;
  notes: string[];
}

export async function opTaggedMedia(
  ctx: CliContext,
  input: { target: string; limit?: number | undefined },
): Promise<TaggedMediaResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const [rows, listing] = await Promise.all([
    listTaggedMedia(ctx.db, resolved.igAccountId, limit + 1),
    latestTagsListingEvidence(ctx.db, resolved.igAccountId),
  ]);
  const truncated = rows.length > limit;
  const notes = [
    "Every row references media owned by ANOTHER account (the documented tags edge); these are never this account's own media.",
    "First-observation-wins: a row absent from a later listing is never reported as removed.",
    "The platform excludes media from private accounts from the tags edge.",
  ];
  if (listing !== null && listing.completion === "PARTIAL") {
    notes.push(
      "The most recent tags listing completed PARTIAL (capped or truncated): more tagged media may exist than the platform returned. A later scan extends the record.",
    );
  }
  return {
    target: { id: resolved.id, username: resolved.username, status: resolved.status },
    rowCount: Math.min(rows.length, limit),
    listing:
      listing === null
        ? null
        : {
            observedAt: listing.observedAt.toISOString(),
            completion: listing.completion,
            pages: listing.pages,
            pageCap: listing.pageCap,
          },
    rows: rows.slice(0, limit).map((r) => ({
      mediaId: r.mediaId,
      ownerUsername: r.ownerUsername,
      caption: r.caption,
      permalink: r.permalink,
      mediaType: r.mediaType,
      takenAt: r.takenAt === null ? null : r.takenAt.toISOString(),
      observedAt: r.observedAt.toISOString(),
      confidence: r.confidence,
      evidenceId: r.evidenceId,
    })),
    truncated,
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
    available: isCapabilityAvailable(entry),
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
// mention read — one webhook-keyed mentioned comment, on demand (FOUNDING
// §17). Stateless: nothing is persisted, mirroring the lookup/discovery split
// (D53). The platform publishes no listing edge, so an id is required and the
// answer is only about that id.
// ---------------------------------------------------------------------------

export interface MentionedCommentProbeResult {
  /** The account the mention belongs to (the read is scoped to its node). */
  account: string;
  sourceId: string;
  status: string;
  confidence: string | null;
  observedAt: string | null;
  comment: unknown;
  note: string | null;
  error: { kind: string; message: string; retryable: boolean } | null;
}

/**
 * Default the read's account to the deployment's single owned target. Several
 * owned targets (or none) is an ambiguity the operator resolves explicitly,
 * never a guess.
 */
async function resolveMentionAccount(
  ctx: CliContext,
  explicit: string | undefined,
): Promise<string> {
  const cleaned = explicit?.trim().replace(/^@/, "") ?? "";
  if (cleaned !== "") return cleaned;
  const owned = (await listTargetsForUser(ctx.db, ctx.userId)).filter(
    (t) => t.observationMode === "OWNED",
  );
  const first = owned[0];
  if (first === undefined) {
    throw new UsageError(
      "No owned target exists to attribute this read to. Pass --account <username>.",
    );
  }
  if (owned.length > 1) {
    throw new UsageError(
      `This deployment tracks ${owned.length} owned accounts; pass --account <username> to name the account the mention belongs to.`,
    );
  }
  return first.username;
}

function asMentionProbe(
  account: string,
  sourceId: string,
  result: CapabilityResult<unknown>,
): MentionedCommentProbeResult {
  return {
    account,
    sourceId,
    status: result.status,
    confidence:
      result.status === CapabilityStatus.ERROR ? null : (result.confidence as string),
    observedAt: result.status === CapabilityStatus.ERROR ? null : result.observedAt,
    comment:
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

export async function opMentionedCommentProbe(
  ctx: CliContext,
  input: { commentId: string; account?: string | undefined },
): Promise<MentionedCommentProbeResult> {
  const commentId = input.commentId.trim();
  if (commentId === "") {
    throw new UsageError(
      "A comment id is required — it arrives in the app's webhook notification payload.",
    );
  }
  const provider = ctx.provider.provider;
  if (provider === null) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `Provider "${ctx.provider.name}" is not usable: ${ctx.provider.error ?? "unknown reason"}`,
      3,
    );
  }
  const account = await resolveMentionAccount(ctx, input.account);
  // The read is scoped to the account's node: resolve first so a username this
  // provider cannot observe is refused here, with the provider's own reason,
  // instead of being attributed to an account that was never checked.
  const resolved = await provider.resolveAccount(account);
  if (resolved.status !== CapabilityStatus.AVAILABLE || resolved.data === undefined) {
    return asMentionProbe(account, provider.sourceId, resolved);
  }
  const result: CapabilityResult<NormalizedMentionedComment> =
    await provider.getMentionedComment(resolved.data, commentId);
  return asMentionProbe(account, provider.sourceId, result);
}

// ---------------------------------------------------------------------------
// Claims ledger (FOUNDING §18, D67) — the operator's agent researches OUTSIDE
// IGTrack and submits findings here; IGTrack validates, stores, cites, and
// renders them. Nothing on these paths fetches anything, there is no LLM in
// this process, and a claim is never merged into a platform observation.
// ---------------------------------------------------------------------------

export interface ClaimView {
  id: string;
  predicate: string;
  value: string;
  sourceKind: "OPERATOR" | "WEB";
  sourceUrl: string | null;
  sourceDomain: string | null;
  sourceTitle: string | null;
  excerpt: string | null;
  excerptHash: string | null;
  statedAt: string | null;
  retrievedAt: string | null;
  recordedAt: string;
  status: "ACTIVE" | "RETRACTED";
  retractedAt: string | null;
  retractionReason: string | null;
  /** Relation of this claim's predicate cluster; null for retracted rows (they do not participate). */
  relation: ClaimRelationLabel | null;
  relationSourceDomains: string[];
  conflicted: boolean;
  /** Retrieval basis older than 180 days: flagged, never hidden or auto-retracted. */
  dueForReview: boolean;
  ageDays: number;
}

export interface ClaimGroupView {
  predicate: string;
  relation: ClaimRelationLabel;
  conflicted: boolean;
  sourceDomains: string[];
  claims: ClaimView[];
}

function predicateRank(predicate: string): number {
  const index = (CLAIM_PREDICATES as readonly string[]).indexOf(predicate);
  return index === -1 ? 999 : index;
}

function relationForRows(rows: ClaimRecord[]): ClaimRelation {
  return deriveClaimRelation(
    rows.map((r) => ({ value: r.value, sourceKind: r.sourceKind, sourceUrl: r.sourceUrl })),
  );
}

function toClaimView(record: ClaimRecord, relation: ClaimRelation | null, now: Date): ClaimView {
  return {
    id: record.id,
    predicate: record.predicate,
    value: record.value,
    sourceKind: record.sourceKind,
    sourceUrl: record.sourceUrl,
    sourceDomain: record.sourceUrl === null ? null : claimSourceDomain(record.sourceUrl),
    sourceTitle: record.sourceTitle,
    excerpt: record.excerpt,
    excerptHash: record.excerptHash,
    statedAt: record.statedAt === null ? null : record.statedAt.toISOString(),
    retrievedAt: record.retrievedAt === null ? null : record.retrievedAt.toISOString(),
    recordedAt: record.recordedAt.toISOString(),
    status: record.status,
    retractedAt: record.retractedAt === null ? null : record.retractedAt.toISOString(),
    retractionReason: record.retractionReason,
    relation: relation === null ? null : relation.label,
    relationSourceDomains: relation === null ? [] : relation.sourceDomains,
    conflicted: relation === null ? false : relation.conflicted,
    dueForReview: isClaimDueForReview(record, now),
    ageDays: claimAgeDays(record, now),
  };
}

function groupActiveClaims(rows: ClaimRecord[], now: Date): ClaimGroupView[] {
  const byPredicate = new Map<string, ClaimRecord[]>();
  for (const row of rows) {
    if (row.status !== "ACTIVE") continue;
    const list = byPredicate.get(row.predicate);
    if (list === undefined) {
      byPredicate.set(row.predicate, [row]);
    } else {
      list.push(row);
    }
  }
  return [...byPredicate.entries()]
    .sort(([a], [b]) => predicateRank(a) - predicateRank(b) || a.localeCompare(b))
    .map(([predicate, claims]) => {
      const relation = relationForRows(claims);
      return {
        predicate,
        relation: relation.label,
        conflicted: relation.conflicted,
        sourceDomains: relation.sourceDomains,
        claims: claims.map((claim) => toClaimView(claim, relation, now)),
      };
    });
}

function contradictionGroups(
  groups: ClaimGroupView[],
): Array<{ predicate: string; values: Array<{ value: string; sources: string[] }> }> {
  return groups
    .filter((group) => group.conflicted)
    .map((group) => {
      const byValue = new Map<string, { value: string; sources: string[] }>();
      for (const claim of group.claims) {
        const key = normalizeClaimValue(claim.value);
        let entry = byValue.get(key);
        if (entry === undefined) {
          entry = { value: claim.value, sources: [] };
          byValue.set(key, entry);
        }
        entry.sources.push(claim.sourceUrl ?? `operator assertion (claim ${claim.id})`);
      }
      return { predicate: group.predicate, values: [...byValue.values()] };
    });
}

function parseOptionalTimestamp(raw: string | undefined, flag: string): Date | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`${flag} expects an ISO 8601 timestamp, received "${raw}".`);
  }
  return parsed;
}

export interface ClaimAddInput {
  target: string;
  predicate: string;
  value: string;
  sourceUrl?: string | undefined;
  sourceTitle?: string | undefined;
  excerpt?: string | undefined;
  statedAt?: string | undefined;
  retrievedAt?: string | undefined;
}

export async function opClaimAdd(
  ctx: CliContext,
  input: ClaimAddInput,
): Promise<{ claim: ClaimView; target: ResolvedTarget; note: string }> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const classified = classifyClaimPredicate(input.predicate);
  if (classified.kind === "REFUSED") {
    throw new CliError("CLAIM_PREDICATE_REFUSED", classified.reason, 2);
  }
  if (classified.kind === "UNKNOWN") {
    throw new CliError("CLAIM_PREDICATE_UNKNOWN", classified.message, 2);
  }
  const value = validateClaimValue(input.value);
  if (!value.ok) throw new CliError("CLAIM_VALUE_INVALID", value.message, 2);

  let sourceKind: "OPERATOR" | "WEB" = "OPERATOR";
  let sourceUrl: string | null = null;
  if (input.sourceUrl !== undefined && input.sourceUrl.trim() !== "") {
    const validated = validateClaimSourceUrl(input.sourceUrl);
    if (!validated.ok) throw new CliError("CLAIM_SOURCE_URL_INVALID", validated.message, 2);
    sourceKind = "WEB";
    sourceUrl = validated.url;
  }
  let excerpt: string | null = null;
  if (input.excerpt !== undefined && input.excerpt.trim() !== "") {
    const validated = validateClaimExcerpt(input.excerpt);
    if (!validated.ok) throw new CliError("CLAIM_EXCERPT_INVALID", validated.message, 2);
    excerpt = validated.excerpt;
  }
  const statedAt = parseOptionalTimestamp(input.statedAt, "--stated-at");
  const retrievedAt = parseOptionalTimestamp(input.retrievedAt, "--retrieved-at");

  let record: ClaimRecord;
  try {
    record = await addClaim(ctx.db, {
      userId: ctx.userId,
      targetId: resolved.id,
      predicate: classified.predicate,
      value: value.value,
      sourceKind,
      sourceUrl,
      ...(input.sourceTitle !== undefined && input.sourceTitle.trim() !== ""
        ? { sourceTitle: input.sourceTitle.trim() }
        : {}),
      ...(excerpt !== null ? { excerpt } : {}),
      ...(statedAt !== null ? { statedAt } : {}),
      ...(retrievedAt !== null ? { retrievedAt } : {}),
    });
  } catch (err) {
    if (err instanceof AppError && err.code === AppErrorCode.CONFLICT) {
      throw new CliError(
        "CLAIM_DUPLICATE",
        `${err.message} Re-submitting the same finding is not corroboration — cite a different source or value, or drop it.`,
        2,
      );
    }
    throw err;
  }
  const now = new Date();
  // The label on the response is the CLUSTER's label, not the new row's: the
  // second source for a value must come back CORROBORATED, and the honest
  // answer for the whole predicate is what the caller now sees.
  const cluster = await listClaims(ctx.db, {
    userId: ctx.userId,
    targetId: resolved.id,
    predicate: classified.predicate,
  });
  return {
    claim: toClaimView(record, relationForRows(cluster), now),
    target: resolved,
    note:
      sourceKind === "WEB"
        ? "Stored with its source URL and excerpt hash. Claims stay separate from platform observations in every report."
        : "Stored as an operator assertion (no source URL). It can support a claim but never corroborates one.",
  };
}

export interface ClaimsListResult {
  target: ResolvedTarget;
  groups: ClaimGroupView[];
  retracted: ClaimView[];
  totals: { active: number; retracted: number; predicates: number };
  note: string | null;
}

export async function opClaimList(
  ctx: CliContext,
  input: { target: string; predicate?: string | undefined; includeRetracted?: boolean | undefined },
): Promise<ClaimsListResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  let predicate: ClaimPredicate | undefined;
  if (input.predicate !== undefined) {
    const classified = classifyClaimPredicate(input.predicate);
    if (classified.kind === "REFUSED") {
      throw new CliError("CLAIM_PREDICATE_REFUSED", classified.reason, 2);
    }
    if (classified.kind === "UNKNOWN") {
      throw new CliError("CLAIM_PREDICATE_UNKNOWN", classified.message, 2);
    }
    predicate = classified.predicate;
  }
  const includeRetracted = input.includeRetracted === true;
  const rows = await listClaims(ctx.db, {
    userId: ctx.userId,
    targetId: resolved.id,
    includeRetracted: true,
    ...(predicate !== undefined ? { predicate } : {}),
  });
  const now = new Date();
  const groups = groupActiveClaims(rows, now);
  const retractedRows = rows.filter((row) => row.status === "RETRACTED");
  const active = groups.reduce((count, group) => count + group.claims.length, 0);
  return {
    target: resolved,
    groups,
    retracted: includeRetracted ? retractedRows.map((row) => toClaimView(row, null, now)) : [],
    totals: { active, retracted: retractedRows.length, predicates: groups.length },
    note:
      active === 0 && retractedRows.length === 0
        ? "No claims are recorded for this target. Empty means nobody submitted research yet — it is not a statement that the account has no public footprint."
        : includeRetracted === false && retractedRows.length > 0
          ? `${retractedRows.length} retracted claim(s) are not shown; pass --include-retracted to read them.`
          : null,
  };
}

export async function opClaimRetract(
  ctx: CliContext,
  input: { claimId: string; reason: string; confirm: boolean },
): Promise<{ claim: ClaimView; note: string }> {
  if (input.confirm !== true) {
    throw new CliError(
      "CONFIRMATION_REQUIRED",
      "Retracting a claim changes the record permanently; pass confirm: true (CLI: --yes).",
      2,
    );
  }
  const reason = input.reason.trim();
  if (reason === "") {
    throw new UsageError(
      "A retraction reason is required — a retraction without a why is unreadable to the next operator.",
    );
  }
  let record: ClaimRecord;
  try {
    record = await retractClaim(ctx.db, { userId: ctx.userId, claimId: input.claimId, reason });
  } catch (err) {
    if (err instanceof AppError && err.code === AppErrorCode.NOT_FOUND) {
      throw new CliError("CLAIM_NOT_FOUND", err.message, 2);
    }
    if (err instanceof AppError && err.code === AppErrorCode.CONFLICT) {
      throw new CliError("CLAIM_ALREADY_RETRACTED", err.message, 2);
    }
    throw err;
  }
  return {
    claim: toClaimView(record, null, new Date()),
    note:
      "The row stays readable with its retraction reason; it no longer participates in relation labels or the active sections.",
  };
}

// ---------------------------------------------------------------------------
// research — the honest report over stored rows. Platform observations and
// operator claims are rendered in separate sections and are never merged;
// every empty or unavailable section states its reason in the output itself.
// Deterministic: no provider call, no clock beyond computedAt, no ranking
// beyond what is already stored.
// ---------------------------------------------------------------------------

export interface ResearchResult {
  computedAt: string;
  target: DossierResult["target"];
  identity: { account: DossierResult["account"]; route: DossierResult["route"] };
  platform: {
    counts: DossierResult["counts"];
    profile: DossierResult["profile"];
    media: DossierResult["media"];
  };
  /** Derived from stored captions; the corpus size is part of the payload. */
  themes: {
    state: "DERIVED" | "UNAVAILABLE";
    reason: string | null;
    captionRows: number;
    terms: SynthesisTerm[];
    hashtags: SynthesisTerm[];
    note: string;
  };
  /** Derived from stored publish timestamps; the formula is stated. */
  cadence: {
    state: "DERIVED" | "UNAVAILABLE";
    reason: string | null;
    timestampRows: number;
    firstPublishedAt: string | null;
    lastPublishedAt: string | null;
    medianGapDays: number | null;
    note: string;
  };
  /** Platform-reported insights for OWNED targets; null counts = never read. */
  audience: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    points: number | null;
    absences: number | null;
    latestObservedAt: string | null;
    latest: Array<{
      metric: string;
      period: string;
      dimension: string | null;
      dimensionValue: string | null;
      value: number;
      endTime: string | null;
      observedAt: string;
    }>;
    latestAbsences: Array<{ metric: string; period: string; reason: string }>;
    note: string;
  };
  claims: {
    groups: ClaimGroupView[];
    retracted: ClaimView[];
    /** --since (ISO) narrowing this section only; null when unfiltered. */
    since: string | null;
    /** Claim rows the filter hid — stated, never silently dropped. */
    omittedBefore: number;
    totals: { active: number; retracted: number; predicates: number };
    statement: string;
  };
  contradictions: Array<{ predicate: string; values: Array<{ value: string; sources: string[] }> }>;
  /** Recorded change events in a stated window; null counts = never read (mode-absent). */
  changes: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    windowDays: number;
    since: string | null;
    profileChanges: { count: number; latestAt: string | null } | null;
    postChanges: { count: number; latestAt: string | null } | null;
    followDeltas: { count: number; latestAt: string | null } | null;
    note: string;
  };
  leads: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    note: string;
    items: Array<{ username: string; signals: string[] }>;
  };
  connections: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    note: string;
    truncated: boolean;
    method: RelationshipsResult["method"] | null;
    ranks: RelationshipRank[];
  };
  coverage: DossierCoverageRow[];
  routeUnavailability: DossierResult["routeUnavailability"];
  notes: string[];
}

/** Window for the temporal change summary (Phase 3). Stated in the payload so
 * a zero can only ever be read as "nothing recorded in these N days". */
const RESEARCH_CHANGE_WINDOW_DAYS = 90;

export async function opResearch(
  ctx: CliContext,
  input: { target: string; connectionLimit?: number | undefined; since?: string | undefined },
): Promise<ResearchResult> {
  const computedAt = new Date();
  // Relative forms (7d/24h) resolve against computedAt, so two runs of the same
  // report compose the same filter — the report stays deterministic.
  const since = parseSinceDate(input.since, computedAt);
  const dossier = await opDossier(ctx, { target: input.target });
  const observationMode = dossier.target.observationMode;

  const claimRows = await listClaims(ctx.db, {
    userId: ctx.userId,
    targetId: dossier.target.id,
    includeRetracted: true,
  });
  // --since narrows the claims VIEW only, and the count it hid travels with the
  // report: a filtered report that silently drops rows is a half-truth.
  const visibleClaimRows =
    since === null
      ? claimRows
      : claimRows.filter((row) => (row.retrievedAt ?? row.recordedAt) >= since);
  const omittedBefore = claimRows.length - visibleClaimRows.length;
  const groups = groupActiveClaims(visibleClaimRows, computedAt);
  const retractedRows = visibleClaimRows.filter((row) => row.status === "RETRACTED");
  const contradictions = contradictionGroups(groups);
  const active = groups.reduce((count, group) => count + group.claims.length, 0);

  // --- Phase 2: themes and cadence, derived from stored rows, corpus stated. ---
  const storedTexts = (await listStoredPostTexts(ctx.db, ctx.userId, dossier.target.id)) ?? [];
  const themesDerived = deriveThemes(storedTexts.map((row) => row.caption));
  const cadenceDerived = deriveCadence(storedTexts.map((row) => row.takenAt));
  const corpusCap = dossier.media?.previewLimit ?? null;
  // A bounded preview's figures describe the preview; the caveat travels with
  // every derived section, not just the media listing (FOUNDING §14.1/D48).
  const boundedNote =
    dossier.media?.bounded === true
      ? ` The corpus is the BOUNDED discovery media preview${corpusCap === null ? "" : ` (cap ${corpusCap} rows)`} (FOUNDING §14.1/D48) — it is not "the account's posts", so these figures describe the preview only.`
      : "";

  let themes: ResearchResult["themes"];
  if (storedTexts.length === 0) {
    themes = {
      state: "UNAVAILABLE",
      reason:
        observationMode === "OWNED"
          ? "No post rows are stored yet; themes are counted from stored captions — run a POSTS_SCAN to record some."
          : "The discovery probe has stored no media rows for this account yet; themes are counted from the stored bounded preview.",
      captionRows: 0,
      terms: [],
      hashtags: [],
      note: "Nothing is generated when nothing is stored: an empty corpus is not a quiet account.",
    };
  } else if (themesDerived.captionRows === 0) {
    themes = {
      state: "UNAVAILABLE",
      reason: `${storedTexts.length} stored media row(s) carry no caption text; there is nothing to count.`,
      captionRows: 0,
      terms: [],
      hashtags: [],
      note: `Corpus: ${storedTexts.length} stored media row(s), none with text.${boundedNote}`,
    };
  } else {
    themes = {
      state: "DERIVED",
      reason: null,
      captionRows: themesDerived.captionRows,
      terms: themesDerived.terms,
      hashtags: themesDerived.hashtags,
      note: `Occurrences counted across ${themesDerived.captionRows} stored caption(s) (corpus: ${storedTexts.length} stored media row(s)); a word counts once per occurrence, hashtags separately.${boundedNote}`,
    };
  }

  let cadence: ResearchResult["cadence"];
  if (cadenceDerived.timestampRows === 0) {
    cadence = {
      state: "UNAVAILABLE",
      reason:
        "No publish timestamps are stored for this target; cadence needs the provider's published times, and deriving one from first-observed times would answer a different question.",
      timestampRows: 0,
      firstPublishedAt: null,
      lastPublishedAt: null,
      medianGapDays: null,
      note: `Corpus: ${storedTexts.length} stored media row(s), none with a published timestamp.${boundedNote}`,
    };
  } else {
    cadence = {
      state: "DERIVED",
      reason: null,
      timestampRows: cadenceDerived.timestampRows,
      firstPublishedAt: cadenceDerived.firstPublishedAt,
      lastPublishedAt: cadenceDerived.lastPublishedAt,
      medianGapDays: cadenceDerived.medianGapDays,
      note:
        cadenceDerived.medianGapDays === null
          ? `Only one distinct publish timestamp is stored; a median gap needs at least two. Published times are the provider's, not first-observed.${boundedNote}`
          : `Median of the gaps between ${cadenceDerived.timestampRows} distinct stored publish timestamps (the formula); these are provider times, not first-observed.${boundedNote}`,
    };
  }

  // --- Phase 2: audience, platform-reported insights for OWNED targets only. ---
  let audience: ResearchResult["audience"];
  if (observationMode === "OWNED") {
    const insight = await insightState(ctx.db, dossier.target.igAccountId);
    const latest = await insightLatest(ctx.db, dossier.target.igAccountId);
    audience =
      insight.latestObservedAt === null
        ? {
            state: "UNAVAILABLE",
            reason:
              "No insight rows are recorded for this account; audience metrics require an INSIGHTS_SCAN (an owned-account edge).",
            points: 0,
            absences: 0,
            latestObservedAt: null,
            latest: [],
            latestAbsences: [],
            note: "Nothing is inferred from follower counts or captions to fill this section.",
          }
        : {
            state: "OBSERVED",
            reason: null,
            points: insight.points,
            absences: insight.absences,
            latestObservedAt: insight.latestObservedAt.toISOString(),
            latest: latest.map((point) => ({
              metric: point.metric,
              period: point.period,
              dimension: point.dimension,
              dimensionValue: point.dimensionValue,
              value: point.value,
              endTime: point.endTime === null ? null : point.endTime.toISOString(),
              observedAt: point.observedAt.toISOString(),
            })),
            latestAbsences: insight.latestAbsences,
            note:
              insight.absences > 0
                ? `${insight.absences} row(s) are the platform reporting a metric ABSENT with its reason — absence rows are an answer, never a zero. Latest observed values are one row per (metric, period, dimension).`
                : "Latest observed value per (metric, period, dimension); these are platform-reported figures, not estimates.",
          };
  } else {
    audience = {
      state: "UNAVAILABLE",
      reason:
        "Account insights are an owned-account edge (Instagram API with Instagram Login); the documented Business Discovery route exposes no audience metrics for other accounts (FOUNDING §14). This is platform-absent, not empty.",
      points: null,
      absences: null,
      latestObservedAt: null,
      latest: [],
      latestAbsences: [],
      note: "No audience figure is inferred for an observed account.",
    };
  }

  // --- Phase 3: recorded change events in a stated window. ---
  let changes: ResearchResult["changes"];
  if (observationMode === "OWNED") {
    const summary = await getTargetChangeSummary(
      ctx.db,
      ctx.userId,
      dossier.target.id,
      RESEARCH_CHANGE_WINDOW_DAYS,
      daysStartUtc(computedAt),
    );
    if (summary === null) {
      // The dossier resolved the same ownership moments ago; a null here is an
      // internal inconsistency, and quietly reporting an empty window for it
      // would be exactly the kind of silent half-truth this report refuses.
      throw new CliError(
        "TARGET_NOT_FOUND",
        "The target became unreadable while composing the change summary.",
        2,
      );
    }
    const recorded =
      summary.profileChanges.count + summary.postChanges.count + summary.followDeltas.count;
    const row = (v: { count: number; latestAt: Date | null }): { count: number; latestAt: string | null } => ({
      count: v.count,
      latestAt: v.latestAt === null ? null : v.latestAt.toISOString(),
    });
    changes = {
      state: "OBSERVED",
      reason: null,
      windowDays: summary.windowDays,
      since: summary.since.toISOString(),
      profileChanges: row(summary.profileChanges),
      postChanges: row(summary.postChanges),
      followDeltas: row(summary.followDeltas),
      note: `${recorded} change event(s) recorded in the last ${summary.windowDays} days. Zero recorded rows in this window means no change was RECORDED (gaps between scans record nothing) — it is never evidence that nothing happened.`,
    };
  } else {
    changes = {
      state: "UNAVAILABLE",
      reason:
        "Change detection (profile diffs, post presence, follow deltas) is recorded for accounts this deployment owns; a DISCOVERY target stores bounded preview rows only (FOUNDING §14/§15).",
      windowDays: RESEARCH_CHANGE_WINDOW_DAYS,
      since: null,
      profileChanges: null,
      postChanges: null,
      followDeltas: null,
      note: "This is platform-absent for the mode, not an empty window.",
    };
  }

  let connections: ResearchResult["connections"];
  let leads: ResearchResult["leads"];
  if (observationMode === "OWNED") {
    const relationships = await opRelationships(ctx, {
      target: dossier.target.username,
      limit: input.connectionLimit ?? 10,
    });
    connections = {
      state: "OBSERVED",
      reason: null,
      note: "Evidence-ranked from stored rows only (method below); a count of stored rows, never an inferred affinity.",
      truncated: relationships.truncated,
      method: relationships.method,
      ranks: relationships.ranks,
    };
    leads = {
      state: "OBSERVED",
      reason: null,
      note: "Leads, not claims: accounts that appear in stored signal rows. Nothing here has been researched or asserted.",
      items: relationships.ranks
        .filter((rank) => rank.signals.mentions > 0 || rank.signals.deltas > 0)
        .slice(0, 10)
        .map((rank) => ({
          username: rank.username,
          signals: [
            `mentions x${rank.signals.mentions}`,
            `comments x${rank.signals.comments}`,
            `deltas x${rank.signals.deltas}`,
          ],
        })),
    };
  } else {
    const reason =
      "Follow deltas and relationship signals are recorded only for accounts this deployment owns; the documented Business Discovery route exposes no relationship edges (FOUNDING §14/§15). This is a platform-absent result, not an empty one.";
    connections = {
      state: "UNAVAILABLE",
      reason,
      note: "No relationship ranking exists for an observed account, by platform design.",
      truncated: false,
      method: null,
      ranks: [],
    };
    leads = {
      state: "UNAVAILABLE",
      reason,
      note: "No leads can be derived from rows that the platform never exposes.",
      items: [],
    };
  }

  const notes = [...dossier.notes];
  if (contradictions.length > 0) {
    notes.push(
      "Conflicting claims are surfaced with both sources; IGTrack never chooses between sources.",
    );
  }
  if (since !== null) {
    notes.push(
      `--since ${since.toISOString()} filtered the CLAIMS section only: ${omittedBefore} older claim row(s) are omitted from this report (nothing was deleted; drop --since to read them).`,
    );
  }
  notes.push(
    "Claims and platform observations are reported in separate sections and are never blended; a claim is a sourced finding, not an observation.",
  );

  return {
    computedAt: computedAt.toISOString(),
    target: dossier.target,
    identity: { account: dossier.account, route: dossier.route },
    platform: {
      counts: dossier.counts,
      profile: dossier.profile,
      media: dossier.media,
    },
    themes,
    cadence,
    audience,
    claims: {
      groups,
      retracted: retractedRows.map((row) => toClaimView(row, null, computedAt)),
      since: since === null ? null : since.toISOString(),
      omittedBefore,
      totals: { active, retracted: retractedRows.length, predicates: groups.length },
      statement:
        active === 0
          ? "No claims are recorded for this account: nobody has submitted research yet. Claims require an operator- or agent-supplied source (igtrack_claim_add); IGTrack never generates them."
          : `${active} active claim(s) across ${groups.length} predicate(s); ${contradictions.length} predicate(s) CONFLICTED; ${retractedRows.length} retracted. Claims are operator-submitted findings about outside sources — they are not platform observations.`,
    },
    contradictions,
    changes,
    leads,
    connections,
    coverage: dossier.coverage,
    routeUnavailability: dossier.routeUnavailability,
    notes,
  };
}

// ---------------------------------------------------------------------------
// plan — the investigation planner. Stateless by design: every status is
// recomputed from stored rows (jobs, targets, claims) on each call, so an
// interrupted investigation resumes by asking again; there is no cursor to
// lose and no plan record to drift from reality.
// ---------------------------------------------------------------------------

export const PLAN_GOALS = [
  "FULL",
  "PROFILE",
  "POSTS",
  "STORIES",
  "TAGS",
  "INSIGHTS",
  "CONNECTIONS",
  "RESEARCH",
] as const;
export type PlanGoal = (typeof PLAN_GOALS)[number];

const GOAL_KINDS: Record<PlanGoal, readonly ScanKind[]> = {
  FULL: SCAN_KINDS,
  PROFILE: ["PROFILE_SCAN"],
  POSTS: ["POSTS_SCAN"],
  STORIES: ["STORY_SCAN"],
  TAGS: ["TAGS_SCAN"],
  INSIGHTS: ["INSIGHTS_SCAN"],
  CONNECTIONS: ["FOLLOWER_SCAN", "FOLLOWING_SCAN"],
  RESEARCH: ["PROFILE_SCAN"],
};

export type PlanStepStatus =
  | "DONE"
  | "PENDING"
  | "READY"
  | "STALE"
  | "BLOCKED"
  | "NOT_APPLICABLE";

export interface PlanStep {
  id: string;
  goal: PlanGoal;
  objective: string;
  /** Exact MCP tool that performs this step (the CLI equivalent is its command). */
  tool: string;
  params: Record<string, string | string[] | boolean | number>;
  status: PlanStepStatus;
  reason: string | null;
  dependsOn: string[];
  expectedOutput: string;
  completionCriteria: string;
  evidence: string[];
}

export interface PlanResult {
  computedAt: string;
  target: {
    id: string;
    username: string;
    observationMode: "OWNED" | "DISCOVERY";
    status: string;
  };
  goal: PlanGoal;
  steps: PlanStep[];
  nextAction: {
    tool: string;
    params: Record<string, string | string[] | boolean | number>;
    because: string;
  } | null;
  notes: string[];
}

function jobErrorMessage(job: JobQueueSummary): string {
  return job.errorMessage ?? "see igtrack_scans_list for the recorded failure detail";
}

export async function opPlan(
  ctx: CliContext,
  input: { target: string; goal?: string | undefined },
): Promise<PlanResult> {
  const requested = (input.goal ?? "FULL").toUpperCase();
  if (!(PLAN_GOALS as readonly string[]).includes(requested)) {
    throw new UsageError(`Unknown goal "${input.goal}". Allowed: ${PLAN_GOALS.join(", ")}.`);
  }
  const goal = requested as PlanGoal;
  const computedAt = new Date();
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  const full = await getOwnedTarget(ctx.db, ctx.userId, resolved.id);
  if (full === null) {
    throw new CliError("TARGET_NOT_FOUND", `Target "${input.target}" is not owned by this user.`, 2);
  }
  const jobs = await listJobsForTarget(ctx.db, resolved.id, 100);
  const intervals = resolveScanIntervals(process.env);

  const steps: PlanStep[] = [];
  steps.push({
    id: "target",
    goal: "FULL",
    objective: `Resolve "${input.target}" to a tracked target`,
    tool: "igtrack_status",
    params: {},
    status: "DONE",
    reason: null,
    dependsOn: [],
    expectedOutput: "target identity, mode and status",
    completionCriteria: "the reference resolves to an owned target",
    evidence: [
      `target ${resolved.id} (@${resolved.username}) is ${full.observationMode} and ${full.status}`,
    ],
  });

  for (const kind of GOAL_KINDS[goal]) {
    const base = {
      id: `observe:${kind}`,
      goal,
      objective: `Observe ${kind} through the provider route`,
      tool: "igtrack_scans_run",
      params: { target: resolved.id, kinds: [kind] },
      dependsOn: ["target"],
      expectedOutput: "a queued job; execute it with igtrack_work",
      completionCriteria:
        "a job for this kind completes with an outcome (COMPLETED, COMPLETED_EMPTY or COMPLETED_PARTIAL)",
    };
    if (!isScanKindAllowedForMode(kind, full.observationMode)) {
      steps.push({
        ...base,
        status: "NOT_APPLICABLE",
        reason:
          full.observationMode === "DISCOVERY"
            ? "DISCOVERY target: only DISCOVERY_SCAN is answerable for another account (D47)."
            : "OWNED target: DISCOVERY_SCAN observes another account, not this one (D47).",
        evidence: [],
      });
      continue;
    }
    if (ctx.provider.provider === null) {
      steps.push({
        ...base,
        status: "BLOCKED",
        reason: `provider "${ctx.provider.name}" is not usable: ${ctx.provider.error ?? "unknown reason"}`,
        evidence: [],
      });
      continue;
    }
    if (full.status !== "ACTIVE") {
      steps.push({
        ...base,
        status: "BLOCKED",
        reason: `target is ${full.status}; resume it with igtrack_target_set_status before queueing scans`,
        evidence: [],
      });
      continue;
    }
    if (
      full.scanKinds !== null &&
      full.scanKinds.length > 0 &&
      !full.scanKinds.includes(kind)
    ) {
      steps.push({
        ...base,
        status: "NOT_APPLICABLE",
        reason: "excluded by this target's scan preferences",
        evidence: [],
      });
      continue;
    }
    const kindJobs = jobs.filter((job) => job.kind === kind);
    const activeJob = kindJobs.find(
      (job) => job.status === "queued" || job.status === "running" || job.status === "retry_wait",
    );
    if (activeJob !== undefined) {
      steps.push({
        ...base,
        status: "PENDING",
        reason: `job ${activeJob.id} is ${activeJob.status}; run igtrack_work to execute it`,
        evidence: [`job ${activeJob.id} ${activeJob.status}`],
      });
      continue;
    }
    const succeeded = kindJobs.find((job) => job.status === "succeeded");
    if (succeeded !== undefined) {
      const completedAt = succeeded.completedAt;
      const stale =
        completedAt !== null && computedAt.getTime() - completedAt.getTime() > 2 * intervals[kind];
      steps.push({
        ...base,
        status: stale ? "STALE" : "DONE",
        reason: stale
          ? `last successful ${kind} completed at ${completedAt.toISOString()}; the cadence is ${Math.round(intervals[kind] / 1000)}s`
          : null,
        evidence: [
          `job ${succeeded.id} ${succeeded.status}${succeeded.outcome !== null ? ` (${succeeded.outcome})` : ""} at ${completedAt?.toISOString() ?? "unknown time"}`,
        ],
      });
      continue;
    }
    const failed = kindJobs.find((job) => job.status === "failed");
    steps.push({
      ...base,
      status: "READY",
      reason:
        failed === undefined
          ? null
          : `last attempt failed: ${jobErrorMessage(failed)} (a retry is a new job, not a resumed one)`,
      evidence: failed === undefined ? [] : [`job ${failed.id} failed after ${failed.attempts} attempt(s)`],
    });
  }

  const claimRows = await listClaims(ctx.db, {
    userId: ctx.userId,
    targetId: resolved.id,
    includeRetracted: true,
  });
  const activeClaims = claimRows.filter((row) => row.status === "ACTIVE");

  const claimsRelevant = goal === "FULL" || goal === "RESEARCH";
  if (claimsRelevant) {
    steps.push({
      id: "claims:record",
      goal,
      objective: "Submit operator/agent research findings as sourced claims",
      tool: "igtrack_claim_add",
      params: {
        target: resolved.id,
        predicate: "<CLAIM_PREDICATES entry>",
        value: "<short value>",
        sourceUrl: "https://...",
        excerpt: "<short quotation, <=500 chars>",
      },
      status: activeClaims.length > 0 ? "DONE" : "READY",
      reason:
        activeClaims.length > 0
          ? null
          : "no claims exist yet; research happens outside IGTrack and is submitted, never generated — sensitive person-level predicates are refused at write time",
      dependsOn: ["target"],
      expectedOutput: "claims rows carrying source URLs, excerpts and hashes",
      completionCriteria: "every finding you rely on is stored with its source",
      evidence: activeClaims.length > 0 ? [`${activeClaims.length} active claim(s) recorded`] : [],
    });
  }

  steps.push({
    id: "report:research",
    goal,
    objective: "Read back the honest report: observations and claims in separate sections",
    tool: "igtrack_research",
    params: { target: resolved.id },
    status: "READY",
    reason:
      "the report is a stateless read over stored rows — safe to repeat, deterministic within a day",
    dependsOn: claimsRelevant ? ["target", "claims:record"] : ["target"],
    expectedOutput:
      "sections: identity, platform observations, themes, cadence, audience, recent changes, claims, contradictions, leads, connections, coverage",
    completionCriteria: "every empty or unavailable section states its reason in the output itself",
    evidence: [],
  });

  let nextAction: PlanResult["nextAction"] = null;
  const pending = steps.find((step) => step.status === "PENDING");
  if (pending !== undefined) {
    nextAction = {
      tool: "igtrack_work",
      params: { max: 25 },
      because: `${pending.evidence[0] ?? "a job is queued"} — execution is what produces the observation`,
    };
  } else {
    const chosen =
      steps.find((step) => step.status === "READY") ??
      steps.find((step) => step.status === "STALE");
    if (chosen !== undefined) {
      nextAction = {
        tool: chosen.tool,
        params: chosen.params,
        because: chosen.reason ?? `step "${chosen.id}" is ${chosen.status}`,
      };
    }
  }

  const notes: string[] = [
    "This plan is recomputed from stored rows on every call — there is no plan record and no cursor, so an interrupted investigation resumes by asking again.",
  ];
  if (steps.some((step) => step.status === "BLOCKED")) {
    notes.push("BLOCKED steps name their prerequisite; they cannot be worked around by retrying.");
  }
  if (steps.some((step) => step.status === "NOT_APPLICABLE")) {
    notes.push(
      "NOT_APPLICABLE steps are platform-absent for this target's observation mode, not failures.",
    );
  }

  return {
    computedAt: computedAt.toISOString(),
    target: {
      id: resolved.id,
      username: resolved.username,
      observationMode: full.observationMode,
      status: full.status,
    },
    goal,
    steps,
    nextAction,
    notes,
  };
}

// ---------------------------------------------------------------------------

/** Midnight UTC of `at`. Window boundaries must not move between two runs on
 * the same day, or "deterministic within a day" would be a lie. */
function daysStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function parseSinceDate(raw: string | undefined, now: Date = new Date()): Date | null {
  if (raw === undefined || raw === "") return null;
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const unitMs =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - amount * unitMs);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`--since expects 7d/24h/30m or an ISO date, received "${raw}"`);
  }
  return parsed;
}

export { SCAN_KINDS };

import { createHash } from "node:crypto";
import {
  AppError,
  AppErrorCode,
  CAPABILITY_REGISTRY,
  CLAIM_PREDICATES,
  CLAIM_REVIEW_HORIZON_DAYS,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  EVIDENCE_CLASS,
  EVIDENCE_CLASS_LABELS,
  INVESTIGATION_STAGE,
  INVESTIGATION_STAGE_STATUS,
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
  type EvidenceClass,
  type InstagramProvider,
  type InvestigationGap,
  type InvestigationSource,
  type InvestigationStage,
  type NormalizedAccountRef,
  type NormalizedMentionedComment,
  type SynthesisTerm,
} from "@igtrack/core";
import {
  ACTIVITY_TYPES,
  addClaim,
  addResearchDocument,
  createResearchRun,
  createTarget,
  deleteOwnedTarget,
  enqueueJob,
  findFreshFetchedDocument,
  finishResearchRun,
  getDashboardOverview,
  getEvidenceChain,
  getOperationsSnapshot,
  getAccountByIgId,
  getOwnedTarget,
  getOwnedTargetDetail,
  getUserActivityFeed,
  getRelationshipsForUser,
  RELATIONSHIP_LIVE_SOURCE_KINDS,
  RELATIONSHIP_SYNTHETIC_SOURCE_KINDS,
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
  listResearchRuns,
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
  sourceKindFor,
  type ExecutionSource,
  type RunOutcome,
} from "@igtrack/monitoring";
import {
  ConfigState,
  assessReadiness,
  isBlocking,
  extractCandidates,
  handleSearchQueries,
  researchSearchProviderFromEnv,
  ResearchFetcher,
  type Readiness,
  type ResearchSearchProvider,
  type SearchResult,
} from "@igtrack/ingestion";
import {
  RESEARCH_DOCUMENT_FRESH_HOURS,
  RESEARCH_MAX_SOURCES,
  researchFocusForQuestion,
  researchHostPolicy,
  type ResearchCandidate,
  type ResearchDocumentResult,
  type ResearchSourceType,
} from "@igtrack/core";
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
  /**
   * Set when the configured source does not observe this account: every scan
   * of it will be refused. Present so the operator learns it at add time;
   * absent means the source covers the account (or the target is a DISCOVERY
   * one, which has its own route).
   */
  unobservable?: string;
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

  // A target the configured source cannot observe is still created — the
  // operator may be registering it before configuring the source, and a
  // target is not an observation. But the operator is told NOW (D49's
  // principle: an unreachable account is a fact to learn at add time, not
  // after a week of scans that can never produce data). The wording never
  // says the account does not exist: it says the SOURCE does not cover it.
  const unobservable =
    input.observed === true
      ? null
      : await providerCannotObserve(ctx, username);

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
    ...(unobservable === null ? {} : { unobservable }),
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

/**
 * Why the configured source cannot observe this account, or null when it can.
 *
 * A provider observes a bounded set of accounts: a fixture set observes one,
 * the operator's export observes one, the Graph path observes the authorized
 * owned one. Queueing a scan for an account the source cannot see would file
 * that source's bytes under a real account's record — so the scan is refused
 * here, at enqueue, and again in the worker at execute.
 *
 * The message is careful: "this source does not observe that account" is NOT
 * "that account does not exist".
 */
async function providerCannotObserve(
  ctx: CliContext,
  username: string,
): Promise<string | null> {
  const provider = ctx.provider.provider;
  const observes = provider?.observesAccount;
  if (provider === null || provider === undefined || observes === undefined) return null;
  if (await observes.call(provider, username)) return null;
  return (
    `the configured source "${provider.sourceId}" does not observe @${username}, so no scan of it can succeed. ` +
    "This is a provider/identity mismatch, NOT evidence that the account does not exist. " +
    "Configure a source that covers it (IGTRACK_PROVIDER=graph with the owned account, or IGTRACK_PROVIDER=import with the matching export)."
  );
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
    // Refused at enqueue, before a job exists (the D47 rule, applied to the
    // owned side): a source observes a bounded set of accounts, and a scan
    // the configured source cannot answer would be queued only to fail. The
    // worker refuses it again at execute, so a job enqueued by another path
    // cannot slip a provider's bytes under this account either.
    //
    // A DISCOVERY target is exempt: it is answered by the documented
    // Business Discovery route, which observes OTHER accounts by name, and
    // that route has its own gate (the probe at target creation).
    const unobservable =
      full.observationMode === "OWNED"
        ? await providerCannotObserve(ctx, target.username)
        : null;
    if (unobservable !== null) {
      for (const kind of kinds) {
        skipped.push({ kind, username: target.username, reason: unobservable });
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
      // The provider is passed so the scheduler can skip a target the
      // configured source does not observe — a scan it cannot answer must
      // not be queued just to fail.
      await runSchedulerTick(ctx.db, { provider: src.provider });
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
    /**
     * The two evidence classes, and the rule that keeps them apart. A
     * synthetic interaction is evidence about a fixture, not about a person:
     * it never contributes to the live ranking, and the live ranking never
     * borrows a synthetic row.
     */
    sourceKinds: { live: readonly string[]; synthetic: readonly string[] };
    sourceNote: string;
  };
  // Honest bound: ranks are capped after ranking, so say when the cap hid rows.
  truncated: boolean;
  /** Ranks computed from live observations (platform route or the operator's export). */
  ranks: RelationshipRank[];
  /**
   * Ranks computed from synthetic observations. Rendered separately and
   * labelled: they are evidence about a fixture, never about a person.
   */
  syntheticRanks: RelationshipRank[];
}

export async function opRelationships(
  ctx: CliContext,
  input: { target: string; limit?: number | undefined },
): Promise<RelationshipsResult> {
  const resolved = await resolveTarget(ctx.db, ctx.userId, input.target);
  // Two rankings, never one blended ranking: a live deployment must not have
  // demo data moving its scores, and a synthetic deployment must still be
  // able to show (clearly labelled) what its own fixture produced.
  const [live, synthetic] = await Promise.all([
    getRelationshipsForUser(ctx.db, ctx.userId, resolved.id, RELATIONSHIP_LIVE_SOURCE_KINDS),
    getRelationshipsForUser(ctx.db, ctx.userId, resolved.id, RELATIONSHIP_SYNTHETIC_SOURCE_KINDS),
  ]);
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
      sourceKinds: {
        live: RELATIONSHIP_LIVE_SOURCE_KINDS,
        synthetic: RELATIONSHIP_SYNTHETIC_SOURCE_KINDS,
      },
      sourceNote:
        `Two rankings, never blended. The live ranking is computed only from ${RELATIONSHIP_LIVE_SOURCE_KINDS.join(", ")} ` +
        `observations; the synthetic ranking only from ${RELATIONSHIP_SYNTHETIC_SOURCE_KINDS.join(", ")}. ` +
        "A synthetic interaction is evidence about a fixture, not about a person, so it can never move a live score. " +
        "An empty live ranking beside a populated synthetic one means \"no live observation\", not \"no interaction\".",
    },
    truncated: live.ranks.length > limit,
    ranks: live.ranks.slice(0, limit),
    syntheticRanks: synthetic.ranks.slice(0, limit),
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
  // The research engine writes its run records; the claims it stores are
  // counted under ACCOUNT_RESEARCH's own surface.
  WEB_RESEARCH: ["researchRuns"],
};

export interface DossierCoverageRow {
  capability: string;
  label: string;
  state: "OBSERVED" | "UNAVAILABLE" | "NOT_OBSERVED";
  /**
   * The class of evidence behind the rows: SYNTHETIC (generated data), LIVE
   * (a real platform route or the operator's own export), MIXED, or null
   * when there are no rows. Null means "nothing observed", never "observed
   * with no class".
   */
  evidenceClass: "LIVE" | "SYNTHETIC" | "MIXED" | "NONE" | null;
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
    /**
     * The class of evidence behind the stored rows: SYNTHETIC (generated
     * data), LIVE (a real platform route or the operator's own export),
     * MIXED, or NONE. A target whose rows are synthetic has NOT been
     * observed, and every surface that shows its row counts says so.
     */
    evidenceClass: "LIVE" | "SYNTHETIC" | "MIXED" | "NONE";
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
    // The research engine is refused for a DISCOVERY target at enqueue and at
    // execute (D47): its availability is mode-dependent in a way no provider
    // method expresses.
    entry.engineSupplied === true
      ? mode === "OWNED"
      : entry.operatorSupplied === true
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
        entry.engineSupplied === true
          ? "An autonomous research run is refused for a DISCOVERY target (D47): a run is an owned-account operation. The lawful other-account route is the documented Business Discovery edge (`lookup`, or `targets add --observed`)."
          : mode === "DISCOVERY"
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
        entry.engineSupplied === true
          ? "No research run recorded yet: a run happens only when the operator asks (`igtrack research <target> --run --question \"...\"`), bounded to 10 sources at depth 1. IGTrack never researches on its own, so an empty run list is the honest state, not a gap."
          : entry.operatorSupplied === true
            ? "No claims recorded yet: a claim exists only when a source states it and the operator or their agent submits it (`igtrack claims add`). IGTrack never generates claims, so an empty ledger is the honest state, not a gap."
            : mode === "DISCOVERY"
              ? "Not observed yet: no scan through the documented route has stored rows for this capability."
              : "Not observed yet: no scan has stored rows for this capability. A scan can still run.";
    }

    return {
      capability: entry.id,
      label: entry.label,
      state,
      // The class travels with every row: "OBSERVED" alone would let a
      // fixture's 68 insight points read as a reading of the account.
      evidenceClass: hasWriter && rows > 0 ? dossier.evidenceClass : null,
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
      evidenceClass: dossier.evidenceClass,
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
    /**
     * Local configuration readiness for every variable this deployment
     * depends on. Replaces the old presence-only `graphCredentials` triple,
     * which reported three literal `PASTE_..._HERE` markers as "all-set".
     *
     * It is a statement about the ENVIRONMENT and nothing else:
     * `networkCallMade` is always false, and a clean assessment reads
     * NOT_VERIFIED — never "valid", never "connected".
     */
    config: Readiness;
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
  // Local, value-free, network-free. This is what "are the credentials set?"
  // should always have meant: presence, placeholder shape and basic structure,
  // with the answer recorded as NOT_VERIFIED until an API call proves more.
  const config = assessReadiness(process.env);

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
  } else if (config.problems.length > 0) {
    // The provider started (or a different provider is selected), so the
    // individual problems are the report. Each line names a variable and the
    // corrective action; none of them contains a value.
    findings.push(...config.problems.map((p) => `Configuration: ${p}`));
  }
  if (config.graphCredentialsRequired && config.status === ConfigState.NOT_VERIFIED) {
    findings.push(
      "Graph credentials pass every local check. Connectivity is NOT_VERIFIED: `igtrack doctor` makes no API request, so nothing on this screen proves the token is accepted — run `igtrack lookup <username>` for that.",
    );
  }
  if (ctx.provider.error === null && ctx.provider.synthetic) {
    findings.push(
      "SYNTHETIC EVIDENCE: the fixture provider is active. Every account, count, story, media row and delta this deployment holds is generated fixture data — not live Instagram evidence. No real account was ever contacted, and a fixture-backed report never describes a real account.",
    );
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
      config,
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
  /** The provider that answered: fixture | graph | import. */
  provider: string;
  sourceId: string;
  /**
   * Where that provider reads from. "local" means a file on disk (fixture set
   * or an operator-supplied export) and the answer is synthetic or imported,
   * never an Instagram response; "remote-api" means the Instagram Graph API
   * path. This is the single row that tells a reader whether an
   * ACCOUNT_NOT_FOUND means "not in my data" or "Instagram said no".
   */
  sourceKind: "local" | "remote-api";
  /**
   * Whether the Business Discovery opt-in is on for the graph provider — the
   * one switch that decides whether a cross-account request can be issued at
   * all. Null when another provider is active, where it does not apply.
   */
  businessDiscovery: "on" | "off" | null;
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
  /**
   * One value-free sentence: what this answer means, what was asked for, and
   * what was not attempted. Always consistent with `status` + `error.kind`.
   */
  why: string;
}

function sourceKindOf(sourceId: string): "local" | "remote-api" {
  return sourceId.startsWith("fixture") || sourceId.startsWith("import")
    ? "local"
    : "remote-api";
}

/**
 * Translate status + error kind into the sentence an operator actually needs.
 * Uses the existing capability-status and CapabilityErrorKind conventions —
 * no new taxonomy — and never quotes a credential or an upstream payload.
 */
function explainLookup(
  kind: "local" | "remote-api",
  sourceId: string,
  via: LookupResult["via"],
  status: string,
  error: { kind: string; message: string } | null,
  note: string | null,
): string {
  if (status === CapabilityStatus.AVAILABLE) {
    return via === "discovery"
      ? "Observed through the documented Business Discovery edge: profile fields plus a bounded recent-media preview — not the account's full history, and not its rosters, likers or highlights."
      : kind === "local"
        ? "Answered from the local data set — synthetic fixture rows or an operator-supplied export, not an Instagram response."
        : "Observed from the Instagram Graph API.";
  }
  if (status === CapabilityStatus.PARTIAL) {
    return `Partial answer: ${note ?? "some fields came back, others did not"}. Partial data is stored as partial and is never diffed against a complete snapshot.`;
  }
  if (status === CapabilityStatus.UNAVAILABLE) {
    return `No source exposes this: ${note ?? "the source has no route to the requested data"}. It is reported as absent rather than as an empty or zero answer.`;
  }
  const kindOfError = error?.kind ?? CapabilityErrorKind.UNKNOWN;
  switch (kindOfError) {
    case CapabilityErrorKind.ACCOUNT_NOT_FOUND:
      return kind === "local"
        ? `Not present in the local data set (${sourceId}). That source never contacts Instagram, so this is not evidence that the account does not exist — it is evidence that this deployment has no rows for it.`
        : "The provider could not resolve this account through its documented route.";
    case CapabilityErrorKind.AUTH_REQUIRED:
    case CapabilityErrorKind.FORBIDDEN:
      return `The remote provider refused the request (${kindOfError}). No data was returned, and retrying will not change the answer until the credential or its permissions do.`;
    case CapabilityErrorKind.ACCOUNT_PRIVATE:
      return "The account is not reachable through the documented route (private or otherwise not surfaced), reported with the platform's reason instead of an empty profile.";
    case CapabilityErrorKind.RATE_LIMITED:
      return "Rate limited by the provider. Retryable — no partial result was recorded.";
    case CapabilityErrorKind.NETWORK:
    case CapabilityErrorKind.TIMEOUT:
    case CapabilityErrorKind.PROVIDER_ERROR:
      return `Transport failure (${kindOfError}) before any data was read. Retryable; nothing was persisted.`;
    default:
      return `The provider returned an error (${kindOfError}) instead of data. Nothing was persisted.`;
  }
}

function asLookupResult(
  username: string,
  providerName: string,
  sourceId: string,
  businessDiscovery: "on" | "off" | null,
  via: LookupResult["via"],
  result: CapabilityResult<unknown>,
): LookupResult {
  const error =
    result.error === undefined
      ? null
      : { kind: result.error.kind, message: result.error.message, retryable: result.error.retryable };
  const sourceKind = sourceKindOf(sourceId);
  return {
    username,
    provider: providerName,
    sourceId,
    sourceKind,
    businessDiscovery,
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
    error,
    why: explainLookup(sourceKind, sourceId, via, result.status, error, result.note ?? null),
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
    // Configuration failed before any request could be built. The message
    // already names the offending variables and their corrective actions (see
    // graphConfigBlocker) — it never contains a credential value.
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `Lookup made no request: provider "${ctx.provider.name}" is not usable. ${ctx.provider.error ?? "unknown reason"} Nothing was asked of any source.`,
      3,
    );
  }
  // Read the opt-in from the same environment the provider was built from, so
  // this row cannot claim a discovery request that the provider is refusing to
  // issue. Absent for local sources, where the switch does not exist.
  const businessDiscovery: "on" | "off" | null =
    ctx.provider.name === "graph"
      ? (process.env.IGTRACK_GRAPH_BUSINESS_DISCOVERY ?? "") === "1"
        ? "on"
        : "off"
      : null;
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
    return asLookupResult(username, ctx.provider.name, provider.sourceId, businessDiscovery, "discovery", probe);
  }
  return asLookupResult(username, ctx.provider.name, provider.sourceId, businessDiscovery, "resolve", resolved);
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
  /**
   * The evidence class the read came from. A mention read from a fixture set
   * is a synthetic fact about the fixture, and a caller that only sees the
   * source id would have to guess whether Instagram was asked.
   */
  sourceKind: "local" | "remote-api" | null;
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
  sourceKind: "local" | "remote-api" | null,
  result: CapabilityResult<unknown>,
): MentionedCommentProbeResult {
  return {
    account,
    sourceId,
    sourceKind,
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
  const sourceKind = sourceKindOf(provider.sourceId);
  if (resolved.status !== CapabilityStatus.AVAILABLE || resolved.data === undefined) {
    return asMentionProbe(account, provider.sourceId, sourceKind, resolved);
  }
  const result: CapabilityResult<NormalizedMentionedComment> =
    await provider.getMentionedComment(resolved.data, commentId);
  return asMentionProbe(account, provider.sourceId, sourceKind, result);
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
    /**
     * Leads derived from SYNTHETIC observations. Kept apart from the live
     * ones for the same reason the rankings are: a fixture's invented mention
     * is evidence about the fixture, and a reader who saw it beside a live
     * lead would read it as one.
     */
    syntheticItems: Array<{ username: string; signals: string[] }>;
  };
  connections: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    note: string;
    truncated: boolean;
    method: RelationshipsResult["method"] | null;
    /** Ranks from live observations (a platform route or the operator's export). */
    ranks: RelationshipRank[];
    /** Ranks from synthetic observations — never blended with the live ones. */
    syntheticRanks: RelationshipRank[];
  };
  coverage: DossierCoverageRow[];
  routeUnavailability: DossierResult["routeUnavailability"];
  /** Recent autonomous research runs over public web sources (D69). */
  researchRuns: {
    state: "OBSERVED" | "UNAVAILABLE";
    reason: string | null;
    note: string;
    runs: Array<{
      id: string;
      question: string;
      focusIntent: string;
      status: string;
      startedAt: string;
      finishedAt: string;
      maxSources: number;
      documentsPlanned: number;
      documentsFetched: number;
      documentsFailed: number;
      candidatesFound: number;
      claimsStored: number;
      claimsDuplicate: number;
      claimsRefused: number;
      searchProvider: string | null;
      searchUnavailableReason: string | null;
    }>;
  };
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
      note:
        "Evidence-ranked from stored rows only (method below); a count of stored rows, never an inferred affinity. " +
        "Live and synthetic observations are ranked apart: a fixture's invented interaction is evidence about the fixture, never about a person.",
      truncated: relationships.truncated,
      method: relationships.method,
      ranks: relationships.ranks,
      syntheticRanks: relationships.syntheticRanks,
    };
    const leadItems = (ranks: RelationshipRank[]): Array<{ username: string; signals: string[] }> =>
      ranks
        .filter((rank) => rank.signals.mentions > 0 || rank.signals.deltas > 0)
        .slice(0, 10)
        .map((rank) => ({
          username: rank.username,
          signals: [
            `mentions x${rank.signals.mentions}`,
            `comments x${rank.signals.comments}`,
            `deltas x${rank.signals.deltas}`,
          ],
        }));
    leads = {
      state: "OBSERVED",
      reason: null,
      note: "Leads, not claims: accounts that appear in stored signal rows. Nothing here has been researched or asserted.",
      items: leadItems(relationships.ranks),
      syntheticItems: leadItems(relationships.syntheticRanks),
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
      syntheticRanks: [],
    };
    leads = {
      state: "UNAVAILABLE",
      reason,
      note: "No leads can be derived from rows that the platform never exposes.",
      items: [],
      syntheticItems: [],
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

  // --- Autonomous research runs (D69): what the ENGINE attempted over
  // public web sources, including refusals and failures. Reported beside
  // the claims it produced, never merged into them.
  const runRows = await listResearchRuns(ctx.db, {
    userId: ctx.userId,
    targetId: dossier.target.id,
    limit: 10,
  });
  const researchRuns =
    runRows.length === 0
      ? {
          state: "UNAVAILABLE" as const,
          reason: "No autonomous research run has been recorded for this account yet.",
          note: "Run one with `igtrack research <target> --run --question \"...\"`, or keep submitting claims directly (igtrack claims add).",
          runs: [],
        }
      : {
          state: "OBSERVED" as const,
          reason: null,
          note:
            "Each run records the question, the enforced bounds (≤10 sources, depth 1) and every per-document outcome — " +
            "including fetch refusals and failures, which are findings. Claims extracted by a run live in the CLAIMS " +
            "section above, still validated by the same predicate registry.",
          runs: runRows.map((row) => ({
            id: row.id,
            question: row.question,
            focusIntent: row.focusIntent,
            status: row.status,
            startedAt: row.startedAt.toISOString(),
            finishedAt: row.finishedAt.toISOString(),
            maxSources: row.maxSources,
            documentsPlanned: row.documentsPlanned,
            documentsFetched: row.documentsFetched,
            documentsFailed: row.documentsFailed,
            candidatesFound: row.candidatesFound,
            claimsStored: row.claimsStored,
            claimsDuplicate: row.claimsDuplicate,
            claimsRefused: row.claimsRefused,
            searchProvider: row.searchProvider,
            searchUnavailableReason: row.searchUnavailableReason,
          })),
        };

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
    researchRuns,
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

// ---------------------------------------------------------------------------
// opResearchRun — the acquisition engine (FOUNDING §19, D69).
//
// This is the one place the product reaches outside itself, and it reaches
// only where the operator has already reached: a public URL they named, or a
// page a configured search provider returned as a CANDIDATE. Everything about
// the path is deliberately constraining.
//
//   bounds are enforced, not documented    ≤RESEARCH_MAX_SOURCES documents,
//                                          depth 1 (links on a fetched page
//                                          are counted, never followed);
//   the network is hostile by default      every URL goes through the SSRF
//                                          gate (policy host list, DNS check
//                                          against private/loopback/link-
//                                          local/metadata, robots.txt, per-
//                                          document byte/timeout caps, and
//                                          re-validation of EVERY redirect
//                                          hop) in ResearchFetcher;
//   extraction cannot become inference    the extractor reads four fixed
//                                          field families (JSON-LD, meta,
//                                          mailto, profile links) and never
//                                          parses prose — so text on a page
//                                          is structurally inert against
//                                          prompt injection;
//   storage cannot bypass the ledger      every candidate is re-validated
//                                          through classifyClaimPredicate,
//                                          validateClaimValue and
//                                          validateClaimExcerpt, and stored
//                                          by addClaim — the same functions
//                                          `igtrack claims add` uses, so a
//                                          refused predicate stays refused
//                                          however the value arrived;
//   failure is reported, never hidden     every document's outcome, every
//                                          duplicate and every refusal is
//                                          counted onto the run record and
//                                          shown in the report.
//
// The engine is synchronous and bounded: ≤10 documents × 10s timeout. A
// research run is a foreground operation the operator asked for, not a
// background job — the job queue stays what it was (platform scans), and the
// CLI never blocks on a queue it did not create.
// ---------------------------------------------------------------------------

export interface ResearchRunInput {
  target: string;
  question: string;
  /** Public URLs the operator names explicitly. Highest trust tier. */
  urls?: readonly string[];
  /** Cap on documents fetched this run (1..RESEARCH_MAX_SOURCES). */
  maxSources?: number;
  /** Ignore the freshness window and refetch everything. */
  refresh?: boolean;
}

export interface ResearchRunResult {
  runId: string;
  target: DossierResult["target"];
  question: string;
  focus: { intent: string; priorities: string[]; rationale: string };
  bounds: {
    maxSources: number;
    maxDepth: number;
    enforced: string;
    documentsTruncated: number;
  };
  search: {
    provider: string | null;
    queries: string[];
    unavailableReason: string | null;
    candidateUrls: number;
  };
  documents: ResearchDocumentResult[];
  totals: {
    planned: number;
    fetched: number;
    reused: number;
    failed: number;
    candidates: number;
    claimsStored: number;
    claimsDuplicate: number;
    claimsRefused: number;
    /** Pages read but discarded because they never named the handle. */
    pagesDiscarded: number;
    /** Candidates dropped because the statement named the source, not the account. */
    claimsUnattributed: number;
  };
  claims: ClaimView[];
  status: "COMPLETED" | "COMPLETED_PARTIAL" | "FAILED";
  notes: string[];
}

/** Strip the fragment: two URLs differing only in #fragment are one page. */
function normalizeResearchUrl(raw: string): string | null {
  const validated = validateClaimSourceUrl(raw);
  if (!validated.ok) return null;
  try {
    const url = new URL(validated.url);
    url.hash = "";
    // Canonical form so the same page reached through a tracking link and
    // through its clean URL counts ONCE: query parameters that only identify
    // a campaign are dropped, the host is lowercased, and a trailing slash
    // (a different path in the strict sense, the same page in practice) is
    // removed. Every other parameter is kept — a parameter that carries data
    // (an article id, a locale) would change which page is fetched.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|igsh|igshid|ref|mc_cid|mc_eid|mkt_tok|yclid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    if (url.searchParams.toString() === "") url.search = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return validated.url;
  }
}

export async function opResearchRun(
  ctx: CliContext,
  input: ResearchRunInput,
  // Structural subset, not the concrete class: the engine only ever calls
  // fetchPage(), and a scripted double with that one method is how the test
  // matrix exercises the full path without sockets.
  deps: { fetcher?: Pick<ResearchFetcher, "fetchPage"> } = {},
): Promise<ResearchRunResult> {
  const question = input.question.trim();
  if (question === "") {
    throw new UsageError(
      "A research run needs a --question: what are we trying to find out about this account?",
    );
  }
  const dossier = await opDossier(ctx, { target: input.target });
  if (dossier.target.observationMode === "DISCOVERY") {
    // Discovery targets are observed through the Business Discovery probe.
    // Running an autonomous web run against a name the operator has not
    // owned would blur the ownership line D47 draws; the operator can still
    // submit claims for a discovery target, just not commission a run.
    throw new CliError(
      "RESEARCH_RUN_NOT_APPLICABLE",
      "Autonomous research runs apply to OWNED targets. A DISCOVERY target is another public account observed " +
        "through the Business Discovery probe; record what you learn as claims (igtrack claims add) instead.",
      2,
    );
  }

  const maxSources = Math.min(
    Math.max(input.maxSources ?? RESEARCH_MAX_SOURCES, 1),
    RESEARCH_MAX_SOURCES,
  );
  const focus = researchFocusForQuestion(question);
  const fetcher = deps.fetcher ?? new ResearchFetcher();
  const startedAt = new Date();

  // --- Source plan: operator URLs first, then search candidates, then
  // previously-cited claim sources (re-checking our own citations is the
  // cheapest honest source there is).
  const operatorUrls: string[] = [];
  const rejectedOperatorUrls: Array<{ url: string; reason: string }> = [];
  for (const raw of input.urls ?? []) {
    const normalized = normalizeResearchUrl(raw);
    if (normalized === null) {
      rejectedOperatorUrls.push({
        url: raw,
        reason: `"${raw}" is not an absolute http(s) URL; it was not planned.`,
      });
    } else {
      operatorUrls.push(normalized);
    }
  }

  let searchProviderName: string | null = null;
  let searchQueries: string[] = [];
  let searchUnavailableReason: string | null = null;
  const searchCandidateUrls: string[] = [];
  {
    const { researchSearchProviderFromEnv, handleSearchQueries } = await import("@igtrack/ingestion");
    const provider = researchSearchProviderFromEnv();
    searchProviderName = provider.name === "none" ? null : provider.name;
    // The handle's own query budget (D74), shared with the audit probe so
    // both surfaces ask the same four questions of the same index. The old
    // pair here — `"H" organization` / `"H" about contact` — was a near
    // duplicate that spent two requests on the same token-overlap results.
    const account = dossier.target.username;
    searchQueries = handleSearchQueries(account);
    for (const query of searchQueries) {
      const outcome = await provider.search(query, 5);
      if (outcome.unavailableReason !== null && searchUnavailableReason === null) {
        searchUnavailableReason = outcome.unavailableReason;
      }
      // A transport failure is a fact about the search, not an empty result
      // set: dropping it would render a broken index as "nothing was found".
      if (outcome.error !== null && searchUnavailableReason === null) {
        searchUnavailableReason = `Search failed: ${outcome.error}`;
      }
      for (const result of outcome.results) {
        const normalized = normalizeResearchUrl(result.url);
        if (normalized !== null) searchCandidateUrls.push(normalized);
      }
    }
  }

  // Previously-cited claim sources for this target: re-reading our own
  // citations costs nothing new and keeps runs honest about drift.
  const priorClaimUrls = (
    await listClaims(ctx.db, { userId: ctx.userId, targetId: dossier.target.id })
  )
    .map((row) => (row.sourceUrl === null ? null : normalizeResearchUrl(row.sourceUrl)))
    .filter((url): url is string => url !== null);

  const deduped: Array<{ url: string; sourceType: ResearchDocumentResult["sourceType"] }> = [];
  const seenUrls = new Set<string>();
  const pushUrl = (url: string, sourceType: ResearchDocumentResult["sourceType"]): void => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    deduped.push({ url, sourceType });
  };
  for (const url of operatorUrls) pushUrl(url, "OPERATOR_SUPPLIED_URL");
  for (const url of searchCandidateUrls) pushUrl(url, "SEARCH_RESULT");
  for (const url of priorClaimUrls) pushUrl(url, "OPERATOR_SUPPLIED_URL");

  const planned = deduped.slice(0, maxSources);
  const documentsTruncated = Math.max(deduped.length - planned.length, 0);

  // --- The run record exists BEFORE the first fetch: a run that dies
  // mid-flight still leaves evidence of what it attempted.
  const run = await createResearchRun(ctx.db, {
    userId: ctx.userId,
    targetId: dossier.target.id,
    question,
    focusIntent: focus.intent,
    focusPriorities: focus.priorities,
    focusRationale: focus.rationale,
    maxSources,
    maxDepth: 1,
    searchProvider: searchProviderName,
    searchQueries,
    searchUnavailableReason,
    operatorUrlCount: operatorUrls.length,
    boundsTruncated: documentsTruncated,
    startedAt,
  });

  const notes: string[] = [];
  if (rejectedOperatorUrls.length > 0) {
    for (const rejected of rejectedOperatorUrls) {
      notes.push(`Not planned: ${rejected.reason}`);
    }
  }
  if (documentsTruncated > 0) {
    notes.push(
      `${documentsTruncated} candidate URL(s) were NOT fetched: this run is capped at ${maxSources} documents ` +
        "(FOUNDING §19 bounds). Re-run with --max-sources or narrower question to cover them.",
    );
  }
  if (searchUnavailableReason !== null) {
    notes.push(searchUnavailableReason);
  }

  const documents: ResearchDocumentResult[] = [];
  const freshSince = new Date(Date.now() - RESEARCH_DOCUMENT_FRESH_HOURS * 3600 * 1000);
  const claimViews: ClaimView[] = [];
  let fetched = 0;
  let reused = 0;
  let failed = 0;
  let candidatesTotal = 0;
  let claimsStored = 0;
  let claimsDuplicate = 0;
  let claimsRefused = 0;
  let pagesDiscarded = 0;
  let claimsUnattributed = 0;
  const now = new Date();

  for (const plannedDoc of planned) {
    // Freshness reuse: a FETCHED document for this URL inside the window is
    // read back, not refetched. Reuse is reported as REUSED — the operator
    // sees which evidence is old, never a silent substitution.
    const fresh =
      input.refresh === true
        ? null
        : await findFreshFetchedDocument(ctx.db, {
            userId: ctx.userId,
            url: plannedDoc.url,
            since: freshSince,
          });

    if (fresh !== null && fresh.title !== null && fresh.byteSize !== null) {
      reused += 1;
      const result: ResearchDocumentResult = {
        url: plannedDoc.url,
        outcome: "REUSED",
        outcomeReason: `Fetched ${fresh.retrievedAt?.toISOString() ?? "previously"} (inside the ${RESEARCH_DOCUMENT_FRESH_HOURS}h freshness window); pass --refresh to refetch.`,
        httpStatus: fresh.httpStatus,
        title: fresh.title,
        contentType: fresh.contentType,
        byteSize: fresh.byteSize,
        contentSha256: fresh.contentSha256,
        retrievedAt: fresh.retrievedAt?.toISOString() ?? null,
        sourceType: plannedDoc.sourceType,
        candidatesFound: fresh.candidatesFound,
        linksNotFollowed: 0,
      };
      documents.push(result);
      await addResearchDocument(ctx.db, {
        runId: run.id,
        userId: ctx.userId,
        url: plannedDoc.url,
        sourceType: plannedDoc.sourceType,
        outcome: "REUSED",
        outcomeReason: result.outcomeReason,
        httpStatus: fresh.httpStatus,
        title: fresh.title,
        contentType: fresh.contentType,
        byteSize: fresh.byteSize,
        contentSha256: fresh.contentSha256,
        retrievedAt: fresh.retrievedAt,
        candidatesFound: fresh.candidatesFound,
        linksNotFollowed: 0,
      });
      continue;
    }

    const response = await fetcher.fetchPage(plannedDoc.url);
    if (!response.ok) {
      failed += 1;
      const outcome = RESEARCH_FETCH_OUTCOMES[response.kind] ?? "FAILED";
      const result: ResearchDocumentResult = {
        url: plannedDoc.url,
        outcome,
        outcomeReason: response.reason,
        httpStatus: response.httpStatus,
        title: null,
        contentType: null,
        byteSize: null,
        contentSha256: null,
        retrievedAt: null,
        sourceType: plannedDoc.sourceType,
        candidatesFound: 0,
        linksNotFollowed: 0,
      };
      documents.push(result);
      await addResearchDocument(ctx.db, {
        runId: run.id,
        userId: ctx.userId,
        url: plannedDoc.url,
        sourceType: plannedDoc.sourceType,
        outcome,
        outcomeReason: response.reason,
        httpStatus: response.httpStatus,
        title: null,
        contentType: null,
        byteSize: null,
        contentSha256: null,
        retrievedAt: null,
        candidatesFound: 0,
        linksNotFollowed: 0,
      });
      continue;
    }

    fetched += 1;
    const extracted = extractCandidates(response.body);
    // Depth-1 bound: count the links we deliberately did not follow, so the
    // run says out loud what it chose not to do.
    const linksNotFollowed = (response.body.match(/<a\s[^>]*href/gi) ?? []).length;
    candidatesTotal += extracted.candidates.length;

    const contentSha256 = createHash("sha256")
      .update(response.body, "utf8")
      .digest("hex");

    // --- Relevance gate: the SAME gate the audit probe applies. A search hit
    // is a machine suggestion; a page that never names the handle was not
    // "found" for it, and storing that page's structured fields as claims
    // ABOUT the handle is the inference this product refuses. An
    // operator-named page bypasses the gate — the operator asserted its
    // relevance by naming it.
    const pageMentionsHandle = handleMentioned(
      `${response.finalUrl}\n${extracted.title ?? ""}\n${response.body}`,
      dossier.target.username,
    );
    if (plannedDoc.sourceType === "SEARCH_RESULT" && !pageMentionsHandle) {
      pagesDiscarded += 1;
      const discardedReason = `Discarded — this page never names @${dossier.target.username}, so it cannot be a statement about that account.`;
      const discardedResult: ResearchDocumentResult = {
        url: response.finalUrl,
        outcome: "FETCHED",
        outcomeReason: discardedReason,
        httpStatus: response.httpStatus,
        title: extracted.title,
        contentType: response.contentType,
        byteSize: response.byteSize,
        contentSha256,
        retrievedAt: response.fetchedAt.toISOString(),
        sourceType: plannedDoc.sourceType,
        candidatesFound: 0,
        linksNotFollowed,
      };
      documents.push(discardedResult);
      await addResearchDocument(ctx.db, {
        runId: run.id,
        userId: ctx.userId,
        url: response.finalUrl,
        sourceType: plannedDoc.sourceType,
        outcome: "FETCHED",
        outcomeReason: discardedReason,
        httpStatus: response.httpStatus,
        title: extracted.title,
        contentType: response.contentType,
        byteSize: response.byteSize,
        contentSha256,
        retrievedAt: response.fetchedAt,
        candidatesFound: 0,
        linksNotFollowed,
      });
      continue;
    }

    // --- Validation gate: the SAME path `igtrack claims add` uses. The
    // extractor proposes; the ledger disposes.
    let stored = 0;
    let duplicates = 0;
    let refused = 0;
    let unattributed = 0;
    const pageHost = (() => {
      try {
        return new URL(response.finalUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    for (const candidate of extracted.candidates as ResearchCandidate[]) {
      const classified = classifyClaimPredicate(candidate.predicate);
      if (classified.kind !== "ALLOWED") {
        refused += 1;
        continue;
      }
      const value = validateClaimValue(candidate.value);
      if (!value.ok) {
        refused += 1;
        continue;
      }
      const excerpt = validateClaimExcerpt(candidate.excerpt);
      if (!excerpt.ok) {
        refused += 1;
        continue;
      }
      // --- Attribution gate: on a MACHINE-FOUND page, a stored statement must
      // itself involve the handle — its value names the handle as a token, or
      // the page's own host does. A third-party article ABOUT the account
      // also describes its SOURCE (the publisher's name, its own social
      // links, its address); attributing those to the account would be a
      // false claim about the account. Operator-named pages bypass this, for
      // the same reason they bypass the relevance gate.
      if (
        plannedDoc.sourceType === "SEARCH_RESULT" &&
        !handleMentioned(value.value, dossier.target.username) &&
        !handleMentioned(pageHost, dossier.target.username)
      ) {
        unattributed += 1;
        continue;
      }
      try {
        const record = await addClaim(ctx.db, {
          userId: ctx.userId,
          targetId: dossier.target.id,
          predicate: classified.predicate,
          value: normalizeClaimValue(value.value),
          sourceKind: "WEB",
          sourceUrl: response.finalUrl,
          sourceTitle: extracted.title,
          excerpt: excerpt.excerpt,
          statedAt: null,
          retrievedAt: response.fetchedAt,
          researchRunId: run.id,
        });
        stored += 1;
        claimViews.push(toClaimView(record, null, now));
      } catch (err) {
        if (err instanceof AppError && err.code === AppErrorCode.CONFLICT) {
          duplicates += 1;
          continue;
        }
        throw err;
      }
    }
    claimsStored += stored;
    claimsDuplicate += duplicates;
    claimsRefused += refused;
    claimsUnattributed += unattributed;

    const result: ResearchDocumentResult = {
      url: response.finalUrl,
      outcome: "FETCHED",
      outcomeReason:
        linksNotFollowed > 0
          ? `${linksNotFollowed} link(s) on this page were NOT followed (depth-1 bound).`
          : null,
      httpStatus: response.httpStatus,
      title: extracted.title,
      contentType: response.contentType,
      byteSize: response.byteSize,
      contentSha256,
      retrievedAt: response.fetchedAt.toISOString(),
      sourceType: plannedDoc.sourceType,
      candidatesFound: extracted.candidates.length,
      linksNotFollowed,
    };
    documents.push(result);
    await addResearchDocument(ctx.db, {
      runId: run.id,
      userId: ctx.userId,
      url: response.finalUrl,
      sourceType: plannedDoc.sourceType,
      outcome: "FETCHED",
      outcomeReason: result.outcomeReason,
      httpStatus: response.httpStatus,
      title: extracted.title,
      contentType: response.contentType,
      byteSize: response.byteSize,
      contentSha256,
      retrievedAt: response.fetchedAt,
      candidatesFound: extracted.candidates.length,
      linksNotFollowed,
    });
  }

  const status: ResearchRunResult["status"] =
    failed === 0 && documentsTruncated === 0
      ? "COMPLETED"
      : fetched > 0 || reused > 0
        ? "COMPLETED_PARTIAL"
        : planned.length === 0
          ? "COMPLETED"
          : "FAILED";

  await finishResearchRun(ctx.db, {
    runId: run.id,
    userId: ctx.userId,
    status,
    documentsPlanned: planned.length,
    documentsFetched: fetched + reused,
    documentsFailed: failed,
    candidatesFound: candidatesTotal,
    claimsStored,
    claimsDuplicate,
    claimsRefused,
    finishedAt: new Date(),
  });

  if (claimsDuplicate > 0) {
    notes.push(
      `${claimsDuplicate} candidate(s) were already recorded and were not re-stored: re-submitting the same finding ` +
        "is not corroboration.",
    );
  }
  if (claimsRefused > 0) {
    notes.push(
      `${claimsRefused} candidate(s) were refused by the claim predicate registry before storage — a refusal is a ` +
        "boundary, not a bug (FOUNDING §14/§18).",
    );
  }
  if (pagesDiscarded > 0) {
    notes.push(
      `${pagesDiscarded} fetched page(s) were DISCARDED because they never named the handle: a search hit is a ` +
        "machine suggestion, and a page that does not mention the account cannot be a statement about it. " +
        "Weak coverage, not an absence of public evidence.",
    );
  }
  if (claimsUnattributed > 0) {
    notes.push(
      `${claimsUnattributed} candidate(s) were NOT attributed to this account: the statement named the source page, ` +
        "not the handle. A third-party publisher's own name, links and address describe the publisher.",
    );
  }
  if (planned.length === 0 && searchUnavailableReason !== null) {
    notes.push(
      "No sources were available to this run. Configure a search provider or pass --url to name public pages " +
        "directly; the engine will not invent sources.",
    );
  }
  notes.push(
    "Extracted claims are stored with their source URL, page title, excerpt and SHA-256; they appear in the claims " +
      "section of `igtrack research` and are never presented as platform observations.",
  );

  return {
    runId: run.id,
    target: dossier.target,
    question,
    focus: { intent: focus.intent, priorities: focus.priorities, rationale: focus.rationale },
    bounds: {
      maxSources,
      maxDepth: 1,
      enforced: `${planned.length} document(s) planned of ${deduped.length} candidate(s); depth 1 — links on fetched pages are counted, never followed.`,
      documentsTruncated,
    },
    search: {
      provider: searchProviderName,
      queries: searchQueries,
      unavailableReason: searchUnavailableReason,
      candidateUrls: searchCandidateUrls.length,
    },
    documents,
    totals: {
      planned: planned.length,
      fetched,
      reused,
      failed,
      candidates: candidatesTotal,
      claimsStored,
      claimsDuplicate,
      claimsRefused,
      pagesDiscarded,
      claimsUnattributed,
    },
    claims: claimViews,
    status,
    notes,
  };
}

/**
 * One vocabulary for "the fetch did not produce a document", shared by the
 * acquisition run (D69) and the audit's public-web probe (D70): two surfaces
 * must not describe the same refusal with two different words.
 */
const RESEARCH_FETCH_OUTCOMES: Record<string, ResearchDocumentResult["outcome"]> = {
  UNSAFE_URL: "UNSAFE_URL",
  BLOCKED_BY_POLICY: "BLOCKED_BY_POLICY",
  BLOCKED_BY_ROBOTS: "BLOCKED_BY_ROBOTS",
  BLOCKED_CONTENT_TYPE: "BLOCKED_CONTENT_TYPE",
  TOO_LARGE: "TOO_LARGE",
  TIMEOUT: "TIMEOUT",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  NETWORK_ERROR: "FAILED",
};

// ---------------------------------------------------------------------------
/**
 * Does `text` contain `handle` (case-insensitively) as a DELIMITED token —
 * not as an inner fragment?
 *
 * Phase-3 measurement (SOURCE-AUDIT §11): substring matching let the
 * near-miss handle `nasaa` match inside `nasaa_research`, and it is how
 * `nasa` would match "nasal" or a three-letter handle match "said". Letters,
 * digits and underscore are handle characters (IG handles are [a-z0-9._]), so
 * a match touching either side of them belongs to a LONGER handle-like token
 * and is a different string. Hyphen and period are delimiters: `nasa.gov`
 * and `natgeo-breaks` still name the handle. Deliberate residual: a longer
 * dot-joined handle (`other.name` containing `name`) still matches — periods
 * must stay delimiters or every domain form stops matching, which would be a
 * genuine false rejection.
 */
export function handleMentioned(text: string, handle: string): boolean {
  const needle = handle.toLowerCase();
  if (needle === "") return false;
  const haystack = text.toLowerCase();
  const isHandleChar = (ch: string): boolean => /[a-z0-9_]/.test(ch);
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const before = at > 0 ? haystack[at - 1] : undefined;
    const after = at + needle.length < haystack.length ? haystack[at + needle.length] : undefined;
    if (
      (before === undefined || !isHandleChar(before)) &&
      (after === undefined || !isHandleChar(after))
    ) {
      return true;
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

// opAuditWebProbe — the public-web phase of the audit (FOUNDING §19, D70).
//
// The founder's question is about an ARBITRARY username, so the workflow may
// not require a tracked (let alone owned) target before it may read public
// pages that name the handle. This probe is:
//
//   read-only by construction — it takes no database handle, so it cannot
//     store, register, queue or mutate anything;
//   bounded — the same compile-time bounds as an acquisition run, at the
//     audit's smaller default document ceiling;
//   gated — the same URL gate, robots check, content-type allowlist, byte cap
//     and timeout, so an instagram.com URL is refused here exactly as an
//     acquisition run refuses it: platform data has one lawful route;
//   evidence-honouring — every fact carries its source URL, page title, field,
//     extraction method and retrieval time, and is labelled a THIRD-PARTY
//     STATEMENT about the handle, never a platform observation about an
//     account;
//   inference-free — the extractor reads fixed structured fields only, the
//     closed predicate registry disposes, and `inferences` is a statement of
//     that absence rather than a confidence number the product cannot earn.
// ---------------------------------------------------------------------------

/** Default document ceiling for one audit's web phase (a probe, not a run). */
export const AUDIT_WEB_MAX_SOURCES = 5;

export interface AuditWebDocument {
  url: string;
  outcome: ResearchDocumentResult["outcome"];
  outcomeReason: string | null;
  httpStatus: number | null;
  title: string | null;
  contentType: string | null;
  byteSize: number | null;
  contentSha256: string | null;
  retrievedAt: string | null;
  sourceType: ResearchSourceType;
  /**
   * Whether the RETRIEVED page (final URL, title or body) names the exact
   * handle. null = not observed (the fetch failed), never false: absence of a
   * read is not a reading that said no.
   */
  mentionsHandle: boolean | null;
  /** Structured-field facts this document contributed. */
  facts: number;
  /** Candidates this document proposed that the predicate registry refused. */
  refused: number;
  /** Structured values discarded because the page never named the handle. */
  discarded: number;
  /**
   * Structured values this page DID name the handle for, but which were not
   * attributed: on a machine-found page the statement itself did not involve
   * the handle (its value and the page's host both name the source, not the
   * account). Counted, never silently dropped.
   */
  unattributed: number;
  linksNotFollowed: number;
}

/** A fact a public page STATES in a structured field — a third-party statement. */
export interface AuditWebFact {
  predicate: string;
  value: string;
  excerpt: string;
  /** The exact structured field the value came from, e.g. `ld+json Organization.name`. */
  field: string;
  method: string;
  /** Provenance class. Always the strongest the engine has: a documented field. */
  provenance: "PUBLIC_WEB_DOCUMENTED";
  sourceUrl: string;
  sourceTitle: string | null;
  sourceDomain: string | null;
  retrievedAt: string | null;
  /** A link-based fact asserts association, never account ownership. */
  uncertainty: string | null;
}

export interface AuditWebRelation {
  predicate: string;
  /** Derived from the facts below; a conflict shows BOTH values and picks no winner. */
  label: string;
  values: string[];
  sourceDomains: string[];
  facts: number;
}

/**
 * Did a SEARCH actually happen, and what did it answer? The four states are
 * the difference between "we never asked", "we asked and found nothing" and
 * "we asked and the source could not answer" — a zero-search run may never be
 * presented as an investigation (FOUNDING §19, D73).
 */
export type AuditSearchState =
  /** No provider configured (unset / none / a selected provider with no key). */
  | "SEARCH_NOT_CONFIGURED"
  /** The provider answered and returned at least one candidate URL. */
  | "SEARCH_SUCCEEDED"
  /** The provider answered and genuinely returned no results. */
  | "SEARCH_NO_RESULTS"
  /** The provider could not answer: transport error, quota, bad credential, upstream failure. */
  | "SEARCH_FAILED";

/**
 * Retrieval outcome, in the repository's own run-status vocabulary
 * (COMPLETED / COMPLETED_PARTIAL / FAILED): a partial pass is PARTIAL, never
 * "nothing found", and a pass where every document failed is FAILED.
 */
export type AuditRetrievalState =
  | "NOT_ATTEMPTED"
  | "COMPLETED"
  | "COMPLETED_PARTIAL"
  | "FAILED";

/**
 * WHERE the public-web phase stopped, as one label (Phase 2). The six
 * sparse-result situations an operator must be able to tell apart: no source
 * was configured, the source could not answer, the source answered with zero
 * candidates, candidates existed but none could be read, pages were read but
 * none name the handle, relevant pages named it but nothing extractable
 * survived the predicate registry, or evidence was actually extracted. A
 * "zero facts" headline is never one of these by itself — it always arrives
 * with the one below.
 */
export type AuditWebOutcomeClass =
  /** No search provider configured and no --url given: nothing could be asked. */
  | "SEARCH_UNAVAILABLE"
  /** A provider was selected but could not answer (transport, quota, credential). */
  | "SEARCH_FAILED"
  /** Search ran and genuinely returned no candidates. */
  | "SEARCH_NO_CANDIDATES"
  /** Candidates existed, but no page could be read (all failed or were skipped). */
  | "CANDIDATES_INACCESSIBLE"
  /** Pages were fetched, but none names the exact handle — poor coverage, not a verdict. */
  | "PAGES_IRRELEVANT"
  /** Pages naming the handle were fetched, but no candidate survived extraction/validation. */
  | "RELEVANT_NO_FACTS"
  /** At least one third-party statement about the handle was extracted with its citation. */
  | "EVIDENCE_EXTRACTED";

/** One search candidate's fate: why it ranked and whether it was ever read. */
export interface AuditWebCandidate {
  url: string;
  disposition: "PLANNED" | "SKIPPED_BY_POLICY" | "NOT_FETCHED";
  reason: string;
}

export interface AuditWebReport {
  attempted: boolean;
  /** Whether any source — operator URL or search provider — existed to plan. */
  sourcesAvailable: boolean;
  search: {
    provider: string | null;
    /** What the SEARCH step did — never conflated with what retrieval found. */
    state: AuditSearchState;
    queries: string[];
    /** Per-query result count and error: exactly what each question returned. */
    perQuery: Array<{ query: string; results: number; error: string | null }>;
    candidateUrls: number;
    /** Candidates whose own result summary (url/title/snippet) names the handle. */
    relevantCandidates: number;
    unavailableReason: string | null;
    /** Provider-side caveat about coverage (e.g. a degraded fallback index). */
    note: string | null;
  };
  /** What RETRIEVAL did with the plan, in run-status vocabulary. */
  retrievalState: AuditRetrievalState;
  /** Where the phase stopped, as one deterministic label — see the type's doc. */
  outcomeClass: AuditWebOutcomeClass;
  bounds: {
    maxSources: number;
    maxDepth: number;
    enforced: string;
    documentsTruncated: number;
  };
  /** Every search candidate with its ranking reason and fate (bounded by the query budget). */
  candidates: AuditWebCandidate[];
  documents: AuditWebDocument[];
  facts: AuditWebFact[];
  relations: AuditWebRelation[];
  /** URLs the operator named that could not even be planned, with the reason. */
  rejectedUrls: Array<{ url: string; reason: string }>;
  totals: {
    planned: number;
    fetched: number;
    /** Real failures: a request that was made and did not deliver a page. */
    failed: number;
    /** Structural refusals (policy) — never attempted, never counted as failed. */
    skipped: number;
    /** Fetched pages that name the exact handle in URL, title or body. */
    pagesNamingHandle: number;
    facts: number;
    refused: number;
    /** Values from machine-found pages that did not involve the handle (self-identification). */
    unattributed: number;
  };
  /**
   * Deliberately a statement, not a list: this product derives no inference
   * from public-web text and stores no model output as evidence. Anything
   * beyond what the sources state is the operator's judgement, labelled as
   * theirs.
   */
  inferences: string;
  /** One value-free sentence: what ran, what did not, and why. */
  why: string;
  notes: string[];
}

/**
 * One read-only pass over the public web for one handle. No `ctx`: without a
 * database handle this function cannot write, which is what makes the audit's
 * "wrote no row" promise structural rather than a convention.
 */
export async function opAuditWebProbe(
  input: { username: string; urls?: readonly string[]; maxSources?: number },
  deps: {
    fetcher?: Pick<ResearchFetcher, "fetchPage">;
    search?: ResearchSearchProvider;
  } = {},
): Promise<AuditWebReport> {
  const username = input.username;
  const maxSources = Math.min(
    Math.max(input.maxSources ?? AUDIT_WEB_MAX_SOURCES, 1),
    RESEARCH_MAX_SOURCES,
  );

  // --- Source plan: operator-named pages first, then search candidates.
  const operatorUrls: string[] = [];
  const rejectedUrls: Array<{ url: string; reason: string }> = [];
  for (const raw of input.urls ?? []) {
    const normalized = normalizeResearchUrl(raw);
    if (normalized === null) {
      rejectedUrls.push({
        url: raw,
        reason: `"${raw}" is not an absolute http(s) URL with a citable host; it was not planned.`,
      });
    } else {
      operatorUrls.push(normalized);
    }
  }

  const search = deps.search ?? researchSearchProviderFromEnv();
  // Deterministic queries, derived from the handle — never from page text
  // (D74). `handleSearchQueries` owns the variants and the budget, so the
  // questions a probe asks are one testable value, not inline string building.
  const queries = handleSearchQueries(username);
  // Relevance is decided on one token: the exact handle, case-insensitively.
  // It is used twice — to ORDER candidates (mention-first, so the document
  // budget goes to pages that name the handle) and to GATE claims below (a
  // retrieved page that never names the handle contributes no fact about it).
  const handle = username.toLowerCase();
  // Delimiter-aware (handleMentioned): relevance must be a token match — an
  // inner fragment of a longer word or handle names something else entirely.
  const namesHandle = (haystack: string): boolean => handleMentioned(haystack, handle);

  const candidates = new Map<string, SearchResult>();
  const perQuery: Array<{ query: string; results: number; error: string | null }> = [];
  let searchUnavailableReason: string | null = null;
  let searchNote: string | null = null;
  for (const query of queries) {
    const outcome = await search.search(query, 5);
    perQuery.push({ query, results: outcome.results.length, error: outcome.error });
    if (outcome.unavailableReason !== null && searchUnavailableReason === null) {
      searchUnavailableReason = outcome.unavailableReason;
    }
    if (outcome.error !== null && searchUnavailableReason === null) {
      searchUnavailableReason = `Search failed: ${outcome.error}`;
    }
    if (outcome.note !== undefined && searchNote === null) searchNote = outcome.note;
    for (const result of outcome.results) {
      const normalized = normalizeResearchUrl(result.url);
      if (normalized !== null && !candidates.has(normalized)) candidates.set(normalized, result);
    }
  }
  const searchCandidateUrls = [...candidates.keys()];
  const summaryOf = ([url, result]: [string, SearchResult]): string =>
    `${url} ${result.title ?? ""} ${result.snippet ?? ""}`;
  // A candidate the fetch gate would refuse by policy (an Instagram-family
  // host) can never contribute a fact, so it must not consume the document
  // budget ahead of a page that could actually be read.
  const policyAllows = (url: string): boolean => {
    try {
      return researchHostPolicy(new URL(url).hostname).allowed;
    } catch {
      return false;
    }
  };
  const policyRefusedCandidates = searchCandidateUrls.filter((url) => !policyAllows(url));
  // Explainable relevance signal, strongest first: the exact handle appearing
  // in the result URL, then its title, then its snippet. A snippet can be
  // truncated or stale, so it ranks below title and URL but still above a
  // result that matches nothing — nothing readable is dropped before it is
  // read, while a policy-refused host (rank -1) never wins a slot from any
  // readable page. The sort is stable, so equal signals keep provider order.
  const signalOf = (entry: [string, SearchResult]): number => {
    if (!policyAllows(entry[0])) return -1;
    if (namesHandle(entry[0])) return 3;
    if (entry[1].title !== null && namesHandle(entry[1].title)) return 2;
    if (entry[1].snippet !== null && namesHandle(entry[1].snippet)) return 1;
    return 0;
  };
  const orderedCandidates = [...candidates.entries()].sort((a, b) => signalOf(b) - signalOf(a));
  const relevantCandidates = orderedCandidates.filter((entry) => namesHandle(summaryOf(entry))).length;

  const searchState: AuditSearchState =
    search.name === "none"
      ? "SEARCH_NOT_CONFIGURED"
      : candidates.size > 0
        ? "SEARCH_SUCCEEDED"
        : searchUnavailableReason !== null
          ? "SEARCH_FAILED"
          : "SEARCH_NO_RESULTS";

  const planned: Array<{ url: string; sourceType: ResearchSourceType }> = [];
  const seenUrls = new Set<string>();
  const pushUrl = (url: string, sourceType: ResearchSourceType): void => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    planned.push({ url, sourceType });
  };
  for (const url of operatorUrls) pushUrl(url, "OPERATOR_SUPPLIED_URL");
  for (const [url] of orderedCandidates) pushUrl(url, "SEARCH_RESULT");
  const documentsTruncated = Math.max(planned.length - maxSources, 0);
  const boundedPlan = planned.slice(0, maxSources);
  // One explainable row per search candidate: WHY it ranked where it did and
  // WHAT happened to it. This is the sparse-result report's evidence that
  // candidate selection was deliberate — bounded by the query budget (≤4
  // queries × 5 results), so the list can never grow into an irrelevant-URL
  // dump standing in for intelligence.
  const boundedUrls = new Set(boundedPlan.map((entry) => entry.url));
  const signalWhy = (entry: [string, SearchResult]): string => {
    if (namesHandle(entry[0])) return "its result URL names the exact handle";
    if (entry[1].title !== null && namesHandle(entry[1].title))
      return "its result title names the exact handle";
    if (entry[1].snippet !== null && namesHandle(entry[1].snippet))
      return "its result snippet names the exact handle (a snippet can be stale — the fetched page still has to name it)";
    return "no exact-handle match in its url/title/snippet; kept only because the document budget had room";
  };
  const candidateRows: AuditWebCandidate[] = orderedCandidates.map((entry) => {
    const [url] = entry;
    if (!policyAllows(url)) {
      return {
        url,
        disposition: "SKIPPED_BY_POLICY",
        reason:
          "Instagram-family host — the fetch gate refuses it by policy (FOUNDING §14), so it is recorded as " +
          "skipped, never attempted, and can never take a slot from a readable page.",
      };
    }
    if (boundedUrls.has(url)) {
      return { url, disposition: "PLANNED", reason: signalWhy(entry) };
    }
    return {
      url,
      disposition: "NOT_FETCHED",
      reason: `outside the document budget (cap ${maxSources}); it stays a candidate, not a read page.`,
    };
  });

  const fetcher = deps.fetcher ?? new ResearchFetcher();
  const documents: AuditWebDocument[] = [];
  const facts: AuditWebFact[] = [];
  const notes: string[] = [...rejectedUrls.map((r) => `Not planned: ${r.reason}`)];
  let refusedTotal = 0;
  let unattributedTotal = 0;
  let candidatesTotal = 0;
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  let gatedDocuments = 0;
  let discardedTotal = 0;

  for (const plannedDoc of boundedPlan) {
    const response = await fetcher.fetchPage(plannedDoc.url);
    if (!response.ok) {
      const outcomeKind = RESEARCH_FETCH_OUTCOMES[response.kind] ?? "FAILED";
      // A policy refusal is a STRUCTURAL fact (the host can never be read
      // here), not a failed attempt: it is counted as skipped, so one
      // Instagram URL in the plan can never turn a clean pass into retrieval
      // FAILED. Anything else that did not come back is a real failure.
      if (outcomeKind === "BLOCKED_BY_POLICY") skipped += 1;
      else failed += 1;
      documents.push({
        url: plannedDoc.url,
        outcome: outcomeKind,
        outcomeReason: response.reason,
        httpStatus: response.httpStatus,
        title: null,
        contentType: null,
        byteSize: null,
        contentSha256: null,
        retrievedAt: null,
        sourceType: plannedDoc.sourceType,
        // Never observed — the page was not read, so "does not mention the
        // handle" would be a claim about a document we never saw.
        mentionsHandle: null,
        facts: 0,
        refused: 0,
        discarded: 0,
        unattributed: 0,
        linksNotFollowed: 0,
      });
      continue;
    }

    fetched += 1;
    const extracted = extractCandidates(response.body);
    const linksNotFollowed = (response.body.match(/<a\s[^>]*href/gi) ?? []).length;
    const pageMentionsHandle = namesHandle(
      `${response.finalUrl}\n${extracted.title ?? ""}\n${response.body}`,
    );
    // Relevance gate: a SEARCH candidate becomes a statement about the handle
    // only if the retrieved page itself names the handle. A search hit is a
    // machine suggestion (and its snippet may be truncated or stale), so a page
    // that never names the account cannot have been "found" for it — reporting
    // its fields as third-party statements about @handle is exactly the
    // inference this product refuses. An OPERATOR-NAMED page bypasses the gate:
    // the operator asserted its relevance by naming it.
    const gated = plannedDoc.sourceType === "SEARCH_RESULT" && !pageMentionsHandle;
    if (gated) {
      gatedDocuments += 1;
      discardedTotal += extracted.candidates.length;
      documents.push({
        url: response.finalUrl,
        outcome: "FETCHED",
        outcomeReason: [
          `Relevance gate: this page does not name @${username} in its URL, title or body, so its ${
            extracted.candidates.length
          } structured value(s) were discarded — a search hit is a candidate, never a statement about the handle.`,
          linksNotFollowed > 0
            ? `${linksNotFollowed} link(s) on this page were NOT followed (depth-1 bound).`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" "),
        httpStatus: response.httpStatus,
        title: extracted.title,
        contentType: response.contentType,
        byteSize: response.byteSize,
        contentSha256: createHash("sha256").update(response.body, "utf8").digest("hex"),
        retrievedAt: response.fetchedAt.toISOString(),
        sourceType: plannedDoc.sourceType,
        mentionsHandle: false,
        facts: 0,
        refused: 0,
        discarded: extracted.candidates.length,
        unattributed: 0,
        linksNotFollowed,
      });
      continue;
    }

    let refused = 0;
    let unattributed = 0;
    // Self-identification: on a MACHINE-FOUND page, a stored statement must
    // literally involve the handle — its value names the handle as a token,
    // or the page's own host does. A third-party article ABOUT the account
    // also describes its SOURCE (og:site_name "WeRSM", the publisher's own
    // social links, the publisher's contact address): those are facts about
    // the source, and attributing them to @handle is the identity inference
    // this product refuses — measured on the natgeo case (SOURCE-AUDIT §11),
    // where 6 of 24 stored facts named the wrong entity. The asymmetry with
    // the mention gate above is deliberate: operator-named pages bypass BOTH
    // checks, because the operator asserted relevance by naming the page.
    let pageHost = "";
    try {
      pageHost = new URL(response.finalUrl).hostname;
    } catch {
      pageHost = response.finalUrl;
    }
    for (const candidate of extracted.candidates as ResearchCandidate[]) {
      // The SAME gate an acquisition run and `claims add` use: the extractor
      // proposes, the closed predicate registry disposes.
      const classified = classifyClaimPredicate(candidate.predicate);
      if (classified.kind !== "ALLOWED") {
        refused += 1;
        continue;
      }
      const value = validateClaimValue(candidate.value);
      if (!value.ok) {
        refused += 1;
        continue;
      }
      const excerpt = validateClaimExcerpt(candidate.excerpt);
      if (!excerpt.ok) {
        refused += 1;
        continue;
      }
      if (
        plannedDoc.sourceType === "SEARCH_RESULT" &&
        !namesHandle(value.value) &&
        !namesHandle(pageHost)
      ) {
        unattributed += 1;
        continue;
      }
      facts.push({
        predicate: classified.predicate,
        value: value.value,
        excerpt: excerpt.excerpt,
        field: candidate.field,
        method: candidate.method,
        provenance: "PUBLIC_WEB_DOCUMENTED",
        sourceUrl: response.finalUrl,
        sourceTitle: extracted.title,
        sourceDomain: claimSourceDomain(response.finalUrl),
        retrievedAt: response.fetchedAt.toISOString(),
        uncertainty: candidate.uncertainty ?? null,
      });
    }
    refusedTotal += refused;
    unattributedTotal += unattributed;
    candidatesTotal += extracted.candidates.length;
    documents.push({
      url: response.finalUrl,
      outcome: "FETCHED",
      outcomeReason:
        [
          linksNotFollowed > 0
            ? `${linksNotFollowed} link(s) on this page were NOT followed (depth-1 bound).`
            : null,
          unattributed > 0
            ? `${unattributed} structured value(s) on this page do NOT involve @${username} ` +
              "(they name the source page, not the account) and were not attributed."
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" ") || null,
      httpStatus: response.httpStatus,
      title: extracted.title,
      contentType: response.contentType,
      byteSize: response.byteSize,
      contentSha256: createHash("sha256").update(response.body, "utf8").digest("hex"),
      retrievedAt: response.fetchedAt.toISOString(),
      sourceType: plannedDoc.sourceType,
      mentionsHandle: pageMentionsHandle,
      facts: extracted.candidates.length - refused - unattributed,
      refused,
      discarded: 0,
      unattributed,
      linksNotFollowed,
    });
  }

  // --- Corroboration and contradiction, derived from the facts themselves.
  // Same derivation as the claims ledger: one value from ≥2 distinct domains
  // is CORROBORATED; differing normalized values are CONFLICTED and show BOTH
  // sides — no winner is chosen and no numeric confidence is invented.
  const byPredicate = new Map<string, AuditWebFact[]>();
  for (const fact of facts) {
    const bucket = byPredicate.get(fact.predicate);
    if (bucket === undefined) byPredicate.set(fact.predicate, [fact]);
    else bucket.push(fact);
  }
  const relations: AuditWebRelation[] = [...byPredicate.entries()]
    .map(([predicate, group]) => {
      const relation: ClaimRelation = deriveClaimRelation(
        group.map((fact) => ({
          value: fact.value,
          sourceKind: "WEB" as const,
          sourceUrl: fact.sourceUrl,
        })),
      );
      const domains = new Set(
        group.map((fact) => fact.sourceDomain ?? fact.sourceUrl).filter(Boolean),
      );
      // A CONFLICT means INDEPENDENT SOURCES disagree. One page asserting three
      // different social URLs is three separate statements from one source, not
      // a contradiction — a live probe of a real site labelled its own LinkedIn,
      // X and YouTube links "CONFLICTED" before this correction, which would
      // have told an operator that sources contradict each other when none do.
      // The differing values still show below; the label just stops lying.
      const label =
        relation.label === "CONFLICTED" && domains.size < 2 ? "SINGLE_SOURCE" : relation.label;
      return {
        predicate,
        label: label as string,
        values: [...new Set(group.map((fact) => normalizeClaimValue(fact.value)))].sort(),
        sourceDomains: relation.sourceDomains,
        facts: group.length,
      };
    })
    .sort((a, b) => a.predicate.localeCompare(b.predicate));

  const sourcesAvailable = boundedPlan.length > 0;
  const attempted = sourcesAvailable;
  if (documentsTruncated > 0) {
    notes.push(
      `${documentsTruncated} candidate URL(s) were NOT fetched: this probe is capped at ${maxSources} document(s) ` +
        "(FOUNDING §19 bounds). A wider pass is `igtrack research --run`, which stores what it reads.",
    );
  }
  if (gatedDocuments > 0) {
    notes.push(
      `${gatedDocuments} retrieved page(s) never named @${username} in their URL, title or body, so their ` +
        `${discardedTotal} structured value(s) were discarded: a search hit is a candidate, never a statement ` +
        "about the handle.",
    );
  }
  if (unattributedTotal > 0) {
    notes.push(
      `${unattributedTotal} structured value(s) from machine-found pages were NOT attributed: the page named ` +
        `@${username}, but the value itself and the page's own host both describe the SOURCE page, not the ` +
        "account. Operator-named pages (--url) bypass this check, because the operator asserted their relevance.",
    );
  }
  if (searchCandidateUrls.length > 0 && relevantCandidates === 0) {
    notes.push(
      `0 of ${searchCandidateUrls.length} search candidate(s) named ${username} in its result summary ` +
        "(url/title/snippet), so mention-first ordering had nothing to prioritize; any page that is fetched " +
        "still has to name the handle itself to contribute a fact.",
    );
  }
  if (policyRefusedCandidates.length > 0) {
    notes.push(
      `${policyRefusedCandidates.length} of ${searchCandidateUrls.length} search candidate(s) point at ` +
        "Instagram-family hosts the fetch gate refuses by policy, so they were ordered last, recorded SKIPPED and " +
        "never requested: platform data has one lawful route (FOUNDING §14).",
    );
  }
  if (skipped > 0) {
    notes.push(
      `${skipped} planned document(s) were refused by policy before any request was made (BLOCKED_BY_POLICY): a ` +
        "structural limitation of this route, not a network failure — it is counted as skipped, never as a failed fetch.",
    );
  }
  if (searchNote !== null) notes.push(`Search provider note: ${searchNote}`);
  if (searchUnavailableReason !== null && searchState === "SEARCH_SUCCEEDED") {
    // Partial search: some queries answered, another did not.
    notes.push(`Search was only partly usable: ${searchUnavailableReason}`);
  }
  if (search.name !== "none") {
    // Sparse results must say WHICH classes of source were never consulted, so
    // an operator can tell "poor coverage of one index" apart from "no public
    // evidence exists" — without this, a zero reads like a verdict.
    notes.push(
      `Source classes not searched here: platform-private data (likers, other accounts' rosters, highlights, ` +
        `stories) is refused by decision (FOUNDING §14); Instagram-hosted pages cannot be fetched by policy; and ` +
        `exactly ONE web index was queried (${search.name}) — a different index may hold pages this one does not.`,
    );
  }

  const retrievalState: AuditRetrievalState =
    boundedPlan.length === 0
      ? "NOT_ATTEMPTED"
      : failed > 0 && fetched === 0
        ? "FAILED"
        : failed > 0 || skipped > 0 || documentsTruncated > 0
          ? "COMPLETED_PARTIAL"
          : "COMPLETED";

  // One label for WHERE the run stopped, so a sparse report answers "did we
  // even ask, did pages come back, were they about this handle, or did the
  // extractor simply find nothing allowed?" without the operator counting
  // fields. Deterministic from the counts above — never from interpretation.
  const pagesNamingHandle = documents.filter((doc) => doc.mentionsHandle === true).length;
  const outcomeClass: AuditWebOutcomeClass = !attempted
    ? searchState === "SEARCH_NOT_CONFIGURED"
      ? "SEARCH_UNAVAILABLE"
      : searchState === "SEARCH_FAILED"
        ? "SEARCH_FAILED"
        : "SEARCH_NO_CANDIDATES"
    : facts.length > 0
      ? "EVIDENCE_EXTRACTED"
      : fetched === 0
        ? "CANDIDATES_INACCESSIBLE"
        : gatedDocuments > 0 && gatedDocuments >= fetched
          ? "PAGES_IRRELEVANT"
          : "RELEVANT_NO_FACTS";

  const searchWhy =
    searchState === "SEARCH_NOT_CONFIGURED"
      ? (searchUnavailableReason ?? "no search provider is configured")
      : searchState === "SEARCH_NO_RESULTS"
        ? `the configured search provider (${search.name}) answered all ${queries.length} query(ies) with zero results`
        : searchState === "SEARCH_FAILED"
          ? (searchUnavailableReason ?? `the configured search provider (${search.name}) could not answer`)
          : `${searchCandidateUrls.length} candidate URL(s) came back from ${search.name}`;

  const why = attempted
    ? `Planned ${boundedPlan.length} public document(s) from ${
        operatorUrls.length
      } operator-named URL(s) and ${searchCandidateUrls.length} search candidate(s) (search: ${searchState}, ` +
      `retrieval: ${retrievalState}), depth 1, capped at ${maxSources}. Nothing was stored: every fact below is a ` +
      "third-party statement retrieved at the time shown, not a platform observation about the account."
    : `No public-web source was available to plan: ${
        (input.urls ?? []).length === 0
          ? "no --url was given"
          : "no --url survived normalization"
      }, and ${searchWhy}. The probe fetches pages a source named; it never invents candidate sources.`;

  return {
    attempted,
    sourcesAvailable,
    search: {
      provider: search.name === "none" ? null : search.name,
      state: searchState,
      queries,
      perQuery,
      candidateUrls: searchCandidateUrls.length,
      relevantCandidates,
      unavailableReason: searchUnavailableReason,
      note: searchNote,
    },
    retrievalState,
    outcomeClass,
    bounds: {
      maxSources,
      maxDepth: 1,
      enforced: `${boundedPlan.length} document(s) planned of ${planned.length} candidate(s); depth 1 — links on fetched pages are counted, never followed; Instagram-family hosts are refused by policy.`,
      documentsTruncated,
    },
    candidates: candidateRows,
    documents,
    facts,
    relations,
    rejectedUrls,
    totals: {
      planned: boundedPlan.length,
      fetched,
      failed,
      skipped,
      pagesNamingHandle,
      facts: facts.length,
      refused: refusedTotal,
      unattributed: unattributedTotal,
    },
    inferences:
      "None. This product derives no inference from public-web text and stores no model output as evidence: what a source states is recorded with its citation, and what it does not state stays unknown. A handle appearing on a page is that page's statement, never proof that a particular person or organization operates the account.",
    why,
    notes,
  };
}

// ---------------------------------------------------------------------------
// audit — one read-only command that unifies the observation workflow.
//
// `igtrack audit <username>` answers, in one report and in this order:
//   1. can this deployment observe the account at all? (local configuration,
//      decided without spending a request);
//   2. what does the source say right now? (ONE lookup probe — the same
//      stateless probe `igtrack lookup` runs);
//   3. what has already been recorded about it? (the stored read-back behind
//      `dossier`/`research`, plus the scan/job state behind `plan`);
//   4. what can never be observed, and why (the capability registry's
//      refusals — platform-absent, not unimplemented);
//   5. what to do next.
//
// It is read-only by construction and the workflow it unifies is REUSED, not
// re-implemented: `opLookup`, `opResearch`, `opPlan`. It queues no scan, writes
// no row, and never registers a target — so a failed or inconclusive probe
// cannot leave this deployment claiming to observe something it never saw.
//
// Two rules the report exists to protect:
//   * a probe that answers ACCOUNT_NOT_FOUND (or fails) is NOT evidence that
//     the account does not exist — it is a statement about one source, and the
//     sentence that says so travels in the payload;
//   * configuration is checked before anything is observed, and a blocked
//     configuration is reported as CONFIGURATION_ERROR (exit 3), never as an
//     empty result.
// ---------------------------------------------------------------------------

export type AuditConfigState =
  /** The selected provider cannot run: unknown name, missing or placeholder credentials. */
  | "CONFIGURATION_ERROR"
  /** Credentials pass every local check; only an accepted API call can prove more. */
  | "NOT_VERIFIED"
  /** No credential this deployment consumes (fixture default, or the import export path). */
  | "NOT_APPLICABLE";

export type AuditProbeState =
  /** The source returned data for this account (a probe, not a stored claim). */
  | "OBSERVED"
  | "PARTIAL"
  /** The source holds nothing for the account. Local sources: a data-set gap, not a platform verdict. */
  | "NOT_OBSERVED"
  /** No route exposes it to this deployment (private, consumer account, capability absent). */
  | "UNSUPPORTED"
  /** The route refused it: missing permission, or an account we are not authorized to read. */
  | "NOT_AUTHORIZED"
  /** Transport/provider failure before any data was read. Retryable unless stated otherwise. */
  | "PROVIDER_ERROR"
  /** Not attempted: the configuration blocked the probe before any request could be built. */
  | "NOT_ATTEMPTED";

export type AuditRecordState =
  /** The account is tracked AND stored rows exist for it. */
  | "OBSERVED"
  /**
   * Stored rows exist, but every one of them is synthetic: the record is a
   * data set's footprint, not a reading of the account. Distinct from
   * OBSERVED on purpose — "there are rows" and "the account was observed"
   * are different facts.
   */
  | "SYNTHETIC"
  /** Nothing is stored: either untracked, or tracked with no scan rows yet. */
  | "NOT_OBSERVED";

export interface AuditReport {
  generatedAt: string;
  /** Exactly what was passed in, before normalization. */
  requested: string;
  /** The normalized username every section below is about. */
  username: string;
  /** Which accepted form the reference took: USERNAME, HANDLE or PROFILE_URL. */
  referenceForm: string;
  config: {
    state: AuditConfigState;
    provider: string;
    sourceId: string | null;
    /** "local" = a file on disk (synthetic or imported); "remote-api" = the Graph API path. */
    sourceKind: "local" | "remote-api" | null;
    usable: boolean;
    error: string | null;
    synthetic: boolean;
    /** One sentence naming what kind of evidence this source produces. */
    evidence: string;
    /**
     * The local configuration assessment this decision was made from: variable
     * NAMES, states and corrective actions — never a value. `networkCallMade`
     * is always false, and a clean assessment reads NOT_VERIFIED.
     */
    readiness: Readiness;
  };
  probe: {
    attempted: boolean;
    state: AuditProbeState;
    /** Which route answered: the observed account, or the discovery probe of another. */
    via: "resolve" | "discovery" | null;
    /** The provider's own capability status, verbatim (null when nothing was attempted). */
    status: string | null;
    sourceKind: "local" | "remote-api" | null;
    /** Whether the Business Discovery opt-in is on (graph only; null elsewhere). */
    businessDiscovery: "on" | "off" | null;
    observedAt: string | null;
    /** The probe payload when the source answered (for discovery: a bounded preview). */
    account: unknown;
    error: { kind: string; message: string; retryable: boolean } | null;
    /** One value-free sentence: what this answer means and what was not attempted. */
    why: string;
  };
  record: {
    tracked: boolean;
    state: AuditRecordState;
    /** Why nothing / something is stored. Never "the account does not exist". */
    reason: string | null;
    target: { id: string; observationMode: "OWNED" | "DISCOVERY"; status: string } | null;
    identity: DossierResult["account"] | null;
    route: DossierResult["route"] | null;
    /** When this deployment first / last recorded anything about the account. */
    firstRecordedAt: string | null;
    lastRecordedAt: string | null;
    profile: DossierResult["profile"] | null;
    /** Row counts and the bounded-preview ceiling, never the media rows themselves. */
    media: {
      storedCount: number;
      bounded: boolean | null;
      previewLimit: number | null;
      oldestPublishedAt: string | null;
      newestPublishedAt: string | null;
      firstObservedAt: string | null;
      lastObservedAt: string | null;
    } | null;
    counts: Record<string, { count: number; latestAt: string | null }>;
    claims: {
      active: number;
      retracted: number;
      predicates: number;
      /**
       * Active claims past the 180-day review horizon (`DUE_FOR_REVIEW`):
       * stale citations the report names instead of letting them read as
       * current. Staleness is reported, never auto-retracted or downgraded.
       */
      dueForReview: number;
      statement: string;
    } | null;
    /** Per-capability coverage computed from stored rows, with a reason for every gap. */
    coverage: DossierCoverageRow[] | null;
    notes: string[];
  };
  /**
   * The public-web phase (D70): third-party statements about the handle from
   * pages a source named — never platform observations, never stored, never
   * an inference. Always present; `attempted: false` carries the reason.
   */
  web: AuditWebReport;
  /**
   * The distinction the whole report exists to make, in one machine-readable
   * block: a report was GENERATED, and an account was (or was not) OBSERVED.
   * Those are different facts, and a caller that only sees an exit code or a
   * headline must not confuse them.
   */
  observation: {
    /** Did a real request reach Instagram? False for fixture and import sources. */
    realPlatformRequest: boolean;
    /** Did the configured source return an observation of THIS account? */
    observed: boolean;
    /** The class of the evidence the probe produced, if any. */
    evidenceClass: "LIVE" | "IMPORTED" | "SYNTHETIC" | "NONE";
    /** One sentence a caller can print verbatim. */
    statement: string;
  };
  /**
   * The concise summary: one headline and one row per evidence class, each
   * derived from the section that holds it. Platform observation, stored
   * record, public-web statement, stored third-party claim, operator evidence
   * and inference are kept apart here so no reading can blend them.
   */
  summary: {
    headline: string;
    classes: Array<{ evidence: string; state: string; detail: string }>;
  };
  /** Capabilities this product refuses by decision, with the reason. Independent of the provider. */
  unsupported: Array<{ id: string; label: string; why: string | null; liveState: string }>;
  errors: Array<{ step: string; code: string; message: string; retryable: boolean }>;
  limitations: string[];
  nextSteps: Array<{ action: string; because: string }>;
}

/**
 * Translate one lookup answer into the audit's probe state.
 *
 * Reuses the existing status/error-kind conventions rather than inventing a
 * second taxonomy. ACCOUNT_PRIVATE maps to NOT_AUTHORIZED: the documented
 * route refuses to expose a private account to this credential, which is an
 * authorization fact — the platform's own reason travels verbatim in
 * `probe.error.kind` and `probe.why`, so no information is collapsed away.
 */
function auditProbeState(lookup: LookupResult): AuditProbeState {
  if (lookup.status === CapabilityStatus.AVAILABLE) return "OBSERVED";
  if (lookup.status === CapabilityStatus.PARTIAL) return "PARTIAL";
  if (lookup.status === CapabilityStatus.UNAVAILABLE) return "UNSUPPORTED";
  switch (lookup.error?.kind) {
    case CapabilityErrorKind.ACCOUNT_NOT_FOUND:
      return "NOT_OBSERVED";
    case CapabilityErrorKind.AUTH_REQUIRED:
    case CapabilityErrorKind.FORBIDDEN:
    case CapabilityErrorKind.ACCOUNT_PRIVATE:
      return "NOT_AUTHORIZED";
    case CapabilityErrorKind.NETWORK:
    case CapabilityErrorKind.TIMEOUT:
    case CapabilityErrorKind.RATE_LIMITED:
    case CapabilityErrorKind.PROVIDER_ERROR:
      return "PROVIDER_ERROR";
    default:
      return "PROVIDER_ERROR";
  }
}

/** What kind of evidence the active source produces, in one sentence. */
function auditEvidenceLabel(ctx: CliContext): string {
  if (ctx.provider.error !== null) {
    return "UNAVAILABLE — the selected provider could not be constructed, so no evidence is being described here.";
  }
  if (ctx.provider.synthetic) {
    return "SYNTHETIC — generated fixture data. Not a live account observation: no real account was contacted, and no figure here describes a real account.";
  }
  if (ctx.provider.name === "import") {
    return "IMPORTED — the operator's own Instagram data export. Real data, but a record of an export, never a live observation.";
  }
  return "LIVE — the official Instagram Graph API, scoped to the authorized account.";
}

export async function opAudit(
  ctx: CliContext,
  input: { username: string; urls?: readonly string[]; maxSources?: number },
  // Structural subsets, exactly as `research --run` takes them: the audit's
  // web phase is exercised against a scripted transport in tests, and never
  // opens a socket the operator did not ask for.
  deps: {
    fetcher?: Pick<ResearchFetcher, "fetchPage">;
    search?: ResearchSearchProvider;
  } = {},
): Promise<AuditReport> {
  const requested = input.username;
  const parsed = parseAccountReference(requested);
  if (!parsed.ok) {
    // A reference that names no account is a usage error, before any phase
    // runs: "invalid reference" and "valid but unobservable" must stay
    // different answers.
    throw new UsageError(
      `${parsed.message} \`igtrack audit\` accepts a username, an @handle, or an instagram.com profile URL.`,
    );
  }
  const username = parsed.reference.username;
  const errors: AuditReport["errors"] = [];

  // --- Phase 1: configuration, decided locally, before anything is observed.
  const readiness = assessReadiness(process.env);
  const usable = ctx.provider.error === null;
  const blocking = !usable || isBlocking(readiness.status);
  const configState: AuditConfigState = blocking
    ? "CONFIGURATION_ERROR"
    : readiness.graphCredentialsRequired && readiness.status === ConfigState.NOT_VERIFIED
      ? "NOT_VERIFIED"
      : "NOT_APPLICABLE";
  if (blocking) {
    errors.push({
      step: "configuration",
      code: "CONFIGURATION_ERROR",
      message:
        ctx.provider.error ??
        (readiness.problems.length > 0
          ? readiness.problems.join("; ")
          : "the selected provider's configuration is blocked (see config.readiness)"),
      retryable: false,
    });
  }

  // --- Phase 2: ONE stateless probe through the configured source.
  // `blocking` gates it, not just `usable`: a graph provider can construct
  // fine while readiness is INVALID_CONFIGURATION (a token with whitespace,
  // say — graphConfigBlocker only refuses MISSING/PLACEHOLDER). Probing then
  // would send a request the local check already ruled out, so the probe waits
  // for a configuration that deserves to be observed.
  let probe: AuditReport["probe"];
  if (!usable || blocking) {
    const reason = !usable
      ? `No request was made: provider "${ctx.provider.name}" is not usable. ${ctx.provider.error ?? "unknown reason"}`
      : `No request was made: the local configuration check failed (${readiness.status}) before anything was observed${
          readiness.problems.length > 0 ? ` — ${readiness.problems.join("; ")}` : ""
        }.`;
    probe = {
      attempted: false,
      state: "NOT_ATTEMPTED",
      via: null,
      status: null,
      sourceKind: null,
      businessDiscovery: null,
      observedAt: null,
      account: null,
      error: null,
      why: `${reason} Configuration is checked before anything is observed, so a configuration failure can never be reported as an absence of data.`,
    };
  } else {
    const lookup = await opLookup(ctx, { username });
    const state = auditProbeState(lookup);
    if (lookup.error !== null) {
      errors.push({
        step: "probe",
        code: lookup.error.kind,
        message: lookup.error.message,
        retryable: lookup.error.retryable,
      });
    }
    probe = {
      attempted: true,
      state,
      via: lookup.via,
      status: lookup.status,
      sourceKind: lookup.sourceKind,
      businessDiscovery: lookup.businessDiscovery,
      observedAt: lookup.observedAt,
      account: lookup.account,
      error: lookup.error,
      why:
        state === "NOT_ATTEMPTED"
          ? lookup.why
          : `${lookup.why} The probe persists nothing: it is a statement about one source at one moment, never a stored claim.`,
    };
  }

  // --- Phase 3: what this deployment has already recorded.
  // A tracked target reads back through the same research report `igtrack
  // research` prints, and the same stateless planner `igtrack plan` derives.
  let record: AuditReport["record"];
  let nextSteps: AuditReport["nextSteps"] = [];
  const emptyCounts: Record<string, { count: number; latestAt: string | null }> = {};
  let trackedTarget: { id: string; observationMode: "OWNED" | "DISCOVERY"; status: string } | null =
    null;
  try {
    const resolved = await resolveTarget(ctx.db, ctx.userId, username);
    trackedTarget = {
      id: resolved.id,
      observationMode: "OWNED",
      status: resolved.status,
    };
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== "TARGET_NOT_FOUND") throw err;
  }

  if (trackedTarget === null) {
    record = {
      tracked: false,
      state: "NOT_OBSERVED",
      reason: `This deployment has no target and no stored observations for @${username}. Nothing was recorded, so there is no dossier, coverage or history to read back — and the probe above is not evidence that the account does not exist.`,
      target: null,
      identity: null,
      route: null,
      firstRecordedAt: null,
      lastRecordedAt: null,
      profile: null,
      media: null,
      counts: emptyCounts,
      claims: null,
      coverage: null,
      notes: [],
    };
  } else {
    const research = await opResearch(ctx, { target: trackedTarget.id, connectionLimit: 5 });
    const plan = await opPlan(ctx, { target: trackedTarget.id });
    trackedTarget = {
      id: research.target.id,
      observationMode: research.target.observationMode,
      status: research.target.status,
    };
    const storedRows = Object.values(research.platform.counts).reduce(
      (total, entry) => total + entry.count,
      0,
    );
    // "Rows exist" and "the account was observed" are different facts. When
    // every stored row is synthetic, the record is a data set's footprint and
    // says so — a reader must never take 68 generated insight points for a
    // reading of the account.
    const recordClass = research.identity.route.evidenceClass;
    const recordState: AuditRecordState =
      storedRows === 0
        ? "NOT_OBSERVED"
        : recordClass === "SYNTHETIC"
          ? "SYNTHETIC"
          : "OBSERVED";
    record = {
      tracked: true,
      state: recordState,
      reason:
        storedRows > 0
          ? recordState === "SYNTHETIC"
            ? "Every stored row for this account is SYNTHETIC (generated data). The row counts below are real rows, but they are not a reading of this account, and no figure in them describes it."
            : null
          : "This account is tracked, but no scan has stored rows for it yet: a tracked account is not an observed one.",
      target: trackedTarget,
      identity: research.identity.account,
      route: research.identity.route,
      firstRecordedAt: research.identity.account.firstSeenAt,
      lastRecordedAt: research.identity.account.lastSeenAt,
      profile: research.platform.profile,
      media:
        research.platform.media === null
          ? null
          : {
              storedCount: research.platform.media.storedCount,
              bounded: research.platform.media.bounded,
              previewLimit: research.platform.media.previewLimit,
              oldestPublishedAt: research.platform.media.oldestPublishedAt,
              newestPublishedAt: research.platform.media.newestPublishedAt,
              firstObservedAt: research.platform.media.firstObservedAt,
              lastObservedAt: research.platform.media.lastObservedAt,
            },
      counts: research.platform.counts,
      claims: {
        active: research.claims.totals.active,
        retracted: research.claims.totals.retracted,
        predicates: research.claims.totals.predicates,
        dueForReview: research.claims.groups.flatMap((group) => group.claims).filter(
          (claim) => claim.dueForReview,
        ).length,
        statement: research.claims.statement,
      },
      coverage: research.coverage,
      notes: [...research.notes],
    };
    // Next steps for a tracked account come from the planner, so this report
    // can never recommend something the plan would refuse.
    const seen = new Set<string>();
    const push = (action: string, because: string): void => {
      if (seen.has(action)) return;
      seen.add(action);
      nextSteps.push({ action, because });
    };
    if (plan.nextAction !== null) {
      push(
        `${plan.nextAction.tool} ${JSON.stringify(plan.nextAction.params)}`,
        plan.nextAction.because,
      );
    }
    for (const step of plan.steps) {
      if (step.status !== "READY" && step.status !== "PENDING" && step.status !== "STALE") continue;
      push(
        `${step.tool} ${JSON.stringify(step.params)}`,
        // STALE is stale EVIDENCE — the stored observation behind this step is
        // older than its cadence — so the word travels with the recommendation
        // instead of the step reading as an ordinary, current suggestion.
        step.status === "STALE"
          ? `STALE — ${
              step.reason ?? `step "${step.id}" has not completed within its cadence`
            }`
          : (step.reason ?? `step "${step.id}" is ${step.status}`),
      );
    }
    for (const step of plan.steps.filter((s) => s.status === "BLOCKED")) {
      push(`${step.tool} ${JSON.stringify(step.params)}`, step.reason ?? "blocked");
    }
    push(
      `igtrack research ${username}`,
      "the full read-back this audit summarizes: identity, observations, claims and coverage in separate sections",
    );
  }

  // --- Phase 4: the public-web probe (D70). Read-only, bounded, and it takes
  // no database handle, so "this audit wrote nothing" stays structurally true.
  // A broken search-provider configuration is reported as a CONFIGURATION
  // error — never as "no web sources exist" (invariant 7).
  let web: AuditWebReport;
  try {
    web = await opAuditWebProbe(
      {
        username,
        ...(input.urls !== undefined ? { urls: input.urls } : {}),
        ...(input.maxSources !== undefined ? { maxSources: input.maxSources } : {}),
      },
      deps,
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    errors.push({
      step: "web",
      code: "CONFIGURATION_ERROR",
      message: err.message,
      retryable: false,
    });
    web = {
      attempted: false,
      sourcesAvailable: false,
      search: {
        provider: null,
        state: "SEARCH_NOT_CONFIGURED",
        queries: [],
        perQuery: [],
        candidateUrls: 0,
        relevantCandidates: 0,
        unavailableReason: err.message,
        note: null,
      },
      retrievalState: "NOT_ATTEMPTED",
      outcomeClass: "SEARCH_UNAVAILABLE",
      bounds: {
        maxSources: input.maxSources ?? AUDIT_WEB_MAX_SOURCES,
        maxDepth: 1,
        enforced: "no document was planned: the web phase could not start",
        documentsTruncated: 0,
      },
      candidates: [],
      documents: [],
      facts: [],
      relations: [],
      rejectedUrls: [],
      totals: { planned: 0, fetched: 0, failed: 0, skipped: 0, pagesNamingHandle: 0, facts: 0, refused: 0, unattributed: 0 },
      inferences: "None. No page was read, so nothing is asserted and nothing is inferred.",
      why: `No request was made: ${err.message}`,
      notes: [],
    };
  }

  // --- Phase 5: what can never be observed, what to do, and what this is not.
  const unsupported = capabilityLines()
    .filter((line) => !line.available)
    .map((line) => ({
      id: line.id,
      label: line.label,
      why: line.why,
      liveState: line.liveState as string,
    }));

  const limitations: string[] = [
    `This audit is read-only: it queued no scan, wrote no row and registered no target. It asked one stateless probe of the configured source (${ctx.provider.sourceId ?? "no source"}).`,
  ];
  if (configState === "NOT_APPLICABLE") {
    limitations.push(
      "Configuration was checked locally against the environment (variable names, states and fixes only — never a value). No API request was made by that check.",
    );
  }
  if (configState === "NOT_VERIFIED") {
    limitations.push(
      "The credentials this deployment consumes pass every LOCAL check. That is NOT_VERIFIED, not \"valid\": only an accepted API call can prove a credential works.",
    );
  }
  if (probe.via === "discovery") {
    limitations.push(
      "The probe answered through the documented Business Discovery route: public profile fields plus a BOUNDED, non-pageable media preview — never the account's posts, rosters, likers or highlights.",
    );
  }
  if (record.tracked && record.media?.bounded === true) {
    limitations.push(
      `The stored media rows are a bounded preview (ceiling ${record.media.previewLimit ?? "unrecorded"} rows): "newly discovered" is not "newly created", and publishedAt (the platform's time) is a different fact from firstObservedAt (ours).`,
    );
  }
  if (record.state === "NOT_OBSERVED") {
    limitations.push(
      "Nothing is stored for this account here. Absence of a record is not evidence about the account itself — it says what this deployment has and has not observed.",
    );
  }
  if (record.claims !== null && record.claims.dueForReview > 0) {
    // Stale evidence is named, not expired: a citation older than the review
    // horizon still says what it said when it was retrieved, and silently
    // dropping or downgrading it would rewrite the record (invariant 5).
    limitations.push(
      `Stale evidence: ${record.claims.dueForReview} of ${record.claims.active} active claim(s) were retrieved more than ${CLAIM_REVIEW_HORIZON_DAYS} days ago and are flagged DUE_FOR_REVIEW. They are kept exactly as recorded — never expired, never downgraded — but they describe an earlier moment and should be re-checked before they are relied on.`,
    );
  }
  if (configState === "NOT_APPLICABLE" && ctx.provider.synthetic && probe.state === "NOT_OBSERVED") {
    limitations.push(
      "The configured source is SYNTHETIC fixture data, so an ACCOUNT_NOT_FOUND answer here is a property of that data set — it says nothing about Instagram or about this account.",
    );
  }
  if (web.attempted) {
    limitations.push(
      "The public-web facts above are THIRD-PARTY STATEMENTS retrieved from pages a source named, at the times shown. They are not platform observations, they are not stored by this read-only command, and a handle appearing on a page is that page's claim — never proof of who operates the account.",
    );
    if (web.relations.some((relation) => relation.label === "CONFLICTED")) {
      limitations.push(
        "Where two public sources disagree, both values are shown and no winner is chosen: this product does not rank sources against each other or invent a confidence score.",
      );
    }
    if (web.totals.failed > 0 || web.totals.skipped > 0 || web.bounds.documentsTruncated > 0) {
      limitations.push(
        `The public-web phase is PARTIAL by construction: ${web.totals.failed} document(s) failed, ${web.totals.skipped} refused by policy without a request, and ${web.bounds.documentsTruncated} candidate(s) were not fetched. Incomplete coverage is reported as incomplete, never as "nothing found".`,
      );
    }
  } else if (configState !== "CONFIGURATION_ERROR") {
    limitations.push(
      web.search.state === "SEARCH_NOT_CONFIGURED"
        ? "The public-web phase did not run, so nothing here reflects the open web: see web.why for the exact reason. No public page was read, invented or assumed."
        : `A search step RAN (${web.search.state}${web.search.provider === null ? "" : ` via ${web.search.provider}`}, ` +
          `${web.search.queries.length} query(ies)) and retrieval ended ${web.retrievalState}: ${web.why} ` +
          "A search that returned nothing is reported as what the source answered, never as proof that nothing exists.",
    );
  }
  if (unsupported.length > 0) {
    limitations.push(
      `${unsupported.length} capability(ies) are refused by decision (likers, other accounts' rosters, highlights, private data): they are platform-absent, not unimplemented. FOUNDING §14.`,
    );
  }

  if (configState === "CONFIGURATION_ERROR") {
    nextSteps = [
      {
        action: "igtrack doctor",
        because: `the selected provider cannot run: ${
          ctx.provider.error ?? readiness.problems.join("; ")
        }`,
      },
      ...nextSteps,
    ];
  } else {
    if (
      (probe.state === "OBSERVED" || probe.state === "PARTIAL") &&
      record.tracked === false
    ) {
      nextSteps = [
        {
          action: `igtrack targets add ${username}${probe.via === "discovery" ? " --observed" : ""}`,
          because:
            "the source can observe this account but nothing is recorded yet; --observed tracks another public account through the documented Business Discovery route, and the route is probed before the target is created",
        },
        ...nextSteps,
      ];
    }
    if (probe.state === "NOT_OBSERVED" && record.tracked === false) {
      nextSteps = [
        {
          action: "igtrack capabilities",
          because:
            "this source holds no rows for the account, which is a data-set gap and not a statement about the account; the registry names what could be observed and from which lawful source",
        },
        ...nextSteps,
      ];
    }
    if (probe.state === "NOT_AUTHORIZED" || probe.state === "UNSUPPORTED") {
      nextSteps = [
        {
          action: "igtrack capabilities",
          because: `the configured route does not expose this account (${probe.error?.kind ?? probe.status ?? "no route"}); the registry and the probe's reason state exactly what is obtainable from this source`,
        },
        ...nextSteps,
      ];
    }
    if (probe.state === "PROVIDER_ERROR") {
      // A retryable failure is its own remedy; a source that could not be read
      // at all (missing fixture set, unreadable export) sends the operator to
      // doctor, which names provider usability without making an API request.
      // Either way this report never ends in "no next step".
      if (probe.error?.retryable === true) {
        nextSteps = [
          {
            action: `igtrack audit ${username}`,
            because: `the probe failed with a retryable ${probe.error.kind} before any data was read; nothing was recorded, so a plain retry is the whole remedy`,
          },
          ...nextSteps,
        ];
      } else {
        nextSteps = [
          {
            action: "igtrack doctor",
            because: `the configured source could not be read at all (${probe.error?.kind ?? probe.status ?? "unknown failure"}): ${probe.error?.message ?? "the provider returned an error instead of data"}`,
          },
          ...nextSteps,
        ];
      }
    }
  }

  // Web-phase next steps come last and never contradict the phases above:
  // they only ever point at the two lawful ways to go further — a wider
  // stored acquisition, or filing the citations in the ledger.
  if (web.attempted && web.totals.facts > 0 && record.tracked === false) {
    nextSteps.push({
      action: `igtrack targets add ${username} --observed`,
      because:
        "the web facts above are cited third-party statements about this handle; an observed target records what the platform's Business Discovery route returns so web statements and platform observations can finally be read side by side",
    });
    nextSteps.push({
      action: `igtrack claims add --target ${username} --predicate ORGANIZATION_NAME --value "…" --source-url "…" --excerpt "…"`,
      because:
        "a fact you judge worth keeping is filed by you, with its citation — this audit stores nothing, and the ledger refuses any predicate the registry does not allow",
    });
  }
  if (!web.attempted && configState !== "CONFIGURATION_ERROR") {
    nextSteps.push({
      action: `igtrack audit ${username} --url "https://example.org/about"`,
      because:
        web.search.state === "SEARCH_NO_RESULTS"
          ? `a genuine zero, not a missing source: the configured search provider (${web.search.provider ?? "none"}) ` +
            `ran ${web.search.queries.length} query(ies) and returned no results, so no candidate existed to plan. ` +
            "Name a public page with --url to widen the pass — the engine will not invent sources."
          : "no public-web source was available to plan: --url names a public page directly, and a search provider " +
            "supplies candidates (IGTRACK_RESEARCH_SEARCH_PROVIDER=auto uses IGTRACK_RESEARCH_SEARCH_API_KEY with " +
            "Brave when a key is present, otherwise the keyless FreeSerp index; =brave plus " +
            "IGTRACK_RESEARCH_SEARCH_API_KEY is the official API). The engine will not invent sources.",
    });
  }
  if (web.attempted && web.totals.facts === 0 && configState !== "CONFIGURATION_ERROR") {
    // Zero facts after a run that DID search and read pages: the report must
    // say which of the two worlds this is — thin coverage of one index (fix:
    // widen the sources), pages read with nothing extractable (fix: name a
    // better page), or candidates that could not be read at all (fix: retry /
    // widen) — and never imply that no public evidence exists anywhere.
    nextSteps.push({
      action: `igtrack audit ${username} --url "https://example.org/page-that-names-${username}"`,
      because:
        web.outcomeClass === "PAGES_IRRELEVANT"
          ? `every retrieved page failed the exact-handle gate (${web.totals.pagesNamingHandle} of ${web.totals.fetched} ` +
            "fetched page(s) named the handle): this is WEAK COVERAGE from one index, not proof that no public " +
            "evidence exists. --url names a page you know discusses the handle, or set " +
            "IGTRACK_RESEARCH_SEARCH_API_KEY with IGTRACK_RESEARCH_SEARCH_PROVIDER=auto to search Brave's index too."
          : web.outcomeClass === "CANDIDATES_INACCESSIBLE"
            ? `no candidate page could be read at all (${web.totals.skipped} policy-skipped, ${web.totals.failed} ` +
              `failed, ${web.bounds.documentsTruncated} outside the budget), so nothing here describes the handle: ` +
              "retry the failures later, or name a readable page with --url."
            : `the pages were readable but nothing extractable about ${username} survived the predicate registry ` +
              `(${web.outcomeClass}): --url names a page you know states facts about this handle, which the extractor ` +
              "can then quote with its citation.",
    });
  }

  // The concise summary: one headline plus one row per evidence class, each
  // derived from the section that holds it. This is what makes "observed",
  // "stated by a source" and "inferred" separable at a glance — the classes
  // are never blended, and the inference row is an absence by design.
  const summary = {
    headline:
      `@${username}: ${
        probe.state === "OBSERVED"
          ? "the configured source answered for this account"
          : `the configured source returned ${probe.state}`
      }; ${
        record.tracked
          ? `this deployment holds ${record.state === "OBSERVED" ? "stored observations" : "a target with no observations"}`
          : "this deployment holds nothing"
      }; ${
        web.attempted
          ? `${web.totals.facts} public-web statement(s) across ${web.totals.fetched} page(s)`
          : "no public-web source was read"
      }.`,
    classes: [
      {
        evidence: "Platform observation",
        state: probe.state,
        detail: `${
          ctx.provider.synthetic
            ? "SYNTHETIC (fixture)"
            : ctx.provider.name === "import"
              ? "IMPORTED (operator export)"
              : "live"
        } via ${probe.via ?? "no route"} — ${probe.why}`,
      },
      {
        evidence: "Stored record",
        state: record.state,
        detail: record.tracked
          ? `${record.target?.observationMode ?? "?"} target; ${Object.values(record.counts).reduce(
              (t, c) => t + c.count,
              0,
            )} stored row(s); ${
              record.claims === null ? "no claims" : `${record.claims.active} active claim(s)`
            }`
          : "nothing recorded for this account here",
      },
      {
        evidence: "Public-web statement",
        state: web.attempted ? (web.totals.facts > 0 ? "OBSERVED" : "NOT_OBSERVED") : "NOT_ATTEMPTED",
        // The two steps are reported apart so "the search never ran" and "the
        // search ran and found nothing" can never read as the same finding.
        detail: `search ${web.search.state} · retrieval ${web.retrievalState} · outcome ${web.outcomeClass} · ${
          web.attempted
            ? `${web.totals.facts} fact(s) from ${web.totals.fetched} page(s), ${web.totals.pagesNamingHandle} page(s) naming the handle, each fact with its source URL, field and retrieval time; ${
                web.relations.filter((r) => r.label === "CORROBORATED").length
              } corroborated, ${web.relations.filter((r) => r.label === "CONFLICTED").length} contradicted`
            : web.why
        }`,
      },
      {
        evidence: "Third-party claim (stored)",
        state: record.claims === null || record.claims.active === 0 ? "NONE" : "OBSERVED",
        detail:
          record.claims === null
            ? "no ledger for this account"
            : `${
                record.claims.dueForReview > 0
                  ? `${record.claims.dueForReview} of ${record.claims.active} claim(s) flagged DUE_FOR_REVIEW (stale, past the ${CLAIM_REVIEW_HORIZON_DAYS}-day horizon) — `
                  : ""
              }${record.claims.statement}`,
      },
      {
        evidence: "Operator evidence",
        state: ctx.provider.name === "import" ? "SUPPLIED" : "NONE",
        detail:
          ctx.provider.name === "import"
            ? "the operator's own Instagram export is the configured source"
            : "no operator-supplied evidence was read by this audit (igtrack import and igtrack claims add are the two ways to add some)",
      },
      {
        evidence: "Inference",
        state: "NONE",
        detail: web.inferences,
      },
    ],
  };

  // The one block that separates "a report was produced" from "the account
  // was observed". Generated from the probe's own answer, never from the
  // report's existence: a caller must be able to read this without parsing
  // prose.
  const observed = probe.state === "OBSERVED" || probe.state === "PARTIAL";
  const realPlatformRequest =
    probe.attempted && probe.sourceKind === "remote-api" && observed;
  const evidenceClass: AuditReport["observation"]["evidenceClass"] = !observed
    ? "NONE"
    : ctx.provider.synthetic
      ? "SYNTHETIC"
      : ctx.provider.name === "import"
        ? "IMPORTED"
        : "LIVE";
  const observation: AuditReport["observation"] = {
    realPlatformRequest,
    observed,
    evidenceClass,
    statement: !probe.attempted
      ? "NO OBSERVATION: no request was made. The configuration is blocked — see the Configuration section."
      : !observed
        ? `NO OBSERVATION: the configured source (${ctx.provider.sourceId ?? "none"}) returned ${probe.state}. ` +
          "That is a fact about this source, not about the account's existence."
        : realPlatformRequest
          ? "OBSERVED (LIVE): an authorized request to the official Instagram Graph API returned this account's data."
          : evidenceClass === "SYNTHETIC"
            ? "OBSERVED (SYNTHETIC): the configured source is a fixture set. No real account was contacted and no figure here describes a real account."
            : evidenceClass === "IMPORTED"
              ? "OBSERVED (IMPORTED): the operator's own Instagram data export answered. Real data, but a record of an export — never a live observation."
              : "OBSERVED.",
  };

  return {
    generatedAt: new Date().toISOString(),
    requested,
    username,
    referenceForm: parsed.reference.form,
    observation,
    config: {
      state: configState,
      provider: ctx.provider.name,
      sourceId: ctx.provider.sourceId,
      sourceKind: ctx.provider.sourceId === null ? null : sourceKindOf(ctx.provider.sourceId),
      usable,
      error: ctx.provider.error,
      synthetic: ctx.provider.synthetic,
      evidence: auditEvidenceLabel(ctx),
      readiness,
    },
    probe,
    record,
    web,
    summary,
    unsupported,
    errors,
    limitations,
    nextSteps,
  };
}

// ---------------------------------------------------------------------------
// investigate — ONE username in, one provenance-backed dossier out.
//
// The product decision this implements: the user supplies a handle and
// IGTrack does the rest. They should not have to add a target, queue scans,
// run the worker, run a research query and then read three different
// reports to find out what is known. Every stage that a configured source
// can answer runs here, automatically, and every stage that cannot says so
// with the reason and the configuration that would change it.
//
// The rules the pipeline never bends:
//
//   * A stage is reported separately from the next one, with what it
//     retrieved and what it could not.
//   * The evidence classes are never blended: a platform observation, a
//     public-web statement, the operator's export, an operator's finding, a
//     derivation and a fixture are six different things.
//   * A source that was not consulted is reported as not consulted. A source
//     that was consulted and returned nothing is reported as returning
//     nothing. These are not the same answer.
//   * Nothing is inferred about a person that the evidence does not support.
//   * Re-running is incremental: observations dedupe by identity, so a second
//     investigation adds what changed and re-reports what did not.
// ---------------------------------------------------------------------------

export interface InvestigateInput {
  /** A username, an @handle, or an instagram.com profile URL. */
  username: string;
  /** What the operator is trying to find out. Derived from the handle when omitted. */
  question?: string | undefined;
  /** Public pages the operator names explicitly (highest trust tier). */
  urls?: readonly string[] | undefined;
  /** Cap on documents fetched by the public-web stage (1..RESEARCH_MAX_SOURCES). */
  maxSources?: number | undefined;
  /** Skip the public-web stage entirely. */
  web?: boolean | undefined;
  /** Ignore the document freshness window and refetch. */
  refresh?: boolean | undefined;
  /** Cap on jobs the platform stage may execute. */
  maxJobs?: number | undefined;
  /** Re-read now, ignoring the per-target scan cadence. Off by default. */
  force?: boolean | undefined;
}

export interface InvestigateContent {
  /** Media rows stored for the account, newest published first, bounded. */
  media: Array<{
    postId: string;
    caption: string | null;
    publishedAt: string | null;
    firstObservedAt: string | null;
    likeCount: number | null;
    commentCount: number | null;
    repostsCount: number | null;
    mediaType: string | null;
    commentsState: string | null;
    sourceId: string;
    evidenceId: string | null;
  }>;
  /** Hashtags and terms derived from the stored captions. */
  hashtags: SynthesisTerm[];
  terms: SynthesisTerm[];
  /** Comments authored on the account's own media, with their authors. */
  comments: Array<{
    postId: string;
    commentId: string;
    author: string;
    text: string;
    createdAt: string;
    evidenceId: string | null;
  }>;
  /** Story mentions — the accounts named in the account's own stories. */
  storyMentions: Array<{ storyId: string; username: string; visibilityClass: string }>;
  /** Media by other accounts in which this account is tagged. */
  taggedMedia: Array<{ mediaId: string; ownerUsername: string | null; takenAt: string | null }>;
  /** The corpus size behind the derived terms — never a term without its source. */
  captionRows: number;
}

export interface InvestigateWeb {
  /** Whether the public-web stage ran at all. */
  attempted: boolean;
  /** What the stage did, in its own vocabulary. */
  outcome: string;
  /** The queries actually issued. */
  queries: string[];
  /** The search provider that answered, or null when none was configured. */
  searchProvider: string | null;
  /** Why no search provider was usable, when that is the case. */
  searchUnavailableReason: string | null;
  /** Documents read, with their per-document outcome. */
  documents: Array<{ url: string; outcome: string; reason: string | null; facts: number }>;
  /** Facts extracted, with their citation. */
  facts: Array<{
    predicate: string;
    value: string;
    sourceUrl: string;
    sourceTitle: string | null;
    excerpt: string;
    retrievedAt: string;
    /** Whether the finding is filed in the claims ledger or only reported here. */
    stored: boolean;
  }>;
  totals: { planned: number; fetched: number; failed: number; facts: number; stored: number };
}

export interface InvestigateResult {
  investigation: {
    startedAt: string;
    completedAt: string;
    /** Exactly what the operator typed. */
    requested: string;
    /** The normalized handle every section is about. */
    username: string;
    referenceForm: string;
    /** The target this investigation recorded into, when one exists. */
    targetId: string | null;
    observationMode: "OWNED" | "DISCOVERY" | null;
    /** One row per stage: what it did, what it retrieved, why it stopped. */
    stages: InvestigationStage[];
    /** Every source consulted, and every source not consulted. */
    sources: InvestigationSource[];
    /** One row per evidence class: what it means and how much of it there is. */
    evidenceClasses: Array<{ class: EvidenceClass; label: string; items: number }>;
    /**
     * How many items the investigation actually RETRIEVED — rows read, facts
     * extracted, ranks computed. Attempts are not retrieval: a scan that was
     * queued and refused retrieved nothing.
     */
    retrievedItems: number;
  };
  /** Account identity and profile metadata. */
  identity: ResearchResult["identity"];
  /** The stored observation record. */
  platform: ResearchResult["platform"];
  /** Accessible content: posts, captions, comments, mentions, tags. */
  content: InvestigateContent;
  /** Relationship evidence — live and synthetic, never blended. */
  relationships: {
    live: RelationshipRank[];
    synthetic: RelationshipRank[];
    method: RelationshipsResult["method"] | null;
  };
  /** The public-web stage's result. */
  web: InvestigateWeb;
  /** Operator/agent findings, with their citations. */
  claims: ResearchResult["claims"];
  /** Where two sources disagree. Both sides, no winner. */
  contradictions: ResearchResult["contradictions"];
  /** Changes between comparable observations. */
  changes: ResearchResult["changes"];
  /** Uncertain leads, kept apart from the confirmed findings. */
  leads: ResearchResult["leads"];
  /** Themes derived from the stored captions. */
  themes: ResearchResult["themes"];
  /** Publishing cadence derived from the stored timestamps. */
  cadence: ResearchResult["cadence"];
  /** Per-capability coverage: what was observed, and why each gap is a gap. */
  coverage: DossierCoverageRow[];
  /** Everything the investigation could not get, and what would change that. */
  gaps: InvestigationGap[];
  /** The exact next commands, with the reason for each. */
  nextSteps: Array<{ action: string; because: string }>;
  /** The full research report this dossier is built from — the same object
   * `igtrack research` prints, so the two can never disagree. */
  report: ResearchResult;
  notes: string[];
}

/**
 * The evidence class a stored source id belongs to.
 *
 * The class follows the SOURCE, never the fact that a source happened to
 * answer: a fixture set that observes an account produces SYNTHETIC evidence,
 * not a platform observation. Getting this wrong is how generated data ends
 * up described as a live reading.
 */
function evidenceClassForSource(sourceId: string): EvidenceClass {
  const kind = sourceId.split(":")[0] ?? "";
  if (kind === "fixture") return EVIDENCE_CLASS.SYNTHETIC;
  if (kind === "import") return EVIDENCE_CLASS.EXPORT;
  if (kind === "graph") return EVIDENCE_CLASS.PLATFORM;
  return EVIDENCE_CLASS.OPERATOR;
}

/** The question an investigation asks when the operator did not supply one. */
function defaultQuestion(handle: string): string {
  return `What is publicly documented about @${handle}?`;
}

function stage(
  id: InvestigationStage["id"],
  objective: string,
  status: InvestigationStage["status"],
  options: {
    source?: string | null;
    reason?: string | null;
    retrieved?: Record<string, number>;
    classes?: EvidenceClass[];
  } = {},
): InvestigationStage {
  return {
    id,
    objective,
    status,
    source: options.source ?? null,
    reason: options.reason ?? null,
    retrieved: options.retrieved ?? {},
    evidenceClasses: options.classes ?? [],
  };
}

export async function opInvestigate(
  ctx: CliContext,
  input: InvestigateInput,
  deps: {
    /** Injected web transport, so a test can exercise the pipeline without sockets. */
    fetcher?: Pick<ResearchFetcher, "fetchPage">;
    search?: ResearchSearchProvider;
  } = {},
): Promise<InvestigateResult> {
  const startedAt = new Date();
  const notes: string[] = [];
  const stages: InvestigationStage[] = [];
  const gaps: InvestigationGap[] = [];
  const sources: InvestigationSource[] = [];

  // --- A. Normalize and validate the reference.
  const requested = input.username;
  const parsed = parseAccountReference(requested);
  if (!parsed.ok) {
    throw new UsageError(
      `${parsed.message} \`igtrack investigate\` accepts a username, an @handle, or an instagram.com profile URL.`,
    );
  }
  const handle = parsed.reference.username;

  const provider = ctx.provider.provider;
  if (provider === null) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `Investigation made no request: provider "${ctx.provider.name}" is not usable. ${ctx.provider.error ?? "unknown reason"}`,
      3,
    );
  }
  // The class of everything this source produces. A fixture set that observes
  // an account produces SYNTHETIC evidence — the class follows the source.
  const sourceClass = evidenceClassForSource(ctx.provider.sourceId ?? "none");

  // --- B. Resolve the account through the permitted sources.
  const resolved = await provider.resolveAccount(handle);
  const sourceObserves = resolved.status === CapabilityStatus.AVAILABLE;
  let discovered = false;
  let discoveryNote: string | null = null;
  if (!sourceObserves && provider.capabilities()[CapabilityName.DISCOVER_ACCOUNT] === true) {
    const probe = await provider.discoverAccount(handle);
    if (probe.status === CapabilityStatus.AVAILABLE) {
      discovered = true;
    } else {
      discoveryNote =
        probe.error?.message ??
        probe.note ??
        "the documented discovery route returned no public data for this account";
    }
  }
  const resolveNote =
    resolved.status === CapabilityStatus.AVAILABLE
      ? `the configured source observes @${handle}`
      : resolved.error?.message ??
        resolved.note ??
        `the configured source returned ${resolved.status} for @${handle}`;

  // Identity: a platform id already bound to a DIFFERENT username is a
  // different account. Similar names are not the same person, and the platform
  // id — not the spelling — is the identity.
  const observedIgId =
    sourceObserves && resolved.data !== undefined
      ? resolved.data.igId
      : undefined;
  if (observedIgId !== undefined) {
    const bound = await getAccountByIgId(ctx.db, observedIgId);
    if (bound !== null && bound.usernameLower !== handle.toLowerCase()) {
      throw new CliError(
        "IDENTITY_CONFLICT",
        `The platform id for @${handle} is already bound to @${bound.username}. Two accounts cannot share one platform id, ` +
          "so nothing was recorded: this is a different account that happens to have a similar name.",
        2,
      );
    }
  }

  stages.push(
    stage(
      INVESTIGATION_STAGE.IDENTITY,
      "Normalize the reference and resolve the account through the permitted sources",
      sourceObserves
        ? INVESTIGATION_STAGE_STATUS.COMPLETED
        : discovered
          ? INVESTIGATION_STAGE_STATUS.COMPLETED
          : INVESTIGATION_STAGE_STATUS.BLOCKED,
      {
        source: ctx.provider.sourceId,
        reason: sourceObserves
          ? resolveNote
          : discovered
            ? `the documented discovery route answered for @${handle}`
            : `${resolveNote}${discoveryNote === null ? "" : `; discovery: ${discoveryNote}`}`,
        retrieved: sourceObserves
          ? { accounts: 1 }
          : discovered
            ? { accounts: 1 }
            : {},
        classes: sourceObserves ? [sourceClass] : [],
      },
    ),
  );
  if (!sourceObserves && !discovered) {
    gaps.push({
      subject: `platform account data for @${handle}`,
      kind: "investigation",
      reason: `${resolveNote}. The configured source does not observe this account, so no platform field was read.`,
      howToImprove:
        "Point IGTRACK_GRAPH_USERNAME at an account you own (IGTRACK_PROVIDER=graph), or set IGTRACK_PROVIDER=import with an export of this account. " +
        "For another public professional account, enable the documented discovery route (IGTRACK_GRAPH_BUSINESS_DISCOVERY=1).",
    });
  }
  sources.push({
    id: ctx.provider.sourceId ?? "no source",
    evidenceClass: evidenceClassForSource(ctx.provider.sourceId ?? "none"),
    queried: true,
    reason: sourceObserves
      ? "the account is observable through this source"
      : discovered
        ? "the documented discovery route answered"
        : resolveNote,
    items: sourceObserves || discovered ? 1 : 0,
  });

  // --- The target. A DISCOVERY target is for an account the platform reached
  // through the documented cross-account route; anything else is the account
  // this deployment was asked to observe.
  //
  // The route was already probed above, so the target is created directly
  // rather than through a second probe: probing twice would let a transient
  // failure abort an investigation that has already been answered.
  const mode: "OWNED" | "DISCOVERY" = discovered ? "DISCOVERY" : "OWNED";
  const { target } = await createTarget(ctx.db, {
    userId: ctx.userId,
    username: handle,
    ...(discovered ? { observationMode: "DISCOVERY" as const } : {}),
  });
  const targetId = target.id;

  // --- C/E. The platform stage: queue what the source can answer, then
  // execute it. The queue is shared, so other targets' jobs can be drained
  // too — the report states what THIS investigation did, read back from this
  // target's own job rows.
  //
  // The cadence is respected by default: a scan that was already done inside
  // this target's scheduling window is NOT re-read, so repeating an
  // investigation is cheap and does not hammer the platform. `force` asks for
  // a fresh look.
  const queued = await opScanRun(ctx, {
    target: targetId,
    ...(input.force === true ? { force: true } : {}),
  });
  const platformStage = stage(
    INVESTIGATION_STAGE.PLATFORM,
    "Observe every field the selected source exposes for the account",
    INVESTIGATION_STAGE_STATUS.COMPLETED,
    {
      source: ctx.provider.sourceId,
      reason: `${queued.enqueued.length} scan(s) queued; ${queued.skipped.length} refused or skipped`,
      retrieved: { queued: queued.enqueued.length, skipped: queued.skipped.length },
      classes: sourceObserves ? [sourceClass] : [],
    },
  );
  if (queued.enqueued.length === 0) {
    platformStage.status = INVESTIGATION_STAGE_STATUS.BLOCKED;
    platformStage.reason =
      queued.skipped[0]?.reason ??
      "the configured source exposes no scan kind for this account";
    gaps.push({
      subject: "platform observations for this account",
      kind: "investigation",
      reason: platformStage.reason,
      howToImprove:
        "Configure a source that observes this account (IGTRACK_PROVIDER=graph with the owned account, or IGTRACK_PROVIDER=import with its export).",
    });
  }

  const maxJobs = Math.max(input.maxJobs ?? 25, 1);
  if (queued.enqueued.length > 0) {
    // The CONTEXT's provider, not a freshly built one: the investigation must
    // observe through the source the caller configured, and the evidence class
    // it reports must match the rows it writes.
    const src: ExecutionSource = {
      provider,
      source: {
        id: provider.sourceId,
        kind: sourceKindFor(provider.sourceId),
        name: `${provider.sourceId} provider`,
        providerVersion: provider.sourceId.split(":").pop() ?? "unknown",
      },
    };
    const workerId = makeWorkerId();
    for (let i = 0; i < maxJobs; i += 1) {
      const outcome = await pollOnce(ctx.db, workerId, src);
      if (outcome.state === "none") break;
    }
  }
  // What this target's own jobs recorded — not the whole shared queue.
  const targetJobs = await listJobsForTarget(ctx.db, targetId, 50);
  const completed = targetJobs.filter((j) => j.outcome === "COMPLETED").length;
  const partial = targetJobs.filter((j) => j.outcome === "COMPLETED_PARTIAL").length;
  const failed = targetJobs.filter((j) => j.status === "failed").length;
  platformStage.retrieved = {
    ...platformStage.retrieved,
    jobs: targetJobs.length,
    completed,
    partial,
    failed,
  };
  if (targetJobs.length > 0) {
    platformStage.reason =
      `${targetJobs.length} scan job(s) on record: ${completed} completed, ${partial} partial, ${failed} failed`;
    if (failed > 0) {
      platformStage.status = INVESTIGATION_STAGE_STATUS.PARTIAL;
      const firstError = targetJobs.find(
        (j): j is (typeof targetJobs)[number] & { errorMessage: string } =>
          j.errorMessage !== null,
      )?.errorMessage;
      if (firstError !== undefined) {
        gaps.push({
          subject: "one or more platform scans",
          kind: "investigation",
          reason: firstError,
          howToImprove: "igtrack scans list --target " + handle + " shows every job and its recorded failure.",
        });
      }
    }
  }
  stages.push(platformStage);

  // --- D. The content stage: what the observation actually recorded.
  const detail = await getOwnedTargetDetail(ctx.db, ctx.userId, targetId);
  const content = buildInvestigateContent(detail);
  const contentStage = stage(
    INVESTIGATION_STAGE.CONTENT,
    "Read back the accessible content: posts, captions, comments, mentions, tags",
    content.media.length + content.comments.length + content.storyMentions.length + content.taggedMedia.length >
      0
      ? INVESTIGATION_STAGE_STATUS.COMPLETED
      : INVESTIGATION_STAGE_STATUS.BLOCKED,
    {
      source: ctx.provider.sourceId,
      reason:
        content.media.length + content.comments.length + content.storyMentions.length + content.taggedMedia.length >
        0
          ? `${content.media.length} media row(s), ${content.comments.length} comment(s), ${content.storyMentions.length} mention(s), ${content.taggedMedia.length} tagged-media row(s)`
          : "no content rows were recorded for this account",
      retrieved: {
        media: content.media.length,
        comments: content.comments.length,
        storyMentions: content.storyMentions.length,
        taggedMedia: content.taggedMedia.length,
        captionRows: content.captionRows,
      },
      classes: sourceObserves ? [sourceClass] : [],
    },
  );
  stages.push(contentStage);

  // --- The relationships stage.
  const relationships = await opRelationships(ctx, { target: targetId });
  const relationshipStage = stage(
    INVESTIGATION_STAGE.RELATIONSHIPS,
    "Rank the accounts this one is observed to interact with, by evidence class",
    relationships.ranks.length + relationships.syntheticRanks.length > 0
      ? INVESTIGATION_STAGE_STATUS.COMPLETED
      : INVESTIGATION_STAGE_STATUS.BLOCKED,
    {
      source: ctx.provider.sourceId,
      reason:
        relationships.ranks.length + relationships.syntheticRanks.length > 0
          ? `${relationships.ranks.length} live rank(s), ${relationships.syntheticRanks.length} synthetic rank(s)`
          : "no interaction was observed for this account",
      retrieved: {
        live: relationships.ranks.length,
        synthetic: relationships.syntheticRanks.length,
      },
      classes: [
        ...(relationships.ranks.length > 0 && sourceClass !== EVIDENCE_CLASS.SYNTHETIC
          ? [sourceClass]
          : []),
        ...(relationships.syntheticRanks.length > 0 ? [EVIDENCE_CLASS.SYNTHETIC] : []),
      ],
    },
  );
  stages.push(relationshipStage);

  // --- F/G. The public-web stage. A DISCOVERY target is another account
  // observed through the documented route: a research RUN is an owned-account
  // operation (D47), so its findings are reported here and not filed.
  const web: InvestigateWeb = {
    attempted: false,
    outcome: "NOT_ATTEMPTED",
    queries: [],
    searchProvider: null,
    searchUnavailableReason: null,
    documents: [],
    facts: [],
    totals: { planned: 0, fetched: 0, failed: 0, facts: 0, stored: 0 },
  };
  if (input.web === false) {
    stages.push(
      stage(INVESTIGATION_STAGE.WEB, "Discover and retrieve public references", INVESTIGATION_STAGE_STATUS.SKIPPED, {
        source: null,
        reason: "the operator skipped the public-web stage (--no-web)",
      }),
    );
  } else {
    const question = input.question?.trim() || defaultQuestion(handle);
    if (mode === "OWNED") {
      const run = await opResearchRun(
        ctx,
        {
          target: targetId,
          question,
          ...(input.urls !== undefined ? { urls: input.urls } : {}),
          ...(input.maxSources !== undefined ? { maxSources: input.maxSources } : {}),
          ...(input.refresh === true ? { refresh: true } : {}),
        },
        { ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}) },
      );
      web.attempted = true;
      web.outcome = run.status;
      web.queries = run.search.queries;
      web.searchProvider = run.search.provider;
      web.searchUnavailableReason = run.search.unavailableReason;
      web.documents = run.documents.map((doc) => ({
        url: doc.url,
        outcome: doc.outcome,
        reason: doc.outcomeReason,
        facts: 0,
      }));
      web.facts = run.claims.map((claim) => ({
        predicate: claim.predicate,
        value: claim.value,
        sourceUrl: claim.sourceUrl ?? "",
        sourceTitle: claim.sourceTitle,
        excerpt: claim.excerpt ?? "",
        retrievedAt: claim.retrievedAt ?? claim.recordedAt,
        stored: true,
      }));
      web.totals = {
        planned: run.totals.planned,
        fetched: run.totals.fetched,
        failed: run.totals.failed,
        // STATEMENTS, not extracted candidates: a candidate that the
        // attribution gate refused is not a fact about the account.
        facts: run.claims.length,
        stored: run.totals.claimsStored,
      };
      stages.push(
        stage(
          INVESTIGATION_STAGE.WEB,
          "Discover and retrieve public references",
          run.status === "FAILED"
            ? INVESTIGATION_STAGE_STATUS.FAILED
            : run.status === "COMPLETED_PARTIAL"
              ? INVESTIGATION_STAGE_STATUS.PARTIAL
              : INVESTIGATION_STAGE_STATUS.COMPLETED,
          {
            source: run.search.provider ?? "public web",
            reason: `${run.totals.claimsStored} claim(s) filed, ${run.totals.claimsRefused} refused by the registry, ${run.totals.pagesDiscarded} page(s) discarded for not naming the handle`,
            retrieved: {
              queries: run.search.queries.length,
              candidates: run.search.candidateUrls,
              documents: run.totals.fetched + run.totals.failed,
              claims: run.totals.claimsStored,
            },
            classes: [EVIDENCE_CLASS.WEB],
          },
        ),
      );
    } else {
      // Read-only: the documented route observed another account, and an
      // autonomous run against a name the operator has not owned is not
      // permitted (D47). The findings are reported; they are not filed.
      const probe = await opAuditWebProbe(
        { username: handle, ...(input.urls !== undefined ? { urls: input.urls } : {}) },
        {
          ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
          ...(deps.search !== undefined ? { search: deps.search } : {}),
        },
      );
      web.attempted = probe.attempted;
      web.outcome = probe.outcomeClass;
      web.queries = probe.search.queries;
      web.searchProvider = probe.search.provider;
      web.searchUnavailableReason = probe.search.unavailableReason;
      web.documents = probe.documents.map((doc) => ({
        url: doc.url,
        outcome: doc.outcome,
        reason: doc.outcomeReason,
        facts: doc.facts,
      }));
      web.facts = probe.facts.map((fact) => ({
        predicate: fact.predicate,
        value: fact.value,
        sourceUrl: fact.sourceUrl,
        sourceTitle: fact.sourceTitle,
        excerpt: fact.excerpt,
        // A fact without a retrieval time has no provenance; say so rather
        // than inventing a timestamp.
        retrievedAt: fact.retrievedAt ?? "unavailable",
        stored: false,
      }));
      web.totals = {
        planned: probe.totals.planned,
        fetched: probe.totals.fetched,
        failed: probe.totals.failed,
        facts: probe.totals.facts,
        stored: 0,
      };
      stages.push(
        stage(
          INVESTIGATION_STAGE.WEB,
          "Discover and retrieve public references",
          probe.totals.facts > 0
            ? INVESTIGATION_STAGE_STATUS.COMPLETED
            : probe.attempted
              ? INVESTIGATION_STAGE_STATUS.PARTIAL
              : INVESTIGATION_STAGE_STATUS.BLOCKED,
          {
            source: probe.search.provider ?? "public web",
            reason:
              `${probe.totals.facts} statement(s) extracted; reported only — a research run is an owned-account operation, ` +
              "so a DISCOVERY target's findings are not filed. Use `igtrack claims add` to keep one.",
            retrieved: {
              queries: probe.search.queries.length,
              documents: probe.totals.fetched + probe.totals.failed,
              facts: probe.totals.facts,
            },
            classes: [EVIDENCE_CLASS.WEB],
          },
        ),
      );
    }
    if (web.searchProvider !== null) {
      sources.push({
        id: web.searchProvider,
        evidenceClass: EVIDENCE_CLASS.WEB,
        queried: true,
        reason: `${web.totals.fetched} document(s) read, ${web.totals.facts} statement(s) extracted`,
        items: web.totals.facts,
      });
      // A search that RAN and found nothing is a finding, not a silence: the
      // gap has to say that the index was asked and did not hold anything
      // about this handle. "No public evidence exists" is a different claim,
      // and this report must never make it.
      if (web.totals.facts === 0) {
        gaps.push({
          subject: "public-web references",
          kind: "investigation",
          reason:
            `the search (${web.searchProvider}) ran ${web.queries.length} quer(y/ies) and produced ` +
            `${web.totals.fetched} readable document(s) and no statement about this handle. ` +
            "That is the index's coverage, not evidence that nothing exists — one index was asked, and a different one may hold pages it does not.",
          howToImprove:
            "Set IGTRACK_RESEARCH_SEARCH_API_KEY with IGTRACK_RESEARCH_SEARCH_PROVIDER=auto (adds the Brave index), or name pages directly with --url.",
        });
      }
    } else {
      sources.push({
        id: "public-web",
        evidenceClass: EVIDENCE_CLASS.WEB,
        queried: false,
        reason:
          web.searchUnavailableReason ??
          "no search provider was configured, so no public page was found",
        items: 0,
      });
      gaps.push({
        subject: "public-web references",
        kind: "investigation",
        reason:
          web.searchUnavailableReason ??
          "no search provider is configured, so the public-web stage found no candidate pages",
        howToImprove:
          "Set IGTRACK_RESEARCH_SEARCH_PROVIDER=auto (uses IGTRACK_RESEARCH_SEARCH_API_KEY with Brave when a key is present, otherwise the keyless FreeSerp index), or name pages with --url.",
      });
    }
  }

  // --- I/J. The dossier: one report over the stored record.
  const report = await opResearch(ctx, { target: targetId });
  // The derived topics belong with the content they came from, and the corpus
  // size travels with them: a term without its corpus is not a finding.
  content.hashtags = report.themes.hashtags;
  content.terms = report.themes.terms;
  const correlateStage = stage(
    INVESTIGATION_STAGE.CORRELATE,
    "Correlate the evidence across classes: themes, cadence, contradictions",
    report.themes.state === "DERIVED" || report.contradictions.length > 0
      ? INVESTIGATION_STAGE_STATUS.COMPLETED
      : INVESTIGATION_STAGE_STATUS.PARTIAL,
    {
      source: "stored observations",
      reason:
        report.contradictions.length > 0
          ? `${report.contradictions.length} contradiction(s) found — both sides shown, no winner chosen`
          : `${report.themes.captionRows} caption(s) read for themes; no contradiction between the sources on record`,
      retrieved: {
        captionRows: report.themes.captionRows,
        contradictions: report.contradictions.length,
        timestampRows: report.cadence.timestampRows,
      },
      classes: [EVIDENCE_CLASS.DERIVED],
    },
  );
  stages.push(correlateStage);

  // Every capability the registry lists, with its reason — the coverage table
  // is the "what remains unknown" answer, per capability.
  //
  // When the platform stage is blocked, "not observed" must NOT be explained
  // as "a scan can still run": the source refuses to observe this account, so
  // a scan could never have run. The real reason replaces the generic one.
  for (const row of report.coverage) {
    if (row.state === "OBSERVED") continue;
    const blockedPlatform =
      platformStage.status === INVESTIGATION_STAGE_STATUS.BLOCKED &&
      row.state === "NOT_OBSERVED";
    gaps.push({
      subject: row.label,
      kind: "capability",
      reason: blockedPlatform
        ? `${platformStage.reason ?? "the configured source does not observe this account"} (so a scan of it could not run)`
        : row.reason ?? "not observed",
      howToImprove: row.unlock ?? null,
    });
  }
  if (relationships.ranks.length === 0 && relationships.syntheticRanks.length === 0) {
    gaps.push({
      subject: "follower, following and interaction records",
      kind: "investigation",
      reason:
        "no interaction was observed for this account. The platform exposes follower and following LISTS only for the account the deployment owns; for any other account they are platform-absent, not unimplemented.",
      howToImprove:
        "IGTRACK_PROVIDER=import with the operator's own export is the only lawful route to a real roster, mutual-follow and follow-change evidence.",
    });
  }

  // The evidence-class summary: how much of each class this investigation
  // actually produced. The classes are never merged, and the counts are
  // ITEMS — a class is not credited because a stage merely ran.
  const classCounts = new Map<EvidenceClass, number>();
  const add = (cls: EvidenceClass, n: number): void => {
    if (n <= 0) return;
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + n);
  };
  add(
    sourceClass,
    content.media.length +
      content.comments.length +
      content.storyMentions.length +
      content.taggedMedia.length +
      relationships.ranks.length +
      (report.platform.profile.latest === null ? 0 : 1),
  );
  add(EVIDENCE_CLASS.SYNTHETIC, relationships.syntheticRanks.length);
  add(EVIDENCE_CLASS.WEB, web.totals.facts);
  add(EVIDENCE_CLASS.OPERATOR, report.claims.totals.active);
  add(
    EVIDENCE_CLASS.DERIVED,
    report.themes.terms.length + report.contradictions.length,
  );
  // The VALUES are the class names (the keys are the short aliases), so the
  // summary iterates the values.
  const evidenceClasses = (Object.values(EVIDENCE_CLASS) as EvidenceClass[])
    .map((cls) => ({
      class: cls,
      label: EVIDENCE_CLASS_LABELS[cls],
      items: classCounts.get(cls) ?? 0,
    }))
    .filter((row) => row.items > 0 || row.class === EVIDENCE_CLASS.PLATFORM);

  const nextSteps = buildInvestigateNextSteps(ctx, {
    handle,
    mode,
    sourceObserves,
    discovered,
    relationships,
    web,
    report,
  });

  const completedAt = new Date();
  stages.push(
    stage(
      INVESTIGATION_STAGE.DOSSIER,
      "Assemble the dossier: what is known, what was derived, and what is still unknown",
      INVESTIGATION_STAGE_STATUS.COMPLETED,
      {
        source: "stored observations + the public web",
        reason: `${gaps.length} gap(s) stated; ${evidenceClasses.length} evidence class(es) present`,
        retrieved: { gaps: gaps.length, evidenceClasses: evidenceClasses.length },
        classes: [EVIDENCE_CLASS.DERIVED],
      },
    ),
  );

  // What was actually RETRIEVED — not what was attempted. A scan that was
  // queued and then refused retrieved nothing, and the exit code has to say
  // so.
  const retrievedItems =
    content.media.length +
    content.comments.length +
    content.storyMentions.length +
    content.taggedMedia.length +
    web.totals.facts +
    relationships.ranks.length +
    relationships.syntheticRanks.length +
    report.claims.totals.active +
    (report.platform.profile.latest === null ? 0 : 1);

  return {
    investigation: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      requested,
      username: handle,
      referenceForm: parsed.reference.form,
      targetId,
      observationMode: mode,
      stages,
      sources,
      evidenceClasses,
      retrievedItems,
    },
    identity: report.identity,
    platform: report.platform,
    content,
    relationships: {
      live: relationships.ranks,
      synthetic: relationships.syntheticRanks,
      method: relationships.method,
    },
    web,
    claims: report.claims,
    contradictions: report.contradictions,
    changes: report.changes,
    leads: report.leads,
    themes: report.themes,
    cadence: report.cadence,
    coverage: report.coverage,
    gaps,
    nextSteps,
    report,
    notes: [...report.notes, ...notes],
  };
}

/** The content section, read back from the stored record with its provenance. */
function buildInvestigateContent(
  detail: Awaited<ReturnType<typeof getOwnedTargetDetail>>,
): InvestigateContent {
  const media: InvestigateContent["media"] = [];
  const comments: InvestigateContent["comments"] = [];
  const storyMentions: InvestigateContent["storyMentions"] = [];
  const taggedMedia: InvestigateContent["taggedMedia"] = [];
  if (detail === null) {
    return {
      media,
      comments,
      storyMentions,
      taggedMedia,
      hashtags: [],
      terms: [],
      captionRows: 0,
    };
  }
  for (const post of detail.posts) {
    media.push({
      postId: post.postId,
      caption: post.caption,
      publishedAt: post.takenAt === null ? null : post.takenAt.toISOString(),
      firstObservedAt: post.observedAt.toISOString(),
      likeCount: post.likeCount,
      commentCount: post.commentCount,
      repostsCount: post.repostsCount,
      mediaType: post.mediaType,
      commentsState: post.commentsState,
      sourceId: post.sourceId,
      evidenceId: post.evidenceId,
    });
  }
  for (const group of detail.postComments) {
    for (const comment of group.comments) {
      comments.push({
        postId: group.postId,
        commentId: comment.commentId,
        author: comment.username,
        text: comment.body,
        createdAt: comment.commentedAt.toISOString(),
        evidenceId: comment.evidenceId,
      });
    }
  }
  for (const group of detail.storyMentions) {
    for (const mention of group.mentions) {
      storyMentions.push({
        storyId: group.storyId,
        username: mention.username,
        visibilityClass: mention.visibilityClass,
      });
    }
  }
  for (const row of detail.taggedMedia) {
    taggedMedia.push({
      mediaId: row.mediaId,
      ownerUsername: row.ownerUsername,
      takenAt: row.takenAt === null ? null : row.takenAt.toISOString(),
    });
  }
  const captionRows = detail.posts.filter((p) => p.caption !== null).length;
  return {
    media,
    comments,
    storyMentions,
    taggedMedia,
    hashtags: [],
    terms: [],
    captionRows,
  };
}

/** The next commands, each with the reason it is the next one. */
function buildInvestigateNextSteps(
  ctx: CliContext,
  input: {
    handle: string;
    mode: "OWNED" | "DISCOVERY";
    sourceObserves: boolean;
    discovered: boolean;
    relationships: RelationshipsResult;
    web: InvestigateWeb;
    report: ResearchResult;
  },
): Array<{ action: string; because: string }> {
  const steps: Array<{ action: string; because: string }> = [];
  if (!input.sourceObserves && !input.discovered) {
    steps.push({
      action: "igtrack config",
      because:
        "no platform source observes this account, so its platform fields were never read. `igtrack config` shows which credentials the deployment has and which are missing.",
    });
  }
  if (input.web.totals.facts === 0 && input.web.searchProvider === null) {
    steps.push({
      action: "igtrack audit " + input.handle + " --url \"https://example.org/page-that-names-" + input.handle + "\"",
      because:
        "no public-web source was available, so nothing on the open web was read. Naming a page you know discusses the handle widens the pass without inventing a source.",
    });
  }
  if (input.relationships.ranks.length === 0 && input.relationships.syntheticRanks.length === 0) {
    steps.push({
      action: "igtrack capabilities",
      because:
        "the registry names exactly which capabilities have a lawful source and which are platform-absent — it is the shortest route from \"not observed\" to \"never observable\".",
    });
  }
  if (input.report.claims.totals.active === 0 && input.web.totals.facts > 0) {
    steps.push({
      action: "igtrack claims list --target " + input.handle,
      because:
        "the public-web stage found statements; the claims ledger is where a finding with its citation is kept, so the next investigation can build on it.",
    });
  }
  if (steps.length === 0) {
    steps.push({
      action: "igtrack research " + input.handle,
      because:
        "the full report over the stored record — observations, claims, contradictions and coverage — is one command away.",
    });
  }
  void ctx;
  return steps;
}

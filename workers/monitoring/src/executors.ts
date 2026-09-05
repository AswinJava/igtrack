import { createHash } from "node:crypto";
import {
  stableStringify,
  SourceKind,
  Confidence,
  ObservationCategory,
  CapabilityStatus,
  CapabilityErrorKind,
  isRetryableCapabilityKind,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedProfile,
  type NormalizedFollowEntry,
  type NormalizedPost,
  type NormalizedComment,
  type NormalizedStory,
} from "@igtrack/core";
import {
  recordCapabilitySuccess,
  recordCapabilityFailure,
  recordProviderMetrics,
  markCapabilityUnavailable,
  recordProfileSnapshot,
  recordFollowSnapshot,
  recordStory,
  recordPost,
  recordPostComment,
  latestFollowSnapshot,
  persistFollowDiff,
  loadCheckpoint,
  saveCheckpoint,
  renewJobLease,
  stageFollowScanMembers,
  loadStagedFollowScanMembers,
  clearStagedFollowScanMembers,
  clearForeignFollowScanStaging,
  getTarget,
  getAccountById,
  type Database,
  type JobRecord,
  type SourceInput,
  type EvidenceRecordInput,
  type FollowDirection,
} from "@igtrack/database";
import {
  ProviderTimeoutError,
  providerTimeoutMs,
  withProviderTimeout,
} from "./timeout.js";

export interface ExecutionSource {
  provider: InstagramProvider;
  source: SourceInput;
}

export class JobExecutionError extends Error {
  readonly kind: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { kind?: string; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "JobExecutionError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// STEP 11: explicit source classification. Classifications are decided by
// explicit rules, never a catch-all. The source id is `<class>:<name>:<ver>`:
// class decides SourceKind; the provider is responsible for its own label.
const SOURCE_KIND_BY_CLASS: Record<string, SourceKind> = {
  fixture: SourceKind.FIXTURE,
  import: SourceKind.IMPORT,
  graph: SourceKind.GRAPH_API,
  user: SourceKind.USER_PROVIDED,
};

export function sourceKindFor(sourceId: string): SourceKind {
  const cls = sourceId.split(":")[0] ?? "";
  return SOURCE_KIND_BY_CLASS[cls] ?? SourceKind.IMPORT;
}

// PC-T1: every provider capability call crosses the timeout boundary. A hang
// becomes a typed retryable TIMEOUT capability failure (source health records
// it); no evidence is produced and nothing is marked complete. Every call is
// also counted in capability_metrics (best-effort) for operations visibility.
async function providerCall<T>(
  db: Database,
  source: SourceInput,
  capability: string,
  op: () => Promise<CapabilityResult<T>>,
): Promise<CapabilityResult<T>> {
  const timeoutMs = providerTimeoutMs();
  const startedAt = Date.now();
  const count = async (
    result: CapabilityResult<T> | null,
    extra: { timedOut?: boolean } = {},
  ): Promise<void> => {
    try {
      const errorKind = result?.error?.kind;
      await recordProviderMetrics(db, {
        source,
        capability,
        ok: result !== null && result.status !== CapabilityStatus.ERROR,
        ...(extra.timedOut === true ? { timedOut: true } : {}),
        ...(errorKind === "RATE_LIMITED" ? { rateLimited: true } : {}),
        latencyMs: Date.now() - startedAt,
        observedAt: new Date(startedAt),
      });
    } catch {
      // Metrics must never break a scan.
    }
  };
  try {
    const result = await withProviderTimeout(op(), capability, timeoutMs);
    await count(result);
    return result;
  } catch (err) {
    if (err instanceof ProviderTimeoutError) {
      await count(null, { timedOut: true });
      await recordCapabilityFailure(db, {
        source,
        capability,
        reason: err.message,
        errorCategory: "TIMEOUT",
      });
      throw new JobExecutionError(err.message, {
        kind: "TIMEOUT",
        retryable: true,
      });
    }
    throw err;
  }
}

// Lease heartbeat for paged scans: extends locked_at while this worker still
// owns the job (running + locked_by match). Returns false when ownership was
// lost — the scan loop must then stop writing and report `lost` instead of
// racing the reclaim winner. Never throws: renewal failure surfaces through
// the existing complete/fail ownership guards.
async function renewLease(db: Database, job: JobRecord): Promise<boolean> {
  if (job.lockedBy === null) return true;
  try {
    return await renewJobLease(db, job.id, job.lockedBy);
  } catch {
    return true;
  }
}

// STEP 9: provider-declared retryability wins; the taxonomy decides when the
// provider leaves it unset. A non-retryable kind is permanent regardless of
// what a broken provider claims.
function resolvedRetryable(err: { kind?: string; retryable?: boolean } | undefined): boolean {
  const kind = err?.kind;
  const declared = kind !== undefined && Object.values(CapabilityErrorKind).includes(kind as CapabilityErrorKind)
    ? isRetryableCapabilityKind(kind as CapabilityErrorKind)
    : true;
  return err?.retryable ?? declared;
}

export function buildSource(provider: InstagramProvider): SourceInput {
  // sourceId forms: "<class>:<version>" (fixture:v1) or "<class>:<name>:<version>"
  // (<class>:graph:v2). The class drives SourceKind; the last segment is the
  // provider version.
  const parts = provider.sourceId.split(":");
  return {
    id: provider.sourceId,
    kind: sourceKindFor(provider.sourceId),
    name: `${provider.sourceId} provider`,
    providerVersion: parts[parts.length - 1] ?? "unknown",
  };
}

export function isSynthetic(source: SourceInput): boolean {
  return source.kind === SourceKind.FIXTURE;
}

function evidenceFrom(
  source: SourceInput,
  kind: string,
  observationId: string,
  template: {
    observedAt: string;
    confidence: Confidence;
    ref?: string;
    rawPayloadHash?: string;
    rawReference?: string;
  },
  payload: unknown,
  metadata?: Record<string, unknown>,
): EvidenceRecordInput {
  const normalizedHash = sha256(stableStringify(payload));
  return {
    observationKind: kind,
    source,
    ...(template.rawReference !== undefined
      ? { sourceReference: template.rawReference }
      : template.ref !== undefined
        ? { sourceReference: template.ref }
        : {}),
    schemaVersion: "v1",
    observedAt: new Date(template.observedAt),
    capturedAt: new Date(),
    confidence: template.confidence,
    // raw_hash carries the provider's genuine raw-payload hash. When the
    // provider cannot transport the raw representation it stays unset — a
    // normalized hash must never masquerade as a raw one.
    ...(template.rawPayloadHash !== undefined
      ? { rawHash: template.rawPayloadHash }
      : {}),
    normalizedHash,
    metadata: { synthetic: source.kind === SourceKind.FIXTURE, ...(metadata ?? {}) },
  };
}

async function loadAccountForTarget(
  db: Database,
  job: JobRecord,
): Promise<{ account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>; target: NonNullable<Awaited<ReturnType<typeof getTarget>>> }> {
  if (job.targetId === null) {
    throw new JobExecutionError(`job ${job.kind} requires a target`, { retryable: false });
  }
  const target = await getTarget(db, job.targetId);
  if (target === null) {
    throw new JobExecutionError(`target ${job.targetId} not found`, { retryable: false });
  }
  const account = await getAccountById(db, target.igAccountId);
  if (account === null) {
    throw new JobExecutionError(`ig_account ${target.igAccountId} not found`, { retryable: false });
  }
  return { account: account as NonNullable<Awaited<ReturnType<typeof getAccountById>>>, target };
}

function accountRef(account: {
  username: string;
  igId: string | null;
  displayName: string | null;
  isPrivate: boolean | null;
}): NormalizedAccountRef {
  return {
    username: account.username,
    ...(account.igId !== null ? { igId: account.igId } : {}),
    ...(account.displayName !== null ? { displayName: account.displayName } : {}),
    ...(account.isPrivate !== null ? { isPrivate: account.isPrivate } : {}),
  };
}

export type JobResult =
  | "succeeded"
  | "succeeded-empty"
  | "succeeded-partial"
  | "unavailable"
  | "failure";

// ---------------------------------------------------------------------------
// PROFILE_SCAN
// ---------------------------------------------------------------------------

export async function runProfileScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
): Promise<JobResult> {
  const { account, target } = await loadAccountForTarget(db, job);
  const source = src.source;

  const caps = src.provider.capabilities();
  if (caps.getProfile !== true) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getProfile",
      coverageNote: "Provider declares the getProfile capability unavailable.",
    });
    return "unavailable";
  }

  const result: CapabilityResult<NormalizedProfile> = await providerCall(
    db,
    source,
    "getProfile",
    () => src.provider.getProfile(accountRef(account)),
  );

  if (result.status === CapabilityStatus.UNAVAILABLE) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getProfile",
      coverageNote: result.note ?? "Profile unavailable from this source.",
    });
    return "unavailable";
  }

  if (result.status === CapabilityStatus.ERROR) {
    const err = result.error;
    await recordCapabilityFailure(db, {
      source,
      capability: "getProfile",
      reason: err?.message ?? "Provider error",
      errorCategory: err?.kind ?? "INTERNAL",
    });
    throw new JobExecutionError(err?.message ?? "Provider error", {
      kind: err?.kind ?? "INTERNAL",
      retryable: resolvedRetryable(err),
      ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    });
  }

  if (result.data === undefined) {
    throw new JobExecutionError("Provider returned no profile data", { retryable: false });
  }

  const observedAt = result.observedAt;
  const observationId = `profile:${account.username}@${observedAt}`;
  const evidence = evidenceFrom(
    source,
    "profile_snapshot",
    observationId,
    {
      observedAt,
      confidence: result.confidence,
      ref: account.username,
      ...(result.rawPayloadHash !== undefined
        ? { rawPayloadHash: result.rawPayloadHash }
        : {}),
      ...(result.rawReference !== undefined
        ? { rawReference: result.rawReference }
        : {}),
    },
    result.data,
    { capabilityStatus: result.status, jobId: job.id },
  );

  await recordProfileSnapshot(db, {
    profile: result.data,
    evidence,
  });

  await recordCapabilitySuccess(db, {
    source,
    capability: "getProfile",
  });

  return "succeeded";
}

// ---------------------------------------------------------------------------
// FOLLOWER_SCAN — checkpoint-resumable, append-only, idempotent.
//
// Paginates the provider by cursor, persisting a per-scan checkpoint after
// each page. The checkpoint carries the acquired entries (username + igId) and
// belongs to exactly one logical scan (job id): a resumed run restores the
// full member set, so a crash can never silently drop an acquired page.
// The observation identity (snapshot taken_at + evidence observed_at) derives
// from the job's first-claim timestamp, which is stable across retries and
// lease reclaims — a crash after the observation write dedupes on the natural
// key instead of duplicating history. Completeness comes from the provider's
// final page contract, never hardcoded.
// ---------------------------------------------------------------------------

export interface FollowerScanOptions {
  // Test hook: throw after processing this many pages to simulate an
  // interrupted worker, enabling checkpoint-resume verification.
  crashAfterPages?: number;
}

const FOLLOWER_CHECKPOINT_KIND = "FOLLOWER_SCAN";
const FOLLOWING_CHECKPOINT_KIND = "FOLLOWING_SCAN";

export interface FollowScanConfig {
  jobKind: "FOLLOWER_SCAN" | "FOLLOWING_SCAN";
  direction: FollowDirection;
  capability: "getFollowers" | "getFollowing";
  checkpointKind: string;
  // Stable observation-identity prefix; the FOLLOWERS value preserves the
  // Phase 5 identity scheme exactly.
  identityPrefix: string;
}

const FOLLOWER_SCAN_CONFIG: FollowScanConfig = {
  jobKind: "FOLLOWER_SCAN",
  direction: "FOLLOWERS",
  capability: "getFollowers",
  checkpointKind: FOLLOWER_CHECKPOINT_KIND,
  identityPrefix: "followers",
};

const FOLLOWING_SCAN_CONFIG: FollowScanConfig = {
  jobKind: "FOLLOWING_SCAN",
  direction: "FOLLOWING",
  capability: "getFollowing",
  checkpointKind: FOLLOWING_CHECKPOINT_KIND,
  identityPrefix: "following",
};

interface FollowCheckpointProgress {
  cursor?: string;
  page?: number;
  // Legacy (pre-0005) checkpoints carried the full entries array; staging
  // replaced it. Empty array below means "no legacy entries".
  entries?: Array<{ username: string; igId?: string }>;
}

export async function runFollowerScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
  options: FollowerScanOptions = {},
): Promise<JobResult> {
  return runFollowScan(db, job, src, FOLLOWER_SCAN_CONFIG, options);
}

export async function runFollowingScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
  options: FollowerScanOptions = {},
): Promise<JobResult> {
  return runFollowScan(db, job, src, FOLLOWING_SCAN_CONFIG, options);
}

// Direction-generic follow scan: one reliability architecture (checkpoint
// ownership, logical scan identity, completeness honesty, derived deltas)
// shared by FOLLOWER_SCAN and FOLLOWING_SCAN.
export async function runFollowScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
  cfg: FollowScanConfig,
  options: FollowerScanOptions = {},
): Promise<JobResult> {
  if (job.targetId === null) {
    throw new JobExecutionError(`${cfg.jobKind} requires a target`, { retryable: false });
  }
  const targetId = job.targetId;
  const { account } = await loadAccountForTarget(db, job);
  const target = await getTarget(db, targetId);
  if (target === null) {
    throw new JobExecutionError(`target ${targetId} not found`, { retryable: false });
  }
  const source = src.source;
  const direction = cfg.direction;

  const caps = src.provider.capabilities();
  if (caps[cfg.capability] !== true) {
    await markCapabilityUnavailable(db, {
      source,
      capability: cfg.capability,
      coverageNote: `Provider declares the ${cfg.capability} capability unavailable.`,
    });
    return "unavailable";
  }

  // Logical scan identity: claimJob preserves started_at across retries and
  // lease reclaims, so every execution of this job observes the same instant.
  const scanObservedAt = new Date(job.startedAt ?? Date.now()).toISOString();

  // A checkpoint belongs to one logical scan. Resume only when this job owns
  // it; a foreign or legacy checkpoint starts a fresh scan. PC-T2: acquired
  // members live in the durable staging table (append-only, idempotent), so a
  // resumed scan continues with the already-staged rows for THIS job —
  // including legacy entries fostered from an old JSONB checkpoint.
  const checkpoint = await loadCheckpoint(db, targetId, cfg.checkpointKind);
  const ownedCheckpoint =
    checkpoint !== null && checkpoint.jobId === job.id ? checkpoint : null;
  const progress = (ownedCheckpoint?.progress ?? undefined) as
    | FollowCheckpointProgress
    | undefined;

  if (ownedCheckpoint === null) {
    // Fresh logical scan: clear any abandoned staging from a crashed or
    // superseded job before reusing this target's rows.
    await clearForeignFollowScanStaging(db, { targetId, keepJobId: job.id });
  } else {
    // Owned checkpoint: todays already-staged rows are our resume basis.
    await clearForeignFollowScanStaging(db, { targetId, keepJobId: job.id });
  }

  const legacyEntries: NormalizedFollowEntry[] = (progress?.entries ?? []).map(
    (entry) => ({
      username: entry.username,
      ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
    }),
  );
  if (legacyEntries.length > 0) {
    // Foster pre-staging checkpoint members into the staging table exactly
    // once, under this job's ownership.
    await stageFollowScanMembers(db, {
      jobId: job.id,
      targetId,
      entries: legacyEntries,
    });
  }

  let cursor = progress?.cursor;
  let pagesProcessed = progress?.page ?? 0;
  let lastPageComplete = false;

  const persistCheckpoint = async (nextCursor: string | undefined): Promise<void> => {
    // Checkpoint is now cursor/page only (PC-T2): no O(n²) array rewrites.
    await saveCheckpoint(db, {
      targetId,
      kind: cfg.checkpointKind,
      jobId: job.id,
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      page: pagesProcessed,
      progress: {
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        page: pagesProcessed,
      },
    });
  };

  const ref = accountRef(account);

  for (;;) {
    const pageResult = await providerCall(db, source, cfg.capability, () =>
      src.provider[cfg.capability](
        ref,
        cursor !== undefined ? { value: cursor } : undefined,
      ),
    );

    if (pageResult.status === CapabilityStatus.UNAVAILABLE) {
      await markCapabilityUnavailable(db, {
        source,
        capability: cfg.capability,
        coverageNote:
          pageResult.note ??
          `${direction === "FOLLOWERS" ? "Follower" : "Following"} list unavailable from this source.`,
      });
      return "unavailable";
    }
    if (pageResult.status === CapabilityStatus.ERROR) {
      const err = pageResult.error;
      await recordCapabilityFailure(db, {
        source,
        capability: cfg.capability,
        reason: err?.message ?? "Provider error",
        errorCategory: err?.kind ?? "INTERNAL",
      });
      throw new JobExecutionError(err?.message ?? "Provider error", {
        kind: err?.kind ?? "INTERNAL",
        retryable: resolvedRetryable(err),
        ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      });
    }
    if (pageResult.data === undefined) {
      throw new JobExecutionError("Provider returned no follower page data", {
        retryable: false,
      });
    }

    const page = pageResult.data;
    const pageCursor = page.nextCursor;
    const pageComplete = page.complete;
    lastPageComplete = pageComplete;

    // PC-T2: stage the new members durably NOW — append-only and idempotent.
    // pagesProcessed advances only after the persistent write succeeds.
    await stageFollowScanMembers(db, {
      jobId: job.id,
      targetId,
      entries: page.entries,
    });
    pagesProcessed += 1;

    // Simulated interruption (test hook) — leaves partial state behind.
    if (options.crashAfterPages !== undefined && pagesProcessed >= options.crashAfterPages) {
      await persistCheckpoint(pageCursor);
      throw new JobExecutionError(
        `Simulated interruption after page ${pagesProcessed}`,
        { retryable: true, kind: "INTERRUPTED" },
      );
    }

    await persistCheckpoint(pageCursor);

    // Heartbeat: a many-page scan must not look abandoned mid-run. When the
    // lease was reclaimed elsewhere this returns false and the scan stops
    // writing instead of racing the new owner.
    if ((await renewLease(db, job)) === false) {
      throw new JobExecutionError("Job lease lost during follow scan", {
        kind: "LEASE_LOST",
        retryable: false,
      });
    }

    if (pageComplete || pageCursor === undefined || pageCursor === "") {
      break;
    }
    cursor = pageCursor;
  }

  // One coherent snapshot for the whole scan, evidence-linked at insert time.
  // PC-T2: the final member set is read from durable staging in acquisition
  // order — a genuine empty list (AVAILABLE, complete, zero entries) is an
  // honest positive observation of absence (F8-2), recorded as COMPLETED_EMPTY,
  // never converted into a failure.
  const members: NormalizedFollowEntry[] = await loadStagedFollowScanMembers(
    db,
    job.id,
  );

  // Derived follow deltas vs the PREVIOUS snapshot — must be read before the
  // new snapshot is inserted, otherwise "latest" is the snapshot we just wrote.
  const previous = await latestFollowSnapshot(db, targetId, direction);

  // Observation identity is the logical scan time (stable across retries and
  // lease reclaims), not this execution's wall clock. captured_at stays real.
  const observedAt = scanObservedAt;
  const observationId = `${cfg.identityPrefix}:${targetId}@${observedAt}`;
  const completion = lastPageComplete ? "COMPLETE" : "PARTIAL";
  const evidence = evidenceFrom(
    source,
    "follow_snapshot",
    observationId,
    {
      observedAt,
      confidence: Confidence.HIGH,
      ref: account.username,
    },
    { count: members.length, usernames: members.map((e) => e.username) },
    { direction, completion, jobId: job.id },
  );

  const result = await recordFollowSnapshot(db, {
    targetId,
    direction,
    source,
    evidence,
    page: {
      entries: members,
      complete: lastPageComplete,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt,
      },
    },
  });

  if (previous !== null && previous.id !== result.snapshot.id) {
    // Diffs are derived only between COMPLETE snapshots. Diffing a PARTIAL
    // scan against a previous snapshot would fabricate LOST_* deltas from a
    // truncated page — the partial snapshot is still recorded, but no
    // relationship change is claimed from it.
    if (lastPageComplete && previous.completeness === "COMPLETE") {
      await persistFollowDiff(db, {
        targetId,
        direction,
        fromSnapshotId: previous.id,
        toSnapshotId: result.snapshot.id,
      });
    }
  }

  // Clear the checkpoint and owned staging now the scan is complete so the
  // next scan starts fresh. Foreign-staging cleanup already ran at scan start.
  await clearStagedFollowScanMembers(db, job.id);
  await saveCheckpoint(db, {
    targetId,
    kind: cfg.checkpointKind,
    page: 0,
    progress: { page: 0 },
  });

  await recordCapabilitySuccess(db, {
    source,
    capability: cfg.capability,
  });

  if (members.length === 0) return "succeeded-empty";
  return lastPageComplete ? "succeeded" : "succeeded-partial";
}

// ---------------------------------------------------------------------------
// STORY_SCAN
// ---------------------------------------------------------------------------

function storyObservationId(accountUsername: string, story: NormalizedStory): string {
  return `story:${accountUsername}:${story.storyId}@${story.meta.observedAt}`;
}

export async function runStoryScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
): Promise<JobResult> {
  const { account } = await loadAccountForTarget(db, job);
  const source = src.source;

  const caps = src.provider.capabilities();
  if (caps.getStories !== true) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getStories",
      coverageNote: "Provider declares the getStories capability unavailable.",
    });
    return "unavailable";
  }

  const result = await providerCall(db, source, "getStories", () =>
    src.provider.getStories(accountRef(account)),
  );

  if (result.status === CapabilityStatus.UNAVAILABLE) {
    // An unavailable story tray is NOT an empty tray: no story rows, no
    // "no story" claims — source health carries the truth.
    await markCapabilityUnavailable(db, {
      source,
      capability: "getStories",
      coverageNote: result.note ?? "Stories unavailable from this source.",
    });
    return "unavailable";
  }

  if (result.status === CapabilityStatus.ERROR) {
    const err = result.error;
    await recordCapabilityFailure(db, {
      source,
      capability: "getStories",
      reason: err?.message ?? "Provider error",
      errorCategory: err?.kind ?? "INTERNAL",
    });
    throw new JobExecutionError(err?.message ?? "Provider error", {
      kind: err?.kind ?? "INTERNAL",
      retryable: resolvedRetryable(err),
      ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    });
  }

  if (result.data === undefined) {
    throw new JobExecutionError("Provider returned no story data", { retryable: false });
  }

  const stories = result.data;
  const completion = result.status === CapabilityStatus.PARTIAL ? "PARTIAL" : "COMPLETE";

  for (const story of stories) {
    const observationId = storyObservationId(account.username, story);
    const rawMeta = {
      observedAt: story.meta.observedAt,
      confidence: story.meta.confidence,
      ...(result.rawPayloadHash !== undefined ? { rawPayloadHash: result.rawPayloadHash } : {}),
      ...(result.rawReference !== undefined ? { rawReference: result.rawReference } : {}),
    };
    const evidence = evidenceFrom(
      source,
      "story",
      observationId,
      rawMeta,
      story,
      { completion, jobId: job.id },
    );

    // Mention evidence keyed by lowercase username, exactly as recordStory
    // consumes it. Classification reuses the normalizer's visibility class —
    // no second taxonomy exists or is invented here.
    const mentionEvidence: Record<string, EvidenceRecordInput> = {};
    for (const mention of story.mentions) {
      const usernameKey = mention.account.username.toLowerCase();
      mentionEvidence[usernameKey] = evidenceFrom(
        source,
        "story_mention",
        `story_mention:${account.username}:${story.storyId}:${usernameKey}@${story.meta.observedAt}`,
        {
          observedAt: mention.meta.observedAt,
          confidence: mention.meta.confidence,
          ...(result.rawPayloadHash !== undefined
            ? { rawPayloadHash: result.rawPayloadHash }
            : {}),
          ...(result.rawReference !== undefined
            ? { rawReference: result.rawReference }
            : {}),
        },
        mention,
        {
          storyId: story.storyId,
          classification: mention.visibilityClass,
          mentionedUsername: mention.account.username,
          jobId: job.id,
        },
      );
    }

    await recordStory(db, {
      owner: accountRef(account),
      story,
      sourceId: source.id,
      evidence,
      mentionEvidence,
    });
  }

  await recordCapabilitySuccess(db, {
    source,
    capability: "getStories",
  });

  if (stories.length === 0) {
    // AVAILABLE + zero stories is an honest positive observation of absence —
    // never conflated with UNAVAILABLE.
    return "succeeded-empty";
  }
  return completion === "PARTIAL" ? "succeeded-partial" : "succeeded";
}

// ---------------------------------------------------------------------------
// POST_SCAN
//
// Persists provider posts plus their publicly exposed comments across ALL
// pages: the listing resumes via CapabilityResult.nextCursor with a
// POSTS_SCAN checkpoint, so multi-page media collections complete instead of
// truncating at 25. Per-post comment observation state is recorded at insert
// time (the table is append-only): OBSERVED (source read, even when empty),
// UNAVAILABLE (no exposed comment source — skipped, never empty-faked),
// NOT_SCANNED (comments capability off). A duplicate-cursor loop guard stops
// pathological providers instead of paging forever.
// ---------------------------------------------------------------------------

const POSTS_CHECKPOINT_KIND = "POSTS_SCAN";

async function fetchCommentPages(
  db: Database,
  source: SourceInput,
  provider: InstagramProvider,
  post: NormalizedPost,
): Promise<{
  comments: NormalizedComment[];
  state: "OBSERVED" | "UNAVAILABLE";
  truncated: boolean;
  rawPayloadHash?: string;
  rawReference?: string;
}> {
  const comments: NormalizedComment[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  let rawPayloadHash: string | undefined;
  let rawReference: string | undefined;
  for (;;) {
    const result: CapabilityResult<NormalizedComment[]> = await providerCall(
      db,
      source,
      "getPublicComments",
      () => provider.getPublicComments(post, cursor !== undefined ? { value: cursor } : undefined),
    );
    if (result.status === CapabilityStatus.UNAVAILABLE) {
      // A post with no exposed comment source stays comment-less. The gap is
      // recorded in source health; the post itself is still a real observation.
      await markCapabilityUnavailable(db, {
        source,
        capability: "getPublicComments",
        coverageNote: result.note ?? `No comment source for post ${post.postId}.`,
      });
      return { comments, state: "UNAVAILABLE", truncated: false };
    }
    if (result.status === CapabilityStatus.ERROR) {
      const err = result.error;
      await recordCapabilityFailure(db, {
        source,
        capability: "getPublicComments",
        reason: err?.message ?? "Provider error",
        errorCategory: err?.kind ?? "INTERNAL",
      });
      throw new JobExecutionError(err?.message ?? "Provider error", {
        kind: err?.kind ?? "INTERNAL",
        retryable: resolvedRetryable(err),
        ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      });
    }
    if (result.data !== undefined) comments.push(...result.data);
    if (rawPayloadHash === undefined) rawPayloadHash = result.rawPayloadHash;
    if (rawReference === undefined) rawReference = result.rawReference;
    const next = result.nextCursor;
    // Duplicate cursor = pathological provider loop: stop instead of paging
    // forever, and flag the listing truncated so the scan reports partial.
    if (next !== undefined && next !== "" && seenCursors.has(next)) {
      truncated = true;
      break;
    }
    if (next === undefined || next === "") break;
    seenCursors.add(next);
    cursor = next;
  }
  return {
    comments,
    state: "OBSERVED",
    truncated,
    ...(rawPayloadHash !== undefined ? { rawPayloadHash } : {}),
    ...(rawReference !== undefined ? { rawReference } : {}),
  };
}

export async function runPostScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
): Promise<JobResult> {
  if (job.targetId === null) {
    throw new JobExecutionError("POST_SCAN requires a target", { retryable: false });
  }
  const targetId = job.targetId;
  const { account } = await loadAccountForTarget(db, job);
  const source = src.source;

  const caps = src.provider.capabilities();
  if (caps.getPublicPosts !== true) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getPublicPosts",
      coverageNote: "Provider declares the getPublicPosts capability unavailable.",
    });
    return "unavailable";
  }
  const commentsSupported = caps.getPublicComments === true;
  if (!commentsSupported) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getPublicComments",
      coverageNote: "Provider declares the getPublicComments capability unavailable.",
    });
  }

  // Resume an owned multi-page listing; a foreign checkpoint starts fresh.
  const postCheckpoint = await loadCheckpoint(db, targetId, POSTS_CHECKPOINT_KIND);
  let postCursor =
    postCheckpoint !== null && postCheckpoint.jobId === job.id
      ? (postCheckpoint.progress as { cursor?: string } | null)?.cursor ??
        postCheckpoint.cursor ??
        undefined
      : undefined;
  await saveCheckpoint(db, {
    targetId,
    kind: POSTS_CHECKPOINT_KIND,
    jobId: job.id,
    ...(postCursor !== undefined ? { cursor: postCursor } : {}),
    page: 0,
    progress: { ...(postCursor !== undefined ? { cursor: postCursor } : {}), page: 0 },
  });

  const ref = accountRef(account);
  const seenCursors = new Set<string>();
  let pagesProcessed = 0;
  let postsObserved = 0;
  let truncated = false;

  for (;;) {
    const result: CapabilityResult<NormalizedPost[]> = await providerCall(
      db,
      source,
      "getPublicPosts",
      () => src.provider.getPublicPosts(ref, postCursor !== undefined ? { value: postCursor } : undefined),
    );

    if (result.status === CapabilityStatus.UNAVAILABLE) {
      await markCapabilityUnavailable(db, {
        source,
        capability: "getPublicPosts",
        coverageNote: result.note ?? "Posts unavailable from this source.",
      });
      return "unavailable";
    }

    if (result.status === CapabilityStatus.ERROR) {
      const err = result.error;
      await recordCapabilityFailure(db, {
        source,
        capability: "getPublicPosts",
        reason: err?.message ?? "Provider error",
        errorCategory: err?.kind ?? "INTERNAL",
      });
      throw new JobExecutionError(err?.message ?? "Provider error", {
        kind: err?.kind ?? "INTERNAL",
        retryable: resolvedRetryable(err),
        ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      });
    }

    if (result.data === undefined) {
      throw new JobExecutionError("Provider returned no post data", { retryable: false });
    }

    const posts = result.data;
    const pagePartial =
      result.status === CapabilityStatus.PARTIAL || result.confidence === Confidence.MEDIUM;

    for (const post of posts) {
      // Comments resolve BEFORE the post row is written: the posts table is
      // append-only, so per-post comment state must be known at insert time.
      let commentsState: "OBSERVED" | "UNAVAILABLE" | "NOT_SCANNED" = "NOT_SCANNED";
      let postComments: NormalizedComment[] = [];
      let commentRawHash: string | undefined;
      let commentRawRef: string | undefined;
      if (commentsSupported) {
        const fetched = await fetchCommentPages(db, source, src.provider, post);
        postComments = fetched.comments;
        commentsState = fetched.state;
        commentRawHash = fetched.rawPayloadHash;
        commentRawRef = fetched.rawReference;
        if (fetched.truncated) truncated = true;
      }

      const postEvidence = evidenceFrom(
        source,
        "post",
        `post:${account.username}:${post.postId}@${post.meta.observedAt}`,
        {
          observedAt: post.meta.observedAt,
          confidence: post.meta.confidence,
          ref: account.username,
          ...(result.rawPayloadHash !== undefined
            ? { rawPayloadHash: result.rawPayloadHash }
            : {}),
          ...(result.rawReference !== undefined
            ? { rawReference: result.rawReference }
            : {}),
        },
        post,
        { completion: pagePartial ? "PARTIAL" : "COMPLETE", jobId: job.id },
      );

      const { post: postRow } = await recordPost(db, {
        targetId,
        owner: ref,
        post,
        sourceId: source.id,
        evidence: postEvidence,
        commentsState,
      });

      for (const comment of postComments) {
        const commentEvidence = evidenceFrom(
          source,
          "post_comment",
          `post_comment:${account.username}:${post.postId}:${comment.commentId}@${comment.meta.observedAt}`,
          {
            observedAt: comment.meta.observedAt,
            confidence: comment.meta.confidence,
            ...(commentRawHash !== undefined ? { rawPayloadHash: commentRawHash } : {}),
            ...(commentRawRef !== undefined ? { rawReference: commentRawRef } : {}),
          },
          comment,
          { postId: post.postId, jobId: job.id },
        );
        await recordPostComment(db, {
          postDbId: postRow.id,
          comment,
          evidence: commentEvidence,
        });
      }

      postsObserved += 1;
    }

    pagesProcessed += 1;
    await saveCheckpoint(db, {
      targetId,
      kind: POSTS_CHECKPOINT_KIND,
      jobId: job.id,
      ...(result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}),
      page: pagesProcessed,
      progress: {
        ...(result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}),
        page: pagesProcessed,
      },
    });
    if ((await renewLease(db, job)) === false) {
      throw new JobExecutionError("Job lease lost during posts scan", {
        kind: "LEASE_LOST",
        retryable: false,
      });
    }

    const next = result.nextCursor;
    if (next === undefined || next === "" || seenCursors.has(next)) {
      // Duplicate cursor = pathological provider loop: stop instead of paging
      // forever, and report the listing as truncated (partial).
      if (next !== undefined && next !== "") truncated = true;
      break;
    }
    seenCursors.add(next);
    postCursor = next;
  }

  await saveCheckpoint(db, {
    targetId,
    kind: POSTS_CHECKPOINT_KIND,
    page: 0,
    progress: { page: 0 },
  });

  await recordCapabilitySuccess(db, {
    source,
    capability: "getPublicPosts",
  });

  if (postsObserved === 0) return "succeeded-empty";
  return truncated ? "succeeded-partial" : "succeeded";
}


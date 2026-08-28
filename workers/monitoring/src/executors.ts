import { createHash } from "node:crypto";
import {
  stableStringify,
  SourceKind,
  Confidence,
  ObservationCategory,
  CapabilityStatus,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedProfile,
  type NormalizedFollowEntry,
} from "@igtrack/core";
import {
  recordCapabilitySuccess,
  recordCapabilityFailure,
  markCapabilityUnavailable,
  recordProfileSnapshot,
  recordFollowSnapshot,
  latestFollowSnapshot,
  persistFollowDiff,
  loadCheckpoint,
  saveCheckpoint,
  getTarget,
  getAccountById,
  type Database,
  type JobRecord,
  type SourceInput,
  type EvidenceRecordInput,
  type FollowDirection,
} from "@igtrack/database";

export interface ExecutionSource {
  provider: InstagramProvider;
  source: SourceInput;
}

export class JobExecutionError extends Error {
  readonly kind: string | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { kind?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "JobExecutionError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? true;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceKindFor(sourceId: string): SourceKind {
  return sourceId.startsWith("fixture") ? SourceKind.FIXTURE : SourceKind.IMPORT;
}

export function buildSource(provider: InstagramProvider): SourceInput {
  return {
    id: provider.sourceId,
    kind: sourceKindFor(provider.sourceId),
    name: `${provider.sourceId} provider`,
    providerVersion: provider.sourceId.split(":")[1] ?? "unknown",
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

export type JobResult = "succeeded" | "unavailable" | "failure";

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

  const result: CapabilityResult<NormalizedProfile> = await src.provider.getProfile(
    accountRef(account),
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
      retryable: err?.retryable ?? true,
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
    { capabilityStatus: result.status },
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
  // it; a foreign or legacy checkpoint starts a fresh scan.
  const checkpoint = await loadCheckpoint(db, targetId, cfg.checkpointKind);
  const ownedCheckpoint =
    checkpoint !== null && checkpoint.jobId === job.id ? checkpoint : null;
  const progress = (ownedCheckpoint?.progress ?? undefined) as
    | FollowCheckpointProgress
    | undefined;
  let cursor = progress?.cursor;
  let pageIndex = progress?.page ?? 0;
  const entries: NormalizedFollowEntry[] = (progress?.entries ?? []).map((entry) => ({
    username: entry.username,
    ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
  }));
  const seen = new Set<string>(entries.map((entry) => entry.username.toLowerCase()));
  let pagesProcessed = pageIndex;
  let lastPageComplete = false;

  const persistCheckpoint = async (nextCursor: string | undefined): Promise<void> => {
    await saveCheckpoint(db, {
      targetId,
      kind: cfg.checkpointKind,
      jobId: job.id,
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      page: pagesProcessed,
      progress: {
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        page: pagesProcessed,
        entries: entries.map((entry) => ({
          username: entry.username,
          ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
        })),
      },
    });
  };

  const ref = accountRef(account);

  for (;;) {
    const pageResult = await src.provider[cfg.capability](
      ref,
      cursor !== undefined ? { value: cursor } : undefined,
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
        retryable: err?.retryable ?? true,
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

    for (const entry of page.entries) {
      const key = entry.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
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

    if (pageComplete || pageCursor === undefined || pageCursor === "") {
      break;
    }
    cursor = pageCursor;
  }

  // One coherent snapshot for the whole scan, evidence-linked at insert time.
  if (entries.length === 0 && pagesProcessed === 0) {
    await recordCapabilityFailure(db, {
      source,
      capability: cfg.capability,
      reason:
        "Provider returned no follow entries before any page completed",
      errorCategory: "EMPTY",
    });
    throw new JobExecutionError(
      `Provider returned no ${direction === "FOLLOWERS" ? "follower" : "following"} entries`,
      {
        retryable: true,
        kind: "EMPTY",
      },
    );
  }

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
    { count: entries.length, usernames: entries.map((e) => e.username) },
    { direction, completion },
  );

  const result = await recordFollowSnapshot(db, {
    targetId,
    direction,
    source,
    evidence,
    page: {
      entries,
      complete: lastPageComplete,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt,
      },
    },
  });

  if (previous !== null && previous.id !== result.snapshot.id) {
    await persistFollowDiff(db, {
      targetId,
      direction,
      fromSnapshotId: previous.id,
      toSnapshotId: result.snapshot.id,
    });
  }

  // Clear the checkpoint now the scan is complete so the next scan starts fresh.
  await saveCheckpoint(db, {
    targetId,
    kind: cfg.checkpointKind,
    page: 0,
    progress: { page: 0, entries: [] },
  });

  await recordCapabilitySuccess(db, {
    source,
    capability: cfg.capability,
  });

  return "succeeded";
}


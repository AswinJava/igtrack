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
  template: { observedAt: string; confidence: Confidence; ref?: string },
  payload: unknown,
  metadata?: Record<string, unknown>,
): EvidenceRecordInput {
  const hash = sha256(stableStringify(payload));
  return {
    observationKind: kind,
    source,
    ...(template.ref !== undefined ? { sourceReference: template.ref } : {}),
    schemaVersion: "v1",
    observedAt: new Date(template.observedAt),
    capturedAt: new Date(),
    confidence: template.confidence,
    rawHash: hash,
    normalizedHash: hash,
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
  isPrivate: boolean;
}): NormalizedAccountRef {
  return {
    username: account.username,
    ...(account.igId !== null ? { igId: account.igId } : {}),
    ...(account.displayName !== null ? { displayName: account.displayName } : {}),
    isPrivate: account.isPrivate,
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
    { observedAt, confidence: result.confidence, ref: account.username },
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
// FOLLOWER_SCAN — fixture-backed, checkpoint-resumable, append-only.
//
// Paginates the provider by cursor, persisting a per-scan checkpoint after
// each page so an interrupted run (worker crash) can resume from the next
// cursor without re-fetching finished pages or duplicating DB writes
// (recordFollowSnapshot is idempotent by natural key). Accumulated entries are
// carried in the checkpoint so a resumed run emits one coherent snapshot.
// ---------------------------------------------------------------------------

export interface FollowerScanOptions {
  // Test hook: throw after processing this many pages to simulate an
  // interrupted worker, enabling checkpoint-resume verification.
  crashAfterPages?: number;
}

const FOLLOWER_CHECKPOINT_KIND = "FOLLOWER_SCAN";

export async function runFollowerScan(
  db: Database,
  job: JobRecord,
  src: ExecutionSource,
  options: FollowerScanOptions = {},
): Promise<JobResult> {
  if (job.targetId === null) {
    throw new JobExecutionError("FOLLOWER_SCAN requires a target", { retryable: false });
  }
  const targetId = job.targetId;
  const { account } = await loadAccountForTarget(db, job);
  const target = await getTarget(db, targetId);
  if (target === null) {
    throw new JobExecutionError(`target ${targetId} not found`, { retryable: false });
  }
  const source = src.source;
  const direction: FollowDirection = "FOLLOWERS";

  const caps = src.provider.capabilities();
  if (caps.getFollowers !== true) {
    await markCapabilityUnavailable(db, {
      source,
      capability: "getFollowers",
      coverageNote: "Provider declares the getFollowers capability unavailable.",
    });
    return "unavailable";
  }

  // Revive prior progress (cursors / pages done / accumulated usernames).
  const checkpoint = await loadCheckpoint(db, targetId, FOLLOWER_CHECKPOINT_KIND);
  const progress = (checkpoint?.progress ?? {}) as {
    cursor?: string;
    page?: number;
    usernames?: string[];
  };
  let cursor = progress.cursor;
  let pageIndex = progress.page ?? 0;
  const entries: NormalizedFollowEntry[] = [];
  const seen = new Set<string>(progress.usernames ?? []);
  let pagesProcessed = pageIndex;

  const ref = accountRef(account);

  for (;;) {
    const pageResult = await src.provider.getFollowers(
      ref,
      cursor !== undefined ? { value: cursor } : undefined,
    );

    if (pageResult.status === CapabilityStatus.UNAVAILABLE) {
      await markCapabilityUnavailable(db, {
        source,
        capability: "getFollowers",
        coverageNote: pageResult.note ?? "Follower list unavailable from this source.",
      });
      return "unavailable";
    }
    if (pageResult.status === CapabilityStatus.ERROR) {
      const err = pageResult.error;
      await recordCapabilityFailure(db, {
        source,
        capability: "getFollowers",
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

    for (const entry of page.entries) {
      const key = entry.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    pagesProcessed += 1;

    // Simulated interruption (test hook) — leaves partial state behind.
    if (options.crashAfterPages !== undefined && pagesProcessed >= options.crashAfterPages) {
      await saveCheckpoint(db, {
        targetId,
        kind: FOLLOWER_CHECKPOINT_KIND,
        jobId: job.id,
        ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
        page: pagesProcessed,
        progress: { cursor: pageCursor, page: pagesProcessed, usernames: [...seen] },
      });
      throw new JobExecutionError(
        `Simulated interruption after page ${pagesProcessed}`,
        { retryable: true, kind: "INTERRUPTED" },
      );
    }

    await saveCheckpoint(db, {
      targetId,
      kind: FOLLOWER_CHECKPOINT_KIND,
      jobId: job.id,
      ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
      page: pagesProcessed,
      progress: { cursor: pageCursor, page: pagesProcessed, usernames: [...seen] },
    });

    if (pageComplete || pageCursor === undefined || pageCursor === "") {
      break;
    }
    cursor = pageCursor;
  }

  // One coherent snapshot for the whole scan, evidence-linked at insert time.
  if (entries.length === 0 && pageIndex === 0) {
    await recordCapabilityFailure(db, {
      source,
      capability: "getFollowers",
      reason: "Provider returned no follower entries",
      errorCategory: "EMPTY",
    });
    throw new JobExecutionError("Provider returned no follower entries", {
      retryable: true,
      kind: "EMPTY",
    });
  }

  // Derived follow deltas vs the PREVIOUS snapshot — must be read before the
  // new snapshot is inserted, otherwise "latest" is the snapshot we just wrote.
  const previous = await latestFollowSnapshot(db, targetId, direction);

  const observedAt = new Date().toISOString();
  const observationId = `followers:${targetId}@${observedAt}`;
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
    { direction, completion: "COMPLETE" },
  );

  const result = await recordFollowSnapshot(db, {
    targetId,
    direction,
    source,
    evidence,
    page: {
      entries,
      complete: true,
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
    kind: FOLLOWER_CHECKPOINT_KIND,
    page: 0,
    progress: { page: 0, usernames: [] },
  });

  await recordCapabilitySuccess(db, {
    source,
    capability: "getFollowers",
  });

  return "succeeded";
}


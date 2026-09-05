// Per-target synchronization state (§24/25-feed): one honest label derived
// from target status plus the latest scan job, never from vibes. Freshness
// uses the latest successful completion; the threshold is a named product
// decision, not a provider claim.

export const SYNC_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type SyncState =
  | "PAUSED"
  | "SYNCING"
  | "FAILED"
  | "UNAVAILABLE"
  | "PARTIAL"
  | "SYNCED"
  | "STALE";

export interface SyncStateInput {
  status: string;
  latestJobStatus: string | null;
  latestJobOutcome: string | null;
  latestJobCompletedAt: Date | null;
  lastObserved: Date | null;
  now?: Date;
}

export interface SyncStateResult {
  state: SyncState;
  detail: string;
}

export function targetSyncState(input: SyncStateInput): SyncStateResult {
  const now = input.now ?? new Date();
  if (input.status === "PAUSED" || input.status === "STOPPED") {
    return {
      state: "PAUSED",
      detail: "Monitoring paused — scheduled scans stay queued out and history is preserved.",
    };
  }
  if (
    input.latestJobStatus === "queued" ||
    input.latestJobStatus === "running" ||
    input.latestJobStatus === "retry_wait"
  ) {
    return {
      state: "SYNCING",
      detail: "An observation is queued or running — current state refreshes when it completes.",
    };
  }
  if (input.latestJobStatus === "failed") {
    return {
      state: "FAILED",
      detail: "The latest scan failed — previous valid snapshots are preserved, nothing was overwritten.",
    };
  }
  if (input.latestJobOutcome === "UNAVAILABLE") {
    return {
      state: "UNAVAILABLE",
      detail: "The source cannot answer the latest scan — shown as unavailable, never zero.",
    };
  }
  if (input.latestJobOutcome === "COMPLETED_PARTIAL") {
    return {
      state: "PARTIAL",
      detail: "Latest scan observed part of the listing — the next scan resumes from the checkpoint.",
    };
  }
  const reference =
    input.latestJobCompletedAt ?? input.lastObserved ?? null;
  if (reference === null) {
    return {
      state: "STALE",
      detail: "No successful synchronization recorded yet — the initial observation is still pending.",
    };
  }
  if (now.getTime() - reference.getTime() > SYNC_FRESHNESS_MS) {
    return {
      state: "STALE",
      detail: "No successful synchronization in the last 24 hours — data shown may be outdated.",
    };
  }
  return {
    state: "SYNCED",
    detail: "Synchronized within the last 24 hours.",
  };
}

export function syncTone(state: SyncState): "success" | "warning" | "muted" | "danger" | "info" {
  switch (state) {
    case "SYNCED":
      return "success";
    case "SYNCING":
      return "info";
    case "PARTIAL":
    case "STALE":
    case "PAUSED":
      return "warning";
    case "UNAVAILABLE":
      return "muted";
    case "FAILED":
      return "danger";
  }
}

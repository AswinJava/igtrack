import { pgEnum } from "drizzle-orm/pg-core";

export const targetStatusEnum = pgEnum("target_status", [
  "ACTIVE",
  "PAUSED",
  "STOPPED",
]);

export const followDirectionEnum = pgEnum("follow_direction", [
  "FOLLOWERS",
  "FOLLOWING",
]);

export const snapshotCompletenessEnum = pgEnum("snapshot_completeness", [
  "COMPLETE",
  "PARTIAL",
]);

export const followChangeEnum = pgEnum("follow_change", [
  "NEW_FOLLOWING",
  "LOST_FOLLOWING",
  "NEW_FOLLOWER",
  "LOST_FOLLOWER",
]);

export const interactionKindEnum = pgEnum("interaction_kind", [
  "COMMENT",
  "REPLY",
  "MENTION",
  "TAG",
  "LIKE_SIGNAL",
]);

export const observationCategoryEnum = pgEnum("observation_category", [
  "OBSERVED",
  "DERIVED",
  "INFERRED",
  "UNAVAILABLE",
]);

export const confidenceLevelEnum = pgEnum("confidence_level", [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
]);

export const mentionVisibilityEnum = pgEnum("mention_visibility", [
  "VISIBLE",
  "POSSIBLY_HIDDEN",
  "OFF_CANVAS",
  "METADATA_ONLY",
  "UNKNOWN",
]);

export const mediaTypeEnum = pgEnum("media_type", ["IMAGE", "VIDEO", "CAROUSEL", "UNKNOWN"]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "cancelled",
]);

// Diagnostics-only outcome dimension (Phase 6 D4). Failures stay in
// `status`/`error`; outcome records HOW a job concluded:
// COMPLETED (real observations), COMPLETED_EMPTY (AVAILABLE + zero),
// COMPLETED_PARTIAL (provider PARTIAL, preserved), UNAVAILABLE,
// SKIPPED_PAUSED / SKIPPED_STOPPED (target not ACTIVE at execution).
export const jobOutcomeEnum = pgEnum("job_outcome", [
  "COMPLETED",
  "COMPLETED_EMPTY",
  "COMPLETED_PARTIAL",
  "UNAVAILABLE",
  "SKIPPED_PAUSED",
  "SKIPPED_STOPPED",
]);

export const sourceHealthStatusEnum = pgEnum("source_health_status", [
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
]);

export const sourceKindEnum = pgEnum("source_kind", [
  "FIXTURE",
  "IMPORT",
  "GRAPH_API",
  "USER_PROVIDED",
]);

export const retentionStateEnum = pgEnum("retention_state", [
  "RETAINED",
  "PENDING_DELETION",
  "DELETED",
]);

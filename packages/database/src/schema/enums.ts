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

// How a target is observed (FOUNDING §15, D47). OWNED means the operator's own
// account, read through the owned-account edges. DISCOVERY means another public
// professional account, read through the documented Business Discovery edge —
// operator-named, never traversal-derived, and never a place to hang an owned
// scan kind that cannot succeed there.
export const observationModeEnum = pgEnum("observation_mode", [
  "OWNED",
  "DISCOVERY",
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

// Phase G (D54): how a post's presence in an owned account's media listing
// changed between observations. PRESENT/ABSENT is current state (mutable);
// NO_LONGER_OBSERVED is the event row written when a COMPLETE listing no
// longer contains a post — never phrased as "deleted" (D55).
export const postPresenceStateEnum = pgEnum("post_presence_state", [
  "PRESENT",
  "ABSENT",
]);

export const postChangeKindEnum = pgEnum("post_change_kind", [
  "CAPTION_EDITED",
  "NO_LONGER_OBSERVED",
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

// FOUNDING §18 (D67): how a claim's value was obtained, and whether the
// operator has retracted it. There is deliberately no PLATFORM kind — a
// platform read is an observation in the evidence ledger, never a claim.
export const claimSourceKindEnum = pgEnum("claim_source_kind", ["OPERATOR", "WEB"]);

export const claimStatusEnum = pgEnum("claim_status", ["ACTIVE", "RETRACTED"]);

// FOUNDING 19 (D69): autonomous public-web research runs. A run is the
// record of WHAT THE ENGINE TRIED and what came of it — including refusals
// and failures, which are findings, not noise.
export const researchRunStatusEnum = pgEnum("research_run_status", [
  "COMPLETED",
  "COMPLETED_PARTIAL",
  "FAILED",
]);

export const researchDocumentOutcomeEnum = pgEnum("research_document_outcome", [
  "FETCHED",
  "REUSED",
  "FAILED",
  "BLOCKED_BY_POLICY",
  "BLOCKED_BY_ROBOTS",
  "UNSAFE_URL",
  "BLOCKED_CONTENT_TYPE",
  "TOO_LARGE",
  "TIMEOUT",
  "NOT_FOUND",
  "RATE_LIMITED",
  "NETWORK_ERROR",
]);

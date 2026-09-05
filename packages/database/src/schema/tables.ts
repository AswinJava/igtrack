import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  confidenceLevelEnum,
  followChangeEnum,
  followDirectionEnum,
  interactionKindEnum,
  jobOutcomeEnum,
  jobStatusEnum,
  mediaTypeEnum,
  mentionVisibilityEnum,
  observationCategoryEnum,
  retentionStateEnum,
  snapshotCompletenessEnum,
  sourceHealthStatusEnum,
  sourceKindEnum,
  targetStatusEnum,
} from "./enums.js";

const uuid = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  // scrypt$salt$hash; null means credential login is disabled for this account
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the opaque session token; raw token never stored
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);


export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  kind: sourceKindEnum("kind").notNull(),
  name: text("name").notNull(),
  providerVersion: text("provider_version"),
  createdAt: createdAt(),
});

export const igAccounts = pgTable(
  "ig_accounts",
  {
    id: uuid(),
    igId: text("ig_id"),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull().unique(),
    displayName: text("display_name"),
    // Privacy/verification are UNKNOWN (nullable) until an explicit observation
    // states otherwise. Absence of information must never be written as false.
    isPrivate: boolean("is_private"),
    isVerified: boolean("is_verified"),
    accountType: text("account_type"),
    profilePicUrl: text("profile_pic_url"),
    bio: text("bio"),
    externalUrl: text("external_url"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("ig_accounts_ig_id_unique_idx")
      .on(table.igId)
      .where(sql`${table.igId} IS NOT NULL`),
  ],
);

export const targets = pgTable(
  "targets",
  {
    id: uuid(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    localName: text("local_name"),
    notes: text("notes"),
    tags: text("tags").array().notNull().default([]),
    status: targetStatusEnum("status").notNull().default("ACTIVE"),
    // Per-target scan cadence multiplier applied to every global per-kind
    // interval (NULL = default 1x). Validated 0.25–8 on write; NULL keeps the
    // deployment defaults so existing targets are unaffected.
    scanCadenceMult: real("scan_cadence_mult"),
    // Explicit subset of schedulable scan kinds for this target
    // (NULL = all kinds). Empty arrays are normalized to NULL on write —
    // "no scans at all" is expressed with PAUSED, not with an empty set.
    scanKinds: text("scan_kinds").array(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("targets_user_account_unique_idx").on(table.userId, table.igAccountId),
    index("targets_user_idx").on(table.userId),
    index("targets_status_created_idx").on(table.status, table.createdAt, table.id),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid(),
    observationKind: text("observation_kind").notNull(),
    observationId: text("observation_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    sourceReference: text("source_reference"),
    providerVersion: text("provider_version"),
    schemaVersion: text("schema_version"),
    observedAt: timestamptz("observed_at").notNull(),
    capturedAt: timestamptz("captured_at").notNull(),
    confidence: confidenceLevelEnum("confidence").notNull(),
    rawHash: text("raw_hash"),
    normalizedHash: text("normalized_hash"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("evidence_observation_unique_idx").on(
      table.observationKind,
      table.observationId,
    ),
    index("evidence_source_idx").on(table.sourceId),
    index("evidence_observed_idx").on(table.observedAt),
    check("evidence_raw_hash_length_chk", sql`char_length(${table.rawHash}) = 64`),
  ],
);

export const profileSnapshots = pgTable(
  "profile_snapshots",
  {
    id: uuid(),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    observedAt: timestamptz("observed_at").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    username: text("username").notNull(),
    displayName: text("display_name"),
    bio: text("bio"),
    profilePicUrl: text("profile_pic_url"),
    externalUrl: text("external_url"),
    followerCount: integer("follower_count"),
    followingCount: integer("following_count"),
    postCount: integer("post_count"),
    isVerified: boolean("is_verified"),
    // Privacy at observation time; NULL means the provider did not expose it
    // for this snapshot (never defaulted to false).
    isPrivate: boolean("is_private"),
    category: observationCategoryEnum("category").notNull().default("OBSERVED"),
    confidence: confidenceLevelEnum("confidence").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("profile_snapshots_idempotency_idx").on(
      table.igAccountId,
      table.sourceId,
      table.observedAt,
    ),
    index("profile_snapshots_account_time_idx").on(
      table.igAccountId,
      table.observedAt,
    ),
  ],
);

export const profileChanges = pgTable(
  "profile_changes",
  {
    id: uuid(),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    fromSnapshotId: text("from_snapshot_id").references(() => profileSnapshots.id, {
      onDelete: "set null",
    }),
    toSnapshotId: text("to_snapshot_id")
      .notNull()
      .references(() => profileSnapshots.id, { onDelete: "cascade" }),
    detectedAt: timestamptz("detected_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("profile_changes_idempotency_idx").on(
      table.igAccountId,
      table.field,
      table.toSnapshotId,
    ),
    index("profile_changes_account_time_idx").on(table.igAccountId, table.detectedAt),
  ],
);

export const stories = pgTable(
  "stories",
  {
    id: uuid(),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    storyId: text("story_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    observedAt: timestamptz("observed_at").notNull(),
    takenAt: timestamptz("taken_at").notNull(),
    expiresAt: timestamptz("expires_at"),
    mediaType: mediaTypeEnum("media_type").notNull(),
    durationMs: integer("duration_ms"),
    caption: text("caption"),
    hasLink: boolean("has_link").notNull().default(false),
    // The provider-supplied link target when hasLink is true; null when the
    // provider exposes no URL (graph) or none was attached. Rendered only as
    // a user-initiated outbound link, never fetched server-side.
    linkUrl: text("link_url"),
    stickerKinds: text("sticker_kinds").array().notNull().default([]),
    poll: jsonb("poll"),
    question: jsonb("question"),
    location: jsonb("location"),
    music: jsonb("music"),
    category: observationCategoryEnum("category").notNull().default("OBSERVED"),
    confidence: confidenceLevelEnum("confidence").notNull(),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("stories_idempotency_idx").on(
      table.igAccountId,
      table.storyId,
      table.sourceId,
    ),
    index("stories_account_taken_idx").on(table.igAccountId, table.takenAt),
  ],
);

export const storyMentions = pgTable(
  "story_mentions",
  {
    id: uuid(),
    storyDbId: text("story_db_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    mentionedAccountId: text("mentioned_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    positionX: real("position_x"),
    positionY: real("position_y"),
    width: real("width"),
    height: real("height"),
    rawVisibilityFlag: boolean("raw_visibility_flag"),
    visibilityClass: mentionVisibilityEnum("visibility_class").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    confidence: confidenceLevelEnum("confidence").notNull(),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("story_mentions_idempotency_idx").on(
      table.storyDbId,
      table.mentionedAccountId,
    ),
    index("story_mentions_account_idx").on(table.mentionedAccountId),
  ],
);

// Append-only re-observation log for stories. The stories row itself is
// immutable (no-UPDATE trigger) and records FIRST observation only; every
// subsequent scan that still sees the story appends a sighting here. This
// answers "how long was it observable" and "when last seen" without ever
// rewriting history. Sightings are keyed (story, observed_at) so retried or
// reclaimed scans collapse instead of duplicating.
export const storySightings = pgTable(
  "story_sightings",
  {
    id: uuid(),
    storyDbId: text("story_db_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    observedAt: timestamptz("observed_at").notNull(),
    jobId: text("job_id").references(() => monitoringJobs.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("story_sightings_story_observed_idx").on(
      table.storyDbId,
      table.observedAt,
    ),
    index("story_sightings_observed_idx").on(table.observedAt),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    postId: text("post_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    observedAt: timestamptz("observed_at").notNull(),
    takenAt: timestamptz("taken_at").notNull(),
    caption: text("caption"),
    shortcode: text("shortcode"),
    // Full provider-supplied permalink (post URL) when the provider exposes
    // one. Rendered only as a user-initiated outbound link behind an
    // http(s) guard — never fetched server-side (SSRF) or auto-loaded
    // (no third-party IP leak).
    permalink: text("permalink"),
    likeCount: integer("like_count"),
    commentCount: integer("comment_count"),
    // Provider-declared media typing (IMAGE/VIDEO/CAROUSEL) and raw product
    // classifier (FEED/REELS/...) — null when the provider did not declare it.
    mediaType: text("media_type"),
    mediaProductType: text("media_product_type"),
    // Per-post comment observation state: OBSERVED (comment source read, even
    // when empty), UNAVAILABLE (no exposed comment source), NOT_SCANNED
    // (comments capability off). NULL = recorded before state tracking.
    commentsState: text("comments_state"),
    category: observationCategoryEnum("category").notNull().default("OBSERVED"),
    confidence: confidenceLevelEnum("confidence").notNull(),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("posts_idempotency_idx").on(
      table.igAccountId,
      table.postId,
      table.sourceId,
    ),
    index("posts_target_taken_idx").on(table.targetId, table.takenAt),
  ],
);

export const postComments = pgTable(  "post_comments",
  {
    id: uuid(),
    postDbId: text("post_db_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorAccountId: text("author_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    commentId: text("comment_id").notNull(),
    body: text("body").notNull(),
    commentedAt: timestamptz("commented_at").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    confidence: confidenceLevelEnum("confidence").notNull(),
    // Provider-supplied like count on the comment; null when the provider
    // omits it (owner hid counts, no permission). Never zero-filled: null is
    // "not exposed", 0 is "exposed as zero".
    likeCount: integer("like_count"),
    // Source-scoped id of the parent comment when the provider exposes reply
    // threading; null when flat or unexposed.
    inReplyToCommentId: text("in_reply_to_comment_id"),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("post_comments_idempotency_idx").on(
      table.postDbId,
      table.commentId,
    ),
    index("post_comments_author_idx").on(table.authorAccountId),
  ],
);

// Album items of carousel posts, in provider order. Written only from
// provider-returned children (never inferred); a CAROUSEL post without rows
// here means children were unavailable or not retrieved, never "single
// item". Covered by the parent post's evidence; cascade deletes with it.
export const postChildren = pgTable(
  "post_children",
  {
    id: uuid(),
    postDbId: text("post_db_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    childMediaId: text("child_media_id").notNull(),
    mediaType: text("media_type"),
    shortcode: text("shortcode"),
    permalink: text("permalink"),
    takenAt: timestamptz("taken_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("post_children_post_child_idx").on(
      table.postDbId,
      table.childMediaId,
    ),
    index("post_children_post_idx").on(table.postDbId),
  ],
);

export const followSnapshots = pgTable(
  "follow_snapshots",
  {
    id: uuid(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    direction: followDirectionEnum("direction").notNull(),
    takenAt: timestamptz("taken_at").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    completeness: snapshotCompletenessEnum("completeness").notNull(),
    totalObserved: integer("total_observed").notNull().default(0),
    cursorState: text("cursor_state"),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("follow_snapshots_idempotency_idx").on(
      table.targetId,
      table.direction,
      table.takenAt,
      table.sourceId,
    ),
    index("follow_snapshots_target_time_idx").on(
      table.targetId,
      table.direction,
      table.takenAt,
    ),
  ],
);

export const followSnapshotMembers = pgTable(
  "follow_snapshot_members",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => followSnapshots.id, { onDelete: "cascade" }),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.igAccountId] }),
    index("follow_snapshot_members_account_idx").on(table.igAccountId),
  ],
);

export const followDeltas = pgTable(
  "follow_deltas",
  {
    id: uuid(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    direction: followDirectionEnum("direction").notNull(),
    change: followChangeEnum("change").notNull(),
    igAccountId: text("ig_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    fromSnapshotId: text("from_snapshot_id").references(() => followSnapshots.id, {
      onDelete: "set null",
    }),
    toSnapshotId: text("to_snapshot_id")
      .notNull()
      .references(() => followSnapshots.id, { onDelete: "cascade" }),
    confidence: confidenceLevelEnum("confidence").notNull().default("HIGH"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("follow_deltas_idempotency_idx").on(
      table.targetId,
      table.direction,
      table.change,
      table.igAccountId,
      table.toSnapshotId,
    ),
    index("follow_deltas_target_seen_idx").on(
      table.targetId,
      table.direction,
      table.firstSeenAt,
    ),
  ],
);

// Intentionally reserved, writerless by decision (not dead architecture):
// no supported provider exposes a lawful public likes/activity feed, so
// fabricating rows would violate the no-fake-data rule. The table stays so a
// future lawful interaction source has a typed landing zone; an emptiness
// test pins the dormant state. Delete paths and evidence readers already
// handle it, so activation needs only a writer + UI.
export const interactions = pgTable(
  "interactions",
  {
    id: uuid(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    actorAccountId: text("actor_account_id")
      .notNull()
      .references(() => igAccounts.id, { onDelete: "restrict" }),
    kind: interactionKindEnum("kind").notNull(),
    postRef: text("post_ref"),
    externalRef: text("external_ref"),
    observedAt: timestamptz("observed_at").notNull(),
    textMeta: text("text_meta"),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    category: observationCategoryEnum("category").notNull().default("OBSERVED"),
    confidence: confidenceLevelEnum("confidence").notNull(),
    evidenceId: text("evidence_id").references(() => evidence.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("interactions_external_ref_unique_idx")
      .on(table.sourceId, table.externalRef)
      .where(sql`${table.externalRef} IS NOT NULL`),
    index("interactions_target_time_idx").on(table.targetId, table.observedAt),
    index("interactions_actor_idx").on(table.actorAccountId),
  ],
);

// Intentionally reserved, writerless by decision (not dead architecture):
// archiving media BYTES requires settled answers on URL expiry, download
// permission, and storage policy that no current provider supplies (neither
// fixture nor graph yields archivable asset URLs today). Media METADATA
// (types, shortcodes, permalinks, link URLs) is persisted on posts/stories
// instead. Do not store bytes here until a provider legitimizes the source;
// do not store credentials or tokens in any media URL.
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid(),
    contentHash: text("content_hash").notNull().unique(),
    storageKey: text("storage_key").notNull(),
    mediaType: mediaTypeEnum("media_type").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "restrict",
    }),
    retentionState: retentionStateEnum("retention_state")
      .notNull()
      .default("RETAINED"),
    createdAt: createdAt(),
  },
  (table) => [index("media_assets_retention_idx").on(table.retentionState)],
);

export const monitoringJobs = pgTable(
  "monitoring_jobs",
  {
    id: uuid(),
    kind: text("kind").notNull(),
    targetId: text("target_id").references(() => targets.id, {
      onDelete: "cascade",
    }),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").notNull().default({}),
    priority: integer("priority").notNull().default(0),
    status: jobStatusEnum("status").notNull().default("queued"),
    outcome: jobOutcomeEnum("outcome"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamptz("available_at").notNull().defaultNow(),
    lockedAt: timestamptz("locked_at"),
    lockedBy: text("locked_by"),
    startedAt: timestamptz("started_at"),
    completedAt: timestamptz("completed_at"),
    error: jsonb("error"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("monitoring_jobs_idempotency_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("monitoring_jobs_claimable_idx")
      .on(table.status, table.availableAt)
      .where(sql`${table.status} IN ('queued', 'retry_wait')`),
    index("monitoring_jobs_target_idx").on(table.targetId),
    check("monitoring_jobs_attempts_chk", sql`${table.attempts} >= 0`),
    check("monitoring_jobs_max_attempts_chk", sql`${table.maxAttempts} > 0`),
  ],
);

export const jobCheckpoints = pgTable(
  "job_checkpoints",
  {
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    jobId: text("job_id").references(() => monitoringJobs.id, {
      onDelete: "set null",
    }),
    cursor: text("cursor"),
    page: integer("page").notNull().default(0),
    progress: jsonb("progress"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.targetId, table.kind] }),
    index("job_checkpoints_job_idx").on(table.jobId),
  ],
);

// PC-T2 staging: acquired follow-scan members are appended here durably, one
// row per member, instead of rewriting a growing JSONB array every page. The
// checkpoint keeps only cursor/page. Unique (job_id, username_lower) makes
// duplicate pages and reclaim re-execution idempotent; ordering by `id`
// preserves first-acquisition order; foreign-job rows are cleared at scan
// start and own rows at completion (or cascade with the target).
export const followScanStaging = pgTable(
  "follow_scan_staging",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => monitoringJobs.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull(),
    igId: text("ig_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("follow_scan_staging_job_username_idx").on(
      table.jobId,
      table.usernameLower,
    ),
    index("follow_scan_staging_target_idx").on(table.targetId),
  ],
);

export const schedulerState = pgTable("scheduler_state", {
  // Single-row singleton ("default"). Multiple scheduler instances converge
  // on this row; it carries diagnostics truth, not scheduling decisions.
  id: text("id").primaryKey(),
  lastTickAt: timestamptz("last_tick_at"),
  lastSuccessAt: timestamptz("last_success_at"),
  lastError: jsonb("last_error"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const sourceHealth = pgTable(
  "source_health",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    status: sourceHealthStatusEnum("status").notNull(),
    lastSuccessAt: timestamptz("last_success_at"),
    lastFailureAt: timestamptz("last_failure_at"),
    lastFailureReason: text("last_failure_reason"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    errorCategory: text("error_category"),
    latencyMs: integer("latency_ms"),
    coverageNote: text("coverage_note"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.capability] })],
);

// Append-only operational counters per provider capability: request volume,
// outcomes, and last latency. Written best-effort by the worker's provider
// call wrapper; never on the correctness path. Powers the diagnostics
// capability section and any future alerting. Secrets never touch this table.
export const capabilityMetrics = pgTable(
  "capability_metrics",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    totalRequests: integer("total_requests").notNull().default(0),
    totalOk: integer("total_ok").notNull().default(0),
    totalErrors: integer("total_errors").notNull().default(0),
    totalTimeouts: integer("total_timeouts").notNull().default(0),
    totalRateLimited: integer("total_rate_limited").notNull().default(0),
    lastLatencyMs: integer("last_latency_ms"),
    lastObservedAt: timestamptz("last_observed_at"),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.capability] })],
);

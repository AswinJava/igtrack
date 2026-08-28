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
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("targets_user_account_unique_idx").on(table.userId, table.igAccountId),
    index("targets_user_idx").on(table.userId),
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
  (table) => [primaryKey({ columns: [table.targetId, table.kind] })],
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
    jobId: text("job_id").notNull(),
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

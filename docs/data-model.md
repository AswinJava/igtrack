# IGTrack — Data Model

Principles:

1. **Append-only observations.** Never overwrite history; current state is a
   derived view. `following_count = 100 today / 87 yesterday` stores both.
2. **Normalized entities + snapshot/delta rows.** No giant duplicated JSON blobs.
3. **Every important row has provenance** (evidence link, source, timestamps).
4. **Category + confidence on everything user-visible.**

## Entities

### App domain

- **User** — app account: id, email, password_hash, created_at.
- **Target** — monitoring target: id, user_id, ig_account_id, local_name,
  notes, tags[], status (ACTIVE/PAUSED/STOPPED), created_at.

### Instagram domain (canonical registry)

- **IgAccount** — one row per known Instagram account: id, ig_id (platform id
  when known, nullable), username, username_lower (unique), display_name,
  is_private, is_verified (both nullable: UNKNOWN until an observation
  explicitly states them — absence never writes false), account_type,
  profile_pic_url, bio, external_url, first_seen_at, last_seen_at.
  Current-state cache only; history lives in snapshots.

### Observations (append-only)

- **ProfileSnapshot** — id, ig_account_id, observed_at, source_id, evidence_id,
  username, display_name, bio, profile_pic_url, follower_count?,
  following_count?, post_count?, is_verified?, external_url?, category=OBSERVED,
  confidence.
- **ProfileChange** (DERIVED) — id, ig_account_id, field, old_value, new_value,
  detected_at, from_snapshot_id, to_snapshot_id.
- **Story** — id, ig_account_id, story_id (source-scoped), observed_at,
  expires_at?, media_type, duration_ms?, caption?, has_link?, sticker_kinds[],
  poll/question/location/music metadata (nullable columns or typed JSONB),
  source_id, evidence_id, category, confidence. Unique on (ig_account_id,
  story_id, source_id).
- **StoryMention** — id, story_id, mentioned_account_id, position_x?,
  position_y?, width?, height?, raw_visibility_flag?, visibility_class
  (VISIBLE | POSSIBLY_HIDDEN | OFF_CANVAS | METADATA_ONLY | UNKNOWN),
  evidence_id, category, confidence.
- **FollowSnapshot** — id, target_id, direction (FOLLOWERS | FOLLOWING),
  taken_at, source_id, completeness (COMPLETE | PARTIAL), cursor_state?,
  total_observed, evidence_id.
- **FollowSnapshotMember** — snapshot_id, ig_account_id. (Normalized; indexed.)
- **FollowDelta** (DERIVED) — id, target_id, direction, change
  (NEW_FOLLOWING | LOST_FOLLOWING | NEW_FOLLOWER | LOST_FOLLOWER),
  ig_account_id, first_seen_at, from_snapshot_id, to_snapshot_id, confidence.
- **Interaction** — id, target_id, actor_account_id, kind
  (COMMENT | REPLY | MENTION | TAG | LIKE_SIGNAL), post_ref?, observed_at,
  text_meta?, source_id, evidence_id, category, confidence.
- **TimelineEvent** (DERIVED) — id, target_id, type (PROFILE_CHANGED,
  STORY_POSTED, STORY_EXPIRED, MENTION_OBSERVED, FOLLOWING_ADDED,
  FOLLOWING_REMOVED, FOLLOWER_ADDED, FOLLOWER_REMOVED, COMMENT_OBSERVED,
  INTERACTION_OBSERVED), occurred_at, ref_kind, ref_id, summary.

### Intelligence (INFERRED)

- **RelationshipScore** — id, target_id, other_account_id, score, computed_at,
  window_start, window_end, params_version, signals JSONB (per-signal
  contributions), evidence_refs[]. Unique on (target_id, other_account_id,
  computed_at).
- **RelationshipSignal** — contributing rows: target_id, other_account_id,
  signal_kind (MENTION | COMMENT | FOLLOW | MUTUAL_FOLLOW | RECIPROCITY |
  RECURRENCE | PERSISTENCE), weight, count, last_observed_at, evidence_refs[].

### Provenance

- **Evidence** — id, observation_kind, observation_id, source_type,
  source_reference, observed_at, captured_at, confidence, raw_hash (sha256 of
  the raw source payload; NULL when no raw representation exists — never faked
  from normalized data), normalized_hash (sha256 of normalized form),
  raw_payload_ref (storage key; raw payloads retained only where appropriate).
- **Source** — id, kind (FIXTURE | IMPORT | GRAPH_API | ...), name, config_ref.
- **SourceHealth** — source_id, capability, status (HEALTHY | DEGRADED |
  UNAVAILABLE), last_success_at, last_failure_at, last_failure_reason,
  coverage_note, updated_at.

### Media

- **MediaAsset** — id, content_hash (unique, dedup), storage_key, bytes,
  mime_type, checksum, captured_at, source_id. Stories reference assets by
  content hash.

### Operations

- **MonitoringJob** — id, kind, target_id?, idempotency_key (unique), state
  (QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED), attempts, max_attempts,
  next_run_at, started_at?, finished_at?, checkpoint JSONB, error?,
  locked_by?, locked_at? (lease: stale running jobs are reclaimable after
  `IGTRACK_JOB_LEASE_MS`, default 5 min; exhausted-attempt stragglers are
  reaped to FAILED; same-kind same-target jobs never run concurrently).
- **JobRun** (audit) — job_id, attempt, started_at, finished_at, outcome,
  duration_ms, log_ref.

### Notifications (post-MVP)

- **AlertRule** — id, user_id, target_id?, event_type, channel, config JSONB,
  enabled.
- **Notification** — id, user_id, rule_id?, event_ref, channel, state
  (PENDING | SENT | FAILED), sent_at?.

## Indexing strategy (Postgres)

- observations: `(target/ig_account_id, observed_at DESC)`
- timeline_events: `(target_id, occurred_at DESC)` + type filter
- follow_snapshot_members: `(snapshot_id)`, `(ig_account_id)`
- follow_deltas: `(target_id, direction, first_seen_at DESC)`
- relationship_scores: `(target_id, score DESC)` latest-per-pair queries
- evidence lookups: `(observation_kind, observation_id)`
- ig_accounts: unique `username_lower`; GIN on JSONB metadata where used

## Confidence framework

| Level | Meaning |
|---|---|
| HIGH | directly observed from a supported source |
| MEDIUM | derived from multiple reliable observations |
| LOW | partial observation or incomplete source |
| UNKNOWN | cannot determine |

## Phase 2 implementation notes

- **Append-only enforcement:** Postgres `BEFORE UPDATE` trigger `igtrack_reject_update()` on `evidence`, `profile_snapshots`, `profile_changes`, `stories`, `story_mentions`, `follow_snapshots`, `follow_snapshot_members`, `follow_deltas`, `interactions`. The trigger rejects any UPDATE; DELETE remains permitted for lawful retention/target-cascade cleanup. The trigger lives in migration `0000_...sql`; it is outside drizzle's snapshot (drizzle cannot model triggers) and is re-checked by `schema.test.ts`.
- **Evidence linkage:** `evidence.observation_id` stores the database row id of the observation; the observation row stores `evidence_id` FK. On re-ingestion the repository checks existence first (by natural unique — `(ig_account_id, story_id, source_id)` etc.) and returns `deduplicated` without inserting duplicate evidence/observation rows.
- **Follow model:** normalized `ig_accounts` + `follow_snapshot_members` (PK `(snapshot_id, ig_account_id)`); diff computation stays in `packages/core/diff/follow-diff.ts` and is persisted as `follow_deltas`; the DB never reimplements the algorithm.
- **Media:** `media_assets` holds metadata only (`content_hash` unique for dedup, `storage_key`, bytes, checksum); binaries are not stored in Postgres.

## Retention & deletion

Deleting a target (`deleteTargetWithObservations`) atomically removes: `profile_snapshots`, `profile_changes`, `stories` (cascade `story_mentions`), `interactions`, `follow_snapshots` (cascade members), `follow_deltas`, related `evidence`, and the `targets` row. `ig_accounts` rows are retained as a shared registry. `evidence` for `story_mentions` is collected before the cascade.

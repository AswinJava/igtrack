import { sql, eq, type SQL } from "drizzle-orm";
import type { Database } from "../client/client.js";
import { getSourceHealth, type SourceHealthRecord } from "./source-health.js";
import { getOwnedTarget, type TargetRecord } from "./targets.js";
import type { AccountRecord } from "./accounts.js";
import { igAccounts, profileSnapshots } from "../schema/index.js";
import {
  listProfileSnapshots,
  listProfileChanges,
} from "./observations.js";
import { listStories, listMentionsForStoryWithAccount, sightingSummariesForAccount } from "./stories.js";
import { listPosts, listCommentsForPostWithAccount, listChildrenForPost } from "./posts.js";
import { listTaggedMedia } from "./tagged-media.js";
import {
  latestFollowSnapshot,
  listMembersForSnapshot,
  listRecentDeltas,
  type DeltaWithAccount,
} from "./follows.js";

const int = (v: unknown): number => Number(v);

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

// drizzle's execute() returns loosely-typed row objects; this centralises the
// one legitimate cast per query so call sites keep real types.
async function query<T>(db: Database, q: SQL): Promise<T[]> {
  const res = await db.execute(q);
  return Array.from(res) as T[];
}

// ---------------------------------------------------------------------------
// Targets list — single-query replacement for the Phase 3 per-row loop (N+1).
// Semantics preserved: current/latest profile observation per target,
// absent when no snapshot exists yet.
// ---------------------------------------------------------------------------

export interface TargetListRow {
  id: string;
  username: string;
  display_name: string | null;
  status: string;
  observation_mode: string | null;
  tags: string[] | null;
  local_name: string | null;
  is_private: boolean | null;
  is_verified: boolean | null;
  last_observed: Date | string | null;
  follower_count: number | null;
  following_count: number | null;
  snapshot_source: string | null;
  job_status: string | null;
  job_outcome: string | null;
  job_completed_at: Date | string | null;
  job_available_at: Date | string | null;
}

export interface TargetListItem {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
  /** OWNED = this deployment's own account; DISCOVERY = another public account via the documented route (D47). */
  observationMode: "OWNED" | "DISCOVERY";
  tags: string[];
  localName: string | null;
  isPrivate: boolean | null;
  isVerified: boolean | null;
  followerCount: number | null;
  followingCount: number | null;
  lastObserved: Date | null;
  // Source of the latest profile snapshot. Null when no snapshot exists yet.
  // Rendered per-card so fixture data is unmistakable at list level too.
  snapshotSourceId: string | null;
  // Latest scan job for sync-state display. Nulls mean no job has ever been
  // recorded for this target (freshly created, worker hasn't picked it up).
  latestJobStatus: string | null;
  latestJobOutcome: string | null;
  latestJobCompletedAt: Date | null;
  latestJobAvailableAt: Date | null;
}

export async function listTargetsForUser(
  db: Database,
  userId: string,
): Promise<TargetListItem[]> {
  const rows = await query<TargetListRow>(db, sql`
    SELECT t.id,
           ia.username,
           ia.display_name,
           t.status::text AS status,
           t.observation_mode::text AS observation_mode,
           t.tags,
           t.local_name,
           ia.is_private,
           ia.is_verified,
           ps.observed_at AS last_observed,
           ps.follower_count,
           ps.following_count,
           ps.snapshot_source,
           j.status::text AS job_status,
           j.outcome::text AS job_outcome,
           j.completed_at AS job_completed_at,
           j.available_at AS job_available_at
    FROM targets t
    JOIN ig_accounts ia ON ia.id = t.ig_account_id
    LEFT JOIN LATERAL (
      SELECT s.observed_at, s.follower_count, s.following_count, s.source_id AS snapshot_source
      FROM profile_snapshots s
      WHERE s.ig_account_id = t.ig_account_id
      ORDER BY s.observed_at DESC
      LIMIT 1
    ) ps ON TRUE
    LEFT JOIN LATERAL (
      SELECT j2.status, j2.outcome, j2.completed_at, j2.available_at
      FROM monitoring_jobs j2
      WHERE j2.target_id = t.id
      ORDER BY j2.created_at DESC
      LIMIT 1
    ) j ON TRUE
    WHERE t.user_id = ${userId}
    ORDER BY t.created_at DESC
  `);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    status: r.status,
    observationMode: r.observation_mode === "DISCOVERY" ? "DISCOVERY" : "OWNED",
    tags: r.tags ?? [],
    localName: r.local_name,
    isPrivate: r.is_private,
    isVerified: r.is_verified,
    followerCount: r.follower_count === null ? null : Number(r.follower_count),
    followingCount: r.following_count === null ? null : Number(r.following_count),
    lastObserved: r.last_observed === null ? null : asDate(r.last_observed),
    snapshotSourceId: r.snapshot_source,
    latestJobStatus: r.job_status,
    latestJobOutcome: r.job_outcome,
    latestJobCompletedAt: r.job_completed_at === null ? null : asDate(r.job_completed_at),
    latestJobAvailableAt: r.job_available_at === null ? null : asDate(r.job_available_at),
  }));
}

// ---------------------------------------------------------------------------
// Dashboard (scoped to the authenticated user's targets)
// ---------------------------------------------------------------------------

interface ScopedCountsRow {
  tracked: number;
  snapshots: number;
  deltas: number;
  stories: number;
}

async function scopedCounts(db: Database, userId: string): Promise<ScopedCountsRow> {
  const rows = await query<ScopedCountsRow>(db, sql`
    SELECT
      (SELECT count(*)::int FROM targets WHERE user_id = ${userId}) AS tracked,
      (SELECT count(*)::int FROM profile_snapshots ps
        WHERE EXISTS (SELECT 1 FROM targets t
          WHERE t.user_id = ${userId} AND t.ig_account_id = ps.ig_account_id)) AS snapshots,
      (SELECT count(*)::int FROM follow_deltas fd
        WHERE EXISTS (SELECT 1 FROM targets t
          WHERE t.user_id = ${userId} AND t.id = fd.target_id)) AS deltas,
      (SELECT count(*)::int FROM stories s
        WHERE EXISTS (SELECT 1 FROM targets t
          WHERE t.user_id = ${userId} AND t.ig_account_id = s.ig_account_id)) AS stories
  `);
  const r = rows[0];
  return {
    tracked: r ? int(r.tracked) : 0,
    snapshots: r ? int(r.snapshots) : 0,
    deltas: r ? int(r.deltas) : 0,
    stories: r ? int(r.stories) : 0,
  };
}

interface QueueCountRow {
  status: string;
  count: number;
}

async function queueCounts(db: Database): Promise<Record<string, number>> {
  try {
    const rows = await query<QueueCountRow>(db, sql`
      SELECT status::text AS status, count(*)::int AS count
      FROM monitoring_jobs GROUP BY status
    `);
    return Object.fromEntries(rows.map((r) => [r.status, int(r.count)]));
  } catch {
    return {};
  }
}

export interface ActivityItem {
  id: string;
  type: string;
  summary: string;
  timestamp: Date;
  targetUsername: string;
  // Epistemic class of the underlying observation: follow/profile diffs are
  // DERIVED (snapshot comparisons), story sightings are OBSERVED events.
  // Confidence is the originating observation's persisted confidence:
  // profile changes inherit their to-snapshot's confidence, follow deltas
  // carry their own persisted confidence, stories carry theirs, and media
  // changes (Phase G) carry the confidence of the observation that read the
  // difference. Nothing here is assigned or invented.
  category: string | null;
  confidence: string | null;
  // Evidence row id backing this event, so every feed item links to
  // provenance. Joined from the originating observation's evidence_id.
  evidenceId: string | null;
}

export const ACTIVITY_TYPES = [
  "PROFILE_CHANGED",
  "NEW_FOLLOWER",
  "LOST_FOLLOWER",
  "NEW_FOLLOWING",
  "LOST_FOLLOWING",
  "STORY_POSTED",
  "STORY_EXPIRED",
  "POST_PUBLISHED",
  // Phase G (FOUNDING §16): media changes. POST_REMOVED reads "no longer
  // observed in a complete listing" — never "deleted" (D55).
  "POST_EDITED",
  "POST_REMOVED",
  "COMMENT_POSTED",
  "MENTION_OBSERVED",
  // FOUNDING §17: first observation of a row in the documented tags edge. The
  // row is insert-once, so the feed item means "first observed in the tag
  // listing", never "tagged you just now".
  "TAG_OBSERVED",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityFeedOptions {
  types?: ActivityType[];
  // Case-insensitive substring match against username and summary.
  query?: string;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function getUserActivityFeed(
  db: Database,
  userId: string,
  limit = 30,
  options: ActivityFeedOptions = {},
): Promise<ActivityItem[]> {
  const types =
    options.types !== undefined && options.types.length > 0
      ? options.types.filter((t): t is ActivityType =>
          (ACTIVITY_TYPES as readonly string[]).includes(t),
        )
      : null;
  const rawQuery = options.query?.trim().slice(0, 100) ?? "";
  const like =
    rawQuery.length > 0 ? `%${escapeLikePattern(rawQuery)}%` : null;
  const rows = await query<{
    id: string;
    type: string;
    summary: string;
    occurred_at: Date | string;
    username: string;
    category: string | null;
    confidence: string | null;
    evidence_id: string | null;
  }>(
    db,
    sql`
    SELECT * FROM (
    (SELECT pc.id::text AS id, 'PROFILE_CHANGED'::text AS type,
            ia.username || ' — ' || pc.field || ' changed' AS summary,
            pc.detected_at AS occurred_at, ia.username,
            'DERIVED'::text AS category, ps.confidence::text AS confidence,
            ps.evidence_id AS evidence_id
     FROM profile_changes pc
     JOIN ig_accounts ia ON ia.id = pc.ig_account_id
     JOIN profile_snapshots ps ON ps.id = pc.to_snapshot_id
     WHERE EXISTS (SELECT 1 FROM targets t
       WHERE t.user_id = ${userId} AND t.ig_account_id = pc.ig_account_id)
     ORDER BY pc.detected_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT fd.id::text AS id, fd.change::text AS type,
            ia.username || ' — ' || lower(replace(fd.change::text, '_', ' ')) AS summary,
            fd.first_seen_at AS occurred_at, ia.username,
            'DERIVED'::text AS category, fd.confidence::text AS confidence,
            fs.evidence_id AS evidence_id
     FROM follow_deltas fd
     JOIN ig_accounts ia ON ia.id = fd.ig_account_id
     JOIN targets t ON t.id = fd.target_id
     JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
     WHERE t.user_id = ${userId}
     ORDER BY fd.first_seen_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT s.id::text AS id, 'STORY_POSTED'::text AS type,
            ia.username || ' — story observed' AS summary,
            s.taken_at AS occurred_at, ia.username,
            'OBSERVED'::text AS category, s.confidence::text AS confidence,
            s.evidence_id AS evidence_id
     FROM stories s
     JOIN ig_accounts ia ON ia.id = s.ig_account_id
     WHERE EXISTS (SELECT 1 FROM targets t
       WHERE t.user_id = ${userId} AND t.ig_account_id = s.ig_account_id)
     ORDER BY s.taken_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT s.id::text AS id, 'STORY_EXPIRED'::text AS type,
            ia.username || ' — story expired' AS summary,
            s.expires_at AS occurred_at, ia.username,
            'DERIVED'::text AS category, s.confidence::text AS confidence,
            s.evidence_id AS evidence_id
     FROM stories s
     JOIN ig_accounts ia ON ia.id = s.ig_account_id
     WHERE s.expires_at IS NOT NULL AND s.expires_at < now()
       AND EXISTS (SELECT 1 FROM targets t
       WHERE t.user_id = ${userId} AND t.ig_account_id = s.ig_account_id)
     ORDER BY s.expires_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT p.id::text AS id, 'POST_PUBLISHED'::text AS type,
            ia.username || ' — post observed' AS summary,
            p.taken_at AS occurred_at, ia.username,
            'OBSERVED'::text AS category, p.confidence::text AS confidence,
            p.evidence_id AS evidence_id
     FROM posts p
     JOIN targets t ON t.id = p.target_id
     JOIN ig_accounts ia ON ia.id = p.ig_account_id
     WHERE t.user_id = ${userId}
     ORDER BY p.taken_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT pch.id::text AS id,
            (CASE pch.change
              WHEN 'CAPTION_EDITED' THEN 'POST_EDITED'
              ELSE 'POST_REMOVED'
            END)::text AS type,
            owner.username || ' — ' ||
            CASE pch.change
              WHEN 'CAPTION_EDITED' THEN 'post caption changed'
              ELSE 'post no longer observed'
            END AS summary,
            pch.detected_at AS occurred_at, owner.username,
            'DERIVED'::text AS category, pch.confidence::text AS confidence,
            pch.evidence_id AS evidence_id
     FROM post_changes pch
     JOIN posts p ON p.id = pch.post_db_id
     JOIN targets t ON t.id = pch.target_id
     JOIN ig_accounts owner ON owner.id = p.ig_account_id
     WHERE t.user_id = ${userId}
     ORDER BY pch.detected_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT pc.id::text AS id, 'COMMENT_POSTED'::text AS type,
            author.username || ' — comment observed' AS summary,
            pc.commented_at AS occurred_at, owner.username,
            'OBSERVED'::text AS category, pc.confidence::text AS confidence,
            pc.evidence_id AS evidence_id
     FROM post_comments pc
     JOIN posts p ON p.id = pc.post_db_id
     JOIN targets t ON t.id = p.target_id
     JOIN ig_accounts author ON author.id = pc.author_account_id
     JOIN ig_accounts owner ON owner.id = p.ig_account_id
     WHERE t.user_id = ${userId}
     ORDER BY pc.commented_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT sm.id::text AS id, 'MENTION_OBSERVED'::text AS type,
            mentioned.username || ' — mentioned by ' || owner.username AS summary,
            sm.observed_at AS occurred_at, owner.username,
            'OBSERVED'::text AS category, sm.confidence::text AS confidence,
            COALESCE(sm.evidence_id, s.evidence_id) AS evidence_id
     FROM story_mentions sm
     JOIN stories s ON s.id = sm.story_db_id
     JOIN ig_accounts mentioned ON mentioned.id = sm.mentioned_account_id
     JOIN ig_accounts owner ON owner.id = s.ig_account_id
     WHERE EXISTS (SELECT 1 FROM targets t
       WHERE t.user_id = ${userId} AND t.ig_account_id = s.ig_account_id)
     ORDER BY sm.observed_at DESC LIMIT ${limit})
    UNION ALL
    (SELECT tm.id::text AS id, 'TAG_OBSERVED'::text AS type,
            owner.username || ' — tagged media by ' || COALESCE(tm.owner_username, 'an unknown account') AS summary,
            tm.observed_at AS occurred_at, owner.username,
            'OBSERVED'::text AS category, tm.confidence::text AS confidence,
            tm.evidence_id AS evidence_id
     FROM tagged_media tm
     JOIN ig_accounts owner ON owner.id = tm.ig_account_id
     WHERE EXISTS (SELECT 1 FROM targets t
       WHERE t.user_id = ${userId} AND t.ig_account_id = tm.ig_account_id)
     ORDER BY tm.observed_at DESC LIMIT ${limit})
    ) AS feed
    ${types !== null || like !== null
      ? sql`WHERE ${sql.join(
          [
            ...(types !== null
              ? [sql`feed.type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})`]
              : []),
            ...(like !== null
              ? [sql`(feed.username ILIKE ${like} OR feed.summary ILIKE ${like})`]
              : []),
          ],
          sql` AND `,
        )}`
      : sql``}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    summary: r.summary,
    timestamp: asDate(r.occurred_at),
    targetUsername: r.username,
    category: r.category,
    confidence: r.confidence,
    evidenceId: r.evidence_id,
  }));
}

export interface DashboardOverview {
  trackedCount: number;
  recentSnapshots: number;
  followChanges: number;
  storiesObserved: number;
  recentActivity: ActivityItem[];
  sourceHealth: SourceHealthRecord[];
  queue: {
    queued: number;
    running: number;
    retryWait: number;
    failed: number;
  };
}

export async function getDashboardOverview(
  db: Database,
  userId: string,
): Promise<DashboardOverview> {
  const [counts, activity, health, q] = await Promise.all([
    scopedCounts(db, userId),
    getUserActivityFeed(db, userId, 8),
    getSourceHealth(db).catch(() => [] as SourceHealthRecord[]),
    queueCounts(db),
  ]);
  return {
    trackedCount: counts.tracked,
    recentSnapshots: counts.snapshots,
    followChanges: counts.deltas,
    storiesObserved: counts.stories,
    recentActivity: activity,
    sourceHealth: health,
    queue: {
      queued: q.queued ?? 0,
      running: q.running ?? 0,
      retryWait: q.retry_wait ?? 0,
      failed: q.failed ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Target detail bundle (ownership-verified)
// ---------------------------------------------------------------------------

export interface FollowRoster {
  usernames: string[];
  totalObserved: number;
}

export interface TargetDetailBundle {
  target: NonNullable<Awaited<ReturnType<typeof getOwnedTarget>>>;
  account: typeof igAccounts.$inferSelect;
  snapshots: (typeof profileSnapshots.$inferSelect)[];
  changes: Awaited<ReturnType<typeof listProfileChanges>>;
  health: SourceHealthRecord[];
  stories: Awaited<ReturnType<typeof listStories>>;
  storyMentions: Array<{ storyId: string; mentions: Awaited<ReturnType<typeof listMentionsForStoryWithAccount>> }>;
  // Per-story observation lifetimes (first/last seen, sighting count),
  // keyed by stories.id. Absent keys mean a single observation so far.
  storySightings: Record<string, { count: number; firstSeenAt: Date | null; lastSeenAt: Date | null }>;
  posts: Awaited<ReturnType<typeof listPosts>>;
  postComments: Array<{ postId: string; comments: Awaited<ReturnType<typeof listCommentsForPostWithAccount>> }>;
  postChildren: Array<{ postId: string; children: Awaited<ReturnType<typeof listChildrenForPost>> }>;
  followFollowers: Awaited<ReturnType<typeof latestFollowSnapshot>>;
  followFollowing: Awaited<ReturnType<typeof latestFollowSnapshot>>;
  // Auditable member rosters for the latest snapshots (bounded at 50 each;
  // null when no snapshot exists yet). Lets the UI show WHO is in a
  // snapshot, not just the count.
  followFollowerRoster: FollowRoster | null;
  followFollowingRoster: FollowRoster | null;
  /** Media by other accounts in which this account is tagged (the tags edge). */
  taggedMedia: Awaited<ReturnType<typeof listTaggedMedia>>;
  deltas: DeltaWithAccount[];
  jobs: JobQueueSummary[];
}

export async function getOwnedTargetDetail(
  db: Database,
  userId: string,
  targetId: string,
): Promise<TargetDetailBundle | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;

  const accountRows = await db
    .select()
    .from(igAccounts)
    .where(eq(igAccounts.id, owned.igAccountId))
    .limit(1);
  const account = accountRows[0];
  if (account === undefined) return null;

  const [snapshots, changes, health, storiesList, postsList, followFollowers, followFollowing, deltas, jobs, sightings, taggedMediaRows] =
    await Promise.all([
      listProfileSnapshots(db, account.id, { limit: 20 }).catch(() => []),
      listProfileChanges(db, account.id, { limit: 20 }).catch(() => []),
      getSourceHealth(db).catch(() => []),
      listStories(db, account.id, { limit: 10 }).catch(() => []),
      listPosts(db, owned.id, { limit: 10 }).catch(() => []),
      latestFollowSnapshot(db, owned.id, "FOLLOWERS").catch(() => null),
      latestFollowSnapshot(db, owned.id, "FOLLOWING").catch(() => null),
      listRecentDeltas(db, owned.id, { limit: 20 }).catch(() => []),
      listJobsForTarget(db, owned.id, 8).catch(() => []),
      sightingSummariesForAccount(db, account.id).catch(() => ({})),
      listTaggedMedia(db, account.id, 50).catch(() => []),
    ]);

  const storyMentions: TargetDetailBundle["storyMentions"] = [];
  const mentionResults = await Promise.all(
    storiesList.slice(0, 3).map(async (s) => ({
      storyId: s.storyId,
      mentions: await listMentionsForStoryWithAccount(db, s.id).catch(() => []),
    })),
  );
  storyMentions.push(...mentionResults);

  const postComments: TargetDetailBundle["postComments"] = [];
  const commentResults = await Promise.all(
    postsList.slice(0, 5).map(async (p) => ({
      postId: p.postId,
      comments: await listCommentsForPostWithAccount(db, p.id).catch(() => []),
    })),
  );
  postComments.push(...commentResults);

  const postChildren: TargetDetailBundle["postChildren"] = [];
  const childrenResults = await Promise.all(
    postsList.slice(0, 5).map(async (p) => ({
      postId: p.postId,
      children: await listChildrenForPost(db, p.id).catch(() => []),
    })),
  );
  postChildren.push(...childrenResults);

  const [followerRosterRows, followingRosterRows] = await Promise.all([
    followFollowers !== null
      ? listMembersForSnapshot(db, followFollowers.id, 50).catch(() => [])
      : Promise.resolve([]),
    followFollowing !== null
      ? listMembersForSnapshot(db, followFollowing.id, 50).catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    target: owned,
    account,
    snapshots,
    changes,
    health,
    stories: storiesList,
    storyMentions,
    storySightings: sightings,
    posts: postsList,
    postComments,
    postChildren,
    followFollowers,
    followFollowing,
    followFollowerRoster:
      followFollowers === null
        ? null
        : {
            usernames: followerRosterRows.map((r) => r.username),
            totalObserved: followFollowers.totalObserved,
          },
    followFollowingRoster:
      followFollowing === null
        ? null
        : {
            usernames: followingRosterRows.map((r) => r.username),
            totalObserved: followFollowing.totalObserved,
          },
    taggedMedia: taggedMediaRows,
    deltas,
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Relationships ranking (ownership-verified; signals counted from
// evidence-linked observations only)
// ---------------------------------------------------------------------------

export interface RelationshipRank {
  username: string;
  score: number;
  // Observed signal counts only (D43): story mentions, comment authorship on
  // owned media, follow deltas. A signal a scan never observed stays 0 here —
  // this is a count of stored rows, not an inferred affinity.
  signals: { mentions: number; comments: number; deltas: number };
  /**
   * The same counts restricted to the recency window (D51). A count, not a
   * decayed score: how many stored rows are recent, never a denoised guess.
   */
  signalsWithinWindow: { mentions: number; comments: number; deltas: number };
  confidence: string;
  // Structural relationship state, derived from the latest COMPLETE-agnostic
  // snapshots (membership is a fact about the latest observation, not a
  // claim about exact follow times — see follow_deltas for event wording).
  mutual: boolean;
  currentlyObserved: boolean;
  // First observation evidence: "delta" pins it to a change event,
  // "snapshot" means present since the earliest snapshot on record (weaker).
  firstSeenAt: string | null;
  firstSeenBasis: "delta" | "snapshot" | null;
  // Latest snapshot in which the account was a member; null when no longer
  // observed (never fabricate a departure timestamp).
  lastSeenAt: string | null;
  /**
   * Timestamp of the most recent stored signal (mention, comment, or delta).
   * Null means no signal was ever observed — not "a long time ago".
   */
  lastSignalAt: string | null;
  /**
   * The stored rows behind the counts, newest first and bounded. Every rank
   * can be traced to observations; a rank with no evidence rows is a
   * structural membership fact, and says so by being empty.
   */
  evidence: RelationshipEvidenceRow[];
}

export interface RelationshipEvidenceRow {
  kind: "mention" | "comment" | "delta";
  observedAt: string;
  /** Evidence ledger id backing the row (null when the observation stored none). */
  evidenceId: string | null;
  /** Stable reference inside the kind: story_db_id / post_db_id / change name. */
  reference: string;
}

/**
 * Signal weights and the recency window, in one place: the ranking code and
 * the method block a caller renders must describe the same arithmetic (D51).
 * A mention is a public act naming the account (12), a comment is a direct
 * interaction on owned media (10), a follow delta is a structural change (8).
 * The weights order observed counts; they never invent one.
 */
export const RELATIONSHIP_SIGNAL_WEIGHTS = {
  mention: 12,
  comment: 10,
  delta: 8,
} as const;

export const RELATIONSHIP_RECENCY_WINDOW_DAYS = 30;

/**
 * Evidence classes, split by what they are evidence OF.
 *
 * A live observation is evidence about a person. A synthetic one is evidence
 * about a fixture. The two are never blended into one ranking: a synthetic
 * interaction can never move a live score, and a live deployment never shows
 * a demo rank as if it were a relationship.
 *
 * The split is by SOURCE CLASS, not by a hard-coded exclusion, so a
 * synthetic deployment still renders its own relationships — clearly
 * labelled — instead of going silently empty. An empty live ranking beside a
 * populated synthetic one is a readable finding; a single blended ranking is
 * not.
 */
export const RELATIONSHIP_LIVE_SOURCE_KINDS = ["GRAPH_API", "IMPORT", "USER_PROVIDED"] as const;
export const RELATIONSHIP_SYNTHETIC_SOURCE_KINDS = ["FIXTURE"] as const;

/** SQL: a row's source belongs to one of the given evidence classes. */
function sourceKindFilter(sourceKinds: readonly string[]): SQL {
  return sql`src.kind IN (${sql.join(
    sourceKinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

/** SQL: a snapshot's source belongs to one of the given evidence classes. */
function snapshotSourceKindFilter(sourceKinds: readonly string[]): SQL {
  return sql`source_id IN (SELECT id FROM sources WHERE kind IN (${sql.join(
    sourceKinds.map((kind) => sql`${kind}`),
    sql`, `,
  )}))`;
}

const EVIDENCE_PER_ACCOUNT = 3;

export interface RelationshipRanking {
  ranks: RelationshipRank[];
  /** The evidence classes this ranking was computed over. Never blended. */
  sourceKinds: readonly string[];
}

/**
 * The relationship ranking for one target, computed over ONE evidence class
 * at a time.
 *
 * `sourceKinds` is a required argument on purpose. A caller states which
 * class of evidence the ranking is about, and the query can only ever mix
 * rows from that class — so a synthetic interaction is structurally unable to
 * reach a live ranking, and a live one is structurally unable to borrow a
 * demo row. The caller renders the two classes separately (see
 * `opRelationships`), because one blended ranking would be the lie.
 */
export async function getRelationshipsForUser(
  db: Database,
  userId: string,
  targetId: string,
  sourceKinds: readonly string[],
): Promise<RelationshipRanking> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) {
    return { ranks: [], sourceKinds };
  }
  const kindFilter = sourceKindFilter(sourceKinds);
  const snapshotKindFilter = snapshotSourceKindFilter(sourceKinds);

  const [deltas, mentionRows, commentRows, deltaRows, evidenceRows] = await Promise.all([
    listRecentDeltas(db, owned.id, {
      limit: 50,
      sourceKinds,
    }).catch(
      () => [] as DeltaWithAccount[],
    ),
    query<{ username: string; count: number; count_window: number; last_at: Date | string }>(
      db,
      sql`
        SELECT ia.username,
               count(DISTINCT sm.story_db_id)::int AS count,
               count(DISTINCT sm.story_db_id) FILTER (
                 WHERE s.observed_at >= now() - (${RELATIONSHIP_RECENCY_WINDOW_DAYS} || ' days')::interval
               )::int AS count_window,
               max(s.observed_at) AS last_at
        FROM story_mentions sm
        JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
        JOIN stories s ON s.id = sm.story_db_id
        JOIN sources src ON src.id = s.source_id
        WHERE s.ig_account_id = ${owned.igAccountId} AND ${kindFilter}
        GROUP BY ia.username
        ORDER BY count DESC
      `,
    ).catch(() => [] as Array<{ username: string; count: number; count_window: number; last_at: Date | string; synthetic_count: number }>),
    // Comment authorship on the owned account's media (D43). The owner's own
    // comments are excluded — talking on your own post is not a relationship
    // signal. Readable lawfully only because these comments live on media the
    // operator owns.
    query<{ username: string; count: number; count_window: number; last_at: Date | string }>(
      db,
      sql`
        SELECT ia.username,
               count(*)::int AS count,
               count(*) FILTER (
                 WHERE pc.observed_at >= now() - (${RELATIONSHIP_RECENCY_WINDOW_DAYS} || ' days')::interval
               )::int AS count_window,
               max(pc.observed_at) AS last_at
        FROM post_comments pc
        JOIN posts p ON p.id = pc.post_db_id
        JOIN ig_accounts ia ON ia.id = pc.author_account_id
        JOIN sources src ON src.id = p.source_id
        WHERE p.ig_account_id = ${owned.igAccountId}
          AND pc.author_account_id <> ${owned.igAccountId}
          AND ${kindFilter}
        GROUP BY ia.username
        ORDER BY count DESC
      `,
    ).catch(() => [] as Array<{ username: string; count: number; count_window: number; last_at: Date | string }>),
    // Delta aggregates in one pass (not the capped event list): a 30-day count
    // and the newest change timestamp per account. The delta inherits its
    // source from the snapshot it was derived into, so the class is read
    // through that snapshot.
    query<{ username: string; count: number; count_window: number; last_at: Date | string }>(
      db,
      sql`
        SELECT ia.username,
               count(*)::int AS count,
               count(*) FILTER (
                 WHERE fd.first_seen_at >= now() - (${RELATIONSHIP_RECENCY_WINDOW_DAYS} || ' days')::interval
               )::int AS count_window,
               max(fd.first_seen_at) AS last_at
        FROM follow_deltas fd
        JOIN ig_accounts ia ON ia.id = fd.ig_account_id
        JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
        JOIN sources src ON src.id = fs.source_id
        WHERE fd.target_id = ${owned.id} AND ${kindFilter}
        GROUP BY ia.username
      `,
    ).catch(() => [] as Array<{ username: string; count: number; count_window: number; last_at: Date | string }>),
    // Per-account evidence rows: the stored observations behind the counts,
    // newest first, bounded per account inside the database (no N+1).
    query<{
      username: string;
      kind: string;
      observed_at: Date | string;
      evidence_id: string | null;
      reference: string;
    }>(
      db,
      sql`
        SELECT username, kind, observed_at, evidence_id, reference FROM (
          SELECT ia.username, 'mention'::text AS kind, s.observed_at,
                 sm.evidence_id, sm.story_db_id AS reference,
                 row_number() OVER (PARTITION BY ia.username ORDER BY s.observed_at DESC) AS rn
          FROM story_mentions sm
          JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
          JOIN stories s ON s.id = sm.story_db_id
          JOIN sources src ON src.id = s.source_id
          WHERE s.ig_account_id = ${owned.igAccountId} AND ${kindFilter}
        ) m WHERE rn <= ${EVIDENCE_PER_ACCOUNT}
        UNION ALL
        SELECT username, kind, observed_at, evidence_id, reference FROM (
          SELECT ia.username, 'comment'::text AS kind, pc.observed_at,
                 pc.evidence_id, pc.post_db_id AS reference,
                 row_number() OVER (PARTITION BY ia.username ORDER BY pc.observed_at DESC) AS rn
          FROM post_comments pc
          JOIN posts p ON p.id = pc.post_db_id
          JOIN ig_accounts ia ON ia.id = pc.author_account_id
          JOIN sources src ON src.id = p.source_id
          WHERE p.ig_account_id = ${owned.igAccountId}
            AND pc.author_account_id <> ${owned.igAccountId}
            AND ${kindFilter}
        ) c WHERE rn <= ${EVIDENCE_PER_ACCOUNT}
        UNION ALL
        SELECT username, kind, observed_at, evidence_id, reference FROM (
          SELECT ia.username, 'delta'::text AS kind, fd.first_seen_at AS observed_at,
                 NULL::text AS evidence_id, fd.change::text AS reference,
                 row_number() OVER (PARTITION BY ia.username ORDER BY fd.first_seen_at DESC) AS rn
          FROM follow_deltas fd
          JOIN ig_accounts ia ON ia.id = fd.ig_account_id
          JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
          JOIN sources src ON src.id = fs.source_id
          WHERE fd.target_id = ${owned.id} AND ${kindFilter}
        ) d WHERE rn <= ${EVIDENCE_PER_ACCOUNT}
        ORDER BY observed_at DESC
      `,
    ).catch(() => [] as Array<{
      username: string;
      kind: string;
      observed_at: Date | string;
      evidence_id: string | null;
      reference: string;
    }>),
  ]);

  const map = new Map<
    string,
    {
      mentions: number;
      comments: number;
      deltas: number;
      window: { mentions: number; comments: number; deltas: number };
      lastSignalAt: string | null;
      evidence: RelationshipEvidenceRow[];
    }
  >();
  const bucket = (username: string) => {
    let cur = map.get(username);
    if (cur === undefined) {
      cur = {
        mentions: 0,
        comments: 0,
        deltas: 0,
        window: { mentions: 0, comments: 0, deltas: 0 },
        lastSignalAt: null,
        evidence: [],
      };
      map.set(username, cur);
    }
    return cur;
  };
  const newer = (a: string | null, b: string): string =>
    a === null || b > a ? b : a;
  for (const m of mentionRows) {
    const cur = bucket(m.username);
    cur.mentions += int(m.count);
    cur.window.mentions += int(m.count_window);
    cur.lastSignalAt = newer(cur.lastSignalAt, asDate(m.last_at).toISOString());
  }
  for (const c of commentRows) {
    const cur = bucket(c.username);
    cur.comments += int(c.count);
    cur.window.comments += int(c.count_window);
    cur.lastSignalAt = newer(cur.lastSignalAt, asDate(c.last_at).toISOString());
  }
  for (const d of deltas) {
    // Kept for the event list the caller renders; the aggregates above are
    // the counts, so this pass only guarantees the account has a rank row.
    bucket(d.username);
  }
  for (const d of deltaRows) {
    const cur = bucket(d.username);
    cur.deltas += int(d.count);
    cur.window.deltas += int(d.count_window);
    cur.lastSignalAt = newer(cur.lastSignalAt, asDate(d.last_at).toISOString());
  }
  for (const e of evidenceRows) {
    const cur = bucket(e.username);
    if (cur.evidence.length >= EVIDENCE_PER_ACCOUNT) continue;
    cur.evidence.push({
      kind: e.kind as RelationshipEvidenceRow["kind"],
      observedAt: asDate(e.observed_at).toISOString(),
      evidenceId: e.evidence_id,
      reference: e.reference,
    });
  }

  // Stable members: accounts present in BOTH the earliest and latest
  // snapshot of a direction have an observed relationship duration even with
  // zero signal events (no mentions, no deltas — nothing ever changed). They
  // rank last with honest weak provenance instead of being invisible.
  // Bounded per direction; ranking stays signal-ordered.
  const STABLE_MEMBER_CAP = 100;
  const stableRows = await query<{ username: string }>(
    db,
    sql`(SELECT ia.username FROM follow_snapshot_members m
         JOIN follow_snapshot_members m0 ON m0.ig_account_id = m.ig_account_id
         JOIN ig_accounts ia ON ia.id = m.ig_account_id
         WHERE m.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS' AND ${snapshotKindFilter}
           ORDER BY taken_at DESC LIMIT 1)
           AND m0.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS' AND ${snapshotKindFilter}
           ORDER BY taken_at ASC LIMIT 1)
           AND m.snapshot_id <> m0.snapshot_id
         LIMIT ${STABLE_MEMBER_CAP})
        UNION
        (SELECT ia.username FROM follow_snapshot_members m
         JOIN follow_snapshot_members m0 ON m0.ig_account_id = m.ig_account_id
         JOIN ig_accounts ia ON ia.id = m.ig_account_id
         WHERE m.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWING' AND ${snapshotKindFilter}
           ORDER BY taken_at DESC LIMIT 1)
           AND m0.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWING' AND ${snapshotKindFilter}
           ORDER BY taken_at ASC LIMIT 1)
           AND m.snapshot_id <> m0.snapshot_id
         LIMIT ${STABLE_MEMBER_CAP})`,
  ).catch(() => [] as Array<{ username: string }>);
  for (const row of stableRows) {
    if (!map.has(row.username)) {
      bucket(row.username);
    }
  }

  // Ranking: observed counts ordered by the shared weights (D43/D51). Recency
  // is carried alongside (lastSignalAt + a 30-day count), never folded into
  // the score — a decay constant would be an invented number, and this product
  // does not invent numbers.
  const ranked = [...map.entries()]
    .map(([username, v]) => ({
      username,
      score:
        v.mentions * RELATIONSHIP_SIGNAL_WEIGHTS.mention +
        v.comments * RELATIONSHIP_SIGNAL_WEIGHTS.comment +
        v.deltas * RELATIONSHIP_SIGNAL_WEIGHTS.delta,
      signals: { mentions: v.mentions, comments: v.comments, deltas: v.deltas },
      signalsWithinWindow: v.window,
      lastSignalAt: v.lastSignalAt,
      evidence: v.evidence,
      confidence:
        v.mentions + v.comments + v.deltas > 2
          ? "MEDIUM"
          : v.mentions + v.comments + v.deltas > 0
            ? "LOW"
            : "UNKNOWN",
    }))
    // Ties are broken by recency, then name — the order is deterministic and
    // every position is explained by a stored count or a stored timestamp.
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? "") ||
        a.username.localeCompare(b.username),
    );

  const [latestFollowers, latestFollowing, earliestTaken, firstSeenRows] = await Promise.all([
    latestFollowSnapshot(db, owned.id, "FOLLOWERS", { sourceKinds }).catch(() => null),
    latestFollowSnapshot(db, owned.id, "FOLLOWING", { sourceKinds }).catch(() => null),
    query<{ direction: string; earliest: Date | string }>(
      db,
      sql`SELECT direction::text AS direction, min(taken_at) AS earliest
           FROM follow_snapshots
           WHERE target_id = ${owned.id} AND ${snapshotKindFilter}
           GROUP BY direction`,
    ).catch(() => [] as Array<{ direction: string; earliest: Date | string }>),
    ranked.length === 0
      ? Promise.resolve([])
      : query<{ username: string; first_seen: Date | string }>(
          db,
          sql`SELECT ia.username, min(fd.first_seen_at) AS first_seen
               FROM follow_deltas fd
               JOIN ig_accounts ia ON ia.id = fd.ig_account_id
               JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
               JOIN sources src ON src.id = fs.source_id
               WHERE fd.target_id = ${owned.id}
                 AND ${kindFilter}
                 AND ia.username IN (${sql.join(
                   ranked.map((r) => sql`${r.username}`),
                   sql`, `,
                 )})
               GROUP BY ia.username`,
        ).catch(() => [] as Array<{ username: string; first_seen: Date | string }>),
  ]);
  const firstSeenByUser = new Map(
    firstSeenRows.map((r) => [r.username, asDate(r.first_seen).toISOString()] as const),
  );
  const earliestByDirection = new Map(
    earliestTaken.map((r) => [r.direction, asDate(r.earliest).toISOString()] as const),
  );
  const earliestOverall =
    [...earliestByDirection.values()].sort()[0] ?? null;

  async function isMember(
    snapshotId: string | null,
    username: string,
  ): Promise<boolean> {
    if (snapshotId === null) return false;
    const rows = await query<{ one: number }>(
      db,
      sql`SELECT 1 AS one FROM follow_snapshot_members fsm
           JOIN ig_accounts ia ON ia.id = fsm.ig_account_id
           WHERE fsm.snapshot_id = ${snapshotId} AND ia.username = ${username}
           LIMIT 1`,
    ).catch(() => [] as Array<{ one: number }>);
    return rows.length > 0;
  }

  const enriched = [];
  for (const r of ranked) {
    const [inFollowers, inFollowing] = await Promise.all([
      isMember(latestFollowers?.id ?? null, r.username),
      isMember(latestFollowing?.id ?? null, r.username),
    ]);
    const followerTaken =
      latestFollowers !== null ? asDate(latestFollowers.takenAt).toISOString() : null;
    const followingTaken =
      latestFollowing !== null ? asDate(latestFollowing.takenAt).toISOString() : null;
    const lastSeenAt = inFollowers
      ? followerTaken
      : inFollowing
        ? followingTaken
        : null;
    const deltaFirst = firstSeenByUser.get(r.username) ?? null;
    const observed = inFollowers || inFollowing;
    enriched.push({
      ...r,
      mutual: inFollowers && inFollowing,
      currentlyObserved: observed,
      // Stable members (zero signals, present across snapshots) carry
      // structural evidence: observed presence upgrades vacuous UNKNOWN to
      // LOW, never higher — the ranking stays signal-ordered.
      confidence:
        r.confidence === "UNKNOWN" && observed ? "LOW" : r.confidence,
      firstSeenAt: deltaFirst ?? earliestOverall,
      firstSeenBasis: (deltaFirst !== null ? "delta" : earliestOverall !== null ? "snapshot" : null) as
        | "delta"
        | "snapshot"
        | null,
      lastSeenAt,
    });
  }
  return {
    ranks: enriched,
    sourceKinds,
  };
}

// ---------------------------------------------------------------------------
// Dossier: one target's recorded state read back in a single pass (D50).
//
// A dossier is a REPORT over stored observations, not a new store: every
// number below is a count of rows that exist, and a surface with no rows is
// reported as not observed rather than as empty data. Nothing is inferred
// from another surface, and nothing is zero-filled.
// ---------------------------------------------------------------------------

export interface DossierCount {
  count: number;
  latestAt: Date | null;
}

export interface DossierMediaRow {
  postId: string;
  caption: string | null;
  permalink: string | null;
  /** The platform's publish time (posts.taken_at) — a different fact from when we first saw it. */
  publishedAt: Date | null;
  /** When this deployment first observed the row (posts.observed_at). */
  firstObservedAt: Date | null;
  likeCount: number | null;
  commentCount: number | null;
  /** Provider-supplied reposts_count when the platform returned one; null = not returned (never zero-filled). */
  repostsCount: number | null;
  mediaType: string | null;
  mediaProductType: string | null;
  commentsState: string;
  sourceId: string;
  evidenceId: string | null;
  /** Position inside the provider's bounded preview, when one was declared. */
  previewPosition: number | null;
  previewLimit: number | null;
  previewBounded: boolean | null;
}

export interface DossierMediaSummary {
  storedCount: number;
  /** The route's ceiling on the preview, from the newest row's evidence. Null when the source declared none. */
  previewLimit: number | null;
  previewBounded: boolean | null;
  oldestPublishedAt: Date | null;
  newestPublishedAt: Date | null;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
  rows: DossierMediaRow[];
}

export interface DossierRouteUnavailability {
  sourceId: string;
  capability: string;
  note: string | null;
  updatedAt: Date;
}

export interface TargetDossier {
  target: TargetRecord;
  account: AccountRecord;
  counts: {
    profileSnapshots: DossierCount;
    profileChanges: DossierCount;
    followerSnapshots: DossierCount;
    followingSnapshots: DossierCount;
    followDeltas: DossierCount;
    stories: DossierCount;
    storyMentions: DossierCount;
    storySightings: DossierCount;
    // FOUNDING §17: rows from the documented tags edge (media owned by others
    // in which this account was tagged), first-observation-wins.
    taggedMedia: DossierCount;
    posts: DossierCount;
    postComments: DossierCount;
    postChildren: DossierCount;
    // Phase G: media change events (caption edits, no-longer-observed).
    postChanges: DossierCount;
    // FOUNDING §17: posts that actually carry a provider-supplied reposts
    // count. This is the writer behind the REPOSTS capability: zero such rows
    // means "the platform never returned one", never "no reposts".
    repostsObserved: DossierCount;
    insightPoints: DossierCount;
    interactions: DossierCount;
    // FOUNDING §18: ACTIVE operator/agent-submitted claims (the writer behind
    // the ACCOUNT_RESEARCH capability). Retracted rows stay in the table but
    // are not counted here.
    claims: DossierCount;
    // Bounded public-web research runs (D69). Runs are refused for DISCOVERY
    // targets, so a row always means the operator directed one.
    researchRuns: DossierCount;
  };
  latestProfileSnapshot: Awaited<ReturnType<typeof listProfileSnapshots>>[number] | null;
  media: DossierMediaSummary | null;
  /** Sources that have actually written observations for this target/account. */
  observingSources: string[];
  /** The source classes behind those rows (e.g. ["FIXTURE"]). */
  sourceKinds: string[];
  /**
   * What class of evidence stands behind the stored rows. SYNTHETIC means
   * generated data, LIVE means a real platform route or the operator's own
   * export, MIXED means both are present, NONE means nothing is stored.
   */
  evidenceClass: "LIVE" | "SYNTHETIC" | "MIXED" | "NONE";
  /**
   * Capabilities the routes themselves reported as UNAVAILABLE for those
   * sources, with the reason they gave. Deployment-wide per (source,
   * capability) — the same answer any scan of this account would get.
   */
  routeUnavailability: DossierRouteUnavailability[];
}

const DOSSIER_MEDIA_LIMIT = 25;

export async function getTargetDossier(
  db: Database,
  userId: string,
  targetId: string,
): Promise<TargetDossier | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;

  const accountRows = await db
    .select()
    .from(igAccounts)
    .where(eq(igAccounts.id, owned.igAccountId))
    .limit(1);
  const account = accountRows[0];
  if (account === undefined) return null;

  const [countRows, latestSnapshots, mediaRows, mediaAggRows, sourceRows, healthRows] =
    await Promise.all([
      query<Record<string, number | Date | string | null>>(
        db,
        sql`
          SELECT
            (SELECT count(*)::int FROM profile_snapshots WHERE ig_account_id = ${account.id}) AS profile_snapshots,
            (SELECT max(observed_at) FROM profile_snapshots WHERE ig_account_id = ${account.id}) AS profile_snapshots_at,
            (SELECT count(*)::int FROM profile_changes WHERE ig_account_id = ${account.id}) AS profile_changes,
            (SELECT max(created_at) FROM profile_changes WHERE ig_account_id = ${account.id}) AS profile_changes_at,
            (SELECT count(*)::int FROM follow_snapshots WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS') AS follower_snapshots,
            (SELECT max(taken_at) FROM follow_snapshots WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS') AS follower_snapshots_at,
            (SELECT count(*)::int FROM follow_snapshots WHERE target_id = ${owned.id} AND direction = 'FOLLOWING') AS following_snapshots,
            (SELECT max(taken_at) FROM follow_snapshots WHERE target_id = ${owned.id} AND direction = 'FOLLOWING') AS following_snapshots_at,
            (SELECT count(*)::int FROM follow_deltas WHERE target_id = ${owned.id}) AS follow_deltas,
            (SELECT max(first_seen_at) FROM follow_deltas WHERE target_id = ${owned.id}) AS follow_deltas_at,
            (SELECT count(*)::int FROM stories WHERE ig_account_id = ${account.id}) AS stories,
            (SELECT max(observed_at) FROM stories WHERE ig_account_id = ${account.id}) AS stories_at,
            (SELECT count(*)::int FROM story_mentions sm JOIN stories s ON s.id = sm.story_db_id
              WHERE s.ig_account_id = ${account.id}) AS story_mentions,
            (SELECT max(sm.observed_at) FROM story_mentions sm JOIN stories s ON s.id = sm.story_db_id
              WHERE s.ig_account_id = ${account.id}) AS story_mentions_at,
            (SELECT count(*)::int FROM story_sightings ss JOIN stories s ON s.id = ss.story_db_id
              WHERE s.ig_account_id = ${account.id}) AS story_sightings,
            (SELECT max(ss.observed_at) FROM story_sightings ss JOIN stories s ON s.id = ss.story_db_id
              WHERE s.ig_account_id = ${account.id}) AS story_sightings_at,
            (SELECT count(*)::int FROM tagged_media WHERE ig_account_id = ${account.id}) AS tagged_media,
            (SELECT max(observed_at) FROM tagged_media WHERE ig_account_id = ${account.id}) AS tagged_media_at,
            (SELECT count(*)::int FROM posts WHERE target_id = ${owned.id}) AS posts,
            (SELECT max(observed_at) FROM posts WHERE target_id = ${owned.id}) AS posts_at,
            (SELECT count(*)::int FROM post_comments pc JOIN posts p ON p.id = pc.post_db_id
              WHERE p.target_id = ${owned.id}) AS post_comments,
            (SELECT max(pc.observed_at) FROM post_comments pc JOIN posts p ON p.id = pc.post_db_id
              WHERE p.target_id = ${owned.id}) AS post_comments_at,
            (SELECT count(*)::int FROM post_children ch JOIN posts p ON p.id = ch.post_db_id
              WHERE p.target_id = ${owned.id}) AS post_children,
            (SELECT max(ch.created_at) FROM post_children ch JOIN posts p ON p.id = ch.post_db_id
              WHERE p.target_id = ${owned.id}) AS post_children_at,
            (SELECT count(*)::int FROM post_changes WHERE target_id = ${owned.id}) AS post_changes,
            (SELECT max(detected_at) FROM post_changes WHERE target_id = ${owned.id}) AS post_changes_at,
            (SELECT count(*)::int FROM posts WHERE target_id = ${owned.id} AND reposts_count IS NOT NULL) AS reposts_observed,
            (SELECT max(observed_at) FROM posts WHERE target_id = ${owned.id} AND reposts_count IS NOT NULL) AS reposts_observed_at,
            (SELECT count(*)::int FROM insight_points WHERE ig_account_id = ${account.id}) AS insight_points,
            (SELECT max(observed_at) FROM insight_points WHERE ig_account_id = ${account.id}) AS insight_points_at,
            (SELECT count(*)::int FROM interactions WHERE target_id = ${owned.id}) AS interactions,
            (SELECT max(observed_at) FROM interactions WHERE target_id = ${owned.id}) AS interactions_at,
            (SELECT count(*)::int FROM claims WHERE target_id = ${owned.id} AND status = 'ACTIVE') AS claims,
            (SELECT max(recorded_at) FROM claims WHERE target_id = ${owned.id} AND status = 'ACTIVE') AS claims_at,
            (SELECT count(*)::int FROM research_runs WHERE target_id = ${owned.id}) AS research_runs,
            (SELECT max(started_at) FROM research_runs WHERE target_id = ${owned.id}) AS research_runs_at
        `,
      ),
      listProfileSnapshots(db, account.id, { limit: 1 }).catch(() => []),
      query<{
        post_id: string;
        caption: string | null;
        permalink: string | null;
        taken_at: Date | string | null;
        observed_at: Date | string | null;
        like_count: number | null;
        comment_count: number | null;
        reposts_count: number | null;
        media_type: string | null;
        media_product_type: string | null;
        comments_state: string;
        source_id: string;
        evidence_id: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        db,
        sql`
          SELECT p.post_id, p.caption, p.permalink, p.taken_at, p.observed_at,
                 p.like_count, p.comment_count, p.reposts_count, p.media_type::text AS media_type,
                 p.media_product_type, p.comments_state::text AS comments_state,
                 p.source_id, p.evidence_id, e.metadata
          FROM posts p
          LEFT JOIN evidence e ON e.id = p.evidence_id
          WHERE p.target_id = ${owned.id}
          -- Published-time order is the platform's order for a preview;
          -- observed_at is kept separate so the two never blur.
          ORDER BY p.taken_at DESC NULLS LAST, p.observed_at DESC
          LIMIT ${DOSSIER_MEDIA_LIMIT}
        `,
      ).catch(() => []),
      query<{
        count: number;
        oldest_published: Date | string | null;
        newest_published: Date | string | null;
        first_observed: Date | string | null;
        last_observed: Date | string | null;
      }>(
        db,
        sql`
          SELECT count(*)::int AS count,
                 min(taken_at) AS oldest_published,
                 max(taken_at) AS newest_published,
                 min(observed_at) AS first_observed,
                 max(observed_at) AS last_observed
          FROM posts WHERE target_id = ${owned.id}
        `,
      ).catch(() => []),
      query<{ source_id: string; source_kind: string }>(
        db,
        sql`
          SELECT DISTINCT s.source_id, src.kind::text AS source_kind FROM (
            SELECT source_id FROM profile_snapshots WHERE ig_account_id = ${account.id}
            UNION SELECT source_id FROM stories WHERE ig_account_id = ${account.id}
            UNION SELECT source_id FROM insight_points WHERE ig_account_id = ${account.id}
            UNION SELECT source_id FROM posts WHERE target_id = ${owned.id}
            UNION SELECT source_id FROM follow_snapshots WHERE target_id = ${owned.id}
            UNION SELECT source_id FROM interactions WHERE target_id = ${owned.id}
            UNION SELECT source_id FROM tagged_media WHERE ig_account_id = ${account.id}
          ) s
          JOIN sources src ON src.id = s.source_id
          ORDER BY s.source_id
        `,
      ).catch(() => []),
      getSourceHealth(db).catch(() => [] as SourceHealthRecord[]),
    ]);

  const counts = countRows[0] ?? {};
  const count = (key: string): number => int(counts[key] ?? 0);
  const at = (key: string): Date | null => {
    const v = counts[key];
    return v === null || v === undefined ? null : asDate(v);
  };

  const observingSources = sourceRows.map((r) => r.source_id);
  const sourceKinds = [...new Set(sourceRows.map((r) => r.source_kind))].sort();
  /**
   * What class of evidence stands behind this target's stored rows.
   *
   * "OBSERVED" without this is a lie waiting to be read: 68 insight points
   * from a fixture set are rows, not a reading of the account. SYNTHETIC says
   * the rows came from generated data; LIVE says a real platform route or the
   * operator's own export produced them; MIXED says both are present, and
   * then no single number describes the target.
   */
  const evidenceClass: TargetDossier["evidenceClass"] =
    sourceKinds.length === 0
      ? "NONE"
      : sourceKinds.length > 1
        ? "MIXED"
        : sourceKinds[0] === "FIXTURE"
          ? "SYNTHETIC"
          : "LIVE";
  const mediaAgg = mediaAggRows[0];

  const media: DossierMediaSummary | null =
    mediaAgg === undefined || int(mediaAgg.count) === 0
      ? null
      : {
          storedCount: int(mediaAgg.count),
          previewLimit: readPreviewNumber(mediaRows[0]?.metadata, "previewLimit"),
          previewBounded: readPreviewBoolean(mediaRows[0]?.metadata, "previewBounded"),
          oldestPublishedAt: nullableDate(mediaAgg.oldest_published),
          newestPublishedAt: nullableDate(mediaAgg.newest_published),
          firstObservedAt: nullableDate(mediaAgg.first_observed),
          lastObservedAt: nullableDate(mediaAgg.last_observed),
          rows: mediaRows.map((r) => ({
            postId: r.post_id,
            caption: r.caption,
            permalink: r.permalink,
            publishedAt: nullableDate(r.taken_at),
            firstObservedAt: nullableDate(r.observed_at),
            likeCount: r.like_count === null ? null : int(r.like_count),
            commentCount: r.comment_count === null ? null : int(r.comment_count),
            repostsCount: r.reposts_count === null ? null : int(r.reposts_count),
            mediaType: r.media_type,
            mediaProductType: r.media_product_type,
            commentsState: r.comments_state,
            sourceId: r.source_id,
            evidenceId: r.evidence_id,
            previewPosition: readPreviewNumber(r.metadata, "previewPosition"),
            previewLimit: readPreviewNumber(r.metadata, "previewLimit"),
            previewBounded: readPreviewBoolean(r.metadata, "previewBounded"),
          })),
        };

  return {
    target: owned,
    account,
    counts: {
      profileSnapshots: { count: count("profile_snapshots"), latestAt: at("profile_snapshots_at") },
      profileChanges: { count: count("profile_changes"), latestAt: at("profile_changes_at") },
      followerSnapshots: { count: count("follower_snapshots"), latestAt: at("follower_snapshots_at") },
      followingSnapshots: { count: count("following_snapshots"), latestAt: at("following_snapshots_at") },
      followDeltas: { count: count("follow_deltas"), latestAt: at("follow_deltas_at") },
      stories: { count: count("stories"), latestAt: at("stories_at") },
      storyMentions: { count: count("story_mentions"), latestAt: at("story_mentions_at") },
      storySightings: { count: count("story_sightings"), latestAt: at("story_sightings_at") },
      taggedMedia: { count: count("tagged_media"), latestAt: at("tagged_media_at") },
      posts: { count: count("posts"), latestAt: at("posts_at") },
      postComments: { count: count("post_comments"), latestAt: at("post_comments_at") },
      postChildren: { count: count("post_children"), latestAt: at("post_children_at") },
      postChanges: { count: count("post_changes"), latestAt: at("post_changes_at") },
      repostsObserved: { count: count("reposts_observed"), latestAt: at("reposts_observed_at") },
      insightPoints: { count: count("insight_points"), latestAt: at("insight_points_at") },
      interactions: { count: count("interactions"), latestAt: at("interactions_at") },
      // FOUNDING §18: operator/agent-submitted claims. ACTIVE only — a
      // retracted claim is kept readable but is not an observed row.
      claims: { count: count("claims"), latestAt: at("claims_at") },
      researchRuns: { count: count("research_runs"), latestAt: at("research_runs_at") },
    },
    latestProfileSnapshot: latestSnapshots[0] ?? null,
    media,
    observingSources,
    sourceKinds,
    evidenceClass,
    routeUnavailability: healthRows
      .filter(
        (h) => h.status === "UNAVAILABLE" && observingSources.includes(h.sourceId),
      )
      .map((h) => ({
        sourceId: h.sourceId,
        capability: h.capability,
        note: h.coverageNote ?? null,
        updatedAt: h.updatedAt,
      })),
  };
}

// ---------------------------------------------------------------------------
// Research-report reads (DEEP-ACCOUNT-INTELLIGENCE §4.3): the stored text and
// timestamp corpus the themes/cadence derivations are scoped to, and windowed
// change-event counts. Plain reads of rows this deployment already recorded —
// the report never fetches anything.
// ---------------------------------------------------------------------------

export interface StoredPostText {
  postId: string;
  caption: string | null;
  /** The provider's published time; null when the source did not transport it. */
  takenAt: Date | null;
}

/** Every stored caption/timestamp for a target, in publish order (nulls last).
 * The report states its corpus size, so this must be the whole stored set for
 * the target — never a sample that would silently shrink the denominators. */
export async function listStoredPostTexts(
  db: Database,
  userId: string,
  targetId: string,
): Promise<StoredPostText[] | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const rows = await query<{
    post_id: string;
    caption: string | null;
    taken_at: Date | string | null;
  }>(
    db,
    sql`
      SELECT post_id, caption, taken_at
      FROM posts
      WHERE target_id = ${owned.id}
      ORDER BY taken_at DESC NULLS LAST, post_id
    `,
  );
  return rows.map((r) => ({
    postId: r.post_id,
    caption: r.caption,
    takenAt: nullableDate(r.taken_at),
  }));
}

export interface ChangeWindowCount {
  count: number;
  latestAt: Date | null;
}

export interface TargetChangeSummary {
  windowDays: number;
  since: Date;
  profileChanges: ChangeWindowCount;
  postChanges: ChangeWindowCount;
  followDeltas: ChangeWindowCount;
}

/**
 * How many change events of each kind were RECORDED in the window. Zero rows
 * means "nothing changed was recorded" — a gap between scans records nothing,
 * so this must never be rendered as "nothing happened".
 */
export async function getTargetChangeSummary(
  db: Database,
  userId: string,
  targetId: string,
  windowDays: number,
  now: Date = new Date(),
): Promise<TargetChangeSummary | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const rows = await query<{
    profile_changes: number;
    profile_changes_at: Date | string | null;
    post_changes: number;
    post_changes_at: Date | string | null;
    follow_deltas: number;
    follow_deltas_at: Date | string | null;
  }>(
    db,
    sql`
      SELECT
        (SELECT count(*)::int FROM profile_changes
          WHERE ig_account_id = ${owned.igAccountId} AND created_at >= ${since}) AS profile_changes,
        (SELECT max(created_at) FROM profile_changes
          WHERE ig_account_id = ${owned.igAccountId} AND created_at >= ${since}) AS profile_changes_at,
        (SELECT count(*)::int FROM post_changes
          WHERE target_id = ${owned.id} AND detected_at >= ${since}) AS post_changes,
        (SELECT max(detected_at) FROM post_changes
          WHERE target_id = ${owned.id} AND detected_at >= ${since}) AS post_changes_at,
        (SELECT count(*)::int FROM follow_deltas
          WHERE target_id = ${owned.id} AND first_seen_at >= ${since}) AS follow_deltas,
        (SELECT max(first_seen_at) FROM follow_deltas
          WHERE target_id = ${owned.id} AND first_seen_at >= ${since}) AS follow_deltas_at
    `,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    windowDays,
    since: new Date(since),
    profileChanges: {
      count: int(row.profile_changes),
      latestAt: nullableDate(row.profile_changes_at),
    },
    postChanges: {
      count: int(row.post_changes),
      latestAt: nullableDate(row.post_changes_at),
    },
    followDeltas: {
      count: int(row.follow_deltas),
      latestAt: nullableDate(row.follow_deltas_at),
    },
  };
}

function nullableDate(v: Date | string | null | undefined): Date | null {
  return v === null || v === undefined ? null : asDate(v);
}

function readPreviewNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const v = metadata?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readPreviewBoolean(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): boolean | null {
  const v = metadata?.[key];
  return typeof v === "boolean" ? v : null;
}

// ---------------------------------------------------------------------------
// Evidence ledger scoped to the caller's targets, plus drill-in chain.
// No fake provenance: a row appears only when the underlying observation
// provably belongs to one of the caller's targets.
// ---------------------------------------------------------------------------

export interface ScopedEvidenceRow {
  id: string;
  observation_kind: string;
  observation_id: string;
  source_id: string;
  observed_at: Date;
  captured_at: Date;
  confidence: string;
  // Nullable by design: a hash is only recorded when the provider could
  // actually transport the raw representation. Follow snapshots, for example,
  // observe a normalized page and honestly store no raw hash — a normalized
  // hash must never be presented as a raw one.
  raw_hash: string | null;
  normalized_hash: string | null;
  metadata: Record<string, unknown> | null;
}

function mapEvidenceRow(r: {
  id: string;
  observation_kind: string;
  observation_id: string;
  source_id: string;
  observed_at: Date | string;
  captured_at: Date | string;
  confidence: string;
  raw_hash: string | null;
  normalized_hash: string | null;
  metadata: Record<string, unknown> | null;
}): ScopedEvidenceRow {
  return {
    id: r.id,
    observation_kind: r.observation_kind,
    observation_id: r.observation_id,
    source_id: r.source_id,
    observed_at: asDate(r.observed_at),
    captured_at: asDate(r.captured_at),
    confidence: r.confidence,
    raw_hash: r.raw_hash,
    normalized_hash: r.normalized_hash,
    metadata: r.metadata,
  };
}

async function scopedEvidenceByKind(
  db: Database,
  userId: string,
  kind: string,
  limit: number,
): Promise<ScopedEvidenceRow[]> {
  const rows = await query<ScopedEvidenceRow>(
    db,
    sql`
    SELECT e.id, e.observation_kind::text AS observation_kind, e.observation_id,
           e.source_id, e.observed_at, e.captured_at, e.confidence::text AS confidence,
           e.raw_hash, e.normalized_hash, e.metadata
    FROM evidence e
    WHERE e.observation_kind = ${kind}
      AND (
        (e.observation_kind = 'profile_snapshot' AND EXISTS (
          SELECT 1 FROM profile_snapshots ps
          JOIN targets t ON t.ig_account_id = ps.ig_account_id AND t.user_id = ${userId}
          WHERE ps.id = e.observation_id))
        OR (e.observation_kind = 'follow_snapshot' AND EXISTS (
          SELECT 1 FROM follow_snapshots fs
          JOIN targets t ON t.id = fs.target_id AND t.user_id = ${userId}
          WHERE fs.id = e.observation_id))
        OR (e.observation_kind = 'interaction' AND EXISTS (
          SELECT 1 FROM interactions i
          JOIN targets t ON t.id = i.target_id AND t.user_id = ${userId}
          WHERE i.id = e.observation_id))
        OR (e.observation_kind = 'post' AND EXISTS (
          SELECT 1 FROM posts p
          JOIN targets t ON t.id = p.target_id AND t.user_id = ${userId}
          WHERE p.id = e.observation_id))
        OR (e.observation_kind = 'post_comment' AND EXISTS (
          SELECT 1 FROM post_comments pc
          JOIN posts p ON p.id = pc.post_db_id
          JOIN targets t ON t.id = p.target_id AND t.user_id = ${userId}
          WHERE pc.id = e.observation_id))
        OR (e.observation_kind IN ('story', 'story_mention') AND EXISTS (
          SELECT 1 FROM stories st
          JOIN ig_accounts ia ON ia.id = st.ig_account_id
          JOIN targets t ON t.ig_account_id = st.ig_account_id AND t.user_id = ${userId}
          WHERE st.id = e.observation_id
             OR st.id IN (SELECT sm.story_db_id FROM story_mentions sm
                          WHERE sm.id = e.observation_id)))
      )
    ORDER BY e.observed_at DESC
    LIMIT ${limit}
  `,
  );
  return rows.map(mapEvidenceRow);
}

export async function listScopedEvidence(
  db: Database,
  userId: string,
  limit = 30,
): Promise<ScopedEvidenceRow[]> {
  const kinds = ["profile_snapshot", "story", "story_mention", "follow_snapshot", "interaction", "post", "post_comment"];
  const buckets = await Promise.all(
    kinds.map((k) => scopedEvidenceByKind(db, userId, k, limit).catch(() => [])),
  );
  return buckets
    .flat()
    .sort((a, b) => b.observed_at.getTime() - a.observed_at.getTime())
    .slice(0, limit);
}

export interface EvidenceChainDetail {
  evidence: ScopedEvidenceRow;
  claim: string;
  lineage: Array<{ label: string; value: string }>;
}

// Scan/job linkage for §15: worker-recorded evidence carries the producing
// job id in metadata, so any chain can answer "which scan produced this".
// Legacy rows (seed, pre-threading) simply omit the row.
function jobLineage(metadata: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  const jobId = metadata !== null ? metadata.jobId : undefined;
  if (typeof jobId !== "string" || jobId.length === 0) return [];
  return [{ label: "Producing scan job", value: jobId }];
}

export async function getEvidenceChain(
  db: Database,
  userId: string,
  evidenceId: string,
): Promise<EvidenceChainDetail | null> {
  const coreRows = await query<ScopedEvidenceRow>(
    db,
    sql`
    SELECT id, observation_kind::text AS observation_kind, observation_id,
           source_id, observed_at, captured_at, confidence::text AS confidence,
           raw_hash, normalized_hash, metadata
    FROM evidence
    WHERE id = ${evidenceId}
    LIMIT 1
  `,
  );
  const evRaw = coreRows[0];
  if (evRaw === undefined) return null;
  const ev = mapEvidenceRow(evRaw);

  const kind = ev.observation_kind;
  const id = ev.observation_id;

  if (kind === "profile_snapshot") {
    const ownerRows = await query<{ username: string }>(
      db,
      sql`
      SELECT ia.username
      FROM profile_snapshots ps
      JOIN ig_accounts ia ON ia.id = ps.ig_account_id
      WHERE ps.id = ${id}
        AND EXISTS (SELECT 1 FROM targets t
          WHERE t.user_id = ${userId} AND t.ig_account_id = ps.ig_account_id)
      LIMIT 1
    `,
    );
    const owner = ownerRows[0];
    if (owner === undefined) return null;

    const snapRows = await db
      .select()
      .from(profileSnapshots)
      .where(eq(profileSnapshots.id, id))
      .limit(1);
    const snap = snapRows[0];
    if (snap === undefined) return null;

    const changeRows = await query<{ field: string; side: string; detected_at: Date | string }>(
      db,
      sql`
      SELECT field::text AS field, 'new_state' AS side, detected_at
      FROM profile_changes WHERE to_snapshot_id = ${id}
      UNION ALL
      SELECT field::text AS field, 'prior_state' AS side, detected_at
      FROM profile_changes WHERE from_snapshot_id = ${id}
      ORDER BY detected_at DESC
    `,
    );

    const lineage: EvidenceChainDetail["lineage"] = [
      { label: "Account", value: `@${owner.username}` },
      {
        label: "Observed values at this timestamp",
        value: JSON.stringify({
          followerCount: snap.followerCount ?? "unavailable",
          followingCount: snap.followingCount ?? "unavailable",
          postCount: snap.postCount ?? "unavailable",
          bio: snap.bio ?? "unavailable",
        }),
      },
      { label: "Category", value: String(snap.category) },
      ...changeRows.map((c) => ({
        label:
          c.side === "new_state"
            ? "Derived change — this snapshot is the new state"
            : "Derived change — this snapshot was the prior state",
        value: `${c.field} · detected ${asDate(c.detected_at).toISOString()}`,
      })),
      ...jobLineage(ev.metadata),
    ];

    return {
      evidence: ev,
      claim: `Profile state of @${owner.username} as of ${asDate(ev.observed_at).toISOString()}`,
      lineage,
    };
  }

    if (kind === "follow_snapshot") {
    const fsRows = await query<{
      direction: string;
      taken_at: Date | string;
      completeness: string;
      total_observed: number;
      target_username: string;
    }>(
      db,
      sql`
      SELECT fs.direction::text AS direction, fs.taken_at, fs.completeness::text AS completeness,
             fs.total_observed, ia.username AS target_username
      FROM follow_snapshots fs
      JOIN targets t ON t.id = fs.target_id
      JOIN ig_accounts ia ON ia.id = t.ig_account_id
      WHERE fs.id = ${id} AND t.user_id = ${userId}
      LIMIT 1
    `,
    );
    const fs = fsRows[0];
    if (fs === undefined) return null;

    const memberRows = await query<{ username: string }>(
      db,
      sql`
      SELECT ia.username FROM follow_snapshot_members fsm
      JOIN ig_accounts ia ON ia.id = fsm.ig_account_id
      WHERE fsm.snapshot_id = ${id}
      ORDER BY ia.username ASC LIMIT 10
    `,
    );
    const deltaCountRows = await query<{ cnt: number }>(
      db,
      sql`
      SELECT count(*)::int AS cnt FROM follow_deltas
      WHERE from_snapshot_id = ${id} OR to_snapshot_id = ${id}
    `,
    );

    const members = memberRows.map((m) => `@${m.username}`);
    return {
      evidence: ev,
      claim: `${fs.direction.toLowerCase()} snapshot for @${fs.target_username}, taken ${asDate(fs.taken_at).toISOString()}`,
      lineage: [
        { label: "Direction", value: fs.direction },
        { label: "Completeness", value: fs.completeness },
        { label: "Total observed", value: String(int(fs.total_observed)) },
        {
          label:
            int(fs.total_observed) > members.length
              ? `Members (first ${members.length} of ${int(fs.total_observed)})`
              : members.length > 0
                ? "Members"
                : "Members",
          value: members.length > 0 ? members.join(", ") : "none observed",
        },
        {
          label: "Derived deltas referencing this snapshot",
          value: String(deltaCountRows[0] ? int(deltaCountRows[0].cnt) : 0),
        },
        ...jobLineage(ev.metadata),
      ],
    };
  }

  if (kind === "story" || kind === "story_mention") {
    const storyRows = await query<{ story_id: string; username: string; taken_at: Date | string }>(
      db,
      sql`
      SELECT st.story_id, ia.username, st.taken_at
      FROM stories st
      JOIN ig_accounts ia ON ia.id = st.ig_account_id
      WHERE EXISTS (SELECT 1 FROM targets t
        WHERE t.user_id = ${userId} AND t.ig_account_id = st.ig_account_id)
        AND (
          ${kind === "story"
            ? sql`st.id = ${id}`
            : sql`st.id IN (SELECT sm.story_db_id FROM story_mentions sm WHERE sm.id = ${id})`}
        )
      LIMIT 1
    `,
    );
    const s = storyRows[0];
    if (s === undefined) return null;
    return {
      evidence: ev,
      claim: `Story ${s.story_id} from @${s.username}, taken ${asDate(s.taken_at).toISOString()}`,
      lineage: [
        { label: "Story identifier (source-scoped)", value: s.story_id },
        { label: "Account", value: `@${s.username}` },
        { label: "Taken at", value: asDate(s.taken_at).toISOString() },
        ...jobLineage(ev.metadata),
      ],
    };
  }

  if (kind === "post") {
    const postRows = await query<{
      post_id: string;
      username: string;
      taken_at: Date | string;
      caption: string | null;
      shortcode: string | null;
      like_count: number | null;
      comment_count: number | null;
      media_type: string | null;
      media_product_type: string | null;
      comments_state: string | null;
    }>(
      db,
      sql`
      SELECT p.post_id, ia.username, p.taken_at, p.caption, p.shortcode,
             p.like_count, p.comment_count, p.media_type, p.media_product_type,
             p.comments_state
      FROM posts p
      JOIN targets t ON t.id = p.target_id
      JOIN ig_accounts ia ON ia.id = t.ig_account_id
      WHERE p.id = ${id} AND t.user_id = ${userId}
      LIMIT 1
    `,
    );
    const p = postRows[0];
    if (p === undefined) return null;
    return {
      evidence: ev,
      claim: `Post ${p.post_id} from @${p.username}, taken ${asDate(p.taken_at).toISOString()}`,
      lineage: [
        { label: "Post identifier (source-scoped)", value: p.post_id },
        { label: "Account", value: `@${p.username}` },
        { label: "Taken at", value: asDate(p.taken_at).toISOString() },
        ...(p.shortcode !== null ? [{ label: "Shortcode", value: p.shortcode }] : []),
        ...(p.media_type !== null || p.media_product_type !== null
          ? [{
              label: "Provider-declared media type",
              value: [p.media_type, p.media_product_type].filter((v) => v !== null).join(" / "),
            }]
          : [{ label: "Provider-declared media type", value: "not declared by provider" }]),
        { label: "Like count (provider metadata)", value: p.like_count === null ? "unavailable" : String(int(p.like_count)) },
        { label: "Comment count (provider metadata)", value: p.comment_count === null ? "unavailable" : String(int(p.comment_count)) },
        { label: "Comment observation state", value: p.comments_state ?? "unknown (recorded before state tracking)" },
        ...(p.caption !== null ? [{ label: "Caption", value: p.caption }] : []),
        ...jobLineage(ev.metadata),
      ],
    };
  }

  if (kind === "post_comment") {
    const commentRows = await query<{
      comment_id: string;
      body: string;
      commented_at: Date | string;
      author: string;
      post_id: string;
      owner: string;
      in_reply_to_comment_id: string | null;
    }>(
      db,
      sql`
      SELECT pc.comment_id, pc.body, pc.commented_at, ia.username AS author,
             p.post_id, owner.username AS owner, pc.in_reply_to_comment_id
      FROM post_comments pc
      JOIN posts p ON p.id = pc.post_db_id
      JOIN targets t ON t.id = p.target_id
      JOIN ig_accounts ia ON ia.id = pc.author_account_id
      JOIN ig_accounts owner ON owner.id = p.ig_account_id
      WHERE pc.id = ${id} AND t.user_id = ${userId}
      LIMIT 1
    `,
    );
    const c = commentRows[0];
    if (c === undefined) return null;
    return {
      evidence: ev,
      claim: `Comment ${c.comment_id} by @${c.author} on post ${c.post_id} (@${c.owner})`,
      lineage: [
        { label: "Comment identifier (source-scoped)", value: c.comment_id },
        { label: "Author (public account)", value: `@${c.author}` },
        { label: "Post identifier (source-scoped)", value: c.post_id },
        { label: "Commented at", value: asDate(c.commented_at).toISOString() },
        ...(c.in_reply_to_comment_id !== null
          ? [{ label: "Reply to comment", value: c.in_reply_to_comment_id }]
          : []),
        { label: "Text", value: c.body },
        ...jobLineage(ev.metadata),
      ],
    };
  }

  if (kind === "interaction") {
    const iRows = await query<{ target_username: string }>(
      db,
      sql`
      SELECT ia.username AS target_username
      FROM interactions i
      JOIN targets t ON t.id = i.target_id
      JOIN ig_accounts ia ON ia.id = t.ig_account_id
      WHERE i.id = ${id} AND t.user_id = ${userId}
      LIMIT 1
    `,
    );
    const i = iRows[0];
    if (i === undefined) return null;
    return {
      evidence: ev,
      claim: `Interaction observed relative to @${i.target_username}`,
      lineage: [
        { label: "Target account", value: `@${i.target_username}` },
        ...jobLineage(ev.metadata),
      ],
    };
  }

  // Unknown kinds never reach UI flows; never fabricate a chain.
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostics — operational truth without secrets. Worker activity is a
// derived signal and labelled as such; no payloads, credentials, or stack
// traces are ever included.
// ---------------------------------------------------------------------------

export interface JobQueueSummary {
  id: string;
  kind: string;
  status: string;
  outcome: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  targetUsername: string | null;
}

interface JobSummaryRaw {
  id: string;
  kind: string;
  status: string;
  outcome: string | null;
  attempts: number;
  max_attempts: number;
  available_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  error_message: string | null;
  target_username: string | null;
}

function mapJobSummary(r: JobSummaryRaw): JobQueueSummary {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    outcome: r.outcome,
    attempts: int(r.attempts),
    maxAttempts: int(r.max_attempts),
    availableAt: r.available_at === null ? null : asDate(r.available_at),
    startedAt: r.started_at === null ? null : asDate(r.started_at),
    completedAt: r.completed_at === null ? null : asDate(r.completed_at),
    errorMessage:
      r.error_message === null ? null : String(r.error_message).slice(0, 300),
    targetUsername: r.target_username,
  };
}

const JOB_SUMMARY_SELECT = sql`
  SELECT j.id::text AS id, j.kind, j.status::text AS status, j.outcome::text AS outcome, j.attempts, j.max_attempts,
         j.available_at, j.started_at, j.completed_at,
         (CASE WHEN j.error IS NULL THEN NULL
               ELSE left(coalesce(j.error->>'message', 'unknown failure'), 300) END) AS error_message,
         ia.username AS target_username
  FROM monitoring_jobs j
  LEFT JOIN targets t ON t.id = j.target_id
  LEFT JOIN ig_accounts ia ON ia.id = t.ig_account_id
`;

export async function listQueueJobs(
  db: Database,
  options: { statuses?: string[]; limit?: number; userId?: string } = {},
): Promise<JobQueueSummary[]> {
  const statuses = options.statuses ?? ["failed"];
  const limit = options.limit ?? 10;
  // Ownership scoping (invariant 9): job rows carry usernames and error
  // messages, so a userId restricts rows to that owner's targets. Aggregate
  // operations snapshots stay deployment-global by design.
  const ownerFilter =
    options.userId === undefined ? sql`` : sql`AND t.user_id = ${options.userId}`;
  const rows = await query<JobSummaryRaw>(
    db,
    sql`${JOB_SUMMARY_SELECT}
    WHERE j.status::text IN (${sql.join(
      statuses.map((s) => sql`${s}`),
      sql`, `,
    )})
    ${ownerFilter}
    ORDER BY j.updated_at DESC
    LIMIT ${limit}
  `,
  );
  return rows.map(mapJobSummary);
}

export async function listJobsForTarget(
  db: Database,
  targetId: string,
  limit = 8,
): Promise<JobQueueSummary[]> {
  const rows = await query<JobSummaryRaw>(
    db,
    sql`${JOB_SUMMARY_SELECT}
    WHERE j.target_id = ${targetId}
    ORDER BY j.created_at DESC
    LIMIT ${limit}
  `,
  );
  return rows.map(mapJobSummary);
}

export interface OperationsSnapshot {
  database: {
    connected: boolean;
    migrationsApplied: boolean;
    tables: Array<{ table: string; count: number }>;
  };
  queue: {
    queued: number;
    running: number;
    retryWait: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  workers: {
    lastClaimStartedAt: Date | null;
    runningCount: number;
  };
  scheduler: {
    enabled: boolean;
    lastTickAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    outcomes: Record<string, number>;
  };
  runningJobs: JobQueueSummary[];
  retryWaitJobs: JobQueueSummary[];
  failedJobs: JobQueueSummary[];
  sources: SourceHealthRecord[];
  error?: string;
}

export async function getOperationsSnapshot(db: Database): Promise<OperationsSnapshot> {
  try {
    await db.execute(sql`SELECT 1`);
    const [migrationCheck, q, tables, runningJobs, retryWaitJobs, failedJobs, health, workerRow, schedulerRow, outcomeRows] =
      await Promise.all([
        query<{ exists: boolean }>(
          db,
          sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'monitoring_jobs') AS exists`,
        ).then((r) => Boolean(r[0]?.exists)),
        queueCounts(db),
        query<{ table: string; count: number }>(
          db,
          sql`
          SELECT 'targets' AS table, count(*)::int AS count FROM targets
          UNION ALL SELECT 'profile_snapshots', count(*)::int FROM profile_snapshots
          UNION ALL SELECT 'stories', count(*)::int FROM stories
          UNION ALL SELECT 'follow_deltas', count(*)::int FROM follow_deltas
          UNION ALL SELECT 'monitoring_jobs', count(*)::int FROM monitoring_jobs
          UNION ALL SELECT 'evidence', count(*)::int FROM evidence
        `,
        ).catch(() => [] as Array<{ table: string; count: number }>),
        listQueueJobs(db, { statuses: ["running"], limit: 10 }).catch(() => []),
        listQueueJobs(db, { statuses: ["retry_wait"], limit: 10 }).catch(() => []),
        listQueueJobs(db, { statuses: ["failed"], limit: 10 }).catch(() => []),
        getSourceHealth(db).catch(() => []),
        query<{ started_at: Date | string | null }>(
          db,
          sql`SELECT max(started_at) AS started_at FROM monitoring_jobs`,
        ).catch(() => [] as Array<{ started_at: Date | string | null }>),
        query<{ last_tick_at: Date | string | null; last_success_at: Date | string | null; last_error: { message?: string } | null }>(
          db,
          sql`SELECT last_tick_at, last_success_at,
                     (CASE WHEN last_error IS NULL THEN NULL
                           ELSE left(coalesce(last_error->>'message', 'unknown error'), 300) END) AS last_error
                FROM scheduler_state WHERE id = 'default'`,
        ).catch(() => [] as Array<{ last_tick_at: Date | string | null; last_success_at: Date | string | null; last_error: { message?: string } | null }>),
        query<{ outcome: string; n: number }>(
          db,
          sql`SELECT outcome::text AS outcome, count(*)::int AS n
              FROM monitoring_jobs
              WHERE outcome IS NOT NULL
              GROUP BY outcome`,
        ).catch(() => [] as Array<{ outcome: string; n: number }>),
      ]);

    const lastClaimRaw = workerRow[0]?.started_at ?? null;
    return {
      database: {
        connected: true,
        migrationsApplied: migrationCheck,
        tables: Array.from(tables).map((t) => ({ table: t.table, count: int(t.count) })),
      },
      queue: {
        queued: q.queued ?? 0,
        running: q.running ?? 0,
        retryWait: q.retry_wait ?? 0,
        succeeded: q.succeeded ?? 0,
        failed: q.failed ?? 0,
        cancelled: q.cancelled ?? 0,
      },
      workers: {
        lastClaimStartedAt: lastClaimRaw === null ? null : asDate(lastClaimRaw),
        runningCount: runningJobs.length,
      },
      scheduler: {
        enabled: process.env.IGTRACK_SCHEDULER_ENABLED !== "false",
        lastTickAt:
          schedulerRow[0]?.last_tick_at === null || schedulerRow[0] === undefined
            ? null
            : asDate(schedulerRow[0].last_tick_at),
        lastSuccessAt:
          schedulerRow[0]?.last_success_at === null || schedulerRow[0] === undefined
            ? null
            : asDate(schedulerRow[0].last_success_at),
        lastError: schedulerRow[0]?.last_error?.message ?? null,
        outcomes: Object.fromEntries(
          outcomeRows.map((r) => [r.outcome, int(r.n)]),
        ),
      },
      runningJobs,
      retryWaitJobs,
      failedJobs,
      sources: health,
    };
  } catch (e) {
    return {
      database: { connected: false, migrationsApplied: false, tables: [] },
      queue: { queued: 0, running: 0, retryWait: 0, succeeded: 0, failed: 0, cancelled: 0 },
      workers: { lastClaimStartedAt: null, runningCount: 0 },
      scheduler: {
        enabled: process.env.IGTRACK_SCHEDULER_ENABLED !== "false",
        lastTickAt: null,
        lastSuccessAt: null,
        lastError: null,
        outcomes: {},
      },
      runningJobs: [],
      retryWaitJobs: [],
      failedJobs: [],
      sources: [],
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    };
  }
}

import { sql, eq, type SQL } from "drizzle-orm";
import type { Database } from "../client/client.js";
import { getSourceHealth, type SourceHealthRecord } from "./source-health.js";
import { getOwnedTarget } from "./targets.js";
import { igAccounts, profileSnapshots } from "../schema/index.js";
import {
  listProfileSnapshots,
  listProfileChanges,
} from "./observations.js";
import { listStories, listMentionsForStoryWithAccount, sightingSummariesForAccount } from "./stories.js";
import { listPosts, listCommentsForPostWithAccount, listChildrenForPost } from "./posts.js";
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

interface TargetListRow {
  id: string;
  username: string;
  display_name: string | null;
  status: string;
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
  // carry their own persisted confidence, stories carry theirs. Nothing here
  // is assigned or invented.
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
  "COMMENT_POSTED",
  "MENTION_OBSERVED",
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

  const [snapshots, changes, health, storiesList, postsList, followFollowers, followFollowing, deltas, jobs, sightings] =
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
  signals: { mentions: number; deltas: number };
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
}

export async function getRelationshipsForUser(
  db: Database,
  userId: string,
  targetId: string,
): Promise<RelationshipRank[]> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return [];

  const [deltas, mentionRows] = await Promise.all([
    listRecentDeltas(db, owned.id, { limit: 50 }).catch(
      () => [] as DeltaWithAccount[],
    ),
    query<{ username: string; count: number }>(
      db,
      sql`
        SELECT ia.username, count(*)::int AS count
        FROM story_mentions sm
        JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
        JOIN stories s ON s.id = sm.story_db_id
        WHERE s.ig_account_id = ${owned.igAccountId}
        GROUP BY ia.username
        ORDER BY count DESC
      `,
    ).catch(() => [] as Array<{ username: string; count: number }>),
  ]);

  const map = new Map<string, { mentions: number; deltas: number }>();
  for (const m of mentionRows) {
    map.set(m.username, { mentions: int(m.count), deltas: 0 });
  }
  for (const d of deltas) {
    const cur = map.get(d.username) ?? { mentions: 0, deltas: 0 };
    cur.deltas += 1;
    map.set(d.username, cur);
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
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS'
           ORDER BY taken_at DESC LIMIT 1)
           AND m0.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS'
           ORDER BY taken_at ASC LIMIT 1)
           AND m.snapshot_id <> m0.snapshot_id
         LIMIT ${STABLE_MEMBER_CAP})
        UNION
        (SELECT ia.username FROM follow_snapshot_members m
         JOIN follow_snapshot_members m0 ON m0.ig_account_id = m.ig_account_id
         JOIN ig_accounts ia ON ia.id = m.ig_account_id
         WHERE m.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWING'
           ORDER BY taken_at DESC LIMIT 1)
           AND m0.snapshot_id IN (
           SELECT id FROM follow_snapshots
           WHERE target_id = ${owned.id} AND direction = 'FOLLOWING'
           ORDER BY taken_at ASC LIMIT 1)
           AND m.snapshot_id <> m0.snapshot_id
         LIMIT ${STABLE_MEMBER_CAP})`,
  ).catch(() => [] as Array<{ username: string }>);
  for (const row of stableRows) {
    if (!map.has(row.username)) {
      map.set(row.username, { mentions: 0, deltas: 0 });
    }
  }

  // Structural enrichment, bounded to ranked candidates with indexed EXISTS
  // probes (no full-roster loads). Everything here describes snapshot
  // membership — observed facts, never inferred follow/unfollow timestamps.
  const ranked = [...map.entries()]
    .map(([username, v]) => ({
      username,
      score: v.mentions * 12 + v.deltas * 8,
      signals: v,
      confidence:
        v.mentions + v.deltas > 2 ? "MEDIUM" : v.mentions + v.deltas > 0 ? "LOW" : "UNKNOWN",
    }))
    .sort((a, b) => b.score - a.score);

  const [latestFollowers, latestFollowing, earliestTaken, firstSeenRows] = await Promise.all([
    latestFollowSnapshot(db, owned.id, "FOLLOWERS").catch(() => null),
    latestFollowSnapshot(db, owned.id, "FOLLOWING").catch(() => null),
    query<{ direction: string; earliest: Date | string }>(
      db,
      sql`SELECT direction::text AS direction, min(taken_at) AS earliest
           FROM follow_snapshots WHERE target_id = ${owned.id} GROUP BY direction`,
    ).catch(() => [] as Array<{ direction: string; earliest: Date | string }>),
    ranked.length === 0
      ? Promise.resolve([])
      : query<{ username: string; first_seen: Date | string }>(
          db,
          sql`SELECT ia.username, min(fd.first_seen_at) AS first_seen
               FROM follow_deltas fd
               JOIN ig_accounts ia ON ia.id = fd.ig_account_id
               WHERE fd.target_id = ${owned.id}
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
  return enriched;
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
  raw_hash: string;
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
  raw_hash: string;
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
  options: { statuses?: string[]; limit?: number } = {},
): Promise<JobQueueSummary[]> {
  const statuses = options.statuses ?? ["failed"];
  const limit = options.limit ?? 10;
  const rows = await query<JobSummaryRaw>(
    db,
    sql`${JOB_SUMMARY_SELECT}
    WHERE j.status::text IN (${sql.join(
      statuses.map((s) => sql`${s}`),
      sql`, `,
    )})
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
          UNION ALL SELECT 'sessions', count(*)::int FROM sessions
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

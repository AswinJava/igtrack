import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../client/client.js";
import { getOwnedTarget } from "./targets.js";

// ---------------------------------------------------------------------------
// Window-bucketed reads for the four-tab Activity Report.
//
// Every aggregate is computed in UTC (date_trunc over `ts AT TIME ZONE 'UTC'`)
// so a weekly bucket is the same Monday-start week the rest of IGTrack reports
// use, regardless of the database session timezone. Every read is scoped to
// `end`, so composing a report for a past period returns the same rows today as
// it did then. All reads are scoped to the owned target; an unknown target is a
// null result, never an empty one.
// ---------------------------------------------------------------------------

export type ActivityBucketUnit = "day" | "week" | "month" | "quarter" | "year";

export interface ActivityBucketRow {
  bucket: string;
  newFollowing: number;
  lostFollowing: number;
  newFollowers: number;
  lostFollowers: number;
  posts: number;
  stories: number;
  comments: number;
  tags: number;
  mentions: number;
  profileSnapshots: number;
  insights: number;
  /** COMPLETE FOLLOWING snapshots inside the bucket: a zero delta is measured. */
  completeFollowingSnapshots: number;
  total: number;
}

export interface ActivityBucketCommenter {
  bucket: string;
  username: string;
  count: number;
}

export interface ActivityCommentRow {
  id: string;
  username: string;
  body: string;
  commentedAt: string;
  likeCount: number | null;
  postId: string;
  evidenceId: string | null;
}

/**
 * The heavy aggregates used by the selected period's tabs. Null means "the
 * caller did not ask" (the inventory read), never "nothing was found": an
 * empty array is the observed-empty answer.
 */
export interface ActivityTrailDetails {
  topCommenterByBucket: ActivityBucketCommenter[];
  monthCounts: {
    newFollowing: number;
    lostFollowing: number;
    posts: number;
  };
  /**
   * COMPLETE snapshots before and inside the reporting month (clamped to the
   * report end). A zero month count is only a measured zero when a complete
   * roster pair existed to diff; otherwise the composer refuses it.
   */
  completeRosterBeforeMonth: number;
  completeRosterInMonth: number;
  topCommenters: Array<{ username: string; count: number }>;
  topMentioned: Array<{ username: string; count: number }>;
  captions: string[];
  captionRows: number;
  recentComments: ActivityCommentRow[];
  followingRosterSize: number | null;
}

export interface TargetActivityTrail {
  sinceDate: string | null;
  completeRosterSnapshots: number;
  buckets: ActivityBucketRow[];
  details: ActivityTrailDetails | null;
}

async function query<T>(db: Database, q: SQL): Promise<T[]> {
  const res = await db.execute(q);
  return Array.from(res) as T[];
}

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function nullableDate(v: unknown): Date | null {
  return v === null || v === undefined ? null : asDate(v);
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * All-time bucketed activity for one target up to `end`. The caller supplies
 * the bucket unit matching the selected period; the same rows feed the
 * timeline and the period inventory, so the two can never disagree about a
 * period's count. `includeDetails: false` skips the per-tab aggregates when
 * only bucket counts are needed (the inventory read).
 */
export async function getTargetActivityTrail(
  db: Database,
  userId: string,
  targetId: string,
  unit: ActivityBucketUnit,
  start: Date,
  end: Date,
  monthStart: Date,
  monthEnd: Date,
  options: { includeDetails?: boolean } = {},
): Promise<TargetActivityTrail | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const includeDetails = options.includeDetails ?? true;

  const sinceRows = await query<{ since: Date | string | null }>(
    db,
    sql`
      SELECT min(ts) AS since FROM (
        SELECT min(observed_at) AS ts FROM profile_snapshots
          WHERE ig_account_id = ${owned.igAccountId} AND observed_at < ${endIso}
        UNION ALL SELECT min(detected_at) FROM profile_changes
          WHERE ig_account_id = ${owned.igAccountId} AND detected_at < ${endIso}
        UNION ALL SELECT min(taken_at) FROM posts
          WHERE target_id = ${owned.id} AND taken_at < ${endIso}
        UNION ALL SELECT min(taken_at) FROM stories
          WHERE ig_account_id = ${owned.igAccountId} AND taken_at < ${endIso}
        UNION ALL SELECT min(taken_at) FROM follow_snapshots
          WHERE target_id = ${owned.id} AND taken_at < ${endIso}
        UNION ALL SELECT min(first_seen_at) FROM follow_deltas
          WHERE target_id = ${owned.id} AND first_seen_at < ${endIso}
        UNION ALL SELECT min(pc.commented_at) FROM post_comments pc
          JOIN posts p ON p.id = pc.post_db_id
          WHERE p.target_id = ${owned.id} AND pc.commented_at < ${endIso}
        UNION ALL SELECT min(observed_at) FROM tagged_media
          WHERE ig_account_id = ${owned.igAccountId} AND observed_at < ${endIso}
        UNION ALL SELECT min(observed_at) FROM insight_points
          WHERE ig_account_id = ${owned.igAccountId} AND observed_at < ${endIso}
      ) surfaces
    `,
  );
  const sinceDate = sinceRows[0] === undefined ? null : nullableDate(sinceRows[0].since);
  const bucketStart = sinceDate ?? start;
  const bucketStartIso = bucketStart.toISOString();

  const rosterRows = await query<{ complete: number }>(
    db,
    sql`
      SELECT count(*)::int AS complete
      FROM follow_snapshots
      WHERE target_id = ${owned.id} AND completeness = 'COMPLETE' AND taken_at < ${endIso}
    `,
  );

  const bucketRows = await query<{
    bucket: string;
    new_following: number;
    lost_following: number;
    new_followers: number;
    lost_followers: number;
    posts: number;
    stories: number;
    comments: number;
    tags: number;
    mentions: number;
    profile_snapshots: number;
    insights: number;
    complete_following_snapshots: number;
    total: number;
  }>(
    db,
    sql`
      SELECT to_char(bucket, 'YYYY-MM-DD') AS bucket,
             count(*) FILTER (WHERE kind = 'NEW_FOLLOWING')::int AS new_following,
             count(*) FILTER (WHERE kind = 'LOST_FOLLOWING')::int AS lost_following,
             count(*) FILTER (WHERE kind = 'NEW_FOLLOWER')::int AS new_followers,
             count(*) FILTER (WHERE kind = 'LOST_FOLLOWER')::int AS lost_followers,
             count(*) FILTER (WHERE kind = 'POST')::int AS posts,
             count(*) FILTER (WHERE kind = 'STORY')::int AS stories,
             count(*) FILTER (WHERE kind = 'COMMENT')::int AS comments,
             count(*) FILTER (WHERE kind = 'TAG')::int AS tags,
             count(*) FILTER (WHERE kind = 'MENTION')::int AS mentions,
             count(*) FILTER (WHERE kind = 'PROFILE_SNAPSHOT')::int AS profile_snapshots,
             count(*) FILTER (WHERE kind = 'INSIGHT')::int AS insights,
             count(*) FILTER (WHERE kind = 'ROSTER')::int AS complete_following_snapshots,
             count(*) FILTER (
               WHERE kind IN ('NEW_FOLLOWING','LOST_FOLLOWING','POST','STORY','COMMENT','TAG','MENTION')
             )::int AS total
      FROM (
        SELECT fd.change::text AS kind,
               date_trunc(${unit}, fd.first_seen_at AT TIME ZONE 'UTC') AS bucket
        FROM follow_deltas fd
        WHERE fd.target_id = ${owned.id}
          AND fd.first_seen_at >= ${bucketStartIso} AND fd.first_seen_at < ${endIso}
        UNION ALL
        SELECT 'POST', date_trunc(${unit}, p.taken_at AT TIME ZONE 'UTC')
        FROM posts p
        WHERE p.target_id = ${owned.id}
          AND p.taken_at >= ${bucketStartIso} AND p.taken_at < ${endIso}
        UNION ALL
        SELECT 'STORY', date_trunc(${unit}, s.taken_at AT TIME ZONE 'UTC')
        FROM stories s
        WHERE s.ig_account_id = ${owned.igAccountId}
          AND s.taken_at >= ${bucketStartIso} AND s.taken_at < ${endIso}
        UNION ALL
        SELECT 'COMMENT', date_trunc(${unit}, pc.commented_at AT TIME ZONE 'UTC')
        FROM post_comments pc
        JOIN posts p ON p.id = pc.post_db_id
        WHERE p.target_id = ${owned.id}
          AND pc.commented_at >= ${bucketStartIso} AND pc.commented_at < ${endIso}
        UNION ALL
        SELECT 'TAG', date_trunc(${unit}, tm.observed_at AT TIME ZONE 'UTC')
        FROM tagged_media tm
        WHERE tm.ig_account_id = ${owned.igAccountId}
          AND tm.observed_at >= ${bucketStartIso} AND tm.observed_at < ${endIso}
        UNION ALL
        SELECT 'MENTION', date_trunc(${unit}, s.taken_at AT TIME ZONE 'UTC')
        FROM story_mentions sm
        JOIN stories s ON s.id = sm.story_db_id
        WHERE s.ig_account_id = ${owned.igAccountId}
          AND s.taken_at >= ${bucketStartIso} AND s.taken_at < ${endIso}
        UNION ALL
        SELECT 'PROFILE_SNAPSHOT', date_trunc(${unit}, ps.observed_at AT TIME ZONE 'UTC')
        FROM profile_snapshots ps
        WHERE ps.ig_account_id = ${owned.igAccountId}
          AND ps.observed_at >= ${bucketStartIso} AND ps.observed_at < ${endIso}
        UNION ALL
        SELECT 'INSIGHT', date_trunc(${unit}, ip.observed_at AT TIME ZONE 'UTC')
        FROM insight_points ip
        WHERE ip.ig_account_id = ${owned.igAccountId}
          AND ip.observed_at >= ${bucketStartIso} AND ip.observed_at < ${endIso}
        UNION ALL
        SELECT 'ROSTER', date_trunc(${unit}, fs.taken_at AT TIME ZONE 'UTC')
        FROM follow_snapshots fs
        WHERE fs.target_id = ${owned.id}
          AND fs.direction = 'FOLLOWING' AND fs.completeness = 'COMPLETE'
          AND fs.taken_at >= ${bucketStartIso} AND fs.taken_at < ${endIso}
      ) events
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  );

  const buckets: ActivityBucketRow[] = bucketRows.map((row) => ({
    bucket: row.bucket,
    newFollowing: Number(row.new_following),
    lostFollowing: Number(row.lost_following),
    newFollowers: Number(row.new_followers),
    lostFollowers: Number(row.lost_followers),
    posts: Number(row.posts),
    stories: Number(row.stories),
    comments: Number(row.comments),
    tags: Number(row.tags),
    mentions: Number(row.mentions),
    profileSnapshots: Number(row.profile_snapshots),
    insights: Number(row.insights),
    completeFollowingSnapshots: Number(row.complete_following_snapshots),
    total: Number(row.total),
  }));

  if (!includeDetails) {
    return {
      sinceDate: sinceDate?.toISOString() ?? null,
      completeRosterSnapshots: Number(rosterRows[0]?.complete ?? 0),
      buckets,
      details: null,
    };
  }

  const commenterGroups = await query<{ bucket: string; username: string; count: number }>(
    db,
    sql`
      SELECT to_char(bucket, 'YYYY-MM-DD') AS bucket, username, count(*)::int AS count
      FROM (
        SELECT date_trunc(${unit}, pc.commented_at AT TIME ZONE 'UTC') AS bucket,
               ia.username
        FROM post_comments pc
        JOIN posts p ON p.id = pc.post_db_id
        JOIN ig_accounts ia ON ia.id = pc.author_account_id
        WHERE p.target_id = ${owned.id}
          AND pc.commented_at >= ${bucketStartIso} AND pc.commented_at < ${endIso}
      ) comments
      GROUP BY bucket, username
      ORDER BY bucket ASC, count DESC, username ASC
    `,
  );
  const topCommenterByBucket: ActivityBucketCommenter[] = [];
  const seenBuckets = new Set<string>();
  for (const row of commenterGroups) {
    if (seenBuckets.has(row.bucket)) continue;
    seenBuckets.add(row.bucket);
    topCommenterByBucket.push({ bucket: row.bucket, username: row.username, count: Number(row.count) });
  }

  // The reporting month never extends past `end`: a past report must not count
  // rows that were not part of its selected window's horizon.
  const monthStartIso = monthStart.toISOString();
  const monthEndIso = (monthEnd.getTime() < end.getTime() ? monthEnd : end).toISOString();

  const monthRows = await query<{
    new_following: number;
    lost_following: number;
    posts: number;
  }>(
    db,
    sql`
      SELECT
        (SELECT count(*) FROM follow_deltas fd
          WHERE fd.target_id = ${owned.id} AND fd.change = 'NEW_FOLLOWING'
            AND fd.first_seen_at >= ${monthStartIso} AND fd.first_seen_at < ${monthEndIso})::int AS new_following,
        (SELECT count(*) FROM follow_deltas fd
          WHERE fd.target_id = ${owned.id} AND fd.change = 'LOST_FOLLOWING'
            AND fd.first_seen_at >= ${monthStartIso} AND fd.first_seen_at < ${monthEndIso})::int AS lost_following,
        (SELECT count(*) FROM posts p
          WHERE p.target_id = ${owned.id}
            AND p.taken_at >= ${monthStartIso} AND p.taken_at < ${monthEndIso})::int AS posts
    `,
  );

  const monthRosterRows = await query<{ before: number; in_month: number }>(
    db,
    sql`
      SELECT
        count(*) FILTER (WHERE taken_at < ${monthStartIso})::int AS before,
        count(*) FILTER (WHERE taken_at >= ${monthStartIso} AND taken_at < ${monthEndIso})::int AS in_month
      FROM follow_snapshots
      WHERE target_id = ${owned.id} AND completeness = 'COMPLETE' AND taken_at < ${endIso}
    `,
  );

  const topCommenters = await query<{ username: string; count: number }>(
    db,
    sql`
      SELECT ia.username, count(*)::int AS count
      FROM post_comments pc
      JOIN posts p ON p.id = pc.post_db_id
      JOIN ig_accounts ia ON ia.id = pc.author_account_id
      WHERE p.target_id = ${owned.id}
        AND pc.commented_at >= ${bucketStartIso} AND pc.commented_at < ${endIso}
      GROUP BY ia.username
      ORDER BY count DESC, ia.username ASC
      LIMIT 10
    `,
  );

  const topMentioned = await query<{ username: string; count: number }>(
    db,
    sql`
      SELECT ia.username, count(*)::int AS count
      FROM story_mentions sm
      JOIN stories s ON s.id = sm.story_db_id
      JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
      WHERE s.ig_account_id = ${owned.igAccountId}
        AND s.taken_at >= ${bucketStartIso} AND s.taken_at < ${endIso}
      GROUP BY ia.username
      ORDER BY count DESC, ia.username ASC
      LIMIT 10
    `,
  );

  const captionRows = await query<{ caption: string }>(
    db,
    sql`
      SELECT p.caption
      FROM posts p
      WHERE p.target_id = ${owned.id}
        AND p.taken_at >= ${bucketStartIso} AND p.taken_at < ${endIso}
        AND p.caption IS NOT NULL AND p.caption <> ''
      ORDER BY p.taken_at ASC, p.post_id ASC
    `,
  );

  const recentComments = await query<{
    id: string;
    username: string;
    body: string;
    commented_at: Date | string;
    like_count: number | null;
    post_db_id: string;
    evidence_id: string | null;
  }>(
    db,
    sql`
      SELECT pc.id, ia.username, pc.body, pc.commented_at, pc.like_count,
             pc.post_db_id, pc.evidence_id
      FROM post_comments pc
      JOIN posts p ON p.id = pc.post_db_id
      JOIN ig_accounts ia ON ia.id = pc.author_account_id
      WHERE p.target_id = ${owned.id}
        AND pc.commented_at >= ${bucketStartIso} AND pc.commented_at < ${endIso}
      ORDER BY pc.commented_at DESC, pc.comment_id DESC
      LIMIT 100
    `,
  );

  // The latest COMPLETE roster observed strictly before `end`. A past report
  // must not borrow a roster a later scan recorded; `latestCompleteFollowSnapshot`
  // is deliberately not used here because it is end-unbounded.
  const followingRosterRows = await query<{ count: number }>(
    db,
    sql`
      SELECT count(*)::int AS count
      FROM follow_snapshot_members m
      WHERE m.snapshot_id = (
        SELECT s.id
        FROM follow_snapshots s
        WHERE s.target_id = ${owned.id}
          AND s.direction = 'FOLLOWING'
          AND s.completeness = 'COMPLETE'
          AND s.taken_at < ${endIso}
        ORDER BY s.taken_at DESC, s.created_at DESC
        LIMIT 1
      )
    `,
  );
  const followingRosterSize =
    followingRosterRows[0] === undefined ? null : Number(followingRosterRows[0].count);
  // A missing COMPLETE roster yields 0 members and no snapshot; keep those
  // distinguishable so the composer refuses rather than printing 0.
  const hasFollowingRoster = await query<{ present: boolean }>(
    db,
    sql`
      SELECT EXISTS (
        SELECT 1 FROM follow_snapshots s
        WHERE s.target_id = ${owned.id}
          AND s.direction = 'FOLLOWING'
          AND s.completeness = 'COMPLETE'
          AND s.taken_at < ${endIso}
      ) AS present
    `,
  );

  return {
    sinceDate: sinceDate?.toISOString() ?? null,
    completeRosterSnapshots: Number(rosterRows[0]?.complete ?? 0),
    buckets,
    details: {
      topCommenterByBucket,
      monthCounts: {
        newFollowing: Number(monthRows[0]?.new_following ?? 0),
        lostFollowing: Number(monthRows[0]?.lost_following ?? 0),
        posts: Number(monthRows[0]?.posts ?? 0),
      },
      completeRosterBeforeMonth: Number(monthRosterRows[0]?.before ?? 0),
      completeRosterInMonth: Number(monthRosterRows[0]?.in_month ?? 0),
      topCommenters: topCommenters.map((row) => ({ username: row.username, count: Number(row.count) })),
      topMentioned: topMentioned.map((row) => ({ username: row.username, count: Number(row.count) })),
      captions: captionRows.map((row) => row.caption),
      captionRows: captionRows.length,
      recentComments: recentComments.map((row) => ({
        id: row.id,
        username: row.username,
        body: row.body,
        commentedAt: asDate(row.commented_at).toISOString(),
        likeCount: toNumber(row.like_count),
        postId: row.post_db_id,
        evidenceId: row.evidence_id,
      })),
      followingRosterSize: hasFollowingRoster[0]?.present === true ? followingRosterSize : null,
    },
  };
}

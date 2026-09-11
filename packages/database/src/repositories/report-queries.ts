import { eq, sql, type SQL } from "drizzle-orm";
import type {
  ReportComment,
  ReportFollowChange,
  ReportFollowCoverage,
  ReportFollowDelta,
  ReportInsightPoint,
  ReportMention,
  ReportPost,
  ReportProfileChange,
  ReportProfilePoint,
  ReportStory,
  ReportTag,
} from "@igtrack/core";
import type { Database } from "../client/client.js";
import { igAccounts } from "../schema/index.js";
import { getOwnedTarget, type TargetRecord } from "./targets.js";
import { RELATIONSHIP_SIGNAL_WEIGHTS } from "./app-queries.js";
import {
  earliestCompleteFollowSnapshot,
  latestCompleteFollowSnapshot,
  listAllMembersForSnapshot,
  type FollowDirection,
} from "./follows.js";

// ---------------------------------------------------------------------------
// Window-bounded reads for `report`, `reports` and `audience`.
//
// These queries never derive movement from a count. Follow movement comes from
// follow_deltas, which are written only between COMPLETE snapshots; audience
// set algebra uses only the latest COMPLETE roster. A window with no rows is
// returned as empty, and the caller prints the difference between "the source
// answered and nothing happened" and "the source cannot answer".
// ---------------------------------------------------------------------------

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

function iso(v: Date | string): string {
  return asDate(v).toISOString();
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The earliest instant a report window can address. Each surface contributes
 * the SAME timestamp column its window read filters on (a post's publish time,
 * a comment's authored time), so the oldest window the index offers is exactly
 * the oldest window `report` can answer. Observation time would understate the
 * addressable history whenever media is ingested after it was published.
 */
function earliestLedgerAt(db: Database, targetId: string, igAccountId: string) {
  return query<{ earliest_at: Date | string | null }>(
    db,
    sql`
      SELECT min(ts) AS earliest_at FROM (
        SELECT min(observed_at) AS ts FROM profile_snapshots WHERE ig_account_id = ${igAccountId}
        UNION ALL SELECT min(detected_at) FROM profile_changes WHERE ig_account_id = ${igAccountId}
        UNION ALL SELECT min(taken_at) FROM posts WHERE target_id = ${targetId}
        UNION ALL SELECT min(taken_at) FROM stories WHERE ig_account_id = ${igAccountId}
        UNION ALL SELECT min(taken_at) FROM follow_snapshots WHERE target_id = ${targetId}
        UNION ALL SELECT min(first_seen_at) FROM follow_deltas WHERE target_id = ${targetId}
        UNION ALL SELECT min(pc.commented_at) FROM post_comments pc JOIN posts p ON p.id = pc.post_db_id WHERE p.target_id = ${targetId}
        UNION ALL SELECT min(s.taken_at) FROM story_mentions sm JOIN stories s ON s.id = sm.story_db_id WHERE s.ig_account_id = ${igAccountId}
        UNION ALL SELECT min(observed_at) FROM tagged_media WHERE ig_account_id = ${igAccountId}
        UNION ALL SELECT min(observed_at) FROM insight_points WHERE ig_account_id = ${igAccountId}
      ) surfaces
    `,
  );
}

export interface TargetReportRows {
  target: TargetRecord;
  account: { id: string; username: string; igId: string | null; displayName: string | null };
  earliestActivityAt: Date | null;
  baselineProfile: ReportProfilePoint | null;
  profilePoints: ReportProfilePoint[];
  profileChanges: ReportProfileChange[];
  followDeltas: ReportFollowDelta[];
  followersCoverage: ReportFollowCoverage;
  followingCoverage: ReportFollowCoverage;
  posts: ReportPost[];
  stories: ReportStory[];
  comments: ReportComment[];
  mentions: ReportMention[];
  tags: ReportTag[];
  insights: ReportInsightPoint[];
}

export async function getTargetReportRows(
  db: Database,
  userId: string,
  targetId: string,
  start: Date,
  end: Date,
): Promise<TargetReportRows | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;

  const accountRows = await db
    .select({
      id: igAccounts.id,
      username: igAccounts.username,
      igId: igAccounts.igId,
      displayName: igAccounts.displayName,
    })
    .from(igAccounts)
    .where(eq(igAccounts.id, owned.igAccountId))
    .limit(1);
  const account = accountRows[0];
  if (account === undefined) return null;

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [
    ledger,
    baselineRows,
    pointRows,
    changeRows,
    deltaRows,
    followerCoverageRows,
    followingCoverageRows,
    postRows,
    storyRows,
    commentRows,
    mentionRows,
    tagRows,
    insightRows,
  ] = await Promise.all([
    earliestLedgerAt(db, owned.id, owned.igAccountId),
    query<{
      id: string;
      observed_at: Date | string;
      follower_count: number | null;
      following_count: number | null;
      post_count: number | null;
      completeness: string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT id, observed_at, follower_count, following_count, post_count,
               completeness::text AS completeness, evidence_id
        FROM profile_snapshots
        WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at < ${startIso}
          AND completeness = 'COMPLETE'
        ORDER BY observed_at DESC
        LIMIT 1
      `,
    ),
    query<{
      id: string;
      observed_at: Date | string;
      follower_count: number | null;
      following_count: number | null;
      post_count: number | null;
      completeness: string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT id, observed_at, follower_count, following_count, post_count,
               completeness::text AS completeness, evidence_id
        FROM profile_snapshots
        WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso}
        ORDER BY observed_at ASC
      `,
    ),
    query<{
      field: string;
      old_value: string | null;
      new_value: string | null;
      detected_at: Date | string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT pc.field, pc.old_value, pc.new_value, pc.detected_at, ps.evidence_id
        FROM profile_changes pc
        JOIN profile_snapshots ps ON ps.id = pc.to_snapshot_id
        WHERE pc.ig_account_id = ${owned.igAccountId}
          AND pc.detected_at >= ${startIso} AND pc.detected_at < ${endIso}
        ORDER BY pc.detected_at ASC, pc.field ASC
      `,
    ),
    query<{
      change: string;
      username: string;
      first_seen_at: Date | string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT fd.change::text AS change, ia.username, fd.first_seen_at, fs.evidence_id
        FROM follow_deltas fd
        JOIN ig_accounts ia ON ia.id = fd.ig_account_id
        JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
        WHERE fd.target_id = ${owned.id}
          AND fd.first_seen_at >= ${startIso} AND fd.first_seen_at < ${endIso}
        ORDER BY fd.first_seen_at ASC, ia.username ASC
      `,
    ),
    query<{ complete: number; partial: number; latest_complete_at: Date | string | null }>(
      db,
      sql`
        SELECT count(*) FILTER (WHERE completeness = 'COMPLETE')::int AS complete,
               count(*) FILTER (WHERE completeness <> 'COMPLETE')::int AS partial,
               max(taken_at) FILTER (WHERE completeness = 'COMPLETE') AS latest_complete_at
        FROM follow_snapshots
        WHERE target_id = ${owned.id} AND direction = 'FOLLOWERS'
          AND taken_at >= ${startIso} AND taken_at < ${endIso}
      `,
    ),
    query<{ complete: number; partial: number; latest_complete_at: Date | string | null }>(
      db,
      sql`
        SELECT count(*) FILTER (WHERE completeness = 'COMPLETE')::int AS complete,
               count(*) FILTER (WHERE completeness <> 'COMPLETE')::int AS partial,
               max(taken_at) FILTER (WHERE completeness = 'COMPLETE') AS latest_complete_at
        FROM follow_snapshots
        WHERE target_id = ${owned.id} AND direction = 'FOLLOWING'
          AND taken_at >= ${startIso} AND taken_at < ${endIso}
      `,
    ),
    query<{
      id: string;
      taken_at: Date | string;
      caption: string | null;
      media_type: string | null;
      like_count: number | null;
      comment_count: number | null;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT id, taken_at, caption, media_type, like_count, comment_count, evidence_id
        FROM posts
        WHERE target_id = ${owned.id}
          AND taken_at >= ${startIso} AND taken_at < ${endIso}
        ORDER BY taken_at ASC, post_id ASC
      `,
    ),
    query<{
      id: string;
      taken_at: Date | string;
      media_type: string;
      expires_at: Date | string | null;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT id, taken_at, media_type::text AS media_type, expires_at, evidence_id
        FROM stories
        WHERE ig_account_id = ${owned.igAccountId}
          AND taken_at >= ${startIso} AND taken_at < ${endIso}
        ORDER BY taken_at ASC, story_id ASC
      `,
    ),
    query<{
      id: string;
      commented_at: Date | string;
      username: string;
      post_db_id: string;
      body: string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT pc.id, pc.commented_at, author.username, pc.post_db_id, pc.body, pc.evidence_id
        FROM post_comments pc
        JOIN posts p ON p.id = pc.post_db_id
        JOIN ig_accounts author ON author.id = pc.author_account_id
        WHERE p.target_id = ${owned.id}
          AND pc.commented_at >= ${startIso} AND pc.commented_at < ${endIso}
        ORDER BY pc.commented_at ASC, pc.comment_id ASC
      `,
    ),
    query<{
      id: string;
      observed_at: Date | string;
      username: string;
      story_db_id: string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        -- A mention belongs to its story's window, not the scan that read it,
        -- so the Stories section never lists a story whose mentions sit elsewhere.
        SELECT sm.id, sm.observed_at, mentioned.username, sm.story_db_id,
               COALESCE(sm.evidence_id, s.evidence_id) AS evidence_id
        FROM story_mentions sm
        JOIN stories s ON s.id = sm.story_db_id
        JOIN ig_accounts mentioned ON mentioned.id = sm.mentioned_account_id
        WHERE s.ig_account_id = ${owned.igAccountId}
          AND s.taken_at >= ${startIso} AND s.taken_at < ${endIso}
        ORDER BY s.taken_at ASC, mentioned.username ASC
      `,
    ),
    query<{
      id: string;
      observed_at: Date | string;
      owner_username: string | null;
      media_id: string;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT id, observed_at, owner_username, media_id, evidence_id
        FROM tagged_media
        WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso}
        ORDER BY observed_at ASC, media_id ASC
      `,
    ),
    query<{
      metric: string;
      observed_at: Date | string;
      value: number | string | null;
      unavailable_reason: string | null;
      evidence_id: string | null;
    }>(
      db,
      sql`
        SELECT metric, observed_at, value, unavailable_reason, evidence_id
        FROM insight_points
        WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso}
        ORDER BY metric ASC, observed_at ASC
      `,
    ),
  ]);

  const baselineRow = baselineRows[0];
  const baselineProfile: ReportProfilePoint | null =
    baselineRow === undefined
      ? null
      : {
          id: baselineRow.id,
          at: iso(baselineRow.observed_at),
          followerCount: toNumber(baselineRow.follower_count),
          followingCount: toNumber(baselineRow.following_count),
          postCount: toNumber(baselineRow.post_count),
          completeness: baselineRow.completeness,
          evidenceId: baselineRow.evidence_id,
        };

  const coverage = (
    rows: Array<{ complete: number; partial: number; latest_complete_at: Date | string | null }>,
  ): ReportFollowCoverage => {
    const row = rows[0];
    return {
      complete: row === undefined ? 0 : Number(row.complete),
      partial: row === undefined ? 0 : Number(row.partial),
      latestCompleteAt: row === undefined ? null : nullableDate(row.latest_complete_at)?.toISOString() ?? null,
    };
  };

  return {
    target: owned,
    account: {
      id: account.id,
      username: account.username,
      igId: account.igId,
      displayName: account.displayName,
    },
    earliestActivityAt: ledger[0] === undefined ? null : nullableDate(ledger[0].earliest_at),
    baselineProfile,
    profilePoints: pointRows.map((r) => ({
      id: r.id,
      at: iso(r.observed_at),
      followerCount: toNumber(r.follower_count),
      followingCount: toNumber(r.following_count),
      postCount: toNumber(r.post_count),
      completeness: r.completeness,
      evidenceId: r.evidence_id,
    })),
    profileChanges: changeRows.map((r) => ({
      field: r.field,
      from: r.old_value,
      to: r.new_value,
      at: iso(r.detected_at),
      evidenceId: r.evidence_id,
    })),
    followDeltas: deltaRows.map((r) => ({
      change: r.change as ReportFollowChange,
      username: r.username,
      at: iso(r.first_seen_at),
      evidenceId: r.evidence_id,
    })),
    followersCoverage: coverage(followerCoverageRows),
    followingCoverage: coverage(followingCoverageRows),
    posts: postRows.map((r) => ({
      id: r.id,
      takenAt: iso(r.taken_at),
      caption: r.caption,
      mediaType: r.media_type,
      likeCount: toNumber(r.like_count),
      commentCount: toNumber(r.comment_count),
      evidenceId: r.evidence_id,
    })),
    stories: storyRows.map((r) => ({
      id: r.id,
      takenAt: iso(r.taken_at),
      mediaType: r.media_type,
      expiresAt: nullableDate(r.expires_at)?.toISOString() ?? null,
      evidenceId: r.evidence_id,
    })),
    comments: commentRows.map((r) => ({
      id: r.id,
      commentedAt: iso(r.commented_at),
      authorUsername: r.username,
      postId: r.post_db_id,
      body: r.body,
      evidenceId: r.evidence_id,
    })),
    mentions: mentionRows.map((r) => ({
      id: r.id,
      observedAt: iso(r.observed_at),
      mentionedUsername: r.username,
      storyId: r.story_db_id,
      evidenceId: r.evidence_id,
    })),
    tags: tagRows.map((r) => ({
      id: r.id,
      observedAt: iso(r.observed_at),
      ownerUsername: r.owner_username,
      mediaId: r.media_id,
      evidenceId: r.evidence_id,
    })),
    insights: insightRows.map((r) => ({
      metric: r.metric,
      observedAt: iso(r.observed_at),
      value: toNumber(r.value),
      unavailableReason: r.unavailable_reason,
      evidenceId: r.evidence_id,
    })),
  };
}

export interface TargetAudienceSnapshot {
  followers: {
    usernames: string[];
    complete: boolean;
    /** First COMPLETE snapshot on this side: the baseline no delta can predate. */
    baselineAt: string | null;
    takenAt: string | null;
    snapshotId: string | null;
    evidenceId: string | null;
  };
  following: {
    usernames: string[];
    complete: boolean;
    baselineAt: string | null;
    takenAt: string | null;
    snapshotId: string | null;
    evidenceId: string | null;
  };
}

/** The earliest instant any report window can address, across every surface. */
export async function getTargetLedgerStart(
  db: Database,
  userId: string,
  targetId: string,
): Promise<Date | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const rows = await earliestLedgerAt(db, owned.id, owned.igAccountId);
  return rows[0] === undefined ? null : nullableDate(rows[0].earliest_at);
}

/**
 * The latest COMPLETE roster on each side, or an explicit absence. Never falls
 * back to a PARTIAL snapshot: set algebra over a truncated roster would report
 * every unread member as "does not follow you back".
 */
export async function getTargetAudienceSnapshots(
  db: Database,
  userId: string,
  targetId: string,
): Promise<TargetAudienceSnapshot | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const [followers, following, followerBaseline, followingBaseline] = await Promise.all([
    latestCompleteFollowSnapshot(db, owned.id, "FOLLOWERS"),
    latestCompleteFollowSnapshot(db, owned.id, "FOLLOWING"),
    earliestCompleteFollowSnapshot(db, owned.id, "FOLLOWERS"),
    earliestCompleteFollowSnapshot(db, owned.id, "FOLLOWING"),
  ]);
  const [followerNames, followingNames] = await Promise.all([
    followers === null ? Promise.resolve([]) : listAllMembersForSnapshot(db, followers.id),
    following === null ? Promise.resolve([]) : listAllMembersForSnapshot(db, following.id),
  ]);
  return {
    followers: {
      usernames: followerNames,
      complete: followers !== null,
      baselineAt: followerBaseline === null ? null : followerBaseline.takenAt.toISOString(),
      takenAt: followers === null ? null : followers.takenAt.toISOString(),
      snapshotId: followers?.id ?? null,
      evidenceId: followers?.evidenceId ?? null,
    },
    following: {
      usernames: followingNames,
      complete: following !== null,
      baselineAt: followingBaseline === null ? null : followingBaseline.takenAt.toISOString(),
      takenAt: following === null ? null : following.takenAt.toISOString(),
      snapshotId: following?.id ?? null,
      evidenceId: following?.evidenceId ?? null,
    },
  };
}

export interface TargetLedgerSummaryRow {
  totalEvents: number;
  earliestAt: Date | null;
  latestAt: Date | null;
}

/** Row counts across the surfaces a report reads, for `reports` readiness. */
export async function getTargetWindowEventCount(
  db: Database,
  userId: string,
  targetId: string,
  start: Date,
  end: Date,
): Promise<number | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const rows = await query<{ total: number }>(
    db,
    sql`
      SELECT (
        (SELECT count(*) FROM profile_snapshots WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso}) +
        (SELECT count(*) FROM follow_deltas WHERE target_id = ${owned.id}
          AND first_seen_at >= ${startIso} AND first_seen_at < ${endIso}) +
        (SELECT count(*) FROM posts WHERE target_id = ${owned.id}
          AND taken_at >= ${startIso} AND taken_at < ${endIso}) +
        (SELECT count(*) FROM stories WHERE ig_account_id = ${owned.igAccountId}
          AND taken_at >= ${startIso} AND taken_at < ${endIso}) +
        (SELECT count(*) FROM post_comments pc JOIN posts p ON p.id = pc.post_db_id
          WHERE p.target_id = ${owned.id}
          AND pc.commented_at >= ${startIso} AND pc.commented_at < ${endIso}) +
        (SELECT count(*) FROM story_mentions sm JOIN stories s ON s.id = sm.story_db_id
          WHERE s.ig_account_id = ${owned.igAccountId}
          AND s.taken_at >= ${startIso} AND s.taken_at < ${endIso}) +
        (SELECT count(*) FROM tagged_media WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso}) +
        (SELECT count(*) FROM insight_points WHERE ig_account_id = ${owned.igAccountId}
          AND observed_at >= ${startIso} AND observed_at < ${endIso})
      )::int AS total
    `,
  );
  return rows[0] === undefined ? 0 : Number(rows[0].total);
}

export interface FollowActivityCounts {
  newFollowing: number | null;
  lostFollowing: number | null;
  newFollowers: number | null;
  lostFollowers: number | null;
  /** Rows in the window across the directions that were actually queried. */
  total: number | null;
}

/**
 * Delta counts for a recent-activity window, optionally scoped to one
 * direction. The excluded direction's fields stay null — a zero there would
 * say "nothing happened on that side", which is not what was measured.
 */
export async function getTargetFollowActivityCounts(
  db: Database,
  userId: string,
  targetId: string,
  start: Date,
  end: Date,
  direction?: FollowDirection,
): Promise<FollowActivityCounts | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const directionFilter = direction === undefined ? sql`` : sql`AND fd.direction = ${direction}`;
  const rows = await query<{
    new_following: number;
    lost_following: number;
    new_followers: number;
    lost_followers: number;
    total: number;
  }>(
    db,
    sql`
      SELECT
        count(*) FILTER (WHERE fd.change = 'NEW_FOLLOWING')::int AS new_following,
        count(*) FILTER (WHERE fd.change = 'LOST_FOLLOWING')::int AS lost_following,
        count(*) FILTER (WHERE fd.change = 'NEW_FOLLOWER')::int AS new_followers,
        count(*) FILTER (WHERE fd.change = 'LOST_FOLLOWER')::int AS lost_followers,
        count(*)::int AS total
      FROM follow_deltas fd
      WHERE fd.target_id = ${owned.id}
        AND fd.first_seen_at >= ${startIso} AND fd.first_seen_at < ${endIso}
        ${directionFilter}
    `,
  );
  const row = rows[0];
  const includeFollowing = direction === undefined || direction === "FOLLOWING";
  const includeFollowers = direction === undefined || direction === "FOLLOWERS";
  return {
    newFollowing: includeFollowing ? Number(row?.new_following ?? 0) : null,
    lostFollowing: includeFollowing ? Number(row?.lost_following ?? 0) : null,
    newFollowers: includeFollowers ? Number(row?.new_followers ?? 0) : null,
    lostFollowers: includeFollowers ? Number(row?.lost_followers ?? 0) : null,
    total: Number(row?.total ?? 0),
  };
}

/** SQL: a row's source belongs to one of the given evidence classes. */
function sourceClassFilter(sourceKinds: readonly string[]): SQL {
  return sql`src.kind IN (${sql.join(
    sourceKinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

export interface WindowRelationshipRank {
  username: string;
  mentions: number;
  comments: number;
  deltas: number;
  score: number;
  lastSignalAt: string;
}

/**
 * Relationship ranking scoped to one report window. Same three signals and the
 * same weights as `igtrack relationships`, but every count is bounded by the
 * window's own timestamps (story publish time for mentions, authored time for
 * comments, first-seen time for follow deltas). A historical `report --at`
 * therefore re-reads this window's signals rather than a moving 30-day view,
 * which is what keeps an old report reproducible.
 */
export async function getTargetWindowRelationships(
  db: Database,
  userId: string,
  targetId: string,
  start: Date,
  end: Date,
  sourceKinds: readonly string[],
): Promise<WindowRelationshipRank[] | null> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return null;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const kinds = sourceClassFilter(sourceKinds);
  const rows = await query<{
    username: string;
    mentions: number;
    comments: number;
    deltas: number;
    score: number;
    last_at: Date | string;
  }>(
    db,
    sql`
      SELECT username,
             sum(mentions)::int AS mentions,
             sum(comments)::int AS comments,
             sum(deltas)::int AS deltas,
             (sum(mentions) * ${RELATIONSHIP_SIGNAL_WEIGHTS.mention} +
              sum(comments) * ${RELATIONSHIP_SIGNAL_WEIGHTS.comment} +
              sum(deltas) * ${RELATIONSHIP_SIGNAL_WEIGHTS.delta})::int AS score,
             max(last_at) AS last_at
      FROM (
        SELECT ia.username, 1 AS mentions, 0 AS comments, 0 AS deltas, s.taken_at AS last_at
        FROM story_mentions sm
        JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
        JOIN stories s ON s.id = sm.story_db_id
        JOIN sources src ON src.id = s.source_id
        WHERE s.ig_account_id = ${owned.igAccountId} AND ${kinds}
          AND s.taken_at >= ${startIso} AND s.taken_at < ${endIso}
        UNION ALL
        SELECT ia.username, 0, 1, 0, pc.commented_at
        FROM post_comments pc
        JOIN posts p ON p.id = pc.post_db_id
        JOIN ig_accounts ia ON ia.id = pc.author_account_id
        JOIN sources src ON src.id = p.source_id
        WHERE p.ig_account_id = ${owned.igAccountId}
          AND pc.author_account_id <> ${owned.igAccountId}
          AND ${kinds}
          AND pc.commented_at >= ${startIso} AND pc.commented_at < ${endIso}
        UNION ALL
        SELECT ia.username, 0, 0, 1, fd.first_seen_at
        FROM follow_deltas fd
        JOIN ig_accounts ia ON ia.id = fd.ig_account_id
        JOIN follow_snapshots fs ON fs.id = fd.to_snapshot_id
        JOIN sources src ON src.id = fs.source_id
        WHERE fd.target_id = ${owned.id} AND ${kinds}
          AND fd.first_seen_at >= ${startIso} AND fd.first_seen_at < ${endIso}
      ) events
      GROUP BY username
      ORDER BY score DESC, last_at DESC, username ASC
      LIMIT 50
    `,
  );
  return rows.map((r) => ({
    username: r.username,
    mentions: Number(r.mentions),
    comments: Number(r.comments),
    deltas: Number(r.deltas),
    score: Number(r.score),
    lastSignalAt: iso(r.last_at),
  }));
}

export interface EvidenceSourceInfo {
  sourceId: string;
  observedAt: string;
}

/**
 * Source attribution for a batch of evidence ids. `export` stamps every CSV
 * row with the source that produced it; an id that does not resolve is left
 * empty rather than guessed. The source's class prefix decides `synthetic`
 * (fixture sources are synthetic; a graph/public/import source is not).
 */
export async function getEvidenceSourceInfo(
  db: Database,
  evidenceIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, EvidenceSourceInfo>> {
  const ids = [...new Set(evidenceIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return new Map();
  const rows = await query<{ id: string; source_id: string; observed_at: Date | string }>(
    db,
    sql`
      SELECT id, source_id, observed_at
      FROM evidence
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `,
  );
  return new Map(rows.map((r) => [r.id, { sourceId: r.source_id, observedAt: iso(r.observed_at) }]));
}

export interface TargetSourceRow {
  sourceId: string;
  sourceKind: string;
}

/**
 * Every source that contributed a stored row to one target, with its
 * registered kind. Aggregate surfaces (the period index, audience) print no
 * row-level evidence ids, so this is how they still name the class of
 * evidence behind their counts instead of borrowing the configured provider.
 * Same unions as the dossier's observingSources, scoped to the owner.
 */
export async function getTargetObservingSources(
  db: Database,
  userId: string,
  targetId: string,
): Promise<TargetSourceRow[]> {
  const owned = await getOwnedTarget(db, userId, targetId);
  if (owned === null) return [];
  const rows = await query<{ source_id: string; source_kind: string }>(
    db,
    sql`
      SELECT DISTINCT s.source_id, src.kind::text AS source_kind FROM (
        SELECT source_id FROM profile_snapshots WHERE ig_account_id = ${owned.igAccountId}
        UNION SELECT source_id FROM stories WHERE ig_account_id = ${owned.igAccountId}
        UNION SELECT source_id FROM insight_points WHERE ig_account_id = ${owned.igAccountId}
        UNION SELECT source_id FROM posts WHERE target_id = ${owned.id}
        UNION SELECT source_id FROM follow_snapshots WHERE target_id = ${owned.id}
        UNION SELECT source_id FROM interactions WHERE target_id = ${owned.id}
        UNION SELECT source_id FROM tagged_media WHERE ig_account_id = ${owned.igAccountId}
      ) s
      JOIN sources src ON src.id = s.source_id
      ORDER BY s.source_id
    `,
  ).catch(() => []);
  return rows.map((r) => ({ sourceId: r.source_id, sourceKind: r.source_kind }));
}

import { getDatabase, getSql } from "./db.js";
import {
  listProfileChanges,
  listProfileSnapshots,
  listRecentDeltas,
  latestFollowSnapshot,
  getSourceHealth,
  listStories,
  listMentionsForStory,
  users,
  targets,
  igAccounts,
  profileSnapshots,
} from "@igtrack/database";
import { sql, desc, eq } from "drizzle-orm";

export interface DashboardData {
  trackedCount: number;
  recentSnapshots: number;
  followChanges: number;
  storiesObserved: number;
  recentActivity: Array<{
    id: string;
    type: string;
    summary: string;
    timestamp: Date;
    targetUsername: string;
  }>;
  sourceHealth: Array<{
    sourceId: string;
    capability: string;
    status: string;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    consecutiveFailures: number;
  }>;
  queue: {
    queued: number;
    running: number;
    retryWait: number;
    failed: number;
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const db = getDatabase();
  const sqlDb = getSql();

  try {
    const [targetRows, snapshotCount, deltaCount, storyCount, sourceHealthRows, queueRows] =
      await Promise.all([
        db
          .select({
            id: targets.id,
            username: igAccounts.username,
            displayName: igAccounts.displayName,
          })
          .from(targets)
          .innerJoin(igAccounts, eq(targets.igAccountId, igAccounts.id))
          .limit(100),
        sqlDb<{ count: number }[]>`SELECT count(*)::int AS count FROM profile_snapshots`.then((r) => r[0]?.count ?? 0),
        sqlDb<{ count: number }[]>`SELECT count(*)::int AS count FROM follow_deltas`.then((r) => r[0]?.count ?? 0),
        sqlDb<{ count: number }[]>`SELECT count(*)::int AS count FROM stories`.then((r) => r[0]?.count ?? 0),
        getSourceHealth(db).catch(() => []),
        sqlDb<{ status: string; count: number }[]>`SELECT status, count(*)::int AS count FROM monitoring_jobs GROUP BY status`.then((rows) =>
          Object.fromEntries(rows.map((r) => [r.status, r.count])),
        ),
      ]);

    const activity: DashboardData["recentActivity"] = [];

    const recentChanges = await sqlDb<
      Array<{ id: string; field: string; old_value: string | null; new_value: string | null; detected_at: Date; username: string }>
    >`
      SELECT pc.id, pc.field, pc.old_value, pc.new_value, pc.detected_at, ia.username
      FROM profile_changes pc
      JOIN ig_accounts ia ON ia.id = pc.ig_account_id
      ORDER BY pc.detected_at DESC
      LIMIT 5
    `.catch(() => []);

    for (const c of recentChanges) {
      activity.push({
        id: c.id,
        type: "PROFILE_CHANGED",
        summary: `${c.username}: ${c.field} changed`,
        timestamp: c.detected_at,
        targetUsername: c.username,
      });
    }

    const recentDeltas = await sqlDb<
      Array<{ id: string; change: string; first_seen_at: Date; username: string }>
    >`
      SELECT fd.id, fd.change, fd.first_seen_at, ia.username
      FROM follow_deltas fd
      JOIN ig_accounts ia ON ia.id = fd.ig_account_id
      ORDER BY fd.first_seen_at DESC
      LIMIT 5
    `.catch(() => []);

    for (const d of recentDeltas) {
      activity.push({
        id: d.id,
        type: d.change,
        summary: `${d.username}: ${d.change.replace(/_/g, " ").toLowerCase()}`,
        timestamp: d.first_seen_at,
        targetUsername: d.username,
      });
    }

    const recentStories = await sqlDb<
      Array<{ id: string; story_id: string; taken_at: Date; username: string }>
    >`
      SELECT s.id, s.story_id, s.taken_at, ia.username
      FROM stories s
      JOIN ig_accounts ia ON ia.id = s.ig_account_id
      ORDER BY s.taken_at DESC
      LIMIT 3
    `.catch(() => []);

    for (const s of recentStories) {
      activity.push({
        id: s.id,
        type: "STORY_POSTED",
        summary: `${s.username}: story ${s.story_id}`,
        timestamp: s.taken_at,
        targetUsername: s.username,
      });
    }

    activity.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const q = queueRows as Record<string, number>;

    return {
      trackedCount: targetRows.length,
      recentSnapshots: snapshotCount,
      followChanges: deltaCount,
      storiesObserved: storyCount,
      recentActivity: activity.slice(0, 8),
      sourceHealth: sourceHealthRows.map((r) => ({
        sourceId: r.sourceId,
        capability: r.capability,
        status: r.status,
        lastSuccessAt: r.lastSuccessAt,
        lastFailureAt: r.lastFailureAt,
        consecutiveFailures: r.consecutiveFailures,
      })),
      queue: {
        queued: q.queued ?? 0,
        running: q.running ?? 0,
        retryWait: q.retry_wait ?? 0,
        failed: q.failed ?? 0,
      },
    };
  } catch {
    return {
      trackedCount: 0,
      recentSnapshots: 0,
      followChanges: 0,
      storiesObserved: 0,
      recentActivity: [],
      sourceHealth: [],
      queue: { queued: 0, running: 0, retryWait: 0, failed: 0 },
    };
  }
}

export interface TargetListItem {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
  tags: string[];
  localName: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  followerCount: number | null;
  followingCount: number | null;
  lastObserved: Date | null;
}

export async function getTargets(): Promise<TargetListItem[]> {
  const db = getDatabase();
  try {
    const rows = await db
      .select({
        id: targets.id,
        status: targets.status,
        tags: targets.tags,
        localName: targets.localName,
        username: igAccounts.username,
        displayName: igAccounts.displayName,
        isPrivate: igAccounts.isPrivate,
        isVerified: igAccounts.isVerified,
      })
      .from(targets)
      .innerJoin(igAccounts, eq(targets.igAccountId, igAccounts.id))
      .orderBy(desc(targets.createdAt));

    const items: TargetListItem[] = [];
    for (const r of rows) {
      const ig = await db
        .select({ id: igAccounts.id })
        .from(igAccounts)
        .where(eq(igAccounts.username, r.username))
        .limit(1);

      let lastObserved: Date | null = null;
      let followerCount: number | null = null;
      let followingCount: number | null = null;
      if (ig[0]) {
        const snap = await db
          .select()
          .from(profileSnapshots)
          .where(eq(profileSnapshots.igAccountId, ig[0].id))
          .orderBy(desc(profileSnapshots.observedAt))
          .limit(1);
        if (snap[0]) {
          lastObserved = snap[0].observedAt;
          followerCount = snap[0].followerCount;
          followingCount = snap[0].followingCount;
        }
      }

      items.push({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        status: r.status,
        tags: r.tags ?? [],
        localName: r.localName,
        isPrivate: r.isPrivate,
        isVerified: r.isVerified,
        followerCount,
        followingCount,
        lastObserved,
      });
    }
    return items;
  } catch {
    return [];
  }
}

export async function getTargetById(id: string) {
  const db = getDatabase();
  try {
    const rows = await db
      .select({
        target: targets,
        account: igAccounts,
      })
      .from(targets)
      .innerJoin(igAccounts, eq(targets.igAccountId, igAccounts.id))
      .where(eq(targets.id, id))
      .limit(1);
    if (!rows[0]) return null;
    const { target, account } = rows[0];
    const snapshots = await listProfileSnapshots(db, account.id, { limit: 20 }).catch(() => []);
    const changes = await listProfileChanges(db, account.id, { limit: 20 }).catch(() => []);
    const health = await getSourceHealth(db, "fixture:v1").catch(() => []);
    const storiesList = await listStories(db, account.id, { limit: 10 }).catch(() => []);
    const followFollowing = await latestFollowSnapshot(db, target.id, "FOLLOWING").catch(() => null);
    const followFollowers = await latestFollowSnapshot(db, target.id, "FOLLOWERS").catch(() => null);
    const deltas = await listRecentDeltas(db, target.id, { limit: 10 }).catch(() => []);

    let storyMentions: Array<{ storyId: string; mentions: Awaited<ReturnType<typeof listMentionsForStory>> }> = [];
    for (const s of storiesList.slice(0, 3)) {
      const ms = await listMentionsForStory(db, s.id).catch(() => []);
      storyMentions.push({ storyId: s.storyId, mentions: ms });
    }

    return {
      target,
      account,
      snapshots,
      changes,
      health,
      stories: storiesList,
      storyMentions,
      followFollowing,
      followFollowers,
      deltas,
    };
  } catch {
    return null;
  }
}

export async function getActivityFeed(limit = 20) {
  const db = getDatabase();
  const sqlDb = getSql();
  try {
    const changes = await sqlDb<
      Array<{ id: string; field: string; old_value: string | null; new_value: string | null; detected_at: Date; username: string; account_id: string }>
    >`
      SELECT pc.id, pc.field, pc.old_value, pc.new_value, pc.detected_at, ia.username, pc.ig_account_id as account_id
      FROM profile_changes pc
      JOIN ig_accounts ia ON ia.id = pc.ig_account_id
      ORDER BY pc.detected_at DESC
      LIMIT ${limit}
    `.catch(() => []);

    const deltas = await sqlDb<
      Array<{ id: string; change: string; direction: string; first_seen_at: Date; username: string; target_id: string }>
    >`
      SELECT fd.id, fd.change, fd.direction, fd.first_seen_at, ia.username, fd.target_id
      FROM follow_deltas fd
      JOIN ig_accounts ia ON ia.id = fd.ig_account_id
      ORDER BY fd.first_seen_at DESC
      LIMIT ${limit}
    `.catch(() => []);

    const storiesRows = await sqlDb<
      Array<{ id: string; story_id: string; taken_at: Date; username: string; ig_account_id: string }>
    >`
      SELECT s.id, s.story_id, s.taken_at, ia.username, s.ig_account_id
      FROM stories s
      JOIN ig_accounts ia ON ia.id = s.ig_account_id
      ORDER BY s.taken_at DESC
      LIMIT ${limit}
    `.catch(() => []);

    type FeedItem = {
      id: string;
      type: string;
      timestamp: Date;
      summary: string;
      username: string;
      confidence: string;
      category: string;
    };

    const feed: FeedItem[] = [
      ...changes.map((c) => ({
        id: c.id,
        type: "PROFILE_CHANGED",
        timestamp: c.detected_at,
        summary: `${c.username} — ${c.field} changed`,
        username: c.username,
        confidence: "HIGH",
        category: "DERIVED",
      })),
      ...deltas.map((d) => ({
        id: d.id,
        type: d.change,
        timestamp: d.first_seen_at,
        summary: `${d.username} — ${d.change.replace(/_/g, " ").toLowerCase()}`,
        username: d.username,
        confidence: "HIGH",
        category: "DERIVED",
      })),
      ...storiesRows.map((s) => ({
        id: s.id,
        type: "STORY_POSTED",
        timestamp: s.taken_at,
        summary: `${s.username} — story ${s.story_id}`,
        username: s.username,
        confidence: "HIGH",
        category: "OBSERVED",
      })),
    ];

    feed.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return feed.slice(0, limit);
  } catch {
    return [];
  }
}

export async function getRelationships(targetId: string) {
  const db = getDatabase();
  try {
    const deltas = await listRecentDeltas(db, targetId, { limit: 50 });
    const mentions = await getSql()<Array<{ username: string; count: number }>>`
      SELECT ia.username, count(*)::int AS count
      FROM story_mentions sm
      JOIN ig_accounts ia ON ia.id = sm.mentioned_account_id
      JOIN stories s ON s.id = sm.story_db_id
      JOIN targets t ON t.ig_account_id = s.ig_account_id
      WHERE t.id = ${targetId}
      GROUP BY ia.username
      ORDER BY count DESC
    `.catch(() => [] as Array<{ username: string; count: number }>);

    const map = new Map<string, { mentions: number; deltas: number }>();
    for (const m of mentions as Array<{ username: string; count: number }>) {
      map.set(m.username, { mentions: m.count, deltas: 0 });
    }
    for (const d of deltas) {
      const key = d.username;
      const cur = map.get(key) ?? { mentions: 0, deltas: 0 };
      cur.deltas += 1;
      map.set(key, cur);
    }

    const ranked = [...map.entries()]
      .map(([username, v]) => ({
        username,
        score: v.mentions * 12 + v.deltas * 8,
        signals: v,
        confidence: v.mentions + v.deltas > 2 ? "MEDIUM" : v.mentions + v.deltas > 0 ? "LOW" : "UNKNOWN",
      }))
      .sort((a, b) => b.score - a.score);

    return ranked;
  } catch {
    return [];
  }
}

export async function getEvidenceList(limit = 20) {
  const db = getDatabase();
  try {
    const rows = await getSql()<
      Array<{
        id: string;
        observation_kind: string;
        observation_id: string;
        source_id: string;
        observed_at: Date;
        captured_at: Date;
        confidence: string;
        raw_hash: string;
        normalized_hash: string | null;
      }>
    >`SELECT id, observation_kind, observation_id, source_id, observed_at, captured_at, confidence, raw_hash, normalized_hash FROM evidence ORDER BY observed_at DESC LIMIT ${limit}`.catch(
      () => [] as Array<any>,
    );
    return rows as Array<{
      id: string;
      observation_kind: string;
      observation_id: string;
      source_id: string;
      observed_at: Date;
      captured_at: Date;
      confidence: string;
      raw_hash: string;
      normalized_hash: string | null;
    }>;
  } catch {
    return [];
  }
}

export async function getDiagnostics() {
  const db = getDatabase();
  const sqlDb = getSql();
  try {
    const [migrationCheck, queueRows, healthRows, tableCounts] = await Promise.all([
      sqlDb<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'monitoring_jobs') AS exists`.then((r) => r[0]?.exists ?? false),
      sqlDb<{ status: string; count: number }[]>`SELECT status, count(*)::int AS count FROM monitoring_jobs GROUP BY status`.catch(() => []),
      getSourceHealth(db).catch(() => []),
      sqlDb<{ table: string; count: number }[]>`SELECT 'targets' AS table, count(*)::int AS count FROM targets UNION ALL SELECT 'profile_snapshots', count(*)::int FROM profile_snapshots UNION ALL SELECT 'stories', count(*)::int FROM stories UNION ALL SELECT 'follow_deltas', count(*)::int FROM follow_deltas UNION ALL SELECT 'evidence', count(*)::int FROM evidence`.catch(() => []),
    ]);

    const queue = Object.fromEntries((queueRows as Array<{ status: string; count: number }>).map((r) => [r.status, r.count]));

    return {
      database: {
        connected: true,
        migrationsApplied: migrationCheck,
        tables: tableCounts as Array<{ table: string; count: number }>,
      },
      queue: {
        queued: (queue as Record<string, number>).queued ?? 0,
        running: (queue as Record<string, number>).running ?? 0,
        retryWait: (queue as Record<string, number>).retry_wait ?? 0,
        succeeded: (queue as Record<string, number>).succeeded ?? 0,
        failed: (queue as Record<string, number>).failed ?? 0,
        cancelled: (queue as Record<string, number>).cancelled ?? 0,
      },
      sources: healthRows,
    };
  } catch (e) {
    return {
      database: { connected: false, migrationsApplied: false, tables: [] as Array<{ table: string; count: number }> },
      queue: { queued: 0, running: 0, retryWait: 0, succeeded: 0, failed: 0, cancelled: 0 },
      sources: [] as Awaited<ReturnType<typeof getSourceHealth>>,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  getEvidenceForObservation,
  getOwnedTarget,
  listProfileChanges,
  listProfileSnapshots,
  runMigrations,
  seed,
  type DatabaseHandle,
} from "@igtrack/database";
import type { ArchiveHttpResponse } from "@igtrack/ingestion";
import { createContext, type CliContext } from "../src/context.js";
import { opFullAudit } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The collecting audit, end to end.
//
// The first look at a public account has no roster baseline. What a public
// archive preserves is the profile page itself, whose embedded payload
// carries exact counts — so the first audit must return a dated COUNT series
// for the days before this deployment ever saw the account, and must say
// truthfully that identities cannot be named without a COMPLETE roster.
//
// These tests pin the promise and the invariants around it:
//   * the first audit records archived points as PUBLIC_WEB evidence;
//   * those points are PARTIAL snapshots and never produce profile_changes;
//   * the count series and its deltas are derived in the read-back;
//   * a second run deduplicates instead of duplicating;
//   * an unreachable archive is UNAVAILABLE with a reason, never EMPTY;
//   * `history: false` runs no archive phase at all.
// The archive transport is injected: no test touches the network.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";

const FIXTURE_USERNAME = "aurora.wilde"; // the account the v1 fixture set observes
const ARCHIVE_SOURCE_ID = "archive:wayback:v1";

async function probe(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function page(username: string, counts: { followers: number; following: number; posts: number }): string {
  return (
    `<html><head><script>window.__data={"username":"${username}",` +
    `"follower_count":${counts.followers},"following_count":${counts.following},` +
    `"media_count":${counts.posts}}</script></head></html>`
  );
}

function captureStamp(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function archiveResponse(body: string): ArchiveHttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

/** A transport that serves two dated captures of one account's profile. */
function archiveTransport(
  username: string,
  olderCounts: { followers: number; following: number; posts: number },
  newerCounts: { followers: number; following: number; posts: number },
): {
  fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<ArchiveHttpResponse>;
  urls: string[];
} {
  const older = captureStamp(10);
  const newer = captureStamp(3);
  const original = `https://www.instagram.com/${username}/`;
  const cdx = JSON.stringify([
    ["timestamp", "original"],
    [older, original],
    [newer, original],
  ]);
  const captures = new Map<string, string>([
    [`https://web.archive.org/web/${older}id_/${original}`, page(username, olderCounts)],
    [`https://web.archive.org/web/${newer}id_/${original}`, page(username, newerCounts)],
  ]);
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes("/cdx/search/cdx")) return archiveResponse(cdx);
      const capture = captures.get(url);
      if (capture === undefined) throw new Error(`unexpected archive URL: ${url}`);
      return archiveResponse(capture);
    },
  };
}

const databaseUp = await probe(TEST_DATABASE_URL);

describe.skipIf(!databaseUp)("collecting audit: first-look activity", () => {
  let handle: DatabaseHandle;
  let ctx: CliContext;

  beforeAll(async () => {
    handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
    await handle.sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await handle.sql.unsafe("DROP SCHEMA public CASCADE");
    await handle.sql.unsafe("CREATE SCHEMA public");
    await runMigrations(handle.db);
    await seed(handle.db);

    process.env.IGTRACK_DATABASE_URL = TEST_DATABASE_URL;
    process.env.IGTRACK_PROVIDER = "fixture";
    delete process.env.IGTRACK_USER_EMAIL;
    process.env.IGTRACK_RESEARCH_SEARCH_PROVIDER = "none";
    delete process.env.IGTRACK_RESEARCH_SEARCH_API_KEY;

    ctx = await createContext();
  });

  afterAll(async () => {
    await ctx?.close();
    await handle?.close();
  });

  it("returns a dated count series on the first audit, as PUBLIC_WEB PARTIAL snapshots", async () => {
    const transport = archiveTransport(
      FIXTURE_USERNAME,
      { followers: 12400, following: 300, posts: 145 },
      { followers: 12444, following: 305, posts: 147 },
    );
    const result = await opFullAudit(
      ctx,
      { username: FIXTURE_USERNAME, web: false, historyDays: 30 },
      { archiveFetch: transport.fetchImpl },
    );

    expect(result.activity).not.toBeNull();
    const archive = result.activity!.archive;
    expect(archive.state).toBe("OBSERVED");
    expect(archive.recorded).toBe(2);
    expect(archive.recordingErrors).toBe(0);
    expect(archive.archive.points.map((p) => p.followerCount)).toEqual([12400, 12444]);

    // The stored rows carry the archive source and observedAt = capture time.
    const target = await getOwnedTarget(ctx.db, ctx.userId, archive.targetId);
    expect(target).not.toBeNull();
    const snapshots = await listProfileSnapshots(ctx.db, target!.igAccountId!, { limit: 100 });
    const archived = snapshots.filter((row) => row.sourceId === ARCHIVE_SOURCE_ID);
    expect(archived).toHaveLength(2);
    for (const row of archived) expect(row.completeness).toBe("PARTIAL");
    // Each archived point has its own evidence row naming the capture.
    for (const row of archived) {
      expect(row.evidenceId).not.toBeNull();
      const evidence = await getEvidenceForObservation(ctx.db, "profile_snapshot", row.id);
      expect(evidence?.sourceId).toBe(ARCHIVE_SOURCE_ID);
      expect(evidence?.sourceReference).toContain("web.archive.org");
    }

    // Invariant 4: a PARTIAL count-only read never becomes a profile change.
    expect(await listProfileChanges(ctx.db, target!.igAccountId!, { limit: 100 })).toEqual([]);

    // The read-back derives the movement across the stored points, including
    // the archive points, and labels them as public web.
    const recent = result.activity!.recent;
    expect(recent).not.toBeNull();
    const archivePoints = recent!.countActivity.points.filter((p) => p.sourceId === ARCHIVE_SOURCE_ID);
    expect(archivePoints).toHaveLength(2);
    for (const point of archivePoints) expect(point.evidenceClass).toBe("PUBLIC_WEB");
    expect(recent!.countActivity.intervals.length).toBeGreaterThanOrEqual(1);
    const firstInterval = recent!.countActivity.intervals[0];
    expect(firstInterval?.followerDelta).toBe(44);

    // The fixture set supplied a COMPLETE roster baseline, so no edge was
    // recorded — EMPTY with a baseline, never UNAVAILABLE.
    expect(recent!.state).toBe("EMPTY");
    expect(result.gaps.some((gap) => gap.subject.includes("named follow / unfollow"))).toBe(false);

    const surfaces = new Map(result.surfaces.map((row) => [row.surface, row]));
    expect(surfaces.get("Public-archive profile captures")?.state).toBe("COLLECTED");
    expect(surfaces.get("Public-archive profile captures")?.items).toBe(2);
    expect(surfaces.get("Recent count movement (derived from stored observations)")?.state).toBe("COLLECTED");
    expect(surfaces.get("Recent follow / unfollow identities")?.state).toBe("EMPTY");
  });

  it("names no follower without a roster baseline, and says why, while the count series still answers", async () => {
    // A discovery-only account: the fixture set observes its profile but not
    // its rosters, which is exactly the first-look situation for a public
    // account this deployment does not own.
    const transport = archiveTransport(
      "dune.harbor",
      { followers: 210, following: 180, posts: 60 },
      { followers: 224, following: 176, posts: 61 },
    );
    const result = await opFullAudit(
      ctx,
      { username: "dune.harbor", web: false, historyDays: 30 },
      { archiveFetch: transport.fetchImpl },
    );

    expect(result.activity!.archive.state).toBe("OBSERVED");
    expect(result.activity!.archive.recorded).toBe(2);

    const recent = result.activity!.recent;
    expect(recent).not.toBeNull();
    expect(recent!.state).toBe("UNAVAILABLE");
    expect(recent!.countActivity.state).toBe("OBSERVED");
    const archivePoints = recent!.countActivity.points.filter((p) => p.sourceId === ARCHIVE_SOURCE_ID);
    expect(archivePoints.length).toBe(2);
    for (const point of archivePoints) expect(point.evidenceClass).toBe("PUBLIC_WEB");
    // 14 gained followers across the two captures is movement of a number;
    // the read-back must never present it as a named follow.
    expect(recent!.countActivity.intervals[0]?.followerDelta).toBe(14);
    expect(recent!.rows).toEqual([]);

    const gap = result.gaps.find((entry) => entry.subject.includes("named follow / unfollow"));
    expect(gap?.reason).toContain("never who moved");
    const surface = result.surfaces.find((row) => row.surface === "Recent follow / unfollow identities");
    expect(surface?.state).toBe("UNAVAILABLE");
    expect(surface?.detail).toContain("roster baseline");
  });

  it("deduplicates a repeated archive read instead of duplicating it", async () => {
    const transport = archiveTransport(
      FIXTURE_USERNAME,
      { followers: 12400, following: 300, posts: 145 },
      { followers: 12444, following: 305, posts: 147 },
    );
    const before = await opFullAudit(
      ctx,
      { username: FIXTURE_USERNAME, web: false, historyDays: 30 },
      { archiveFetch: transport.fetchImpl },
    );
    const target = await getOwnedTarget(ctx.db, ctx.userId, before.activity!.archive.targetId);
    const snapshotsBefore = (await listProfileSnapshots(ctx.db, target!.igAccountId!, { limit: 100 })).filter(
      (row) => row.sourceId === ARCHIVE_SOURCE_ID,
    );

    const again = await opFullAudit(
      ctx,
      { username: FIXTURE_USERNAME, web: false, historyDays: 30 },
      { archiveFetch: transport.fetchImpl },
    );
    expect(again.activity!.archive.recorded).toBe(0);
    expect(again.activity!.archive.deduplicated).toBe(2);

    const snapshotsAfter = (await listProfileSnapshots(ctx.db, target!.igAccountId!, { limit: 100 })).filter(
      (row) => row.sourceId === ARCHIVE_SOURCE_ID,
    );
    expect(snapshotsAfter).toHaveLength(snapshotsBefore.length);
  });

  it("reports an unreachable archive as UNAVAILABLE and never as empty history", async () => {
    const result = await opFullAudit(
      ctx,
      { username: FIXTURE_USERNAME, web: false, historyDays: 30 },
      {
        archiveFetch: async () => {
          throw new Error("network down");
        },
      },
    );

    expect(result.activity!.archive.state).toBe("UNAVAILABLE");
    expect(result.activity!.archive.archive.points).toEqual([]);
    const surface = result.surfaces.find((row) => row.surface === "Public-archive profile captures");
    expect(surface?.state).toBe("UNAVAILABLE");
    expect(surface?.detail).toContain("failure to look");
    // The reason travels with the result: a reader must be able to tell a
    // failed read from a conclusion about the account.
    expect(result.activity!.archive.archive.reason).toContain("failure to look");
  });

  it("runs no archive phase when history is disabled", async () => {
    const result = await opFullAudit(ctx, { username: FIXTURE_USERNAME, web: false, history: false });

    expect(result.activity).toBeNull();
    expect(result.surfaces.some((row) => row.surface === "Public-archive profile captures")).toBe(false);
  });
});

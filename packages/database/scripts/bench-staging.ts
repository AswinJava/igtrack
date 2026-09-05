// Phase 11b scale benchmark — real PostgreSQL, production staging path
// Run: DATABASE_URL=... pnpm exec tsx scripts/bench-staging.ts
// This harness uses the actual production APIs (stageFollowScanMembers,
// loadStagedFollowScanMembers, clearStagedFollowScanMembers, recordFollowSnapshot)
// so the measurement reflects the shipped implementation, not a fake.

import { randomUUID } from "node:crypto";
import { createDb, type Database } from "../src/index.js";
import { upsertAccount } from "../src/repositories/accounts.js";
import {
  stageFollowScanMembers,
  loadStagedFollowScanMembers,
  clearStagedFollowScanMembers,
  clearForeignFollowScanStaging,
} from "../src/repositories/follow-staging.js";
import { recordFollowSnapshot } from "../src/repositories/follows.js";
import { sql } from "drizzle-orm";
import { SourceKind } from "@igtrack/core";

// Use the same DB as Phase 11a report — real PG required.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.IGTRACK_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack";

const SCALES = [1_000, 10_000, 50_000, 100_000, 500_000] as const;
const PAGE_SIZE = 1_000;

type BenchResult = {
  scale: number;
  pageSize: number;
  pages: number;
  stageWallMs: number;
  rowsInserted: number;
  duplicateIgnored: number;
  rowsPresent: number;
  distinctPresent: number;
  loadWallMs: number;
  rssBefore: number;
  rssAfter: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  snapshotWallMs: number;
  memberInserts: number;
  cleanupWallMs: number;
  totalWallMs: number;
  dbStagingBytes: number;
  dbSnapshotBytes: number;
  dbMembersBytes: number;
};

function mu(ms: number): string {
  return `${ms.toFixed(0)} ms`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function pad(s: string, n: number): string {
  return s.padStart(n, " ");
}

async function freshDb(): Promise<{ db: any; sql: any; close: () => Promise<void> }> {
  const handle = createDb({ url: DATABASE_URL, max: 10 });
  // Do NOT DROP SCHEMA here — we want to keep migrations and not wipe prod DB tables unrelated to bench.
  // Instead we create an isolated target/job per scale with random ids and clean them after.
  return handle;
}

function genUsernames(n: number, offset = 0): string[] {
  const arr: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = offset + i + 1;
    arr.push(`member${String(idx).padStart(6, "0")}`);
  }
  return arr;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pgSize(db: any, table: string): Promise<number> {
  const rows: any = await db.execute(sql.raw(`SELECT pg_total_relation_size('${table}') as s`));
  // drizzle execute returns different shapes; fallback to sql
  try {
    const r: unknown = await db.execute(sql`SELECT pg_total_relation_size(${table}) as s`);
    if (Array.isArray(r)) return Number((r[0] as { s?: unknown } | undefined)?.s ?? 0);
    const nested = (r as { rows?: unknown }).rows;
    if (Array.isArray(nested)) return Number((nested[0] as { s?: unknown } | undefined)?.s ?? 0);
    return 0;
  } catch {
    return 0;
  }
}

async function benchOne(
  db: any,
  scale: number,
): Promise<BenchResult> {
  // Isolated context
  const userId = randomUUID();
  const targetId = randomUUID();
  const jobId = randomUUID();

  // Create minimal target context via direct inserts (avoid full createTarget flow)
  // We use upsertAccount for igAccounts, then insert into targets via sql
  // Use existing helpers where possible — direct SQL is okay for isolation.
  const username = `bench_${scale}_${Date.now()}`;
  // Create user directly
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`bench-${scale}-${Date.now()}@igtrack.test`})`);
  const ownerAcc = await upsertAccount(db as any, { username, seenAt: new Date() });
  await db.execute(
    sql`INSERT INTO targets (id, user_id, ig_account_id, status) VALUES (${targetId}, ${userId}, ${ownerAcc.id}, 'ACTIVE')`,
  );
  // Also ensure sources row for snapshot
  const source = { id: "fixture:v1", kind: SourceKind.FIXTURE, name: "bench", providerVersion: "v1" } as const;
  await db.execute(sql`INSERT INTO sources (id, kind, name) VALUES (${source.id}, ${source.kind}, ${source.name}) ON CONFLICT (id) DO NOTHING`);

  const usernames = genUsernames(scale);
  const pages = chunk(usernames, PAGE_SIZE);
  const entriesPerPage = pages.map((p) => p.map((u) => ({ username: u })));

  const memBeforeStage = process.memoryUsage();

  const stageStart = performance.now();
  let totalInserted = 0;
  let totalAttempted = 0;
  for (const entries of entriesPerPage) {
    totalAttempted += entries.length;
    const n = await stageFollowScanMembers(db as any, { jobId, targetId, entries });
    totalInserted += n;
  }
  const stageWallMs = performance.now() - stageStart;
  const duplicateIgnored = totalAttempted - totalInserted;

  // Verify staging counts
  const countRes: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobId}`);
  const rowsPresent = Number(countRes.rows?.[0]?.c ?? countRes[0]?.c ?? 0);
  const distinctRes: any = await db.execute(
    sql`SELECT count(DISTINCT username_lower) as c FROM follow_scan_staging WHERE job_id = ${jobId}`,
  );
  const distinctPresent = Number(distinctRes.rows?.[0]?.c ?? distinctRes[0]?.c ?? 0);

  // Load benchmark
  const memBeforeLoad = process.memoryUsage();
  const loadStart = performance.now();
  const loaded = await loadStagedFollowScanMembers(db as any, jobId);
  const loadWallMs = performance.now() - loadStart;
  const memAfterLoad = process.memoryUsage();

  // Snapshot construction — measure separate phases
  // We will call recordFollowSnapshot which does: ensureSource, dedupe check, loop upsertAccount, insert snapshot, insert members, evidence
  // To split timings, we measure whole snapshot path as one; finer splitting would require instrumenting internals.
  const snapshotStart = performance.now();
  const snapshotRes = await recordFollowSnapshot(db as any, {
    targetId,
    direction: "FOLLOWERS" as const,
    source,
    page: {
      entries: loaded.map((m) => ({ username: m.username, ...(m.igId ? { igId: m.igId } : {}) })),
      complete: true,
      meta: { category: "OBSERVED" as const, confidence: "HIGH" as const, observedAt: new Date().toISOString() },
    },
  });
  const snapshotWallMs = performance.now() - snapshotStart;

  // Verify final snapshot member count
  const snapCountRes: any = await db.execute(
    sql`SELECT count(*) as c FROM follow_snapshot_members WHERE snapshot_id = ${snapshotRes.snapshot.id}`,
  );
  const memberInserts = Number(snapCountRes.rows?.[0]?.c ?? snapCountRes[0]?.c ?? 0);

  // DB sizes (measured)
  let dbStagingBytes = 0;
  let dbSnapshotBytes = 0;
  let dbMembersBytes = 0;
  try {
    const s1: any = await db.execute(sql`SELECT pg_total_relation_size('follow_scan_staging') as s`);
    dbStagingBytes = Number(s1.rows?.[0]?.s ?? s1[0]?.s ?? 0);
    const s2: any = await db.execute(sql`SELECT pg_total_relation_size('follow_snapshots') as s`);
    dbSnapshotBytes = Number(s2.rows?.[0]?.s ?? s2[0]?.s ?? 0);
    const s3: any = await db.execute(sql`SELECT pg_total_relation_size('follow_snapshot_members') as s`);
    dbMembersBytes = Number(s3.rows?.[0]?.s ?? s3[0]?.s ?? 0);
  } catch {}

  // Cleanup benchmark (should be 0 after)
  const cleanupStart = performance.now();
  await clearStagedFollowScanMembers(db as any, jobId);
  const cleanupWallMs = performance.now() - cleanupStart;
  const afterClean: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobId}`);
  const afterCleanCount = Number(afterClean.rows?.[0]?.c ?? afterClean[0]?.c ?? 0);
  if (afterCleanCount !== 0) throw new Error(`cleanup failed for ${scale}: ${afterCleanCount} rows remain`);

  // Remove target (cascades snapshots/members/staging) and user
  await db.execute(sql`DELETE FROM targets WHERE id = ${targetId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  // Remove bench igAccounts that were created for members (they remain as shared registry; we keep them to avoid cascade issues, but they are orphaned — acceptable for bench)
  // To keep DB clean, delete members that are orphaned? We keep as is; they are part of shared registry.

  const totalWallMs = stageWallMs + loadWallMs + snapshotWallMs + cleanupWallMs;

  return {
    scale,
    pageSize: PAGE_SIZE,
    pages: pages.length,
    stageWallMs,
    rowsInserted: totalInserted,
    duplicateIgnored,
    rowsPresent,
    distinctPresent,
    loadWallMs,
    rssBefore: memBeforeLoad.rss,
    rssAfter: memAfterLoad.rss,
    heapUsedBefore: memBeforeLoad.heapUsed,
    heapUsedAfter: memAfterLoad.heapUsed,
    snapshotWallMs,
    memberInserts,
    cleanupWallMs,
    totalWallMs,
    dbStagingBytes,
    dbSnapshotBytes,
    dbMembersBytes,
  };
}

async function duplicateBench(db: any): Promise<{ ok: boolean; detail: string }> {
  const userId = randomUUID();
  const targetId = randomUUID();
  const jobId = randomUUID();
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`dup-${Date.now()}@igtrack.test`})`);
  const ownerAcc = await upsertAccount(db as any, { username: `dup_owner_${Date.now()}`, seenAt: new Date() });
  await db.execute(sql`INSERT INTO targets (id, user_id, ig_account_id, status) VALUES (${targetId}, ${userId}, ${ownerAcc.id}, 'ACTIVE')`);

  const scale = 10_000;
  const usernames = genUsernames(scale);
  const pages = chunk(usernames, 1_000);
  // Stage page1, page2, page2 again, page3, page1 again
  const order = [0, 1, 1, 2, 0].map((idx) => pages[idx]!);
  for (const p of order) {
    await stageFollowScanMembers(db as any, { jobId, targetId, entries: p.map((u) => ({ username: u })) });
  }
  const cnt: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobId}`);
  const n = Number(cnt.rows?.[0]?.c ?? cnt[0]?.c ?? 0);
  const distinct: any = await db.execute(sql`SELECT count(DISTINCT username_lower) as c FROM follow_scan_staging WHERE job_id = ${jobId}`);
  const d = Number(distinct.rows?.[0]?.c ?? distinct[0]?.c ?? 0);
  // Expected unique = pages 0+1+2 = 3000 (since duplicate pages deduped)
  const expected = 3_000;
  const ok = n === expected && d === expected;
  await clearStagedFollowScanMembers(db as any, jobId);
  await db.execute(sql`DELETE FROM targets WHERE id = ${targetId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  return { ok, detail: `expected ${expected}, got count=${n} distinct=${d} dupPages=[1,0] deduplicated` };
}

async function reorderedBench(db: any): Promise<{ ok: boolean; detail: string }> {
  const make = async (order: string) => {
    const userId = randomUUID();
    const targetId = randomUUID();
    const jobId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`reorder-${order}-${Date.now()}@igtrack.test`})`);
    const ownerAcc = await upsertAccount(db as any, { username: `reorder_${order}_${Date.now()}`, seenAt: new Date() });
    await db.execute(sql`INSERT INTO targets (id, user_id, ig_account_id, status) VALUES (${targetId}, ${userId}, ${ownerAcc.id}, 'ACTIVE')`);
    const usernames = genUsernames(3_000);
    const pages = chunk(usernames, 1_000);
    let idxs: number[];
    if (order === "ABC") idxs = [0, 1, 2];
    else if (order === "CAB") idxs = [2, 0, 1];
    else idxs = [1, 2, 0];
    for (const i of idxs) await stageFollowScanMembers(db as any, { jobId, targetId, entries: pages[i]!.map((u) => ({ username: u })) });
    const cnt: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobId}`);
    const n = Number(cnt.rows?.[0]?.c ?? cnt[0]?.c ?? 0);
    const loaded = await loadStagedFollowScanMembers(db as any, jobId);
    const set = new Set(loaded.map((m) => m.username.toLowerCase()));
    await clearStagedFollowScanMembers(db as any, jobId);
    await db.execute(sql`DELETE FROM targets WHERE id = ${targetId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    return { n, set, order };
  };
  const a = await make("ABC");
  const b = await make("CAB");
  const c = await make("BCA");
  const ok = a.n === 3000 && b.n === 3000 && c.n === 3000 && a.set.size === 3000 && b.set.size === 3000 && c.set.size === 3000 && [...a.set].every((x) => b.set.has(x) && c.set.has(x));
  return { ok, detail: `ABC=${a.n} CAB=${b.n} BCA=${c.n}, sets equal=${ok}` };
}

async function crossJobBench(db: any): Promise<{ ok: boolean; detail: string }> {
  const userId = randomUUID();
  const targetId = randomUUID();
  const jobA = randomUUID();
  const jobB = randomUUID();
  await db.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`cross-${Date.now()}@igtrack.test`})`);
  const ownerAcc = await upsertAccount(db as any, { username: `cross_${Date.now()}`, seenAt: new Date() });
  await db.execute(sql`INSERT INTO targets (id, user_id, ig_account_id, status) VALUES (${targetId}, ${userId}, ${ownerAcc.id}, 'ACTIVE')`);
  await stageFollowScanMembers(db as any, { jobId: jobA, targetId, entries: genUsernames(1_000).map((u) => ({ username: u })) });
  await stageFollowScanMembers(db as any, { jobId: jobB, targetId, entries: genUsernames(1_000, 1_000).map((u) => ({ username: u })) });
  // Simulate scan start for jobB — should clear foreign (jobA) staging
  await clearForeignFollowScanStaging(db as any, { targetId, keepJobId: jobB });
  const cntA: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobA}`);
  const nA = Number(cntA.rows?.[0]?.c ?? cntA[0]?.c ?? 0);
  const cntB: any = await db.execute(sql`SELECT count(*) as c FROM follow_scan_staging WHERE job_id = ${jobB}`);
  const nB = Number(cntB.rows?.[0]?.c ?? cntB[0]?.c ?? 0);
  // jobA should be 0 after foreign clear, jobB 1000
  const ok = nA === 0 && nB === 1000;
  await clearStagedFollowScanMembers(db as any, jobB);
  // jobA already cleared
  await db.execute(sql`DELETE FROM targets WHERE id = ${targetId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  return { ok, detail: `jobA after clearForeign=${nA} (expected 0), jobB=${nB} (expected 1000)` };
}

async function main() {
  console.log("Bench staging — real PG:", DATABASE_URL.replace(/:[^:@]+@/, ":***@"));
  const handle = createDb({ url: DATABASE_URL, max: 20 });
  const db: any = handle.db;

  const sys = {
    node: process.version,
    platform: process.platform,
    cpus: (await import("node:os")).cpus().length,
  };
  console.log(`Node ${sys.node} on ${sys.platform} cpus=${sys.cpus} at ${new Date().toISOString()}`);

  // Quick health
  await handle.sql`SELECT 1`;
  console.log("DB ok");

  const results: BenchResult[] = [];
  for (const scale of SCALES) {
    console.log(`\n=== scale ${scale} pageSize ${PAGE_SIZE} pages ${Math.ceil(scale / PAGE_SIZE)} ===`);
    const mem0 = process.memoryUsage();
    console.log(`mem before ${bytes(mem0.rss)} rss heap ${bytes(mem0.heapUsed)}`);
    const t0 = performance.now();
    const r = await benchOne(db, scale);
    const t1 = performance.now();
    console.log(
      `stage ${mu(r.stageWallMs)} rows ${r.rowsInserted}/${scale} dupIgnored ${r.duplicateIgnored} present ${r.rowsPresent} distinct ${r.distinctPresent} load ${mu(r.loadWallMs)} snapshot ${mu(r.snapshotWallMs)} members ${r.memberInserts} cleanup ${mu(r.cleanupWallMs)} total ${mu(r.totalWallMs)} (bench loop ${mu(t1 - t0)})`,
    );
    console.log(`rss delta ${(r.rssAfter - r.rssBefore) / 1024 / 1024} MB heap delta ${(r.heapUsedAfter - r.heapUsedBefore) / 1024 / 1024} MB`);
    console.log(`db sizes staging ${bytes(r.dbStagingBytes)} snapshots ${bytes(r.dbSnapshotBytes)} members ${bytes(r.dbMembersBytes)}`);
    if (r.rowsPresent !== scale || r.distinctPresent !== scale || r.memberInserts !== scale) {
      console.error(`INTEGRITY FAIL for ${scale}: rowsPresent ${r.rowsPresent} distinct ${r.distinctPresent} members ${r.memberInserts} expected ${scale}`);
      process.exitCode = 1;
    }
    results.push(r);
    // Brief pause to let PG settle
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\n=== duplicate-page correctness ===");
  const dup = await duplicateBench(db);
  console.log(`${dup.ok ? "PASS" : "FAIL"} ${dup.detail}`);
  if (!dup.ok) process.exitCode = 1;

  console.log("\n=== reordered-page set equivalence ===");
  const reorder = await reorderedBench(db);
  console.log(`${reorder.ok ? "PASS" : "FAIL"} ${reorder.detail}`);
  if (!reorder.ok) process.exitCode = 1;

  console.log("\n=== cross-job isolation ===");
  const cross = await crossJobBench(db);
  console.log(`${cross.ok ? "PASS" : "FAIL"} ${cross.detail}`);
  if (!cross.ok) process.exitCode = 1;

  console.log("\n=== summary markdown ===");
  console.log("| Scale | Stage | Load | Snapshot | Total | RSS delta MB | DB staging | Members | Result |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    const rssDeltaMb = ((r.rssAfter - r.rssBefore) / 1024 / 1024).toFixed(1);
    const ok = r.rowsPresent === r.scale && r.memberInserts === r.scale ? "PASS" : "FAIL";
    console.log(
      `| ${r.scale.toLocaleString()} | ${mu(r.stageWallMs)} | ${mu(r.loadWallMs)} | ${mu(r.snapshotWallMs)} | ${mu(r.totalWallMs)} | ${rssDeltaMb} | ${bytes(r.dbStagingBytes)} | ${r.memberInserts.toLocaleString()} | ${ok} |`,
    );
  }

  // Emit JSON for report ingestion
  console.log("\n__JSON__");
  console.log(JSON.stringify({ sys, results, dup, reorder, cross }, null, 2));

  await handle.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

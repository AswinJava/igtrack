// Latency bench for the agent-facing research reads over a synthetic fixture
// workload on a real local Postgres. Run: pnpm exec tsx scripts/bench-research.ts
// Uses an isolated `igtrack_bench` database, same pattern as perf-release.ts.
//
// This measures the read surfaces an agent polls during an investigation:
// claims list, research report, and plan. Nothing here observes a live account.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  addClaim,
  createDb,
  listTargetsForUser,
  runMigrations,
  seed,
} from "../packages/database/src/index.js";
import type { FetchResult, ResearchFetcher } from "../packages/ingestion/src/index.js";
import { createContext } from "../apps/cli/src/context.js";
import { opClaimList, opPlan, opResearch, opResearchRun } from "../apps/cli/src/tools.js";

const SERVER_URL =
  process.env.IGTRACK_TEST_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test";
const BENCH_URL = SERVER_URL.replace(/\/[^/]*$/, "/igtrack_bench");
const TARGET = "target_a";

const CLAIM_PREDICATES = [
  "ORGANIZATION_NAME",
  "ORGANIZATION_KIND",
  "LOCATION_STATED",
  "INDUSTRY_OR_FIELD",
  "CONTACT_CHANNEL",
  "INSTITUTIONAL_AFFILIATION_STATED",
  "PRODUCT_OR_SERVICE",
  "RELATED_ACCOUNT_ASSERTED",
] as const;

function quantiles(samples: number[]): {
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (n: number): number => Number(n.toFixed(2));
  return {
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function bench(
  fn: () => Promise<unknown>,
  iterations = 40,
  warmup = 5,
): Promise<ReturnType<typeof quantiles> & { iterations: number }> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return { iterations, ...quantiles(samples) };
}

async function main(): Promise<void> {
  const bootstrap = createDb({ url: SERVER_URL, max: 1 });
  await bootstrap.sql.unsafe(`CREATE DATABASE igtrack_bench`).catch(() => {});
  await bootstrap.close();

  const handle = createDb({ url: BENCH_URL, max: 5 });
  await handle.sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.sql.unsafe(`DROP SCHEMA public CASCADE`);
  await handle.sql.unsafe(`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  await seed(handle.db);

  process.env.IGTRACK_DATABASE_URL = BENCH_URL;
  process.env.IGTRACK_PROVIDER = "fixture";
  delete process.env.IGTRACK_USER_EMAIL;
  const ctx = await createContext();
  try {
    const targets = await listTargetsForUser(ctx.db, ctx.userId);
    const target = targets.find((t) => t.username === TARGET);
    if (target === undefined) throw new Error(`seed did not create ${TARGET}`);

    // A worked research session: 8 predicates x 8 sourced rows.
    for (const predicate of CLAIM_PREDICATES) {
      for (let i = 0; i < 8; i += 1) {
        await addClaim(ctx.db, {
          userId: ctx.userId,
          targetId: target.id,
          predicate,
          value: `Bench value ${predicate} ${i}`,
          sourceKind: "WEB",
          sourceUrl: `https://bench-${i % 4}.example.com/doc/${i}`,
          excerpt: `Benchmark workload excerpt ${predicate} ${i}.`,
          retrievedAt: new Date(Date.now() - (i % 5) * 86_400_000),
        });
      }
    }

    const results = {
      workload: {
        target: TARGET,
        claims: CLAIM_PREDICATES.length * 8,
        note: "synthetic fixture rows on a local Postgres; no live account was observed",
      },
      bench: {
        claimsList: await bench(() => opClaimList(ctx, { target: TARGET, includeRetracted: true })),
        research: await bench(() => opResearch(ctx, { target: TARGET })),
        plan: await bench(() => opPlan(ctx, { target: TARGET })),
        // The engine path: plan → (scripted) fetch → extract → validate →
        // store → run record. Transport is injected, so this measures the
        // engine's own cost, not a network's. Unique URLs per run keep every
        // iteration a full fetch (no 24h freshness reuse), so the p95 is the
        // worst-case single run, not the reuse shortcut.
        researchRun: await bench(
          () => {
            const fetcher: Pick<ResearchFetcher, "fetchPage"> = {
              fetchPage: async (url: string): Promise<FetchResult> => ({
                ok: true,
                finalUrl: url,
                httpStatus: 200,
                contentType: "text/html; charset=utf-8",
                body: `<!doctype html><html><head><title>Bench Org</title>
<meta property="og:site_name" content="Bench Org">
<script type="application/ld+json">{"@type":"Organization","name":"Bench Org","address":{"addressLocality":"Lisbon"},"knowsAbout":"Bench work"}</script>
</head><body>structured fields only</body></html>`,
                byteSize: 512,
                fetchedAt: new Date(),
                redirectsFollowed: 0,
                robotsChecked: false,
              }),
            };
            let n = 0;
            return opResearchRun(
              ctx,
              {
                target: TARGET,
                question: "Who runs this account?",
                urls: Array.from(
                  { length: 4 },
                  () => `https://bench-run-${(n += 1)}.example.com/about`,
                ),
              },
              { fetcher },
            );
          },
          20,
          3,
        ),
      },
      cliStartup: null as unknown,
    };

    // Process boot + help render. The MCP process pays this once per session.
    // Launched through the same tsx shim `pnpm igtrack` uses (pnpm itself adds
    // its own bootstrap cost on top, which is not this CLI's to measure).
    const tsxShim = join("node_modules", ".bin", process.platform === "win32" ? "tsx.CMD" : "tsx");
    const spawned = (): { ms: number; status: number | null } => {
      const command =
        process.platform === "win32"
          ? `"${tsxShim}" apps/cli/src/main.ts help`
          : `${tsxShim} apps/cli/src/main.ts help`;
      const start = performance.now();
      const result = spawnSync(command, { shell: true, encoding: "utf8" });
      return { ms: performance.now() - start, status: result.status };
    };
    const probe = spawned();
    if (probe.status !== 0) {
      results.cliStartup = {
        error: "CLI startup probe exited non-zero; timing withheld",
        status: probe.status,
      };
    } else {
      const samples = [probe.ms - 0];
      for (let i = 0; i < 4; i += 1) samples.push(spawned().ms);
      results.cliStartup = { iterations: samples.length, ...quantiles(samples) };
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await ctx.close();
    await handle.close();
  }
}

await main();

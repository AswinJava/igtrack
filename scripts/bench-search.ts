// ---------------------------------------------------------------------------
// Search-provider benchmark (Phase 2, D74). Run:
//   pnpm exec tsx scripts/bench-search.ts [--handles sel_win_,nasa] [--json]
//
// Measures the REAL audit pipeline (handleSearchQueries → provider →
// canonical dedup → ranking → fetch gate → relevance gate) once per
// handle × provider, and prints one row per run:
//
//   results   raw results across all queries
//   unique    canonical-URL-deduplicated candidates (dedup = 1 - unique/results)
//   summary   candidates whose url/title/snippet names the exact handle
//   fetched / skip / fail   document outcomes (skip = policy, never requested)
//   naming    fetched pages that name the exact handle in URL/title/body
//   facts     third-party statements that survived extraction + the registry
//   ms        per-query search latency (p50 / max)
//
// LIVE by design: it makes real HTTP requests through the same code paths the
// CLI uses, bounded at 4 queries and 5 documents per run. Brave is measured
// only when IGTRACK_RESEARCH_SEARCH_API_KEY is present; without a key the row
// says so instead of inventing numbers. Unit/mocked regression lives in
// packages/ingestion/test and apps/cli/test — this script is for measurement.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import {
  researchSearchProviderFromEnv,
  type ResearchSearchProvider,
  type SearchOutcome,
} from "../packages/ingestion/src/index.js";
import { opAuditWebProbe, type AuditWebReport } from "../apps/cli/src/tools.js";

interface TimedProvider extends ResearchSearchProvider {
  readonly timings: number[];
}

function timed(provider: ResearchSearchProvider): TimedProvider {
  const timings: number[] = [];
  return {
    name: provider.name,
    timings,
    async search(query: string, limit: number): Promise<SearchOutcome> {
      const started = performance.now();
      try {
        return await provider.search(query, limit);
      } finally {
        timings.push(performance.now() - started);
      }
    },
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!);
}

interface Row {
  handle: string;
  provider: string;
  queries: number;
  results: number;
  unique: number;
  dedupRate: string;
  summaryHits: number;
  fetched: number;
  policySkipped: number;
  failed: number;
  namingPages: number;
  facts: number;
  outcomeClass: AuditWebReport["outcomeClass"];
  searchP50Ms: number;
  searchMaxMs: number;
}

async function runOne(handle: string, provider: ResearchSearchProvider): Promise<Row> {
  const wrapped = timed(provider);
  const report = await opAuditWebProbe({ username: handle }, { search: wrapped });
  const results = report.search.perQuery.reduce((total, entry) => total + entry.results, 0);
  return {
    handle,
    provider: provider.name,
    queries: report.search.queries.length,
    results,
    unique: report.search.candidateUrls,
    dedupRate: results === 0 ? "n/a" : `${Math.round((1 - report.search.candidateUrls / results) * 100)}%`,
    summaryHits: report.search.relevantCandidates,
    fetched: report.totals.fetched,
    policySkipped: report.totals.skipped,
    failed: report.totals.failed,
    namingPages: report.totals.pagesNamingHandle,
    facts: report.totals.facts,
    outcomeClass: report.outcomeClass,
    searchP50Ms: quantile(wrapped.timings, 0.5),
    searchMaxMs: quantile(wrapped.timings, 1),
  };
}

function parseArgs(argv: readonly string[]): { handles: string[]; json: boolean } {
  const handlesFlag = argv.indexOf("--handles");
  const handles =
    handlesFlag >= 0 && argv[handlesFlag + 1] !== undefined
      ? argv[handlesFlag + 1]!.split(",").map((handle) => handle.trim()).filter((handle) => handle !== "")
      : ["sel_win_", "nasa"];
  return { handles, json: argv.includes("--json") };
}

async function main(): Promise<void> {
  const { handles, json } = parseArgs(process.argv.slice(2));
  const providers: ResearchSearchProvider[] = [researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "freeserp" })];
  const apiKey = (process.env["IGTRACK_RESEARCH_SEARCH_API_KEY"] ?? "").trim();
  if (apiKey !== "") {
    providers.push(researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "brave", IGTRACK_RESEARCH_SEARCH_API_KEY: apiKey }));
  }

  const rows: Row[] = [];
  for (const handle of handles) {
    for (const provider of providers) {
      rows.push(await runOne(handle, provider));
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
    return;
  }

  const header = [
    "handle", "provider", "queries", "results", "unique", "dedup", "summary-hits",
    "fetched", "policy-skip", "failed", "naming-pages", "facts", "outcome", "p50ms", "maxms",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) =>
      `| ${[
        row.handle, row.provider, String(row.queries), String(row.results), String(row.unique),
        row.dedupRate, String(row.summaryHits), String(row.fetched), String(row.policySkipped),
        String(row.failed), String(row.namingPages), String(row.facts), row.outcomeClass,
        String(row.searchP50Ms), String(row.searchMaxMs),
      ].join(" | ")} |`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (apiKey === "") {
    process.stdout.write(
      "\nbrave: NOT MEASURED — IGTRACK_RESEARCH_SEARCH_API_KEY is not set (no key invented, no row fabricated).\n",
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`bench-search failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

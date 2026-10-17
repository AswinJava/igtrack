// ---------------------------------------------------------------------------
// Phase-3 audit evaluation benchmark. Run:
//   pnpm bench:audit                                    # all cases, live, freeserp (+brave when keyed)
//   pnpm bench:audit --cases nasa,nasaa
//   pnpm bench:audit --cases nasa,natgeo --record apps/cli/test/fixtures/bench
//   pnpm bench:audit --saved apps/cli/test/fixtures/bench   # offline replay
//   pnpm bench:audit --json
// (Invoke through the package script or tsx directly — `pnpm exec tsx` on
// Windows has been observed to swallow the script's own flags.)
//
// Measures the REAL audit pipeline (opAuditWebProbe) once per case × provider
// over the evaluation set in apps/cli/src/bench.ts: candidate precision,
// retrieval, exact-handle pages, SUPPORT-checked claims (every fact re-verified
// against the retrieved body), attribution strength, duplicates, failures and
// latency — plus whether the case's ground-truth expectation held. Raw fact
// count is reported but never used as the success verdict (mission rule).
//
// Three layers stay separate by design:
//   mocked   — vitest suites (packages/ingestion/test, apps/cli/test), never network;
//   saved    — --saved replays a recording (search answers + fetched pages)
//              deterministically, no network;
//   live     — this script's default, real HTTP, bounded (4 queries × 5 docs
//              per case, sequential).
// Brave rows appear only when IGTRACK_RESEARCH_SEARCH_API_KEY is set — never
// invented. The script is NEVER part of `pnpm test`.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  ResearchFetcher,
  researchSearchProviderFromEnv,
  type ResearchSearchProvider,
} from "../packages/ingestion/src/index.js";
import {
  opAuditWebProbe,
  type AuditWebReport,
} from "../apps/cli/src/tools.js";
import {
  BENCH_CASES,
  ReplayFetcher,
  ReplaySearchProvider,
  captureFetcher,
  captureSearch,
  computeBenchMetrics,
  type BenchCase,
  type BenchMetrics,
  type BenchRecording,
} from "../apps/cli/src/bench.js";

interface RunRow {
  metrics: BenchMetrics;
  mode: "live" | "saved";
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function num(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function findCase(handle: string): BenchCase | undefined {
  return BENCH_CASES.find((entry) => entry.handle === handle);
}

async function runLive(
  handle: string,
  benchCase: BenchCase | undefined,
  provider: ResearchSearchProvider,
): Promise<{ row: RunRow; recording: BenchRecording }> {
  const capturedSearch = captureSearch(provider);
  const capturedFetch = captureFetcher(new ResearchFetcher());
  const report: AuditWebReport = await opAuditWebProbe(
    { username: handle },
    { search: capturedSearch.provider, fetcher: capturedFetch.fetcher },
  );
  const metrics = computeBenchMetrics({
    report,
    pages: capturedFetch.pages,
    searches: capturedSearch.searches,
    handle,
    ...(benchCase !== undefined ? { benchCase } : {}),
  });
  const recording: BenchRecording = {
    handle,
    provider: provider.name,
    recordedAt: new Date().toISOString(),
    searches: capturedSearch.searches.map((entry) => ({
      query: entry.query,
      results: entry.outcome.results,
      error: entry.outcome.error,
      unavailableReason: entry.outcome.unavailableReason,
      ...(entry.outcome.note !== undefined ? { note: entry.outcome.note } : {}),
    })),
    pages: capturedFetch.pages.map((page) => ({
      requestedUrl: page.requestedUrl,
      result: page.result,
    })),
  };
  return { row: { metrics, mode: "live" }, recording };
}

async function runSaved(recording: BenchRecording, benchCase: BenchCase | undefined): Promise<RunRow> {
  const capturedSearch = captureSearch(new ReplaySearchProvider(recording));
  const capturedFetch = captureFetcher(new ReplayFetcher(recording));
  const handle = recording.handle;
  const report = await opAuditWebProbe(
    { username: handle },
    { search: capturedSearch.provider, fetcher: capturedFetch.fetcher },
  );
  return {
    mode: "saved",
    metrics: computeBenchMetrics({
      report,
      pages: capturedFetch.pages,
      searches: capturedSearch.searches,
      handle,
      ...(benchCase !== undefined ? { benchCase } : {}),
    }),
  };
}

function loadRecordings(dir: string): BenchRecording[] {
  const entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  return entries.map((name) => {
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as BenchRecording;
    if (
      typeof parsed.handle !== "string" ||
      !Array.isArray(parsed.searches) ||
      !Array.isArray(parsed.pages)
    ) {
      throw new Error(`${name} is not a BenchRecording`);
    }
    return parsed;
  });
}

function printTables(rows: RunRow[]): void {
  const headA = [
    "handle", "category", "provider", "mode", "queries", "results", "unique", "dedup",
    "cand-prec", "gt-cand", "gt-fetch", "naming", "page-prec", "host/topical", "outcome", "expect",
  ];
  const headB = [
    "handle", "facts", "unattrib", "support", "unique-stmt", "dup-rate", "corr/conf/single",
    "exp-found", "failed", "fail-rate", "search-p50", "search-max", "fetch-p50", "fetch-max",
  ];
  const rowA = (m: BenchMetrics, mode: string): string =>
    `| ${[
      m.handle, m.category ?? "?", m.provider, mode, String(m.queries), String(m.results),
      String(m.uniqueCandidates), pct(m.dedupRate), pct(m.candidatePrecision),
      `${m.gtPagesInCandidates}/${m.gtPagesTotal}`, `${m.gtPagesFetched}/${m.gtPagesTotal}`,
      String(m.namingPages), pct(m.pagePrecision),
      `${m.attributionStrong}/${m.attributionWeak}`, m.outcomeClass,
      m.expectation === null ? "—" : m.expectationMet === null ? "REVIEW" : m.expectationMet ? "MET" : "MISSED",
    ].join(" | ")} |`;
  const rowB = (m: BenchMetrics): string =>
    `| ${[
      m.handle, String(m.facts), String(m.unattributed), pct(m.supportRate), String(m.uniqueStatements), pct(m.duplicateRate),
      `${m.relationsCorroborated}/${m.relationsConflicted}/${m.relationsSingleSource}`,
      `${m.expectedVerifiedFound}/${m.expectedVerified}`, String(m.failed),
      pct(m.retrievalFailureRate), String(m.searchP50Ms), String(m.searchMaxMs),
      String(m.fetchP50Ms), String(m.fetchMaxMs),
    ].join(" | ")} |`;
  const table = (head: string[], body: string[]): string =>
    [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body].join("\n");

  process.stdout.write(`\n### Discovery and retrieval\n\n${table(headA, rows.map((r) => rowA(r.metrics, r.mode)))}\n`);
  process.stdout.write(`\n### Extraction quality (facts are NEVER the verdict — support and precision are)\n\n${table(headB, rows.map((r) => rowB(r.metrics)))}\n`);

  const weak = rows.filter((r) => r.metrics.unsupported.length > 0);
  if (weak.length > 0) {
    process.stdout.write("\n### Facts that failed the support check (inspect these first)\n\n");
    for (const row of weak) {
      for (const item of row.metrics.unsupported) {
        process.stdout.write(`- ${row.metrics.handle}: ${item.predicate} = "${item.value}" (${item.field}) ← ${item.sourceUrl}\n`);
      }
    }
  }
}

function parseArgs(argv: readonly string[]): {
  cases: string[] | null;
  json: boolean;
  recordDir: string | null;
  savedDir: string | null;
} {
  const flag = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : null;
  };
  const casesFlag = flag("--cases");
  return {
    cases: casesFlag === null ? null : casesFlag.split(",").map((h) => h.trim()).filter((h) => h !== ""),
    json: argv.includes("--json"),
    recordDir: flag("--record"),
    savedDir: flag("--saved"),
  };
}

async function main(): Promise<void> {
  const { cases, json, recordDir, savedDir } = parseArgs(process.argv.slice(2));
  const rows: RunRow[] = [];

  if (savedDir !== null) {
    // Saved-response layer: deterministic, offline, answers only what was captured.
    for (const recording of loadRecordings(savedDir)) {
      if (cases !== null && !cases.includes(recording.handle)) continue;
      rows.push(await runSaved(recording, findCase(recording.handle)));
    }
    if (rows.length === 0) throw new Error(`no recordings in ${savedDir} matched --cases`);
  } else {
    // Live layer: real providers, bounded (the probe enforces 4 queries × cap docs).
    const providers: ResearchSearchProvider[] = [
      researchSearchProviderFromEnv({ IGTRACK_RESEARCH_SEARCH_PROVIDER: "freeserp" }),
    ];
    const apiKey = (process.env["IGTRACK_RESEARCH_SEARCH_API_KEY"] ?? "").trim();
    if (apiKey !== "") {
      providers.push(
        researchSearchProviderFromEnv({
          IGTRACK_RESEARCH_SEARCH_PROVIDER: "brave",
          IGTRACK_RESEARCH_SEARCH_API_KEY: apiKey,
        }),
      );
    }
    const selected = BENCH_CASES.filter((entry) => cases === null || cases.includes(entry.handle));
    if (selected.length === 0) throw new Error("--cases matched no evaluation-set handles");
    if (recordDir !== null) mkdirSync(recordDir, { recursive: true });
    for (const benchCase of selected) {
      for (const provider of providers) {
        const { row, recording } = await runLive(benchCase.handle, benchCase, provider);
        rows.push(row);
        if (recordDir !== null && providers.length === 1) {
          // Record only single-provider runs: a mixed recording cannot replay
          // which provider answered which query.
          writeFileSync(
            join(recordDir, `${benchCase.handle}.json`),
            `${JSON.stringify(recording, null, 2)}\n`,
            "utf8",
          );
        }
      }
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
    );
    return;
  }
  printTables(rows);
  if (savedDir === null && (process.env["IGTRACK_RESEARCH_SEARCH_API_KEY"] ?? "").trim() === "") {
    process.stdout.write(
      "\nbrave: NOT MEASURED — IGTRACK_RESEARCH_SEARCH_API_KEY is not set (no key invented, no row fabricated).\n",
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`bench-audit failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

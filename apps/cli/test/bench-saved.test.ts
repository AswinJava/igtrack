import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BENCH_CASES,
  ReplayFetcher,
  ReplaySearchProvider,
  captureFetcher,
  captureSearch,
  computeBenchMetrics,
  type BenchMetrics,
  type BenchRecording,
} from "../src/bench.js";
import { handleMentioned, opAuditWebProbe, type AuditWebReport } from "../src/tools.js";

// ---------------------------------------------------------------------------
// The SAVED-RESPONSE layer (mission: mocked vs saved vs live stay separate).
// These tests replay recordings captured from real freeserp/fetch runs — no
// network, no mocks — through the REAL probe and assert the Phase-3
// corrections end to end: support checking against canonicalized text, the
// self-identification rule, the share-button exclusion, the corrected `nasaa`
// ground truth, and honest preservation of transport failures. Fixtures are
// apps/cli/test/fixtures/bench/*.json (recorded 2026-10-19).
// ---------------------------------------------------------------------------

async function replay(
  name: string,
): Promise<{ report: AuditWebReport; metrics: BenchMetrics }> {
  const recording = JSON.parse(
    readFileSync(new URL(`./fixtures/bench/${name}.json`, import.meta.url), "utf8"),
  ) as BenchRecording;
  const capturedSearch = captureSearch(new ReplaySearchProvider(recording));
  const capturedFetch = captureFetcher(new ReplayFetcher(recording));
  const report = await opAuditWebProbe(
    { username: recording.handle },
    { search: capturedSearch.provider, fetcher: capturedFetch.fetcher },
  );
  const benchCase = BENCH_CASES.find((entry) => entry.handle === recording.handle);
  const metrics = computeBenchMetrics({
    report,
    pages: capturedFetch.pages,
    searches: capturedSearch.searches,
    handle: recording.handle,
    ...(benchCase !== undefined ? { benchCase } : {}),
  });
  return { report, metrics };
}

/** Every stored fact must involve the handle: its value or the page's host. */
function selfIdentifiesEveryFact(report: AuditWebReport, handle: string): boolean {
  return report.facts.every(
    (fact) => handleMentioned(fact.value, handle) || handleMentioned(fact.sourceDomain ?? "", handle),
  );
}

describe("saved-response replay of committed live recordings", () => {
  it("replays the nasa recording offline to the same verified result", async () => {
    const { report, metrics } = await replay("nasa");
    expect(report.outcomeClass).toBe("EVIDENCE_EXTRACTED");
    expect(metrics.expectationMet).toBe(true); // REQUIRE_EVIDENCE held
    expect(metrics.facts).toBeGreaterThan(0);
    expect(metrics.supported).toBe(metrics.facts); // 100% support, canon checker
    expect(metrics.gtPagesFetched).toBe(metrics.gtPagesTotal); // ground truth reached
    expect(metrics.gtPagesInCandidates).toBe(metrics.gtPagesTotal);
    expect(metrics.unattributed).toBeGreaterThan(0); // source identity counted, not attributed
    expect(selfIdentifiesEveryFact(report, "nasa")).toBe(true);
  }, 60_000);

  it("replays the natgeo recording: publisher identity never attributed, share buttons never claimed", async () => {
    const { report, metrics } = await replay("natgeo");
    expect(report.outcomeClass).toBe("EVIDENCE_EXTRACTED");
    expect(metrics.expectationMet).toBe(true);
    expect(metrics.facts).toBeGreaterThan(0);
    expect(metrics.supported).toBe(metrics.facts); // escaping asymmetries are gone
    expect(report.totals.unattributed).toBeGreaterThan(0);
    expect(selfIdentifiesEveryFact(report, "natgeo")).toBe(true);
    for (const fact of report.facts) {
      if (fact.predicate === "RELATED_ACCOUNT_ASSERTED") {
        // no "share this" button may read as a profile claim
        expect(fact.value).not.toMatch(/\/(?:intent|share|sharearticle|sharer)(?:\/|\?|$)/i);
      }
      if (fact.predicate === "ORGANIZATION_NAME") {
        // the measured contamination: foreign publishers (wersm, detik, wtxl)
        // must never be named as the handle's organization
        const firstLabel = (fact.sourceDomain ?? "").replace(/^www\./, "").split(".")[0];
        expect(["wersm", "detik", "wtxl"]).not.toContain(firstLabel);
      }
    }
  }, 60_000);

  it("replays the nasaa recording: corrected ground truth, failures preserved as failures", async () => {
    const { report, metrics } = await replay("nasaa");
    // The original FORBID expectation was falsified by this very evidence.
    expect(metrics.expectation).toBe("REVIEW");
    expect(metrics.expectationMet).toBe(null);
    expect(metrics.supported).toBe(metrics.facts); // string-true on the page
    expect(metrics.namingPages).toBe(1); // only nasaa-arts.org was readable
    expect(report.totals.failed).toBe(4); // nasaa.org answered 403 — kept, never hidden
    // the near-miss property that still matters: no nasa.* page contributes
    for (const doc of report.documents) {
      expect(new URL(doc.url).hostname).not.toMatch(/^nasa\./);
    }
    expect(selfIdentifiesEveryFact(report, "nasaa")).toBe(true);
  }, 60_000);
});

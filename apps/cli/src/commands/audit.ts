import { CLAIM_REVIEW_HORIZON_DAYS } from "@igtrack/core";
import { createContext } from "../context.js";
import {
  display,
  emit,
  flagNumber,
  flagString,
  isJson,
  table,
  UsageError,
  type ParsedArgs,
} from "../output.js";
import { AUDIT_WEB_MAX_SOURCES, opAudit, type AuditReport } from "../tools.js";

// ---------------------------------------------------------------------------
// audit — one command that answers "what is known about this account, from
// where, and what can never be known" without mutating anything.
//
// Three phases, all read-only: a local configuration check (no request), ONE
// stateless probe of the configured source, and a read-back of what this
// deployment already stored. The human screen is derived from the same report
// object the --json envelope carries, so the two renderings cannot disagree.
// ---------------------------------------------------------------------------

export const AUDIT_HELP = `igtrack audit <username|@handle|profile-url> [--url URL[,URL…]] [--max-sources N] [--json]

One report about ONE account: what the configured source says right now, what
this deployment has already recorded, what the public web states about the
handle, and what can never be observed — with the evidence source, timestamps,
coverage and reasons attached to every section.

Phases (in order, all read-only — no target is registered, no row is written):
  1. Configuration is checked LOCALLY (variable names/states/fixes, never a
     value) before anything is observed, so a broken configuration is reported
     as CONFIGURATION_ERROR — never as "no data".
  2. ONE stateless probe of the configured source (the same call \`lookup\`
     makes). It persists nothing.
  3. If the account is tracked, a read-back of stored rows: identity, profile,
     media summary, counts, claims totals, per-capability coverage — the same
     report \`research\` prints, summarized — plus the next step \`plan\` derives.
  4. A bounded public-web probe (FOUNDING §19): pages named with --url, plus
     candidates from a configured search provider (IGTRACK_RESEARCH_SEARCH_PROVIDER:
     auto = Brave when IGTRACK_RESEARCH_SEARCH_API_KEY is set, otherwise the keyless
     FreeSerp index; brave = the official Brave API with that key; freeserp;
     none = never search), fetched through the same SSRF gate, robots check and
     byte/timeout caps as \`research --run\`, capped at
     ${AUDIT_WEB_MAX_SOURCES} documents by default, depth 1, and NEVER stored.
     The search asks a fixed budget of 4 distinct queries for the handle
     (quoted form, profile-URL form, @-mention form, bare form), deduplicates
     candidates to canonical URLs, and ranks them by explainable relevance
     (exact handle in URL > title > snippet; policy-refused hosts last).
     Every fact is labelled a third-party statement with its source URL, field
     and retrieval time — never a platform observation, and only from a page
     that names the handle itself; on search-found pages the statement itself must also involve the handle (its value, or the page's own host), so a third-party article's publisher identity is counted but never attributed. The report separates SEARCH_NOT_CONFIGURED /
     SEARCH_SUCCEEDED / SEARCH_NO_RESULTS / SEARCH_FAILED from the retrieval
     outcome, and labels where the phase stopped (outcome: SEARCH_UNAVAILABLE /
     SEARCH_FAILED / SEARCH_NO_CANDIDATES / CANDIDATES_INACCESSIBLE /
     PAGES_IRRELEVANT / RELEVANT_NO_FACTS / EVIDENCE_EXTRACTED), so a run that
     never searched is never shown as an investigation and one weak index is
     never shown as proof that no public evidence exists.
     With neither --url nor a search provider the phase reports UNAVAILABLE with
     the exact reason; it never invents sources.

The audit queues no scan, writes no row and registers no target. A probe that
finds nothing says "this source holds no rows for the account" — it is NEVER
proof that the account does not exist. Fixture answers are synthetic; import
answers are the operator's own export; graph answers are the documented Graph
API routes only (Business Discovery only when IGTRACK_GRAPH_BUSINESS_DISCOVERY=1).

Exit codes: 0 report produced AND the configured source returned an observation
of the account, 2 usage/invalid reference, 3 configuration blocked (the report
is still printed — read its "next steps"), 4 report produced but NO observation
was made (the source returned NOT_OBSERVED / UNSUPPORTED / NOT_AUTHORIZED / an
error). Exit 0 means "the source answered" — the report's "Observation" block
separately says whether a real platform request reached Instagram
(observation.realPlatformRequest), and a fixture or export source can never set
it.

Examples:
  igtrack audit sel_win_
  igtrack audit @dune.harbor --json
  igtrack audit sel_win_ --url "https://example.org/about,https://example.org/press"
  igtrack audit https://www.instagram.com/aurora.wilde/`;

/**
 * Exit code from the report alone, so --json and the human screen cannot
 * disagree.
 *
 *   0 — the report was produced AND the configured source returned an
 *       observation of the account. The report states the evidence class
 *       (LIVE / IMPORTED / SYNTHETIC) separately: exit 0 means "the source
 *       answered", never "Instagram was contacted" — that is `observation.
 *       realPlatformRequest`, and only a live provider can set it.
 *   2 — usage or an invalid reference (thrown before a report exists).
 *   3 — the configuration is blocked. The report is still printed — read its
 *       "next steps". Nothing was observed and nothing could be.
 *   4 — the report was produced, but NO observation was made: the source
 *       returned NOT_OBSERVED / UNSUPPORTED / NOT_AUTHORIZED / a provider
 *       error, or no request was attempted.
 *
 * The distinction between 0 and 4 is the point of this command: a report that
 * generates successfully is not the same thing as an account that was
 * observed, and a script must be able to tell them apart without reading the
 * report. A broken search-provider configuration is the same class of failure
 * as a broken provider configuration: it names a variable that is wrong, not
 * an absence of data.
 */
export function auditExitCode(report: AuditReport): number {
  if (report.config.state === "CONFIGURATION_ERROR") return 3;
  if (
    report.errors.some(
      (error) => error.step === "web" && error.code === "CONFIGURATION_ERROR",
    )
  ) {
    return 3;
  }
  return report.observation.observed ? 0 : 4;
}

function coverageTable(rows: AuditReport["record"]["coverage"]): string {
  if (rows === null) return "  (no stored rows: coverage is computed from evidence this deployment recorded)";
  return table(
    ["capability", "state", "evidence", "rows", "reason"],
    rows.map((row) => [
      row.label,
      row.state,
      // The class travels with the state: "OBSERVED" alone would let a
      // fixture's rows read as a reading of the account.
      row.evidenceClass === null
        ? "-"
        : row.evidenceClass === "SYNTHETIC"
          ? "SYNTHETIC"
          : row.evidenceClass,
      row.observedRows === null ? "no writer" : String(row.observedRows),
      row.reason === null ? "-" : row.reason.replace(/\s+/g, " ").slice(0, 90),
    ]),
  );
}

/** The human screen, rendered from the report only — never from side state. */
export function renderAuditHuman(report: AuditReport): string {
  const sections: string[] = [
    `Audit      @${report.username}  (requested "${report.requested}" · ${report.referenceForm.toLowerCase()})`,
    `Generated  ${report.generatedAt}`,
    "",
    "Observation (a report was generated — that is NOT the same as an account being observed)",
    table(
      ["field", "value"],
      [
        ["account observed", report.observation.observed ? "YES" : "NO"],
        ["real platform request", report.observation.realPlatformRequest ? "YES" : "NO"],
        ["evidence class", report.observation.evidenceClass],
        ["statement", report.observation.statement],
      ],
    ),
    "",
    "Summary (one row per evidence class — they are never blended)",
    `  ${report.summary.headline}`,
    table(
      ["evidence", "state", "detail"],
      report.summary.classes.map((row) => [
        row.evidence,
        row.state,
        row.detail.replace(/\s+/g, " ").slice(0, 160),
      ]),
    ),
    "",
    "Configuration (local check only — names, states and fixes; no value is ever printed)",
    table(
      ["field", "value"],
      [
        ["state", report.config.state],
        ["provider", report.config.provider],
        ["source", display(report.config.sourceId)],
        [
          "source kind",
          report.config.sourceKind === null
            ? "unavailable — no source could be constructed"
            : report.config.sourceKind === "local"
              ? "local file — no request reaches Instagram"
              : "Instagram Graph API — a live provider",
        ],
        ["usable", report.config.usable ? "yes" : `NO — ${display(report.config.error)}`],
        ["evidence", report.config.evidence],
        [
          "readiness",
          `${report.config.readiness.status} · networkCallMade=${String(report.config.readiness.networkCallMade)}`,
        ],
      ],
    ),
  ];

  if (report.config.readiness.problems.length > 0) {
    sections.push(
      "",
      "Problems (each names a variable and a fix; no values are shown):",
      ...report.config.readiness.problems.map((problem) => `  · ${problem}`),
    );
  }

  sections.push(
    "",
    "Probe (one stateless request through the configured source — persists nothing)",
    table(
      ["field", "value"],
      [
        ["attempted", report.probe.attempted ? "yes" : "no"],
        ["state", report.probe.state],
        ["route", display(report.probe.via)],
        ["capability status", display(report.probe.status)],
        [
          "source kind",
          report.probe.sourceKind === null
            ? display(null)
            : report.probe.sourceKind === "local"
              ? "local file — not an Instagram response"
              : "Instagram Graph API",
        ],
        ...(report.probe.businessDiscovery === null
          ? []
          : ([
              [
                "business discovery",
                report.probe.businessDiscovery === "on"
                  ? "on (opted in)"
                  : "off — cross-account requests cannot be issued",
              ],
            ] as Array<[string, string]>)),
        ["observed at", display(report.probe.observedAt)],
        ["error", report.probe.error === null ? "none" : `${report.probe.error.kind}: ${report.probe.error.message}`],
      ],
    ),
    `  ${report.probe.why}`,
  );

  sections.push(
    "",
    `Stored record (${report.record.tracked ? "tracked target" : "NOT tracked"})`,
  );
  if (report.record.target !== null) {
    sections.push(
      table(
        ["field", "value"],
        [
          ["target id", report.record.target.id],
          ["mode", report.record.target.observationMode],
          ["status", report.record.target.status],
          ["state", report.record.state],
          ["first recorded", display(report.record.firstRecordedAt)],
          ["last recorded", display(report.record.lastRecordedAt)],
        ],
      ),
    );
  }
  if (report.record.identity !== null) {
    const identity = report.record.identity;
    sections.push(
      table(
        ["field", "value"],
        [
          ["platform id", display(identity.igId)],
          ["display name", display(identity.displayName)],
          [
            "flags",
            `private ${display(identity.isPrivate)} · verified ${display(identity.isVerified)} · type ${display(identity.accountType)}`,
          ],
          ...(report.record.route === null
            ? []
            : ([
                [
                  "route",
                  `${report.record.route.providerMethod} — ${report.record.route.scope} (sources: ${report.record.route.observingSources.join(", ")})`,
                ],
                [
                  "stored evidence class",
                  report.record.route.evidenceClass === "SYNTHETIC"
                    ? "SYNTHETIC — the stored rows are generated data, not a reading of this account"
                    : report.record.route.evidenceClass === "MIXED"
                      ? "MIXED — some stored rows are generated data and some are not; no single figure describes this account"
                      : report.record.route.evidenceClass === "LIVE"
                        ? "LIVE — a real platform route or the operator's own export produced these rows"
                        : "NONE — nothing is stored for this account",
                ],
              ] as Array<[string, string]>)),
        ],
      ),
    );
  }
  if (report.record.reason !== null) {
    sections.push(`  ${report.record.reason}`);
  }
  if (report.record.profile !== null) {
    const latest = report.record.profile.latest;
    sections.push(
      "",
      "Profile (latest stored snapshot — rows, never live figures)",
      table(
        ["field", "value"],
        [
          ["followers", display(latest?.followerCount ?? null)],
          ["following", display(latest?.followingCount ?? null)],
          ["posts", display(latest?.postCount ?? null)],
          ["snapshots", String(report.record.profile.snapshotCount)],
          ["observed at", display(latest?.observedAt ?? null)],
          ["source", display(latest?.sourceId ?? null)],
          ["profile changes", String(report.record.profile.changeCount)],
        ],
      ),
    );
  }
  if (report.record.media !== null) {
    const media = report.record.media;
    sections.push(
      "",
      "Media (row counts and bounds — never the rows themselves)",
      table(
        ["field", "value"],
        [
          ["stored rows", String(media.storedCount)],
          [
            "bounded",
            media.bounded === null
              ? display(null)
              : media.bounded
                ? `YES — a bounded preview (ceiling ${display(media.previewLimit)} rows), never "the account's posts"`
                : "no — first observations from a complete listing",
          ],
          ["published range", `${display(media.oldestPublishedAt)} … ${display(media.newestPublishedAt)}`],
          ["observed range", `${display(media.firstObservedAt)} … ${display(media.lastObservedAt)}`],
        ],
      ),
    );
  }
  const countRows = Object.entries(report.record.counts);
  if (countRows.length > 0) {
    sections.push(
      "",
      "Stored rows by surface",
      table(
        ["surface", "rows", "latest"],
        countRows.map(([surface, entry]) => [
          surface,
          String(entry.count),
          display(entry.latestAt),
        ]),
      ),
    );
  }
  if (report.record.claims !== null) {
    sections.push(
      "",
      "Claims (operator/agent-submitted findings — never observations)",
      `  ${report.record.claims.active} active · ${report.record.claims.retracted} retracted · ${report.record.claims.predicates} predicate(s)`,
      ...(report.record.claims.dueForReview > 0
        ? [
            `  STALE — ${report.record.claims.dueForReview} active claim(s) are past the ${CLAIM_REVIEW_HORIZON_DAYS}-day review horizon (DUE_FOR_REVIEW): kept exactly as recorded, but they describe an earlier moment — see Limitations`,
          ]
        : []),
      `  ${report.record.claims.statement}`,
    );
  }
  sections.push("", "Coverage (computed from stored rows; every gap carries its reason)", coverageTable(report.record.coverage));

  const web = report.web;
  sections.push(
    "",
    "Public web (bounded, read-only probe — third-party statements about the handle, never platform observations, never stored)",
    table(
      ["field", "value"],
      [
        ["attempted", web.attempted ? "yes" : "no"],
        [
          "search",
          `${web.search.state} · provider ${display(web.search.provider)} · ${web.search.queries.length} query(ies) · ` +
            `${web.search.candidateUrls} candidate URL(s) · ${web.search.relevantCandidates} naming @${report.username}`,
        ],
        ["retrieval", `${web.retrievalState} · ${web.retrievalState === "NOT_ATTEMPTED" ? "no document was fetched" : `${web.totals.fetched} fetched / ${web.totals.failed} failed / ${web.totals.skipped} policy-skipped`}`],
        [
          "outcome",
          `${web.outcomeClass} — ${
            web.outcomeClass === "EVIDENCE_EXTRACTED"
              ? "at least one third-party statement was extracted with its citation"
              : web.outcomeClass === "PAGES_IRRELEVANT"
                ? `poor coverage: ${web.totals.pagesNamingHandle} of ${web.totals.fetched} fetched page(s) name the handle — not a verdict that no evidence exists`
                : web.outcomeClass === "RELEVANT_NO_FACTS"
                  ? "pages naming the handle were read, but nothing extractable survived validation"
                  : web.outcomeClass === "CANDIDATES_INACCESSIBLE"
                    ? "candidates existed, but no page could be read"
                    : web.outcomeClass === "SEARCH_NO_CANDIDATES"
                      ? "search ran and genuinely returned no candidates"
                      : web.outcomeClass === "SEARCH_FAILED"
                        ? "a provider was selected but could not answer"
                        : "no search provider was configured and no --url was given"
          }`,
        ],
        [
          "bounds",
          `≤${web.bounds.maxSources} document(s), depth ${web.bounds.maxDepth} — ${web.bounds.enforced}`,
        ],
        [
          "totals",
          `planned ${web.totals.planned} · fetched ${web.totals.fetched} · failed ${web.totals.failed} · ` +
            `policy-skipped ${web.totals.skipped} · pages naming @${report.username} ${web.totals.pagesNamingHandle} · ` +
            `facts ${web.totals.facts} · refused by registry ${web.totals.refused}` +
            (web.totals.unattributed > 0
              ? ` · not attributed (page named the handle, value names the source) ${web.totals.unattributed}`
              : ""),
        ],
        ["inferences", "none produced — see the Inferences row in the summary"],
      ],
    ),
    `  ${web.why}`,
  );
  if (web.search.perQuery.length > 0) {
    sections.push(
      "",
      "Queries issued (deterministic, budgeted; each shows exactly what it returned)",
      table(
        ["#", "query", "results", "error"],
        web.search.perQuery.map((entry, index) => [
          String(index + 1),
          entry.query,
          String(entry.results),
          // null means the query ANSWERED without an error — "none", not the
          // missing-data "unavailable" the display helper prints for null.
          entry.error ?? "none",
        ]),
      ),
    );
  }
  if (web.search.unavailableReason !== null) {
    sections.push(`  search ${web.search.state} — ${web.search.unavailableReason}`);
  }
  for (const note of web.notes) sections.push(`  · ${note}`);
  if (web.candidates.length > 0) {
    sections.push(
      "",
      "Candidates (why each ranked where it did, and whether it was ever read)",
      table(
        ["disposition", "url", "reason"],
        web.candidates.map((candidate) => [
          candidate.disposition,
          candidate.url,
          candidate.reason.replace(/\s+/g, " ").slice(0, 140),
        ]),
      ),
    );
  }
  if (web.rejectedUrls.length > 0) {
    sections.push(
      "",
      "Rejected URLs (not even planned)",
      table(
        ["url", "reason"],
        web.rejectedUrls.map((entry) => [entry.url, entry.reason.replace(/\s+/g, " ").slice(0, 120)]),
      ),
    );
  }
  if (web.documents.length > 0) {
    sections.push(
      "",
      "Documents (per-document outcome; a failure is reported as a failure, never as an absence of facts)",
      table(
        ["outcome", "source", "url", "title", "detail"],
        web.documents.map((doc) => [
          doc.outcome,
          doc.sourceType === "OPERATOR_SUPPLIED_URL" ? "operator --url" : "search result",
          doc.url,
          display(doc.title),
          [
            doc.httpStatus === null ? null : `HTTP ${doc.httpStatus}`,
            doc.byteSize === null ? null : `${doc.byteSize} B`,
            doc.contentSha256 === null ? null : `sha256 ${doc.contentSha256.slice(0, 12)}…`,
            `${doc.facts} fact(s)`,
            doc.refused > 0 ? `${doc.refused} refused by the predicate registry` : null,
            doc.unattributed > 0 ? `${doc.unattributed} not attributed (value names the source page)` : null,
            doc.discarded > 0 ? `${doc.discarded} discarded — page never names @${report.username}` : null,
            doc.mentionsHandle === null
              ? null
              : `names @${report.username}: ${doc.mentionsHandle ? "yes" : "no"}`,
            doc.outcomeReason,
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
        ]),
      ),
    );
  }
  if (web.facts.length > 0) {
    sections.push(
      "",
      "Facts (what a source STATES in a structured field — a citation, not an observation of the account)",
      table(
        ["predicate", "value", "source", "field", "retrieved"],
        web.facts.map((fact) => [
          fact.predicate,
          fact.value.replace(/\s+/g, " ").slice(0, 60),
          `${fact.sourceDomain ?? fact.sourceUrl}${fact.sourceTitle === null ? "" : ` — ${fact.sourceTitle}`}`,
          // The per-fact caveat travels to the human screen too: the JSON
          // envelope has always carried `uncertainty`, and a caveat only the
          // machine can read is not one the operator can act on.
          `${fact.field} (${fact.method})${
            fact.uncertainty === null
              ? ""
              : ` · caveat: ${fact.uncertainty.replace(/\s+/g, " ").slice(0, 140)}`
          }`,
          display(fact.retrievedAt),
        ]),
      ),
    );
    if (web.relations.length > 0) {
      sections.push(
        "",
        "Corroboration and contradiction (derived from the facts above; a conflict shows both values and picks no winner)",
        table(
          ["predicate", "label", "distinct values", "domains", "facts"],
          web.relations.map((relation) => [
            relation.predicate,
            relation.label,
            String(relation.values.length),
            relation.sourceDomains.join(", ") || "-",
            String(relation.facts),
          ]),
        ),
      );
    }
  }

  if (report.unsupported.length > 0) {
    sections.push(
      "",
      `Unavailable by decision (${report.unsupported.length}) — platform-absent, not unimplemented (FOUNDING §14)`,
      table(
        ["capability", "why"],
        report.unsupported.map((entry) => [
          entry.label,
          (entry.why ?? "see igtrack capabilities").replace(/\s+/g, " ").slice(0, 90),
        ]),
      ),
    );
  }

  sections.push(
    "",
    "Errors",
    ...(report.errors.length === 0
      ? ["  (none)"]
      : report.errors.map((error) => `  ${error.step} [${error.code}]${error.retryable ? " (retryable)" : ""}: ${error.message}`)),
    "",
    "Limitations",
    ...report.limitations.map((limitation) => `  · ${limitation}`),
    "",
    "Next steps",
    ...(report.nextSteps.length === 0
      ? ["  (none)"]
      : report.nextSteps.flatMap((step) => [`  ${step.action}`, `      because ${step.because}`])),
  );

  return sections.join("\n");
}

export async function runAudit(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const username = args.positionals[0];
  if (username === undefined) {
    throw new UsageError(
      "Usage: igtrack audit <username|@handle|profile-url>  (igtrack audit --help)",
    );
  }
  // The public-web phase is opt-in by source: --url names pages directly, and
  // a configured search provider supplies candidates. Without either, the
  // phase reports UNAVAILABLE with the exact reason instead of guessing.
  const urlFlag = flagString(args.flags, "url");
  const urls =
    urlFlag === undefined
      ? []
      : urlFlag
          .split(",")
          .map((url) => url.trim())
          .filter((url) => url !== "");
  const maxSources =
    args.flags["max-sources"] === undefined
      ? undefined
      : flagNumber(args.flags, "max-sources", AUDIT_WEB_MAX_SOURCES);
  const ctx = await createContext();
  try {
    const report = await opAudit(ctx, {
      username,
      ...(urls.length > 0 ? { urls } : {}),
      ...(maxSources !== undefined ? { maxSources } : {}),
    });
    emit({ json, meta: ctx.meta, data: report, human: renderAuditHuman(report) });
    return auditExitCode(report);
  } finally {
    await ctx.close();
  }
}

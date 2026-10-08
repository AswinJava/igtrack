import { display, emit, flagNumber, flagString, isJson, table, UsageError, type ParsedArgs } from "../output.js";
import { createContext } from "../context.js";
import { opInvestigate, type InvestigateResult } from "../tools.js";

export const INVESTIGATE_HELP = `igtrack investigate <username|@handle|profile-url> [options]

One username in, one provenance-backed dossier out. IGTrack runs every
investigation stage the configured sources support, then reports what was
investigated, what was actually retrieved, what was derived from it, what
remains unknown, and which configuration would close each gap.

Stages, in order (each is reported separately, with what it retrieved):
  1. IDENTITY       the reference is normalized and the account is resolved
                    through the permitted sources — the platform id, not the
                    spelling, is the identity, so two similar names are never
                    merged
  2. PLATFORM       every field the selected source exposes for the account
                    (profile, media, comments, stories, tags, insights)
  3. CONTENT        the accessible content read back with its provenance:
                    posts, captions, comments, mentions, tagged media
  4. RELATIONSHIPS  the accounts this one is observed to interact with, by
                    evidence class (live and synthetic are never blended)
  5. WEB            public-web discovery and retrieval, with every fact's
                    URL and retrieval time
  6. CORRELATE      themes, cadence and contradictions across the classes
  7. DOSSIER        the report itself, with its coverage and its gaps

Options:
  --question "..."  What you are trying to find out. Derived from the handle
                    when omitted.
  --url URL[,URL]   Public pages to read as part of the web stage (named
                    pages are the highest-trust tier).
  --max-sources N   Cap on documents the web stage fetches (1..10).
  --no-web          Skip the public-web stage (no search request is made).
  --refresh         Ignore the document freshness window and re-fetch.
  --force           Re-read the platform now, ignoring the scan cadence.
  --max-jobs N      Cap on jobs the platform stage executes (default 25).
  --json            The same dossier as the machine-readable envelope.

Exit codes: 0 the dossier was produced and at least one stage retrieved
something, 2 usage or an invalid reference, 3 the configuration is blocked
(no source could be constructed), 4 the dossier was produced but NO stage
retrieved anything — read the gaps, this is not a report about the account.

Examples:
  igtrack investigate @serpaix.ai
  igtrack investigate serpaix.ai --url "https://example.org/about" --json
  igtrack investigate serpaix.ai --no-web`;

export async function runInvestigate(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const username = args.positionals[0];
  if (username === undefined) {
    throw new UsageError(
      "Usage: igtrack investigate <username|@handle|profile-url>  (igtrack investigate --help)",
    );
  }
  const urlFlag = flagString(args.flags, "url");
  const urls =
    urlFlag === undefined
      ? []
      : urlFlag
          .split(",")
          .map((url) => url.trim())
          .filter((url) => url !== "");
  const maxSources = args.flags["max-sources"] === undefined
    ? undefined
    : flagNumber(args.flags, "max-sources", 10);
  const maxJobs = args.flags["max-jobs"] === undefined
    ? undefined
    : flagNumber(args.flags, "max-jobs", 25);
  const ctx = await createContext();
  try {
    const result = await opInvestigate(ctx, {
      username,
      ...(args.flags["question"] !== undefined
        ? { question: String(args.flags["question"]) }
        : {}),
      ...(urls.length > 0 ? { urls } : {}),
      ...(maxSources !== undefined ? { maxSources } : {}),
      ...(maxJobs !== undefined ? { maxJobs } : {}),
      ...(args.flags["no-web"] === true ? { web: false } : {}),
      ...(args.flags["refresh"] === true ? { refresh: true } : {}),
      ...(args.flags["force"] === true ? { force: true } : {}),
    });
    emit({ json, meta: ctx.meta, data: result, human: renderInvestigateHuman(result) });
    return investigateExitCode(result);
  } finally {
    await ctx.close();
  }
}

/**
 * The exit code from the investigation itself.
 *
 * 0 — the dossier was produced and at least one item was actually RETRIEVED.
 *     A dossier whose stages all came back empty is a DIFFERENT answer (4):
 *     it says nothing was found, which is not the same as saying the account
 *     has nothing.
 * 2 — usage (thrown before an investigation exists).
 * 3 — the configuration is blocked (thrown as a CliError).
 */
export function investigateExitCode(result: InvestigateResult): number {
  return result.investigation.retrievedItems > 0 ? 0 : 4;
}

function renderInvestigateHuman(result: InvestigateResult): string {
  const inv = result.investigation;
  const sections: string[] = [
    `Investigating @${inv.username}  (requested "${inv.requested}" · ${inv.referenceForm.toLowerCase()})`,
    `Started    ${inv.startedAt}   Finished ${inv.completedAt}`,
    `Mode       ${inv.observationMode ?? "none"} · target ${inv.targetId ?? "none"}`,
    "",
    "What was investigated (one row per stage — they are never blended)",
    table(
      ["stage", "status", "source", "counts", "note"],
      inv.stages.map((s) => [
        s.id,
        s.status,
        s.source ?? "-",
        Object.entries(s.retrieved)
          .map(([key, value]) => `${key}=${value}`)
          .join(" "),
        (s.reason ?? "").replace(/\s+/g, " ").slice(0, 110),
      ]),
    ),
    "",
    "Evidence classes (what each class is evidence of — never merged)",
    table(
      ["class", "items", "means"],
      inv.evidenceClasses.map((row) => [row.class, String(row.items), row.label]),
    ),
    "",
    "Sources",
    table(
      ["source", "class", "queried", "items", "note"],
      inv.sources.map((s) => [
        s.id,
        s.evidenceClass,
        s.queried ? "yes" : "NO",
        s.items === null ? "-" : String(s.items),
        (s.reason ?? "").replace(/\s+/g, " ").slice(0, 100),
      ]),
    ),
  ];

  const identity = result.identity;
  sections.push(
    "",
    "Identity and profile",
    table(
      ["field", "value"],
      [
        ["username", `@${identity.account.username}`],
        ["platform id", display(identity.account.igId)],
        ["display name", display(identity.account.displayName)],
        [
          "flags",
          `private ${display(identity.account.isPrivate)} · verified ${display(identity.account.isVerified)} · type ${display(identity.account.accountType)}`,
        ],
        [
          "route",
          `${identity.route.providerMethod} — ${identity.route.scope} (sources: ${identity.route.observingSources.join(", ") || "none"})`,
        ],
        ["stored evidence class", identity.route.evidenceClass],
        [
          "counts",
          `followers ${display(result.platform.profile.latest?.followerCount ?? null)} · following ${display(result.platform.profile.latest?.followingCount ?? null)} · posts ${display(result.platform.profile.latest?.postCount ?? null)}`,
        ],
        [
          "biography",
          display(result.platform.profile.latest?.biography ?? null),
        ],
        [
          "website",
          display(result.platform.profile.latest?.externalUrl ?? null),
        ],
        ["observed at", display(result.platform.profile.latest?.observedAt ?? null)],
      ],
    ),
  );

  sections.push(
    "",
    `Content (${result.content.media.length} media row(s), ${result.content.comments.length} comment(s), ${result.content.storyMentions.length} mention(s), ${result.content.taggedMedia.length} tagged-media row(s))`,
  );
  if (result.content.media.length > 0) {
    sections.push(
      table(
        ["post", "published", "first observed", "likes", "comments", "media", "source", "caption"],
        result.content.media.map((row) => [
          row.postId,
          display(row.publishedAt),
          display(row.firstObservedAt),
          display(row.likeCount),
          display(row.commentCount),
          display(row.mediaType),
          row.sourceId,
          (row.caption ?? "-").replace(/\s+/g, " ").slice(0, 60),
        ]),
      ),
    );
  }
  if (result.content.comments.length > 0) {
    sections.push(
      table(
        ["post", "author", "when", "text"],
        result.content.comments.map((row) => [
          row.postId,
          `@${row.author}`,
          row.createdAt,
          row.text.replace(/\s+/g, " ").slice(0, 70),
        ]),
      ),
    );
  }
  if (result.content.storyMentions.length > 0) {
    sections.push(
      table(
        ["story", "mentioned", "visibility"],
        result.content.storyMentions.map((row) => [
          row.storyId,
          `@${row.username}`,
          row.visibilityClass,
        ]),
      ),
    );
  }
  if (result.content.hashtags.length > 0 || result.content.terms.length > 0) {
    sections.push(
      `  Topics derived from ${result.content.captionRows} stored caption(s) — a derivation, never an observation:`,
      table(
        ["hashtags", "terms"],
        [
          [
            result.content.hashtags.map((t) => t.term).join(" ") || "-",
            result.content.terms.map((t) => t.term).join(" ") || "-",
          ],
        ],
      ),
    );
  }

  sections.push(
    "",
    "Relationships (live and synthetic are ranked apart — a synthetic interaction is evidence about a fixture, never about a person)",
  );
  if (result.relationships.live.length === 0 && result.relationships.synthetic.length === 0) {
    sections.push("  No interaction was observed for this account.");
  } else {
    if (result.relationships.live.length > 0) {
      sections.push(
        "  Live:",
        table(
          ["account", "score", "mentions", "comments", "deltas", "mutual", "last signal"],
          result.relationships.live.map((r) => [
            `@${r.username}`,
            String(r.score),
            String(r.signals.mentions),
            String(r.signals.comments),
            String(r.signals.deltas),
            r.mutual ? "yes" : "no",
            display(r.lastSignalAt),
          ]),
        ),
      );
    }
    if (result.relationships.synthetic.length > 0) {
      sections.push(
        "  Synthetic (fixture data — not evidence about anyone):",
        table(
          ["account", "score", "mentions", "comments", "deltas", "mutual", "last signal"],
          result.relationships.synthetic.map((r) => [
            `@${r.username}`,
            String(r.score),
            String(r.signals.mentions),
            String(r.signals.comments),
            String(r.signals.deltas),
            r.mutual ? "yes" : "no",
            display(r.lastSignalAt),
          ]),
        ),
      );
    }
  }

  sections.push(
    "",
    `Public web (${result.web.outcome} — ${result.web.totals.facts} statement(s) from ${result.web.totals.fetched} page(s))`,
  );
  if (result.web.facts.length > 0) {
    sections.push(
      table(
        ["predicate", "value", "source", "retrieved", "filed"],
        result.web.facts.map((fact) => [
          fact.predicate,
          fact.value.replace(/\s+/g, " ").slice(0, 60),
          fact.sourceUrl,
          fact.retrievedAt,
          fact.stored ? "yes" : "no (reported only)",
        ]),
      ),
    );
  }

  sections.push(
    "",
    `Claims (operator/agent findings — ${result.claims.totals.active} active · ${result.claims.totals.retracted} retracted · ${result.claims.totals.predicates} predicate(s))`,
  );
  if (result.contradictions.length > 0) {
    sections.push(
      "Contradictions (both sides shown; no winner chosen)",
      table(
        ["predicate", "values", "domains"],
        result.contradictions.map((c) => [
          c.predicate,
          c.values.map((v) => v.value).join("  |  "),
          c.values.flatMap((v) => v.sources).join(", ") || "-",
        ]),
      ),
    );
  }
  if (result.leads.state === "OBSERVED" && result.leads.items.length > 0) {
    sections.push(
      "Uncertain leads (signals, not confirmed relationships)",
      table(
        ["account", "signals"],
        result.leads.items.map((l) => [`@${l.username}`, l.signals.join(", ")]),
      ),
    );
  }

  const investigationGaps = result.gaps.filter((g) => g.kind === "investigation");
  const capabilityGaps = result.gaps.filter((g) => g.kind === "capability");
  sections.push(
    "",
    `What this investigation could not get (${investigationGaps.length})`,
  );
  if (investigationGaps.length === 0) {
    sections.push("  Nothing: every stage retrieved what it could.");
  } else {
    sections.push(
      table(
        ["subject", "why", "what would change it"],
        investigationGaps.map((gap) => [
          gap.subject,
          gap.reason.replace(/\s+/g, " ").slice(0, 120),
          (gap.howToImprove ?? "-").replace(/\s+/g, " ").slice(0, 120),
        ]),
      ),
    );
  }
  sections.push(
    "",
    `Per-capability coverage (${capabilityGaps.length} not observed or unavailable)`,
    table(
      ["capability", "state", "evidence", "rows", "why", "what would change it"],
      result.coverage
        .filter((row) => row.state !== "OBSERVED")
        .map((row) => [
          row.label,
          row.state,
          row.evidenceClass ?? "-",
          row.observedRows === null ? "no writer" : String(row.observedRows),
          (row.reason ?? "-").replace(/\s+/g, " ").slice(0, 100),
          (row.unlock ?? "-").replace(/\s+/g, " ").slice(0, 100),
        ]),
    ),
  );

  sections.push(
    "",
    "Next steps",
    ...result.nextSteps.map((step) => `  ${step.action}\n      because ${step.because}`),
  );
  if (result.notes.length > 0) {
    sections.push("", "Notes", ...result.notes.map((note) => `  · ${note}`));
  }
  return sections.join("\n");
}

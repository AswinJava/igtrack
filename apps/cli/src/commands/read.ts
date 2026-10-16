import { ACTIVITY_TYPES, type ActivityType } from "@igtrack/database";
import { CAPABILITY_REGISTRY } from "@igtrack/core";
import {
  CliError,
  capabilityLines,
  display,
  emit,
  flagBool,
  flagNumber,
  flagString,
  isJson,
  relativeTime,
  table,
  UsageError,
  type ParsedArgs,
} from "../output.js";
import { createContext } from "../context.js";
import { opActivity, opDossier, opEvidence, opInsights, opLookup, opRelationships } from "../tools.js";

// ---------------------------------------------------------------------------
// Read-only operations: activity, relationships, evidence, lookup.
//
// These are the commands an agent runs most often. They are safe by
// construction: no writes, no provider side effects beyond a read, and every
// row carries its provenance (source id, confidence, evidence id).
// ---------------------------------------------------------------------------

export async function runActivity(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const rawTypes = (flagString(args.flags, "type") ?? "")
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    const invalid = rawTypes.filter(
      (t) => !(ACTIVITY_TYPES as readonly string[]).includes(t),
    );
    if (invalid.length > 0) {
      throw new UsageError(
        `Unknown --type ${invalid.join(", ")}. Allowed: ${ACTIVITY_TYPES.join(", ")}.`,
      );
    }

    const result = await opActivity(ctx, {
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 30),
      target: flagString(args.flags, "target"),
      types: rawTypes,
      query: flagString(args.flags, "query"),
    });

    const human = [
      `Scope   ${result.scope}`,
      `Since   ${result.since === null ? "all observations on record" : result.since.toISOString()}`,
      result.truncated
        ? `Note    the feed was read with a bounded scan; more than the ${result.items.length} events shown here may exist for this query.`
        : "",
      "",
      table(
        ["when", "type", "target", "summary", "confidence", "evidence"],
        result.items.map((item) => [
          relativeTime(item.timestamp),
          item.type,
          `@${item.targetUsername}`,
          item.summary,
          display(item.confidence),
          item.evidenceId ?? "none",
        ]),
      ),
    ]
      .filter((line) => line !== "")
      .join("\n");

    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runRelationships(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError("Usage: igtrack relationships <target id|username> [--limit N]");
  }
  const ctx = await createContext();
  try {
    const result = await opRelationships(ctx, {
      target,
      limit: flagNumber(args.flags, "limit", 25),
    });

    const human = [
      `Target   @${result.target.username} (${result.target.status})`,
      result.ranks.length === 0
        ? "No relationships observed yet. Relationship ranks come from COMPLETE follower/following snapshots, story mentions, and comment authorship on owned media."
        : table(
            ["account", "score", "mentions", "comments", "deltas", "mutual", "first seen", "last seen", "last signal", "basis"],
            result.ranks.map((r) => [
              `@${r.username}`,
              String(r.score),
              `${r.signals.mentions}${r.signalsWithinWindow.mentions > 0 ? ` (${r.signalsWithinWindow.mentions} in ${result.method.recencyWindowDays}d)` : ""}`,
              `${r.signals.comments}${r.signalsWithinWindow.comments > 0 ? ` (${r.signalsWithinWindow.comments} in ${result.method.recencyWindowDays}d)` : ""}`,
              `${r.signals.deltas}${r.signalsWithinWindow.deltas > 0 ? ` (${r.signalsWithinWindow.deltas} in ${result.method.recencyWindowDays}d)` : ""}`,
              r.mutual ? "yes" : "no",
              r.firstSeenAt === null ? "unavailable" : r.firstSeenAt,
              r.lastSeenAt === null ? "not currently observed" : r.lastSeenAt,
              r.lastSignalAt === null ? "no signal event" : r.lastSignalAt,
              r.firstSeenBasis ?? "none",
            ]),
          ),
      result.truncated
        ? `Note: more ranks exist than the ${result.ranks.length} shown; raise --limit to see them.`
        : "",
      "",
      `Method: ${result.method.scoreFormula}`,
      ...result.method.signals.map((s) => `  ${s.kind} × ${s.weight} — ${s.means}`),
      `  ${result.method.recencyNote}`,
      `  ${result.method.evidenceNote}`,
    ]
      .filter((line) => line !== "")
      .join("\n");

    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runEvidence(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const result = await opEvidence(ctx, {
      id: flagString(args.flags, "id"),
      limit: flagNumber(args.flags, "limit", 20),
    });

    let human: string;
    if (result.mode === "chain") {
      const chain = result.chain;
      if (chain === null) throw new CliError("EVIDENCE_NOT_FOUND", "Evidence row not found.", 2);
      human = [
        `Claim     ${chain.claim}`,
        `Kind      ${chain.evidence.observation_kind}`,
        `Source    ${chain.evidence.source_id}`,
        `Observed  ${chain.evidence.observed_at.toISOString()} (captured ${chain.evidence.captured_at.toISOString()})`,
        `Confidence ${chain.evidence.confidence}`,
        `Raw hash  ${display(chain.evidence.raw_hash)}`,
        chain.evidence.raw_hash === null
          ? "          (this source transports no raw representation; the normalized hash is not a substitute)"
          : "",
        `Normalized ${display(chain.evidence.normalized_hash)}`,
        "",
        "Lineage:",
        table(
          ["label", "value"],
          chain.lineage.map((l) => [l.label, l.value]),
        ),
      ].join("\n");
    } else {
      human = table(
        ["observed", "kind", "source", "observation id", "confidence", "id"],
        result.rows.map((r) => [
          relativeTime(r.observed_at),
          r.observation_kind,
          r.source_id,
          r.observation_id,
          r.confidence,
          r.id,
        ]),
      );
    }

    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export const LOOKUP_HELP = `igtrack lookup <username> [--json]

Ask the configured source what it can observe about one account, WITHOUT
persisting anything. This is the cheapest way for an agent to answer "is this
account observable at all, and from which source?".

Fixture answers are synthetic. Graph answers describe the authorized account
only — unless Business Discovery is explicitly enabled
(IGTRACK_GRAPH_BUSINESS_DISCOVERY=1), in which case another account's public
profile and a bounded recent-media preview come back as a PROBE from the
documented Business Discovery edge. Consumer and private accounts are
unreachable, and age-gated accounts return nothing: both are reported with the
reason instead of an empty profile. UNAVAILABLE means the source does not
expose it — the output says so instead of returning an empty object.`;

interface DiscoveredAccountView {
  account: { username: string; igId?: string; displayName?: string };
  displayName?: string;
  bio?: string;
  externalUrl?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  recentMedia: Array<{
    postId: string;
    takenAt: string;
    likeCount?: number;
    commentCount?: number;
    mediaType?: string;
    permalink?: string;
  }>;
}

export async function runLookup(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const username = args.positionals[0];
  if (username === undefined) throw new UsageError("Usage: igtrack lookup <username>");
  const ctx = await createContext();
  try {
    const result = await opLookup(ctx, { username });
    const rows: Array<[string, string]> = [
      ["username", `@${result.username}`],
      ["source", result.sourceId],
      ["route", display(result.via)],
      ["capability status", result.status],
      ["confidence", display(result.confidence)],
      ["observed at", display(result.observedAt)],
      ["note", display(result.note)],
      ["error", result.error === null ? "none" : `${result.error.kind}: ${result.error.message}`],
    ];
    const probe =
      result.via === "discovery" && result.status === "AVAILABLE"
        ? (result.account as DiscoveredAccountView)
        : null;
    const sections: string[] = [table(["field", "value"], rows)];
    if (probe !== null) {
      sections.push(
        "",
        table(
          ["field", "value"],
          [
            ["platform id", display(probe.account.igId ?? null)],
            ["display name", display(probe.displayName ?? null)],
            ["bio", display(probe.bio ?? null)],
            ["external url", display(probe.externalUrl ?? null)],
            ["followers", display(probe.followerCount ?? null)],
            ["following", display(probe.followingCount ?? null)],
            ["posts", display(probe.postCount ?? null)],
          ],
        ),
      );
      if (probe.recentMedia.length > 0) {
        sections.push(
          "",
          "recent media (bounded preview — not the account's full history)",
          table(
            ["post", "taken", "type", "likes", "comments"],
            probe.recentMedia.map((m) => [
              m.postId,
              m.takenAt,
              display(m.mediaType ?? null),
              display(m.likeCount ?? null),
              display(m.commentCount ?? null),
            ]),
          ),
        );
      }
    }
    const footer =
      result.status === "UNAVAILABLE"
        ? "The requested route does not expose this. Nothing was written."
        : "Nothing was persisted: `lookup` is a read-only probe.";
    const human = [...sections, "", footer].join("\n");
    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// dossier — everything recorded about one target, with its gaps named
// ---------------------------------------------------------------------------

export const DOSSIER_HELP = `igtrack dossier <target id|username> [--json]

Everything this deployment has RECORDED about one tracked account, read back
with its gaps intact: identity, profile snapshots and changes, follow deltas,
stories and mentions, stored media rows, and a per-capability coverage list
where every state is computed from rows that exist.

A capability with no rows is reported as NOT_OBSERVED with the reason a scan
cannot fill it, or as UNAVAILABLE with the platform's own reason — never as
empty data. Capabilities this project refuses by decision carry that refusal.

For a DISCOVERY target (another public account, tracked via
\`targets add <username> --observed\`) the stored media rows are a BOUNDED,
non-pageable preview: the row's \`publishedAt\` (the platform's publish time) and
\`firstObservedAt\` (when this deployment first saw it) are different facts and
are printed as such — newly discovered is not newly created.

Read-only. Nothing is fetched; this is a report over stored observations.`;

export async function runDossier(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError("Usage: igtrack dossier <target id|username>");
  }
  const ctx = await createContext();
  try {
    const result = await opDossier(ctx, { target });

    const sections: string[] = [
      `Dossier   @${result.account.username}  (${result.target.observationMode} · ${result.target.status})`,
      `Account   id ${result.account.id} · platform id ${display(result.account.igId)}`,
      `Profile   ${display(result.account.displayName)} · private ${display(result.account.isPrivate)} · verified ${display(result.account.isVerified)} · type ${display(result.account.accountType)}`,
      `Seen      first ${result.account.firstSeenAt} · last ${result.account.lastSeenAt}`,
      `Route     ${result.route.providerMethod} — ${result.route.scope}`,
      `Sources   ${result.route.observingSources.length === 0 ? "none recorded yet" : result.route.observingSources.join(", ")}`,
      "",
      "Coverage (state is computed from stored rows; reasons are the platform's or the registry's, never a guess):",
      table(
        ["capability", "state", "rows", "latest", "reason"],
        result.coverage.map((c) => [
          c.label,
          c.state,
          c.observedRows === null ? "no writer" : String(c.observedRows),
          c.latestObservedAt ?? "unavailable",
          [
            c.reason === null ? null : c.reason.replace(/\s+/g, " ").slice(0, 90),
            c.unlock === null ? null : `unlock: ${c.unlock.replace(/\s+/g, " ").slice(0, 60)}`,
            c.caveat === null ? null : `caveat: ${c.caveat.replace(/\s+/g, " ").slice(0, 90)}`,
          ]
            .filter((v) => v !== null)
            .join(" · "),
        ]),
      ),
    ];

    sections.push(
      "",
      "Profile snapshots:",
      result.profile.latest === null
        ? "  No profile snapshot recorded for this account yet."
        : table(
            ["field", "value"],
            [
              ["observed at", result.profile.latest.observedAt],
              ["source", result.profile.latest.sourceId],
              ["completeness", display(result.profile.latest.completeness)],
              ["followers", display(result.profile.latest.followerCount)],
              ["following", display(result.profile.latest.followingCount)],
              ["posts", display(result.profile.latest.postCount)],
              ["bio", display(result.profile.latest.biography)],
              ["external url", display(result.profile.latest.externalUrl)],
              ["verified", display(result.profile.latest.isVerified)],
            ],
          ),
      `  ${result.profile.snapshotCount} snapshot(s) · ${result.profile.changeCount} recorded field change(s)`,
    );

    if (result.media !== null) {
      sections.push(
        "",
        `Stored media rows (${result.media.storedCount})${result.media.bounded === true ? " — bounded preview" : ""}:`,
        table(
          ["post", "published", "first observed", "type", "likes", "comments", "comments state"],
          result.media.rows.map((m) => [
            m.postId,
            display(m.publishedAt),
            display(m.firstObservedAt),
            display(m.mediaType),
            display(m.likeCount),
            display(m.commentCount),
            m.commentsState,
          ]),
        ),
        `  published ${display(result.media.oldestPublishedAt)} … ${display(result.media.newestPublishedAt)} · first observed here ${display(result.media.firstObservedAt)} … ${display(result.media.lastObservedAt)}`,
      );
      if (result.media.truncated) {
        sections.push(
          "  Note: more rows are stored than the report lists; this table is capped.",
        );
      }
    }

    if (result.routeUnavailability.length > 0) {
      sections.push(
        "",
        "Routes that answered UNAVAILABLE for the sources observing this target:",
        table(
          ["source", "capability", "reason", "updated"],
          result.routeUnavailability.map((u) => [
            u.sourceId,
            u.capability,
            display(u.note).replace(/\s+/g, " ").slice(0, 110),
            u.updatedAt,
          ]),
        ),
      );
    }

    sections.push("", "Notes:", ...result.notes.map((n) => `  · ${n}`));

    emit({ json, meta: ctx.meta, data: result, human: sections.join("\n") });
    return 0;
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// insights — the metrics this deployment recorded while the platform showed them
// ---------------------------------------------------------------------------

export const INSIGHTS_HELP = `igtrack insights <target id|username> [--metric M] [--limit N] [--json]

What the platform reported about this account's own insights, as THIS
deployment recorded them.

Insights are the one observation family the platform does not keep for you: the
Graph API answers only for a bounded recent window, and demographics only as a
current-state snapshot. A series exists here only if a scan ran while the point
was visible, so the accumulation window is printed with the data.

A metric the platform did not return is listed as ABSENT with its reason — a
documented platform rule ("fewer than 100 followers") when one applies. It is
never shown as 0. \`--metric reach\` prints one metric's series oldest-first.

Live insights require the official Graph API on an account you own. The fixture
provider (default) answers with synthetic data.`;

export async function runInsights(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError("Usage: igtrack insights <target id|username> [--metric M]");
  }
  const ctx = await createContext();
  try {
    const result = await opInsights(ctx, {
      target,
      metric: flagString(args.flags, "metric"),
      limit: flagNumber(args.flags, "limit", 200),
    });

    const sections: string[] = [
      `Target   @${result.target.username} (${result.target.status})`,
      `Recorded ${result.state.points} values and ${result.state.absences} absences · last scan ${relativeTime(result.state.latestObservedAt)}`,
    ];

    if (result.state.latestAbsences.length > 0) {
      sections.push(
        "",
        "Absent at the most recent scan:",
        table(
          ["metric", "period", "reason"],
          result.state.latestAbsences.map((a) => [a.metric, a.period, a.reason]),
        ),
      );
    }

    sections.push(
      "",
      result.state.points === 0
        ? "No insight values recorded for this account yet. Run `igtrack scans run --kind INSIGHTS_SCAN` and then `igtrack work`."
        : "Latest recorded value per metric and breakdown:",
    );
    if (result.state.points > 0) {
      sections.push(
        table(
          ["metric", "period", "timeframe", "breakdown", "value", "bucket end", "observed"],
          result.latest.rows.map((r) => [
            r.metric,
            r.period,
            display(r.timeframe),
            r.dimension === null ? "none" : `${r.dimension}=${display(r.dimensionValue)}`,
            String(r.value),
            display(r.endTime),
            r.observedAt.toISOString(),
          ]),
        ),
      );
      if (result.latest.truncated) {
        sections.push(
          "Note: more buckets exist than the limit shows; raise --limit to see them.",
        );
      }
    }

    if (result.series !== null) {
      sections.push("", `Series for ${result.series.metric} (oldest first):`);
      sections.push(
        result.series.points.length === 0
          ? result.series.absentReason === null
            ? "No values recorded for this metric. The platform has not been observed to report it absent either — it may simply never have been recorded here."
            : `No values recorded. The platform reported it absent: ${result.series.absentReason}`
          : table(
              ["bucket end", "period", "value"],
              result.series.points.map((p) => [
                display(p.endTime),
                p.period,
                String(p.value),
              ]),
            ),
      );
    }

    emit({ json, meta: ctx.meta, data: result, human: sections.join("\n") });
    return 0;
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// capabilities — the honesty surface in text form.
// ---------------------------------------------------------------------------

export const CAPABILITIES_HELP = `igtrack capabilities [--json] [--available]

Print the capability registry: every capability IGTrack could show, whether a
provider method actually supplies it, and — when it cannot — the exact reason
(the platform does not expose it, or it needs a permission you do not have).
This is generated from the same registry the web UI renders, so the CLI can
never advertise more than the code delivers.`;

export async function runCapabilities(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const onlyAvailable = flagBool(args.flags, "available");
  const lines = capabilityLines().filter((l) => (onlyAvailable ? l.available : true));

  const data = {
    capabilities: CAPABILITY_REGISTRY.filter((entry) =>
      onlyAvailable
        ? entry.whyUnavailable === null && entry.providerMethods.length > 0
        : true,
    ),
    summary: {
      available: capabilityLines().filter((l) => l.available).length,
      total: CAPABILITY_REGISTRY.length,
    },
  };

  const human = [
    `${data.summary.available} of ${data.summary.total} capabilities are obtainable from a lawful source.`,
    "",
    table(
      ["capability", "state", "why not (when unavailable)"],
      lines.map((l) => [
        l.label,
        l.available ? `available · ${l.liveState}` : `UNAVAILABLE · ${l.liveState}`,
        l.why === null ? "" : l.why.replace(/\s+/g, " ").slice(0, 110),
      ]),
    ),
  ].join("\n");

  emit({
    json,
    meta: {
      provider: process.env.IGTRACK_PROVIDER ?? "fixture",
      sourceId: null,
      synthetic: false,
      production: process.env.NODE_ENV === "production",
      studio: "cli",
      generatedAt: new Date().toISOString(),
      note: "Static product capability registry — independent of the active data source.",
    },
    data,
    human,
  });
  return 0;
}

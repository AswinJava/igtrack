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
import { opActivity, opEvidence, opLookup, opRelationships } from "../tools.js";

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
        ? "No relationships observed yet. Relationship ranks come from COMPLETE follower/following snapshots and story mentions."
        : table(
            ["account", "score", "mentions", "deltas", "mutual", "first seen", "last seen", "basis"],
            result.ranks.map((r) => [
              `@${r.username}`,
              String(r.score),
              String(r.signals.mentions),
              String(r.signals.deltas),
              r.mutual ? "yes" : "no",
              r.firstSeenAt === null ? "unavailable" : r.firstSeenAt,
              r.lastSeenAt === null ? "not currently observed" : r.lastSeenAt,
              r.firstSeenBasis ?? "none",
            ]),
          ),
    ].join("\n");

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
only. UNAVAILABLE means the source does not expose it — the output says so
instead of returning an empty object.`;

export async function runLookup(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const username = args.positionals[0];
  if (username === undefined) throw new UsageError("Usage: igtrack lookup <username>");
  const ctx = await createContext();
  try {
    const result = await opLookup(ctx, { username });
    const human = [
      table(
        ["field", "value"],
        [
          ["username", `@${result.username}`],
          ["source", result.sourceId],
          ["capability status", result.status],
          ["confidence", display(result.confidence)],
          ["observed at", display(result.observedAt)],
          ["note", display(result.note)],
          ["error", result.error === null ? "none" : `${result.error.kind}: ${result.error.message}`],
        ],
      ),
      "",
      result.status === "UNAVAILABLE"
        ? "This source does not expose account resolution. Nothing was written."
        : "Nothing was persisted: `lookup` is a read-only probe.",
    ].join("\n");
    emit({ json, meta: ctx.meta, data: result, human });
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

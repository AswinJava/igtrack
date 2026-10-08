import { writeFileSync } from "node:fs";
import {
  CliError,
  display,
  emit,
  flagNumber,
  flagString,
  isJson,
  relativeTime,
  resolveUserPath,
  storedRowMeta,
  table,
  UsageError,
  type ParsedArgs,
} from "../output.js";
import { createContext } from "../context.js";
import {
  opAlerts,
  opAudience,
  opDigest,
  opExport,
  opRecent,
  opReport,
  opReports,
  EXPORT_KINDS,
} from "../tools.js";

// ---------------------------------------------------------------------------
// report / reports / audience / export / digest
//
// These commands render a period from stored rows only. None of them scans,
// enqueues work, or writes to the ledger: a report for last week is the same
// bytes today as it was last week because it is composed from the rows that
// already exist. A section that cannot be answered says so; it is never zero.
// ---------------------------------------------------------------------------

export const REPORT_HELP = `igtrack report <target> [--period weekly|monthly|quarterly|yearly]
                                 [--at <ISO date>] [--out <file>] [--json]

Compose one period from stored rows: profile movement, audience change, posts,
stories, engagement, comments, mentions, tags, insights, relationships and the
gaps. The period calendar is UTC: weeks start Monday, months and quarters are
calendar months and quarters. --at selects the period containing that date
(default: now).

Every section states its epistemic state:
  OBSERVED     rows exist and are printed with evidence ids
  DERIVED      arithmetic over stored rows (counts, means, deltas)
  EMPTY        the source answered and nothing was recorded in this window
  UNAVAILABLE  the source cannot answer at all, with the reason

Output is deterministic Markdown. --out writes it to a file. --json returns the
structured report plus the same Markdown. Nothing is generated, inferred or
narrated beyond what the rows support.`;

export const REPORTS_HELP = `igtrack reports <target> [--period P] [--limit N]

List the most recent periods for one target, newest first, with the stored event
count in each. State is COVERED (stored rows fall inside the window), EMPTY (no
rows) or IN_PROGRESS (the window has not ended). The listing never claims a
report was generated — only that data exists for the window. Each row prints the
exact \`igtrack report\` command that composes it.`;

export const AUDIENCE_HELP = `igtrack audience <target> [--since 30d] [--limit N]

Audience set algebra over the latest COMPLETE follower and following snapshots:
mutuals, accounts that follow the target but are not followed back, and accounts
the target follows that do not follow back. Counts are those sets' sizes.

Only COMPLETE rosters are used. A PARTIAL snapshot is a truncated read; treating
it as a roster would report every unread member as "does not follow you back".
When a side is absent the sets are empty and the reason is printed. Follow
movement since --since comes from stored follow deltas, which name every added
and removed account. --limit bounds each printed list.`;

export const RECENT_HELP = `igtrack recent <target> [--direction following|followers|both]
                           [--since <window>] [--limit N]

Who the target started following (or stopped following) since the stored
baseline.

Instagram exposes no follow timestamp for another account's Following list, so
this is a baseline-then-diff over stored rosters. The first COMPLETE snapshot is
the baseline; each later COMPLETE snapshot is diffed against the previous one,
and every row's firstSeenAt is when THIS ledger first recorded the edge, not
the Instagram follow time. Edges that existed before the baseline cannot be
dated and are never listed as recent.

--direction following (default) reads new/lost follows; followers reads new/lost
followers; both reads the two sides together. --since defaults to the baseline
instant, so by default the answer is "everything new since tracking started".
--limit bounds the printed rows; counts are the complete window counts.

States:
  OBSERVED     at least one delta was recorded in the window
  EMPTY        a baseline exists and nothing changed in the window
  UNAVAILABLE  no COMPLETE roster has ever been recorded for the requested side

Rosters are only readable from an owner export (import provider) or an
authorized Graph session. A logged-out page source cannot enumerate a roster,
and the output names that reason instead of printing an empty list.`;

export const EXPORT_HELP = `igtrack export <target> --kind <kind> [--format csv|json]
                           [--since 30d] [--limit N] [--out <file>]
                           [--period P] [--at <date>] [--search <text>]

Write stored rows to stdout (or a file with --out) as CSV or JSON. Kinds:
  activity    the event feed for this target
  report      one period, flattened to section/fact rows (uses --period/--at)
  posts       posts with a platform publish time inside the window
  comments    stored comments on owned media, with their text; --search
              applies a case-insensitive substring filter over comment text
              and author names (kind=comments only)
  stories     story first observations
  mentions    stored story-mention rows
  tagged      first-observation rows from the tags edge
  insights    own-account metric points (value or the platform's absence reason)
  followers   the latest COMPLETE follower roster
  following   the latest COMPLETE following roster
  audience    mutual / not-following-back / not-followed-back sets

Every observed row carries its provenance: \`evidence_id\`, the evidence's own
\`evidence_observed_at\`, \`source_id\` and \`synthetic\`. An unresolved evidence id
leaves those cells empty rather than guessing a source.

A roster export refuses when no COMPLETE snapshot exists: a truncated read is
not a roster. Exports never invent rows and never zero-fill a missing count.`;

export const DIGEST_HELP = `igtrack digest [target] [--since 7d] [--limit N] [--out <file>]

A short local change digest across tracked targets (or one target when named):
counts by event type, the accounts added and removed on each follow side, and
the newest events with their evidence ids. Named without a target it covers
every tracked target (the same scope as \`--all\`).

--out writes the digest text to a file so cron or an agent can deliver it; no
daemon, email or outbox is involved.

A period with no stored events is not proof the account was quiet — it means no
scan recorded anything. The digest says which of the two it is reporting.`;

export const ALERTS_HELP = `igtrack alerts [target] [--since 24h] [--limit N] [--types A,B] [--out <dir>]

The same stored-row events as \`digest\`, shaped as alerts: one record per event
with type, account, tracked target, summary, observed time and evidence id.
--types filters to exact event types (for example PROFILE_CHANGED,NEW_FOLLOWER);
omitted means every type. The filter is applied to this period's events, not
saved: re-running with another list composes a different selection.

--out <dir> writes a local outbox: one JSON file per alert, named by event type
and a stable hash of the alert id. Re-running over the same events rewrites
identical files (idempotent), so a cron job or an agent can poll the directory
without duplicating deliveries. Without --out nothing is written.

There is no email, SMS, webhook or background daemon. An alert is not an
evaluation of importance — it is a stored row you asked to be reminded of. A
period with no stored events produces an empty alert list, not a quiet-account
claim.`;

function writeOut(path: string, content: string): void {
  const resolved = resolveUserPath(path);
  try {
    writeFileSync(resolved, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  } catch (err) {
    throw new CliError(
      "EXPORT_WRITE_FAILED",
      `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      1,
    );
  }
}

export async function runReport(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError(
      "Usage: igtrack report <target id|username> [--period weekly|monthly|quarterly|yearly] [--at <date>] [--out <file>]",
    );
  }
  const format = (flagString(args.flags, "format") ?? "md").trim().toLowerCase();
  if (!["md", "markdown", "json"].includes(format)) {
    throw new UsageError(`--format expects md or json, received "${format}".`);
  }
  const out = flagString(args.flags, "out");
  const ctx = await createContext();
  try {
    const result = await opReport(ctx, {
      target,
      period: flagString(args.flags, "period"),
      at: flagString(args.flags, "at"),
    });
    if (out !== undefined) writeOut(out, result.markdown);
    const human =
      out !== undefined
        ? `Wrote the ${result.window.label} report for @${result.target.username} to ${out} (${result.report.sections.length} sections, ${result.report.gaps.length} gap(s)).`
        : format === "json"
          ? JSON.stringify(result.report, null, 2)
          : result.markdown;
    emit({
      json,
      meta: storedRowMeta(ctx.meta, {
        sourceIds: result.report.evidence.sourceIds,
        evidenceClass: result.report.evidence.evidenceClass,
      }),
      data: result,
      human,
    });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runReports(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError("Usage: igtrack reports <target id|username> [--period P] [--limit N]");
  }
  const ctx = await createContext();
  try {
    const result = await opReports(ctx, {
      target,
      period: flagString(args.flags, "period"),
      limit: flagNumber(args.flags, "limit", 8),
    });
    const human = [
      `Target   @${result.target.username} (${result.period} periods)`,
      `Ledger   ${result.ledgerStartsAt === null ? "no stored rows" : `starts ${result.ledgerStartsAt}`}`,
      "",
      table(
        ["window", "start", "end", "state", "stored events", "compose with"],
        result.windows.map((w) => [
          w.window.label,
          w.window.start,
          w.window.end,
          w.state,
          String(w.eventCount),
          w.command,
        ]),
      ),
      "",
      result.note,
    ].join("\n");
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

function count(n: number | null): string {
  return n === null ? "unavailable" : String(n);
}

function nameList(names: readonly string[], limit: number): string {
  if (names.length === 0) return "none recorded";
  const shown = names.slice(0, limit).map((n) => `@${n.replace(/^@/, "")}`);
  return names.length > limit ? `${shown.join(", ")} (+${names.length - limit} more)` : shown.join(", ");
}

export async function runAudience(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError("Usage: igtrack audience <target id|username> [--since 30d] [--limit N]");
  }
  const ctx = await createContext();
  try {
    const result = await opAudience(ctx, {
      target,
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 200),
    });
    const limit = Math.min(result.rosterLimit, 50);
    const snap = (side: typeof result.snapshots.followers): string =>
      side.complete
        ? `${side.usernames.length} accounts · snapshot ${side.snapshotId} · taken ${display(side.takenAt)} · evidence ${display(side.evidenceId)}`
        : "no COMPLETE snapshot on record";
    // Every set needs both rosters. When either is absent the answer is
    // "unavailable", never "0": an empty list here would read as "nobody".
    const setsComputed = result.sets.complete;
    const setCount = (value: number): string => (setsComputed ? String(value) : "unavailable");
    const setNames = (names: readonly string[]): string =>
      setsComputed ? nameList(names, limit) : "unavailable";
    const human = [
      `Target       @${result.target.username} (${result.target.status})`,
      `Followers    ${snap(result.snapshots.followers)}`,
      `Following    ${snap(result.snapshots.following)}`,
      "",
      table(
        ["set", "count"],
        [
          ["followers", count(result.sets.followerCount)],
          ["following", count(result.sets.followingCount)],
          ["mutual", count(result.sets.mutualCount)],
          ["follows you, not followed back", setCount(result.sets.notFollowingBack.length)],
          ["you follow, not following back", setCount(result.sets.notFollowedBack.length)],
        ],
      ),
      "",
      `Mutual                  ${setNames(result.sets.mutuals)}`,
      `Not following back      ${setNames(result.sets.notFollowingBack)}`,
      `Not followed back       ${setNames(result.sets.notFollowedBack)}`,
      result.truncated
        ? `Truncated               lists are bounded at ${result.rosterLimit}; counts above are the complete set sizes.`
        : "",
      "",
      result.recent === null
        ? ""
        : [
            `Follow movement since ${result.recent.since.toISOString()} (stored deltas)`,
            `  new followers      ${nameList(result.recent.newFollowers, limit)}`,
            `  lost followers     ${nameList(result.recent.lostFollowers, limit)}`,
            `  now following      ${nameList(result.recent.newFollowing, limit)}`,
            `  no longer following ${nameList(result.recent.lostFollowing, limit)}`,
            `  new mutuals        ${result.recent.newMutuals === null ? "unavailable (a roster side is absent)" : nameList(result.recent.newMutuals, limit)}`,
            result.recent.truncated ? `  (movement lists are bounded at ${result.rosterLimit})` : "",
          ]
            .filter((line) => line !== "")
            .join("\n"),
      ...result.notes.map((n) => `Note: ${n}`),
    ]
      .filter((line) => line !== "")
      .join("\n");
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runRecent(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError(
      "Usage: igtrack recent <target id|username> [--direction following|followers|both] [--since <window>] [--limit N]",
    );
  }
  const ctx = await createContext();
  try {
    const result = await opRecent(ctx, {
      target,
      direction: flagString(args.flags, "direction"),
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 50),
    });
    const side = (block: typeof result.baseline.following): string =>
      block.baselineAt === null
        ? "no COMPLETE snapshot on record"
        : `baseline ${display(block.baselineAt)} · latest ${display(block.latestAt)} · ${block.size ?? "?"} accounts`;
    const countCell = (value: number | null): string => (value === null ? "not read" : String(value));
    const human = [
      `Target       @${result.target.username} (${result.target.status})`,
      `Direction    ${result.direction}`,
      `Window       since ${result.since.toISOString()} (first-seen times)`,
      `State        ${result.state}`,
      `Following    ${side(result.baseline.following)}`,
      `Followers    ${side(result.baseline.followers)}`,
      "",
      table(
        ["change", "count"],
        [
          ["new following", countCell(result.counts.newFollowing)],
          ["lost following", countCell(result.counts.lostFollowing)],
          ["new followers", countCell(result.counts.newFollowers)],
          ["lost followers", countCell(result.counts.lostFollowers)],
        ],
      ),
      "",
      result.rows.length === 0
        ? result.state === "UNAVAILABLE"
          ? "No recent activity can be shown: there is no baseline to diff."
          : "No add or removal was recorded in this window."
        : table(
            ["first seen", "change", "account", "present now", "mutual now", "evidence"],
            result.rows.map((row) => [
              relativeTime(row.firstSeenAt),
              row.change.replace(/_/g, " ").toLowerCase(),
              `@${row.username}`,
              row.presentNow === null ? "unknown" : row.presentNow ? "yes" : "no",
              row.mutualNow === null ? "unknown" : row.mutualNow ? "yes" : "no",
              display(row.evidenceId),
            ]),
          ),
      result.truncated
        ? `Truncated    newest ${result.limit} of ${result.counts.total ?? "?"} row(s).`
        : "",
      ...result.notes.map((note) => `Note: ${note}`),
    ]
      .filter((line) => line !== "")
      .join("\n");
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runExport(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError(`Usage: igtrack export <target id|username> --kind <${EXPORT_KINDS.join("|")}> [--format csv|json] [--out <file>]`);
  }
  const kind = flagString(args.flags, "kind");
  if (kind === undefined) {
    throw new UsageError(`--kind is required. One of: ${EXPORT_KINDS.join(", ")}.`);
  }
  const out = flagString(args.flags, "out");
  const ctx = await createContext();
  try {
    const result = await opExport(ctx, {
      target,
      kind,
      format: flagString(args.flags, "format"),
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 10_000),
      period: flagString(args.flags, "period"),
      at: flagString(args.flags, "at"),
      search: flagString(args.flags, "search"),
    });
    if (out !== undefined) writeOut(out, result.content);
    const human =
      out !== undefined
        ? `Wrote ${result.rowCount} ${result.kind} row(s) for @${result.target.username} to ${out} (${result.format}).${result.truncated ? " The export was truncated by --limit." : ""}`
        : result.content;
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runAlerts(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  const out = flagString(args.flags, "out");
  const rawTypes = flagString(args.flags, "types") ?? flagString(args.flags, "type");
  const types =
    rawTypes === undefined
      ? undefined
      : rawTypes
          .split(",")
          .map((type) => type.trim())
          .filter((type) => type !== "");
  const ctx = await createContext();
  try {
    const result = await opAlerts(ctx, {
      target,
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 50),
      out,
      types,
    });
    const human = [
      `Alerts   ${result.scope} · ${result.since} → ${result.until}${result.types === null ? "" : ` · types: ${result.types.join(", ")}`}`,
      `Alerts   ${result.count}${result.truncated ? ` (digest total ${result.digestTotal}; list bounded by --limit)` : ""}`,
      "",
      result.alerts.length === 0
        ? "No stored events in this period. That is a fact about the record, not proof the account was quiet."
        : table(
            ["when", "type", "target", "account", "summary", "evidence"],
            result.alerts.map((alert) => [
              relativeTime(alert.observedAt),
              alert.type,
              alert.target ?? "unattributed",
              alert.account,
              alert.summary,
              alert.evidenceId ?? "none",
            ]),
          ),
      "",
      result.outbox === null
        ? "Outbox   none (pass --out <dir> to write alert files)"
        : `Outbox   ${result.outbox.written} new file(s), ${result.outbox.existing} already present in ${result.outbox.dir}`,
      result.note,
    ].join("\n");
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

export async function runDigest(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const target = args.positionals[0];
  const out = flagString(args.flags, "out");
  const ctx = await createContext();
  try {
    const result = await opDigest(ctx, {
      target,
      since: flagString(args.flags, "since"),
      limit: flagNumber(args.flags, "limit", 50),
    });
    const countRows = Object.entries(result.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const movement = [
      result.named.newFollowers.length > 0 ? `New followers        ${result.named.newFollowers.join(", ")}` : "",
      result.named.lostFollowers.length > 0 ? `Lost followers       ${result.named.lostFollowers.join(", ")}` : "",
      result.named.newFollowing.length > 0 ? `Now following        ${result.named.newFollowing.join(", ")}` : "",
      result.named.lostFollowing.length > 0 ? `No longer following  ${result.named.lostFollowing.join(", ")}` : "",
    ].filter((line) => line !== "");
    const digestText = [
      `Digest   ${result.scope} · ${result.since.toISOString()} → ${result.until.toISOString()}`,
      `Events   ${result.total}${result.truncated ? ` (latest ${result.items.length} shown)` : ""}`,
      "",
      countRows.length === 0 ? "No recorded events in this period." : table(["type", "count"], countRows.map(([type, count]) => [type, String(count)])),
      movement.length === 0 ? "" : "",
      ...movement,
      result.items.length === 0
        ? ""
        : table(
            ["when", "type", "account", "target", "summary", "evidence"],
            result.items.map((item) => [
              relativeTime(item.timestamp),
              item.type,
              item.account,
              item.target ?? "unattributed",
              item.summary,
              item.evidenceId ?? "none",
            ]),
          ),
      "",
      result.note,
    ]
      .filter((line) => line !== "")
      .join("\n");
    if (out !== undefined) writeOut(out, digestText);
    const human =
      out === undefined
        ? digestText
        : `Wrote the ${result.scope} digest to ${out} (${result.total} event(s) since ${result.since.toISOString()}).`;
    emit({ json, meta: storedRowMeta(ctx.meta, result.evidence), data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

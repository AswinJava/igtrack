import { writeFileSync } from "node:fs";
import {
  CliError,
  emit,
  flagNumber,
  flagString,
  isJson,
  resolveUserPath,
  storedRowMeta,
  UsageError,
  type ParsedArgs,
} from "../output.js";
import { createContext } from "../context.js";
import { opActivityReport } from "../tools.js";
import { renderActivityReportMarkdown } from "@igtrack/core";

// ---------------------------------------------------------------------------
// activity-report — the four-tab Activity Report, composed from stored rows
// only.
//
// Read-only like `report`: nothing is scanned, queued or written. The Markdown
// is the contract (four tabs in the audited order); --json returns the same
// structure with every unavailable field present as null + reason.
// ---------------------------------------------------------------------------

export const ACTIVITY_REPORT_HELP = `igtrack activity-report <target> [options]

Compose the four-tab Activity Report over stored rows for one target:

  Activity Analytics   follow movement, posts, stories, comments, tagged media,
                       active window, hashtags, comment ranks, post list
  Ties & Trails        all-time totals with this-month counts, days analyzed,
                       comment map, media tags, period timeline, top comments
  Stories & Highlights stored stories for the period; highlights UNAVAILABLE
  AI Insights          UNAVAILABLE by design: no provider, no inference

Periods use the report data types: daily=DAILY, weekly=WEEK,
monthly=MONTH, quarterly=SEASON, yearly=YEAR. Calendar windows are UTC;
weeks start Monday and every end is exclusive.

Options:
  --period daily|weekly|monthly|quarterly|yearly   default weekly
  --at <ISO date|YYYY-MM-DD>    period containing this instant (default now)
  --data-id <id>                exact period id from reports[].data_id
  --tab all|analytics|trails|stories|insights      default all
  --limit <n>                   timeline rows printed (default 50)
  --inventory-limit <n>         periods listed in the inventory (default 180)
  --format md|json              human output (default md)
  --out <file>                  write the Markdown to a file
  --json                        standard JSON envelope around the result

The report never zero-fills. A metric the stored ledger cannot answer is null,
state UNAVAILABLE, and carries the capability-registry reason. Likes given,
liker identities, interaction history, highlights, verified ratios, cross-
platform identities, places and AI inferences have no lawful source here and
are refused rather than guessed. Synthetic rows are labelled in JSON and in a
banner at the top of the Markdown. Nothing in this command scans or writes.`;

export async function runActivityReport(args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (target === undefined) {
    throw new UsageError(
      "Usage: igtrack activity-report <target id|username> [--period daily|weekly|monthly|quarterly|yearly] [--at <date>] [--data-id <id>] [--tab all|analytics|trails|stories|insights] [--format md|json] [--out <file>]",
    );
  }
  const format = (flagString(args.flags, "format") ?? "md").trim().toLowerCase();
  if (!["md", "markdown", "json"].includes(format)) {
    throw new UsageError(`--format expects md or json, received "${format}".`);
  }
  const tabRaw = (flagString(args.flags, "tab") ?? "all").trim().toLowerCase();
  if (!["all", "analytics", "trails", "stories", "insights"].includes(tabRaw)) {
    throw new UsageError(
      `--tab expects all, analytics, trails, stories or insights, received "${tabRaw}".`,
    );
  }
  const timelineLimit = flagNumber(args.flags, "limit", 50);
  if (timelineLimit < 0) throw new UsageError("--limit must be zero or greater.");
  const inventoryLimit = flagNumber(args.flags, "inventory-limit", 180);
  const out = flagString(args.flags, "out");
  // A `--format json` answer with nowhere else to go is machine-shaped, and a
  // machine-shaped answer carries `_meta` — the source id and synthetic label
  // belong to the data, not to a second flag the caller must remember.
  const json = isJson(args.flags) || (out === undefined && format === "json");

  const ctx = await createContext();
  try {
    const result = await opActivityReport(ctx, {
      target,
      period: flagString(args.flags, "period"),
      at: flagString(args.flags, "at"),
      dataId: flagString(args.flags, "data-id"),
      inventoryLimit,
    });
    const tab = tabRaw as "all" | "analytics" | "trails" | "stories" | "insights";
    const markdown = renderActivityReportMarkdown(result.report, { tab, timelineLimit });
    if (out !== undefined) {
      const resolved = resolveUserPath(out);
      try {
        writeFileSync(resolved, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
      } catch (err) {
        throw new CliError(
          "EXPORT_WRITE_FAILED",
          `Could not write ${out}: ${err instanceof Error ? err.message : String(err)}`,
          1,
        );
      }
    }
    const human =
      out !== undefined
        ? `Wrote the ${result.report.data_type} ${result.window.label} activity report for @${result.target.username} to ${out} (${result.report.tabs.ties_and_trails.timeline_total} period(s), ${result.report.reports_delivered} delivered).`
        : format === "json"
          ? JSON.stringify(result.report, null, 2)
          : markdown;
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

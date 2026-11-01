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
import { opTracker } from "../tools.js";
import { renderTrackerCardMarkdown, renderTrackerOverviewMarkdown } from "@igtrack/core";

// ---------------------------------------------------------------------------
// tracker — the watchlist of observed accounts and their closed-period cards.
//
// Read-only like `activity-report`: nothing is scanned, queued or written. The
// Markdown is composed from stored rows, and every unavailable metric carries
// its registry reason instead of a zero.
// ---------------------------------------------------------------------------

export const TRACKER_HELP = `igtrack tracker [target] [options]

Watchlist of tracked accounts with one closed-period card each. Without a
target the overview lists every owned target, sorted by last observation
(newest first) then username, with the seven observed counts per card:

  new followings   follow deltas first observed inside the window
  unfollows        lost-follow deltas first observed inside the window
  posts stories comments tags mentions   stored rows in the window

With a target the full card adds the new-follow/unfollow rosters, top
commenters, recent comments, posts, hashtags, evidence ids, next-scan state
and the explicit refusals.

The default period is weekly and, without --at, the latest CLOSED window is
selected (an open window's zero is not a completed zero). --at selects the
containing window exactly, including a window that has not closed; that card
is labelled IN_PROGRESS.

Options:
  --period daily|weekly|monthly|quarterly|yearly   default weekly
  --at <ISO date|YYYY-MM-DD>    window containing this instant (may be open)
  --limit <n>                   overview cards printed (default 12, max 50)
  --format md|json              human output (default md)
  --out <file>                  write the Markdown to a file
  --json                        standard JSON envelope around the result

Nothing is scanned, queued or written to the database. Counts come from the
same stored rows as igtrack activity-report, so the two cannot disagree about
a window. A metric no lawful source answers is null with state UNAVAILABLE and
a capability-registry reason; accounts liked, highlights, verified followings,
AI insights, cross-platform identities, places and email delivery are refused
rather than guessed. A follow count of zero is printed only when a COMPLETE
following-roster comparison measured it. Synthetic rows are labelled in JSON
and in the Markdown.`;

export async function runTracker(args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  const limit = flagNumber(args.flags, "limit", 12);
  const out = flagString(args.flags, "out");
  const format = (flagString(args.flags, "format") ?? "md").trim().toLowerCase();
  if (!["md", "markdown", "json"].includes(format)) {
    throw new UsageError(`--format expects md or json, received "${format}".`);
  }
  // A `--format json` answer with nowhere else to go is machine-shaped, and a
  // machine-shaped answer carries `_meta` — the source id and synthetic label
  // belong to the data, not to a second flag the caller must remember.
  const json = isJson(args.flags) || (out === undefined && format === "json");

  const ctx = await createContext();
  try {
    const result = await opTracker(ctx, {
      target,
      period: flagString(args.flags, "period"),
      at: flagString(args.flags, "at"),
      limit,
    });
    const markdown =
      result.mode === "target" && result.card !== null
        ? renderTrackerCardMarkdown(result.card)
        : result.overview !== null
          ? renderTrackerOverviewMarkdown(result.overview)
          : "";

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

    const summary =
      result.mode === "target" && result.card !== null
        ? `Wrote the ${result.card.period.data_type} ${result.card.period.label} tracker card for @${result.card.target.username} to ${out} (${result.card.period.state}).`
        : `Wrote the ${result.window.label} watchlist to ${out} (${result.overview?.totals.displayed ?? "unknown"} of ${result.overview?.totals.tracked ?? "unknown"} target(s)).`;

    const human =
      out !== undefined
        ? summary
        : format === "json"
          ? JSON.stringify(result, null, 2)
          : markdown;

    const evidence =
      result.card?.evidence ?? result.overview?.evidence ?? {
        sourceIds: [],
        evidenceClass: "NONE" as const,
      };
    emit({
      json,
      meta: storedRowMeta(ctx.meta, {
        sourceIds: evidence.sourceIds,
        evidenceClass: evidence.evidenceClass,
      }),
      data: result,
      human,
    });
    return 0;
  } finally {
    await ctx.close();
  }
}

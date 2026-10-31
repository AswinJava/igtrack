import { writeFileSync } from "node:fs";
import {
  VIEWER_TABS,
  type ViewerReport,
  type ViewerStoryRow,
  type ViewerTab,
  type ViewerTabKey,
} from "@igtrack/core";
import { opViewer } from "../tools.js";
import {
  CliError,
  display,
  emit,
  envelope,
  flagNumber,
  flagString,
  isJson,
  resolveOptionalUserPath,
  table,
  UsageError,
  type OutputMeta,
  type ParsedArgs,
} from "../output.js";

// ---------------------------------------------------------------------------
// `igtrack viewer <input>` — the six-tab account viewer.
//
// Database-free composition of the logged-out public page and the login-free
// aggregator, in the fixed tab order. Tabs no lawful source can answer are
// UNAVAILABLE with a typed reason; counts are observed rows, kept separate
// from any number the platform declared.
// ---------------------------------------------------------------------------

export const VIEWER_HELP = `igtrack viewer <input> [options]

Read one public account as a six-tab viewer report — Stories, Posts, Reels,
Highlights, Reposts, Tagged — composed from the logged-out public profile page
and the login-free aggregator. Nothing is stored, no scan is queued, and no
third-party viewer API is called.

Input
  <username>                 @name or name
  <profile URL>              instagram.com/<name>
  <post or reel URL>         the owner is resolved from the media page
  <story URL>                /stories/<name>/<id> selects the Stories tab

Options
  --tab <name>       story|post|reels|highlights|repost|tagged|all
                     (default: the tab the input selects; username → story)
  --mention <name>   Mark the stories/highlight items that name this account
  --source <name>    public|anonstories|both   (default: both)
  --max-posts <n>    Cap on public media rows read (default 60)
  --max-highlights <n>  Highlights whose contents are opened (default 5)
  --chrome <path>    Browser executable (default: IGTRACK_CHROME_PATH)
  --json             Print the standard { ok, data, _meta } envelope
  --out <file>       Also write the envelope to <file>

Honesty contract: every tab carries its evidence class (PUBLIC_WEB or
PUBLIC_AGGREGATOR). count is what this report observed; declaredCount is the
platform's own number and is never merged with it. Reposts, tagged media for
another account, liker identities and AI inferences are UNAVAILABLE with the
registry reason — not empty results. A private account yields only its public
profile shell. Media rows carry original source URLs; nothing is proxied or
re-served.`;

function viewerMeta(report: ViewerReport, note?: string): OutputMeta {
  const sources = report.profile.sources.join("+");
  return {
    provider: "viewer",
    sourceId: sources === "" ? "viewer:v1" : `viewer:${sources}`,
    synthetic: false,
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: report.generatedAt,
    note:
      note ??
      `Read-only six-tab composition of ${report.requestedSources.join(" + ")}. Evidence classes are stated per tab; unavailable tabs carry their reason.`,
  };
}

function firstLine(value: string | null, max = 70): string {
  if (value === null) return "—";
  const line = value.split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function mentioned(row: ViewerStoryRow): string {
  if (row.mentions.length === 0) return "—";
  return row.mentions
    .map((mention) => `@${mention.username}${mention.isReshareAuthor ? " (reshare)" : ""}`)
    .join(", ");
}

function tabCount(tab: ViewerTab): string {
  if (tab.status === "UNAVAILABLE") return "UNAVAILABLE";
  const observed = tab.count ?? 0;
  if (tab.declaredCount !== null && tab.declaredCount !== observed) {
    return `${observed} observed / ${tab.declaredCount} declared`;
  }
  return String(observed);
}

function tabStrip(report: ViewerReport): string {
  return VIEWER_TABS.map(({ key, label }) => {
    const tab = report.tabs.find((candidate) => candidate.key === key);
    return `${label} ${tab === undefined ? "—" : tabCount(tab)}`;
  }).join("  |  ");
}

function renderStoryRows(rows: ViewerStoryRow[]): string {
  if (rows.length === 0) return "(none observed)";
  return table(
    ["story id", "published", "age", "type", "mentions", "link", "media"],
    rows.map((row) => [
      row.id === "" ? "—" : row.id,
      display(row.publishedAt),
      display(row.age),
      display(row.mediaType),
      mentioned(row),
      firstLine(row.linkUrl),
      firstLine(row.mediaUrl),
    ]),
  );
}

function renderTab(report: ViewerReport, tab: ViewerTab): string {
  const lines: string[] = [];
  lines.push(`${tab.label} — ${tabCount(tab)}`);
  if (tab.status === "UNAVAILABLE") {
    lines.push(`UNAVAILABLE (${tab.reasonKind ?? "STRUCTURAL"}): ${tab.reason ?? "no reason recorded"}`);
    return lines.join("\n");
  }
  if (tab.reason !== null) lines.push(`Note: ${tab.reason}`);

  if (tab.key === "story") {
    lines.push(renderStoryRows(tab.rows));
  } else if (tab.key === "post" || tab.key === "reels") {
    lines.push(
      tab.rows.length === 0
        ? "(none observed)"
        : table(
            ["shortcode", "published", "type", "likes", "comments", "plays", "detail", "caption"],
            tab.rows.map((row) => [
              row.shortcode,
              display(row.takenAt),
              display(row.productType ?? row.mediaType),
              display(row.likeCount),
              display(row.commentCount),
              display(row.playCount),
              row.detailStatus,
              firstLine(row.caption),
            ]),
          ),
    );
    if (tab.rows.length > 0) {
      lines.push(
        "",
        "Media URLs (source, not proxied)",
        ...tab.rows.map(
          (row) =>
            `  ${row.shortcode}  ${row.videoUrl ?? row.displayUrl ?? row.thumbnailUrl ?? "unavailable"}`,
        ),
      );
    }
  } else if (tab.key === "highlights") {
    lines.push(
      tab.rows.length === 0
        ? "(none observed)"
        : table(
            ["title", "id", "contents", "items", "source", "reason"],
            tab.rows.map((row) => [
              display(row.title),
              row.id,
              row.contentsStatus,
              row.itemCount === null ? "—" : String(row.itemCount),
              row.sources.join(", "),
              display(row.contentsReason),
            ]),
          ),
    );
    for (const highlight of tab.rows) {
      if (highlight.contentsStatus !== "READ" || highlight.items.length === 0) continue;
      lines.push(
        "",
        `Highlight ${highlight.title ?? highlight.id} (${highlight.items.length} item(s) read)`,
        renderStoryRows(highlight.items),
      );
    }
  }

  if (tab.sources.length > 0) {
    lines.push("", `Evidence classes: ${tab.evidenceClasses.join(", ")} · sources: ${tab.sources.join(", ")}`);
  }
  return lines.join("\n");
}

export interface ViewerRenderOptions {
  tab: ViewerTabKey | "all";
}

export function renderViewerHuman(
  report: ViewerReport,
  options: ViewerRenderOptions = { tab: report.focus.tab },
): string {
  const sections: string[] = [];
  const profile = report.profile;

  sections.push(
    table(
      ["field", "value"],
      [
        ["username", `@${profile.username}`],
        ["name", display(profile.fullName)],
        ["private", display(profile.isPrivate)],
        ["verified", display(profile.isVerified)],
        ["followers", display(profile.followerCount)],
        ["following", display(profile.followingCount)],
        ["posts (declared)", display(profile.declaredPostCount)],
        ["profile picture", display(profile.profilePicUrl)],
        ["sources", profile.sources.length === 0 ? "—" : profile.sources.join(", ")],
        ["requested", report.requestedSources.join(" + ") || "—"],
        ["input", `${report.input.kind}: ${report.input.raw}`],
      ],
    ),
  );
  if (profile.biography !== null) sections.push("", "Bio", profile.biography);

  sections.push("", tabStrip(report));

  const selected = report.tabs.filter(
    (tab) => options.tab === "all" || tab.key === options.tab,
  );
  for (const tab of selected) {
    sections.push("", renderTab(report, tab));
  }

  sections.push(
    "",
    `Mentions${report.mentions.count === null ? " (UNAVAILABLE)" : ` (${report.mentions.count})`}`,
  );
  if (report.mentions.count === null) {
    sections.push(report.mentions.reason ?? "The mention index was not read.");
  } else if (report.mentions.rows.length === 0) {
    sections.push("(no observed story or highlight named another account)");
  } else {
    sections.push(
      table(
        ["username", "name", "private", "verified", "items", "seen in"],
        report.mentions.rows.map((row) => [
          `@${row.username}`,
          display(row.fullName),
          display(row.isPrivate),
          display(row.isVerified),
          String(row.itemCount),
          row.seenIn.join(", "),
        ]),
      ),
    );
  }

  if (report.mentionFocus !== null) {
    const focus = report.mentionFocus;
    sections.push("", `Mention focus: @${focus.username}`);
    if (!focus.matched) {
      sections.push(focus.reason ?? "No observed item named this account.");
    } else {
      sections.push(`${focus.itemCount} item(s) named this account.`);
      if (focus.storyIds.length > 0) sections.push(`  stories: ${focus.storyIds.join(", ")}`);
      for (const entry of focus.highlightItems) {
        sections.push(`  highlight ${entry.highlightId}: ${entry.itemIds.join(", ")}`);
      }
    }
  }

  const popularity = report.popularity;
  sections.push(
    "",
    "Popularity (loaded sample)",
    table(
      ["metric", "value"],
      [
        ["sample size", String(popularity.sampleSize)],
        ["likes", popularity.likeTotal === null ? "unavailable" : `${popularity.likeTotal} over ${popularity.likeSampleSize} row(s)`],
        ["like average", display(popularity.likeAverage)],
        ["comments", popularity.commentTotal === null ? "unavailable" : `${popularity.commentTotal} over ${popularity.commentSampleSize} row(s)`],
        ["comment average", display(popularity.commentAverage)],
      ],
    ),
  );
  if (popularity.reason !== null) sections.push(popularity.reason);

  sections.push("", "Refused by design");
  for (const refusal of report.refusals) {
    sections.push(`  · ${refusal.label} [${refusal.capability}]: ${refusal.reason}`);
  }

  sections.push(
    "",
    "Coverage",
    table(
      ["tab", "status", "observed", "reason"],
      report.coverage.map((row) => [
        row.subject,
        row.status,
        row.value === null || row.value === undefined ? "—" : String(row.value),
        row.reason ?? "—",
      ]),
    ),
  );

  sections.push("", `Gaps (${report.gaps.length})`);
  if (report.gaps.length === 0) {
    sections.push("(none declared)");
  } else {
    for (const gap of report.gaps) {
      sections.push(`  · ${gap.subject}: ${gap.reason}`);
      if (gap.howToImprove !== null) sections.push(`    improve: ${gap.howToImprove}`);
    }
  }

  sections.push(
    "",
    `Downloads: ${report.downloadPolicy.mode}`,
    report.downloadPolicy.note,
  );

  sections.push("", "Notes");
  for (const note of report.notes) sections.push(`  · ${note}`);

  return sections.join("\n");
}

function parseTab(value: string | undefined): ViewerTabKey | "all" | undefined {
  if (value === undefined) return undefined;
  if (value === "all") return "all";
  const keys = VIEWER_TABS.map((tab) => tab.key);
  if (!(keys as readonly string[]).includes(value)) {
    throw new UsageError(
      `Unknown tab "${value}". Use one of: ${[...keys, "all"].join(", ")}.`,
    );
  }
  return value as ViewerTabKey;
}

function parseSource(value: string | undefined): "public" | "anonstories" | "both" {
  if (value === undefined) return "both";
  if (value === "public" || value === "anonstories" || value === "both") return value;
  throw new UsageError(`Unknown source "${value}". Use public, anonstories or both.`);
}

export async function runViewer(args: ParsedArgs): Promise<number> {
  const input = args.positionals[0];
  if (input === undefined) {
    throw new UsageError(
      "Usage: igtrack viewer <username|profile URL|post URL|story URL> [--tab <name>] [--json]",
    );
  }
  const json = isJson(args.flags);
  const out = resolveOptionalUserPath(flagString(args.flags, "out"));
  const tab = parseTab(flagString(args.flags, "tab"));
  const source = parseSource(flagString(args.flags, "source"));
  const mention = flagString(args.flags, "mention");
  const chromePath = flagString(args.flags, "chrome");
  const maxPosts = flagNumber(args.flags, "max-posts", 60);
  const maxHighlights = flagNumber(args.flags, "max-highlights", 5);

  const report = await opViewer({
    input,
    source,
    ...(tab !== undefined && tab !== "all" ? { tab } : {}),
    ...(mention !== undefined ? { mention } : {}),
    ...(chromePath !== undefined ? { chromePath } : {}),
    maxPosts,
    maxHighlights,
  });

  const meta = viewerMeta(
    report,
    out !== undefined ? `Viewer report written to ${out}.` : undefined,
  );
  if (out !== undefined) {
    try {
      writeFileSync(out, `${JSON.stringify(envelope(report, viewerMeta(report)), null, 2)}\n`, "utf8");
    } catch (err) {
      throw new CliError(
        "WRITE_FAILED",
        `Could not write ${out}: ${err instanceof Error ? err.message : String(err)}`,
        1,
      );
    }
  }

  const human = renderViewerHuman(report, {
    tab: tab ?? report.focus.tab,
  });
  emit({
    json,
    meta,
    data: report,
    human: out !== undefined ? `${human}\n\nWritten to ${out}` : human,
  });
  return 0;
}

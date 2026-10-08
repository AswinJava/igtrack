import { writeFileSync } from "node:fs";
import { AnonStoriesProvider, type AnonStoriesDossier } from "@igtrack/ingestion";
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
// `igtrack anonstories <username>` — the login-free aggregator dossier.
//
// What the logged-out profile page cannot expose — active stories, each
// highlight's contents, and every account named in that story metadata — is
// readable from a third-party aggregator (anonstories.com) without a login.
// This command is the DB-free inspection surface, exactly like `igtrack
// public`; storing is `igtrack investigate`/`work` with
// IGTRACK_PROVIDER=anonstories. The source is named on every row: this is a
// third-party relay (PUBLIC_AGGREGATOR), never an Instagram page and never a
// Graph API response.
// ---------------------------------------------------------------------------

export const ANONSTORIES_HELP = `igtrack anonstories <username> [--json] [--out <file>]

Read stories, highlights and story mentions for any public username without a
login, through the anonstories.com aggregator, and print the complete dossier:
account, active stories with their metadata mentions, the highlight list, each
highlight's contents, the merged mention index, and every explicit gap.

Options
  --json             Print the standard { ok, data, _meta } envelope
  --out <file>       Also write the envelope (pretty JSON) to <file>
  --chrome <path>    Browser executable (default: IGTRACK_CHROME_PATH, then
                      a detected Chrome/Chromium/Edge)
  --max-highlights <n>  Highlights whose contents are opened (default 5; the
                      aggregator rate-limits after ~5 rapid calls)

Honesty contract: rows are PUBLIC_AGGREGATOR at MEDIUM confidence — a
third-party relay, not a platform observation. UNAVAILABLE classes (rosters,
posts, comments, tags, insights) stay UNAVAILABLE with their reasons, private
profiles are refused rather than guessed, and a rate-limited or queued answer
is reported as such instead of as an empty result.`;

function providerMeta(note?: string): OutputMeta {
  return {
    provider: "anonstories",
    sourceId: "anonstories:v1",
    synthetic: false,
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
    note:
      note ??
      "Live reading of a third-party public aggregator (anonstories.com) through a local browser. PUBLIC_AGGREGATOR — not an Instagram page and not an official Graph API response.",
  };
}

function firstLine(value: string | undefined, max = 60): string {
  if (value === undefined) return "—";
  const line = value.split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function mentionLabel(
  mentions: Array<{ username: string; isReshareAuthor?: boolean; fullName?: string }>,
): string {
  if (mentions.length === 0) return "—";
  return mentions
    .map((mention) => `@${mention.username}${mention.isReshareAuthor === true ? " (reshare source)" : ""}`)
    .join(", ");
}

function renderHuman(dossier: AnonStoriesDossier): string {
  const account = dossier.account;
  const sections: string[] = [];

  sections.push(
    table(
      ["field", "value"],
      [
        ["username", `@${account.username}`],
        ["name", display(account.fullName)],
        ["aggregator id (legacy pk)", display(account.pk)],
        ["private", display(account.isPrivate)],
        ["verified", display(account.isVerified)],
        ["followers", display(account.followerCount)],
        ["following", display(account.followingCount)],
        ["posts (declared)", display(account.postCount)],
        ["observed at", dossier.observedAt],
        ["source", `${dossier.source.sourceId} (${dossier.source.origin})`],
      ],
    ),
  );

  sections.push(
    "",
    `Active stories (${dossier.stories.length})`,
    dossier.stories.length === 0
      ? "(the account carried no active story at this moment — a positive observation, not an error)"
      : table(
          ["story id", "published", "age", "type", "mentions", "link"],
          dossier.stories.map((story) => [
            story.storyId,
            display(story.publishedAt),
            display(story.age),
            display(story.mediaType),
            mentionLabel(story.mentions),
            firstLine(story.linkUrl),
          ]),
        ),
  );

  sections.push(
    "",
    `Highlights (${dossier.counts.highlights} listed, ${dossier.counts.highlightContentsRead} read)`,
    dossier.highlights.length === 0
      ? "(none listed by the aggregator)"
      : table(
          ["title", "id", "contents", "items", "reason"],
          dossier.highlights.map((highlight) => [
            display(highlight.title),
            highlight.id,
            highlight.status,
            highlight.status === "READ" ? String(highlight.itemCount) : "—",
            display(highlight.reason),
          ]),
        ),
  );
  for (const highlight of dossier.highlights) {
    if (highlight.status !== "READ" || highlight.items.length === 0) continue;
    sections.push(
      "",
      `Highlight ${highlight.title ?? highlight.id} (${highlight.itemCount} item(s))`,
      table(
        ["item id", "published", "age", "type", "mentions", "link"],
        highlight.items.map((item) => [
          item.storyId,
          display(item.publishedAt),
          display(item.age),
          display(item.mediaType),
          mentionLabel(item.mentions),
          firstLine(item.linkUrl),
        ]),
      ),
    );
  }

  sections.push(
    "",
    `Mention index (${dossier.mentions.length} account(s) named in story metadata)`,
    dossier.mentions.length === 0
      ? "(no observed story or highlight named another account)"
      : table(
          ["username", "name", "private", "verified", "items", "seen in"],
          dossier.mentions.map((mention) => [
            `@${mention.username}`,
            display(mention.fullName),
            display(mention.isPrivate),
            display(mention.isVerified),
            String(mention.itemCount),
            mention.seenIn.join(", "),
          ]),
        ),
  );

  sections.push(
    "",
    "Coverage",
    table(
      ["subject", "status", "value", "reason"],
      dossier.coverage.map((row) => [
        row.subject,
        row.status,
        display(row.value),
        display(row.reason),
      ]),
    ),
  );

  sections.push("", `Gaps (${dossier.gaps.length})`);
  if (dossier.gaps.length === 0) {
    sections.push("(none declared)");
  } else {
    for (const gap of dossier.gaps) {
      sections.push(`  · ${gap.subject}: ${gap.reason}`);
      if (gap.howToImprove !== null) sections.push(`    improve: ${gap.howToImprove}`);
    }
  }

  sections.push("", "Notes");
  for (const note of dossier.notes) sections.push(`  · ${note}`);

  return sections.join("\n");
}

export async function runAnonstories(args: ParsedArgs): Promise<number> {
  const username = args.positionals[0];
  if (username === undefined) {
    throw new UsageError(
      "Usage: igtrack anonstories <username> [--json] [--out <file>]",
    );
  }
  const json = isJson(args.flags);
  const out = resolveOptionalUserPath(flagString(args.flags, "out"));
  const chromePath = flagString(args.flags, "chrome");
  const maxHighlights = flagNumber(args.flags, "max-highlights", 5);

  let provider: AnonStoriesProvider;
  try {
    provider = new AnonStoriesProvider({
      ...(chromePath !== undefined ? { chromePath } : {}),
      maxHighlights,
    });
  } catch (err) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `The anonstories provider is not usable: ${
        err instanceof Error ? err.message : String(err)
      } Nothing was requested.`,
      3,
    );
  }

  const result = await provider.getDossier(username, { maxHighlights });
  if (result.dossier === undefined) {
    throw new CliError(
      result.error?.kind ?? "ANONSTORIES_FAILED",
      result.error?.message ?? result.note ?? "The aggregator dossier could not be built.",
      1,
    );
  }
  const dossier = result.dossier;
  const meta = providerMeta(
    out !== undefined
      ? `Dossier written to ${out}. Live third-party aggregator read; PUBLIC_AGGREGATOR, not a platform observation.`
      : undefined,
  );

  if (out !== undefined) {
    try {
      writeFileSync(out, `${JSON.stringify(envelope(dossier, providerMeta()), null, 2)}\n`, "utf8");
    } catch (err) {
      throw new CliError(
        "WRITE_FAILED",
        `Could not write ${out}: ${err instanceof Error ? err.message : String(err)}`,
        1,
      );
    }
  }

  const human = renderHuman(dossier);
  emit({ json, meta, data: dossier, human: out !== undefined ? `${human}\n\nWritten to ${out}` : human });
  return 0;
}

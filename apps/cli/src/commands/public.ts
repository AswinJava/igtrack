import { writeFileSync } from "node:fs";
import { PublicWebProvider, type PublicWebDossier } from "@igtrack/ingestion";
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
// `igtrack public <username>` — the logged-out public-page dossier.
//
// This command deliberately does not touch the database. It is a direct reading
// of what Instagram serves to a logged-out visitor, rendered in a local
// headless browser, and its whole value is the complete payload plus the
// explicit gaps. Storing it is `igtrack investigate`/`work` with
// IGTRACK_PROVIDER=public; this command is the inspection surface.
// ---------------------------------------------------------------------------

export const PUBLIC_HELP = `igtrack public <username> [--json] [--out <file>]

Read every field Instagram exposes on an account's logged-out public pages and
print the complete dossier: profile, bio links, highlights, every media item the
profile timeline and reels tab expose, each item's public metadata, and an
explicit list of what the logged-out surface does not carry.

Options
  --json             Print the standard { ok, data, _meta } envelope
  --out <file>       Also write the envelope (pretty JSON) to <file>
  --chrome <path>    Browser executable (default: IGTRACK_CHROME_PATH, then
                     a detected Chrome/Chromium/Edge)
  --max-posts <n>    Safety bound on media items read (default 60)

Limits (reported as UNAVAILABLE, never zero-filled): follower/following
rosters, comment lists, likers, tagged-media listings, highlight contents,
stories and insights require a logged-in session or owner authorization.`;

function providerMeta(note?: string): OutputMeta {
  return {
    provider: "public",
    sourceId: "public:web:v1",
    synthetic: false,
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
    note:
      note ??
      "Live observation of Instagram's logged-out public pages, rendered in a local headless browser. Not an official Graph API response.",
  };
}

function firstLine(value: string | undefined, max = 160): string {
  if (value === undefined) return "unavailable";
  const line = value.split(/\r?\n/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function renderHuman(dossier: PublicWebDossier): string {
  const profile = dossier.profile;
  const sections: string[] = [];

  sections.push(
    table(
      ["field", "value"],
      [
        ["username", `@${dossier.username}`],
        ["name", display(profile.fullName)],
        ["platform id", display(profile.igId ?? profile.pk)],
        ["private", display(profile.isPrivate)],
        ["verified", display(profile.isVerified)],
        ["followers", display(profile.followerCount)],
        ["following", display(profile.followingCount)],
        ["posts (declared)", display(profile.postCount)],
        ["observed at", dossier.observedAt],
        ["source", `${dossier.source.sourceId} (${dossier.source.retrieval})`],
      ],
    ),
  );

  sections.push("", "Bio", profile.biography ?? "unavailable");
  if (profile.biographyMentions.length > 0) {
    sections.push(`Mentions  ${profile.biographyMentions.map((m) => `@${m}`).join(", ")}`);
  }
  if (profile.bioLinks.length > 0) {
    sections.push(
      "",
      "Bio links",
      table(
        ["title", "type", "url"],
        profile.bioLinks.map((link) => [
          display(link.title),
          display(link.linkType),
          link.url,
        ]),
      ),
    );
  }
  if (profile.highlights.length > 0) {
    sections.push(
      "",
      "Highlights (strip metadata only)",
      table(
        ["title", "id", "owner"],
        profile.highlights.map((h) => [h.title, h.id, display(h.ownerUsername)]),
      ),
    );
  }

  const skipped =
    (dossier.counts.postsSkippedForeign ?? 0) + (dossier.counts.postsSkippedUnverified ?? 0);
  sections.push(
    "",
    `Posts (${dossier.counts.postsDiscovered} discovered, ${dossier.counts.postsEnriched} enriched${
      skipped > 0 ? `, ${skipped} not this account's` : ""
    })`,
    dossier.posts.length === 0
      ? "(none exposed)"
      : table(
          ["shortcode", "published", "type", "likes", "comments", "plays", "detail", "caption"],
          dossier.posts.map((post) => [
            post.shortcode,
            display(post.takenAt),
            display(post.mediaType),
            display(post.likeCount),
            display(post.commentCount),
            display(post.playCount),
            post.detailStatus,
            firstLine(post.caption),
          ]),
        ),
  );
  const permalinks = dossier.posts.filter((post) => post.permalink !== undefined);
  if (permalinks.length > 0) {
    sections.push(
      "",
      "Permalinks (provider-supplied)",
      ...permalinks.map((post) => `  ${post.shortcode}  ${post.permalink}`),
    );
  }

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

export async function runPublic(args: ParsedArgs): Promise<number> {
  const username = args.positionals[0];
  if (username === undefined) {
    throw new UsageError("Usage: igtrack public <username> [--json] [--out <file>]");
  }
  const json = isJson(args.flags);
  const out = resolveOptionalUserPath(flagString(args.flags, "out"));
  const chromePath = flagString(args.flags, "chrome");
  const maxPosts = flagNumber(args.flags, "max-posts", 60);

  let provider: PublicWebProvider;
  try {
    provider = new PublicWebProvider({
      ...(chromePath !== undefined ? { chromePath } : {}),
      maxPosts,
    });
  } catch (err) {
    throw new CliError(
      "PROVIDER_UNAVAILABLE",
      `The public provider is not usable: ${
        err instanceof Error ? err.message : String(err)
      } Nothing was requested.`,
      3,
    );
  }

  const result = await provider.getDossier(username);
  if (result.dossier === undefined) {
    throw new CliError(
      result.error?.kind ?? "PUBLIC_WEB_FAILED",
      result.error?.message ?? result.note ?? "The public dossier could not be built.",
      1,
    );
  }
  const dossier = result.dossier;
  const meta = providerMeta(
    out !== undefined
      ? `Dossier written to ${out}. Live logged-out public-page observation; not an official Graph API response.`
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

import { writeFileSync } from "node:fs";
import { parsePostReference, type PostReference } from "@igtrack/core";
import { PublicWebProvider, type PublicSinglePost } from "@igtrack/ingestion";
import {
  CliError,
  display,
  emit,
  envelope,
  flagString,
  isJson,
  resolveOptionalUserPath,
  table,
  UsageError,
  type OutputMeta,
  type ParsedArgs,
} from "../output.js";

// ---------------------------------------------------------------------------
// `igtrack post <post URL>` — one media item read from its own permalink.
//
// A profile URL OR a post URL both work. `public`
// answers the first; this command answers the second by reading the same
// logged-out media page `public` enriches each item from. It does not touch
// the database: the URL is the evidence reference, and what the page does not
// carry (the comment list, likers, carousel children) is stated as
// UNAVAILABLE rather than inferred from the counts.
// ---------------------------------------------------------------------------

export const POST_HELP = `igtrack post <post URL> [--json] [--out <file>]

Read one Instagram post from its public permalink: caption, owner,
collaborators, tagged accounts, location, music, media URLs, like/comment/play
counts and the observation time. The post URL itself is the evidence
reference; nothing is inferred from the page chrome.

Accepts /p/<shortcode>/, /reel/<shortcode>/ and /tv/<shortcode>/ links, with
or without the profile prefix. A profile URL is refused here — use
\`igtrack public <username>\` for that.

Options
  --json             Print the standard { ok, data, _meta } envelope
  --out <file>       Also write the envelope (pretty JSON) to <file>
  --chrome <path>    Browser executable (default: IGTRACK_CHROME_PATH, then
                     a detected Chrome/Chromium/Edge)

Limits (reported as UNAVAILABLE, never zero-filled): the comment list, likers
and carousel child items are not exposed on a logged-out media page. The
comment COUNT is observed; the rows behind it are not, and none is invented.`;

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
      "Live observation of Instagram's logged-out public media page, rendered in a local headless browser. Not an official Graph API response.",
  };
}

function renderHuman(single: PublicSinglePost): string {
  const post = single.post;
  const sections: string[] = [];
  sections.push(
    table(
      ["field", "value"],
      [
        ["shortcode", post.shortcode],
        ["url form", single.kind],
        ["platform id", display(post.postId)],
        ["permalink", display(post.permalink)],
        ["published", display(post.takenAt)],
        ["type", display(post.mediaType)],
        ["product type", display(post.mediaProductType)],
        ["owner", post.owner === undefined ? "unavailable" : `@${post.owner.username}`],
        ["likes", display(post.likeCount)],
        ["comments", display(post.commentCount)],
        ["plays", display(post.playCount)],
        ["comments disabled", display(post.commentsDisabled)],
        ["observed at", single.observedAt],
        ["source", `${single.source.sourceId} (${single.source.retrieval})`],
      ],
    ),
  );

  sections.push("", "Caption", post.caption ?? "unavailable");
  if (post.coauthors.length > 0) {
    sections.push(`Coauthors  ${post.coauthors.map((c) => `@${c.username}`).join(", ")}`);
  }
  if (post.taggedUsers.length > 0) {
    sections.push(`Tagged     ${post.taggedUsers.map((t) => `@${t.user.username}`).join(", ")}`);
  }
  if (post.location !== undefined) {
    sections.push(`Location   ${display(post.location.name)}`);
  }
  if (post.music !== undefined) {
    sections.push(`Music      ${display(post.music.title)} (${post.music.kind})`);
  }

  const mediaRows = [
    ["display", post.media.displayUrl],
    ["thumbnail", post.media.thumbnailUrl],
    ["video", post.media.videoUrl],
  ].filter((row): row is [string, string] => row[1] !== undefined) as Array<[string, string]>;
  sections.push(
    "",
    "Media URLs (observed, not re-hosted)",
    mediaRows.length === 0 ? "(none exposed)" : table(["kind", "url"], mediaRows),
  );

  sections.push(
    "",
    `Comments: ${single.comments.status}`,
    `  · ${single.comments.reason}`,
  );
  sections.push("", "Notes");
  for (const note of single.notes) sections.push(`  · ${note}`);
  return sections.join("\n");
}

export async function runPost(args: ParsedArgs): Promise<number> {
  const raw = args.positionals[0];
  if (raw === undefined) {
    throw new UsageError("Usage: igtrack post <post URL> [--json] [--out <file>]");
  }
  const parsed = parsePostReference(raw);
  if (!parsed.ok) {
    throw new UsageError(parsed.message);
  }
  const reference: PostReference = parsed.reference;
  const json = isJson(args.flags);
  const out = resolveOptionalUserPath(flagString(args.flags, "out"));
  const chromePath = flagString(args.flags, "chrome");

  let provider: PublicWebProvider;
  try {
    provider = new PublicWebProvider({
      ...(chromePath !== undefined ? { chromePath } : {}),
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

  const result = await provider.getPublicPost(reference);
  if (result.data === undefined) {
    throw new CliError(
      result.error?.kind ?? "PUBLIC_WEB_FAILED",
      result.error?.message ?? result.note ?? "The post could not be read.",
      result.status === "UNAVAILABLE" ? 3 : 1,
    );
  }
  const single = result.data;
  const meta = providerMeta(
    out !== undefined
      ? `Post written to ${out}. Live logged-out public-page observation; not an official Graph API response.`
      : undefined,
  );

  if (out !== undefined) {
    try {
      writeFileSync(out, `${JSON.stringify(envelope(single, providerMeta()), null, 2)}\n`, "utf8");
    } catch (err) {
      throw new CliError(
        "WRITE_FAILED",
        `Could not write ${out}: ${err instanceof Error ? err.message : String(err)}`,
        1,
      );
    }
  }

  const human = renderHuman(single);
  emit({ json, meta, data: single, human: out !== undefined ? `${human}\n\nWritten to ${out}` : human });
  return 0;
}

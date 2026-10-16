import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  available,
  CapabilityErrorKind,
  Confidence,
  errored,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedDiscoveredAccount,
  type NormalizedFollowPage,
  type NormalizedInsightSet,
  type NormalizedMentionedComment,
  type NormalizedPost,
  type NormalizedPostChild,
  type NormalizedProfile,
  type NormalizedStory,
  type NormalizedTagPage,
  type ProviderCapabilities,
  type SourceRef,
} from "@igtrack/core";

// import:v1 — the operator's own Instagram data export ("Download your
// information", JSON form). This is the only lawful path to a REAL follower /
// following roster: Instagram ships it to the account owner directly, so no
// session, cookie, private endpoint, or scraping is involved (invariant 3).
//
// Scope is deliberately narrow: the roster files under
// `connections/followers_and_following/` are read and normalized; every other
// capability answers UNAVAILABLE with the reason — not zero, not a guess.

// Export entry shapes, pinned from the export format: a top-level array of
// entries whose username lives in string_list_data[0].value (href carries the
// profile URL; title usually mirrors value). Optional fields stay optional —
// nothing is invented when absent.
const exportEntryV1 = z.object({
  title: z.string().optional(),
  string_list_data: z
    .array(
      z.object({
        href: z.string().optional(),
        value: z.string().optional(),
        timestamp: z.number().optional(),
      }),
    )
    .optional(),
  media_list_data: z.array(z.unknown()).optional(),
});
const rosterFileV1 = z.array(exportEntryV1);

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Accepts the export root, `connections/`, or the `followers_and_following/`
// directory itself — whichever the operator points IGTRACK_IMPORT_DIR at.
// A nonexistent path is a configuration error and fails fast (invariant 7).
function resolveRosterDir(importDir: string): string {
  const nested = join(importDir, "connections", "followers_and_following");
  if (existsSync(nested)) return nested;
  if (existsSync(importDir)) return importDir;
  throw new Error(
    `igtrack import: export directory not found: ${importDir} ` +
      `(tried "${nested}" and the directory itself). ` +
      "Set IGTRACK_IMPORT_DIR to your Instagram data-export directory.",
  );
}

// followers_1.json, followers_2.json … in natural numeric order; a bare
// followers.json (single-file export) sorts as the first page.
function rosterFiles(dir: string, direction: "followers" | "following"): string[] {
  if (direction === "following") {
    return readdirSync(dir).filter((f) => f === "following.json").sort();
  }
  const numbered: Array<{ file: string; n: number }> = [];
  let bare: string | undefined;
  for (const f of readdirSync(dir)) {
    if (f === "followers.json") bare = f;
    else {
      const m = /^followers_(\d+)\.json$/.exec(f);
      if (m !== null) numbered.push({ file: f, n: Number(m[1]) });
    }
  }
  numbered.sort((a, b) => a.n - b.n);
  const files = numbered.map((x) => x.file);
  if (files.length === 0 && bare !== undefined) return [bare];
  return files;
}

export interface ImportProviderOptions {
  /** Export path: root, `connections/`, or `followers_and_following/`. */
  importDir: string;
  /** The account the export belongs to — the ONLY account this provider observes. */
  username: string;
  clock?: () => Date;
}

export class ImportProvider implements InstagramProvider {
  readonly sourceId = "import:v1";

  private readonly rosterDir: string;
  private readonly username: string;
  private readonly clock: () => Date;

  constructor(options: ImportProviderOptions) {
    this.username = options.username.trim();
    if (this.username === "") {
      throw new Error("igtrack import: IGTRACK_IMPORT_USERNAME must not be empty");
    }
    this.rosterDir = resolveRosterDir(options.importDir);
    this.clock = options.clock ?? (() => new Date());
  }

  capabilities(): ProviderCapabilities {
    // The export supplies rosters and nothing else — declared exactly, so
    // doctor and the capability matrix never over-claim.
    return {
      resolveAccount: true,
      getProfile: false,
      getStories: false,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: false,
      getPublicComments: false,
      getPostChildren: false,
      // The export carries no tagged-media section (tagged media belong to
      // other accounts) and no mentioned-comment data; declared false rather
      // than silently absent.
      getTags: false,
      getMentionedComment: false,
      // The export has no insight metrics at all (D38) — declared false so
      // doctor and the capability matrix never over-claim.
      getAccountInsights: false,
      // The export describes only the account it was downloaded from; it
      // carries no other-account data (D42).
      discoverAccount: false,
    };
  }

  async resolveAccount(username: string): Promise<CapabilityResult<NormalizedAccountRef>> {
    const meta = this.meta();
    // One export, one owner. Any other username is honestly not-observable
    // through this provider — never probed, never scraped.
    if (username.trim().toLowerCase() !== this.username.toLowerCase()) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `The import provider observes only the export's owner @${this.username}; @${username} is not observable through it`,
        retryable: false,
      });
    }
    return available({ username: this.username }, { ...meta, confidence: Confidence.HIGH });
  }

  async getProfile(): Promise<CapabilityResult<NormalizedProfile>> {
    return unavailable(
      this.meta(),
      "The Instagram data export carries no profile snapshot: follower/following files hold usernames only — no bio, counts, avatar, or verification state.",
    );
  }

  async getStories(): Promise<CapabilityResult<NormalizedStory[]>> {
    return unavailable(
      this.meta(),
      "Instagram's data export never includes story content — stories are ephemeral and absent from every export section.",
    );
  }

  async getFollowers(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return this.getRoster("followers", account, cursor);
  }

  async getFollowing(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return this.getRoster("following", account, cursor);
  }

  async getPublicPosts(): Promise<CapabilityResult<NormalizedPost[]>> {
    return unavailable(
      this.meta(),
      "import:v1 reads only the export's follower/following roster files; the export's post sections are not read by this provider version.",
    );
  }

  async getPublicComments(): Promise<CapabilityResult<NormalizedComment[]>> {
    return unavailable(
      this.meta(),
      "import:v1 reads only the export's follower/following roster files; comments are not read by this provider version.",
    );
  }

  async getPostChildren(): Promise<CapabilityResult<NormalizedPostChild[]>> {
    return unavailable(
      this.meta(),
      "import:v1 reads only the export's follower/following roster files; album children are not read by this provider version.",
    );
  }

  async getTags(): Promise<CapabilityResult<NormalizedTagPage>> {
    return unavailable(
      this.meta(),
      "The Instagram data export carries no tagged-media section: media in which the account was tagged belong to other accounts and are absent from the export. Reachable through the graph provider's documented IG User tags edge (owned account).",
    );
  }

  async getMentionedComment(): Promise<CapabilityResult<NormalizedMentionedComment>> {
    return unavailable(
      this.meta(),
      "The Instagram data export carries no mentioned-comment data: comments on other accounts' media are not included. The graph provider's mentioned_comment read is webhook-keyed and reads one caller-supplied id on demand.",
    );
  }

  async getAccountInsights(): Promise<CapabilityResult<NormalizedInsightSet>> {
    return unavailable(
      this.meta(),
      "The Instagram data export carries no account insight metrics — reach, views, and demographics exist only behind the IG User insights edge. Use the graph provider (owned Business/Creator account) for insights.",
    );
  }

  async discoverAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedDiscoveredAccount>> {
    const target = username.trim().replace(/^@/, "");
    return unavailable(
      this.meta(),
      `The Instagram data export describes only the account it was downloaded from; it carries no public data for another account${target === "" ? "" : ` such as @${target}`}. Another account's public profile is reachable solely through the graph provider's documented Business Discovery edge (D42).`,
    );
  }

  // One page = one raw export file: genuine per-file payload hash, cursor = the
  // next file in export order, complete only on the last file. The export is a
  // point-in-time dump, so freshness equals the export date — said, not hidden.
  private async getRoster(
    direction: "followers" | "following",
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    const meta = this.meta(account);
    try {
      const files = rosterFiles(this.rosterDir, direction);
      if (files.length === 0) {
        return unavailable(
          meta,
          `No ${direction} file in ${this.rosterDir} (expected ` +
            `${direction === "followers" ? "followers_1.json" : "following.json"} under ` +
            "connections/followers_and_following). Re-download the Instagram export " +
            `with the ${direction} section selected.`,
        );
      }

      let index = 0;
      if (cursor !== undefined) {
        // The cursor IS the next file to read (emitted as files[index + 1]);
        // an unknown name is a hard error, never a guessed page.
        const at = files.indexOf(cursor.value);
        if (at < 0) {
          return errored(meta, {
            kind: CapabilityErrorKind.INTERNAL,
            message: `Unknown ${direction} cursor: ${cursor.value}`,
            retryable: false,
          });
        }
        index = at;
      }

      const file = files[index]!;
      const rawText = await readFile(join(this.rosterDir, file), "utf8");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        return errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: `Export file ${file} is not valid JSON`,
          retryable: false,
        });
      }
      const parsed = rosterFileV1.safeParse(parsedJson);
      if (!parsed.success) {
        return errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: `Export file ${file} failed validation: ${parsed.error.message.slice(0, 200)}`,
          retryable: false,
        });
      }

      // Username from string_list_data[0].value, falling back to title —
      // an entry with neither is malformed input and fails loudly rather
      // than silently shrinking the roster.
      const seen = new Set<string>();
      const entries: NormalizedFollowPage["entries"] = [];
      parsed.data.forEach((raw, i) => {
        const name = (raw.string_list_data?.[0]?.value ?? raw.title ?? "").trim();
        if (name === "") {
          throw new Error(`entry ${i} in ${file} carries no username (string_list_data[0].value or title)`);
        }
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ username: name });
      });

      const observedAt = this.clock().toISOString();
      const next = files[index + 1];
      const isLast = next === undefined;
      return available(
        {
          entries,
          complete: isLast,
          ...(next !== undefined ? { nextCursor: next } : {}),
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: isLast ? Confidence.HIGH : Confidence.MEDIUM,
            observedAt,
          },
        },
        {
          ...meta,
          observedAt,
          confidence: isLast ? Confidence.HIGH : Confidence.MEDIUM,
          rawPayloadHash: sha256(rawText),
          rawReference: `${this.sourceId}/${file}`,
          ...(isLast
            ? {
                note:
                  "Complete roster read from the operator's own Instagram export; " +
                  "freshness equals the export date, not the live platform.",
              }
            : { note: `More export files remain (${files.length - index - 1}); continue with the returned cursor.` }),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "export read failed";
      const missing =
        message.includes("ENOENT") || message.includes("no such file");
      return errored(meta, {
        kind: missing ? CapabilityErrorKind.SOURCE_NOT_FOUND : CapabilityErrorKind.SCHEMA_MISMATCH,
        message: `Instagram export read failure: ${message.slice(0, 250)}`,
        retryable: false,
      });
    }
  }

  private meta(account?: NormalizedAccountRef): {
    observedAt: string;
    source: SourceRef;
  } {
    return {
      observedAt: this.clock().toISOString(),
      source: {
        sourceId: this.sourceId,
        kind: SourceKind.IMPORT,
        ...(account !== undefined ? { reference: account.username } : {}),
      },
    };
  }
}

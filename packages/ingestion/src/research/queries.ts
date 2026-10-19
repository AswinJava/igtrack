// ---------------------------------------------------------------------------
// Deterministic search-query strategy for one Instagram handle (Phase 2, D74).
//
// Why this exists: a search engine returns CANDIDATES, and query form decides
// which neighbourhood of the index we land in. Live probes against the keyless
// FreeSerp index (2026-10-19, docs/verification/SOURCE-AUDIT.md) showed that
// two near-duplicate queries like `"H" instagram` and `"H" contact about`
// return the same token-overlap junk while spending a second request — the
// handle is one token, so the surrounding words carry all the signal.
//
// Each variant below asks a DIFFERENT question about the same handle:
//   1. `"H" instagram`          — the canonical form: handle plus platform.
//   2. `instagram.com/H`        — pages quoting the profile URL itself
//                                 (link-in-bio pages, directories, articles).
//   3. `"@H"`                   — the mention form bios and articles use.
//   4. `"H"`                    — the bare exact handle, any context.
//
// The list is finite, ordered and capped: query variety stops at the point
// where a new query would re-ask an old one with different punctuation. This
// module never interprets RESULTS — exact-handle relevance is decided later,
// on the retrieved page itself (the audit's relevance gate), never on a
// snippet this generator produced.
// ---------------------------------------------------------------------------

/** Default query budget for one audit web probe: diverse, never endless. */
export const HANDLE_QUERY_LIMIT = 4;

/**
 * Build the search queries for one handle: deterministic, deduplicated,
 * capped at `limit`. A handle that already carries `@` is not double-prefixed,
 * and an empty handle yields no queries (there is nothing to ask about).
 */
export function handleSearchQueries(rawHandle: string, limit = HANDLE_QUERY_LIMIT): string[] {
  const handle = rawHandle.trim().replace(/^@+/, "");
  if (handle === "" || limit <= 0) return [];
  const variants = [
    `"${handle}" instagram`,
    `instagram.com/${handle}`,
    `"@${handle}"`,
    `"${handle}"`,
  ];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const query of variants) {
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= limit) break;
  }
  return queries;
}

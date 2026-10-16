# Changelog

No release tags yet; `0.1.0` is the current, unreleased line. Entries map to
dated decision records in [docs/FOUNDING.md](docs/FOUNDING.md) — read those for
the *why* behind every honesty rule below.

## 0.1.0 — unreleased

### Phase H — the two remainings, and where they stop

- **Added: tagged media.** An append-only `tagged_media` table (first-
  observation-wins; a re-scan never rewrites a stored row and no removal is
  ever claimed) fed by a new owned-only `TAGS_SCAN` (24 h cadence). One scan-keyed evidence row
  per listing carries the completeness; a capped listing completes `PARTIAL`. New
  surfaces: `igtrack tags <username>`, the `igtrack_tags` MCP tool, dossier
  coverage counts, and a `TAG_OBSERVED` activity entry. Never rendered as the
  account's own posts, never diffed against the posts table (D60–D62).
- **Added: mentioned comment read.** `igtrack mention <commentId>` (MCP:
  `igtrack_mention_read`) reads one `mentioned_comment` on demand — the id's only
  lawful source is a Meta webhook notification, so there is deliberately no
  listing and nothing is persisted: a probe is not a claim of record (D63–D64).
- **Added: repost count metadata.** `posts.repostsCount` is parsed when the
  provider returns it and stored null otherwise (absence with a reason, never
  zero). The capability registry now separates `REPOSTS` (the observable scalar,
  available via `getPublicPosts`) from the new `RESHARES` entry (who reposted —
  structurally absent, refused; FOUNDING §14). Requesting the field live is
  gated on a one-node probe so an unknown field cannot fail a whole call (D65).
- **Docs:** FOUNDING §17 records D60–D66, including the not-added list and the
  live-verification plan (`pnpm verify:graph`). `docs/CAPABILITIES.md`
  regenerated: 18 of 23 capabilities obtainable.
- **Known limits, stated:** live verification of the tags edge, the mentioned
  comment read, and `reposts_count` is outstanding (no credentials in this
  environment); request shapes are docs-pinned and fixture-verified, live state
  `NOT_VERIFIED`. See FOUNDING §17.

### Phases A–G — the road to Phase H

- **Phase A** — closed the honesty gaps found by the source audit (absence vs.
  zero across SQL, JSON and CLI tables).
- **Phase B** — `import:v1`, the lawful real-roster path (operator's own export).
- **Phase C** — pinned the agent-facing refusals and fixed the two honesty gaps
  they exposed (D33–D35).
- **Phase D** — own-account insights with absence rows (follower-count series,
  reach/views/engagement, country demographics; D36–D41).
- **Fourth founding** — the complete-account dossier requirement, clause by
  clause, with each clause's lawful route or its refusal (D42–D46).
- **Phase E** — the dossier's lawful core: Business Discovery probe (`lookup`,
  stateless) plus the opt-in recorded path (`targets add --observed`) and the
  comment signal (D42–D46).
- **Phases F+G** — the dossier executed end to end where lawful, and owned-media
  change detection: caption edits, disappearances, PARTIAL never diffed
  (D47–D59).

### Earlier

- Posts pipeline, lookup, capability diagnostics, worker hardening, release
  tests; bench-staging, workflow and e2e fixes (pre-phase commits).

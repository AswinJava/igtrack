# Changelog

No release tags yet; `0.1.0` is the current, unreleased line. Entries map to
dated decision records in [docs/FOUNDING.md](docs/FOUNDING.md) — read those for
the *why* behind every honesty rule below.

## 0.1.0 — unreleased

### Cursor loops and identity collisions (2026-10-19)

- **A repeated follower/following cursor now ends the scan as PARTIAL.** The
  shared follow engine compares each returned cursor with the ones it has
  already consumed; a provider that hands the same cursor back would otherwise
  re-fetch one page until the lease expired. The acquired pages are kept and
  the snapshot is recorded PARTIAL, never COMPLETE, so no loss is derived from
  a listing that was not finished.
- **A username already bound to another platform id is no longer overwritten.**
  `upsertAccount` still matches a rename by the platform id first (D52), but a
  row whose `ig_id` differs from the incoming observation is left untouched
  and the write fails with an identity-conflict error. Silently merging two
  ids onto one row would misattribute both accounts' history.
- **The import freshness note stopped claiming a date the bytes do not
  contain.** `import:v1` roster files carry no export-generation timestamp, so
  the note now says the observation time is when IGTrack read the files, not
  when Instagram produced the export.

### Adversarial audit closure (2026-10-20)

- **A follow scan is now bounded even when the cursor never repeats.** The loop
  guard catches a cursor it has already consumed, but a provider minting a
  fresh value on every page never repeats — it would fetch indefinitely, and
  the per-page lease heartbeat keeps the job alive while it does, so nothing
  ever reclaims it. Follow scans now stop at `IGTRACK_FOLLOW_MAX_PAGES`
  (default 500 — the same guard the tagged-media scan already carried), keep
  every page already read, and record PARTIAL with `pageCap` in the evidence.
  The unread remainder is never claimed to be absent.
- **The id-first rename path can no longer raise a raw unique-index error.**
  Matching a rename by platform id (D52) still comes first, but the rename now
  proceeds only while the target handle is free or already belongs to that id:
  a handle held by another row — or an id already bound to another account —
  refuses with the descriptive identity-conflict error instead of a Postgres
  `23505` escaping as an opaque `Failed query: insert into "ig_accounts"…`.
  The same translation now covers what the guards cannot see: two concurrent
  observations racing past each other's uncommitted write and colliding on the
  platform-id or handle index. Neither identity moves on refusal, a conflict
  mid-transaction still rolls the transaction back, and two concurrent writes
  claiming one handle keep exactly one row.
- **The roster freshness note reaches stored evidence instead of the floor.**
  `import:v1` produced the note and the docs asserted it, but the follow-scan
  executor read notes only on the UNAVAILABLE path, so the caveat was dropped
  before anything was written. The final page's note now rides onto the
  snapshot's evidence row as `providerNote`, so a later reader of the stored
  timestamp still gets "read time, not export time".

### Evidence quality, measured (2026-10-19)

- **A web fact must now involve the handle it is filed under (D75).** On
  search-found pages, a stored statement's value names the handle as a
  delimited token or the page's own host does; a third-party article about
  `@natgeo` that also describes its *source* (og:site_name `WeRSM`, the
  publisher's own socials and contacts) has those values counted per document
  (`unattributed`) and in a report note, never attributed. Operator `--url`
  pages bypass this exactly as they bypass the mention gate — the operator
  asserted relevance. A live benchmark run before this change showed 6 of 24
  natgeo facts naming the wrong entity and 22 confident facts for the
  three-letter handle `rgb`; after, 0.
- **The exact-handle gate matches tokens, not substrings.** The handle must be
  delimited: letters/digits/underscore on either side disqualify the match
  (`nasaa` inside `nasaa_research`, `rgb` inside `sRGB`, `nasa` inside
  `nasal`); periods stay delimiters so `nasa.gov` keeps matching — the
  documented residual is that a longer dot-joined handle still matches.
- **Related-account links are profile-only on every extraction path.**
  Share/compose endpoints (`x.com/intent/…`, `linkedin.com/shareArticle`,
  `twitter.com/share`) name no profile and are no longer proposed, and the D47
  Instagram-family refusal now also covers `ld+json sameAs[]`, which had
  stored a `facebook.com` link the anchor walk would have refused.
- **Attribution is reported as a level, not a vibe:** `HOST` (identity) /
  `URL` / `TITLE` / `BODY` (topical), and only HOST counts as strong —
  `wersm.com/natgeo-breaks-…` reading STRONG was the symptom behind the
  wrong-entity facts above.
- **Added: the audit-quality benchmark, three layers kept separate.**
  `apps/cli/src/bench.ts` + `scripts/bench-audit.ts` (`pnpm bench:audit`)
  measure the real probe over a seven-case evaluation set with ground truth
  verified independently of the pipeline (SOURCE-AUDIT §11): candidate
  precision, retrieval, exact-handle pages, support-checked claims (every fact
  re-verified against the retrieved body, canonicalized both ways), attribution
  levels, duplicates, failures and latency — raw fact count is reported but
  never the verdict. Layers: mocked (vitest, never network), saved
  (`--saved` replays committed recordings `apps/cli/test/fixtures/bench/`
  offline, reproducing live numbers exactly), live (default, never part of
  `pnpm test`). Brave rows appear only when a key exists — NOT MEASURED, never
  a fabricated comparison.
- **A falsified expectation changed the ground truth, not the gate.** The
  `nasaa` case was written expecting nothing to state the string; live runs
  found real organizations using it (nasaa-arts.org HTTP 200, brand 596×;
  nasaa.org exists behind 403 to any user-agent). The case is now REVIEW with
  that evidence, and still tests what remains true: no `nasa.*` page may
  contribute to `nasaa`, and identity-unverified string matches are never
  verdicts.

### The central use case, audited and named (2026-10-19)

- **Added: `docs/verification/REQUIREMENT-AUDIT.md`.** The founder's central
  question — *an operator types an unknown username, what can this product
  lawfully show them?* — mapped clause by clause (FOUNDING §14.1 A1–A10, §15,
  §18, §19) to the implementing code path, the lawful source, the credential
  it needs, whether the target must be owned, the legal constraint, the
  verification evidence and the missing work. Refusals are listed as refusals,
  not as TODOs, and every `NOT_VERIFIED` row carries its exact prerequisite.
- **The audit now names stale evidence instead of letting it read as current.**
  `igtrack audit` reports how many stored claims are past the 180-day review
  horizon (`record.claims.dueForReview`, flagged `DUE_FOR_REVIEW`), adds a
  `Stale evidence:` limitation, marks the summary's third-party-claim row, and
  prefixes any plan step whose stored observation is older than its cadence
  with `STALE —`. Staleness is a flag only: a stale claim is never expired,
  retracted, downgraded or dropped (FOUNDING §18).
- **The audit's human screen renders each web fact's uncertainty.** A
  `caveat:` suffix travels with the fact's field, so a per-fact qualifier is
  no longer visible only in `--json`.
- **The public-web phase runs a REAL search on a fresh install — no account,
  no key (D73).** `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto` (now shipped in
  `.env`/`.env.example`) is Brave when `IGTRACK_RESEARCH_SEARCH_API_KEY` is
  present and otherwise the keyless, unmetered, documented FreeSerp JSON API
  over its own crawl index; the code default (unset) stays `none` so tests and
  no-egress deployments remain deterministic, an unknown name is a
  CONFIGURATION_ERROR (exit 3), and `brave` without a key names the variable
  instead of failing open. Every excluded keyless alternative (DuckDuckGo,
  Mojeek, SearXNG, GDELT, Qwant, Google CSE, Bing) is dated evidence in
  `docs/verification/SOURCE-AUDIT.md` §9. The search step now reports its own
  state — `SEARCH_NOT_CONFIGURED` / `SEARCH_SUCCEEDED` / `SEARCH_NO_RESULTS` /
  `SEARCH_FAILED` — separately from retrieval
  (`NOT_ATTEMPTED`/`COMPLETED`/`COMPLETED_PARTIAL`/`FAILED`), so "the provider
  answered zero results" can never read as "the phase did not run". And a
  search hit stays a candidate: a SEARCH-result page contributes a fact only
  if the retrieved page itself names the exact handle, otherwise its
  structured values are counted and discarded with the reason; operator `--url`
  pages bypass that gate because the operator asserted relevance, and
  Instagram-family candidates are ordered last so a doomed host never consumes
  a readable page's document slot.
- **Discovery quality rebuilt as a deterministic query strategy (D74).** A live
  diagnosis found the keyless index ignores quoted phrases and tokenizes
  `sel_win_` into `sel`+`win`, so Phase 1's two derived queries asked for
  token-overlap junk — retrieval and the gate were fine, coverage was not. The
  search now asks a fixed budget of **4 distinct query forms** (quoted,
  profile-URL, `@`-mention, bare — `handleSearchQueries`, ordered, deduped,
  `HANDLE_QUERY_LIMIT`), deduplicates candidates to **canonical URLs**
  (tracking params, fragment, host case and trailing slash normalized; content
  params kept), and ranks them with an explainable stable signal sort (exact
  handle in URL > title > snippet; policy-refused candidates last). Every
  candidate reports its **disposition and reason** (`PLANNED` /
  `SKIPPED_BY_POLICY` / `NOT_FETCHED`), each query reports its own result count
  or error, and a policy refusal is counted as **`skipped`, never `failed`** —
  no request was ever made — with `skipped > 0` yielding `COMPLETED_PARTIAL`.
- **One label says where the web phase stopped — and six zeros get six names.**
  The report carries a deterministic `outcomeClass`: `SEARCH_UNAVAILABLE` /
  `SEARCH_FAILED` / `SEARCH_NO_CANDIDATES` / `CANDIDATES_INACCESSIBLE` /
  `PAGES_IRRELEVANT` / `RELEVANT_NO_FACTS` / `EVIDENCE_EXTRACTED`. The
  zero-fact next step branches on it: weak coverage of one index says **"not
  proof that no public evidence exists"** (and names the keyed Brave option),
  inaccessible candidates say retry or `--url`, and earlier stops report the
  registry's own remedy. The report also lists the source classes it never
  searches. Live-verified both directions: `sel_win_` → 0 facts /
  `PAGES_IRRELEVANT` with the weak-coverage wording; control handle `nasa` →
  4/4 pages naming the handle, 41 facts / `EVIDENCE_EXTRACTED`
  (`scripts/bench-search.ts`; benchmark table in `docs/verification/SOURCE-AUDIT.md`
  §10, Brave honestly `NOT MEASURED` until a key is set).

### The arbitrary-username investigation workflow

- **Added: `igtrack audit <username> --url URL[,URL…] [--max-sources N]` — a
  public-web phase for an account you have never seen.** `opAuditWebProbe`
  plans operator-named pages first, then candidates from a configured search
  provider (≤5 documents, depth 1, hard ceiling 10), and reads them through
  the same SSRF gate, DNS check, robots check, content-type allowlist, byte
  cap and timeout as a research run — Instagram-family hosts refused by policy
  (D70). It takes **no database handle**: an audit still queues no scan,
  writes no row and registers no target, and that is now structural.
- **Evidence classes never blur.** Every fact is labelled
  `PUBLIC_WEB_DOCUMENTED` and carries its source URL, page title, exact field,
  extraction method, retrieval time and the document's SHA-256; corroboration
  and contradiction are derived with the ledger's own rules — two domains
  agreeing is `CORROBORATED`, disagreement is `CONFLICTED` with **both** values
  shown and no winner chosen; and the report's `summary` keeps platform
  observation, stored record, public-web statement, stored third-party claim,
  operator evidence and **inference (`NONE`, always)** in separate rows.
- **Audit honesty fixes.** A synthetic `ACCOUNT_NOT_FOUND` is stated as a
  property of the fixture set, never of Instagram; an unknown
  `IGTRACK_RESEARCH_SEARCH_PROVIDER` is a `CONFIGURATION_ERROR` (exit 3)
  rather than an empty section; a failed document reports `FAILED` rather than
  "nothing found"; `NOT_ATTEMPTED` carries the exact env-var remedy; and
  `igtrack_audit` (MCP) gains optional `urls`/`maxSources` while keeping
  `readOnlyHint: true`.
- **Source audit:** `docs/verification/SOURCE-AUDIT.md` records the lawful
  landscape with dated citations — Business Discovery as the only lawful
  arbitrary-username platform route, oEmbed refused on its terms, Basic
  Display retired, and every popular OSINT library classified reference-only
  because it authenticates with session cookies or undocumented endpoints
  (D71).
- **Honesty fixes found by the first LIVE probe, not by any fixture (D72).**
  A `meta description` phrase-miner that produced the value `that&` is
  deleted outright — phrase-mining prose is prose interpretation, and the
  field already arrives from JSON-LD where the page states it as a field;
  HTML entities are now decoded at both extraction gates, so a legal name is
  stored as `Smith & Wesson` and never as `Smith &amp; Wesson`; and a
  contradiction now requires **two independent sources** — one page listing
  three social profiles reads `SINGLE_SOURCE` with all values shown, never
  `CONFLICTED`.

### Research acquisition — the bounded public-web engine

- **Added: `igtrack research <target> --run --question "..."` /
  `igtrack_research_run`.** The product's first autonomous acquisition layer:
  it plans, fetches, extracts, validates and stores source-backed evidence
  itself. Sources are planned in order — operator `--url` pages, then
  search-provider candidates (no provider configured means `UNAVAILABLE` with
  the exact reason, never invented sources), then prior claims' source URLs —
  deduplicated and capped at **10 documents at depth 1**; the engine never
  follows links it did not plan (D69).
- **Bounds enforced in code, pinned by tests.** Compile-time constants in
  `packages/core/src/research.ts`, not env vars: 10 sources, depth 1, 10s
  per-document timeout, 512KB streamed byte cap, 3 redirects (each hop
  re-validated), 24h document-freshness reuse window. A deployment choice
  cannot widen the product's safety envelope
  (`packages/core/test/research.test.ts`).
- **Retrieval safety.** A static gate refuses non-`http(s)` schemes, non-80/443
  ports, embedded credentials, and Instagram/localhost/metadata hosts by
  policy (platform data stays with the Graph API adapters); DNS answers are
  checked against private/loopback/link-local/metadata ranges before connect;
  robots.txt is respected; content types are allowlisted; the body is streamed
  to the byte cap under the wall-clock timeout. Every hop re-runs the gate
  (`packages/ingestion/test/research-fetch.test.ts`).
- **Injection is structurally inert.** Extraction reads four fixed field
  families (JSON-LD, meta tags, mailto addresses, public profile links) —
  never page prose — so a page cannot prompt-inject its way into a claim;
  retrieved text is data, never instructions. Each candidate then passes the
  same closed predicate registry as operator claims before storage; duplicates
  are counted, never re-stored (D69).
- **Honest run records.** A run row stores its question, focus, bounds, and
  totals; every document's outcome — `FETCHED`, `REUSED` (<24h), `FAILED`,
  `BLOCKED_BY_POLICY`, `UNSAFE_URL` — is recorded with its reason, so a
  partial run never fabricates success. Claims stored by a run carry
  `research_run_id` provenance. Runs are refused for `DISCOVERY` targets at
  enqueue and at execute (D47 stands).
- **Capability registry gains `WEB_RESEARCH`** with a new `engineSupplied`
  flag — a third honest supply mode, distinct from platform methods and from
  operator-typed rows; the dossier coverage row reports it `UNAVAILABLE` with
  the D47 reason on a DISCOVERY target and `OBSERVED` from stored run rows on
  an OWNED one. `docs/CAPABILITIES.md` regenerated: **20 of 25 obtainable**.
- **Search providers:** `none` (unset code default — honest `UNAVAILABLE` +
  reason), `auto` (Brave when `IGTRACK_RESEARCH_SEARCH_API_KEY` is present,
  otherwise the keyless FreeSerp index — the shipped `.env`/`.env.example`
  default so a fresh install runs a real search with no account and no key),
  `brave` and `freeserp` (force one); an unknown name is a configuration error,
  never a silent `none` (D73).
- **Test matrix (93 checks across 7 files):** core bounds/policies, extraction
  field families + injection inertness + refusal silence, fetcher gate/robots/
  redirect/caps/timeout/status mapping, search-provider selection, migration
  0021 + run lifecycle + owner scoping + freshness + concurrency, ~19 engine
  scenarios (multi-source, sparse, injection, refusal, failures, dedup,
  determinism, CLI/MCP contracts, cross-user denial), MCP schema bounds.
- **Known limits, stated:** the Brave search adapter and live public-web fetch
  are `NOT_VERIFIED` in this environment (no search key; tests use injected
  deterministic transport, and a live run against arbitrary third-party pages
  is not a test fixture). The extractor is regex-on-HTML, not an LLM — an
  accepted trade-off recorded in D69: no probabilistic component can move a
  claim across the predicate registry.

### Deep intelligence Phase 1 — claims ledger, research report, planner

- **Added: the claims ledger.** A new `claims` table (migration 0020) stores
  operator/agent-submitted findings about an account — a closed predicate
  registry, `source_kind` `OPERATOR` | `WEB` (never `PLATFORM`), source URL,
  short excerpt + SHA-256, and `stated_at`/`retrieved_at`/`recorded_at` as
  distinct facts. IGTrack stores claims; it never generates, fetches or infers
  them. Sensitive person-level predicates are refused at write time with the
  FOUNDING pointer; duplicates are typed `CLAIM_DUPLICATE` refusals naming the
  existing claim; corroboration (`CORROBORATED` = ≥2 distinct source domains)
  and contradiction (`CONFLICTED` = both sides shown, no winner) are derived,
  never stored; retraction keeps the row readable and requires `confirm: true`;
  a 180-day review horizon flags stale claims without ever hiding them (D67).
- **Added: `igtrack research <target>` / `igtrack_research`.** A deterministic
  read over stored rows — zero provider calls — with labelled sections:
  identity/route, platform observations (carrying the D48 bounded-preview
  caveat), themes and cadence (corpus size stated), owned-account audience and
  change summaries, the claims ledger separated from platform facts,
  contradictions, leads (explicitly not claims), evidence-ranked connections
  (OWNED only; DISCOVERY gets `UNAVAILABLE` + reason), and coverage. Every
  empty section states why; `--since` filters claims only and says so;
  `--format md` renders the same data as a hand-off document; two consecutive
  calls are byte-identical modulo `computedAt` (D68).
- **Added: the investigation planner.** `igtrack plan <target> [--goal]` /
  `igtrack_plan` recomputes every step (`DONE`/`PENDING`/`READY`/`STALE`/
  `BLOCKED`/`NOT_APPLICABLE`) from jobs, targets and claims on each call and
  names the single next action — stateless by design, so an interrupted
  investigation resumes by asking again; D47-refused kinds render
  `NOT_APPLICABLE`, an unusable provider renders `BLOCKED`, an unknown goal is
  a `USAGE` error (D68).
- **CLI:** `claims add|list|retract`, `research`, `plan` (router grows from 19
  to 22 cases); **MCP:** 4 new tools plus `igtrack_plan` (19 → 24,
  `EXPECTED_TOOLS` pinned); capability registry gains `ACCOUNT_RESEARCH`
  (available via operator submissions, zero provider methods) and
  `docs/CAPABILITIES.md` regenerates to **19 of 24 obtainable** (D67/D68).
- **Bench:** `scripts/bench-research.ts` (p50/p95 over a 64-claim synthetic
  workload): research p50 42.5 ms / p95 60.0 ms on local Postgres, within the
  pre-established 1500 ms threshold.
- **Docs:** FOUNDING §18 records D67/D68, the not-added list and the Phase-1
  verification table; [docs/DEEP-ACCOUNT-INTELLIGENCE.md](docs/DEEP-ACCOUNT-INTELLIGENCE.md)
  carries its implementation status; README counts reconciled.
- **Known limits, stated:** no live account was observed by any of this — every
  row comes from the synthetic fixture provider or operator-submitted claims;
  live Graph verification remains `NOT_VERIFIED` (no credential in this
  environment).

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

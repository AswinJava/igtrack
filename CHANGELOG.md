# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Activity Report** — `igtrack activity-report` and the `igtrack_activity_report`
  MCP tool compose the four-tab Activity Report shape over stored rows: four
  tabs in order (Activity Analytics, Ties & Trails, Stories &
  Highlights, AI Insights), DAILY/WEEK/MONTH/SEASON/YEAR periods, a period
  inventory with badges, delivered count and stable `data_id`s, a merged
  timeline and closed-period totals. Unavailable metrics are `null` with
  `UNAVAILABLE` and the capability-registry reason; pending periods are marked
  `provisional` and never zero-filled; CLI and MCP call the same operation.
- **`AI_INSIGHTS` capability** — documented absent: no provider returns
  personality, relationship, financial or location inferences, so the AI
  Insights tab is always refused rather than generated.
- **Tracker** — `igtrack tracker [target]` and the `igtrack_tracker` MCP tool
  project the stored ledger as a watchlist: one card per tracked account with
  new followings, unfollows, posts, stories, comments, tags and mentions for
  the latest **closed** period (weekly by default; `--at` selects exactly and
  may mark an open window `IN_PROGRESS`). Naming a target adds follow
  rosters, top commenters, recent comments, posts, hashtags, next-scan state
  and the explicit refusal list. Follow counts stay `UNAVAILABLE` with the
  coverage-gap reason unless a COMPLETE roster comparison measured them;
  counts match `activity-report` for the same window because both read one
  ledger. Read-only: no scan, queue or write.
- **Viewer** — `igtrack viewer <input>` and the `igtrack_viewer` MCP tool
  compose one account across six tabs in fixed order — stories, posts, reels,
  highlights, reposts, tagged — from logged-out public-page reads
  (`PUBLIC_WEB`) and login-free aggregator reads (`PUBLIC_AGGREGATOR`). The
  tab strip, covered-tab refusal, declared-vs-observed post counts and
  mention focus are shared; repost identities, tagged media of accounts you
  do not own, likes and AI insights are typed `UNAVAILABLE` with the
  capability-registry reason; media rows carry source URLs and the report
  never proxies or re-serves bytes. Accepts handles, profile URLs and
  post/reel/story permalinks; a highlight URL is refused with its reason.

## [1.0.0] — 2026-10-30

The first public release: an evidence-first observation engine for Instagram
accounts you are authorized to observe, with one operations layer behind a CLI
and an MCP server.

### Added

- **Investigation workflow** — `investigate` runs every stage the configured
  sources support and returns one dossier: stages, evidence classes, retrieved
  content, ranked relationships, cited public-web statements and every gap with
  its reason.
- **Plain-English surface** — `ask` plans operations from a sentence, states its
  assumptions, runs the same operations layer as the commands, and never
  auto-runs destructive steps.
- **Observation engine** — profile, stories, story mentions, posts, comments,
  carousels, tagged media and own-account insights. Every row carries source,
  observation id, observed/captured times, confidence and SHA-256 evidence.
- **Derivations** — follow deltas, profile changes, caption edits, post
  disappearances, story lifetimes, mention roll-ups, relationship rankings and
  insight series. Partial scans are stored but never diffed.
- **Periods and sets** — weekly/monthly/quarterly/yearly reports with
  OBSERVED/DERIVED/EMPTY/UNAVAILABLE sections, a period index, audience sets,
  first-seen follow movement, CSV/JSON export, digests and an idempotent local
  alert outbox.
- **Claims ledger and bounded research** — a closed predicate registry, cited
  findings, computed corroboration/conflict labels, write-time refusals for
  sensitive person-level predicates, and a bounded, SSRF-gated acquisition engine.
- **Providers** — deterministic `fixture`, official `graph` (owned account and
  optional Business Discovery), `import` (your own export), `public` (logged-out
  pages in local headless Chrome) and `anonstories` (third-party aggregator),
  each with an explicit evidence class.
- **Operations** — Postgres-backed queue with leases and heartbeats, resumable
  paged scans with checkpoints, retry classification, source health, retention
  and a per-target scheduler.
- **Agent surface** — 38 MCP tools over stdio, with negative contracts in the
  tool descriptions and evidence ids on every result.
- **Diagnostics** — `status`, `doctor`, `config` and a generated capability
  matrix that a test keeps in sync with the registry.

### Security

- Secrets are environment-only; `.env` is ignored and `config`/`doctor` print
  presence and shape, never values.
- The research engine refuses private, loopback, link-local and metadata
  addresses, re-validates redirects, respects robots.txt and refuses
  Instagram-family hosts by policy.
- Fixtures are synthetic and labelled; a fixture set observes only its manifest's
  account, so demo data cannot become evidence about a real person.

### Known limitations

- Live Graph request shapes are documentation-pinned and marked `NOT_VERIFIED`
  until run against a real account (`pnpm verify:graph` is the probe).
- Some capabilities are platform-absent by design; the full list, with reasons,
  is in [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

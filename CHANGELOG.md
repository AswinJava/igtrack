# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

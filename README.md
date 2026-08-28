# IGTrack

Evidence-driven **public** Instagram monitoring and relationship intelligence.

Enter a public username → IGTrack builds a historical, evidence-backed picture of
publicly observable activity: profile changes, stories, follow diffs, mentions,
and the strongest observed public connections — every claim linked to provenance.

**Core principle:** OBSERVATION ≠ FACT ≠ INFERENCE. Every data point is typed
(`OBSERVED | DERIVED | INFERRED | UNAVAILABLE`), timestamped, and backed by
evidence. IGTrack never pretends to know what the platform does not expose.

## Status

Phase 6 — deterministic scheduler + complete observation coverage
(FOLLOWING_SCAN, STORY_SCAN + mention pipeline, job outcomes, scheduler
diagnostics, first Playwright E2E) on top of the Phase 5 reliability gate.
Ingestion remains **fixture-only**: no production Instagram monitoring exists.
See `docs/roadmap.md`.

## Quickstart

```bash
pnpm install
pnpm test          # vitest, fixture-driven; DB suites run against real Postgres
pnpm typecheck
pnpm e2e           # Playwright smoke (needs Docker Postgres; provisions igtrack_e2e)
```

Postgres: start Docker Desktop, then `docker compose up -d` (or any Postgres 16
at `postgresql://igtrack:igtrack@127.0.0.1:5432`).

## Running

```bash
pnpm --filter @igtrack/monitoring start   # worker daemon: job polling + scheduler
```

SIGINT/SIGTERM shut the daemon down cooperatively (in-flight job finishes, pool
closes). See `docs/deployment.md` for topology, lifecycle guarantees, backup and
retention assumptions, and `docs/provider-contract.md` for the ingestion boundary.

## Layout

```
apps/web              Next.js app (Phase 3)
packages/core         domain types, provider contracts, diff/scoring primitives
packages/ingestion    source adapters, normalizers, versioned fixtures
packages/database     Drizzle schema + repositories (Phase 2)
workers/monitoring    db-backed job runner + deterministic scheduler (Phase 5–6)
docs/                 spec, architecture, data model, platform limitations
```

## Docs

- `docs/founder-brief.md` — what this is and why
- `docs/product-spec.md` — features, UX, quality bar
- `docs/architecture.md` — stack decisions and module boundaries
- `docs/data-model.md` — entities, append-only observations, evidence
- `docs/platform-limitations.md` — what Instagram does/doesn't expose, legally
- `docs/roadmap.md` — phased plan

## Safety & legality

IGTrack works only with public data, user-authorized access, or permitted
integrations. It does not bypass authentication, challenges, or access controls,
and does not access private accounts or messages. See
`docs/platform-limitations.md`.

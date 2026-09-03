# IGTrack

Evidence-driven **public** Instagram monitoring and relationship intelligence.

Enter a public username → IGTrack builds a historical, evidence-backed picture of
publicly observable activity: profile changes, stories, follow diffs, mentions,
and the strongest observed public connections — every claim linked to provenance.

**Core principle:** OBSERVATION ≠ FACT ≠ INFERENCE. Every data point is typed
(`OBSERVED | DERIVED | INFERRED | UNAVAILABLE`), timestamped, and backed by
evidence. IGTrack never pretends to know what the platform does not expose.

## Status

Phase 13 — **Zero-Cost Public Beta Ready with Explicit P2 Gates**
(fixture-only `fixture:v1`, no Graph integration, no live Instagram calls).
Provider evaluation is complete: every Graph API capability has an explicit
`AVAILABLE / PARTIAL / UNAVAILABLE / UNKNOWN` answer with evidence
(`docs/phase-10-provider-evaluation.md`), the adapter contract is mapped
method-by-method (`docs/provider-contract.md` §1e), and conformance + failure
injection remain green. Controlled Graph API testing is intentionally
`NOT YET AVAILABLE` until the founder explicitly authorizes an owned
Business/Creator account + Meta app + token via env/secret-store (no scraping,
no private-API). Until then, ingestion remains **fixture-only**
(`fixture:v1`) — the canonical conformance reference. The $0 deploy path
(Render Free web + Neon Free Postgres + GitHub Actions ephemeral worker +
R2 backups) is **IMPLEMENTED** (`render.yaml`, `Dockerfile.web/worker`,
`.github/workflows/`, `scripts/backup*.sh`) but **not yet DEPLOYED**
until the founder creates the Neon project + Render service + GitHub secrets
and runs Migrate → Worker → Backup → Restore live (15 min, no card).
See `docs/roadmap.md`, `docs/zero-cost-beta-deployment.md`,
`docs/phase-13-zero-cost-beta-readiness.md`,
`docs/phase-10-founder-report.md`, and `docs/phase-10-controlled-testing.md`.

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
closes). Provider calls are bounded by `IGTRACK_PROVIDER_TIMEOUT_MS` (default 30s)
— a hung provider becomes a typed retryable TIMEOUT, never a wedge. Follow-scan
members stage durably (`follow_scan_staging`, migration 0005) instead of JSONB
checkpoint rewrites. See `docs/deployment.md` for topology, lifecycle guarantees,
backup and retention assumptions, and `docs/provider-contract.md` for the ingestion
boundary and its conformance harness.

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

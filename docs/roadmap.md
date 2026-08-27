# IGTrack — Roadmap

Each phase ends with: inspect → implement → test → review → fix → document → commit.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo & architecture discovery: audit, foundation files, docs, monorepo scaffold, core contracts, fixture-driven ingestion | **in progress** |
| 1 | Product specification (this repo's `docs/product-spec.md`) | **done (this commit)** |
| 2 | Architecture & database: Drizzle schema, migrations, repositories, Postgres via docker-compose | next |
| 3 | Core application shell: Next.js app, layout/nav, design system, auth | |
| 4 | Target management: add/resolve/validate/pause/tags/notes | **done** |
| 5 | Observation engine: job runner (Postgres SKIP LOCKED), profile scans, source health | **done** |
| 5R | Reliability gate: worker error boundary, lease/stale reclamation, checkpoint resume integrity, privacy/verification unknowns, raw-hash honesty, same-target serialization | **done (Phase 5)** |
| 5 | Observation engine: job runner (Postgres SKIP LOCKED), profile scans, source health | |
| 6 | Story system: story observations + mention classification pipeline | |
| 7 | Follower/following snapshots + diff engine UI | |
| 8 | Interaction system: comments/mentions/tags + likes capability layer | |
| 9 | Relationship intelligence: weighted scoring, decay, explainable rankings | |
| 10 | Evidence system UI: provenance panels, hashes, "why do we know this?" | |
| 11 | Alerts: rules engine + notification adapters (in-app, browser, email) | |
| 12 | Analytics: growth, frequency, concentration charts | |
| 13 | Hardening: security review, rate limiting, retention jobs, backups | |
| 14 | Production readiness: self-host + low-cost cloud deploy guides, diagnostics | |

## MVP gate (end of Phase 10)

1. Add public target — 2. profile snapshots — 3. story observation —
4. mention extraction where available — 5. follower snapshots — 6. following
snapshots — 7. follow diffs — 8. unified timeline — 9. evidence/provenance —
10. basic relationship ranking — 11. basic dashboard — 12. source health.

Only after the gate: relationship graph, media archive, alerts depth,
analytics depth, AI explanations, search depth.

## Working agreements

- Fixture-first: every ingestion feature is built against versioned fixtures;
  real providers plug into the same contract later.
- No phase starts while the previous phase's tests are red.
- Anything requiring platform bypass is out of scope forever
  (see `platform-limitations.md`).

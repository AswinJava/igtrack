# IGTrack — Roadmap

Each phase ends with: inspect → implement → test → review → fix → document → commit.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo & architecture discovery: audit, foundation files, docs, monorepo scaffold, core contracts, fixture-driven ingestion | **done** |
| 1 | Product specification (`docs/product-spec.md`) | **done** |
| 2 | Architecture & database: Drizzle schema, migrations, repositories, Postgres via docker-compose | **done** |
| 3 | Core application shell: Next.js app, layout/nav, design system, auth | **done** |
| 4 | Target management: add/resolve/validate/pause/tags/notes | **done** |
| 5 | Observation engine: job runner (Postgres SKIP LOCKED), profile scans, source health | **done** |
| 5R | Reliability gate: worker error boundary, lease/stale reclamation, checkpoint resume integrity, privacy/verification unknowns, raw-hash honesty, same-target serialization | **done** |
| 6 | Scheduler + complete observation coverage: deterministic DB-backed scheduler (window idempotency, guarded ACTIVE-only enqueue), FOLLOWING_SCAN, STORY_SCAN + mention pipeline, job outcome dimension, scheduler diagnostics, Playwright E2E | **done** |
| 6.5 | Production-readiness gate: forensic audit, CI (real-Postgres tests + worker boot smoke + build + E2E), worker daemon entry + graceful shutdown, idle backoff, scheduler fleet rotation, deployment/provider-contract/ops docs | **done** |
| 6.6 | Provider-integration hardening: PC-T1 provider timeout boundary, PC-T2 checkpoint staging (durable `follow_scan_staging`, O(n) writes), provider error taxonomy + retryability + retry-after, empty-list honesty, source-class registry, conformance harness + fixture suite, migration 0005 verified on existing DBs, CI infra guard, config audit | **done** |
| 7 | Honesty depth in UI: empty-vs-zero reclassification (D2), PARTIAL surfacing (D3), diff engine UI depth | next |
| 8 | Interaction system: comments/mentions/tags + likes capability layer | |
| 9 | Relationship intelligence: weighted scoring, decay, explainable rankings | |
| 10 | Evidence system UI: provenance panels, hashes, "why do we know this?" | |
| 11 | Alerts: rules engine + notification adapters (in-app, browser, email) | |
| 12 | Analytics: growth, frequency, concentration charts | |
| 13 | Hardening: security review, rate limiting, retention jobs, backups, CI | |
| 14 | Production readiness: self-host + low-cost cloud deploy guides | |

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

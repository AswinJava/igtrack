# Phase 7 — Final Founder Report

## 1. Executive verdict

**NOT READY FOR PUBLIC PRODUCTION — READY FOR PROVIDER EVALUATION (CONDITIONAL).**

The engineering answer to Phase 7's question is: **yes, conditionally.** IGTrack's
architecture is provider-ready: capability honesty, evidence integrity, append-only
history, and job reliability held up under independent forensic audit, and four P1
blockers were found and fixed this phase (CI absence, non-bootable worker daemon,
idle DB hammering, scheduler fleet starvation). What remains before exposing the
system to real traffic is a small, well-understood P2 security/ops list (login rate
limiting, session purge scheduling, unused `IGTRACK_SESSION_SECRET` decision, backup
policy). None of them touch the provider contract.

## 2. Commit

Phase 7 work committed on `master` (this report + failure matrix + provider contract
+ deployment docs + P1 fixes + CI + 3 new tests). Baseline was `369f566`.

## 3. Baseline verification (all reproduced against `369f566`)

| Command | Result |
|---|---|
| `git status` / `git log` | clean tree, HEAD `369f566` (26 commits unpushed — note: unpushed means no CI could have run) |
| `pnpm test` (no Postgres) | 46 passed / **88 skipped** — DB suites silently skip; "all tests pass" was only true with infrastructure up |
| `pnpm test` (Postgres up) | **133 passed, 1 skipped** (23 files, 56.8s) — Phase 6 claim verified |
| `pnpm typecheck` | all 4 packages pass |
| `pnpm --filter @igtrack/web build` | production build passes |
| `pnpm e2e` | **7/7 passed** (1.4m, isolated `igtrack_e2e`) |
| PostgreSQL health | docker compose Postgres 16 healthy; migrations reproducible on fresh schemas |

## 4. Production architecture assessment

Sound and honest. Postgres is the single persistence/queue boundary (`SKIP LOCKED`,
lease reclaim, terminal reap, same-kind serialization). Providers sit behind
`InstagramProvider`; core is dependency-free; UI has no provider logic; observations
are append-only at the database level (UPDATE-rejecting triggers). The modular
monolith boundary has been respected throughout.

## 5. P0 findings

**None.** No data-corruption path, no cross-user exposure, and no fabricated
epistemic claim was found in the forensic audit.

## 6. P1 findings (all fixed this phase)

| ID | Finding | Fix |
|---|---|---|
| C1 | **No CI existed** — every gate was manual; 26 commits unpushed | `.github/workflows/ci.yml`: install → typecheck → tests on real Postgres → **worker boot smoke** → production build → Playwright |
| W1 | **Worker daemon could not be started** — `runWorkerLoop` was never invoked; `start` imported a module and exited | `workers/monitoring/src/main.ts` daemon entry + `start` wiring |
| W6 | Worker **crashed at import under real Node/tsx** (`import { PostgresError } from "postgres"` — invalid ESM named export; vitest interop had masked it forever) | Default-import static access; CI boot-smoke prevents regression |
| D1 | **Idle worker hammered Postgres** — no sleep when the queue is empty | Idle backoff (test J12) |
| S11 | **Scheduler starved targets beyond the first 200 forever** — empirically 1,000 targets → only 800 jobs ever enqueued | Clock-rotated fleet paging (test S11) |
| W2 | No SIGINT/SIGTERM handling | Cooperative shutdown (test J13): stop claiming, in-flight job finishes, pool closes |

## 7. P2 findings (documented, not hidden)

- **Checkpoint cliff quantified** (§10): safe ≤ ~10k members; unsafe ≥ ~50k.
  Staging-table migration path designed, not built. **Hard gate for any real provider.**
- `IGTRACK_JOB_LEASE_MS` has no heartbeat → scans longer than the lease are doubly
  executed (integrity safe via append-only idempotency; wasted work).
- No provider-call timeout (PC-T1) — mandatory before real providers.
- Login brute-force: no rate limiting. Login timing oracle on unknown users.
- `purgeExpiredSessions` never scheduled; terminal `monitoring_jobs` grow unbounded.
- `IGTRACK_SESSION_SECRET` documented but unused (founder decision);
  `IGTRACK_JOB_CONCURRENCY` unused.
- Diagnostics page authenticated but global (not per-user).
- No backups; observation history is unreconstructible — RPO is a founder decision.
- Pool lacks explicit connect/idle/statement timeouts.
- No Dockerfiles; deployment documented but packaging deferred.
- Observability gaps: scan durations, per-target last-success history.

## 8–12. Reliability / database / checkpoint / scheduler / worker

- **Reliability**: the daemon now boots, never hammers, never dies on recoverable
  errors, and shuts down cooperatively. Jobs cannot become permanently stuck (lease
  reclaim + terminal reap). Two workers cannot mutate the same logical scan without
  ownership checks; a stale worker cannot clobber a successor (`JobStateError`).
- **Database**: migrations reproducible; append-only triggers verified; hot queries
  clean (single LATERAL target list, bounded lists, partial indexes for claimable and
  idempotency paths). No OFFSET pagination on hot paths.
- **Checkpoint scaling**: 31 KB @1k → 14.8 MB @500k payloads; O(n²) rewrite
  amplification 15 MB @10k → **37 GB @500k per scan**; PG16 round-trip ≤0.8s at 500k.
  Honest boundary today: ~10k members per scan.
- **Scheduler guarantee (honest)**: at-most-once per `(kind, target, window)`; no
  catch-up for missed windows; epoch-math windows are UTC/DST-immune; clock jumps may
  skip (never duplicate) a window. Ticks are interval-bounded; fleet coverage rotates.
- **Worker lifecycle**: all §5 scenarios reviewed — rows W1–W6 and the J-tests cover
  them; unknown job kinds fail non-retryably; infrastructure errors retry with
  backoff; the loop survives a dead database and recovers when it returns.

## 13. Evidence / epistemic assessment

Clean. `raw_hash` is genuine-or-NULL and never a normalized hash (regression-tested).
UNAVAILABLE never collapses into COMPLETED_EMPTY or zero; PARTIAL is never upgraded;
UNKNOWN privacy/verification is preserved until explicitly observed; UI claims trace
to evidence with source, timestamps, confidence, hashes, and synthetic flags. The
repo-wide semantic sweep found no `?? false` / `|| 0` epistemic fallbacks.

## 14. Security assessment

Solid for a single-tenant deployment; not yet public-internet hard. scrypt password
hashing (N=16384), opaque hashed sessions with DB-checked expiry and revocation,
consistent not-found ≡ not-yours scoping (IDOR sweep clean), secret-free structured
logs, dev-login hard-404 in production builds. Outstanding P2s: rate limiting, session
purge, login timing oracle, per-user diagnostics, CSRF Origin hardening.

## 15. CI/CD assessment

Was: **nothing**. Now: full gate on push/PR — frozen-lockfile install, typecheck,
vitest incl. worker suites against a real PostgreSQL 16 service, worker daemon boot
smoke, production web build, Playwright E2E against an isolated database.

## 16. Deployment assessment

Topology documented (`docs/deployment.md`): WEB + WORKER(+embedded scheduler) +
PostgreSQL 16, with lifecycle guarantees, restart/health/migration/rollback posture,
backup assumptions, retention table, and the logging policy. Container packaging
remains deferred until the platform decision.

## 17. Observability assessment

Database-backed diagnostics answer: scheduler alive (last tick/success/error), worker
alive (last claim), stuck/retrying/failed jobs, provider availability (source health),
outcome distribution. Missing: scan-duration metrics, per-target last-success history,
machine-readable health endpoint. No paid services needed.

## 18. Provider contract assessment

Documented as `docs/provider-contract.md`: exact capability matrix for all seven
methods (inputs, outputs, statuses, cursor semantics, raw-representation rules) plus
14 requirements (PC-1…PC-T4) any real provider must demonstrate, including worker-
enforced call timeouts (PC-T1) and page bounds tied to the checkpoint migration (PC-T2).

## 19. Lawful provider requirements

Compliant integration requires demonstrating: identity, observation time, raw evidence
or explicit absence, exact completeness, explicit capability statuses, a provable
authorization basis per account, rate-limit honesty, and bounded scope. Instagram
offers no permitted API for arbitrary third-party public-account monitoring; IGTrack
promises only user-owned/authorized (Graph API) and user-import scopes. FixtureProvider
remains the canonical dev/test provider.

## 20. Tests added

3 (RED → GREEN, each verified failing first):
- **J12** — idle poll backoff (was: tight DB loop).
- **J13** — cooperative shutdown via `shouldStop`.
- **S11** — scheduler fleet coverage beyond the batch limit (250 targets, two ticks →
  250 covered; previously 200 forever).

Final suite: **136 passed, 1 skipped (137), 23 files.**

## 21–23. Typecheck / Build / Playwright

- `pnpm typecheck`: all packages pass (re-verified after every fix).
- `pnpm --filter @igtrack/web build`: passes.
- `pnpm e2e`: 7/7 passed (baseline; web untouched by Phase 7 fixes).
- Worker suites after the W6 import fix: 47/47.

## 24. Documentation

`docs/phase-7-failure-matrix.md` (canonical), `docs/provider-contract.md`,
`docs/deployment.md`, README running section.

## 25. Remaining defects

All P2s in §7. None block provider-contract evaluation; rate limiting and backups
block public exposure.

## 26. Deferred work

Checkpoint staging-table migration, lease heartbeat, provider-call timeout wrapper,
Dockerfiles, machine-readable `/healthz`, scan-duration metrics, scheduled cleanups
(sessions, terminal jobs, story media reaper).

## 27. Founder decisions required

1. `IGTRACK_SESSION_SECRET`: sign sessions with it or delete it from `.env.example`.
2. Acceptable RPO / backup schedule (recommend ≤24h given story ephemerality).
3. Target deployment platform (unblocks Dockerfiles).
4. `ig_accounts` retention policy for deleted targets (registry keeps third-party PII).
5. When to schedule the public-internet hardening P2s (rate limit, CSRF Origin, purge).

## 28. Final Git status

Working tree committed and clean on `master`; the Phase 7 changeset adds: 4 documents,
1 CI workflow, worker daemon entry + 4 reliability fixes, scheduler fleet rotation,
3 new tests. No secrets committed.

## 29. FINAL RECOMMENDATION

**READY FOR PROVIDER EVALUATION — conditionally.**

- Provider evaluation may proceed against the contract now (lawful/authorized sources
  only; FixtureProvider unchanged as the canonical dev/test provider).
- Integration is gated on the staged P2s: PC-T1 timeouts, PC-T2 checkpoint migration
  for large lists, plus rate limiting and backups before any public exposure.
- The verdict is deliberately **NOT READY for public production traffic** — and
  honestly so. Phase 7's question is answered: the system can now safely evaluate a
  lawful provider against its contracts without weakening reliability, security, or
  epistemic integrity.


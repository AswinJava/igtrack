# IGTrack — Phase 7 Failure Matrix

Status: **canonical Phase 7 contract** (production readiness + provider contract gate).
Verdicts: `GAP` (fixed this phase), `OK` (verified already correct), `DEFER` (documented,
not fixed — requires founder decision or real-provider trigger), `DOC` (documented behavior).
Severity: P0 data corruption / cross-user exposure / fabricated claims · P1 production
blocker · P2 scaling / maintainability · P3 cosmetic.

Inherited invariants (Phase 5 + Phase 6 matrices) remain in force unchanged.

## A. Database

| ID | Area / scenario | Expected | Current | Sev | Fix | Test |
|---|---|---|---|---|---|---|
| D1 | Idle worker hammering claim query | Empty queue → poll backoff | **Was**: tight loop, 2 statements per iteration unbounded | P1→GAP | **FIXED (J12)** | J12 |
| D2 | Pool has no explicit `connect_timeout` / `idle_timeout` / `max_lifetime` | Hung connections bounded | Defaults only (`max: 10`) | P2 | DEFER | yes |
| D3 | Migration reproducibility | Fresh schema = deterministic state | OK — journal-driven, verified on fresh test + E2E DBs | OK | — | existing |
| D4 | Append-only enforcement | UPDATE rejected at DB level | OK — triggers on all 9 observation tables | OK | — | schema.test |
| D5 | Unbounded terminal `monitoring_jobs` growth | Scheduled cleanup | No retention job | P2 | DEFER (ops doc) | yes |
| D6 | Hot queries | No N+1 / OFFSET scans / unbounded SELECT | OK — `listTargetsForUser` single LATERAL query; all lists bounded | OK | — | — |

## B. Worker

| ID | Scenario | Expected | Current | Sev | Fix | Test |
|---|---|---|---|---|---|---|
| W1 | Worker daemon cannot be started | `pnpm --filter @igtrack/monitoring start` runs the loop | **Was**: `src/index.ts` only exports; loop never invoked | P1→GAP | **FIXED** (`src/main.ts`) | smoke (manual) |
| W2 | SIGINT / SIGTERM | Stop claiming, finish in-flight job, close pool, exit | **Was**: no handlers; kill mid-job relied on lease expiry | P1→GAP | **FIXED (J13 + main.ts)** | J13 |
| W3 | Scan longer than lease (300s default) | No duplicate execution | Reclaim while stale worker still runs → duplicate execution; integrity preserved (append-only idempotency, logical scan identity, same-job checkpoint ownership) but work is wasted | P2 | DEFER (lease heartbeat / config doc) | yes |
| W4 | Provider hangs indefinitely | Bounded call duration | No timeout wrapper; a hung real provider would wedge the single-threaded loop permanently | P1 *with real provider* / P2 fixture-only | DEFER → mandatory contract requirement PC-T1 | yes |
| W5 | `IGTRACK_JOB_CONCURRENCY` documented but unused | Config honored or removed | Env read nowhere; loop is strictly sequential | P3 | DEFER (doc) | — |
| W6 | Worker under plain Node/tsx crashed at import (`import { PostgresError } from "postgres"` — no such ESM named export; vitest interop masked it) | Daemon starts under real Node resolution | **Was**: `SyntaxError` at module load — the worker had never actually booted outside vitest | P1→GAP | found by the new CI boot smoke | **FIXED** (default-import static) | CI boot smoke step |

## C. Scheduler

| ID | Scenario | Expected | Current | Sev | Fix | Test |
|---|---|---|---|---|---|---|
| S11 | Fleet > batch limit (200) | Every ACTIVE target considered across ticks | **Was**: stable `ORDER BY created_at LIMIT 200` starved targets 201+ **forever** (empirical: 1,000 targets → only 800 jobs ever enqueued) | P1→GAP | **FIXED** (clock-rotated fleet paging) | S11 |
| S12 | Missed windows (worker down) | Honest guarantee documented | At-most-once per `(kind,target,window)`; **no catch-up** — a missed window is skipped, never back-filled | DOC | — | — |
| S13 | Clock jumps | No duplicates; skip/re-entry characterized | Epoch-math windows, UTC, DST-immune; backward jump → dedup no-op; forward jump → skipped window | DOC/P3 | — | — |
| S14 | Tick cost at fleet scale | Bounded per tick | ~6s per tick at 200 targets × 4 kinds (sequential guarded enqueues); linear in batch | P2 | DEFER (set-based enqueue) | — |

## D. Checkpoint scalability (quantified, deterministic synthetic benchmark)

| Members/scan | Checkpoint JSON | Total checkpoint rewrites per scan (100/page) | Real PG16 upsert / read |
|---|---|---|---|
| 1,000 | 31 KB | <1 MB | 71 ms / 56 ms |
| 10,000 | 0.30 MB | 15 MB | 65 ms / 33 ms |
| 50,000 | 1.48 MB | 370 MB | 103 ms / 65 ms |
| 100,000 | 2.96 MB | 1.48 GB | 241 ms / 108 ms |
| 500,000 | 14.8 MB | 37 GB | 793 ms / 466 ms |

| ID | Finding | Sev | Fix |
|---|---|---|---|
| K1 | `progress.entries` rewrites the full accumulated member list every page → O(n²) write amplification; unsafe ≥ ~50k members | P2 now / **P1 before any real provider** | DEFER — path designed: `follow_scan_members(job_id, seq, …)` staging table; checkpoint keeps cursor only |
| K2 | `recordFollowSnapshot` upserts accounts one round-trip per member inside one transaction → multi-minute transactions at scale | P2 / P1 with real provider | DEFER (staging path, set-based upsert) |
| K3 | Evidence metadata stores the full username list per snapshot, append-only → duplicated per scan | P2 | DEFER (same path) |

**Honest boundary**: safe for scans up to ~10k members (fixture-scale). Must be replaced
before a real provider can return large lists.

## E. Evidence / epistemic

| ID | Check | Result |
|---|---|---|
| E1 | `raw_hash` = genuine raw hash or NULL; never `hash(normalized)` | OK (migration 0003 + executors + regression tests) |
| E2 | UNAVAILABLE never becomes COMPLETED_EMPTY / zero | OK (ST2/ST3, C3) |
| E3 | PARTIAL preserved, never upgraded | OK (F2, ST4) |
| E4 | `is_private` / `is_verified` UNKNOWN until explicitly observed | OK (migration 0002, upsertAccount, privacy tests) |
| E5 | Absence-of-data ≠ negative knowledge in UI copy; no `?? false` / `|| 0` epistemic fallbacks | OK (repo-wide semantic sweep) |
| E6 | Derived/inferred lineage (deltas, changes) evidence-linked | OK |

## F. Auth / security

| ID | Area | Finding | Sev |
|---|---|---|---|
| A1 | Password hashing | scrypt N=16384, timing-safe compare | OK |
| A2 | Login timing | Unknown user short-circuits before scrypt → account-existence timing oracle | P2 (defer; fix = dummy-hash on miss) |
| A3 | Sessions | Opaque 32B token, SHA-256 stored, DB-checked expiry, revocation on logout | OK |
| A4 | `IGTRACK_SESSION_SECRET` | Documented in .env.example, **never used anywhere** | P2 — founder decision: use for signing or remove |
| A5 | dev-login in production | Hard 404 on production builds (NODE_ENV gate), no opt-in override | OK |
| A6 | `purgeExpiredSessions` | Defined, never called → sessions accumulate | P2 (cleanup strategy documented) |
| A7 | Login rate limiting | None → brute-force possible | P2 (required before public exposure) |
| A8 | IDOR | All target/evidence/activity/relationship access user-scoped; not-found ≡ not-yours | OK |
| A9 | CSRF | httpOnly + sameSite=lax + JSON-only bodies + no mutating GET; Origin check recommended before public exposure | P3 |
| A10 | Diagnostics | Authenticated, but global (not per-user) operational aggregates | P2 |
| A11 | Secrets | None committed; worker logs structured and secret-free | OK |

## G. CI / deployment / operations

| ID | Area | Finding | Sev |
|---|---|---|---|
| C1 | CI | **No CI existed at all** — every gate was manual | P1→GAP — **FIXED**: `.github/workflows/ci.yml` |
| C2 | Deployment topology | Undocumented; no Dockerfiles; `start` script ran nothing | P1→GAP — documented (`docs/deployment.md`); artifact packaging DEFER (P2) |
| C3 | Backup / recovery | No backups; append-only observation history is **not reconstructible** if the volume is lost | P2 — documented; RPO is a founder decision |
| C4 | Observability | Scheduler/worker/queue/source/outcome coverage exists; missing scan-duration and per-target last-success history | P2 |

## Test → contract mapping (Phase 7 additions)

| Test | Rows covered |
|---|---|
| `workers/monitoring/test/scheduler.test.ts` → "scheduler fleet coverage" | S11 |
| `workers/monitoring/test/worker-boundary.test.ts` → J12, J13 | D1/W2, W2-cooperative-shutdown |


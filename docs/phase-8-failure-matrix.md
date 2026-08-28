# IGTrack — Phase 8 Failure Matrix

Status: **canonical Phase 8 contract** (provider evaluation + hardening).
Verdicts: `GAP` (fixed this phase), `OK` (verified correct), `DEFER` (documented,
not built), `DOC` (documented behavior). Severity: P0 corruption/cross-user/
fabrication · P1 production blocker · P2 scaling/maintainability · P3 cosmetic.
Inherited Phase 5/6/7 invariants remain in force.

| Component | Failure | Expected | Previous | Fixed | Recovery | Evidence impact |
|---|---|---|---|---|---|---|
| Provider | Call hangs indefinitely | Typed retryable TIMEOUT; loop survives | Wedged the single-threaded worker permanently | **GAP — PC-T1** (`withProviderTimeout`, `IGTRACK_PROVIDER_TIMEOUT_MS`) | retry_wait with backoff | None — no evidence produced |
| Provider | Call exceeds timeout but later resolves | Late result discarded | n/a (no boundary) | **GAP — PC-T1** | same as timeout | None |
| Provider | Malformed payload | Typed non-retryable SCHEMA_MISMATCH, no crash, no raw dump | OK (fixture) — now pinned by conformance tests | OK (C5 test) | job fails permanently | None |
| Provider | Rate limited | retryAfterMs honored verbatim as retry time | No channel existed; generic backoff only | **GAP — STEP 10** (`retryAfterMs` → `available_at`, RL-1 test) | delayed retry, no hammering | None |
| Provider | Permanent denial (AUTH_REQUIRED/FORBIDDEN) | Non-retryable regardless of provider claim | Ad-hoc per-call-site defaults | **GAP — STEP 9** (`effectiveRetryability` mapping) | job fails terminally | None |
| Follow scan | Empty complete list | Honest empty COMPLETE snapshot + COMPLETED_EMPTY | Retryable EMPTY **failure** — absence collapsed into failure | **GAP — F8-2** (T2-4 test) | succeeds with zero rows | Zero recorded as positive observation |
| Follow scan | Crash mid-scan | Staged members survive; resume completes | Members lived in JSONB checkpoint (O(n²) rewrites) | **GAP — PC-T2 staging** (T2-1) | resume from cursor + staging | No fabricated LOST deltas |
| Follow scan | Duplicate page / reordered page | Dedupe on (job_id, username_lower) | In-memory `seen` set (lost on restart) | **GAP — staging unique index** (T2-2) | idempotent | None |
| Follow scan | Stale lease → reclaim | Same logical scan re-executes idempotently; one snapshot | Worked but rebuilt full member list in memory | **GAP — staging path** (T2-5) | reclaimed job continues | None |
| Follow scan | Abandoned foreign staging | Cleared at scan start; own rows preserved | n/a (no staging) | **GAP** | fresh scan is clean | None |
| Source registry | Non-fixture provider source id | Explicit class→kind mapping; unknown falls back to IMPORT, never fake GRAPH_API | Every non-fixture id silently became IMPORT | **GAP — STEP 11** (explicit class registry) | n/a | Source attribution stays honest |
| Checkpoint scale | 50k-member scan | Bounded writes | 370MB JSONB rewrites per scan (measured) | **GAP — PC-T2**: 13KB (measured), 2.5× faster | linear in members | None |
| CI | PostgreSQL unavailable | CI FAILS explicitly | DB suites silently skipped locally; CI relied on service health only | **GAP — STEP 20** explicit require-Postgres step | loud failure | n/a |
| Config | Dead/lying env vars | Removed or documented | `IGTRACK_JOB_CONCURRENCY` dead; `IGTRACK_SESSION_SECRET` undocumented-unused | **GAP — STEP 17** (.env.example audit) | n/a | n/a |
| Conformance | Future provider violates contract | Reusable harness rejects it | No harness existed | **GAP — STEP 15** (`core/test/conformance-harness.ts` + fixture suite C1–C5) | n/a | prevents fabricated claims at the boundary |
| Migration | 0005 on existing Phase-7 DB | Applies cleanly, preserves data | n/a | **GAP — STEP 18** verified live (journal 0004 + data → 0005) | journal-driven | data preserved (verified) |

Unchanged-from-previous-phases (verified still holding): lease reclaim + terminal
reap, ownership-guarded complete/fail, same-kind same-target serialization,
append-only triggers, UNAVAILABLE ≠ zero, PARTIAL never upgraded, UNKNOWN
preserved, raw_hash genuine-or-NULL, scheduler window idempotency + fleet rotation,
worker idle backoff + cooperative shutdown.

## Deferred (documented, not built in Phase 8)

Real Instagram provider; per-member account-upsert batching at snapshot time;
Dockerfiles; `/healthz`; scan-duration metrics; login rate limiting; backups/RPO
execution; pool timeout tuning; `IGTRACK_SESSION_SECRET` decision.

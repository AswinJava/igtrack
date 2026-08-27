# IGTrack — Phase 5 Founder Report

Status: **reliability-gate contract.** Written before implementation; results and
final verdict are appended at gate completion. Findings reference
`docs/phase-5-failure-matrix.md` row IDs.

## 1. Executive verdict (pre-gate)

**NOT READY.** The Phase 0–4 baseline is architecturally sound (clean boundaries,
append-only enforced at the DB, honest capability branches, 71/71 tests passing
against real Postgres 16). But the observation engine is **unfit for continuous
monitoring** until four verified P0 violations are closed:

1. **B1** — a crashed worker strands its job in `running` forever; nothing ever
   reclaims it (`locked_at` is written and never read).
2. **B2** — any transient infrastructure error (Postgres restart, completion
   race, lost ownership) escapes the worker loop and **kills the daemon**.
3. **B3** — checkpoint resume drops pre-crash pages from the follower snapshot
   and `persistFollowDiff` then **fabricates `LOST_FOLLOWER` deltas** for members
   it never actually lost. Fabricated negative knowledge — the worst class of
   defect this product can ship.
4. **D1** — `upsertAccount` overwrites `is_private`/`is_verified` with `false`
   whenever a caller does not know them. Absence is written as a positive claim.

## 2. Scope of this phase

Reliability and epistemic integrity only: failure model, P0 fixes, P1 honesty
fixes, failure-injection tests, documentation. No new product surface.

Explicitly out of scope (locked until the gate is green): scheduler, FOLLOWING_SCAN,
STORY_SCAN wiring, empty-vs-zero reclassification (D2), PARTIAL UI depth (D3),
job outcome dimension (D4), Playwright, CI. See §5.

## 3. Verified findings

### P0 — gate blockers (all reproduced by code inspection against HEAD `5ea1603`)

| ID | Finding | Matrix rows |
|---|---|---|
| B1 | No lease / stale-running reclamation; `failJob` UPDATE lacks ownership guard | J1, J2, J5, J8, J10 |
| B2 | Worker loop dies on: claim-time DB failure, `JobStateError` from `completeJob`/`failJob`, any unexpected executor throw | J3, J4, J7, J11 |
| B3 | Follower checkpoint resume loses pre-crash pages; fabricated LOST deltas | P2, E3 |
| D1 | Absence→`false` fabrication for `is_private`/`is_verified` across schema defaults, upsert conflict path, and four normalize sites | V1–V5 |

### P1 — honesty/reliability (fixed in this phase, after P0s)

| ID | Finding | Matrix rows |
|---|---|---|
| C1 | Follower snapshot identity = worker wall-clock → crash-after-write duplicates observations | P4, P5, E3, E4, E7 |
| C2 | Partial pagination persisted as `COMPLETE` (hardcoded) | P6, C2 |
| B4 | Same-target same-kind scans can interleave; checkpoint has no ownership validation | P9 |
| E | Worker evidence `rawHash` is actually a normalized-data hash; raw payload never retained; provider's genuine raw-hash stream discarded | E5 |

### P2 — deferred (documented, not hidden)

D2 empty-vs-zero follower conflation · D3 profile PARTIAL surfacing · D4 job
outcome dimension · `sourceKindFor` misclassifies non-fixture providers ·
relationship heuristic lives in the database package · web's unused
`@igtrack/ingestion` dependency · unused env vars (`IGTRACK_SESSION_SECRET`,
`IGTRACK_JOB_CONCURRENCY`) · stale README/roadmap · no CI · no Playwright ·
unscheduled `purgeExpiredSessions` · diagnostics not user-scoped.

## 4. Architecture decisions (with rejected alternatives)

**D-1 Lease via existing columns; two-statement claim.** `claimJob` gains a lease
(default 5 min, `IGTRACK_JOB_LEASE_MS`): statement 1 reaps stale `running` jobs
whose attempts are exhausted → `failed`; statement 2 claims `queued`/`retry_wait`
due jobs **or** stale `running` jobs with attempts remaining. No new table, no
heartbeats. *Rejected:* dedicated lease table (more state, no added guarantee);
heartbeat extension loops (distributed-scheduler theater at monolith scale);
reclaim→`queued` transition (would allow one extra execution beyond
`max_attempts`).

**D-2 Worker error taxonomy: execution / state / infrastructure / programming.**
`JobExecutionError` keeps its retry semantics; `JobStateError` (lost ownership)
→ outcome `lost`, no state change, no crash; `PostgresError` (cause-chain
checked) → retryable `DATABASE` failure, or `unrecorded` if even recording fails
(job stays `running`; lease reclaim is the recovery); any other throw →
non-retryable `UNEXPECTED` failure (programming errors must reproduce loudly,
not churn retries). `runWorkerLoop` catches everything, logs safely (truncated
messages, no payloads/secrets), sleeps, continues. *Rejected:* blanket-retryable
unexpected errors (masks bugs, current behavior); crash-and-restart as
"recovery" (B2 is exactly that failure).

**D-3 Checkpoint carries acquired entries; ownership validated.** Checkpoint
`progress` stores `{ cursor, page, entries }` (username + igId) and `job_id`.
Resume is honored **only** when `checkpoint.jobId === job.id`; otherwise the scan
starts fresh. Fix for B3; basis for B4 backstop. *Rejected:* page-staging table
(correct but adds schema + GC of abandoned staging rows — documented as the
post-MVP scaling path when follower lists grow); usernames-only payload (cannot
rebuild members with identity).

**D-4 Logical scan identity = `job.started_at`.** Follower snapshot `taken_at`
and evidence `observed_at` derive from the job's first-claim timestamp, which
`claimJob` already preserves across retries and reclaims (`coalesce`). Same
logical scan retry → same natural key → dedupe. Different scans → different
identity. `captured_at` remains real capture time. *Rejected:* uuid scanId in
payload (extra write, no additional property); content-hash identity (collides
for legitimately identical consecutive scans).

**D-5 UNKNOWN stays UNKNOWN: nullable privacy.** Migration makes
`ig_accounts.is_private/is_verified` nullable (drop not null + default);
`upsertAccount` writes/updates them **only** when the caller explicitly knows
them; normalizers stop defaulting absence to `false`; `NormalizedAccountRef`
/`NormalizedProfile` make the fields optional; UI renders unknown honestly.
*Rejected:* keep `NOT NULL DEFAULT false` (structurally encodes the
fabrication); separate "known" flag columns (two sources of truth).

**D-6 Evidence hashes tell the truth.** `evidence.raw_hash` becomes nullable
(genuine 64-char check retained when present); `CapabilityResult` gains optional
`rawPayloadHash`/`rawReference`; `FixtureProvider` transports its real raw-text
hash (the parallel evidence-sink stream is **deleted** as dead code); the worker
sets `raw_hash` only from provider-provided raw provenance, else NULL, and always
hashes the normalized form into `normalized_hash`. *Rejected:* renaming the
column (churn without honesty gain); hashing raw "when available" at the worker
(the worker never sees raw payloads — the provider is the only honest source).

**D-7 Completeness from the provider contract only.** The follower snapshot
persists the final page's actual `complete` flag; loop exit without contractual
completion → `PARTIAL`. No hardcoded completeness anywhere.

**D-8 Claim-time same-target serialization.** Claim excludes jobs of the same
kind+target when one is already `running`. Prevents overlap in the common case;
the D-3 ownership guard is the correctness backstop if the SQL race window is
hit. *Rejected:* advisory session locks (pool-unsafe), per-target lock tables
(new infra for a queue-level property).

**D-9 Scheduler, FOLLOWING_SCAN, STORY_SCAN: deferred until the gate is green.**
They reuse the fixed follower executor skeleton; building on unrecovered
crash semantics would multiply risk. The scheduler will be the smallest loop:
ACTIVE targets → deterministic idempotency keys (kind + target + time bucket),
per-target serialization (already enforced at claim), lease + reclaim
(already built), honest UNAVAILABLE outcomes.

## 5. MUST FIX BEFORE MVP vs CAN DEFER

**Must fix before MVP (this gate):** B1, B2, B3, D1, C1, C2, B4, E — plus the
failure-injection suite and docs below.

**Can defer after MVP:** D2, D3, D4, scheduler, FOLLOWING/STORY wiring,
staging-table checkpoints, Playwright, CI, rate limiting, CSRF depth, session
purge scheduling, diagnostics scoping, dependency/env cleanup.

## 6. Invariants (bind every future change)

1. UNAVAILABLE ≠ EMPTY/0. 2. UNKNOWN ≠ FALSE. 3. PARTIAL ≠ COMPLETE. 4. FAILED
≠ SUCCEEDED. 5. STALE ≠ CURRENT. 6. CRASHED ≠ COMPLETED. 7. UNOBSERVED ≠ NOT
PRESENT. 8. Observations append-only (DB-enforced). 9. Same logical scan retry
→ same observation; different scan → different observation. 10. A checkpoint
belongs to exactly one logical scan.

## 7. Test strategy

RED → FIX → GREEN → regression → full suite, per finding. Failure injection is
deterministic:

- **Crashes** are simulated by executor hooks (`crashAfterPages`) and partial
  execution (run executor, do not complete the job), never by `sleep`.
- **Time** is controlled via an injected `leaseMs` claim option; `leaseMs: 0`
  reclaims deterministically. No multi-second sleeps.
- **Infrastructure failures** are injected via a proxy `Database` whose
  `execute` throws, and by provider stubs that throw `PostgresError`-shaped
  errors.
- **Ownership races** are produced by claiming with worker A, reclaiming with
  worker B (`leaseMs: 0`), then having A attempt completion/failure.
- **Partial pagination** uses an in-test provider stub whose final page reports
  `complete: false` without a cursor.
- Worker tests run against the real Postgres test database (`igtrack_test`);
  a DB gate probe keeps them honest — DB tests are never "skipped" silently
  when Postgres is expected: the fallback branch is the only allowed skip.

## 8. Acceptance gates (§21 of the directive)

- [ ] B2 worker survives transient infrastructure failures
- [ ] B1 stale running jobs are reclaimable
- [ ] Stale workers cannot overwrite successor results
- [ ] B3 checkpoint resume preserves all acquired pages
- [ ] No fabricated LOST members after crash/recovery
- [ ] D1 privacy/verification unknowns cannot overwrite known facts
- [ ] C1 logical scan retry is idempotent
- [ ] C2 PARTIAL cannot become COMPLETE
- [ ] B4 same-target scan concurrency is safe
- [ ] Evidence hashes are semantically truthful
- [ ] Worker tests exist and execute
- [ ] Failure-injection tests execute
- [ ] Real Postgres tests execute
- [ ] `pnpm test` passes · `pnpm typecheck` passes · web build passes
- [ ] No unexplained skipped tests
- [ ] Documentation matches implementation
- [ ] Git working tree clean, commits logically separated

## 9. Remaining risks (accepted, post-gate)

1. Lease expiry can double-execute a long job; mitigated by logical-scan
   identity dedupe and ownership checks — worst case is wasted work, never
   corrupted history.
2. Checkpoint payload grows with the member list; quadratic write bytes remain
   until the staging-table path (documented scaling limit).
3. `failJob`'s select-then-guarded-update has a tiny window where a reclaimed
   job loses the failing worker's error record — recovery is correct (reclaim
   path owns the job), only diagnostics detail is lost.
4. D2/D3/D4 honesty gaps remain open until their deferred fix (tracked above).

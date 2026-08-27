# IGTrack — Phase 5 Failure Matrix

Status: **canonical Phase 5 reliability contract** (founder-approved scope).
Every row states: failure → current behavior → required behavior → recovery →
evidence semantics → whether data may be persisted → required test.

Verdicts: `OK` (verified correct), `GAP` (violation to fix in Phase 5),
`DEFERRED` (documented, consciously not fixed now).

## 0. Invariants enforced by this contract

| Invariant | Enforcement point |
|---|---|
| UNAVAILABLE never becomes EMPTY/0 | worker capability branches; `source_health.status` |
| UNKNOWN never becomes FALSE | `ig_accounts.is_private/is_verified` nullable; absence-preserving upsert |
| PARTIAL never becomes COMPLETE | provider `complete` flag → `follow_snapshots.completeness` |
| FAILED never becomes SUCCEEDED | ownership-guarded `completeJob`/`failJob` |
| STALE never becomes CURRENT | lease reclaim + ownership checks |
| CRASHED never becomes COMPLETED | lease reclaim; reap of exhausted jobs |
| UNOBSERVED never becomes NOT PRESENT | checkpoint resume preserves all acquired pages |
| Observations are append-only | DB triggers (unchanged) |

## A. Job lifecycle

| ID | Failure | Current | Required | Recovery | Evidence impact | Test |
|---|---|---|---|---|---|---|
| J1 | Worker dies after claim, before execute | GAP B1: job stranded `running` forever (`locked_at` written, never consulted) | Lease expiry makes job reclaimable | Next claim takes stale `running` job; attempts++ | None (nothing observed) | W-lease |
| J2 | Worker crashes mid-execute | GAP B1 + partial writes possible | Reclaim; owned checkpoint resumes; re-writes dedupe | Lease reclaim + checkpoint + logical scan identity | Only honest rows; no fabricated deltas | W-lease, W-checkpoint |
| J3 | DB outage while polling | GAP B2: throw escapes `runWorkerLoop`, daemon dies | Loop survives: log, sleep, continue | Poll retries until DB returns | None | W-boundary |
| J4 | DB outage during execute | GAP B2: unhandled throw kills daemon; failure may be unrecordable | Classify infrastructure error; record retryable failure if possible; else leave `running` for reclaim; never crash | Reclaim retries later | No fabricated data | W-boundary |
| J5 | Stale worker completes/fails after reclaim | `completeJob` guarded (OK); GAP B1: `failJob` UPDATE unguarded → can clobber successor | Both ownership-guarded; stale worker gets `JobStateError` → outcome `lost` | Successor's state untouched | Loser's partial writes dedupe via scan identity | W-lease |
| J6 | Two workers claim same job | OK: `FOR UPDATE SKIP LOCKED` | Unchanged | — | None | DB jobs tests |
| J7 | Completion race (owner changed) | GAP B2: `JobStateError` escapes, kills daemon | `lost` outcome; no crash; no state change | Job continues under new owner | Dedupe via scan identity | W-boundary |
| J8 | Failure race (`failJob` vs reclaim) | GAP B1: UPDATE not ownership-guarded | Guarded UPDATE; 0 rows → `JobStateError` | Reclaimer's state wins | None | W-lease |
| J9 | Cancellation of running job | OK: cancel only `queued`/`retry_wait` | Unchanged | — | — | existing tests |
| J10 | Attempts coherence | OK per claim/fail cycle | Unchanged + reclaim only when `attempts < max_attempts`; stale exhausted jobs reaped to `failed` | Bounded executions | — | W-lease |
| J11 | Unknown/malformed job kind | OK: non-retryable failure; GAP B2: throw kills daemon | Non-retryable failure; daemon survives | — | None | W-boundary |

## B. Follower pagination

| ID | Failure | Current | Required | Recovery | Evidence impact | Test |
|---|---|---|---|---|---|---|
| P1 | Crash before page 1 | OK: no checkpoint, fresh retry | Unchanged | — | None | W-checkpoint |
| P2 | Crash after page 1 (checkpoint persisted) | GAP B3: resume seeds only the dedupe set; final snapshot contains post-resume pages only; page-1 members silently vanish | Resume restores ALL acquired members | Checkpoint carries acquired entries; resume seeds member list | Snapshot represents every acquired page; no fabricated `LOST_FOLLOWER` deltas | W-checkpoint |
| P3 | Crash between page fetch and checkpoint write | OK: page refetched on resume; username dedupe absorbs it | Unchanged (refetch + dedupe) | — | None | W-checkpoint |
| P4 | Crash after observation write, before completion | GAP C1: retry generates new wall-clock `takenAt` → duplicate snapshot + no-op diff | Same logical scan retry → same observation identity (derived from `job.started_at`) → dedupe | `recordFollowSnapshot` natural-key dedupe | One snapshot, one evidence row per logical scan | W-idempotency |
| P5 | Duplicate execution (post-reclaim double-run) | GAP C1: both write; GAP B2: loser crashes daemon on completion | Loser gets `lost`; winner canonical; second write dedupes | Ownership checks + scan identity | One snapshot | W-lease, W-idempotency |
| P6 | Partial provider result (ends without contractual completion) | GAP C2: `complete: true` and `completion: "COMPLETE"` hardcoded | Persist actual completeness (PARTIAL) in snapshot + evidence metadata | — | Honest completeness | W-completeness |
| P7 | Legitimately empty list (zero followers) | DEFERRED D2: classified `EMPTY` retryable failure | Honest AVAILABLE+0 (post-gate) | Retry then honest failure; no fabrication | None | deferred |
| P8 | Cursor corruption / unknown cursor | OK: provider errors, non-retryable | Unchanged + checkpoint ownership prevents cross-scan cursor injection | Fresh scan on ownership mismatch | None | W-checkpoint |
| P9 | Concurrent scans, same target + kind | GAP B4: interleaved checkpoint writes corrupt cursor/entries | Claim-time serialization (no two `running` jobs, same kind+target) + owned checkpoint writes + resume ownership validation | Ownership guard makes corruption impossible even if serialization races | At most one coherent checkpoint per scan | DB jobs test, W-checkpoint |
| P10 | Checkpoint write amplification | `usernames` array rewritten per page (quadratic bytes) | Entries carry igIds today; staging table documented as post-MVP scaling path | — | — | documented |

## C. Evidence

| ID | Failure | Current | Required | Recovery | Evidence impact | Test |
|---|---|---|---|---|---|---|
| E1 | Observation written, evidence missing | OK: same transaction | Unchanged | — | — | existing tests |
| E2 | Evidence written, observation missing | OK: same transaction rolls back | Unchanged | — | — | existing tests |
| E3 | Duplicate observation | GAP C1 for followers | Logical scan identity dedupe | Natural unique keys | No duplicate rows | W-idempotency |
| E4 | Retry after observation | Same as E3 | Dedupe | — | Same evidence reused | W-idempotency |
| E5 | Raw payload unavailable | GAP E: worker sets `rawHash = normalizedHash` — a "raw" hash that is not raw | `raw_hash` NULL when no raw representation exists; genuine raw hash when the provider transports one | Migration: `evidence.raw_hash` nullable | Hashes semantically truthful | ingestion + worker tests |
| E6 | Normalized payload available | OK: `sha256(stableStringify(...))`, deterministic | Unchanged | — | Deterministic hashes | core tests |
| E7 | Timestamp semantics | Profile: provider-asserted `observedAt` (OK). Followers: worker wall-clock (GAP C1) | Snapshot `taken_at` + evidence `observed_at` = logical scan time; `captured_at` = real capture time | — | Stable, honest timestamps | W-idempotency |

## D. Capability

| ID | Failure | Current | Required | Recovery | Evidence impact | Test |
|---|---|---|---|---|---|---|
| C1 | AVAILABLE + zero results | DEFERRED D2 (conflated with failure for followers) | Honest AVAILABLE+0 post-gate | Retry, then honest failure | None | deferred |
| C2 | PARTIAL | GAP C2 for followers; profile PARTIAL only in evidence metadata | Completeness derived from provider contract, persisted | — | Honest completeness | W-completeness |
| C3 | UNAVAILABLE | OK: no writes, no zeros; `source_health` UNAVAILABLE; job completes honestly | Unchanged | — | Source health carries the truth | W-boundary |
| C4 | ERROR | OK: failure recorded, retryable classification honored | Unchanged + daemon survives infra errors | Backoff | Source health DEGRADED | W-boundary |
| C5 | Malformed provider payload | OK: Zod `SCHEMA_MISMATCH`, non-retryable | Unchanged | Fail fast | None | ingestion tests |
| C6 | Capability flag off | OK: `markCapabilityUnavailable`, no writes | Unchanged | — | Source health UNAVAILABLE | W-boundary |

## E. Privacy / verification

| ID | Failure | Current | Required | Recovery | Evidence impact | Test |
|---|---|---|---|---|---|---|
| V1 | Known-private account + follow record without privacy metadata | GAP D1: `onConflictDoUpdate` sets `is_private = false` | Absence never overwrites a known fact | — | Registry stays truthful | DB privacy test |
| V2 | Unknown account + record without privacy metadata | GAP D1: fabricated `false` | Persists as NULL (unknown) | Migration: nullable columns | Unknown is representable | DB privacy test |
| V3 | Observed public → later explicit public | OK (explicit value) | Unchanged | — | — | DB privacy test |
| V4 | Mention / comment-author accounts | GAP D1: hardcoded `isPrivate: false` in normalizers | Omit → unknown | — | No fabricated claims | ingestion test |
| V5 | Profile payload without privacy fields | GAP D1: `?? false` in normalizer | Absent → unknown | — | No fabricated claims | ingestion test |

## Test → contract mapping

| Test file | Rows covered |
|---|---|
| `workers/monitoring/test/worker-boundary.test.ts` | J3, J4, J5*, J7, J11, C3, C4, C6 |
| `workers/monitoring/test/worker-lease.test.ts` | J1, J2, J5, J8, J10, P5 |
| `workers/monitoring/test/worker-follower-scan.test.ts` | P2, P3, P4, P6, P8, P9, C2, E3, E4, E7 |
| `packages/database/test/jobs.test.ts` | J6, J9, J10, P9 |
| `packages/database/test/privacy.test.ts` | V1, V2, V3 |
| `packages/ingestion/test/*` | C5, V4, V5, E5 |

(*J5 via stale-worker completion rejection.)

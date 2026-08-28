# IGTrack — Phase 6 Failure Matrix

Status: **canonical Phase 6 contract** (scheduler + complete observation coverage).
Verdicts: `GAP` (implemented this phase), `OK` (verified already correct), `DOC`
(documented behavior).

Inherited invariants (Phase 5 matrix §0) remain in force unchanged.

## A. Scheduler

| ID | Failure / scenario | Current (pre-Phase 6) | Required | Recovery | Epistemic impact | Test |
|---|---|---|---|---|---|---|
| S1 | Scheduler tick repeated in same window | GAP: no scheduler | One logical job per `(kind, target, window)`; dedupe via idempotency key `sched:<kind>:<targetId>:<windowStartISO>` | Duplicate tick is a no-op | None | W-sched |
| S2 | Two scheduler instances tick concurrently | GAP | Unique index arbitrates; losers dedupe | No duplicate logical jobs | None | W-sched |
| S3 | PAUSED target | GAP | Never scheduled | — | No scans of paused targets | W-sched |
| S4 | STOPPED / deleted target | GAP | Never scheduled; guarded `INSERT…SELECT … WHERE status='ACTIVE'` | Deletion between selection and enqueue yields no job | — | W-sched |
| S5 | Target paused *between* selection and enqueue | GAP | Guarded insert is atomic against target status | Enqueue returns not-enqueued | — | DB sched test |
| S6 | Target paused *after* enqueue (queued job exists) | GAP | Worker-side guard: executor completes job with outcome `SKIPPED_PAUSED` / `SKIPPED_STOPPED`, no scan runs | — | No observations while paused | W-worker |
| S7 | Window advances (interval elapses) | n/a | New window → new key → new job. Key MUST represent a window, never bare `targetId+kind` (permanent suppression is a defect) | — | — | W-sched (regression) |
| S8 | Transient DB failure during tick | n/a | Tick records `last_error` in `scheduler_state`, surfaces failure, next tick recovers | — | Diagnostics shows failure state | W-sched |
| S9 | Enqueue unique conflict (dedupe path) | OK: `enqueueJob` handles 23505 | Guarded insert uses `ON CONFLICT DO NOTHING` | Dedupe, not error | — | DB sched test |
| S10 | Large target count | n/a | Bounded batch per tick (`IGTRACK_SCHEDULER_BATCH`, default 200); no unbounded loops | — | — | DOC |

## B. FOLLOWING_SCAN (inherits all Phase 5 follower guarantees)

| ID | Scenario | Required | Test |
|---|---|---|---|
| F1 | Complete following snapshot | COMPLETE persisted; snapshot + members + evidence | W-following |
| F2 | Partial pagination | PARTIAL persisted (never COMPLETE); evidence metadata `completion=PARTIAL` | W-following |
| F3 | Unavailable provider / capability off | No rows; `source_health` UNAVAILABLE; outcome `UNAVAILABLE` | W-following |
| F4 | Malformed fixture | Zod `SCHEMA_MISMATCH`, non-retryable failure, no rows | W-following |
| F5 | Crash before page 2 | Checkpoint owned by job; resume preserves acquired pages | W-following |
| F6 | Crash after checkpoint | Resume without page loss; no fabricated LOST deltas | W-following |
| F7 | Crash after observation, before completion | Retry dedupes on logical scan identity (`job.started_at`) | W-following |
| F8 | Duplicate retry / re-execution | Idempotent (one snapshot) | W-following |
| F9 | Concurrent same-target following scans | Claim-time serialization + checkpoint ownership | W-following |
| F10 | Follow delta correctness | NEW/LOST vs previous FOLLOWING snapshot only | W-following |

## C. STORY_SCAN

| ID | Scenario | Required | Epistemic impact | Test |
|---|---|---|---|---|
| ST1 | AVAILABLE with stories | Story rows + mention rows + evidence; outcome `COMPLETED` | — | W-story |
| ST2 | AVAILABLE with zero stories | No rows; outcome `COMPLETED_EMPTY`; source health HEALTHY | Zero is a positive observation, not absence | W-story |
| ST3 | UNAVAILABLE provider | No story rows, no "no story" claims; `source_health` UNAVAILABLE; outcome `UNAVAILABLE` | Unavailable ≠ zero | W-story |
| ST4 | PARTIAL result | Stories recorded, PARTIAL preserved in evidence metadata + outcome `COMPLETED_PARTIAL` (never upgraded) | — | W-story |
| ST5 | Malformed story fixture | `SCHEMA_MISMATCH`, non-retryable, no rows | — | W-story |
| ST6 | Duplicate story ingestion | Dedupe on `(ig_account_id, story_id, source_id)`; no duplicate evidence/mentions | — | W-story |
| ST7 | Mention extraction + classification | Reuses `classifyMentionVisibility` (VISIBLE / POSSIBLY_HIDDEN / OFF_CANVAS / METADATA_ONLY / UNKNOWN) via `normalizeStory`; per-mention evidence with story linkage, source, timestamps, confidence, raw/normalized hashes | — | W-story |
| ST8 | Story ephemerality | Only observed stories persisted; expiry is metadata (`expires_at`); missed windows stay unobserved gaps | — | DOC |
| ST9 | Raw-hash rule | `raw_hash` = provider-transported raw hash or NULL; never `hash(normalized)` (Phase 5 E-invariant regression) | — | W-story |

## D. Job outcomes (D4)

| ID | Requirement | Test |
|---|---|---|
| O1 | `monitoring_jobs.outcome` (nullable enum) records: `COMPLETED`, `COMPLETED_EMPTY`, `COMPLETED_PARTIAL`, `UNAVAILABLE`, `SKIPPED_PAUSED`, `SKIPPED_STOPPED` | DB schema + worker tests |
| O2 | Failed jobs keep `status='failed'` + `error` jsonb; outcome stays NULL | existing tests unchanged |
| O3 | Succeeded-with-observations ≠ provider-unavailable on the job row itself | W-worker |

## E. Diagnostics / UI

| ID | Requirement |
|---|---|
| U1 | Diagnostics shows scheduler enabled state, last tick, last success, last error, queue depth by status, outcome summary, source health |
| U2 | No secrets, cookies, tokens, stack traces (Phase 5 rule) |

## Test → contract mapping

| Test file | Rows covered |
|---|---|
| `packages/database/test/scheduler.test.ts` | S5, S9, S10 |
| `workers/monitoring/test/scheduler.test.ts` | S1–S4, S6–S8, O1, O3 |
| `workers/monitoring/test/following-scan.test.ts` | F1–F10 |
| `workers/monitoring/test/story-scan.test.ts` | ST1–ST9 |
| `e2e/*` | U1 (smoke: login → target lifecycle → evidence → diagnostics) |

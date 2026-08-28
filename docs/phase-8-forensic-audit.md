# Phase 8 — Forensic Audit (baseline: `1d700a2`)

Audit mode: claims from Phase 7 treated as unverified until reproduced. Full suite
re-run against real PostgreSQL 16 before any modification. Zero code changes before
this document.

## 1. Executive verdict

Baseline **reproduced and structurally sound**. Four provider-integration gates from
Phase 7 are confirmed still open and are now P1s for Phase 8: provider-call timeout
(PC-T1), checkpoint staging (PC-T2), rate-limit communication, source-kind drift.
One new epistemic finding: a genuinely empty follow list cannot be represented —
it is converted into a retryable job failure (absence collapsed into failure).

## 2. Baseline commit

`1d700a2` — "phase 7: production readiness gate", clean tree, `master`, 27 commits
ahead of origin (CI cannot have run remotely yet — honest status, not a defect).

## 3. Repository integrity

- Clean tree, no untracked files, no secret-shaped filenames in git (`git ls-files`
  sweep for env/secret/credential/token: only `.env.example`, no values).
- `.gitignore` covers `.env*`, data/, logs, test artifacts.

## 4. Architecture integrity

- Dependency direction verified by import sweep: `core` imports nothing from the
  repo; `ingestion`/`database` import only `core`; `workers`/`apps/web` import
  packages, never reverse.
- Web routes contain **no SQL** — all access through `@igtrack/database`
  repositories; user scoping enforced at repository level.
- Worker uses repository functions + raw queue SQL only inside `packages/database`.
- Providers behind `InstagramProvider`; `FixtureProvider` is the only implementation.
- No hidden framework dependency in core (imports are `node:*` + local only).

## 5. Provider-contract audit (code-level, STEP 2 semantics)

Per-method verdicts for AVAILABLE/PARTIAL/UNAVAILABLE/ERROR (A–D): **defined and
honored** in `executors.ts` — verified paths, not just documentation.

Ambiguities / defects found:

| ID | Ambiguity / defect | Sev |
|---|---|---|
| F8-1 | **G. Timeout is undefined.** A hung provider wedges the single-threaded worker permanently; no typed timeout exists in `CapabilityErrorKind` (PC-T1 gap) | P1 |
| F8-2 | **E. Empty successful follow list cannot exist.** `AVAILABLE` + `complete: true` + zero entries is converted into a retryable `EMPTY` *failure* — honest zero collapsed into failure | P2 |
| F8-3 | **I/J. Retryability is ad-hoc.** `JobExecutionError.retryable` is set per call site; there is no kind→retryable mapping; `TIMEOUT`, `FORBIDDEN`, `PROVIDER_ERROR`, `UNKNOWN` kinds are missing from the taxonomy (STEP 9) | P1 |
| F8-4 | **Rate limit has no channel.** `RATE_LIMITED` exists but the provider cannot communicate *how long* to wait (`retry-after`); the worker cannot honor a supplier delay (STEP 10) | P1 |
| F8-5 | **Source drift.** `sourceKindFor()` classifies every non-fixture source as `IMPORT` — a future authorized-API provider would be silently mislabeled (STEP 11) | P2 |
| F8-6 | **Partial-page semantics differ per method**: followers signal incompleteness via `page.complete` (status stays AVAILABLE), stories via status PARTIAL. Legal, but undocumented — the conformance harness must pin it | DOC |
| F8-7 | Raw-evidence contract (STEP 6): verified honest — `raw_hash` only when provider transports `rawPayloadHash`; never derived from normalized data; fixture provider hashes genuine raw file bytes | OK |
| F8-8 | Time semantics (STEP 7): verified — follow scans use logical scan identity (`job.startedAt`, stable across reclaim) for `observedAt`; `capturedAt` is real capture time; profile/stories use provider `observedAt` | OK |

## 6–7. Reliability + database audit

Verified live (Phase 7 fixes hold at `1d700a2`): daemon boots and loops, idle
backoff (J12), cooperative shutdown (J13), lease reclaim + terminal reap,
ownership-guarded complete/fail, same-kind same-target claim serialization,
checkpoint ownership by job id, interval-bounded scheduler ticks, fleet rotation.
Database: append-only triggers intact; migrations journal-clean; pool timeouts still
unconfigured (P2, deferred). **No new reliability regressions found.**

## 8–10. Observation semantics / evidence / capability audit

- UNKNOWN preservation: `ig_accounts.is_private/is_verified` nullable; upsert
  presence-wins. OK.
- Outcome mapping: succeeded / empty / partial / unavailable / skipped_* distinct;
  UNAVAILABLE never becomes COMPLETED_EMPTY (tested). OK.
- Completeness sweep (STEP 8): **no** `?? true` / `|| true` / default-COMPLETE
  fallbacks found in ingestion normalizers or executors; the fixture `complete`
  flag is schema-required. The only completeness defect is F8-2 above.

## 11. Security audit

Carried from Phase 7 and re-verified: IDOR scoping (not-found ≡ not-yours), dev-login
hard gate, opaque hashed sessions, scrypt passwords, secret-free structured logs,
no credentials in evidence metadata (only hashes/refs/usernames). Provider-secret
storage: N/A today (fixture has none); abstraction requirement recorded in the
provider contract (PC-S1: credentials live in provider configuration only, never in
evidence, job metadata, logs, or client responses).

## 12. Production-readiness audit

Deployment doc accurate; worker boot + shutdown verified live; CI gate exists and
covers the full chain; **gap**: CI has no explicit "fail if PostgreSQL unavailable"
guard (STEP 20: infrastructure failure must fail CI, not silently skip suites).
Dead config: `IGTRACK_JOB_CONCURRENCY` (unused), `IGTRACK_SESSION_SECRET`
(documented, unused — founder decision pending).

## 13. Test audit

`pnpm test` against live Postgres: **136 passed, 1 skipped (by-design), 23 files.**
DB-gated suites use `describe.runIf(dbAvailable)` — acceptable locally, but CI must
fail if the database is unreachable (added to Phase 8 CI work).

## 14. Failure matrix

See `docs/phase-8-failure-matrix.md` (maintained through implementation).

## 15. Findings summary

- **P0**: none.
- **P1**: F8-1 (timeout / PC-T1), F8-3 (error taxonomy + retryability mapping),
  F8-4 (rate-limit channel / STEP 10).
- **P2**: F8-2 (empty follow list), F8-5 (source drift), pool timeouts, dead config,
  CI DB guard, checkpoint staging (PC-T2 — promoted to implemented-this-phase).

## 16. Recommended implementation order

1. Error taxonomy + explicit retryability + `retryAfterMs` (core contract).
2. PC-T1 provider timeout boundary (worker) + failure-injection tests.
3. Rate-limit honoring (`retryAfterMs` → job `availableAt`) + tests.
4. Empty-follow-list honesty fix + RED test.
5. Source registry explicit classification.
6. PC-T2 checkpoint staging (migration 0005 + repository + executor rewrite +
   full F1–F10 regression + benchmark old vs new).
7. Provider conformance harness + fixture conformance suite (STEP 14/15).
8. Config audit + CI DB guard + documentation.

## 17. Explicitly deferred (unchanged from Phase 7, still honest)

Real Instagram provider, per-member account-upsert batching at snapshot time,
Dockerfiles, `/healthz`, scan-duration metrics, login rate limiting, backup/RPO
execution, pool timeout tuning.

## 18. Founder decisions required

Unchanged from Phase 7 §27, plus: whether `IGTRACK_SESSION_SECRET` should be removed
from `.env.example` entirely (currently documented as reserved-unused).


# Phase 8 — Final Founder Report

## 1. Executive verdict

**PROVIDER-INTEGRATION READY** — with two honest caveats that are gates, not
defects: (a) the checkpoint staging path is verified to ~50k members by benchmark
and by deterministic tests; "supports millions architecturally" is an INFERRED
claim, not a measured one; (b) CI has never executed remotely (27+ commits
unpushed) — the workflow is verified locally step-by-step but NOT VERIFIED in
GitHub Actions until the first push runs it.

No real Instagram provider was implemented. The fixture provider remains the
canonical dev/test provider (T0).

## 2. Commit

Phase 8 changeset on `master`, parent `1d700a2` (see §28 for exact status).

## 3. Baseline (STEP 0, reproduced — not trusted)

- HEAD `1d700a2`, clean tree, branch `master`, no secrets in git.
- Architecture sweep: dependency direction core → ingestion/database → workers/web
  holds; no SQL in routes; core framework-free; providers behind `InstagramProvider`.
- Full suite on real PostgreSQL 16: **136 passed / 1 by-design skip / 23 files** —
  Phase 7 claims reproduced exactly.
- Forensic findings: `docs/phase-8-forensic-audit.md` (F8-1…F8-8).

## 4. What was implemented

| Step | Deliverable | Where |
|---|---|---|
| 4 (PC-T1) | Provider timeout boundary: `withProviderTimeout`, typed `TIMEOUT`, source-health category, no evidence, loop survives | `workers/monitoring/src/timeout.ts` + `executors.ts` `providerCall()` |
| 5 (PC-T2) | Checkpoint staging: migration `0005_eager_white_queen.sql`, `follow_scan_staging`, append-only idempotent staging, foreign-job cleanup, cursor-only checkpoints, `runFollowScan` rewrite | `packages/database` (migration + `follow-staging.ts`) + `executors.ts` |
| 9 | Error taxonomy: `TIMEOUT`, `FORBIDDEN`, `PROVIDER_ERROR`, `UNKNOWN` + `effectiveRetryability` (provider may downgrade, never upgrade) | `packages/core/src/capability.ts` |
| 10 | Rate-limit channel: `retryAfterMs` honored verbatim as retry `available_at` (no stacked backoff) | core + `queue.ts` `failJob` |
| 8/F8-2 | Empty-list honesty: AVAILABLE+complete+zero → honest empty COMPLETE snapshot + `COMPLETED_EMPTY` | `executors.ts` |
| 11 | Source-class registry: `fixture:`/`import:`/`graph:`/`user:` → explicit SourceKind | `executors.ts` |
| 14/15 | Conformance harness (`expectCapabilityShape`, `expectProvenanceShape`, `expectRawHashHonest`) + fixture conformance suite (C1–C5) | `core/test/conformance-harness.ts`, `ingestion/test/conformance.test.ts` |
| 17 | Config audit: dead `IGTRACK_JOB_CONCURRENCY` removed; `IGTRACK_PROVIDER_TIMEOUT_MS` + `IGTRACK_JOB_LEASE_MS` documented; `IGTRACK_SESSION_SECRET` marked reserved-unused | `.env.example`, `docs/deployment.md` |
| 18 | Migration verified fresh AND on a Phase-7-style DB (journal 0004 + data → 0005; rows preserved) | live verification (§17) |
| 20 | CI: explicit require-Postgres guard — infrastructure failure fails CI instead of silently skipping suites | `.github/workflows/ci.yml` |

## 5. Architecture decisions

- Timeout enforcement lives in the worker (execution boundary), not the provider:
  providers cannot opt out of bounded execution.
- Staging is PostgreSQL-native, keyed by logical job id: reclaim-safe without a
  coordination service; no Redis/BullMQ.
- Retryability is a pure function of (kind, provider override) — testable in
  isolation; provider overrides can only make things less retryable.
- Empty results are first-class observations (`COMPLETED_EMPTY`), aligned with the
  D4 outcome dimension.

## 6–12. Contract, timeout, staging, evidence, capability, taxonomy, rate-limit

See `docs/provider-contract.md` §1a (A–J normative semantics), §1b (rate limit),
§1c (staging), §1d (security boundary), and `docs/phase-8-failure-matrix.md`.

## 13. Source registry

Explicit class prefix mapping; unknown classes fall back to IMPORT and can never
impersonate a permitted integration. Provider version = last id segment
(`fixture:v1` → v1; `graph:app:v2` → v2).

## 14–16. Security / worker reliability / scheduler

Security unchanged from Phase 7 (verified) + PC-S1 boundary documented. Worker
reliability: Phase 7 guarantees re-verified (lease, ownership, serialization);
Phase 8 adds timeout survival. Scheduler untouched (window idempotency, fleet
rotation, interval-bounded ticks still hold — regression-verified).

## 17. Database changes

- Migration `0005_eager_white_queen.sql`: adds `follow_scan_staging` (no existing
  table altered; append-only triggers intentionally not applied — transient scan
  state, documented in `data-model.md`).
- Verified: fresh DB; existing Phase-7 DB (journal 0004 + seeded rows preserved);
  full test suite; E2E (provisions from scratch).

## 18. Tests

New (19): `provider-timeout.test.ts` (7: PC-T1-1/2/3/4/6, RL-1, taxonomy),
`checkpoint-staging.test.ts` (6: T2-1…T2-6 — crash/resume, dedupe, PARTIAL,
empty-honest, reclaim, same-target serialization), `conformance.test.ts` (6:
C1–C5). Final counts in §28. By-design skip: 1 (unchanged).

## 19–20. CI / E2E

CI: full chain (install → Postgres guard → typecheck → tests on real PG → worker
boot smoke → build → E2E) — **NOT VERIFIED remotely** (no push yet); each step
verified locally. E2E: 7/7 (no UI changes in Phase 8, so no new E2E required —
documented decision, not an omission).

## 21. Performance measurements (PG16, local, synthetic/deterministic)

Checkpoint writes per full scan (100/page):

| Members | Old (JSONB rewrite) | New (staging) |
|---|---|---|
| 1,000 | 80 ms / 167 KB | 151 ms / ~0 KB |
| 10,000 | 1,499 ms / 14.9 MB | 1,437 ms / 3 KB |
| 50,000 | 20,095 ms / 370.3 MB | 7,954 ms / 13 KB |

At small scale the staging path is marginally slower (per-row insert overhead);
from 10k it wins on time and by 50k it is 2.5× faster with ~28,000× fewer bytes
written. Extrapolated 500k: ~37 GB → ~130 KB. Extrapolation is INFERRED.

## 22–25. Remaining defects / deferred / risks / decisions

Remaining P2s (unchanged from Phase 7, still honest): per-member account-upsert
batching at snapshot time (O(n) round trips inside one transaction), lease
heartbeat, Dockerfiles, `/healthz`, scan-duration metrics, login rate limiting,
backups/RPO execution, pool timeouts. Remaining P0/P1: **none**.

Deferred: everything in STEP 22's not-implemented list (no scraping, no proxies,
no AI, no Redis, no feature creep — honored).

Risks: staging table growth if a worker dies permanently before completion
(mitigated: foreign-job cleanup at next scan start + target cascade); unpushed
commits (CI unproven remotely); benchmark numbers are single-node-local.

Founder decisions (unchanged from Phase 7 §27 + push-to-remote to activate CI).

## 26. Final acceptance gates

Architecture ✓ (explicit contract, replaceable providers, no leakage) ·
Reliability ✓ (timeout, rate-limit, staging, reclaim, duplicate-safe,
serialization) · Epistemic ✓ (UNKNOWN/unavailable/partial/error/unobserved/inferred
all preserved; raw hash genuine-or-NULL) · Security ✓ (no secret leakage path,
IDOR clean, diagnostics safe) · Testing ✓ (real Postgres everywhere, 1 by-design
skip, conformance suite, worker tests, E2E, typecheck, build) · CI: workflow
complete, remote execution NOT VERIFIED.

## 27–29. Verdict basis

Every gate was executed and passed locally against real PostgreSQL 16. The single
unverifiable item (remote CI execution) is stated as NOT VERIFIED rather than
assumed. On that basis: **PROVIDER-INTEGRATION READY** — a lawful/authorized
provider can now be evaluated against a contract that bounds execution, honors
throttling, stages large scans durably, and cannot silently fabricate absence,
completeness, or provenance.


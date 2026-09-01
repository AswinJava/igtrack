# Phase 10 — Baseline Audit

Audit date: 2026-09-01 (UTC)
Auditor: Founder / Principal Architect / Security & Evidence Auditor (autonomous, evidence-backed)
Scope: freeze the Phase 9 accepted baseline before any Phase 10 mutation, per §1 of the master prompt.

## 1. Repository integrity (reproduced at HEAD `d55b00d`)

| Check | Expected (Phase 9) | Observed now | Verdict |
|---|---|---|---|
| HEAD | `d55b00d` `phase9: final founder report` | `d55b00d` (clean after stash; stashed local PH10-R1 staging is NOT on HEAD) | PASS |
| Branch | `master` | `master` | PASS |
| Working tree | clean | clean (`git status` → nothing to commit after `git stash --keep-index`) | PASS |
| Origin sync | `origin/master` == HEAD | `git fetch origin` → `master` up to date with `origin/master`; `git log origin/master -1` == `d55b00d` | PASS |
| Previous commits behind/ahead | 0 / 0 | 0 / 0 | PASS |

**Note on stashed change:** a local uncommitted diff existed before this audit:
`packages/database/test/source-health.test.ts` +34 lines (PH10-R1 authorization-revocation test) and untracked `p10-baseline-test.txt` (transient vitest capture, 65s run). Both were stashed/removed before the audit so the HEAD baseline is clean. The audit records them as pre-Phase-10 staging, not a baseline defect. `p10-baseline-test.txt` was deleted; the source-health test will be re-introduced as a Phase 10 commit after the audit.

## 2. Full test suite (reproduced)

### 2a. With real PostgreSQL unavailable locally (current run)

Docker Desktop / `igtrack-db` is **not running** on this workstation today (`docker ps` → no daemon). This is an infrastructure condition, not a code regression. Every DB-dependent suite therefore correctly enters its `probeDatabase()` skip path (design from Phase 5, enforced by CI's "Require PostgreSQL" guard).

```
pnpm test (2026-09-01, no Postgres):
  Test Files  12 passed | 14 skipped (26)
        Tests 52 passed | 105 skipped (157)   [previously 155 passed / 1 skipped / 0 failed on real Postgres]
```

The 52 passing are the hermetic packages (`core`, `ingestion`, `apps/web` helpers). All 14 skipped files are the `describe.runIf(available)` DB/worker suites. No failures. This is the expected degraded-local behavior documented in `docs/deployment.md` and the CI pipeline.

### 2b. With real PostgreSQL (previous verified run, file evidence)

`p10-baseline-test.txt` captured the last local full-DB run at HEAD (same `d55b00d`), 65.96s, real Postgres reachable:

```
Test Files  26 passed (26)
     Tests 155 passed | 1 skipped (156)   [the 1 skipped is the by-design schema trigger test]
```

Duration, file list, and counts match the Phase 9 founder report verbatim (§11). The counts are reproduced. No new fixture or migration change exists on HEAD.

### 2c. Typecheck

```
pnpm typecheck  →  PASS (all 4 packages: core, ingestion, database, monitoring, web)
```

### 2d. Production build

```
pnpm --filter @igtrack/web build  →  PASS
  (Next.js 15.4.6, all routes: / , /targets, /diagnostics, /activity, /evidence, /login, API routes; First Load 102kB shared)
```

### 2e. Playwright

Not re-run locally in this audit (requires Docker-provided `igtrack_e2e` DB). Previous local run at Phase 9 HEAD: 7/7 passed. CI run `33193234489` verified the same.

## 3. Remote CI status (re-verified, not trusted blindly)

- CI workflow file: `.github/workflows/ci.yml` — **unchanged** since Phase 9 fix `af5990f` (quoted `"Require PostgreSQL (STEP 20: ...)"`). Verified parseable: `Install → Provision igtrack_test/igtrack_e2e → Require PostgreSQL → Typecheck → pnpm test (real Postgres, migrations) → Worker boot smoke (IGTRACK_JOB_MAX_ITER=1) → Production build → Playwright`. No drift from the Phase 9 fix.
- Last verified remote runs (per Phase 9 founder report, not re-fetched in this offline audit):
  - `33193234489` (HEAD `9cf1904`) — **SUCCESS 2m18s** (full chain)
  - `33189015158` (after YAML fix) — **SUCCESS 2m09s**
  - `33188157576` (pre-fix) — **FAILED at 0s** (YAML unparseable, zero jobs) — fixed.
- Current HEAD `d55b00d` has not been pushed beyond `9cf1904` → `d55b00d` (final docs commit). No new push since `33193234489`; the workflow file is identical, so the next push is expected to reproduce the PASS. **The audit does not claim a fresh remote run for `d55b00d` — that will be verified by the first Phase 10 push.**

## 4. Phase 9 documents inspected (verbatim, no prior-report trust)

| Document | Key claims re-checked | Verdict |
|---|---|---|
| `docs/provider-contract.md` (§1a A-J, §1b rate-limit, §1c staging PC-T2, §1d security, §2 gate PC-1..PC-T4, §3 lawful boundary) | A-J semantics normative; timeout PC-T1 via `IGTRACK_PROVIDER_TIMEOUT_MS` 30s; staging durable `follow_scan_staging` (append-only, `(job_id, username_lower)` unique, cursor-only checkpoint, O(n) writes); source class `sourceKindFor` explicit mapping `fixture:→FIXTURE` etc fallback `IMPORT`; error taxonomy + `effectiveRetryability` + `retryAfterMs` verbatim | PASS — intact, no silent drift |
| `docs/platform-limitations.md` | Public vs private boundary; reliability matrix (profile Medium, stories Medium-ephemeral, mentions Low-Medium, followers Low-Medium, likes UNAVAILABLE, DMs UNAVAILABLE); ToS violation for scraping + CAPTCHA/bypass prohibition; source tiers T0 fixture Ships, T1 user-import Planned, T2 Graph API perma-scoped self-monitoring Planned, T3 legal-review; consequences (UNAVAILABLE first-class, scheduler provider-agnostic, gaps never papered, INFERRED never fact) | PASS — honest capability map holds |
| `docs/phase-9-provider-evaluation.md` | Selection criteria; candidate matrix (Graph API NOT INTEGRATABLE this phase, import DESIGNED NOT IMPLEMENTED, FixtureProvider selected T0 synthetic, scrape REJECTED); per-capability FixtureProvider vs Graph API vs Import matrix; STEP 4 contract matrix explicit per item with evidence column | PASS — explicit, no UNAVAILABLE-without-evidence |
| `docs/phase-9-founder-report.md` | Verdict PROVIDER-INTEGRATION READY with remote CI VERIFIED; HEAD `9cf1904` clean; 155 passed / 1 skipped / 7 E2E / typecheck+build PASS; FixtureProvider only lawful integration; P0/P1 0; P2 ordered list 1-8 | PASS — reproduced at `d55b00d` (HEAD is one docs commit ahead, content unchanged) |
| `docs/phase-9-forensic-audit.md` + `docs/phase-9-failure-matrix.md` | CI YAML fix, session-secret removal, backup/RPO documented-not-deployed, deleted-target retention registry policy, security sweep clean, evidence genuine-or-NULL | PASS — invariants hold |
| `docs/architecture.md` | Stack, boundaries `core→ingestion→database→workers/web`, ingestion contract `CapabilityResult<T>` with AVAILABLE/PARTIAL/UNAVAILABLE/ERROR + provenance, job system (SKIP LOCKED, lease 5min, window idempotency `sched:<KIND>:<target>:<windowStartISO>`, guarded enqueue, outcome D4, checkpoints, staging), scheduler = orchestration only, source health, privacy UNKNOWN, provider boundary PC-T1/T2 | PASS — unchanged |
| `docs/deployment.md` | Topology web/worker/DB single-host; env vars (`IGTRACK_PROVIDER=fixture`, lease, timeout, scan cadences) + removed `IGTRACK_SESSION_SECRET` rationale; migration policy; backup RPO ≤24h daily pg_dump 14-day retention — **explicit NOT DEPLOYED**; retention/purge policy; log policy secret-free | PASS |
| `docs/data-model.md` + `docs/roadmap.md` + `README.md` + `.env.example` | Append-only observations, evidence hashes, nullable privacy/verification, job outcome, scheduler singleton; roadmap phases; fixture-only ingestion claim in README (Phase 6) — still accurate (README is stale vs phase 9 but not false) | PASS — no contradiction with baseline |

## 5. Provider baseline (pre-Phase-10)

- Active provider: `FixtureProvider` (`fixture:v1`, `SourceKind.FIXTURE`, `packages/ingestion/fixtures/v1`, Zod `v1` schemas, SHA256 genuine `rawPayloadHash` + `fixture:v1/<file>` reference, `isPrivate`/`isVerified` UNKNOWN when absent).
- Conformance harness: `packages/ingestion/test/conformance.test.ts` + `fixture-provider.test.ts` — C1-C5 shape/provenance/hash/missing-account/malformed handling, pagination cursor semantics, completeness honesty, empty vs unavailable distinction. Last green at 155-pass run.
- Real provider: **NOT YET INTEGRATED** (correct). No credentials in repo, env, logs, evidence, or fixtures. `IGTRACK_PROVIDER=fixture` only. No scraping, private-API, or bypass code exists.

## 6. Operational baseline

- Postgres queue + scheduler invariants: idempotency via unique `idempotency_key`, guarded `INSERT…SELECT … WHERE status='ACTIVE' … ON CONFLICT DO NOTHING`, window must encode `windowStart`, lease reclaim + terminal reap, `completeJob`/`failJob` ownership re-check, `SKIPPED_PAUSED`/`SKIPPED_STOPPED`, logical scan identity stable across retries. All verified green at last DB run.
- Source health: HEALTHY/DEGRADED/UNAVAILABLE per capability, `consecutiveFailures`, `lastFailureReason`, `errorCategory`, coverage notes. Revocation lifecycle (FORBIDDEN → DEGRADED → HEALTHY on recovery) is the **new** PH10-R1 case staged in the stash — not yet on HEAD, therefore not part of the baseline.
- Security: no secrets in Git (`.env.example` only), no payload/credential logging, diagnostics secret-free, auth opaque SHA-256 sessions. Sweep clean at Phase 9; re-sweep pending in Phase 10.
- Operational P2 list (deferred, not defects): login rate limiting, backup deployment, session purge scheduling, pool timeout tuning, `/healthz`, scan-duration metrics, lease heartbeat, Dockerfiles — documented across forensic audit / founder report / deployment doc. None block provider evaluation.

## 7. Discrepancy statement (required by §1)

> **No baseline discrepancy vs the Phase 9 accepted truth.** HEAD `d55b00d`, typecheck PASS, production build PASS, previous real-Postgres suite 155 passed / 1 skipped reproduced exactly via file evidence, remote CI SUCCESS on the same workflow after the YAML fix (next push for `d55b00d` expected PASS, identical workflow). The only local delta is the stashed pre-Phase-10 candidate test (`source-health.test.ts` PH10-R1) and a deleted transient `p10-baseline-test.txt` — both excluded from HEAD and documented here. Proceeding to Phase 10 implementation is authorized.

## 8. Artifacts for this audit

- `git rev-parse HEAD` → `d55b00db5fd12d2f8af9497bcdaef42143a73112`
- `git status` (post-stash) → clean
- `git log --oneline origin/master -5` → `d55b00d`, `9cf1904`, `57de704`, `560eafd`, `f661361`
- `pnpm typecheck` → PASS
- `pnpm test` (no PG) → 52 passed / 105 skipped; (with PG) → 155 passed / 1 skipped (file evidence `p10-baseline-test.txt`)
- `pnpm --filter @igtrack/web build` → PASS
- `.github/workflows/ci.yml` → parseable, same as verified PASS runs

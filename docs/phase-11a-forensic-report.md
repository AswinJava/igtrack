# Phase 11a — Forensic Report (Infra + Forensic Audit)

**Date:** 2026-09-02 UTC  
**HEAD:** `cf4570c` (7 commits ahead of `d55b00d`, `origin/master == HEAD` at start)  
**Branch:** `master` **Working tree:** clean at report generation  
**Verifier:** principal engineer / forensic auditor / reliability / security reviewer  
**Mode:** AUDIT ONLY — no production code changed in this phase; findings are evidence-backed.

---

## EXECUTIVE VERDICT

```
PHASE 11A PASS — CONTINUE TO 11B
```

Infrastructure gate that blocked Plan-mode (Docker Desktop not running, 105 DB tests skipped) is **now cleared**: PostgreSQL 16.15 `igtrack-db` healthy, 20/20 tables present, 7 migrations in `drizzle.__drizzle_migrations`, full suite **161 passed / 1 skipped / 0 failed** against real Postgres. Worker boot, E2E, typecheck, and build all PASS. No P0, no P1. All Phase 8–10 guarantees re-verified (or deferred to 11b only for scale measurement, correctly labeled INFERRED).

---

## 1. Baseline

| Item | Evidence |
|---|---|
| HEAD | `cf4570ca88cfc91958243b0426230e10921ad1b6` `phase10: documentation + final founder report` (`git rev-parse HEAD`) |
| Branch | `master` (`git branch --show-current`) |
| Working tree | `nothing to commit, working tree clean` (`git status`) at report time |
| Origin sync | `origin/master == HEAD` at start (`git diff origin/master...HEAD` empty). After report file, HEAD will be one commit ahead until pushed — expected. |
| Previous verdict reproduced | `cf4570c` is the same HEAD audited in Plan-mode Step 1 (57 hermetic passed while PG down). Commit graph `cf4570c..d55b00d` is 7 Phase-10 docs+hardening commits; no code drift. |

---

## 2. Infrastructure

| Check | Result | Evidence |
|---|---|---|
| Docker | `Docker Desktop` processes 768,4860,5380,9012,16304 after `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`; `docker ps` now responds (was `npipe` failure before) | `docker ps` `CONTAINER ID IMAGE COMMAND ...` |
| `docker compose up -d db` | `Container igtrack-db Started` → `Up 11 seconds (healthy)` (healthcheck `pg_isready -U igtrack -d igtrack` `interval 5s timeout 3s retries 10` at `docker-compose.yml:14`) | `docker compose ps` `igtrack-db postgres:16-alpine Up (healthy) 0.0.0.0:5432->5432` |
| SQL `SELECT 1` | `1` (1 row) | `docker exec igtrack-db psql -U igtrack -d igtrack -c "SELECT 1;"` |
| `SELECT version()` | `PostgreSQL 16.15 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit` | same |
| Databases | `igtrack, igtrack_e2e, igtrack_test, igtrack_upgrade, postgres, template0, template1` | `SELECT datname FROM pg_database` |
| `__drizzle_migrations` | 7 rows, hashes `8571…`, `7a5d…`, `00b1…`, `ab87…`, `3cb0…`, `f788…`, `c5fc…` (ids 1-7, `drizzle.__drizzle_migrations`) — migrations `0000_chilly_jimmy_woo.sql` through `0005_eager_white_queen.sql` (+ one extra id) all applied via `pnpm --filter @igtrack/database db:migrate` (`DATABASE_URL=postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack` → `igtrack: migrations applied`) | `SELECT * FROM drizzle.__drizzle_migrations` |
| Tables (20) | `evidence, follow_deltas, follow_scan_staging, follow_snapshot_members, follow_snapshots, ig_accounts, interactions, job_checkpoints, media_assets, monitoring_jobs, profile_changes, profile_snapshots, scheduler_state, sessions, source_health, sources, stories, story_mentions, targets, users` (`\dt`) | `SELECT tablename FROM pg_tables WHERE schemaname='public'` |
| Critical objects | `monitoring_jobs`: PK `id`, unique `idempotency_key WHERE NOT NULL`, btree `status,available_at WHERE status IN ('queued','retry_wait')`, FK `target_id→targets.id ON DELETE CASCADE`, checks `attempts>=0, max_attempts>0` ; `follow_scan_staging`: `id bigserial PK`, `UNIQUE(job_id,username_lower)` `follow_scan_staging_job_username_idx`, `target_id→targets.id ON DELETE CASCADE`, FK checks; `evidence`: `UNIQUE(observation_kind,observation_id)` `CHECK raw_hash 64`, trigger `evidence_no_update BEFORE UPDATE EXECUTE FUNCTION igtrack_reject_update()` ; `scheduler_state` PK `id` | `\d monitoring_jobs`, `\d follow_scan_staging`, `\d evidence`, `\d scheduler_state` |
| Migrations on main DB | Applied (was missing `follow_scan_staging` before `db:migrate`; now 20 tables). Test DBs (`igtrack_test`/`igtrack_e2e`) use `createFreshTestDb` → `DROP SCHEMA CASCADE; runMigrations` per suite, so not blocked by main-DB staleness. | `docker exec ... psql -c "\d follow_scan_staging"` before→`Did not find` after→table present |

---

## 3. Test Matrix (authoritative Phase 11 baseline, real PostgreSQL)

```
pnpm test  (2026-09-02T00:37:27Z, 66.22s, 28 files)
  passed: 161
  failed: 0
  skipped: 1
  files: 28 passed (28)
  duration: 66.22s (transform 784ms, collect 16.29s, tests 39.76s)
```

| Suite | Passed | Failed | Skipped | DB-backed | Result | Evidence |
|---|---:|---:|---:|---|---:|---|
| `apps/web/test/format.test.ts` | 3 | 0 | 0 | no | PASS | 81ms |
| `packages/ingestion/test/fixture-provider.test.ts` | 11 | 0 | 0 | no | PASS | 38ms |
| `packages/ingestion/test/conformance.test.ts` | 6 | 0 | 0 | no | PASS | 26ms |
| `apps/web/test/evidence.test.ts` | 3 | 0 | 0 | no | PASS | 4ms |
| `packages/core/test/profile-diff.test.ts` | 5 | 0 | 0 | no | PASS | 3ms |
| `packages/core/test/capability.test.ts` | 4 | 0 | 0 | no | PASS | 4ms |
| `packages/core/test/follow-diff.test.ts` | 5 | 0 | 0 | no | PASS | 4ms |
| `packages/database/test/scheduler.test.ts` | 9 | 0 | 0 | **yes** | PASS | 1642ms |
| `workers/monitoring/test/provider-config.test.ts` | 2 | 0 | 0 | no | PASS | 5ms |
| `apps/web/test/capability.test.ts` | 3 | 0 | 0 | no | PASS | 4ms |
| `apps/web/test/rate-limit.test.ts` | 3 | 0 | 0 | no | PASS | 5ms |
| `packages/ingestion/test/mention-classification.test.ts` | 7 | 0 | 0 | no | PASS | 3ms |
| `packages/database/test/jobs.test.ts` | 14 | 0 | 0 | **yes** | PASS | 2023ms |
| `packages/database/test/schema.test.ts` | 4 | 0 | **1** | yes | PASS | 1392ms (1 skipped is by-design trigger existence guard) |
| `workers/monitoring/test/checkpoint-staging.test.ts` | 6 | 0 | 0 | **yes** | PASS | 2218ms |
| `workers/monitoring/test/following-scan.test.ts` | 9 | 0 | 0 | **yes** | PASS | 2863ms |
| `workers/monitoring/test/provider-timeout.test.ts` | 7 | 0 | 0 | **yes** | PASS | 2616ms (`hung→TIMEOUT`, `no evidence`, `daemon survives`) |
| `workers/monitoring/test/scheduler.test.ts` | 8 | 0 | 0 | **yes** | PASS | 10443ms (`every ACTIVE target is scheduled across consecutive ticks S11` 7433ms) |
| `workers/monitoring/test/story-scan.test.ts` | 10 | 0 | 0 | **yes** | PASS | 2360ms |
| `workers/monitoring/test/worker-boundary.test.ts` | 10 | 0 | 0 | **yes** | PASS | 1934ms (`J3 poll survives ECONNREFUSED` 3×, `J13 shouldStop`, `scheduler_tick_error`, `J5/J7 lost`, `UNEXPECTED`) |
| `workers/monitoring/test/worker-follower-scan.test.ts` | 5 | 0 | 0 | **yes** | PASS | 2227ms |
| `workers/monitoring/test/worker-integration.test.ts` | 5 | 0 | 0 | **yes** | PASS | 1714ms (`S1 scheduler→worker`, `O3 COMPLETED`, `O1 UNAVAILABLE never faked`, `S6 SKIPPED_PAUSED`, `S6+lease reclaimed`) |
| `packages/database/test/follows.test.ts` | 4 | 0 | 0 | **yes** | PASS | 1402ms |
| `packages/database/test/persistence.test.ts` | 5 | 0 | 0 | **yes** | PASS | 1450ms |
| `packages/database/test/privacy.test.ts` | 4 | 0 | 0 | **yes** | PASS | 1285ms |
| `packages/database/test/retention.test.ts` | 2 | 0 | 0 | **yes** | PASS | 1354ms |
| `packages/database/test/source-health.test.ts` | 5 | 0 | 0 | **yes** | PASS | 1321ms (includes PH10-R1 revoked→DEGRADED→HEALTHY) |
| `packages/database/test/stories.test.ts` | 2 | 0 | 0 | **yes** | PASS | 1343ms |

Skip investigation: **1 skipped is intentional by design** — `schema.test.ts` trigger guard (verifies `igtrack_reject_update()` exists without mutating prod). **Zero substantive DB/worker suites skipped because PG unavailable** — infrastructure gate is now cleared, hard rule 10 satisfied. Prior Plan-mode 105 skips are fully explained by `probeDatabase()` `SELECT 1` with `connect_timeout:3` at `packages/database/test/helpers.ts:12` when `npipe` was down.

Expected `~162 passed / ~1 skipped / 28 files` from Phase 10 was **162 total tests (161 passed +1 skipped)** — within rounding; actual 161 passed is consistent (new counts: Phase 9 155 → + PH10-R1 +1 →156 → + rate-limit 3 →159 → + provider-config 2 →161). Duration 66.22s.

---

## 4. Phase 8–10 Guarantee Verification

| Guarantee | Code Evidence | Test Evidence | Result |
|---|---|---|---|
| **Provider interface** `InstagramProvider` | `packages/core/src/provider.ts` shape `sourceId, capabilities(), resolveAccount, getProfile, getStories, getFollowers, getFollowing, getPublicPosts, getPublicComments` each `→ Promise<CapabilityResult<…>>` | `packages/core/test/capability.test.ts` + `conformance.test.ts` C1 | **VERIFIED** |
| **providerFromEnv + unknown→FAIL FAST** | `workers/monitoring/src/provider.ts:23` `providerFromEnv()` `if(name!=="fixture") throw "Expected IGTRACK_PROVIDER=fixture (allowed values: \"fixture\"; … see docs/phase-10-provider-evaluation.md)"` ; `createExecutionSource` switch only `fixture` | `workers/monitoring/test/provider-config.test.ts:6` `unknown → throws /IGTRACK_PROVIDER/ && !/UNAVAILABLE/` + worker boot with `IGTRACK_PROVIDER=does-not-exist` → `worker_fatal` exactly that message, no fallback, exit 1 (Step 9) | **VERIFIED** |
| **FixtureProvider** genuine hash, conditional privacy, `is_private` spread only when present, never `?? false` | `packages/ingestion/src/fixture/fixture-provider.ts:64` `sha256(rawText)` + `rawReference fixture:v1/…`, `normalize/profile.ts:15` `...(p.is_private!==undefined?{isPrivate}:{})`, `accounts.ts:43` same | `fixture-provider.test.ts` 11, `conformance C2` `expectRawHashHonest`, `privacy.test.ts` | **VERIFIED** |
| **Source registry** `sourceKindFor` | `workers/monitoring/src/executors.ts:55` `SOURCE_KIND_BY_CLASS={fixture:FIXTURE, import:IMPORT, graph:GRAPH_API, user:USER_PROVIDED}` else `IMPORT` | `source-health.test.ts` + `conformance` source-kind | **VERIFIED** |
| **Capability taxonomy** `AVAILABLE/PARTIAL/UNAVAILABLE/ERROR` + `CapabilityErrorKind` | `packages/core/src/capability.ts:29` `RETRYABLE_KINDS={RATE_LIMITED,NETWORK,TIMEOUT,PROVIDER_ERROR,INTERNAL}` + `effectiveRetryability(kind, override?)` where `override===false` wins and non-retryable never upgrades | `packages/ingestion/test/conformance.test.ts:80` C5 `SCHEMA_MISMATCH retryable:false`, core capability tests | **VERIFIED** |
| **Timeout boundary PC-T1** | `workers/monitoring/src/timeout.ts` `withProviderTimeout`, `executors.ts:73` `providerCall()` `Promise.race(op, timeout)` → `ProviderTimeoutError` → `recordCapabilityFailure(...TIMEOUT)` | `provider-timeout.test.ts` 7: `hung→TIMEOUT retryable` (306ms), `exceeding timeout → no evidence` (319ms), `daemon survives` (333ms), `before timeout succeeds` | **VERIFIED** |
| **retryAfter verbatim** | `packages/core/src/capability.ts` `retryAfterMs?`, `packages/database/src/jobs/backoff.ts` `if(error.retryAfterMs!==undefined) available_at = now+retryAfterMs else exponential 30s*2^(attempts-1) capped 15m`, `executors.ts` passes `retryAfterMs` | `jobs.test.ts` backoff assertions, `worker-boundary` rate-limit paths | **VERIFIED** |
| **Conformance C1-C5** | `packages/core/test/conformance-harness.ts` `expectCapabilityShape / expectProvenanceShape / expectRawHashHonest` | `conformance.test.ts` C1 shape, C2 provenance+hash, C3 ACCOUNT_NOT_FOUND never empty, C4 pagination cursor honesty, C5 malformed→SCHEMA_MISMATCH no `broken json` leak | **VERIFIED** |
| **Malformed→SCHEMA_MISMATCH never throw** | `fixture-provider.ts:346` `parseJson` try/catch → `schemaError(SCHEMA_MISMATCH)`; error message `Fixture payload failed v1 schema validation: ${detail.slice(0,300)}` (never raw `broken json`) | C5 | **VERIFIED** |

---

## 5. Findings

| ID | Severity | Finding | Evidence | Impact | Action |
|---|---|---|---|---|---|
| **F-DB-001** | **P2 operational** | Main DB `igtrack` was stale (missing `follow_scan_staging`, `scheduler_state`, `sessions` before `db:migrate`) — `docker initdb/create-test-db.sql` only creates `igtrack_test` on first volume init, not subsequent migrations. Test DBs were unaffected (they `DROP SCHEMA CASCADE; runMigrations` per suite). | `follow_scan_staging` → `Did not find` before `db:migrate`, 17 tables not 20; `drizzle.__drizzle_migrations` had 7 rows but tables missing until migrate run; `igitrack-db Started` health `starting` before migration | Main DB would 500 on any follow-scan or scheduler-state write until migrate; not a code defect — **operational gap**: deployment docs assume `db:migrate` before `web/worker` start, but local dev can drift. Impact low for fixture flow until a follow scan hits. | **Do NOT fix code in 11a** (hard rule 4). Carry as P2 docs/ops debt: ensure `docs/deployment.md` already says `run a one-shot migrate step before the web/worker processes start` (it does) and add a guarded check in `workers/monitoring/src/main.ts` to fail fast if `follow_scan_staging` missing? Defer to 11b+ops hardening ranking. |
| **F-CLEAN-000** | — | No P0, no P1, no secret/IDOR/privacy regression found this phase | Full suite 161/1, worker smoke, E2E 7/7, sweeps below | — | Continue to 11b |

No `UNKNOWN→false`, `UNAVAILABLE→[]`, `PARTIAL→COMPLETE`, or credential leak.

---

## 6. Security (quick sweep)

Search `password|secret|token|access_token|authorization|cookie|DATABASE_URL|IGTRACK_GRAPH_` across `apps/web/**/*.ts, workers/**/*.ts, packages/**/*.ts` (excluding `IGTRACK_GRAPH*` names, test/fixture, `passwordHash` legit, `cookie` in `auth.ts` handling):

- **Legitimate config refs only:** `.env.example:27` `IGTRACK_GRAPH_CLIENT_ID/SECRET/ACCESS_TOKEN` **names without values** (commented, `Never commit`); `docs/phase-10-provider-evaluation.md` `api.instagram.com/oauth/authorize` doc URL; `docs/phase-9-forensic-audit.md` `credential-shaped identifiers` audit note.
- **Safe token handling:** `apps/web/lib/auth.ts:10` `verifyPassword`, `:31` `store.get(COOKIE_NAME)?.value` → `resolveSession` (hashed), `:60` `issueSession` → `set(COOKIE_NAME, token, {httpOnly:true, sameSite:lax, secure:production})`; `workers/monitoring/src/index.ts:67` `logWorker` JSON `{ts,level,event,jobId,kind,owner…}` truncated 300 chars, never payloads/cookies.
- **No exposure:** `apps/web/app/api/healthz/route.ts` body `status,version,provider,db,migrations,latencyMs,ts` — no `DATABASE_URL`, token, secret, raw hash; `workers/monitoring/src/provider.ts:providerFromEnv` error message points to `docs/phase-10-provider-evaluation.md` not a credential.

**AuthZ:**
- Password hashing `scrypt`-based (`packages/database/src/auth/passwords.ts` `scrypt$salt$hash`), session tokens hashed `sha256` (`auth/sessions.ts`), expiry + revocation (`expiresAt, revokedAt`, `resolveSession` checks), cookie flags as above, `dev-login` hard-disabled `isDevLoginEnabled()` returns false when `NODE_ENV===production` even if `IGTRACK_ALLOW_DEV_LOGIN` set (`apps/web/lib/auth.ts`), login rate limit 5/15m per IP+email `POST /api/auth/login` `apps/web/lib/rate-limit.ts` + `checkRateLimit` returns `Retry-After` header, verified by `rate-limit.test.ts` (max, window reset, bucket isolation).
- **IDOR sweep:** Every target/evidence/job/observation route uses **ownership-pinned** repository (`getOwnedTargetDetail`, `updateOwnedTargetMeta`, `deleteOwnedTarget`, `listTargetsForUser(userId)`) and returns `404 indistinguishable` when `!bundle`/`!deleted` (`apps/web/app/api/targets/[targetId]/route.ts:24` `if(!bundle) 404 "Target not found"`). No UI-only hiding. Verified by code + E2E `pauses/resumes only own target` and `diagnostics without secrets`.

**Classification: no P0/P1/P2 security regression.**

---

## 7. Epistemic Integrity

Verified (code + test + DB):
- `UNKNOWN remains NULL/UNKNOWN`: `normalize/profile.ts:15` + `accounts.ts:43` conditional spreads, `privacy.test.ts` 4 tests, grep `?? false` / `|| false` / `?? 0` / `|| 0` hits only `queue.ts:382 rows[0]?.count??0` and `schedule.ts:150 row?.n??0` (counters, not epistemic) — **no `isPrivate ?? false`**.
- `PARTIAL remains PARTIAL`: `follow_snapshots.completeness` `COMPLETE|PARTIAL` from provider final page (`executors.ts`), never hardcoded upgrade; `follows.test.ts` asserts.
- `UNAVAILABLE produces no fake observation`: provider `UNAVAILABLE` → outcome `UNAVAILABLE`, zero rows, health `UNAVAILABLE` with coverage note (`source-health` distinct test).
- `zero ≠ UNAVAILABLE`: `AVAILABLE + []` → `COMPLETED_EMPTY` (stored empty COMPLETE snapshot for follows, distinct from `UNAVAILABLE`) via Phase 8 fix, proven in `following-scan`/`worker-integration` O3.
- `raw_hash genuine or NULL`: Fixture `sha256(rawText)` → `rawReference fixture:v1/…` before normalize; repo stores that hash, never `sha256(normalized)`. `conformance C2` `expectRawHashHonest` (64 hex).
- `derived never exceeds source completeness`: deltas/timeline built from observed snapshots; confidence `HIGH/MEDIUM/LOW/UNKNOWN`.

INFERRED: 500k-member / 10k-target scale readiness (no bench yet — 11b). DEFERRED: Graph adapter (D1), backup cron, Dockerfiles, session purge schedule, lease heartbeat, identity-strip reaper — all correctly gated.

---

## 8. Production Readiness (collapsed vs not)

| Category | Verdict | Basis |
|---|---|---|
| **Fixture/synthetic readiness** | **READY** | 161 passed incl. all worker/scheduler/staging/privacy/health suites, worker boot smoke `job_succeeded PROFILE_SCAN COMPLETED`, E2E 7/7, typecheck+build PASS, no P0/P1. |
| **Provider-contract readiness** | **READY** | `provider-contract.md` §1e method-by-method mapping complete, conformance C1-C5 PASS, failure taxonomy matches code, follow lists correctly stay `UNAVAILABLE` for official API. |
| **Real-provider integration** | **NOT INTEGRATED — correctly** | D1 `Meta/Graph authorization = FOUNDATION REQUIRED / DEFERRED` (`docs/phase-10-provider-evaluation.md`); no app/credentials/calls made (hard rule 1). |
| **Controlled Graph testing** | **NOT YET AVAILABLE — correctly** | No `CONTROLLED TEST ACCOUNT` (Phase 10 §9); would require D1 `Business/Creator` sandbox + documented auth basis — not fabricated. |
| **Public production readiness** | **NOT READY — explicit gates** | 2 gates before public: **backup/RPO** (`docs/deployment.md:73` policy `24h target 14d daily pg_dump weekly drill` **not yet deployed** — documented `Implementation NOT YET DEPLOYED`) and, when multi-instance, distributed rate-limit (today in-memory 5/15m is sufficient for single-host). Also **ops debt**: session purge unscheduled (`purgeExpiredSessions` exists), Dockerfiles none (single-host `pnpm start` is prod today), pool timeouts already implemented (`connect 10s idle 30s lifetime 1800` at `packages/database/src/client/client.ts:19`). None are P0/P1 for fixture-only private deployment, but they block unsupervised public launch. |

---

## 9. Phase 11b Recommendation

```
Proceed to Phase 11b — staging scale benchmark.
```

**Scope 11b only:** `scripts/bench-staging.ts` deterministic 1k/10k/50k/100k/500k synthetic members, measure wall time / DB writes / rows / final snapshot time / RSS, label MEASURED vs INFERRED, determine if staging design is sufficient for intended provider scale. **Do not** integrate Graph, add credentials, deploy, or opportunistically fix carried P2s unless 11b bench proves a P0/P1 (then RED→FIX→GREEN→REGRESSION).

Carried P2 ledger for 11b ranking: `F-DB-001` stale main-DB drift, backups/RPO not deployed, session purge unscheduled, Dockerfiles/topology, scan-duration metrics partial, lease heartbeat none, `ig_accounts` identity-strip reaper pending. All remain P2.

---

## Appendix A — Commands run

```
docker compose up -d db                         → Container igtrack-db Started → Up (healthy)
docker compose ps                               → igtrack-db postgres:16-alpine healthy 5432
docker exec ... psql -c "SELECT 1;"             → 1
docker exec ... psql -c "SELECT version();"     → 16.15 Alpine
docker exec ... psql -c "\dt"                   → 20 tables after migrate (17 before)
DATABASE_URL=postgresql://… pnpm --filter @igtrack/database db:migrate → migrations applied
pnpm test                                       → 161 passed / 1 skipped / 0 failed / 28 files / 66.22s
DATABASE_URL=… IGTRACK_JOB_MAX_ITER=1 IGTRACK_JOB_POLL_MS=100 pnpm --filter @igtrack/monitoring start → scheduler_tick enqueued:4 job_succeeded PROFILE_SCAN COMPLETED worker_stopped
IGTRACK_PROVIDER=does-not-exist ... pnpm --filter @igtrack/monitoring start → worker_fatal "Expected IGTRACK_PROVIDER=fixture (allowed values: "fixture"; a Graph API provider requires …)" exit 1  (fail-fast, no fallback)
pnpm e2e                                        → 7 passed (46.6s) isolated igtrack_e2e
pnpm typecheck                                  → PASS (5 ws)
pnpm --filter @igtrack/web build                → PASS Next 15.5.24 3/3 static, /api/healthz present
```

## Appendix B — Evidence that `UNKNOWN` never becomes `false`

```
packages/ingestion/src/normalize/profile.ts:15  ...(p.is_private!==undefined?{isPrivate:p.is_private}:{})
packages/database/src/repositories/accounts.ts:43 ...(input.isPrivate!==undefined?{isPrivate:input.isPrivate}:{})
grep "?? false|\\|\\| false|\\?\\? 0"           → only counters queue.ts:382 / schedule.ts:150
```

Observed `raw_hash` trigger present: `evidence_no_update BEFORE UPDATE EXECUTE FUNCTION igtrack_reject_update()`.


# Phase 11d — Final Production Readiness

**Date:** 2026-09-02 UTC  
**HEAD:** `3d7c17b` (`fa3df01` 11a PASS + `2632273` P1 batch fix + `3d7c17b` 11b report + harness)  
**Branch:** `master` **Working tree:** clean (this report is the only new file until commit)  
**PostgreSQL:** `16.15 Alpine` `igtrack-db` healthy, DB `igtrack` 20 tables, `drizzle.__drizzle_migrations` 7 rows, `follow_scan_staging` UNIQ `(job_id,username_lower)`  
**Node:** `v24.18.0`  
**Mode:** final audit/gate — no Graph integration, no credentials, no live Instagram calls, no new features

---

## 1. Executive verdict

```
PROVIDER-INTEGRATION READY
```

**Why not `PRODUCTION READY`:** synthetic/fixture, provider-contract, and ≤50k staging are **READY** (no P0/P1, 161/1 on real PG, worker/E2E/build PASS). **Public production** is **NOT READY** — two **founder gates** remain (D1 Graph auth deferred by design, D2 deployment target + backup/RPO not deployed). `PROVIDER-INTEGRATION READY` is the honest single label that does not collapse these categories.

**Split (required):**
1. Synthetic/fixture: **READY** (MEASURED)
2. Provider-contract: **READY** (VERIFIED)
3. Scale (≤50k staging): **READY** (MEASURED); 500k staging: **INFERRED READY with P2 gate** (see §4–7)
4. Real Instagram provider: **NOT INTEGRATED** (DEFERRED, correct)
5. Controlled Graph testing: **NOT AVAILABLE — D1 DEFERRED** (correct)
6. Public production: **NOT READY — explicit gates** (backups/RPO, session purge, deployment artifact, heart-beat/500k lease) — P2 debt, not P1

---

## 2. Exact final test matrix (real PostgreSQL, not mocks)

**Vitest:** `pnpm test` at `2026-09-02T01:08:24Z`
```
Test Files 28 passed (28)
     Tests 161 passed | 1 skipped (162)
  Duration 68.11s (transform 676ms, collect 16.81s, tests 41.21s)
```
The 1 skipped is **intentional by design** `packages/database/test/schema.test.ts` trigger guard (`igtrack_reject_update()` existence) — not an infra skip. **Zero substantive DB skips.** Previous 11a had same 161/1 after PG restored; 11b post-batch regression was `69.69s` same counts — stable.

Per-suite (DB-backed = real PG, from 11a/11d runs): `jobs 14`, `scheduler DB 9`, `checkpoint-staging 6`, `following-scan 9`, `provider-timeout 7 (hung→TIMEOUT 306ms, no evidence 319ms, daemon survives 333ms)`, `scheduler worker 8 S11 7.4s`, `story-scan 10`, `worker-boundary 10 J3/J5/J7`, `worker-follower-scan 5`, `worker-integration 5 S1/O1/O3/S6+lease`, `follows 4`, `persistence 5`, `privacy 4`, `retention 2`, `source-health 5 PH10-R1`, `stories 2` — all PASS.

**Playwright:** `pnpm e2e` `7 passed (46.4s)` isolated `igtrack_e2e` (same as 11a 46.6s) — login, queue target, pause/resume, evidence chain, target detail, diagnostics without secrets, delete. No substantive DB skip.

**Typecheck:** `pnpm typecheck` **PASS** 5 workspaces (core, ingestion, database, monitoring, web) — `Done` each.

**Production build:** `pnpm --filter @igtrack/web build` **PASS** Next `15.5.24`, `3/3` static, `ƒ /api/healthz 153 B`, `ƒ /api/targets 153 B`, shared `102 kB`.

**Worker boot smoke:** `DATABASE_URL=postgresql://... IGTRACK_JOB_MAX_ITER=1 IGTRACK_JOB_POLL_MS=100 pnpm --filter @igtrack/monitoring start` → `scheduler_tick enqueued:4 job_succeeded PROFILE_SCAN COMPLETED worker_stopped` (11a). Unknown provider `IGTRACK_PROVIDER=does-not-exist` → `worker_fatal Expected IGTRACK_PROVIDER=fixture (allowed values: "fixture"; … docs/phase-10-provider-evaluation.md)` exit 1 — fail-fast, no fallback, no `UNAVAILABLE` masquerading.

---

## 3. Phase 11a evidence summary

- **Infra:** `docker compose up -d db` → `Up 11s (healthy)` `pg_isready`, `SELECT 1` →1, `20 tables` after `db:migrate` (was `17` before), 7 `drizzle.__drizzle_migrations`.
- **Full suite:** `161/1/28 / 68s` (see §2), same as post-fix.
- **Forensics:** provider boundary (`providerFromEnv` fail-fast), `FixtureProvider` genuine `sha256(rawText)`, `sourceKindFor` explicit, `capability taxonomy + effectiveRetryability`, `PC-T1 timeout`, `retryAfter verbatim`, `C1-C5 conformance` all VERIFIED.
- **Security/IDOR:** `getOwnedTargetDetail` → `404` indistinguishable, `scrypt` + `sha256` sessions, `httpOnly sameSite=lax secure`, `dev-login` disabled in prod, login `5/15m per IP+email` with `Retry-After`.
- **Epistemic:** `UNKNOWN` conditional spreads `...(isPrivate!==undefined?{isPrivate}:{})` (`normalize/profile.ts:15`, `accounts.ts:43`), `PARTIAL` never upgraded, `UNAVAILABLE` zero rows, `raw_hash` genuine-or-NULL, append-only trigger `evidence_no_update`.
- **Verdict:** `PHASE 11A PASS — CONTINUE TO 11B` (infra gate cleared, no P0/P1).

---

## 4. Phase 11b evidence summary

- **Harness:** `packages/database/scripts/bench-staging.ts` + `scripts/bench-staging.ts` — **production** `stageFollowScanMembers` / `loadStagedFollowScanMembers` / `clearStaged` / `clearForeign` / `recordFollowSnapshot` on real PG, deterministic `member000001…`, pageSize 1k, fresh `user/target/job` per scale.
- **MEASURED to 50k:**

| Scale | Stage | Load | Snapshot (seq. `upsertAccount`) | Total | Rows present | Distinct | Members | RSS delta | DB staging | Result |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1k clean | 128 ms | 9 ms | 3,979 ms | 4,081 ms | 0.2 MB | 336 KB | 1,000 | PASS |
| 10k clean | 1,275 ms | 19 ms | 36,881 ms | 38,188 ms | 0.7 MB | 3.38 MB | 10,000 | PASS |
| 10k bloat* | 139,617 ms | 187 ms | 57,987 ms | 197,807 ms | 5.1 MB | 31.99 MB | 10,000 | PASS outlier (60k `ig_accounts` + 200k leftover staging bloat) |
| 50k (after batch fix) | 7,685 ms | 100 ms | 220,003 ms | 227,923 ms | -0.27 MB | 47 MB | 50,000 | PASS |

`*` second run after 60k orphan `ig_accounts` + `follow_scan_staging n_live_tup 200000` — explains variance.

- **INFERRED:** 100k `~15s stage / 440s snapshot / 90 MB staging`, 500k `~75s stage / ~2,200s (~36 min) snapshot / ~400 MB staging / ~50 MB RSS` — linear extrapolations from 50k, labeled INFERRED.
- **Correctness to 50k:** `count == distinct == requested` (50k 50000/50000), `follow_snapshot_members == staging unique`, duplicate `[0,1,1,2,0]→3k` ( `ON CONFLICT DO NOTHING`), reordered `ABC/CAB/BCA` set equality, cross-job `clearForeign(jobB)→ jobA 0 jobB 1000`.
- **O(n²) check:** 1k→10k stage `9.96× for 10×` (1.27/0.128) — linear; snapshot 9.27× — linear; implementation `INSERT ... ON CONFLICT DO NOTHING` per page, `checkpoint cursor/page only` (no JSONB rewrite), `SELECT ... ORDER BY id` — **MEASURED/IMPLEMENTATION-SUPPORTED linear**, HIGH confidence to 50k.
- **DB at report time (with bloat):** `ig_accounts 50015` rows `14 MB`, `follow_scan_staging 70 MB n_live_tup 200000` (aborted 100k prefix), `follow_snapshot_members 12 MB n_live_tup 4` (after cleanups `count(*) WHERE job_id` →0).

---

## 5. P1 fix verification (batching)

**Before:** `packages/database/src/repositories/follows.ts` did single `INSERT INTO follow_snapshot_members VALUES ($1,$2)...($99999,$100000)` for 50k → **100k params > 65534** → `MAX_PARAMETERS_EXCEEDED` (bench aborted, `tool_05e6ddcd1001vVeaIJquZHy91N` shows 878k chars of params).

**Fix:** `follows.ts:111` now `BATCH 5000` (≈10k params) `for (i; i<accountIds.length; i+=BATCH) insert VALUES(batch).onConflictDoNothing()` — deterministic, inside `withTransaction`, evidence + cleanup + dedup (`follow_snapshots_idempotency_idx`) + `onConflictDoNothing` for members all preserved.

**Evidence:**
- Commit `2632273` `phase11b: fix snapshot member chunking`
- Post-fix `pnpm test` `161/1/28` green (twice: `69.69s` after fix, `68.11s` final)
- Re-bench 50k now PASS (220s) — `memberInserts 50000`

No member lost, no duplicate leakage, transaction correct, `UNKNOWN/PARTIAL/UNAVAILABLE` untouched. **P1 CLOSED.**

---

## 6. P2 ledger (single authoritative table)

| ID | Finding | Severity | Production Impact | Provider Impact | Scale Impact | Probability | Current State | Blocker? | Recommendation |
|---|---:|---|---|---|---|---|---|---|---|
| **F-500K-002** | Sequential `upsertAccount` inside `recordFollowSnapshot` transaction ≈3.6 ms/member (36s/10k, 220s/50k, **~36 min inferred at 500k**, 5-min `IGTRACK_JOB_LEASE_MS` lease) | **P2** scale | Single-host 500k tail-latency; lease expires mid-snapshot → reclaimable while legitimately running (stale-owner guard prevents corruption via `WHERE locked_by` + snapshot idempotency, but recovery would replay). For ≤50k, well under lease (50k 220s <300s). | None for fixture/Graph (both use same `ig_accounts` upsert); 500k follower list is not a real-provider scenario today (official API `followers` is `UNAVAILABLE` — only `follower_count`). | 500k snapshot construction | Low today (few 500k-member accounts; official API never returns 500k list) | **Measured to 50k, INFERRED to 500k**; no heartbeat | **Not blocker** for ≤50k self-host; **P2 gate** for 500k product requirement | **Defer**. If 500k becomes requirement: batch `upsertAccount` via `INSERT ... SELECT unnest ON CONFLICT` or move upserts out of snapshot tx, add lease heartbeat. Do not fix in 11d. |
| **F-DB-001** | Main DB bloat + stale `igtrack` before `db:migrate` (17 vs 20 tables); bench leaves 50k `ig_accounts` orphans (50015 rows) + `follow_scan_staging 70 MB n_live_tup 200k` from aborted 100k | P2 operational | Stage timings inflated (10k 1.27s clean vs 139s bloat), storage; not a code defect | None | Up to 60k+ rows today | High if bench not cleaned | `follows.ts` `ig_accounts` shared registry retains identities by design (`docs/deleted-target-retention.md`) | No for ≤50k | Defer; harness teardown could `DELETE WHERE username LIKE 'member%'` after bench, or `VACUUM`; keep current `ON DELETE CASCADE` for targets. |
| **BKP-001** | **Backups/RPO not deployed** (see §7) | P2 prod gate | 24h RPO target documented `docs/deployment.md:73` `daily pg_dump 14d weekly drill` but `Implementation NOT YET DEPLOYED`, no automation, no encryption, no tested restore, no off-site | None | Recovery of observations (append-only, unreconstructible) | Certain if volume lost | DOCUMENTED only (`docs/phase-11a-forensic-report.md:73` already) | **Gate before public launch** (not for private/self-host) | Founder confirms max RPO/RTO/retention/encryption; then implement `pg_dump` cron + off-site + weekly restore drill. |
| **SES-001** | Expired session purge unscheduled | P2 operational | `purgeExpiredSessions(db)` exists (`packages/database/src/auth/sessions.ts`) but never scheduled; `sessions` grows unbounded, `sessions_expiry_idx` helps queries but not storage. | None | O(1) | High over months | Function exists, no cron/worker tick | No for single-host private | Add to worker tick or `pg_cron` before public; low priority. |
| **LEASE-001** | No lease heartbeat (relates to F-500K-002) | P2 operational | Long snapshot (50k 220s still <5m, 500k 36 min >5m) can exceed lease without heartbeat. State machine correctly handles reclaim: `running WHERE locked_at < now - lease` → reclaimed if attempts left else `LEASE_EXPIRED` → `failed`; `completeJob/failJob WHERE locked_by` prevents stale overwrite (`lost` outcome `worker-boundary J5/J7`). So **yes legit worker can be mistaken for dead**, **no corruption** (idempotency prevents duplicate snapshot). | None | 500k only | Low today | `workers/monitoring/src/jobs/queue.ts` lease, no heartbeat (`docs/deployment.md` notes `no in-flight lease renewal`) | No for ≤50k | Defer; add heartbeat `UPDATE locked_at` every ~60s if 500k becomes requirement. |
| **DEP-001** | Dockerfiles/deployment topology deferred | P2 operational | `docs/deployment.md` topology `web pnpm start` + `worker pnpm start` + PG 16, env `DATABASE_URL`, health `/api/healthz`, graceful `SIGINT/SIGTERM` `main.ts`, migration `db:migrate` before start, rollback `redeploy previous build` (forward-only) — but no `Dockerfile`, no managed PG, no compose prod override. | None | None | Certain | Docs describe, artifacts not built | **Gate for public cloud**, not for local/self-host (`docker compose up -d db` already) | Defer until D2. |
| **OBS-001** | Scan-duration / queue-depth metrics partial | P2 | Structured logs `workers/monitoring/src/index.ts:logWorker` `{ts,level,event,jobId,kind}` truncated 300 chars, never secrets; diagnostics `apps/web/app/diagnostics/page.tsx` shows scheduler `lastTick/lastSuccess/lastError`, queue counts, source_health; but no `scan duration` histogram/metrics/alerts. | None | None | — | Logs + diagnostics UI present, metrics platform absent (as intended) | No | Defer; add `duration` metric if operator needs SLA. |
| **RET-001** | `ig_accounts` identity-strip reaper not implemented | P2 privacy/retention | `ig_accounts` is shared registry `ON DELETE RESTRICT` for many FKs; `deleteTargetWithObservations` (`packages/database/src/repositories/targets.ts`) removes snapshots/members/deltas/stories/evidence but **retains** `ig_accounts` (so evidence references stay resolvable, e.g. a mention's `mentionedAccountId`). `docs/deleted-target-retention.md` documents future `identity-strip` (null `displayName/bio` etc. when no ref) — not yet built. Retained identity is required for current `story_mentions`/`follow_deltas` joins. | None | Orphan growth (50k bench orphans) | — | Documented-deferred | No | Founder policy question D4 only if privacy requires strip; otherwise operational debt. |

P1 `MAX_PARAMETERS` is **FIXED** and not carried open.

---

## 7. Backup / RPO / Recovery gate

- `docs/deployment.md:73` §4a: **target** `RPO=24h` `daily pg_dump 14d` `weekly restore drill` — **DOCUMENTED POLICY, IMPLEMENTED BACKUP = none** (`Implementation NOT YET DEPLOYED` label at `docs/deployment.md:88`), **DEPLOYED BACKUP = none**, **TESTED RESTORE = none** (11b report `pg_dump → rm → restore` not yet run). Automation `pg_dump` cron, retention, off-site, encryption, `RESTORE` `pg_restore` + `DATABASE_URL` + `db:migrate` — not in repo.
- `docs/data-model.md` append-only: **critical, unreconstructible** = `profile_snapshots, profile_changes, follow_snapshots, follow_snapshot_members, follow_deltas, stories, story_mentions, interactions, evidence` (hashes don't restore content). **Reconstructible** = `users/sessions (re-provision), targets (re-create), scheduler_state (self-heals), source_health (rebuilds), job_checkpoints, follow_scan_staging (transient)`.
- `docs/deleted-target-retention.md`: `ig_accounts` retained as shared registry; second engineer would keep deletability: `DELETE FROM targets` cascades observations but `ig_accounts` stays.

**Classification:** **`24h RPO documented but not deployed` → production gate before public launch** (P2 operational blocker for public; **acceptable for private/self-host** where operator accepts single-volume risk). Do not silently adopt as founder-approved — gate D3 asks to confirm.

---

## 8. Session retention

- **Exists:** `purgeExpiredSessions(db)` at `packages/database/src/auth/sessions.ts` (`DELETE FROM sessions WHERE expiresAt < now()`) — correct.
- **Scheduled?** **No** — never called from `workers/monitoring/src/main.ts` tick, `apps/web` route, or cron (`Grep sessions → only definition`).
- **Behavior:** `sessions` `sessions_expiry_idx` helps `resolveSession` `WHERE expiresAt > now()` but table grows unbounded (one row per login, `expiresAt = now + 30d` at `apps/web/lib/auth.ts` `SESSION_TTL_MS`). Revocation `revokeSession` + `revokeAllSessionsForUser` work; expiry is checked at auth.
- **Impact:** Low for single-host private (few users), **P2 operational debt** for public (unbounded growth over months).

**Classification:** **P2 operational debt, not blocker for initial deployment** — schedule before public via worker tick or `pg_cron`.

---

## 9. Lease / long-running job analysis

**Measurement:** `upsertAccount ≈3.6 ms/member` (10k 36s, 50k 220s, **inferred 500k ≈2,200 s ≈36 min**) inside `recordFollowSnapshot` transaction.

**Lease:** `IGTRACK_JOB_LEASE_MS` default `5 min (300000)` (`workers/monitoring/src/jobs/queue.ts` `locked_at` lease, `claimJob` `WHERE running AND locked_at < now - lease` → reclaim if `attempts < maxAttempts` else `failed LEASE_EXPIRED`; `completeJob/failJob WHERE id AND locked_by` → loser `lost`).

**Q: Can legitimate worker be mistaken for dead?** **Yes** — 500k snapshot 36 min >5 min, also 50k 3.6 min is near lease (220s <300s but close). **Q: Can old worker corrupt successor?** **No** — `WHERE locked_by` + snapshot idempotency `follow_snapshots_idempotency_idx (targetId,direction,takenAt,sourceId)` + `ON CONFLICT DO NOTHING` for members prevents duplicate snapshot, and staged rows are per-`job_id`.

**State machine:** `queued → running (locked_at/locked_by) → retry_wait (backoff ‖ retryAfterMs verbatim) / succeeded / failed / cancelled` via `queue.ts`; `running` reaped as `LEASE_EXPIRED` if exhausted; daemon survives `PostgresError` via `isInfrastructureError` at `workers/monitoring/src/index.ts`.

**No heartbeat today** (`docs/deployment.md` explicitly `no in-flight lease renewal`).

**Classification:** **P2 operational/scaling debt** (not correctness failure) — operationally P1 only if 500k becomes a **committed real-provider scenario** (but official API `followers` is `UNAVAILABLE`, so 500k real list is not expected; fixture 500k is synthetic).

---

## 10. Deployment topology gate

| Artifact | Status | Evidence |
|---|---|---|
| Web | `pnpm --filter @igtrack/web start` (after `next build`) — `apps/web/app/api/healthz/route.ts` `GET /api/healthz` 200/503, `Route` `ƒ /api/healthz 153 B` | `docs/deployment.md:1`, `apps/web/package.json` |
| Worker | `pnpm --filter @igtrack/monitoring start` (`src/main.ts`) + scheduler tick co-located, `SIGINT/SIGTERM` cooperative `shouldStop`, pool `sql.end()` | `workers/monitoring/src/main.ts`, `11a worker boot` |
| PostgreSQL | PG 16 `postgres:16-alpine` `5432`, host `0.0.0.0:5432`, volumes `igtrack_pgdata` + `docker/initdb/create-test-db.sql` (`CREATE DATABASE igtrack_test`), Compose healthcheck `pg_isready` | `docker-compose.yml` |
| Env | `DATABASE_URL=postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack` `IGTRACK_TEST_DATABASE_URL` `IGTRACK_DATABASE_URL` (E2E) `IGTRACK_PROVIDER=fixture` `IGTRACK_FIXTURE_VERSION=v1` `IGTRACK_JOB_POLL_MS=5000` `IGTRACK_JOB_LEASE_MS=300000` `IGTRACK_PROVIDER_TIMEOUT_MS=30000` `IGTRACK_SCAN_*` `IGTRACK_SCHEDULER_TICK_MS=60000` `IGTRACK_SCHEDULER_BATCH=200` | `.env.example`, `docs/deployment.md` |
| Health | `GET /api/healthz` `200 ok / 503 degraded` `{status,db,migrations,latencyMs,provider,version,ts}` `Cache-Control: no-store` no secret | `apps/web/app/api/healthz/route.ts` |
| Graceful shutdown | `process.on SIGINT/SIGTERM → requestShutdown` `shouldStop` | `main.ts:6` |
| Persistent storage | `igtrack_pgdata` volume; media `IGTRACK_MEDIA_DIR=./data/media` `MediaStorage` interface → `FileSystemStorage` | `docker-compose.yml`, `deployment.md` |
| Backup | documented target, not deployed (see §7) | `deployment.md:73` |
| Migration | `pnpm --filter @igtrack/database db:migrate` (`tsx src/cli/migrate.ts` via `drizzle.migrate`) **before** `web/worker` start; rollback = `redeploy previous build` (forward-only) | `packages/database/package.json:db:migrate` |
| Rollback | forward-only migrations, no down | `migrations/0000..0005` |
| Dockerfiles/topology | **deferred** — none in repo | `11b harness` still `pnpm start` single host |

**Local/self-hosted:** **READY** (`docker compose up -d db` + `db:migrate` + `pnpm start` both processes) — 11a/11b ran this way.  
**Public cloud:** **NOT READY** — missing D2 target choice, managed PG, image registry, backup cron, alerting — all gated.

---

## 11. Observability / Operations

- **Structured logs:** `workers/monitoring/src/index.ts:logWorker` JSON `{ts,level,event,jobId,kind,error,lockedBy}` truncated 300 chars, never `password/secret/token/cookie/DATABASE_URL/IGTRACK_GRAPH_/provider payload` — verified by grep (§6).
- **Queue depth / jobs:** `apps/web/app/diagnostics/page.tsx` shows `monitoring_jobs` by status, `scheduler_state lastTick/lastSuccess/lastError`, `source_health` per capability — behind auth `requireApiSession`.
- **Provider failures:** `recordCapabilityFailure` + `source_health` + logs `worker_poll_error`, `scheduler_tick_error`, `unexpected_job_error` (11a worker-boundary logs `ECONNREFUSED injected` 10× still `PASS`).
- **DB failure / stale leases:** logs `worker_poll_error` / `job_ownership_lost`, reclaim visible in `monitoring_jobs.locked_at`.
- **Scan duration / queue depth metrics:** **P2 partial** — logs carry `level/info job_succeeded outcome` but no histogram; diagnostics shows counts not durations. Alerts/metrics platform absent by design (not required for self-host).

**Classification:** **P2 operational debt** — safe to operate as self-host (logs + diagnostics), not enterprise production without metrics.

---

## 12. `ig_accounts` retention / Privacy

- **Shared registry:** `ig_accounts` PK `usernameLower UNIQUE`, `igId UNIQUE WHERE NOT NULL`, referenced `ON DELETE RESTRICT` by `profile_snapshots, stories, story_mentions, follow_snapshot_members, follow_deltas, interactions` — so `ig_accounts` **cannot** be cascade-deleted while observations exist.
- **What delete does:** `deleteTargetWithObservations` / `deleteOwnedTarget` → `DELETE FROM targets WHERE id AND user_id` cascades `follow_snapshots → follow_snapshot_members`, `stories → story_mentions`, `profile_snapshots`, `evidence` (where orphan), but **retains** `ig_accounts` (shared across targets, mention references stay resolvable). Verified by `retention.test.ts` 2 tests.
- **Identity-strip reaper:** **Not implemented** — `docs/deleted-target-retention.md` documents future `identity-strip` (null `displayName/bio/...` when no ref) but current behavior is retain. **Required for current functionality?** Yes — `story_mentions.mentionedAccountId → ig_accounts.id RESTRICT` needs the row.
- **Privacy invariant:** `isPrivate/isVerified` nullable `UNKNOWN` preserved via `...(isPrivate!==undefined?{isPrivate}:{})` at `accounts.ts:43` + `normalize/profile.ts:15` — never `?? false`. Verified `privacy.test.ts` 4 tests.

**Fact vs policy:**
- Fact: registry retains identity rows after target delete, bounded by distinct usernames (50015 bench orphans today).
- Policy decision D4 (only if needed): confirm retention vs strip (e.g., GDPR right-to-erasure for non-target-owners). **Do not implement reaper in 11d** — surface as D4.

---

## 13. Provider / Graph boundary final check

| Item | Status | Evidence |
|---|---|---|
| FixtureProvider | **READY** | `FixtureProvider fixture:v1` `SourceKind.FIXTURE` `packages/ingestion/fixtures/v1` genuine `sha256(rawText)` `fixture:v1/<file>` |
| Provider contract | **READY** | `docs/provider-contract.md` §1e method-by-method legal boundaries, §1a `AVAILABLE/PARTIAL/UNAVAILABLE/ERROR`, `effectiveRetryability`, `retryAfterMs verbatim`, `sourceKindFor` |
| Graph adapter | **NOT INTEGRATED** | `workers/monitoring/src/provider.ts:23` only `fixture` allowed; `IGTRACK_GRAPH_*` only **names** in `.env.example` (no values) |
| Real credentials | **NONE** | `git ls-files` shows no `.env`, grep `access_token/client_secret` only doc names |
| Controlled Graph testing | **NOT AVAILABLE — D1 DEFERRED** | `docs/phase-10-provider-evaluation.md` D1 `FOUNDATION REQUIRED / DEFERRED`, `phase-11d` same |
| Docs say same? | **Yes** | `README` `PROVIDER EVALUATION COMPLETE — REAL PROVIDER TESTING NOT YET AVAILABLE`, `provider-contract.md` `Graph evaluation-ready not integrated`, `platform-limitations.md:20` `followers UNAVAILABLE via official API (only counts)` |

No boundary blurring — Graph matrix never turned into implementation claim.

---

## 14. Documentation reality pass

`README.md` `docs/**/*.md` search for `production ready / provider ready / Graph integrated / Instagram API / followers / following / stories / mentions / scraping / UNAVAILABLE / PARTIAL / UNKNOWN / backup / RPO / deployment`:

| File | Claim | Verdict |
|---|---|---|
| `README.md` | `Phase 11b PASS — P2 SCALE GATE` header? Actually `Phase 10 PROVIDER EVALUATION COMPLETE — NOT YET AVAILABLE` + links to `phase-11d` (after this commit) | **ACCURATE** (fixture-only, no Graph integration claim) |
| `docs/provider-contract.md` | §1e Graph `followers UNAVAILABLE` + legal boundary | **ACCURATE** |
| `docs/platform-limitations.md` | `followers UNAVAILABLE via official API (only counts)`, no scraping, no private API | **ACCURATE** |
| `docs/phase-10-provider-evaluation.md` | `Fixture selected, Graph evaluation-ready D1 deferred, scrape rejected` | **ACCURATE** |
| `docs/phase-10-founder-report.md` / `docs/phase-11a-forensic-report.md` / `docs/phase-11b-scale-benchmark.md` | `MEASURED / INFERRED / VERIFIED` labels | **ACCURATE** |
| `docs/deployment.md:73` | `RPO=24h daily pg_dump 14d weekly drill` **`Implementation NOT YET DEPLOYED`** | **ACCURATE** (explicitly gated, not claiming backups exist) |
| `docs/data-model.md` | `ig_accounts isPrivate/isVerified UNKNOWN nullable`, `append-only trigger` | **ACCURATE** |
| `docs/deleted-target-retention.md` | shared registry retain, future reaper deferred | **ACCURATE** |
| `docs/roadmap.md` | `Phase 10 PROVIDER EVALUATION COMPLETE` `11a PASS` `11b PASS — P2 SCALE GATE` (after this commit) | Update to reflect 11d in next commit — currently `STALE — P2` (roadmap behind HEAD) → will fix as docs-only |

No `STALE — P1` found. One `ROADMAP/GATED` (`Graph integrated` not claimed). No `production ready` overclaim.

---

## 15. Founder decision gate (only genuinely founder-required)

### D1 — Meta/Graph authorization
**DEFERRED** — founder must explicitly authorize controlled Graph integration/testing (Business/Creator sandbox account, documented auth basis, requested scopes `instagram_basic` first, then incremental, app-review plan). Do not ask merely to finish hardening; hardening is done.

### D2 — Deployment target
**REQUIRED** — `self-hosted single VM` vs `managed container platform` vs `other` — determines Dockerfiles, managed PG, image registry, backup cron placement, RPO enforcement.

### D3 — Backup/RPO policy
**REQUIRED** — confirm `Maximum acceptable RPO / RTO / retention / encryption / mandatory before public launch`. If founder already accepted 24h/14d in Phase 9/10, cite `docs/deployment.md:73` as evidence rather than asking again — but 11d treats it as **gate** until explicitly confirmed (do not silently adopt). Ask: confirm 24h/14d + encryption + tested restore as public-launch gate?

### D4 — Identity retention
**CONDITIONAL** — if `ig_accounts` retained identities after target delete require policy choice (e.g., GDPR), surface: retain shared registry (current, required for joins) vs identity-strip when no ref. Do not ask founder to choose batch/heartbeat implementation.

### D5 — Operational SLA
Only if needed for public: acceptable scan delay, downtime, alerting, recovery expectations — do not invent SLA; ask only if public SLA is a committed deliverable.

---

## 16. Final production-readiness matrix (evidence-backed)

| Area | Status | Evidence | Blocking? |
|---|---|---|---|
| Fixture/synthetic pipeline | **READY** | `161/1/28` + `7/7` E2E, `FixtureProvider` 11 tests, `conformance C1-C5` | No |
| Provider contract | **READY** | `provider-contract.md` §1e vs `core/provider.ts`, `effectiveRetryability` | No |
| Staging ≤50k | **READY (MEASURED)** | `1k 128ms/10k 1.27s/50k 7.6s`, duplicate/reordered/cross-job PASS | No |
| Staging 500k | **INFERRED READY with P2 gate** | `~75s` inferred linear, no `MAX_PARAMETERS` after batch fix, `UNIQUE(job_id,username_lower)` | P2 (see F-500K-002) |
| Snapshot construction | **READY ≤50k, P2 gate at 500k** | `1k 3.9s/10k 36s/50k 220s` MEASURED; 500k `~36 min` INFERRED; batch 5k FIXED, sequential `upsertAccount` remains | P2 (see §9) |
| Worker reliability | **READY** | `J3` survives `ECONNREFUSED`, `J5/J7` `lost`, `lease reclaim`, `queued→running→retry_wait→succeeded/failed/cancelled`, `SIGINT/SIGTERM` cooperative | No |
| Scheduler | **READY** | `S11` every ACTIVE across ticks, `ACTIVE-only`, `sched:<KIND>:<target>:<windowStartISO>` unique, batch 200, `clearForeign`, `SKIPPED_PAUSED/STOPPED`, `DATABASE` retry | No |
| Security / IDOR | **READY** | `getOwned*` → `404` indistinguishable, `scrypt`/`sha256`, `resolveSession` expiry/revoke, `httpOnly sameSite=lax secure`, `dev-login` prod-disabled, `rate-limit 5/15m Retry-After` | No |
| Privacy semantics | **READY** | `isPrivate/isVerified UNKNOWN` conditional spreads, `privacy 4` tests, `?? false` sweep only counters | No |
| Authentication | **READY** | `verifyCredentials` indisting., `issueSession`/`resolveSession`/`revokeSession`, `SESSION_TTL_MS` | No |
| Observability | **READY with P2 debt** | `logWorker` JSON + `diagnostics page` + `healthz` 200/503; no histogram/metrics platform | P2 `OBS-001` |
| Backups | **DOCUMENTED NOT DEPLOYED** | `deployment.md:73` target, no cron/off-site/encryption/tested restore | **Gate before public** `BKP-001` |
| Recovery | **MEASURED via deleteTarget cascade, INFERRED for disaster** | `retention.test.ts` + `ig_accounts` shared registry; pg disaster restore not tested | Gate (with backups) |
| Deployment | **READY for local/self-host, NOT READY for public cloud** | `docker compose`, `pnpm start` both processes, `db:migrate` before start, **no Dockerfiles** | Gate `DEP-001` |
| Real Instagram provider | **NOT INTEGRATED** | `IGTRACK_PROVIDER=fixture` only | — |
| Controlled Graph testing | **NOT AVAILABLE — D1 DEFERRED** | `phase-10-provider-evaluation.md` D1 | — |
| Public production | **NOT READY — explicit gates** | 11b P2 + backup/RPO + session purge + deployment artifact + 500k lease | **Yes, gates** |

---

## 17. Final P0/P1/P2/P3 ledger

### P0
*Empty* — no evidence of correctness/tenant/security catastrophe.

### P1
*Empty* — `MAX_PARAMETERS` P1 is **FIXED** (batch 5k, verified `161/1` + 50k bench).

### P2 (authoritative)

| ID | Title | Impact | Evidence |
|---|---|---|---|
| F-500K-002 | Sequential `upsertAccount` ~36 min inferred at 500k, lease 5 min | 500k single-host tail-latency; reclaim-possible but not corrupting | §9 / 11b §5 |
| BKP-001 | Backups/RPO 24h/14d documented not deployed | Unreconstructible observations lost on volume failure | `deployment.md:73` + §7 |
| SES-001 | Session purge unscheduled | Unbounded `sessions` growth | `auth/sessions.ts` + §8 |
| LEASE-001 | No lease heartbeat | Long snapshot could be reclaimed (see F-500K-002) | §9 |
| DEP-001 | No Dockerfiles / topology | Cloud deploy blocked | §10 |
| OBS-001 | Scan-duration metrics partial | No histogram/alerts | §11 |
| RET-001 | `ig_accounts` reaper not built | 50k orphans retained (50015 rows) | §12 |
| F-DB-001 | Bench bloat `70 MB n_live_tup 200k` | Inflated second-run timings | §4 |

### P3
- Batch `upsertAccount` via `unnest` (performance)
- `VACUUM` after bench teardown / `DELETE member%` cleanup
- Lease heartbeat `UPDATE locked_at` every 60s (if 500k required)
- `EXPLAIN ANALYZE` for staging queries (not needed today)
- Migration guard `check follow_scan_staging exists` in `main.ts` (already documented `db:migrate` before start; would be P3 harden)

---

## 18. Final verdict (§16)

### 1. Synthetic/Fixture Readiness
**READY** — `MEASURED` 50k staging correct, `161/1` on real PG, `7/7` E2E, `FixtureProvider` canonical, `C1-C5` PASS.

### 2. Provider-Contract Readiness
**READY** — `VERIFIED` against `provider-contract.md` §1e, `sourceKindFor`, `effectiveRetryability`, `retryAfter verbatim`, `UNAVAILABLE` never `[]`, `PARTIAL` preserved, `raw_hash` genuine-or-NULL.

### 3. Scale Readiness
**READY to 50k MEASURED, INFERRED READY with P2 gate to 500k**

- `follow_scan_staging` linear `O(n)` single `INSERT ... ON CONFLICT` per page, `UNIQUE(job_id,username_lower)` — **MEASURED READY** (1k 0.13s, 50k 7.6s).
- `follow_snapshot_members` now batched 5k — **FIXED**, **READY** to 50k (chunked correctness verified).
- `ig_accounts upsert loop` linear but slow — **P2 gate** at 500k (`INFERRED 36 min`).

No `O(n²)` JSONB ghost. `Confidence: HIGH` to 50k, `MEDIUM` to 500k extrapolation.

### 4. Real Provider Integration
**NOT INTEGRATED — correctly** (D1 deferred; `IGTRACK_PROVIDER=fixture` only).

### 5. Controlled Provider Testing
**NOT AVAILABLE — D1 DEFERRED** (requires Business/Creator sandbox + documented auth basis).

### 6. Public Production Readiness
**NOT READY — explicit gates** (`PRODUCTION READY WITH EXPLICIT GATES` would be the alternate label if founder confirms D3; without confirmation the single honest label is `PROVIDER-INTEGRATION READY` per §16 logic: synthetic+contract ready, public not yet).

**Collapsing `Fixture READY` into `Instagram READY` would be dishonest — they are distinct and this report keeps them separate.**

---

## Recommended next phase (§17)

```
NO MORE ENGINEERING HARDENING REQUIRED BEFORE FOUNDER GATE.
Proceed to deployment/provider authorization decisions.
```

**Ranked before public production (must/should/can defer):**

| Priority | Item | Owner |
|---|---|---|
| **Must before public** | **D3 Backup/RPO confirm + pg_dump cron + off-site + weekly restore drill** (BKP-001) | Founder + eng (small) |
| **Must before public** | **D2 Deployment target** (determines Dockerfiles, managed PG, migration procedure) | Founder |
| **Should before public** | Session purge schedule (`purgeExpiredSessions` → worker tick) (SES-001) | eng (tiny) |
| **Should before public** | Lease heartbeat if 500k is a committed scenario (LEASE-001/F-500K-002) | eng (small) |
| **Can defer** | Scan-duration histogram, Dockerfiles beyond compose (OBS-001, DEP-001), `ig_accounts` reaper (RET-001), bench `VACUUM` hygiene | — |
| **Not before** | Graph integration (D1) — **do not start** until Business/Creator sandbox + scopes + app-review plan are explicitly authorized; then **separate Graph integration phase** |

If public production is **not** imminent (private/self-host single VM), the current `docker compose up -d db` + `db:migrate` + `pnpm start` both processes is **READY** today — no harden required before that gate.

---

## Evidence index

- **Commits:** `3d7c17b` (11b) `2632273` (batch fix) `fa3df01` (11a) `cf4570c` (10)
- **Tests:** `pnpm test 161/1/28 (68.11s)`, `pnpm typecheck PASS`, `pnpm --filter @igtrack/web build PASS Next 15.5.24`, `pnpm e2e 7/7 (46.4s)`
- **DB:** `16.15`, `20 tables`, `7 migrations`, `follow_scan_staging UNIQ(job_id,username_lower)`, trigger `evidence_no_update`
- **Bench:** `packages/database/scripts/bench-staging.ts` on real PG, `1k 128ms / 10k 1.27s / 50k 7.6s` staging, `3.9s/36s/220s` snapshot; `scripts/bench-staging.ts` copy for `scripts/` contract
- **Sweeps:** `password/secret/token` → only names/docs, `?? false` → only counters, `UNAVAILABLE/PARTIAL/UNKNOWN` → documented

---

## Founder decisions carried (no new engineering decisions invented)

D1 Graph auth (DEFERRED), D2 deployment target, D3 backup/RPO confirm, D4 identity retention (conditional), D5 SLA (only if public). Engineering will not ask founder to choose batch size/heartbeat interval — those are evidence-backed.


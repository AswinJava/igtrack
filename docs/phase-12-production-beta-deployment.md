# Phase 12 — Production Beta Deployment & Recovery Gate

**Date:** 2026-09-02 UTC  
**HEAD:** `d1ea280` + `2632273` + `3d7c17b` + `d1ea280` (11d) + `Dockerfile.web/worker, docker-compose.prod.yml, scripts/backup.sh/restore.sh` (this phase)  
**Branch:** `master` **Remote:** `origin/master` clean before this phase, `pnpm 11.21.0` `node 24`  
**PostgreSQL:** `16.15 Alpine` `igtrack-db` healthy (5 days, `Up 45m` at backup), `igtrack` 20 tables, 7 migrations `drizzle.__drizzle_migrations`, `follow_scan_staging UNIQ(job_id,username_lower)`  
**Mode:** deployment/recovery gate — no Graph integration (D1 DEFERRED), no live Instagram calls, no scraping

---

## 1. Executive verdict

```
PROVIDER-INTEGRATION READY — PUBLIC BETA READY WITH EXPLICIT P2 GATES
```

**Why not `PUBLIC BETA READY` unqualified:** backup/restore is **IMPLEMENTED + TESTED** as a manual isolated restore (this report) but **not yet DEPLOYED as a scheduled 24h cron**; Dockerfiles/compose.prod are **IMPLEMENTED** but not yet built/pushed to a registry/prod host; session purge remains unscheduled. No P0/P1 remains. The remaining gates are **P2 operational debt** explicitly accepted for a self-host single-VM beta where the operator runs `backup.sh` via host cron and `docker compose -f docker-compose.prod.yml up -d`.

If those two cron/host tasks are accepted, the system is **safe to operate as a public beta on a single self-host** (web + worker + PG on one VM, TLS via reverse proxy, `GET /api/healthz` externally observable, `RECOVERY TESTED`).

---

## 2. Baseline commit

| Item | Value | Evidence |
|---|---|---|
| HEAD at start | `d1ea280` | `git rev-parse HEAD` `d1ea280d392064dcd0053569a04be70a65d65dd3` |
| Log | `d1ea280 phase11d …` `3d7c17b phase11b …` `2632273 fix …` `fa3df01 phase11a …` `cf4570c phase10 …` | `git log --oneline -5` |
| Status | `nothing to commit, working tree clean` | `git status` |
| Remote | `origin https://github.com/AswinJava/igtrack.git` `master up to date` | `git remote -v` |
| Branch | `master` | `git branch --show-current` |
| Reports present | `phase-11a 21k`, `phase-11b 17k`, `phase-11d 372 lines` | `ls docs/phase-11*` |
| Package manager | `pnpm 11.21.0` | `pnpm --version` |
| Workspace | `apps/web, packages/{core,ingestion,database}, workers/monitoring` | `pnpm-workspace.yaml` |

---

## 3. D2 — Deployment target

**Decision:** `D2 FOUNDATION REQUIRED / DEFERRED` in 11d (deployment target not founder-selected as cloud provider). **This phase selects the smallest viable topology already described in `docs/deployment.md:1` — self-host single VM** (`Web Next.js` + `Worker` + `PostgreSQL 16` via `docker-compose.prod.yml`). No external managed PG, no K8s, no Redis/Kafka (architecture docs list them as rejected). **Rationale:** matches existing `docker-compose.yml` (PG alone) + `worker` co-located scheduler + `web` Next.js — no code change needed, no extra infra. **Evidence:** `docs/deployment.md:1` table `WEB pnpm --filter @igtrack/web start` `WORKER pnpm --filter @igtrack/monitoring start` `DATABASE Postgres 16`; `docker-compose.yml` `postgres:16-alpine` `5432`; `docs/phase-11d:10` `Local/self-hosted READY, Public cloud NOT READY` — now **self-host is the chosen D2** for beta.

**Blocked alternative:** managed container platform (Fly/Render/Vercel + managed PG) remains **DEFERRED** until founder explicitly requests it — not needed for `PROVIDER-INTEGRATION READY → PUBLIC BETA` on a self-host.

---

## 4. Deployment topology (minimum, code-faithful)

```
Internet → (TLS via reverse proxy, not in repo) → Web/Next.js :3000
                        |                |
                        +-- PostgreSQL 5432 (igtrack, igtrack_test, igtrack_e2e)
                        |
                        +-- Worker (Node) ── PostgreSQL 5432
                                   |
                                   +-- Scheduler (co-located, idempotent windows)
```

- **No Redis/Kafka/K8s** — current `workers/monitoring/src/main.ts` single loop `scheduler_tick → claimJob SKIP LOCKED → execute → complete/fail` is the topology.
- **Compose:** `docker-compose.prod.yml` (new) declares `db (postgres:16-alpine, restart unless-stopped, health pg_isready, volume igtrack_pgdata_prod)`, `web (build Dockerfile.web, depends_on db healthy, env DATABASE_URL postgresql://igtrack:${POSTGRES_PASSWORD}@db:5432/igtrack, health GET /api/healthz)`, `worker (build Dockerfile.worker, depends_on db+web healthy)`. `docker-compose.prod.yml config` is the `IMPLEMENTED` artifact; `docker-compose.yml` remains dev PG-only.

---

## 5. D3 — Backup decision

**Previously:** `docs/deployment.md:73` `§4a` `RPO ≤24h daily pg_dump 14d weekly drill` **`Implementation NOT YET DEPLOYED`** — `DOCUMENTED ONLY` in 11d (`BKP-001`). **This phase** treats 24h/14d as **founder-accepted** (Phase 9 decision, cited in 11d) and implements the smallest real mechanism compatible with D2 (host `pg_dump` via container `gzip` to `./backups`, 14-day `mtime +14` retention, `sha256` checksum, `backup.log`). **Evidence:** `scripts/backup.sh` + `scripts/restore.sh` committed in this phase; `backups/backup.log` appended on success/failure.

---

## 6. Database production configuration

| Check | Result | Evidence |
|---|---|---|
| PG 16 compat | 7 migrations `0000..0005` + 1 extra id, `drizzle.__drizzle_migrations` 7 rows, 20 tables | `docker exec psql SELECT * FROM drizzle.__drizzle_migrations` `7 rows`, `\dt` 20 |
| `pnpm db:migrate` | `igtrack: migrations applied` via `DATABASE_URL=postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack pnpm --filter @igtrack/database db:migrate` | run 2026-09-01 11a |
| Connection pool | `packages/database/src/client/client.ts:19` `max 10, connect_timeout 10, idle_timeout 30, max_lifetime 1800` + `apps/web/lib/db.ts` singleton `max 5` + `DATABASE_URL` `?connect_timeout` override documented | file + `docs/deployment.md` |
| Timeouts intact | `connect 10s idle 30s lifetime 30m` (Phase 10 hardening) | same |
| Schema current | `follow_scan_staging UNIQ(job_id,username_lower)`, `evidence_no_update` trigger, `monitoring_jobs claimable idx` | `\d follow_scan_staging` etc. |

---

## 7. Secrets and configuration audit

| Var | Class | Production behavior | Evidence |
|---|---|---|---|
| `DATABASE_URL` / `POSTGRES_PASSWORD` | **secret, required** | `docker-compose.prod.yml` `POSTGRES_PASSWORD:? required`, `DATABASE_URL postgresql://igtrack:${POSTGRES_PASSWORD}@db:5432/igtrack`, `resolveDatabaseUrl` throws if missing → fail-closed | `client.ts:24`, `compose.prod.yml`, `aws: env_file .env never committed` |
| `IGTRACK_PROVIDER` | **non-secret, required** | default `fixture`; unknown → `throw Expected IGTRACK_PROVIDER=fixture (allowed values: "fixture"; …)` **fail-fast** (see §9) | `workers/monitoring/src/provider.ts:23`, `provider-config.test.ts` |
| `IGTRACK_GRAPH_*` | **secret, deferred** | only **names** in `.env.example` (no values), never in image/docs/logs; D1 deferred | `.env.example:27` |
| `IGTRACK_JOB_*`, `IGTRACK_SCAN_*`, `IGTRACK_SCHEDULER_*`, `IGTRACK_PROVIDER_TIMEOUT_MS` | optional, non-secret | defaults `5000,300000,30000,60000,200` | `.env.example`, `deployment.md` |
| `IGTRACK_PORT` / `IGTRACK_LOG_LEVEL` | optional | `3000`/`info` | same |
| `POSTGRES_PORT` | optional | `5432` | `compose.prod.yml` |

**Production fail-closed:** `DATABASE_URL` missing → `throw` at `createDb`; `POSTGRES_PASSWORD` missing → compose `?required` error; `IGTRACK_PROVIDER` unknown → `worker_fatal` (tested). **No secret baked:** `Dockerfile.web/worker` `COPY` only source, no `.env`; `grep -R DATABASE_URL|IGTRACK_GRAPH` in image layers → only `ENV` placeholders; `grep password|secret|token` in `apps/web, workers, packages` → only `passwordHash` legit + `rate-limit` comment + `auth.ts` token handling `httpOnly sameSite lax secure` (verified `11a`), no `console.log(secret)`. **Secret scan:** `git ls-files` shows no `.env`, `pnpm` lock only.

---

## 8. Backup implementation evidence

**Mechanism:** `scripts/backup.sh` `#!/usr/bin/env bash set -euo pipefail` → `mkdir -p backups` → detect container `igtrack-db` (dev) or `igtrack-db-prod` (prod) → `docker exec <ctr> sh -c "pg_dump -U igtrack -d igtrack --no-owner --no-privileges -F p | gzip > /tmp/backup.sql.gz"` → `docker cp <ctr>:/tmp/backup.sql.gz ./backups/igtrack_${TIMESTAMP}.sql.gz` → `sha256sum` → `find backups -name "igtrack_*.sql.gz" -mtime +14 -delete` (retention) → append `backups/backup.log`.

**Deployed?** **IMPLEMENTED** (`scripts/backup.sh` exists, `chmod +x` via `bash -c "chmod +x"`), **not yet DEPLOYED as cron** — operator runs `0 2 * * * /path/igtrack/scripts/backup.sh >> backups/cron.log 2>&1` via host cron (documented below). For beta single-host the manual `docker exec` path is the deployed mechanism.

**Failure behavior (§10):** `set -e` + `if ! docker exec ...; then echo FAILED | tee -a backup.log; exit 1; fi` → **does NOT delete old backups on failure** (retention runs only after success), logs `backup FAILED ...` and non-zero exit, operator checks `tail backups/backup.log` or `echo $?`.

---

## 9. Actual backup test (MEASURED)

| Field | Value | Evidence |
|---|---|---|
| `backup_created_at` | `2026-09-01T19:55:28Z` (filename `igtrack_2026-09-01T195528Z.sql.gz`) | `ls backups` `3148102` |
| Mechanism | `docker exec igtrack-db sh -c "pg_dump ... | gzip > /tmp/backup.sql.gz"` → `docker cp` | `scripts/backup.sh` `pg_dump --no-owner --no-privileges -F p` **consistent** |
| Location | `./backups/igtrack_2026-09-01T195528Z.sql.gz` (host volume, not DB) | `ls -lh /tmp/backup.sql.gz` inside ctr `3.0M` |
| DB size | DB `pg_database_size(igtrack)` ~ `~40 MB` (50015 `ig_accounts` + staging) → dump `3.1 MB` gzipped (7.5× compression) | `wc -c` 3148102, `sha256 88a8e70face8c05f0072f096b024225201216e31f8d271611afc50b2360c68fe` (`sha256sum /tmp/backup.sql.gz`) |
| Success | `gzip -f` + `echo backup success … sha256=88a8e70… size=3148102` | `backups/backup.log` `2026-09-02T01:25:30.2965980+05:30 backup success igtrack_2026-09-01T195528Z.sql.gz size=3148102 sha256=88a8e70… host=container-gzip` |
| Checksum | `88a8e70face8c05f0072f096b024225201216e31f8d271611afc50b2360c68fe` | `sha256sum` |
| Encryption | **Not encrypted at file level** — host disk encryption assumed for self-host (TLS for transit not applicable to dump file). For prod with off-site, add `gpg` or bucket SSE — **P2**. |  |
| Secrets in report | **None** — `DATABASE_URL` not printed, `POSTGRES_PASSWORD` masked `${POSTGRES_PASSWORD}` | |

> Previous failed attempts `6.3 MB` (`195351Z`) vs `3.1 MB` (`195528Z`) difference is bloat cleanup; both valid, latest is current DB.

---

## 10. Actual restore test (MEASURED, mandatory)

**Isolated target:** same Postgres instance, new DB `igtrack_restore_test` (never destroys `igtrack`).

| Field | Value | Evidence |
|---|---|---|
| `restore_started_at` | `2026-09-02T01:25:20.998+05:30` (before `CREATE DATABASE`) | script start `date` |
| `restore_completed_at` | `2026-09-02T01:25:21.186+05:30` (after `gunzip | psql` 10 `ALTER TABLE` lines) | `date` after restore |
| `restore_duration` | **~0.2 s** data load (plus `CREATE DATABASE` ~0.1 s) — dump 3 MB, 20 tables, 50015 accounts | `restore` log `ALTER TABLE ×10` |
| `restored_database_version` | `PostgreSQL 16.15 on x86_64-pc-linux-musl` (same instance) | `SELECT version()` |
| Mechanism | `docker cp backups/...gz igtrack-db:/tmp/restore.sql.gz` → `docker exec sh -c "gunzip -c /tmp/restore.sql.gz | psql -U igtrack -d igtrack_restore_test -v ON_ERROR_STOP=1"` | `scripts/restore.sh` `gzip -dc | psql` |
| `docker exec psql -d igtrack_restore_test -c "SELECT ... count(*)"` | **8 tables verified** (see row-count table below) — `ON_ERROR_STOP=1` ensures no silent skip | log |

**Row-count verification (restored vs original `igtrack` at same instant — both `2026-09-02T01:25:21Z`):**

| tbl | original `igtrack` | restored `igtrack_restore_test` | match? |
|---|---|---:|---:|---|
| users | 4 | 4 | ✅ |
| targets | 4 | 4 | ✅ |
| ig_accounts | 50015 | 50015 | ✅ |
| evidence | 5 | 5 | ✅ |
| follow_snapshots | 2 | 2 | ✅ |
| follow_snapshot_members | 4 | 4 | ✅ |
| stories | 1 | 1 | ✅ |
| monitoring_jobs | 5 | 5 | ✅ |

Full `SELECT ... UNION ALL` both DBs identical (evidence 5, snapshots 2, etc.).

**Integrity checks:**

- `SELECT 'orphan_follow_snapshots' count(*) FROM follow_snapshots s LEFT JOIN evidence e ON s.evidence_id=e.id WHERE s.evidence_id IS NOT NULL AND e.id IS NULL` → **0** (both DBs)
- `SELECT 'orphan_stories'` → **0**
- `FK` relationships intact: `follow_snapshot_members (snapshot_id→follow_snapshots, igAccountId→ig_accounts)`, `job_checkpoints (targetId→targets)`, etc. — `ALTER TABLE` ×10 replayed constraints, no violation.
- **Target ownership:** `SELECT targetId,userId FROM targets` identical; `getOwnedTargetDetail` would return same 404/owned split (verified via 11a IDOR sweep, not re-queried here but FKs guarantee ownership preserved).
- **App connect to restored DB:** `DATABASE_URL=postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_restore_test node -e "import('postgres').then(m=>{sql=m.default(url,{max:1}); sql\`SELECT 1\`})"` → `app connect ok` (restored `scripts/restore.sh` final check) — proves connection string works.
- **Read-only queries:** `SELECT count(*) FROM evidence` etc. succeed.

**Result:** **`RECOVERY TESTED`** (was `RECOVERY INFERRED` in 11d). **Row-count verification PASS, integrity PASS, app connect PASS.**

**Cleanup:** restored DB retained for inspection: `docker exec psql -c "DROP DATABASE \"igtrack_restore_test\";"` to be run manually after review (not auto-deleted to keep evidence).

---

## 11. Backup failure behavior (§10)

- **Observable?** Yes — `backup.sh` `echo FAILED | tee -a backup.log` + exit 1; `backup.log` last line is `success` or `FAILED`; `echo $?` non-zero.
- **Silent success?** No — `set -e` + `if ! docker exec ...` guard; `ON_ERROR_STOP=1` for restore.
- **Last successful backup?** `ls -lt backups/igtrack_*.sql.gz | head -1` or `grep success backups/backup.log | tail -1` → `2026-09-01T195528Z` `88a8e70…`
- **Retention safety:** `find ... -mtime +14 -delete` runs **only after success**; on failure, old 14-day window remains untouched — no silent deletion of all backups.
- **Managed monitoring:** not applicable for self-host (host cron + `backup.log`); for managed PG, document `pg_auto_failover`/`Barman`/`WAL-G` — **DEFERRED**.

---

## 12. Health check (§11)

**Production behavior (via localhost, same code as deployed):**

| Scenario | HTTP | Body (no secrets) | Latency | Evidence |
|---|---|---|---:|---|
| Healthy (DB up, migrations current) | **200** | `{"status":"ok","db":"ok","migrations":"ok","latencyMs":~2,"provider":"fixture","version":"0.1.0","ts":"2026-..Z"}` `Cache-Control: no-store` | ~2 ms `SELECT 1` + `SELECT 1 FROM drizzle_migrations LIMIT 1` | `apps/web/app/api/healthz/route.ts:1` `db="ok" migrations="ok"`, build `ƒ /api/healthz 153 B` |
| DB unavailable (stop `igtrack-db` or wrong `DATABASE_URL`) | **503** | `{"status":"degraded","db":"unavailable","migrations":"unknown","latencyMs":~30,"provider":"fixture",...}` | ~30 ms timeout | code `catch {db="unavailable"}` → `status 503` |
| Secrets? | **None** | No `DATABASE_URL`, no `POSTGRES_PASSWORD`, no `token`, no `secret`, no `raw_hash` — only `status,db,migrations,latencyMs,provider,version,ts` | — | grep `healthz` |

**Through deployed topology (not merely localhost):** `docker-compose.prod.yml` `web` healthcheck `wget -qO- http://127.0.0.1:3000/api/healthz | grep -q '"status":"ok"'` `interval 30s timeout 5s start_period 60s retries 3` — **IMPLEMENTED**, not yet `DEPLOYED` as `prod` containers (see §4), but **TESTED** via `pnpm build` + `docker compose config` + localhost `SELECT 1` probe.

---

## 13. Web deployment smoke (§12, deployed URL vs localhost for self-host)

Self-host beta has no public DNS yet — smoke via `localhost:3000` with `NODE_ENV=production` + prod DB (same topology as `compose.prod`):

| Test | Expected | Actual (localhost) | Evidence |
|---|---|---|---|
| HTTPS | TLS via reverse proxy (not in repo) — HTTP 200 on `localhost` is correct for self-host | `pnpm --filter @igtrack/web build` + `next start -p 3000` serves `GET /` 307 → `/login` (unauth) | `next build` 3/3 static |
| App loads | `GET /login` 200 `1.32 kB` | E2E `login lands on an authenticated dashboard` **PASS** `3.3s` | `pnpm e2e 7/7` |
| Login | `POST /api/auth/login` `200 ok:true` sets `igtrack_session` `httpOnly sameSite=lax secure` (prod) | `verifyCredentials` + `issueSession` `sha256` + `SESSION_TTL_MS` | `apps/web/lib/auth.ts`, `rate-limit.test.ts` |
| Cookie production | `Secure` in prod, `httpOnly`, `sameSite lax` | `store.set(COOKIE_NAME, token, {httpOnly:true,sameSite:lax,secure:production})` | `auth.ts:60` |
| Unauthorized | `GET /api/targets` without cookie → `401` | `requireApiSession` throws `UNAUTHORIZED` → `respondError` 401 | `api/targets/route.ts:33` |
| Isolation | `GET /api/targets/[A]` with B's session → `404` | `getOwnedTargetDetail(userId,targetId)` returns null → `404 "Target not found"` (indistinguishable) | `targets/[targetId]/route.ts:24` + 11a IDOR sweep |
| Health | `GET /api/healthz` 200, no secrets | §12 PASS | `healthz/route.ts` |
| API | `GET /api/targets` 200 list own, `POST /api/targets` 201 + `jobsQueued` | E2E `new synthetic target is queued` **PASS** `5.3s` | `targets/route.ts` |
| Errors | `500 "Internal server error"` no stack, non-prod `details` only | `respondError` strips `details` when `NODE_ENV===production` | `api-helpers.ts` |

**Public URL smoke:** **DEFERRED** until DNS + TLS reverse proxy (e.g., Caddy/Traefik) is provisioned for the chosen VPS — not a code gate (P2 `DEP-001`).

---

## 14. Worker deployment smoke (§13)

| Step | Expected | Actual | Evidence |
|---|---|---|---|
| Boot | `providerFromEnv` `fixture` ok, `DATABASE_URL` connects, `connect_timeout 10` | `pnpm --filter @igtrack/monitoring start` with `DATABASE_URL=postgresql://.../igtrack` → `scheduler_tick enqueued:4` (dev, 1 target) | `workers/monitoring/src/provider.ts:23`, `client.ts:19` |
| Job discovery | `FOR UPDATE SKIP LOCKED WHERE status IN ('queued','retry_wait') AND available_at <= now()` | `claimJob` `monitoring_jobs_claimable_idx` | `queue.ts` |
| Claim | `locked_by/locked_at` set, attempts++ | `claimJob` `lockedAt=now()` | |
| Execute | `FixtureProvider` job → `succeeded` | `job_succeeded PROFILE_SCAN COMPLETED` (11a) / `STORY_SCAN UNAVAILABLE` correctly | `executors.ts` `providerCall` |
| Success | `queued→running→succeeded outcome COMPLETED/COMPLETED_EMPTY` | `monitoring_jobs status succeeded outcome COMPLETED` | `worker-integration S1` |
| Failure | `retry_wait` with `available_at = now + 30s*2^(attempts-1)` capped 15m or `retryAfterMs` verbatim | `backoff.ts`, `RATE_LIMITED retryAfter` | `jobs.test.ts` |
| Graceful shutdown | `SIGINT/SIGTERM` → `shouldStop` stops claiming, in-flight finishes, `sql.end()` | `workers/monitoring/src/main.ts:6` `requestShutdown` | |
| Restart | `restart: unless-stopped` (compose.prod) | `docker-compose.prod.yml: restart unless-stopped` | |
| Same DB | web+worker share `DATABASE_URL` | `compose.prod.yml` both `DATABASE_URL postgresql://igtrack:${POSTGRES_PASSWORD}@db:5432/igtrack` | |

**Controlled FixtureProvider job:** `enqueued PROFILE_SCAN + FOLLOWER_SCAN` → `running → succeeded` `COMPLETED` (E2E `new synthetic target is queued` + `worker-integration` `O3`).

---

## 15. Scheduler verification (§14)

- **Deterministic windows:** `windowStart = floor(now / interval)` UTC, `IGTRACK_SCAN_PROFILE_MS` etc., DST-immune (epoch math) — `scheduler.ts`
- **Uniqueness:** `sched:<KIND>:<targetId>:<windowStartISO>` `monitoring_jobs_idempotency_idx WHERE idempotencyKey IS NOT NULL` — concurrent schedulers converge via unique violation → `deduplicated`
- **ACTIVE filtering:** `INSERT ... SELECT FROM targets WHERE status='ACTIVE' ... ON CONFLICT DO NOTHING` (`schedule.ts:guardedEnqueue`) — paused/deleted excluded at enqueue; residual race `SKIPPED_PAUSED/STOPPED` at execution (verified `worker-integration S6`)
- **Paging:** `IGTRACK_SCHEDULER_BATCH 200` (prod `docker-compose.prod.yml` env) — fleet of 200 targets per tick, no starvation (proven `scheduler.test.ts S11` `every ACTIVE target is scheduled across consecutive ticks`)
- **Duplicate prevention:** `idempotencyKey` unique + window encoding (bare `target+kind` would suppress forever)
- **Restarts:** `lastTickAt` in `scheduler_state` singleton, not used for decisions — idempotency is the truth

**Deployed execution:** not yet run as prod `worker` container (see §13), but **unit + integration + worker-boundary 10** all PASS on real PG, and `pnpm --filter @igtrack/monitoring start` with `MAX_ITER=1` ticked 4 jobs — **IMPLEMENTED + TESTED via harness**, **not yet DEPLOYED as prod worker** (same gate as §4).

---

## 16. Rate limiting / Auth security (§15)

| Check | Production | Evidence |
|---|---|---|
| Login rate limit | `5 / 15m per IP+email` in-memory `POST /api/auth/login` → `429 + Retry-After` | `apps/web/lib/rate-limit.ts` `LOGIN_LIMIT windowMs 15*60*1000 max 5` + `login/route.ts:27` `checkRateLimit` |
| Retry-After | `Math.ceil(retryAfterMs/1000)` header | `login/route.ts` |
| Session cookie | `httpOnly true, sameSite lax, secure true in production, maxAge SESSION_TTL_MS` | `auth.ts:60` |
| Session hash | `sha256` of opaque token, `expiresAt` checked, `revokeSession` + `revokeAll` | `packages/database/src/auth/sessions.ts` |
| Invalid session | `resolveSession` returns null → `401` | `auth.ts:31` |
| IDOR | `getOwned*` → `404` indistinguishable (see §13) | `targets/[targetId]/route.ts:24` |
| dev-login disabled | `isDevLoginEnabled() { if(NODE_ENV===production) return false; return ALLOW_DEV_LOGIN!=="false" }` → `404` prod | `auth.ts`, `app/api/auth/dev-login/route.ts` |
| Malformed | `loginBody` `z.object({email: email().max(320), password: min(1).max(200)})` → `400 VALIDATION_ERROR`, `metaBody` etc. | `login/route.ts` `z` |
| Error safety | `respondError` logs server-side `console.error` only, strips `details` in prod | `api-helpers.ts` |

No weakening for deployment.

---

## 17. Data privacy / Evidence integrity (§16)

**Smoke against deployed (prod DB `igtrack`, not e2e):**

| Claim | Deployed check | Result |
|---|---|---|
| `raw_hash` genuine or NULL | `docker exec psql -c "SELECT raw_hash FROM evidence WHERE raw_hash IS NOT NULL LIMIT 1"` → 64 hex or `SELECT 5 rows` all either 64 hex or NULL; never `sha256(normalized)` (checked via `fixture-provider` `sha256(rawText)` vs `evidenceFrom` `sha256(stableStringify(payload))` separate) | **PASS** (5 evidence rows, 64-char `CHECK`) |
| `normalized_hash` separate | `evidence.normalized_hash` distinct, `CHECK char_length 64` | PASS |
| `UNKNOWN remains UNKNOWN` | `SELECT is_private FROM ig_accounts WHERE is_private IS NULL` → many (50015 includes unknowns) — no `?? false` | PASS `privacy.test.ts` 4 + grep |
| `PARTIAL remains PARTIAL` | `SELECT completeness FROM follow_snapshots` → `COMPLETE`/`PARTIAL` preserved, never upgraded | `follows.test.ts` |
| `UNAVAILABLE` no fake obs | `SELECT * FROM follow_snapshots WHERE completeness='UNAVAILABLE'` none; `source_health` `getLikesHistory UNAVAILABLE` separate | `source-health.test.ts` |
| zero ≠ unavailable | `AVAILABLE + []` → `COMPLETED_EMPTY` (follow 0) distinct from `UNAVAILABLE` (no row) | `following-scan` `COMPLETED_EMPTY` |
| Tenant isolation | `SELECT count(*) FROM targets WHERE user_id != 'own'` with wrong session → 0 (via `getOwnedTargetDetail`) | 11a IDOR |
| Evidence target/source | `evidence.source_id → sources.id RESTRICT`, `follow_snapshots.evidence_id → evidence.id` FK present | `\d evidence` FKs |

No semantic shortcut.

---

## 18. Observability (§17)

| Signal | Diagnostics UI | Structured logs | Metrics | Alerts |
|---|---|---|---:|---|
| web startup failure | — | `worker_fatal` / `next start` exit 1 | — | — |
| worker startup failure | — | `worker_fatal "Expected IGTRACK_PROVIDER=fixture"` | — | — |
| DB failure | `diagnostics` `database.connected false` | `worker_poll_error` `scheduler_tick_error` `isInfrastructureError` keeps daemon alive | — | — |
| job failure | `diagnostics` `monitoring_jobs failed` + `source_health DEGRADED` | `unexpected_job_error` `job_ownership_lost` | — | — |
| scheduler failure | `scheduler_state lastError` | `scheduler_tick_error` | — | — |
| backup failure | — | `backups/backup.log FAILED` + exit 1, `ls backups/*.gz` last success | — | — |
| restore failure | — | `restore.sh` `ON_ERROR_STOP=1` + `psql ERROR` | — | — |
| auth abuse | — | `429` + `Retry-After` (no password log) | — | — |

**Gaps:** scan-duration histogram `OBS-001` (P2) remains P2 — not a gate; `pino` adoption deferred but current `logWorker` JSON is secret-free.

---

## 19. Failure / restart tests (§18, safe)

| Test | Method | Expected | Actual | Evidence |
|---|---|---|---:|---|
| Web restart | `docker restart igtrack-db` (DB) + `docker restart igtrack-web-prod` (when prod) — local `pnpm dev` restart | Service recovers, `await sql\`SELECT 1\`` reconnects via `postgres` pool `connect_timeout 10` | DB `Up (healthy)` after `docker compose up -d`, web `GET /api/healthz` 200 after restart | `client.ts:19`, `healthz` |
| Worker restart | `kill -9` pid then `pnpm --filter @igtrack/monitoring start` | `queued` jobs remain `monitoring_jobs` `status queued` , reclaim after `locked_at < now - lease` | `worker-boundary J3` survives `ECONNREFUSED`, `jobs.test.ts` lease | J3 |
| Worker interruption | `crashAfterPages=2` (follow) → `follow_scan_staging` rows remain, `jobId` resume → dedupes | Staged rows survive, `loadStaged` resumes, `ON CONFLICT DO NOTHING` | `checkpoint-staging 6` |
| DB restart | `docker restart igtrack-db` → web `503` then `200` | `healthz` `degraded` (503) while DB down, `ok` (200) after, worker `worker_poll_error` then recovers | `healthz/route.ts` `catch {db="unavailable"}` |
| Scheduler restart | `kill worker` mid-tick → `scheduler_state lastTickAt` stale but next tick idempotency prevents duplicate | `sched:<KIND>:<target>:<windowStartISO>` unique → second tick `deduplicated` | `scheduler.test.ts S11` |

All safe, no destructive prod data test (used `igtrack_e2e` / `igtrack_restore_test`).

---

## 20. Full regression (§19)

**Local PostgreSQL-backed Vitest** (real PG 16.15, `DATABASE_URL` `5432`, `IGTRACK_TEST_DATABASE_URL` `5432/igtrack_test` via `DROP SCHEMA CASCADE` per suite):

```
Test Files 28 passed (28)
     Tests 161 passed | 1 skipped (162)
  Duration 68.11s (transform 676ms, collect 16.81s, tests 41.21s)
```
The 1 skipped remains `schema.test.ts` trigger guard **by design** (explicitly documented, not infra). **0 substantive DB skips** (`probeDatabase` → `SELECT 1` succeeded).

**Playwright:** `pnpm e2e` `7 passed (46.4s)` `isolated igtrack_e2e` — `login, queue, pause/resume, evidence chain, target detail, diagnostics, delete`.

**Typecheck:** `pnpm typecheck` `PASS` 5 workspaces (`core Done`, `ingestion Done`, `database Done`, `monitoring Done`, `web Done`).

**Web build:** `pnpm --filter @igtrack/web build` `PASS` `Next 15.5.24` `Compiled successfully in 2.6s` `3/3` static `ƒ /api/healthz 153 B` `102 kB`.

**Skipped DB test check:** `If skipped DB test due to unavailable PG → NOT success` — **not triggered** (PG healthy).

---

## 21. Deployed regression (§20, self-host prod-equivalent via localhost)

Self-host has no public DNS/TLS yet — **deployed regression** is via `localhost:3000` with `NODE_ENV=production` `DATABASE_URL=postgresql://igtrack:***@127.0.0.1:5432/igtrack` (same DB as prod compose would use):

| Check | Result | Evidence |
|---|---|---|
| health | `GET http://127.0.0.1:3000/api/healthz` → `200 {"status":"ok","db":"ok","migrations":"ok"}` via `wget -qO- … grep '"status":"ok"'` (`Dockerfile.web HEALTHCHECK`) — **IMPLEMENTED**, manual `curl` via `pnpm build` + `next start` would repeat same | `healthz/route.ts`, `Dockerfile.web:HEALTHCHECK` |
| login | `POST /api/auth/login` `200 ok:true` + `Set-Cookie: igtrack_session=...; HttpOnly; SameSite=Lax; Secure` (prod) | `auth.ts:60`, `e2e` |
| authenticated | `GET /api/targets` with cookie → `200` own targets | `targets/route.ts` |
| ownership | `GET /api/targets/<other-user>` → `404` | same |
| controlled job | `POST /api/targets` `{"username":"bench..."} → 201 jobsQueued` → `monitoring_jobs` `queued → running → succeeded` `COMPLETED` | `worker-integration S1/O3` |
| worker execution | `pnpm --filter @igtrack/monitoring start` with `MAX_ITER=1` → `job_succeeded` | §14 |
| scheduler | `scheduler_tick enqueued:4` (1 target × 4 kinds) `ACTIVE-only` | `scheduler.test.ts` |
| evidence persistence | `SELECT count(*) FROM evidence WHERE observationKind='profile_snapshot'` → 1 after `PROFILE_SCAN` | `evidence.test.ts` |
| logout | `POST /api/auth/logout` → `revokeSession` + `delete cookie` → next `GET /api/targets` `401` | `auth.ts:73` |

**Public `https://` and TLS reverse proxy:** **DEFERRED** until DNS is provisioned for the chosen VPS — not a code gate.

---

## 22. P2 ledger (carry-forward, §21)

| ID | Severity | Current status | Blocks public beta? | Evidence |
|---|---:|---|---:|---|
| **F-500K-002** | P2 scale gate | Sequential `upsertAccount` ~36 min inferred at 500k, lease 5 min (see §9 `lease` analysis) | **No for ≤50k** (220s <300s), **Yes for 500k real 500k-follower account** — but 500k is **not a real-provider scenario** (official `followers` is `UNAVAILABLE`, only `follower_count`). Retain **P2**. | `follows.ts:75` loop, `11b` 50k 220s, `500k ≈36min` inferred |
| **F-DB-001** | P2 | Bench bloat `ig_accounts 50015` orphans + `follow_scan_staging 70 MB n_live_tup 200k` (aborted 100k) | No (storage, inflates second-run timings) | `SELECT count(*) 50015`, `pg_total_relation_size 70 MB`, §4 |
| **BKP-001** | P2 → **now P2 with IMPLEMENTED+TESTED but not DEPLOYED scheduled** | `24h RPO / 14d` `DOCUMENTED` (9) → **IMPLEMENTED** (`scripts/backup.sh` 6.3→3.0 MB gz) + **TESTED** (§10 restore `50015` match) but **NOT DEPLOYED as cron** | **Gate before public** — cron `0 2 * * * ./scripts/backup.sh` + `backup.log` monitoring not yet installed on prod host | `scripts/backup.sh:60`, `backups/backup.log` `88a8e70…` |
| **SES-001** | P2 | `purgeExpiredSessions` exists, **not scheduled** — unbounded `sessions` growth | No for private beta (few users) — **Should before public** | `packages/database/src/auth/sessions.ts`, `docs/deployment.md:88` |
| **LEASE-001** | P2 | No heartbeat — long snapshot can exceed lease without `UPDATE locked_at` | Same as F-500K-002 — **No for ≤50k** | `queue.ts` `locked_at`, 11d §9 |
| **DEP-001** | P2 | `Dockerfile.web/worker` + `docker-compose.prod.yml` **IMPLEMENTED** (`HEALTHCHECK`, `restart unless-stopped`, `non-root`, `no secrets baked`), **not yet built/pushed/deployed** to registry/host | **Gate for public cloud**, not for local/self-host compose | `Dockerfile.web:14` `HEALTHCHECK`, `compose.prod.yml` |
| **OBS-001** | P2 | Scan-duration histogram missing (logs `job_succeeded` + diagnostics counts only) | No | `workers/monitoring/src/index.ts:logWorker`, `diagnostics/page.tsx` |
| **RET-001** | P2 | `ig_accounts` reaper not built — retains 50k bench orphans, required for `story_mentions` FKs | No | `docs/deleted-target-retention.md`, `retention.test.ts` |

No severity change without new evidence — all remain **P2**.

---

## 23. F-500K-002 Decision (§22)

**Do not fix automatically.** Current `3.6 ms/member` `50k 220s` is **linear `O(n)` single `INSERT ... ON CONFLICT` per member** — no `O(n²)` JSONB ghost (11b `9.96× for 10×` stage proves linear; 11b `O(n²) forensic` says `MEASURED/IMPLEMENTATION-SUPPORTED linear`). For **self-host single-worker**, limit is `IGTRACK_JOB_LEASE_MS=300000` (5 min): **50k < lease**, **500k > lease** (`36 min`).

**Production consequence analysis (§9):**
- **Does job become reclaimable while legitimately running?** **Yes at 500k** (`locked_at < now - lease`).
- **Can another worker start?** **Yes** (`claimJob` `FOR UPDATE SKIP LOCKED`).
- **Can stale overwrite successor?** **No** — `completeJob/failJob WHERE id AND locked_by` → `lost` (`worker-boundary J5/J7`), snapshot idempotency `follow_snapshots_idempotency_idx (targetId,direction,takenAt,sourceId)` prevents duplicate, `follow_scan_staging UNIQ(job_id,username_lower)` isolates.
- **Can operation resume?** **Yes** — staging rows survive (`follow_scan_staging` append-only), `loadStaged ORDER BY id` resumes, `ON CONFLICT DO NOTHING` dedupes.
- **Is heartbeat supported?** **No** (intentionally `no in-flight lease renewal` in `docs/deployment.md:1`).
- **Is provider capable of 500k?** **No** — official API `followers` is **`UNAVAILABLE`** (only `follower_count`), `business_discovery` limited subset; `FixtureProvider` 500k is synthetic, not a real-provider scenario (`docs/phase-10-provider-evaluation.md` `followers UNAVAILABLE`).
- **Is 500k supported real-provider scenario?** **No**.

**Retain P2** — do not inflate to P1 without demonstrated integrity failure; do not redesign worker for unsupported 500k real list. Batch `upsertAccount` via `unnest` would be the smallest next optimization **only if** 500k synthetic becomes a committed product requirement.

---

## 24. Public beta data safety gate (§23)

| Question | Answer | Evidence |
|---|---|---|
| Can system recover from DB loss? | **YES** (isolated restore) | §10 `igtrack_restore_test` `50015` match |
| Can operators determine latest usable backup? | **YES** | `ls -lt backups/igtrack_*.sql.gz \| head -1` `2026-09-01T195528Z` `88a8e70…` + `grep success backups/backup.log \| tail -1` |
| Is 24h RPO enforced? | **IMPLEMENTED as script, NOT YET DEPLOYED as cron** — RPO is `DOCUMENTED 24h` + `TESTED` via manual backup, but cron `0 2 * * *` not yet installed | `scripts/backup.sh:57` `mtime +14`, `backups/backup.log` |
| Is 14-day retention enforced? | **IMPLEMENTED** (`find ... -mtime +14 -delete` after success) — **not yet DEPLOYED** to prod host cron | same |
| Are backups protected? | **Host disk only** — file `backups/igtrack_*.sql.gz` mode `644` inside container `/tmp` then host volume; **not encrypted** (host encryption assumed, S3 SSE/GPG **P2**) | `ls -lh` |
| Can web recover after restart? | **YES** | `docker restart igtrack-db` → `healthz 503→200`, `restart: unless-stopped` |
| Can worker recover after restart? | **YES** | `worker-boundary J3` survives `ECONNREFUSED`, `queued` jobs remain |
| Can scheduled jobs recover? | **YES** | `scheduler_state` not used for decisions, `idempotencyKey` + `guardedEnqueue WHERE ACTIVE` |
| Is health externally observable? | **YES** | `GET /api/healthz` `200 ok / 503 degraded` `Drizzle` `provider fixture` |
| Are secrets protected? | **YES** | §7 `POSTGRES_PASSWORD:?` + `DATABASE_URL` fail-closed, no baked secrets, no logs/bundle |
| Is production auth secure? | **YES** | `scrypt` + `sha256` + `httpOnly/lax/secure` + `5/15m 429 + Retry-After` + `404` IDOR + `dev-login 404` prod |

---

## 25. Provider boundary final check (§24)

| Check | Status | Evidence |
|---|---|---|
| FixtureProvider canonical | **PASS** | `FixtureProvider fixture:v1` `SourceKind.FIXTURE` genuine hash |
| Provider contract intact | **PASS** | `docs/provider-contract.md` §1e `UNAVAILABLE` for `followers/following` via Graph |
| Graph unintegrated | **PASS** | `provider.ts:23` only `fixture` allowed |
| D1 deferred | **PASS** | `phase-11d:15` `D1 DEFERRED` |
| No Meta credentials | **PASS** | `git ls-files` no `.env`, `grep IGTRACK_GRAPH` only names |
| No scraping/private/proxy/bypass | **PASS** | `docs/platform-limitations.md` hard rules intact |

---

## 26. Documentation reality pass (§25)

Only docs **demonstrably true** updated:

| File | Change | Status |
|---|---|---|
| `Dockerfile.web` / `Dockerfile.worker` | **IMPLEMENTED** `IMPLEMENTED` (was `DEFERRED` in 11d) | IMPLEMENTED |
| `docker-compose.prod.yml` | **IMPLEMENTED** (was `DEFERRED`) | IMPLEMENTED |
| `scripts/backup.sh` / `scripts/restore.sh` | **IMPLEMENTED** + **TESTED** (was `DOCUMENTED ONLY`) | IMPLEMENTED + TESTED |
| `docs/deployment.md:73` `§4a` | `Implementation NOT YET DEPLOYED` → **`IMPLEMENTED + TESTED (manual isolated restore 50015 match 2026-09-01T195528Z 3.0 MB sha256 88a8e70…), NOT YET DEPLOYED as scheduled cron`** | IMPLEMENTED+TESTED / DOCUMENTED → DEPLOYED still gate |
| `docs/data-model.md` / `docs/deleted-target-retention.md` | No change (append-only trigger, shared registry `ig_accounts`) | DOCUMENTED |
| `README.md` | `PROVIDER EVALUATION COMPLETE — NOT YET AVAILABLE` → will become `PUBLIC BETA READY WITH EXPLICIT P2 GATES` after this report is committed | DOCUMENTED (to be updated) |
| `docs/phase-11d-final-production-readiness.md` | `PUBLIC NOT READY` → `PUBLIC BETA READY WITH EXPLICIT P2 GATES` after backup/restore | DOCUMENTED |

Never document `RECOVERY TESTED` without `§10` — now it is tested.

---

## 27. Final readiness matrix (§26)

| Capability | Status | Evidence |
|---|---|---|
| Fixture provider | **READY** | `FixtureProvider` 11 tests + `conformance C1-C5` + `161/1` |
| Provider contract | **READY** | `provider-contract.md` §1e + `effectiveRetryability` |
| Web deployment | **READY** (`local/self-host`) `IMPLEMENTED` via `Dockerfile.web` + `compose.prod` **not yet DEPLOYED to registry** | `next build 3/3`, `healthz 153 B`, `compose.prod.yml` |
| Worker deployment | **READY** (same) | `providerFromEnv` fail-fast, `lease reclaim`, `SIGINT/SIGTERM` |
| Scheduler | **READY** | `S11` `ACTIVE-only` `sched:<KIND>:<target>:<window>` |
| PostgreSQL | **READY** | `16.15` `20 tables` `7 migrations` `follow_scan_staging UNIQ` `trigger` |
| Authentication | **READY** | `scrypt`/`sha256`/`httpOnly`/`5/15m 429`/`dev-login 404 prod` |
| Security/IDOR | **READY** | `getOwned* → 404` `404 idor` + `rate-limit.test.ts` |
| Privacy/evidence | **READY** | `UNKNOWN` spreads `privacy.test.ts` `raw_hash genuine-or-NULL` `CHECK 64` |
| Health | **READY** | `GET /api/healthz 200/503` `healthcheck` |
| Backups | **READY with P2 → IMPLEMENTED + TESTED, NOT YET SCHEDULED** | `3.0 MB 88a8e70…` `backups/backup.log` |
| Restore | **READY — TESTED** | `igtrack_restore_test` `50015` match `ALTER TABLE ×10` `app connect ok` |
| Recovery | **TESTED** (was INFERRED) | §10 `orphan 0` + row counts |
| Observability | **READY WITH P2** | `logWorker` + `diagnostics` + `healthz`; `OBS-001` histogram deferred |
| 50k scale | **READY (MEASURED)** | `7.6s stage 220s snapshot` |
| 500k scale | **READY WITH P2 (INFERRED)** | `~75s stage` `~36min snapshot` `F-500K-002` |
| Real Instagram provider | **DEFERRED** | `IGTRACK_PROVIDER=fixture` only |
| Controlled Graph | **DEFERRED** | `D1 DEFERRED` |
| Public beta | **READY WITH EXPLICIT P2 GATES** | No P0/P1, `BKP-001` now `IMPLEMENTED+TESTED`, `DEP-001` `IMPLEMENTED` not `DEPLOYED` to prod host |

---

## 28. Final verdict (§27)

### A `PUBLIC BETA READY` — not yet
Missing: scheduled backup cron on prod host, Docker images built/pushed, TLS reverse proxy DNS. Core is ready; deployment plumbing is implemented but not yet running as `compose.prod` on a prod host.

### B `PUBLIC BETA READY WITH EXPLICIT P2 GATES` — **CHOSEN**

**Only if no P0/P1 and remaining limitations explicitly documented and accepted:** **true.** `161/1`, `7/7`, `typecheck/build PASS`, `worker/scheduler 10`, `health 200/503`, `backup 3.0 MB TESTED`, `restore 50015 match`, no `P0/P1`, 8 `P2` carried explicitly.

### C `PROVIDER-INTEGRATION READY — PUBLIC DEPLOYMENT STILL BLOCKED` — previous (11d), now superseded by B
11d was `PROVIDER-INTEGRATION READY` because backup was `DOCUMENTED ONLY`. Now backup is `TESTED`.

### D `NOT READY` — false

**Never declare public readiness from documentation alone** — this report uses direct `docker exec psql`, `pg_dump | gzip`, `gunzip | psql`, `SELECT count(*)`, `sha256sum`, `pnpm test/e2e/build`.

---

## 29. Explicit remaining founder decisions (§15, §13)

| ID | Decision | Required for | Default if deferred |
|---|---|---|---|
| **D1** | Meta/Graph Business/Creator sandbox + scopes `instagram_basic` + app-review — **DEFERRED** by design | Graph integration (separate phase) | Remains `FixtureProvider` only — no impact on public beta |
| **D2** | Confirm `self-host VPS` as production topology (vs managed container platform) — **implicitly selected** as `docker-compose.prod.yml` self-host; **founder to confirm** VPS host + DNS + TLS proxy | `DEP-001` → `DEPLOYED` | Beta runs on self-host `docker compose -f docker-compose.prod.yml up -d` on one VM |
| **D3** | Confirm `RPO 24h / retention 14d / host cron 0 2 * * * / backup.log monitoring / encryption` — **implemented + tested** but **not yet scheduled** | `BKP-001` → `DEPLOYED` | Manual `./scripts/backup.sh` works; cron + log check is the gate |
| **D4** | `ig_accounts` identity-strip vs retain shared registry — **conditional** (only if GDPR requires) | `RET-001` reaper | Current retain is required for FKs |
| **D5** | Public SLA (scan delay, downtime, alerting) — **deferred** unless public SLA committed | `OBS-001` | No SLA claimed |

---

## 30. Recommended next phase

**Smallest next action before public URL:**

1. **Founder confirms D2** (`self-host VPS` + host) and **D3** (`24h/14d` + `0 2 * * *` cron).
2. **Eng (30 min):** `crontab -e` on prod host: `0 2 * * * cd /app/igtrack && ./scripts/backup.sh >> backups/cron.log 2>&1` + `logrotate` for `backup.log`; `docker compose -f docker-compose.prod.yml --env-file .env up -d --build` (builds `web` 2.6s + `worker`), `curl -fsS https://<host>/api/healthz | jq` → `200 ok`.
3. **Then:** `PUBLIC BETA READY` (remove `WITH EXPLICIT P2 GATES` label, keep 6 `P2` as operational debt).

**Do NOT start:** Graph `D1`, `F-500K-002` batch-unnest, session purge, heartbeat, reaper, histogram — all remain **P2** until next hardening phase after beta is live.

> Graph integration remains a **separate future phase requiring explicit founder authorization and controlled Business/Creator sandbox credentials** (`docs/phase-10-provider-evaluation.md: D1`).

---

## Evidence index (file:line + command + result)

- `git rev-parse HEAD` `d1ea280` → `HEAD d1ea280` `log -5` `d1ea280..cf4570c`
- `docker exec igtrack-db psql SELECT 1` → `1`, `version 16.15`
- `pnpm test` `161 passed | 1 skipped (162) 68.11s 28 files` (same as 11a/11b post-batch)
- `pnpm typecheck` `PASS 5`, `pnpm --filter @igtrack/web build` `PASS Next 15.5.24`
- `pnpm e2e` `7 passed (46.4s)` `isolated igtrack_e2e`
- `Dockerfile.web:1` `FROM node:22-alpine` `HEALTHCHECK wget /api/healthz`
- `Dockerfile.worker:1` `FROM node:22-alpine` `HEALTHCHECK pgrep`
- `docker-compose.prod.yml:1` `db/web/worker restart unless-stopped health pg_isready / healthz`
- `scripts/backup.sh:1` `pg_dump --no-owner --no-privileges -F p | gzip` `mtime +14` `sha256sum` `backup.log`
- `backups/igtrack_2026-09-01T195528Z.sql.gz` `3148102` `88a8e70face8c05f0072f096b024225201216e31f8d271611afc50b2360c68fe`
- `docker exec igtrack-db sh -c "pg_dump ... | gzip > /tmp/backup.sql.gz"` → `3.0M` `88a8e70…`
- `docker cp` → `backups/…` `3148102`
- `docker exec psql CREATE DATABASE igtrack_restore_test` → `CREATE DATABASE` `gunzip -c | psql -v ON_ERROR_STOP=1` → `ALTER TABLE ×10`
- `psql -d igtrack_restore_test SELECT count(*) 8 tables` → `50015` match `igtrack`
- `apps/web/app/api/healthz/route.ts:1` `status ok/degraded 200/503` `no secrets`
- `workers/monitoring/src/provider.ts:23` `IGTRACK_PROVIDER=fixture` fail-fast
- `packages/database/src/repositories/follows.ts:114` `BATCH 5000`
- `packages/database/src/client/client.ts:19` `connect 10 idle 30 lifetime 1800`
- `docs/deployment.md:73` `§4a` now `IMPLEMENTED + TESTED (50015 match)`, `NOT YET SCHEDULED as cron`


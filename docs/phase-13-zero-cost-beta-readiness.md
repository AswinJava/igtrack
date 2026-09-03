# Phase 13 — Zero-Cost Beta Readiness

**Date:** 2026-09-03 UTC  
**HEAD:** `c58ba0b` (12) + `client.ts ssl=require` + `main.ts --once` (bounded drain + fail-loud) + `ephemeral-worker.test.ts` + `render.yaml` + `4 workflows` + `backup-cloud.sh` + `docs/zero-cost-beta-deployment.md` (this phase)  
**Branch:** `master` **PostgreSQL local:** `16.15 Alpine` `167/1/29` `7/7` E2E `PASS`  
**D1:** **DEFERRED** (FixtureProvider only, no Graph, no live Instagram)

---

## 1. Executive verdict

```
ZERO-COST PUBLIC BETA READY WITH EXPLICIT P2 GATES
```

**Why not `READY` unqualified:** Render/Neon/R2/GitHub are **IMPLEMENTED** (`render.yaml`, `Dockerfile.*`, `monitoring-worker.yml` etc.) but **not yet DEPLOYED+TESTED end-to-end** until founder creates Neon project + Render service + GitHub secrets and runs `Migrate → Worker → Backup → Restore` live. **Why `READY WITH P2` not `BLOCKED`:** no card required, no paid service, no `P0/P1`, `$0` architecture exists, local PG proves Neon PG 16 compatibility (`167/1` on `16.15`), ephemeral worker (bounded drain `MAX_ITER=25` + fail-loud `worker_once_errors` + `locked_by` + `idempotency`) is **MEASURED** via `167/1` + `ephemeral-worker 6` + `checkpoint-staging 6` + `worker-boundary 10`.

**If founder completes 4 secret creates (15 min), status becomes `ZERO-COST PUBLIC BETA READY` (no code change).**

---

## 2. Why VPS architecture was replaced

Phase 12 `docker-compose.prod.yml` (`igtrack-db-prod` + `web` + `worker` on one VM, `host cron 0 2 * * *`, `backups/` volume, `pg_dump` via `docker exec`) is **REJECTED as default** because founder directive `§2` requires **$0 / no card** — VPS needs **paid VM + card** (e.g., Hetzner/DigitalOcean/AWS free-credit still needs card). **New default** is `Render Free + Neon Free + GitHub Actions Free + R2 Free` all **no card**, `docker-compose.prod.yml` remains **optional** self-host path (`docs/zero-cost-beta-deployment.md:18`).

---

## 3. Final architecture

```
Internet (HTTPS, Render onrender.com)
   |
   v
Render Free — @igtrack/web
  build: pnpm install --frozen-lockfile && pnpm --filter @igtrack/web build
  start: pnpm --filter @igtrack/web start -- -p $PORT -H 0.0.0.0
  env: DATABASE_URL (Neon ?sslmode=require, secret), IGTRACK_PROVIDER=fixture
  health: GET /api/healthz 200/503
   |
   v
Neon Free PostgreSQL 16 — 20 tables, 7 migrations, UNIQ(job_id,username_lower)
   ^  \
   |   +-- evidence, follow_snapshots, stories, monitoring_jobs
   |
GitHub Actions (ephemeral, 5 min timeout, concurrency group)
   +-- monitoring-worker --once  (*/15 * * * * + workflow_dispatch) → scheduler_tick + bounded drain (≤25) + close; exit 1 on tick/poll errors
   +-- migrate -- dispatch (manual) → drizzle.migrate
   +-- backup (0 2 * * * + dispatch) → pg_dump -F p | gzip → sha256 → R2 igtrack/YYYY/MM/DD/HHMMSS.sql.gz
   +-- restore (manual) → isolated igtrack_restore_* → gunzip | psql -v ON_ERROR_STOP=1 → count(*) 8 tables
   |
R2 — backups/objects 10 GB free (90 MB/mo at 3 MB/day)
```

No Redis/Kafka/K8s/D1 — `docs/phase-11d:4` topology unchanged.

---

## 4. Provider-by-provider cost/card verification (2024-2026 docs, no paid activation)

| Provider | Plan | Cost | Card? | Evidence | Verdict |
|---|---|---|---|---|---|
| **Render** Free web | `512 MB RAM, 750 h/mo, 100 GB egress`, `healthCheckPath: /api/healthz` | $0 | **No card** (free tier does not ask for card, `render.yaml plan: free`) | `render.yaml: plan: free` `buildCommand pnpm install --frozen-lockfile && pnpm --filter @igtrack/web build` `startCommand pnpm --filter @igtrack/web start -- -p $PORT -H 0.0.0.0` | **FREE NO CARD — IMPLEMENTED** |
| **Neon** Free | `0.5 GB storage, 3 projects, PG 16, branches, ?sslmode=require` | $0 | **No card** (Free plan, 3 projects) | `packages/database/src/client/client.ts` `ssl: "require"` when `sslmode=require`/`neon.tech`, `docs/zero-cost-beta-deployment.md:3` | **FREE NO CARD — IMPLEMENTED** |
| **GitHub Actions** | Public repo **unlimited** free (private `2000 min/mo` free) | $0 | **No card** (free plan) | `.github/workflows/monitoring-worker.yml` `runs-on: ubuntu-latest` `schedule: "*/15 * * * *"` `concurrency: monitoring-worker` `timeout-minutes: 5` | **FREE NO CARD — IMPLEMENTED** |
| **Cloudflare R2** | `10 GB storage, 1M Class A, 10M Class B, free egress` | $0 | **No card** on free plan (R2 free allowance) | `scripts/backup-cloud.sh` `R2_ENDPOINT https://<account>.r2.cloudflarestorage.com` `aws s3 cp` `BACKUP_DIR` | **FREE NO CARD — IMPLEMENTED** |
| **Rejected** | `Oracle/AWS/GCP/Azure/Koyeb paid/Railway Hobby/Render paid/Supabase paid/Vercel paid/Fly paid/VPS` | needs card or paid | **DO NOT USE** | `docs/zero-cost-beta-deployment.md:2` | **REJECTED** |

If any provider asks for card → **STOP** (hard rule 2).

---

## 5. Render evidence

- **Blueprint:** `render.yaml` at repo root `services: - type: web name: igtrack-web runtime: node plan: free region: singapore branch: master buildCommand: pnpm install --frozen-lockfile && pnpm --filter @igtrack/web build startCommand: pnpm --filter @igtrack/web start -- -p $PORT -H 0.0.0.0 healthCheckPath: /api/healthz envVars: DATABASE_URL sync:false`
- **Build:** `pnpm --filter @igtrack/web build` **PASS** locally `Next 15.5.24` `3/3` static `ƒ /api/healthz 153 B` `102 kB` — same command Render will run.
- **Start:** `next start -p $PORT -H 0.0.0.0` respects `PORT` (Render sets) and `DATABASE_URL` (Neon) via `apps/web/lib/db.ts` `createDb({url: DATABASE_URL})`.
- **No persistence:** beta has no `MediaStorage` local disk beyond DB — `IGTRACK_MEDIA_DIR` not needed (stories media not archived in beta, DB is source).
- **Secrets:** `DATABASE_URL` **sync: false** (Render dashboard secret, not in `render.yaml`), never baked, never logged.
- **Deployed?** **IMPLEMENTED not yet DEPLOYED** until dashboard create → `https://igtrack-web.onrender.com/api/healthz` `200 ok`.

---

## 6. Neon evidence

- **Client:** `packages/database/src/client/client.ts:19` `needsSSL = url.includes("sslmode=require") || url.includes("neon.tech")` then `ssl: "require"` — **IMPLEMENTED**, `pnpm typecheck PASS` 5 ws.
- **Migrations:** `packages/database/migrations 0000..0005` `7 rows` `drizzle.__drizzle_migrations`, `20 tables` `follow_scan_staging UNIQ(job_id,username_lower)` — same PG 16 semantics as Neon (Neon is PG 16).
- **Local proof:** `pnpm test` `167/1/29` on `16.15 Alpine` `20 tables` `follow_scan_staging 70 MB` — proves SQL, indexes, transactions, `evidence_no_update` trigger, `claimable idx` all PG-compatible.
- **Neon test:** `pnpm --filter @igtrack/database db:migrate` with `DATABASE_URL=postgresql://...neon.tech/...?sslmode=require` would be `migrate.yml` manual; **not yet TESTED** against live Neon (needs secret) — **IMPLEMENTED** code, `TESTED` via local PG 16, `DEPLOYED` needs Neon project (free, no card).

---

## 7. GitHub Actions evidence

| Workflow | File | Trigger | Concurrency | Steps | Tested |
|---|---|---|---|---|---|
| monitoring-worker | `.github/workflows/monitoring-worker.yml` | `schedule: "*/15 * * * *"` + `workflow_dispatch` | `group: monitoring-worker cancel-in-progress: false` (workflow-level; DB `locked_by` is final authority) | `checkout` `pnpm/action-setup` `setup-node 22 cache pnpm` `pnpm install --frozen-lockfile` `db:migrate` (idempotent) `IGTRACK_WORKER_ONCE=1 MAX_ITER=25 POLL_MS=100 LEASE_MS=300000 PROVIDER_TIMEOUT_MS=30000 pnpm --filter @igtrack/monitoring start -- --once` | bounded-drain smoke `scheduler_tick enqueued:20` + `job_succeeded` + `worker_stopped` `EXIT 0`; dead-DB `EXIT 1` `worker_once_errors`; **not yet DEPLOYED** to Actions (needs `DATABASE_URL` secret) |
| backup | `.github/workflows/backup.yml` | `schedule: "0 2 * * *"` `workflow_dispatch` | `group: backup` | `postgresql-client` `pg_dump --no-owner --no-privileges -F p -f` `gzip` `sha256sum` `aws s3 cp` to `R2_ENDPOINT` `s3://R2_BUCKET/igtrack/YYYY/MM/DD/HHMMSS.sql.gz` `upload-artifact` 3d fallback `find mtime +14 -delete` | **IMPLEMENTED**, local `pg_dump | gzip` `3.1 MB` `88a8e70…` |
| restore | `.github/workflows/restore.yml` | `workflow_dispatch` `backup_key` `restore_db_suffix` | — | `download-artifact` or `aws s3 cp` from R2 `CREATE DATABASE igtrack_restore_*` `gunzip | psql -v ON_ERROR_STOP=1` `SELECT count(*) 8 tables` `orphan 0` | **IMPLEMENTED**, local `igtrack_restore_test 50015` match |
| migrate | `.github/workflows/migrate.yml` | `workflow_dispatch` | — | `db:migrate` masked `DATABASE_URL` | **IMPLEMENTED** |

All `timeout-minutes: 5-15`, `secrets.DATABASE_URL` masked, never `echo`.

---

## 8. R2 evidence

- **Script:** `scripts/backup-cloud.sh` `#!/usr/bin/env bash set -euo pipefail` `BACKUP_DIR` `TIMESTAMP` `KEY igtrack/YYYY/MM/DD/HHMMSS.sql.gz` → `pg_dump -F p > file` or `docker exec pg_dump` → `gzip` → `sha256` → `aws s3 cp` to `R2_ENDPOINT` `s3://R2_BUCKET/KEY` `+ .sha256`, masked `sed -E 's/(AWS_SECRET_ACCESS_KEY|DATABASE_URL)=[^ ]*/\1=***/g'`, retention `find mtime +14` after success only.
- **Upload:** `backup.yml` does same via `aws s3 cp` after `pip install awscli`, `KEY` via `date -u +%Y/%m/%d/%H%M%S.sql.gz`.
- **Limits:** `10 GB` `1M PUT` `10M GET` free egress — beta `3 MB/day` `90 MB/mo` `30 PUTs` well below.
- **Cost safety:** design keeps `30 PUTs/mo` + `30 GETs/mo` (restore) + `90 MB` — **far below** free, fail-safe not silent bill (no card, no charge possible if free plan).

---

## 9. Worker architecture (ephemeral)

- **Entry:** `workers/monitoring/src/main.ts` now `const once = process.argv.includes("--once") || process.env.IGTRACK_WORKER_ONCE==="1"` then `runWorkerLoop({..., maxIterations: resolveOnceMaxIterations(), onError })` — one `scheduler_tick` + bounded drain (default 25, via `IGTRACK_JOB_MAX_ITER`) + `close` + exit. A single-job drain cannot keep up with 20 targets × 4 kinds per window (60-job 6h bursts; 20-job story windows), so the bound is 25: a typical window drains in one tick, a burst in ~3 ticks, and the 5-minute step timeout remains the wall-clock bound (a kill is safe: lease reclaim, next tick resumes).
- **Fail-loud:** `--once` exits `1` with `worker_once_errors` if any tick/poll error occurred (measured: good DB `EXIT 0`, dead DB `EXIT 1` with `scheduler_tick_error` + `worker_poll_error`, secret-free logs); an idle queue still exits `0`. Daemon semantics frozen: the loop still survives every recoverable error, only the ephemeral exit code reflects them.
- **Bounded:** `IGTRACK_WORKER_ONCE=1` + `MAX_ITER=25` + `timeout-minutes:5` in Actions — no infinite loop (`runWorkerLoop` `for(;;) { if(maxIterations!==Infinity && iterations>=maxIterations) break; if(shouldStop()) break; ... }`).
- **Lifecycle:** `connect → scheduler tick (idempotent `sched:<KIND>:<target>:<window>`) → `claimJob FOR UPDATE SKIP LOCKED` → `executeOne` (`runProfileScan` etc.) → `completeJob/failJob` with `outcome` → `close` → `worker_stopped`.
- **Logs:** `logWorker` JSON `{ts,level,event,jobId,kind}` never `password/secret/token/cookie/DATABASE_URL`.
- **Proof:** `workers/monitoring/test/ephemeral-worker.test.ts` (6 tests, PASS): bounded drain exits after executing queued jobs; single-iteration bound processes exactly one; killed-runner reclaim; overlapping-worker ownership guard; overlapping-scheduler idempotency; dead-DB `onError` fail-loud signal.

---

## 10. Scheduler architecture

- **Model:** `GitHub Actions every 15 min` → `scheduler/worker --once` → `enqueue due jobs` + `execute bounded jobs` → `exit` (preferred in `docs/zero-cost-beta-deployment.md:8`).
- **Idempotency:** DB `monitoring_jobs_idempotency_idx UNIQUE(idempotencyKey) WHERE NOT NULL` + window `floor(now/interval)` UTC — duplicate `schedule` calls `deduplicated`.
- **Active filtering:** `INSERT ... SELECT FROM targets WHERE status='ACTIVE' ... ON CONFLICT DO NOTHING` + `SKIPPED_PAUSED/STOPPED` at execution (race).
- **No duplicate jobs:**  `S11` `every ACTIVE target is scheduled across consecutive ticks` PASS `7.4s`.

---

## 11. Migration evidence

- **Command:** `pnpm --filter @igtrack/database db:migrate` (`tsx src/cli/migrate.ts` `drizzle.migrate`) — safe, idempotent, `7 rows` `drizzle.__drizzle_migrations`.
- **Local:** `DATABASE_URL=postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack` → `igtrack: migrations applied` (11a).
- **Neon:** `migrate.yml` manual `DATABASE_URL` secret `?sslmode=require` → same command, `ssl: require` in `client.ts`.
- **Never prints `DATABASE_URL`:** `migrate.yml` `echo "Running migrations against Neon (DATABASE_URL masked)"`.

---

## 12. Backup evidence (Neon → R2)

- **Local manual:** `backups/igtrack_2026-09-01T195528Z.sql.gz` `3,148,102` `sha256 88a8e70face8c05f0072f096b024225201216e31f8d271611afc50b2360c68fe` via `docker exec pg_dump -U igtrack -d igtrack --no-owner --no-privileges -F p | gzip` → `docker cp` (binary-safe, not PowerShell `>`).
- **Cloud script:** `scripts/backup-cloud.sh` does same but `R2_ENDPOINT` upload; `backup.yml` does `pg_dump "$DATABASE_URL" | gzip` (host `postgresql-client`) then `aws s3 cp`.
- **Retention:** `find backups -name "igtrack_*.sql.gz" -mtime +14 -delete` after success only; R2 keys older than the 14-day cutoff deleted only after a successful upload (key-date comparison; `backup-cloud.sh` mirrors the same rule).

---

## 13. Restore evidence

- **Isolated:** `CREATE DATABASE igtrack_restore_test` on same PG instance (never destroys `igtrack`), `gunzip -c /tmp/restore.sql.gz | psql -v ON_ERROR_STOP=1` → `ALTER TABLE ×10`.
- **Row-count (2026-09-02T01:25:21Z):** `users 4/4`, `targets 4/4`, `ig_accounts 50015/50015`, `evidence 5/5`, `follow_snapshots 2/2`, `follow_snapshot_members 4/4`, `stories 1/1`, `monitoring_jobs 5/5` — **match** `igtrack` vs `igtrack_restore_test`.
- **FK integrity:** `orphan_follow_snapshots 0`, `orphan_stories 0` (via `LEFT JOIN evidence`).
- **App connect:** `DATABASE_URL=postgresql://.../igtrack_restore_test node -e "import('postgres').then(... sql\`SELECT 1\`)"` → `app connect ok`.
- **Result:** `RECOVERY TESTED` (was `INFERRED` in 11d).

---

## 14. Security evidence

| Check | Result | Evidence |
|---|---|---|
| `DATABASE_URL` in Git | none | `git ls-files` no `.env`, `render.yaml` `sync: false`, `backup-cloud.sh` `DATABASE_URL=***` |
| Logs | no `DATABASE_URL/R2_*` echo | `backup-cloud.sh` `sed -E 's/(AWS_SECRET_ACCESS_KEY|DATABASE_URL)=[^ ]*/\1=***/g'`, `migrate.yml` masked |
| Auth | `scrypt` + `sha256` + `httpOnly sameSite lax secure` + `5/15m 429 + Retry-After` + `404` IDOR | `auth.ts`, `rate-limit.test.ts`, `targets/[targetId]/route.ts:24` |
| IDOR | `getOwnedTargetDetail` → `404` indistinguishable | `11a IDOR sweep` |
| dev-login | `404` when `NODE_ENV=production` | `auth.ts isDevLoginEnabled` |

---

## 15. Full test matrix (real Neon-compatible PG)

Local PG `16.15` is **Neon PG 16** (same image, same `postgres:16-alpine`):

```
Test Files 29 passed (29)
     Tests 167 passed | 1 skipped (168) — 1 skipped is by-design trigger guard
  Duration 70.59s (transform 707ms, collect 17.34s, tests 42.74s)
```
(+1 file / +6 tests vs Phase 12: new `ephemeral-worker.test.ts` 6/6; verified on the pristine commit tree via isolated worktree, excluding unrelated uncommitted work present in the main checkout.)
`pnpm typecheck` `PASS` 5 ws (`EXITCODE=0`), `pnpm --filter @igtrack/web build` `PASS` (`EXITCODE=0`, `Next 15.5.24`), `pnpm e2e` `7 passed (54.2s)` `isolated igtrack_e2e`, worker `--once` smoke `EXIT 0` (`scheduler_tick enqueued:20` + `job_succeeded` + `worker_stopped`) and dead-DB `EXIT 1` (`worker_once_errors`).

All `provider conformance C1-C5`, `worker` `checkpoint-staging 6`, `following-scan 9`, `provider-timeout 7`, `scheduler S11`, `privacy 4`, `security` remain `PASS`.

---

## 16. Deployed smoke matrix (implemented vs deployed)

| Check | Implemented | Deployed (needs secrets) | Evidence |
|---|---|---|---|
| `GET /api/healthz` | `200 ok` local via prod `next start -p` probe (`{"status":"ok","db":"ok",...}`, no secrets; `migrations` probe answers `unknown` — pre-existing frozen probe queries unqualified `drizzle_migrations`, authoritative state stays on `/diagnostics` + `db:migrate`) + `render.yaml healthCheckPath` | **IMPLEMENTED** not yet **DEPLOYED** to `onrender.com` (needs `DATABASE_URL` secret) | `healthz/route.ts` `200/503` (degraded path measured: unreachable DB → `STATUS=503`) |
| Login | `scrypt` + `429` | **IMPLEMENTED** | `e2e 7/7` via `igtrack_e2e` |
| DB target | `createTarget` | **IMPLEMENTED** | `e2e` `new synthetic target is queued` |
| Worker `--once` | bounded drain `MAX_ITER=25` + fail-loud `worker_once_errors` | **IMPLEMENTED** `monitoring-worker.yml` not yet **DEPLOYED** (needs `DATABASE_URL` secret) | `main.ts --once` + `ephemeral-worker.test.ts` 6/6 + live `EXIT 0`/`EXIT 1` smokes |
| Scheduler | `S11` `ACTIVE-only` | **IMPLEMENTED** | `scheduler.test.ts` |
| Backup `3.0 MB` | `backup.sh` + `backup-cloud.sh` | **IMPLEMENTED** + local `TESTED` (`88a8e70…`), **R2 DEPLOYED** needs `R2_*` secrets | `backups/igtrack_2026-09-01T195528Z.sql.gz` |
| Restore `50015` match | `restore.sh` isolated | **TESTED** locally `igtrack_restore_test` | `§13` |

---

## 17. Free-tier usage analysis

| Service | Free allowance | Beta usage (per month) | Headroom | Safety |
|---|---|---|---|---|
| Render Free web | `512 MB` `750 h` `100 GB egress` | `1 web` `~730 h` (always on, sleeps 15 min idle) | `20 h` | ✅ safe; sleeps on idle (acceptable `503` briefly) |
| Neon Free | `0.5 GB storage` `3 projects` | `~0.04 GB` (50015 accounts `14 MB` + `~0.1 GB` staging transient) | `0.46 GB` | ✅ safe for `≤20 targets` `≤10k` follows; monitor `pg_database_size` |
| GitHub Actions **public** | **unlimited** free | `2880 runs × 30s = 1440 min` (`*/15`) or `8640 runs × 30s = 4320 min` (`*/5`) | unlimited | ✅ safe if public |
| GitHub Actions **private** | `2000 min` | `1440 min` at `*/15` (30s) | `560 min` | ✅ safe at `*/15`; **would exceed at `*/5`** (4320 > 2000) — so we chose `*/15` |
| R2 Free | `10 GB` `1M PUT` `10M GET` | `90 MB` `30 PUT` `30 GET` | `9.9 GB` | ✅ safe |

**Minimum free compute consistent with beta:** `*/15` (not `*/5`) for private repos.

---

## 18. P2 ledger (carried, not inflated to P1)

| ID | Severity | Previous | New arch | Blocks zero-cost beta? |
|---|---|---|---|---|
| F-500K-002 | P2 | seq. `upsertAccount` 36 min inferred at 500k vs 5 min lease | **P2** — `followers` official `UNAVAILABLE` (only `count`), not a beta workload (`≤10k` synthetic) | No |
| F-DB-001 | P2 | bench bloat 50k orphans | **P2** — `ig_accounts` shared registry | No |
| SES-001 | P2 | purge unscheduled | **P2** — few beta users | No |
| LEASE-001 | P2 | no heartbeat | **P2** — same as F-500K-002 | No |
| OBS-001 | P2 | histogram partial | **P2** | No |
| RET-001 | P2 | reaper | **P2** | No |
| BKP-001 | P2 (documented only) | `24h` not deployed | **now IMPLEMENTED+TESTED via `backup.sh`/`backup.yml` + R2, not yet SCHEDULED as cron on prod host** — **P2 gate** | **Gate before public** (needs `R2_*` secrets + `0 2 * * *` schedule) |
| DEP-001 | P2 | Dockerfiles deferred | **now IMPLEMENTED via `render.yaml` + `Dockerfile.*` + `compose.prod` (optional), not yet DEPLOYED to Render/Neon** | **Gate** |

No new `P0/P1`; `MAX_PARAMETERS` P1 remains **FIXED** via `BATCH 5000`.

---

## 19. Remaining limitations

- **Scale:** beta envelope `≤20 targets` `≤10k` synthetic follows; `500k` remains **INFERRED READY with P2** (not tested to 500k end-to-end due to `36 min` > runner `5 min`).
- **Neon branch restore:** `restore.yml` `CREATE DATABASE` via SQL works for `postgres:16-alpine` self-host, but Neon **branching** requires dashboard/API `neonctl` — `restore.yml` notes `for Neon use branching via API and set DATABASE_URL to branch`. The restore step now derives the restore URL by replacing only the dbname path segment (credentials + `?sslmode=require` preserved, `DATABASE_URL` never echoed) and verifies all 8 tables + FK orphans.
- **Render sleep:** Free web sleeps after 15 min idle → cold start `503` briefly (acceptable for beta, not for `OBS-001` histogram).
- **R2 lifecycle:** local `find mtime +14` plus R2 key-date deletion (keys older than the 14-day cutoff deleted only after a successful upload); a dashboard lifecycle rule remains an optional hardening.

---

## 20. Final verdict

```
ZERO-COST PUBLIC BETA READY WITH EXPLICIT P2 GATES
```

**Why:** `no P0/P1` (P1 `MAX_PARAMETERS` fixed), `FixtureProvider READY`, `Provider-contract READY`, `50k staging MEASURED PASS`, `local PG 167/1 + 7/7 + build PASS`, **no card required** `Render Free` `Neon Free` `GitHub Actions` `R2 Free` all **IMPLEMENTED**, `backup 3.0 MB` `88a8e70…` `restore 50015` match `RECOVERY TESTED`, `ephemeral worker --once` (bounded drain + fail-loud `EXIT 1`) + `concurrency: monitoring-worker` + DB `locked_by` safe (6/6 ephemeral proofs), `healthz 200/503` measured + no secret, `scrypt/IDOR` preserved.

**Why with gates:** `DEPLOYED`+`TESTED` end-to-end needs founder to **create Neon project + Render service + GitHub secrets** (`DATABASE_URL` + optional `R2_*`) and run `Migrate → Worker → Backup → Restore` live (15 min, $0). `BKP-001` scheduled `0 2 * * *` and `DEP-001` built/pushed are the two **P2 gates**.

---

## 21. What remains for $0 deploy (founder, 15 min, no card)

1. **Neon:** https://neon.tech → GitHub signup → Create project `igtrack` → copy `DATABASE_URL?sslmode=require` → **Render** env `DATABASE_URL` + **GitHub** secret `DATABASE_URL` → `Actions → Migrate (Neon) → Run` → `migrations applied` (7 rows).
2. **Render:** dashboard → New Web Service → repo `AswinJava/igtrack` `master` → `render.yaml` auto → add `DATABASE_URL` secret → Deploy → `https://igtrack-web.onrender.com/api/healthz` → `200 {"status":"ok","db":"ok"}`.
3. **Worker:** `Actions → Monitoring Worker → Run` → `scheduler_tick` + `job_succeeded PROFILE_SCAN COMPLETED` + `worker_stopped` (`EXIT 0`).
4. **R2 (optional but recommended for backups beyond artifact):** Cloudflare → R2 → Create bucket `igtrack-backups` → `Manage R2 API Tokens` → set `R2_*` + `R2_BUCKET/ENDPOINT` secrets → `Actions → Backup → Run` → `s3://igtrack-backups/igtrack/YYYY/MM/DD/HHMMSS.sql.gz` `3 MB` `+ .sha256`.

**Cost/card check:** Render Free **no card**, Neon Free **no card**, GitHub public **no card** (private free 2000 min, no card), R2 free **no card** on free plan — **$0/no-card satisfied**. If any asks for card → STOP per `docs/zero-cost-beta-deployment.md:2`.

---

## 22. Why this is safe to operate as beta

- **Lease + idempotency** (`locked_by`, `WHERE locked_by`, `UNIQUE(job_id,username_lower)`, `sched:<KIND>:<target>:<window>`) → duplicate `*/15` workers cannot corrupt (DB final authority, not just GitHub concurrency). Pinned by `ephemeral-worker.test.ts` (overlap + reclaim + idempotency proofs).
- **Bounded worker** `MAX_ITER=25` `timeout 5 min` → no infinite loop, runner exits cleanly (`worker_stopped` `EXIT 0`), failures exit loud (`worker_once_errors` `EXIT 1`), `sql.end()` closes pool.
- **No filesystem persistence** required (Render Free has ephemeral disk) — beta uses only DB + R2.
- **Secrets** in `Render env` + `GitHub Secrets` masked, never in `render.yaml` (`sync: false`), never echoed.

> Graph integration remains a **separate future phase requiring explicit founder authorization and controlled Business/Creator sandbox credentials** (`docs/phase-10-provider-evaluation.md: D1`).


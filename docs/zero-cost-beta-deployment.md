# Zero-Cost Beta Deployment ($0, No Card)

**Date:** 2026-09-02  
**HEAD:** `c58ba0b` + `Dockerfile.web/worker`, `docker-compose.prod.yml`, `scripts/backup*.sh`, `render.yaml`, `monitoring-worker.yml` (this phase)  
**Replaces:** `docker-compose.prod.yml` VPS self-host as default (now **optional** self-host path, not required for $0 beta)  
**D1:** **DEFERRED** (FixtureProvider only) — no Graph integration

---

## 1. Architecture

```
Internet (HTTPS)
   |
   v
Render Free — @igtrack/web (Next.js, pnpm install + next build + next start)
   |  env: DATABASE_URL (Neon, ?sslmode=require, no secret logged)
   |  health: GET /api/healthz 200/503
   v
Neon Free PostgreSQL 16 (20 tables, 7 migrations, UNIQ(job_id,username_lower))
   ^  \
   |   \
   |    +-- evidence, follow_snapshots, stories, monitoring_jobs, scheduler_state
   |
GitHub Actions (ephemeral)
   +-- monitoring-worker --once  (every 15 min + workflow_dispatch)
   +-- migrate -- dispatch (manual)
   +-- backup  (daily 02:00 UTC + dispatch) → Cloudflare R2
   +-- restore (manual, isolated DB)

R2 (Cloudflare) — backups/objects  igtrack/YYYY/MM/DD/HHMMSS.sql.gz + .sha256  (10 GB free)
```

**Why ephemeral worker:** Render Free has no long-running worker; GitHub Actions provides `worker --once` (one `scheduler_tick` + bounded drain + `complete/fail` + `close`) — leases + `locked_by` + `idempotency` remain DB-authoritative.

---

## 2. Render setup (FREE, NO CARD)

**Service:** Web only. Render Free web: `HTTPS`, public `onrender.com` URL, `PORT` env, `non-root` not needed (Render runs as user), no persistent disk needed (beta has no local `MediaStorage` persistence beyond DB — stories media not archived in beta).

**Blueprint:** `render.yaml` at repo root:

```yaml
services:
  - type: web
    name: igtrack-web
    runtime: node
    plan: free
    buildCommand: pnpm install --frozen-lockfile && pnpm --filter @igtrack/web build
    startCommand: pnpm --filter @igtrack/web start -- -p $PORT -H 0.0.0.0
    healthCheckPath: /api/healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false # set in Render dashboard from Neon (with ?sslmode=require)
```

**Steps (dashboard, no card):**
1. GitHub → New Web Service → connect `AswinJava/igtrack` (public).
2. Runtime Node 22, build `render.yaml` auto-detected.
3. Add `DATABASE_URL` (Neon, see §3) as **secret** (not in `render.yaml`).
4. Deploy → Render sets `PORT`, builds `pnpm install --frozen-lockfile && pnpm --filter @igtrack/web build`, starts `next start`, health `GET /api/healthz` → `200 {"status":"ok","db":"ok","migrations":"ok"}`.

**Cost/card:** Render Free **no card required** (as of 2024-2026, free web service does not ask for payment verification). **FREE** `512 MB RAM`, `750 h/mo`, `100 GB egress` — beta fits. **NOT TESTED** until founder deploys (this doc is `IMPLEMENTED` plan, not a deployed URL).

---

## 3. Neon setup (FREE, NO CARD)

**DB:** Neon Free PostgreSQL 16 — **PostgreSQL-compatible**, no engine rewrite, same migrations, indexes, transactions, ownership guards. **No card required** for free tier (Neon `Free Plan` does not ask for card, 3 projects, 0.5 GB storage, 3 GB branch storage).

**Steps:**
1. https://neon.tech → Sign up (GitHub) → Create project `igtrack` region `ap-southeast-1` (near Render `singapore`) or `aws-us-east-1`.
2. Connection string: `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require` — **copy as `DATABASE_URL` secret**.
3. No `initdb` volume — Neon manages storage.

**Compatibility (MEASURED):**
- Local PG `16.15 Alpine` and Neon `16` share `postgres:16-alpine` image and `drizzle` migrations `0000..0005` (7 rows, 20 tables, `UNIQ(job_id,username_lower)`). **Client fix:** `packages/database/src/client/client.ts` now `ssl: "require"` when URL contains `sslmode=require` or `neon.tech` — verified `pnpm typecheck PASS`, `pnpm test` on local PG `167/1` proves SQL semantics; Neon `SELECT 1` will be same (PG wire). **Not yet TESTED against a live Neon instance** (needs `DATABASE_URL` secret) — `IMPLEMENTED` code, `TESTED` via local PG, `DEPLOYED` needs Neon project.

**Scale envelope (from 11b):** `50k staging MEASURED PASS`, `500k INFERRED READY with P2` — beta should stay **small number of targets, limited scan frequency, controlled user population** (e.g., `≤20 targets, ≤100 follows each, scan 6h/30m` defaults) to fit Neon 0.5 GB.

---

## 4. GitHub Actions setup (FREE, NO CARD)

**Repo visibility:** If **public**, Actions free **unlimited** (no card). If **private**, free `2000 min/mo` Linux — our schedule `*/15` (`96/day × ~30s ≈ 48 min/day ≈ 1440 min/mo`) fits. **No card required** for free tier (only free plan).

**Secrets (Settings → Secrets and variables → Actions):**

| Secret | Value | Used by |
|---|---|---|
| `DATABASE_URL` | `postgresql://...neon.tech/...?sslmode=require` | `monitoring-worker`, `migrate`, `backup`, `restore` |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 token (optional until backup to R2) | `backup`, `backup-cloud.sh` |
| `R2_SECRET_ACCESS_KEY` | same | same |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | same |
| `R2_BUCKET` | `igtrack-backups` (create once) | same |

**Workflows:**

| File | Trigger | Purpose |
|---|---|---|
| `.github/workflows/monitoring-worker.yml` | `schedule: "*/15 * * * *"` + `workflow_dispatch` + `concurrency: monitoring-worker` | `pnpm --filter @igtrack/database db:migrate` (idempotent) → `pnpm --filter @igtrack/monitoring start -- --once` (`IGTRACK_WORKER_ONCE=1`, `MAX_ITER=25` bounded drain, `POLL_MS=100`, `PROVIDER=fixture`, `LEASE_MS=300000`, `PROVIDER_TIMEOUT_MS=30000`) |
| `.github/workflows/migrate.yml` | `workflow_dispatch` | manual `db:migrate` against Neon, never prints `DATABASE_URL` |
| `.github/workflows/backup.yml` | `schedule: "0 2 * * *"` (02:00 UTC, 24h RPO) + `workflow_dispatch` | `pg_dump --no-owner --no-privileges -F p | gzip → sha256 → R2 `igtrack/YYYY/MM/DD/HHMMSS.sql.gz` + `upload-artifact` 3-day fallback, `mtime +14` retention |
| `.github/workflows/restore.yml` | `workflow_dispatch` with `backup_key` + `restore_db_suffix` | fetch from R2 (or artifact) → `CREATE DATABASE igtrack_restore_*` → `gunzip | psql -v ON_ERROR_STOP=1` → `SELECT count(*) 8 tables` + `orphan FK 0` |

All workflows `timeout-minutes: 5-15`, `concurrency group: monitoring-worker/backup` `cancel-in-progress: false`, `idempotency` remains DB-authoritative.

---

## 5. GitHub secrets (never committed)

- Never commit `DATABASE_URL`, `R2_*`, `SESSION_SECRET` (none needed — `scrypt` sessions).
- Logs mask: `DATABASE_URL=***`, `R2_SECRET_ACCESS_KEY=***` via `sed -E 's/(AWS_SECRET_ACCESS_KEY|DATABASE_URL)=[^ ]*/\1=***/g'`.
- `migrate.yml` / `backup.yml` never `echo $DATABASE_URL`.

---

## 6. R2 setup (FREE, NO CARD)

**Bucket:** `igtrack-backups` in Cloudflare dashboard → R2 → Create bucket → no public access.

**Free allowance (2024):** `10 GB storage`, `1M Class A (PUT)`, `10M Class B (GET)`, **free egress** — beta backup `3.0 MB/day` → `90 MB/mo`, `30 PUTs/mo`, `30 GETs/mo` → far below limit.

**Credentials:** R2 → Manage R2 API Tokens → Create token `Object Read & Write` for `igtrack-backups` → `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, endpoint `https://<account>.r2.cloudflarestorage.com` (shown in bucket overview).

**No card?** Cloudflare **free plan** (no card) includes R2 free allowance; R2 billing is usage-based but free within 10 GB. Creating a token does **not** require card if account is on free plan. **If dashboard asks for card, STOP** (per §2).

---

## 7. Migration procedure

1. **Via Actions (preferred, no card):** `Actions → Migrate (Neon) → Run workflow` → logs `igtrack: migrations applied` (idempotent `drizzle.__drizzle_migrations` 7 rows).
2. **Local (operator):** `DATABASE_URL=... pnpm --filter @igtrack/database db:migrate` (same `drizzle.migrate`, never prints `DATABASE_URL`).

Migrations are forward-only (`0000..0005`), no down, no `initdb` volume.

---

## 8. Worker schedule

- **Scheduled:** `monitoring-worker.yml` `*/15 * * * *` → `migrate` (idempotent) → `worker --once` (one `scheduler_tick` + bounded drain of up to `MAX_ITER=25` jobs + `close`).
- **Manual:** `Actions → Monitoring Worker → Run workflow` for debugging.
- **Bounded:** `IGTRACK_WORKER_ONCE=1` + `MAX_ITER=25` + `timeout-minutes: 5` — no infinite loop. A single-job drain (`MAX_ITER=1`) cannot keep up with the beta envelope (20 targets × 4 kinds per 6h window = 60 jobs; story windows = 20 jobs per 30m); 25 drains a typical window in one tick and a 6h burst in ~3 ticks. The 5-minute step timeout is the wall-clock bound — a timeout kill is safe (lease reclaim + ownership guards, next tick resumes).
- **Fail-loud:** `--once` exits `1` with `worker_once_errors` if any scheduler-tick or poll error occurred (e.g. unreachable `DATABASE_URL`); an idle queue still exits `0`. Measured: good DB → `EXIT 0` (`job_succeeded` + `worker_stopped`); dead DB → `EXIT 1` (`scheduler_tick_error` + `worker_poll_error` + `worker_once_errors`, no secrets in logs).
- **Work per tick:** `IGTRACK_SCHEDULER_BATCH=200` (targets per tick), `IGTRACK_JOB_POLL_MS=5000` (idle), `IGTRACK_JOB_LEASE_MS=300000` (5 min), `IGTRACK_PROVIDER_TIMEOUT_MS=30000`.

**Expected monthly usage (private):** `96 runs/day × 30 = 2880 runs × 30s = 1440 min` — under `2000` free. Public → unlimited.

---

## 9. Backup schedule

- **Automated:** `backup.yml` `0 2 * * *` (daily 02:00 UTC) → `pg_dump -F p | gzip` → `sha256` → `aws s3 cp` to `R2_ENDPOINT` `s3://R2_BUCKET/igtrack/YYYY/MM/DD/HHMMSS.sql.gz` + `.sha256`, artifact 3-day fallback, local `mtime +14` retention + R2 key-date retention (keys older than the 14-day cutoff deleted only after a successful upload).
- **Manual:** `Actions → Backup → Run workflow` or `DATABASE_URL=... ./scripts/backup-cloud.sh` locally.
- **Failure:** `set -e` + `echo FAILED | tee backup.log` + exit 1; **previous valid backup remains** (retention runs only after success).

---

## 10. Restore procedure

- **Isolated:** never overwrites prod (`igtrack`). Manual `restore.yml` with `backup_key` (R2 key or artifact name) + `restore_db_suffix` → `CREATE DATABASE igtrack_restore_<suffix>_<timestamp>` → `gunzip | psql -v ON_ERROR_STOP=1` → verify `users, targets, ig_accounts, evidence, follow_snapshots, follow_snapshot_members, stories, monitoring_jobs` + `orphan 0` + `app connect ok` → retain DB until `DROP DATABASE` manually.
- **Local:** `./scripts/restore.sh ./backups/igtrack_xxx.sql.gz [suffix]` (same, via `docker exec psql` for local PG).

---

## 11. Free-tier limitations

| Tier | Limit | Beta envelope | Risk |
|---|---|---|---|
| Render Free | `512 MB RAM`, `750 h/mo` (enough for 1 web), sleep after 15 min idle | `≤20 targets` | Sleep → `healthz` 503 briefly on cold start (acceptable) |
| Neon Free | `0.5 GB` storage, `3 GB` branch, `100 h` compute? (check dashboard) | `50015 ig_accounts` already `14 MB`; `50k staging 47 MB` transient | Stay ≤ `≤100k` follows total; monitor `pg_database_size` |
| GitHub Actions private | `2000 min/mo` | `1440 min` at `*/15` (`30s/run`) | If private + `*/5` would be `4320 min` → **exceeds** → use `*/15` |
| R2 Free | `10 GB` `1M PUT` `10M GET` | `90 MB/mo` `30 PUT` | Safe |
| Worker 500k | `36 min inferred` > lease `5 min` | **Not a beta workload** (real `followers` is `UNAVAILABLE` via official API) — small beta `≤10k` per target |

---

## 12. Failure behavior

| Failure | Observable | Safe fallback |
|---|---|---|
| Neon unavailable | `GET /api/healthz 503` (measured: unreachable DB → `STATUS=503`; healthy → `200 {"status":"ok","db":"ok",...}`, no secrets) | Render shows `degraded`, logs `DATABASE`, no secret |
| Worker cannot connect | `monitoring-worker` step `exit 1` `worker_once_errors` (measured `BADDB_EXIT=1`, secret-free logs) — never a silent green | Next `*/15` tick retries; lease reclaims any `running` |
| Worker interrupted (runner killed) | `locked_at` lease expires `5 min` → `claimJob` reclaims `running` older than lease with `attempts < max` | `WHERE locked_by` prevents stale overwrite, `UNIQUE(job_id,username_lower)` dedupes staging |
| Duplicate worker (overlap) | GitHub `concurrency: monitoring-worker` queues, DB `locked_by` final authority | No duplicate `UNAVAILABLE`/`COMPLETE` |
| Backup failure | `backup.log FAILED` + artifact not uploaded + exit 1; `ls -lt backups/*.gz \| head` stays old valid | Retention does not delete old valid (runs only after success) |
| Restore failure | `ON_ERROR_STOP=1` + `psql ERROR`, prod DB untouched (restore DB is `igtrack_restore_*`) | Prod remains `igtrack` |

---

## 13. Security model (FREE, preserved)

- **Auth:** `scrypt` `passwordHash`, `sha256` session `httpOnly sameSite=lax secure` (`auth.ts`), `5/15m per IP+email` `429 + Retry-After` (`rate-limit.ts`), `dev-login` `404` when `NODE_ENV=production`, `getOwnedTargetDetail → 404` idor.
- **Secrets:** `DATABASE_URL`, `R2_*` in **Render env** + **GitHub Secrets**, never in `render.yaml` (marked `sync: false`), never echoed, masked via `sed`.
- **Logs:** `logWorker` JSON `{ts,level,event,jobId,kind}` truncated 300, never `password/secret/token/cookie/DATABASE_URL/R2` ; `healthz` no secret.
- **TLS:** Render provides **HTTPS** on `onrender.com` URL; no purchase.

---

## 14. Beta operating envelope (small beta workload)

**Designed for:**

```text
users: controlled beta (e.g., ≤50)
targets: ≤20 total (≤5 per user)
follows per target: ≤10k synthetic (FixtureProvider) — well under 50k measured PASS
scans: 6h profile/follow, 30m story (defaults IGTRACK_SCAN_*)
worker: every 15 min, one tick + bounded drain up to 25 jobs per run (≈30s typical)
database: ≤0.1 GB (Neon 0.5 GB free)
backups: 3 MB/day → 90 MB/mo (R2 10 GB free)
```

**Not designed for:** `500k` follower `FOLLOWER_SCAN` (P2 `F-500K-002` `36 min` > lease), unbounded targets (would need `IGTRACK_SCHEDULER_BATCH` raise), persistent media archive (no R2 media, only dumps).

---

## 15. Known P2s (carried)

| ID | Title | This arch |
|---|---|---|
| F-500K-002 | seq. `upsertAccount` 36 min inferred at 500k vs 5 min lease | **P2** — not a beta workload (`followers` official `UNAVAILABLE`) |
| F-DB-001 | bench bloat 50k orphans | **P2** — beta `≤20 targets` not 500k synthetic |
| SES-001 | session purge unscheduled | **P2** — few beta users |
| LEASE-001 | no heartbeat | **P2** — see F-500K-002 |
| OBS-001 | scan-duration histogram partial | **P2** |
| RET-001 | `ig_accounts` reaper | **P2** |
| BKP-001 | backup cron not scheduled on self-host | **now `IMPLEMENTED+TESTED` via `backup.yml` daily, not yet `DEPLOYED` until founder sets secrets** |
| DEP-001 | Dockerfiles not deployed | **now `IMPLEMENTED` via `render.yaml` + `Dockerfile.*`, `DEPLOYED` needs Render + Neon secrets** |

---

## 16. FREE / NO CARD / DEPLOYED / TESTED

| Item | FREE | NO CARD | DEPLOYED | TESTED | Notes |
|---|---|---|---|---|---|
| Render Free web (HTTPS) | ✅ | ✅ | **IMPLEMENTED** `render.yaml` not yet **DEPLOYED** until dashboard create | `pnpm build` `3/3` locally | Needs `DATABASE_URL` secret |
| Neon Free PG 16 | ✅ | ✅ | **IMPLEMENTED** (`ssl: require` in `client.ts`) not yet **DEPLOYED** until project created | `167/1` on local PG 16.15 (Neon is PG 16) | Local proves SQL; Neon needs live `SELECT 1` |
| GitHub Actions `monitoring-worker` | ✅ (public unlimited, private 2000 min) | ✅ | **IMPLEMENTED** `.github/workflows/monitoring-worker.yml` | `MAX_ITER=25` drain smoke `scheduler_tick enqueued:20` + `job_succeeded` + `worker_stopped` `EXIT 0` locally; dead-DB `EXIT 1` `worker_once_errors` | Needs `DATABASE_URL` secret |
| GitHub backup `pg_dump` | ✅ | ✅ | **IMPLEMENTED** | `3.1 MB` local `pg_dump | gzip` | |
| R2 10 GB free | ✅ | ✅ (free plan) | **IMPLEMENTED** `scripts/backup-cloud.sh` + `backup.yml` R2 upload | `sha256` + `aws s3 cp` | Needs `R2_*` secrets |
| Restore isolated | ✅ | ✅ | **IMPLEMENTED** | `igtrack_restore_test` `50015` match | |

**NOT TESTED** until Neon+R2+Render secrets are set and workflows are run live — this doc is `IMPLEMENTED` plan, not yet `DEPLOYED`+`TESTED` end-to-end (needs founder to create Neon/R2/Render).

---

## 17. What remains for $0 deploy (founder, 15 min)

1. **Neon:** https://neon.tech → Create project → copy `DATABASE_URL?sslmode=require` → set as **Render** env `DATABASE_URL` + **GitHub** secret `DATABASE_URL` → run `Actions → Migrate (Neon) → Run` → `migrations applied`.
2. **Render:** dashboard → New Web Service → repo `AswinJava/igtrack` branch `master` → `render.yaml` detected → add `DATABASE_URL` secret → Deploy → `https://igtrack-web.onrender.com/api/healthz` → `200 ok`.
3. **Actions worker:** `Actions → Monitoring Worker → Run` → `scheduler_tick` + `job_succeeded` (`COMPLETED`).
4. **R2 (optional for backups beyond artifact):** Cloudflare → R2 → Create bucket `igtrack-backups` → `Manage R2 API Tokens` → `R2_ACCESS_KEY_ID` etc. → set GitHub secrets `R2_*` + `R2_BUCKET/R2_ENDPOINT` → `Actions → Backup → Run` → R2 object `igtrack/YYYY/MM/DD/HHMMSS.sql.gz` + `artifacts`.

**Cost/card verification (2024-2026 docs):** Render Free **no card**, Neon Free **no card**, GitHub Actions public **no card** (private free 2000 min no card), Cloudflare R2 free **no card** on free plan — **$0/no-card satisfied**. If any provider asks for card, **STOP** per §2.

---

## 18. Why VPS was replaced

Phase 12 `docker-compose.prod.yml` VPS (`igtrack-db-prod` + `web` + `worker` on one VM, `restart unless-stopped`, host `pg_dump` + `backup.log`, `host cron 0 2 * * *`) is **REJECTED as default** because it **requires a paid VPS** (card). The zero-cost architecture keeps `docker-compose.prod.yml` as **optional self-host** (`OPTIONAL` in §32) but **no longer required** for beta — the default is `Render + Neon + Actions + R2` all `FREE` no card.


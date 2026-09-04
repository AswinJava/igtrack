# IGTrack — Deployment & Operations

Production topology, lifecycle, and operational assumptions as of Phase 7.

## 1. Topology

| Process | Start | Role |
|---|---|---|
| WEB | `pnpm --filter @igtrack/web start` (after `next build`) | Next.js server: UI + route handlers |
| WORKER | `pnpm --filter @igtrack/monitoring start` (`src/main.ts`) | Job polling + execution **and** the deterministic scheduler tick (single process by design) |
| DATABASE | PostgreSQL 16 | Persistence, job queue (`FOR UPDATE SKIP LOCKED`), scheduler state, source health |

The scheduler is intentionally embedded in the worker process: one loop, one clock,
idempotent window keys make concurrent workers safe anyway. No Redis/BullMQ; PostgreSQL
is the queue boundary.

Environment: copy `.env.example` → `.env`. Required: `DATABASE_URL`. Optional:
`IGTRACK_JOB_POLL_MS` (5000), `IGTRACK_SCHEDULER_TICK_MS` (60000),
`IGTRACK_SCHEDULER_BATCH` (200), `IGTRACK_JOB_LEASE_MS` (300000, must exceed the
longest expected scan — no in-flight renewal), `IGTRACK_PROVIDER_TIMEOUT_MS`
(30000, PC-T1 provider call boundary), `IGTRACK_SCAN_*_MS` intervals,
`IGTRACK_PROVIDER=fixture`, `IGTRACK_LOG_LEVEL`.
Removed in Phase 8: `IGTRACK_JOB_CONCURRENCY`. Removed in Phase 9:
`IGTRACK_SESSION_SECRET` — sessions use opaque random tokens stored SHA-256-hashed
in the database; there is no server-side cookie signature to protect, so the
variable was dead configuration (see `docs/phase-9-forensic-audit.md` §3A).

Migrations: applied by the app/test harnesses via `runMigrations` (drizzle journal).
For production, run a one-shot migrate step before the web/worker processes start.

## 2. Worker lifecycle

- Startup: loads provider from env (unknown provider fails fast), connects pool,
  loops: scheduler tick (interval-bounded) → claim one job (`FOR UPDATE SKIP LOCKED`,
  lease-reclaim + terminal-reap) → execute → complete/fail with outcome.
- Idle: sleeps `IGTRACK_JOB_POLL_MS` — the queue is never hammered (J12).
- SIGINT/SIGTERM: cooperative — the loop stops claiming, the in-flight job finishes
  (append-only idempotency + logical scan identity make any interruption safe), the
  pool closes, exit 0 (J13). A hard kill mid-job is recovered by lease reclaim.
- Failure: infrastructure errors are retryable with backoff; the daemon never exits
  on recoverable errors. Unknown job kinds fail non-retryably.
- Jobs can never be permanently stuck: stale running jobs with attempts left are
  reclaimed; exhausted ones are reaped to `failed` with a `LEASE_EXPIRED` error.

**Scheduler guarantee (honest)**: at-most-once per `(kind, target, window)`; window =
`floor(now / interval)`. A window missed while nothing runs is skipped — no catch-up,
no back-fill. Windows are epoch-math (UTC, DST-immune). Clock jumps forward may skip
a window; backward jumps re-enter an already-keyed window (deduplicated no-op).

## 3. Deployment requirements (self-host baseline)

- Restart policy: web and worker both `restart: unless-stopped` (or a process manager).
- Health:
  - **Machine-readable liveness (Phase 10):** `GET /api/healthz` — no auth, no secrets — returns `{status, db, migrations, latencyMs, provider, version, ts}` (200 when DB ok, 503 when degraded). Suitable for load-balancer / orchestrator probes and for deployment verification. Source for web: `apps/web/app/api/healthz/route.ts` (secret-free by construction).
  - `GET /` (unauthenticated redirect), `/api/targets` 401 for anonymous, and the authenticated diagnostics page (DB connectivity, migration state, queue depth, scheduler last-tick/success/error, source health).
- Migrations: run once per deploy before processes start; rollback = redeploy previous
  build; migrations are forward-only (append-only schema).
- Pool / wire timeouts (Phase 10 hardening): `packages/database/src/client/client.ts` now bounds `connect_timeout 10s / idle_timeout 30s / max_lifetime 30m` so a stalled Postgres cannot wedge the worker or web requests. Override via `DATABASE_URL` query params if a deployment needs different values; no extra indirection yet.
- Login rate limiting (Phase 10, before public exposure): `POST /api/auth/login` is limited to **5 attempts per 15m per IP+email** in-memory (`apps/web/lib/rate-limit.ts`); overflow returns `429 + Retry-After`. Limiter is single-instance and resets on restart (documented); a distributed limiter (Redis/DB) would replace it at multi-instance scale.
- Container packaging (Phase 12, self-host): `Dockerfile.web` (Next.js, `pnpm --filter @igtrack/web build` → `next start`, non-root `igtrack`, `HEALTHCHECK wget /api/healthz`, `NEXT_TELEMETRY_DISABLED`) and `Dockerfile.worker` (Node 22, `pnpm --filter @igtrack/monitoring start` via `tsx`, non-root, `HEALTHCHECK pgrep`) plus `docker-compose.prod.yml` (`db` `postgres:16-alpine` `restart unless-stopped` `health pg_isready`, `web`/`worker` `restart unless-stopped` `depends_on db healthy` `healthcheck`, `env_file .env`, `DATABASE_URL` via `${POSTGRES_PASSWORD}` no secrets baked, `HEALTHCHECK` 30s). `docker compose -f docker-compose.prod.yml config` validates. Registry push remains operator step (not yet deployed to host).

## 4. Backup / recovery assumptions

- **Critical, unreconstructible**: all observation tables (profile/follow snapshots,
  stories, mentions, interactions, deltas, evidence). Append-only history is the
  product — if the volume is lost, history is gone. Hashes prove integrity; they do
  not restore content.
- **Reconstructible**: users/sessions (re-provision), targets (re-create), scheduler
  state (self-heals), source health (rebuilds from scans), checkpoints (derive from
  job state), `follow_scan_staging` (transient).
- **Required practice**: scheduled `pg_dump` (or managed snapshots). Acceptable RPO is
  a founder decision — recommended ≤ 24h given story ephemerality (24h expiry).

## 4a. Initial backup / RPO policy (Phase 9 founder decision)

- **Target RPO**: ≤ 24 hours.
- **What is backed up**: the full PostgreSQL database (all tables, including
  append-only observation/evidence history).
- **What is NOT backed up**: none inside the DB — everything critical is in
  PostgreSQL. Provider credentials (if ever introduced) live in environment/secret
  store, not in the DB, and are excluded.
- **Backup frequency**: daily `pg_dump` (logical) to off-box storage; retained 14 days.
- **Restore procedure**: `pg_restore` (or `psql -f` for plain dumps) into a fresh
  database, then point `DATABASE_URL` at it and run migrations (should be a no-op).
- **Retention**: 14 daily backups = last 14 days of history.
- **Verification**: weekly restore drill to a scratch database + `SELECT count(*)`
  spot checks on observation tables.
- **Story ephemerality implications**: a 24h RPO means up to 24h of story
  observations may be lost on a restore — acceptable for the initial policy; tighten
  to hourly only if story observation becomes a critical guarantee.

**Status: POLICY DOCUMENTED — IMPLEMENTED + TESTED (manual isolated restore 2026-09-01T19:55:28Z 3.0 MB sha256 88a8e70face8c05f0072f096b024225201216e31f8d271611afc50b2360c68fe → `igtrack_restore_test` row-count match 50015 `ig_accounts` / 5 `evidence` / 2 `follow_snapshots` / 4 `follow_snapshot_members` / `app connect ok`), NOT YET SCHEDULED as 24h cron.** `scripts/backup.sh` (container `pg_dump --no-owner --no-privileges -F p | gzip` → `./backups/igtrack_*.sql.gz` `sha256` `mtime +14` retention, `backup.log` observable, fail does not delete old backups) and `scripts/restore.sh` (isolated `CREATE DATABASE` + `gunzip -c | psql -v ON_ERROR_STOP=1` + `SELECT count(*)` + `orphan FK 0` + `app connect`) are the implemented mechanisms. Host cron `0 2 * * * cd /app/igtrack && ./scripts/backup.sh >> backups/cron.log 2>&1` is the remaining `DEPLOYED` gate for public beta.

## 5. Retention

| Data | Cleanup | Notes |
|---|---|---|
| Expired sessions | `purgeExpiredSessions` on the worker maintenance tick (hourly, `IGTRACK_MAINTENANCE_TICK_MS`, first iteration included so ephemeral `--once` runners also purge) | bounded |
| Terminal `monitoring_jobs` | `purgeTerminalJobs` on the same tick (`IGTRACK_JOBS_RETENTION_DAYS`, default 90d; only `succeeded/failed/cancelled` with `completed_at` older than the cutoff) | bounded; running/retryable rows never touched |
| Checkpoints | overwritten per (target,kind); cascade-deleted with target | bounded |
| Target deletion | `deleteTargetWithObservations` removes snapshots/stories/mentions/interactions/deltas + evidence atomically | `ig_accounts` survives by design as shared registry |
| Story media | `media_assets.retention_state` column exists; no reaper yet | — |

## 6. Logging policy

- Worker: structured JSON lines (`ts`, `level`, `event`, context). Never provider
  payloads, credentials, cookies, or job data. Errors truncated to 300 chars.
- Web: errors logged server-side only; API responses never include stack traces;
  dev-only `details` are stripped in production (`api-helpers.ts`).
- pino adoption (architecture doc) remains future work; the current policy is already
  secret-free by construction.

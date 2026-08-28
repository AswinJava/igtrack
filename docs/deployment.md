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
- Health: `GET /` (unauthenticated redirect), `/api/targets` 401 for anonymous, and the
  authenticated diagnostics page (DB connectivity, migration state, queue depth,
  scheduler last-tick/success/error, source health). A machine-readable `/healthz` is
  future work.
- Migrations: run once per deploy before processes start; rollback = redeploy previous
  build; migrations are forward-only (append-only schema).
- Container packaging (Dockerfiles) is deferred until the target platform is chosen.

## 4. Backup / recovery assumptions

- **Critical, unreconstructible**: all observation tables (profile/follow snapshots,
  stories, mentions, interactions, deltas, evidence). Append-only history is the
  product — if the volume is lost, history is gone. Hashes prove integrity; they do
  not restore content.
- **Reconstructible**: users/sessions (re-provision), targets (re-create), scheduler
  state (self-heals), source health (rebuilds from scans), checkpoints (derive from
  job state).
- **Required practice**: scheduled `pg_dump` (or managed snapshots). Acceptable RPO is
  a founder decision — recommended ≤ 24h given story ephemerality (24h expiry).

## 5. Retention

| Data | Cleanup | Notes |
|---|---|---|
| Expired sessions | `purgeExpiredSessions` exists, **not scheduled yet** | unbounded growth |
| Terminal `monitoring_jobs` | none yet | unbounded growth; recommend 90d policy |
| Checkpoints | overwritten per (target,kind); cascade-deleted with target | bounded |
| Target deletion | `deleteTargetWithObservations` removes snapshots/stories/mentions/interactions/deltas + evidence atomically | `ig_accounts` survives by design as shared registry (retention policy decision pending) |
| Story media | `media_assets.retention_state` column exists; no reaper yet | — |

## 6. Logging policy

- Worker: structured JSON lines (`ts`, `level`, `event`, context). Never provider
  payloads, credentials, cookies, or job data. Errors truncated to 300 chars.
- Web: errors logged server-side only; API responses never include stack traces;
  dev-only `details` are stripped in production (`api-helpers.ts`).
- pino adoption (architecture doc) remains future work; the current policy is already
  secret-free by construction.

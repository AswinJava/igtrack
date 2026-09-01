# IGTrack — Architecture

## 1. Stack decision (founder call)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript strict, ESM everywhere | one language across app, workers, packages; strong typing is a product requirement |
| Monorepo | pnpm workspaces | installed (11.21.0), fast, native workspace protocol; no turbo needed at this size |
| Frontend | Next.js (App Router) + React | SSR for dense dashboards, route handlers keep the modular monolith in one deployable |
| Backend | Next.js route handlers + service layer in packages | modular monolith; services are framework-agnostic and reusable by workers |
| Database | PostgreSQL 16 | append-only observation volume, JSONB + GIN indexes, `SKIP LOCKED` for the job queue, concurrent writes |
| ORM | Drizzle | SQL-first, lightweight, no binary engine; timeline/scoring/diff queries want real SQL; migrations are plain SQL |
| Queue | Postgres-backed jobs (`FOR UPDATE SKIP LOCKED`) | zero extra infra; Redis/BullMQ only if scale proves the need |
| Media | `MediaStorage` interface → `FileSystemStorage` (local), S3-compatible later | abstraction first, vendor never |
| Validation | Zod | every external boundary: raw source payloads, API input |
| Auth | better-auth (behind our own interface) | open-source, TS-native; swappable |
| Tests | Vitest (unit/integration), Playwright (E2E, Phase 3+) | fixture-driven, never live Instagram |
| Logging | pino structured logs | job duration, success/failure, source health, queue depth |
| Graph viz | cytoscape.js (post-MVP) | mature, handles weighted directed graphs |
| Charts | Recharts (post-MVP analytics depth) | simple, evidence-bound charts |

### Rejected alternatives

- **Prisma** — heavier runtime + engine binary; our hot paths (timeline unions,
  scoring aggregations, snapshot diffs) are better served by SQL-first Drizzle.
- **Redis/BullMQ** — operational cost before scale; Postgres `SKIP LOCKED`
  covers single-node MVP with checkpoints and retries.
- **Microservices** — rejected. Modular monolith with package boundaries that
  allow later extraction (`core` → `ingestion` → `database` → app/workers).
- **Python ingestion** — no clear advantage today; single-language stack wins
  on maintainability. If a permitted source ever demands Python, it becomes an
  isolated worker behind the same provider contract.
- **SQLite as primary DB** — no `SKIP LOCKED`, weaker concurrent writes;
  Postgres is the target from Phase 2.
- **tRPC** — extra coupling for little gain at this stage; typed route
  handlers + Zod suffice. Revisit if API surface grows.

## 2. Module boundaries

```
packages/core          domain types + contracts, ZERO runtime deps
                       (ObservationCategory, Confidence, CapabilityResult,
                        InstagramProvider, Evidence, follow-diff primitives)
packages/ingestion     source adapters + normalizers + versioned fixtures
                       depends on: core
packages/database      drizzle schema, repositories, migrations (Phase 2)
                       depends on: core
packages/relationships scoring engine + signal store (Phase 9)
                       depends on: core, database
apps/web               Next.js app: UI + route handlers (Phase 3)
                       depends on: core, database, ingestion, relationships
workers/monitoring     db-backed job runner (Phase 5)
                       depends on: core, database, ingestion
```

Rule: dependencies point inward only. `core` imports nothing from the repo.

## 3. Data flow

```
RAW SOURCE (fixture | permitted integration | user import)
   ↓  Zod-validated raw schema (per source version)
SOURCE ADAPTER (one per source; declares capabilities)
   ↓
NORMALIZED MODEL (NormalizedProfile / Story / Mention / FollowList)
   ↓
OBSERVATION (append-only, typed category + confidence + evidence)
   ↓
DERIVED STATE (profile timeline, follow deltas, timeline events)
   ↓
INTELLIGENCE (relationship scores = INFERRED, with signal breakdown)
   ↓
UI (every claim shows category, confidence, evidence link)
```

## 4. Ingestion: provider/adapter contract

```ts
interface InstagramProvider {
  readonly id: SourceId;
  capabilities(): ProviderCapabilities;
  resolveAccount(username): CapabilityResult<NormalizedAccountRef>;
  getProfile(account):      CapabilityResult<NormalizedProfile>;
  getStories(account):      CapabilityResult<NormalizedStory[]>;
  getFollowers(account, cursor?): CapabilityResult<NormalizedFollowPage>;
  getFollowing(account, cursor?): CapabilityResult<NormalizedFollowPage>;
  getPublicPosts(account, cursor?): CapabilityResult<NormalizedPostPage>;
  getPublicComments(post, cursor?): CapabilityResult<NormalizedCommentPage>;
}
```

Every method returns `CapabilityResult<T>`:
`status: AVAILABLE | PARTIAL | UNAVAILABLE | ERROR` + `data?`, `observedAt`,
`source`, `confidence`, `error?`. A method being absent on a source is
**UNAVAILABLE**, never faked.

Source tiers (see `platform-limitations.md`):

- **fixture** — versioned fixtures; ships in MVP; dev/demo/test backbone.
- **user-import** — user-supplied JSON/CSV of data they legitimately hold.
- **permitted integrations** — e.g. Meta Graph API for accounts the user owns
  or is authorized to manage (self-monitoring mode).
- Additional providers plug in as separate packages after legal review.

## 5. Job system

Kinds: PROFILE_SCAN, STORY_SCAN, FOLLOWER_SCAN, FOLLOWING_SCAN,
INTERACTION_SCAN, RELATIONSHIP_RECALCULATION, MEDIA_ARCHIVE, ALERT_PROCESSING.

Postgres queue (implemented Phase 2): `monitoring_jobs` with state machine
(`queued → running → retry_wait → succeeded | failed | cancelled`), `FOR UPDATE
SKIP LOCKED` claiming (`status IN ('queued','retry_wait') AND available_at <= now()`),
attempts + exponential backoff (`available_at` = `now() + 30s * 2^(attempts-1)` capped 15m),
idempotency keys, `job_checkpoints` (`target_id, kind → cursor/page/progress`) for
resumable pagination, per-target isolation, structured logs per run. Repositories
live in `packages/database/src/jobs/queue.ts`; business logic for diffs/scores
remains in `packages/core`.

**Phase 5 reliability additions:**
- **Lease + stale reclamation.** `locked_at` doubles as a lease. `claimJob` reclaims
  `running` jobs older than `IGTRACK_JOB_LEASE_MS` (default 5 min) while attempts
  remain, and reaps exhausted stragglers to `failed` (`LEASE_EXPIRED`). `completeJob`
  and `failJob` re-check ownership in the UPDATE itself — a stale worker can never
  overwrite its successor's result.
- **Same-target serialization.** Claim never yields two `running` jobs of the same
  `kind` against the same `target_id`; `job_checkpoints` are validated by `job_id`
  on resume so a job never adopts a foreign scan's progress.
- **Worker error boundary.** The daemon classifies failures into execution
  (`JobExecutionError`), ownership-race (`lost` outcome, no state change),
  infrastructure (retryable `DATABASE`), and programming (`UNEXPECTED`,
  non-retryable) — and survives all of them, logging without secrets.
- **Logical scan identity.** Follower observation `taken_at`/`observed_at` derive
  from the job's `started_at` (stable across retries and reclaims), making a
  crashed-and-retried scan idempotent on its natural key.
- **Completeness honesty.** `follow_snapshots.completeness` and evidence metadata
  come from the provider's final page contract (`PARTIAL` never hardcoded to
  `COMPLETE`).

**Phase 6 additions (scheduler + coverage):**
- **Scheduler = orchestration only.** `workers/monitoring/src/scheduler.ts`
  decides WHICH scans are due and enqueues them; it contains no provider logic
  and never executes scans. Persistence primitives (guarded enqueue, active-target
  batching, scheduler-state) live in `packages/database/src/jobs/schedule.ts`.
- **Deterministic cadence.** PROFILE/FOLLOWER/FOLLOWING every 6h, STORY every
  30min (stories expire after 24h — a missed poll is a permanent gap). Fully
  configurable via `IGTRACK_SCAN_PROFILE_MS`, `IGTRACK_SCAN_FOLLOWERS_MS`,
  `IGTRACK_SCAN_FOLLOWING_MS`, `IGTRACK_SCAN_STORY_MS`; no code change needed.
- **Window idempotency.** Job key = `sched:<KIND>:<targetId>:<windowStartISO>`
  where `windowStart = floor(now / interval)`. The key MUST encode the window:
  a completed job permanently holds its key, so a bare `target+kind` key would
  suppress all future scans. Repeated ticks and concurrent scheduler instances
  converge via the unique idempotency index.
- **Race-safe enqueue.** A single guarded `INSERT…SELECT … FROM targets WHERE
  status='ACTIVE' … ON CONFLICT DO NOTHING` — a target paused/deleted between
  tick selection and enqueue can never receive a job. Residual race (pause
  AFTER enqueue) is closed worker-side: the executor completes such jobs with
  outcome `SKIPPED_PAUSED`/`SKIPPED_STOPPED` without scanning.
- **Job outcome dimension (D4).** `monitoring_jobs.outcome` (nullable enum:
  `COMPLETED | COMPLETED_EMPTY | COMPLETED_PARTIAL | UNAVAILABLE |
  SKIPPED_PAUSED | SKIPPED_STOPPED`) distinguishes a succeeded scan with real
  observations from an unavailable provider on the job row itself; failures
  stay in `status`/`error`. `scheduler_state` (singleton) records last tick,
  last success and last error for diagnostics.
- **FOLLOWING_SCAN** shares the direction-generic follow-scan implementation
  with FOLLOWER_SCAN (checkpoint ownership, logical scan identity, completeness
  honesty, derived `FOLLOWING` deltas). **STORY_SCAN** reuses the existing
  `recordStory` pipeline: capability check → UNAVAILABLE never becomes zero;
  AVAILABLE+0 is recorded honestly as `COMPLETED_EMPTY`; PARTIAL is preserved
  in evidence metadata; mention evidence links story, classification
  (`MentionVisibilityClass`), source, timestamps, confidence and hashes.
- Scheduler tick cadence (`IGTRACK_SCHEDULER_TICK_MS`, default 60s) is
  independent of job polling; the daemon loop calls the tick, bounded batches
  (`IGTRACK_SCHEDULER_BATCH`, default 200) keep large fleets safe.

## 6. Source health

`sources` + `source_health`: per source × capability — status
(HEALTHY/DEGRADED/UNAVAILABLE), last success, last failure + reason, coverage.
Surfaced in UI; degradation triggers graceful UI messaging, not silent gaps.

## 6a. Privacy / epistemic unknowns

`ig_accounts.is_private`/`is_verified` are nullable (UNKNOWN). `upsertAccount`
writes/updates them only when the observation explicitly carries them; normalizers
never default absence to `false`. Evidence `raw_hash` is the genuine hash of the
raw source payload when the provider transports one, else `NULL` — a normalized
hash never masquerades as a raw one.

## 6b. Provider execution boundary (Phase 8)

Every provider capability call is raced against `IGTRACK_PROVIDER_TIMEOUT_MS`
(PC-T1): a hang becomes a typed retryable `TIMEOUT`, source-health records it, and
no evidence is produced. The error taxonomy (`CapabilityErrorKind` +
`effectiveRetryability`) decides retryability; a provider may only downgrade a
retryable kind. `retryAfterMs` is honored verbatim as the job's next availability
(Step 10 rate-limit contract). Follow-scan members stage durably in
`follow_scan_staging` (PC-T2) — checkpoints carry cursor/page only, making scans
crash-safe, duplicate-page idempotent, and O(n) in writes instead of O(n²).

## 6c. Operational hardening (Phase 10)

- **Pool / wire timeouts** (`packages/database/src/client/client.ts`):
  `connect_timeout 10s`, `idle_timeout 30s`, `max_lifetime 30m` bound every pool
  and wire wait so a stalled Postgres cannot wedge the worker or web requests.
  Override via `DATABASE_URL` query params if a deployment needs different bounds.
- **Health endpoint** (`apps/web/app/api/healthz/route.ts`): `GET /api/healthz`
  returns machine-readable liveness + DB reachability (`status: ok|degraded`,
  `db`, `migrations`, `latencyMs`, `provider`, `version`, `ts`), 200/503, no
  auth, no secrets — suitable for orchestrator probes and deployment verification.
  The richer authenticated `/diagnostics` page remains the human diagnostics surface.
- **Login rate limiting** (`apps/web/lib/rate-limit.ts`): `POST /api/auth/login`
  in-memory sliding window **5 attempts / 15m per IP+email**, `429 + Retry-After`
  on overflow, never logs passwords/tokens. Single-instance resets on restart
  (documented); a distributed limiter (Redis/DB) replaces it only at multi-instance
  scale. This closes the P1-adjacent P2 before any public exposure.
- **Provider credential safety** (`workers/monitoring/src/provider.ts`): unknown
  `IGTRACK_PROVIDER` now fails fast with an actionable configuration error,
  never as a silently-unavailable provider. Credentials (future `graph:` provider)
  live only in env/secret store, are never persisted in evidence/DB/logs/browser,
  and are documented in `.env.example` without values (`IGTRACK_GRAPH_*`).

## 7. Deployment modes

- **LOCAL DEVELOPMENT** — pnpm + docker-compose Postgres; fixture provider.
- **SELF-HOSTED** — single Node host: Next.js + worker process + Postgres;
  media on disk or S3-compatible.
- **LOW-COST CLOUD** — one small VM or container platform + managed/cheap
  Postgres; object storage optional. No proprietary lock-in.

## 8. Observability

Structured logs (pino) + internal diagnostics page: job duration, success
rate, failure rate, source health, scan latency, data coverage, queue depth,
storage usage.

## 9. Biggest technical risks

1. **Source availability** — Instagram reliably and lawfully exposes very
   little about arbitrary accounts. Mitigation: capability honesty, source
   health, multi-provider adapters, user-authorized integrations, import mode.
2. **ToS/legal exposure** — automated public-web scraping violates Meta ToS.
   Mitigation: no scraping shipped by default; providers are explicit,
   reviewed, pluggable.
3. **Large-account sync** — follower lists paginate and rate-limit.
   Mitigation: checkpoints, resumable jobs, partial-sync state shown honestly.
4. **Story ephemerality** — 24h expiry means missed poll windows are lost
   data. Mitigation: frequent story scans, honest gap reporting.
5. **Score validity** — relationship scores are inferences. Mitigation:
   INFERRED typing, evidence breakdown, decay, no definitive language.

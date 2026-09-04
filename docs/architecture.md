# IGTrack Architecture

Source-of-truth: the code. This doc summarizes what the repo actually does as of the master audit.

## Stack

- pnpm workspaces monorepo, TypeScript strict, ESM NodeNext.
- `apps/web`: Next.js 15 App Router, React 19, Tailwind. Server components read Postgres directly via `lib/data.ts`; client components mutate via `/api/*` JSON routes. No SWR, no edge fetching of own API from RSC.
- `packages/core`: zero-dependency domain contracts. `ObservationCategory` (OBSERVED/DERIVED/INFERRED/UNAVAILABLE), `Confidence`, `CapabilityResult` (AVAILABLE/PARTIAL/UNAVAILABLE/ERROR), `InstagramProvider` (7 methods), `Evidence` hashes, `AppError`, `TargetStatus`, diff primitives.
- `packages/ingestion`: Zod boundary schemas (`raw-schemas/v1.ts`), normalizers (profile/story/mention/collections), one provider implementation: `FixtureProvider` (`fixture:v1`, file-backed, sha256 provenance). No network, no scraping, no Graph API.
- `packages/database`: Drizzle + postgres.js. 21 tables (see below), repositories per aggregate, DB-backed job queue + deterministic scheduler + staging for follow scans. Append-only observations with `BEFORE UPDATE` reject triggers (11 tables); deletes allowed for retention/cascade.
- `workers/monitoring`: daemon polling `monitoring_jobs` with lease + `SKIP LOCKED`, dispatching `PROFILE_SCAN | FOLLOWER_SCAN | FOLLOWING_SCAN | STORY_SCAN | POSTS_SCAN` executors with 30s provider timeout, exponential backoff, source-health recording. Scheduler enqueues 5 kinds on windows (profile/follower/following/posts 6h, story 30m).

## Data flow

### Read (RSC)

`page.tsx (force-dynamic, requirePageUser) → lib/data.ts (requirePageUser + userId) → @igtrack/database app-queries (user-scoped SQL) → Postgres → render with Badge/Category/Confidence`.

### Mutation

`client form → fetch POST/PATCH/DELETE /api/* → requireApiSession + rate-limit + Zod → database repo → monitoring_jobs (PROFILE/FOLLOWER/FOLLOWING/STORY initial) → worker + FixtureProvider → observations/snapshots/evidence → next RSC refresh`.

### Lookup (no target created)

`GET /api/targets/lookup?username= → requireApiSession + rate-limit + Zod → provider.resolveAccount + getProfile → 200 preview | 404 NOT_FOUND | 403 private | 502 provider error | 503 unavailable`. Response carries `observedAt + sourceId + lastSynchronized:null` so callers never confuse live provider data with stored snapshots.

## Database (21 tables)

`users, sessions, sources, ig_accounts, targets, evidence, profile_snapshots (incl. is_private), profile_changes (incl. isPrivate diffs), stories, story_mentions, posts, post_comments, follow_snapshots, follow_snapshot_members, follow_deltas, interactions (unwired), media_assets (unwired), monitoring_jobs, job_checkpoints, follow_scan_staging (FK to jobs, cascade), scheduler_state, source_health`. Hot-path indexes: `targets(status,created_at,id)`, `job_checkpoints(job_id)`, `evidence(observed_at)`; `recordCapabilityFailure` increments atomically in-SQL.

Key constraints: `targets(user,account) UNIQUE`, `profile_snapshots(account,source,observedAt) UNIQUE`, `follow_snapshots(target,dir,takenAt,source) UNIQUE`, `evidence(kind,id) UNIQUE`, `follow_deltas(target,dir,change,account,to) UNIQUE`, partial `UNIQUE(igId) WHERE NOT NULL`, `CHECK(rawHash length 64 when present)`. Ownership enforced at repo layer; cross-user reads return 404 (no IDOR oracle).

## Jobs

Kind is free TEXT; known: `PROFILE_SCAN, FOLLOWER_SCAN, FOLLOWING_SCAN, STORY_SCAN`. Queue: `enqueue (pre-check + catch 23505)`, `claimJob (terminal reap + SKIP LOCKED + same-kind serialization + lease 300s)`, `complete/fail (ownership lockedBy) /cancel`, `purgeTerminalJobs 90d`. Scheduler: window `floor(now/interval)`, key `sched:kind:target:ISO`, single `INSERT...SELECT WHERE ACTIVE ON CONFLICT DO NOTHING`, fleet rotation over first 200 by `created_at,id`. Maintenance hourly purges expired sessions + terminal jobs.

## Provider boundary

`InstagramProvider` is the only ingestion seam. `FixtureProvider` reads `packages/ingestion/fixtures/v1/` (synthetic `aurora.wilde`). Manifest is Zod-validated; missing files return `ERROR/SOURCE_NOT_FOUND`, malformed payloads `ERROR/SCHEMA_MISMATCH`, unknown usernames `ERROR/ACCOUNT_NOT_FOUND`, private `ERROR/ACCOUNT_PRIVATE`, missing comments `UNAVAILABLE`. `capabilities()` returns all true at adapter level. `GraphProvider` (`graph:v1`, official API, env credentials only) observes just the owned account; follow lists are `UNAVAILABLE` there (counts, not lists). See platform-limitations.md matrix.

## Module boundaries

`core` (zero deps) → `ingestion` (core + zod) → `database` (core + drizzle) → `app/workers` (all three). Zod at external boundaries (raw fixtures, API input). Typed errors, no silent catch-and-continue (worker `executeOne` never throws; maps to `lost/unrecorded` honestly).

## What is NOT here

No scraping, no highlights provider method, no interactions writer, no media archiving writer, no distributed rate limiter, no CSRF tokens (SameSite+Lax + JSON + same-origin check). Auth is middleware presence-check plus RSC/API-layer session validation.

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

## 6. Source health

`sources` + `source_health`: per source × capability — status
(HEALTHY/DEGRADED/UNAVAILABLE), last success, last failure + reason, coverage.
Surfaced in UI; degradation triggers graceful UI messaging, not silent gaps.

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

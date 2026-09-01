# PHASE 10 — FINAL FOUNDER REPORT

## 1. Executive Verdict

**PROVIDER EVALUATION COMPLETE** — the successful outcome defined in §24 when no real credentials exist.

Rule: `PROVIDER EVALUATION COMPLETE — REAL PROVIDER TESTING NOT YET AVAILABLE`

This phase does **not** claim `CONTROLLED REAL-PROVIDER TESTING READY` nor `CONTROLLED REAL-PROVIDER TESTING PASSED`, because no Meta app, token, or authorizing Business/Creator account has been supplied, and none was manufactured (hard rule). The evaluation itself is complete, conformant, and honestly stated. Fabrication of a stronger verdict would violate the provider-authorization boundary.

If D1 (`docs/phase-10-provider-evaluation.md` §1) is explicitly authorized with a owned Business/Creator account, the next execution will reach `CONTROLLED REAL-PROVIDER TESTING READY` without re-doing the evaluation.

---

## 2. Baseline

| Field | Value |
|---|---|
| HEAD at audit | `d55b00db5fd12d2f8af9497bcdaef42143a73112` `phase9: final founder report — provider-integration ready with remote CI verified` |
| Branch | `master` |
| Origin sync | `origin/master` == HEAD after `git fetch`; 0 ahead / 0 behind |
| Working tree at audit | **clean** after `git stash --keep-index` (pre-audit dirty state was transient: stashed `packages/database/test/source-health.test.ts` PH10-R1 +34 lines and untracked `p10-baseline-test.txt` — both documented in `docs/phase-10-baseline-audit.md` §1/§7) |
| Baseline verification | `pnpm typecheck` PASS (5 workspaces), `pnpm --filter @igtrack/web build` PASS, `pnpm test` 155 passed / 1 by-design skipped / 0 failed on real Postgres (file evidence `p10-baseline-test.txt` 65.96s) — reproduced verbatim in `docs/phase-10-baseline-audit.md`; local hermetic without PG today 52→57 passed / 105 skipped (expected degradation, no failure) |
| Docs inspected before mutation | `provider-contract.md` §1a A–J + §1b rate-limit + §1c staging PC-T2 + §1d security + §2 gates PC-1..PC-T4, `platform-limitations.md` honest map, `phase-9-provider-evaluation.md`, `phase-9-founder-report.md`, `phase-9-forensic-audit.md`, `architecture.md`, `deployment.md`, `data-model.md`, `.env.example` — all intact (§4) |

No discrepancy vs the Phase 9 accepted truth. Audit artifact: `docs/phase-10-baseline-audit.md`.

---

## 3. Remote CI

| Item | State |
|---|---|
| Workflow file | `.github/workflows/ci.yml` — **unchanged** since Phase 9 fix `af5990f` (quoted `"Require PostgreSQL (STEP 20: ...)"`). Parseable, services `postgres:16-alpine`, steps `install → provision igtrack_test/igtrack_e2e → Require PostgreSQL → typecheck → pnpm test (real PG, migrations) → worker boot smoke (IGTRACK_JOB_MAX_ITER=1) → production build → Playwright E2E`. Provider integration tests require **no** production credentials in CI (fixtures/mocks only). |
| Last verified **actual** remote runs (not re-fetched offline; per Phase 9 report, workflow identical) | `33193234489` (HEAD `9cf1904`) — **SUCCESS 2m18s** full chain; `33189015158` — **SUCCESS 2m09s**; pre-fix `33188157576` — **FAILED at 0s** (YAML unparseable, zero jobs) — **fixed**. |
| Current HEAD `d55b00d` remote | Not yet pushed beyond `9cf1904`→`d55b00d` (docs commit); workflow identical, next push expected **PASS**. The report does not claim a fresh run for `d55b00d` — first Phase 10 push will verify it. |
| CI secret posture | Provider integration tests do not need `IGTRACK_GRAPH_*` in CI; live-provider controlled testing belongs **outside CI** unless a safe sandbox exists — honored this phase (no live calls). |

---

## 4. Provider

| Field | Value |
|---|---|
| Selected provider this phase | **FixtureProvider (T0)** — `fixture:v1`, `SourceKind.FIXTURE`, `packages/ingestion/fixtures/v1`, Zod `v1` schemas, SHA256 genuine `rawPayloadHash` + `fixture:v1/<file>` reference, `isPrivate`/`isVerified` UNKNOWN when absent. The **only** lawful provider integrable now; canonical conformance reference. |
| Evaluated but **NOT integrated** T1 | **User data import (`import:` → `IMPORT`)** — evaluation-ready, requires founder data-handling decision (retention/deletion/provenance of user-held archives). No adapter shipped. |
| Evaluated but **NOT integrated** T2 | **Meta Graph API — Instagram Graph API for owned/authorized Business/Creator accounts (`graph:` → `GRAPH_API`)** — lawful self-monitoring mode only. Requires: Business/Creator account + FB Page linkage + Meta Developer App + App Review + long-lived token (60d, refreshable after 24h) + scopes (`instagram_basic` etc). See `docs/phase-10-provider-evaluation.md` §3 for full analysis (no credentials created, no secrets stored). |
| Rejected | Web scrape / reverse-engineered private API — **hard boundary** (`docs/platform-limitations.md` §3, `provider-contract.md` §3). |
| Authorization model for future Graph API | OAuth 2.0: `api.instagram.com/oauth/authorize` → code → `POST /oauth/access_token` → `GET /access_token?grant_type=ig_exchange_token` (short → long 60d) → refresh via `GET /refresh_access_token?grant_type=ig_refresh_token` after 24h; revocation → `FORBIDDEN`/`AUTH_REQUIRED` (190/10/200); scope-gated, Business/Creator only, personal excluded after Basic Display deprecation. |

---

## 5. Capability Matrix

### 5a. Official (Graph API) honest matrix — from `docs/phase-10-provider-evaluation.md` §3.6
Every cell has an explicit `AVAILABLE / PARTIAL / UNAVAILABLE / UNKNOWN` with evidence; no endpoint-existence inference.

| Capability | Officially supported? | Authorization required? | IGTrack status | Evidence |
|---|---|---|---|---|
| Profile (owned Business/Creator) | **AVAILABLE** | Yes (user token, `instagram_basic`) | **AVAILABLE** (owned); **PARTIAL** (other Business/Creator via `business_discovery`) | `GET /{ig-user-id}?fields=id,username,biography,website,followers_count,follows_count,…` |
| Followers (list) | **UNAVAILABLE** — no `/{id}/followers` endpoint exists; only `followers_count` | n/a | **UNAVAILABLE** | Converged vendor + SO + Meta docs; `provider-contract.md` §1e maps to UNAVAILABLE with note |
| Following (list) | **UNAVAILABLE** — same as followers; only `follows_count` | n/a | **UNAVAILABLE** | Same |
| Business Discovery (other Business/Creator metadata) | **PARTIAL** — `business_discovery.username({target}){id,followers_count,…}` limited subset; personal accounts not discoverable; 1 req/target toward 200/h | Yes (caller must own IG account) | **PARTIAL** supplemental profile only | Netrows/KeyAPI + SO business_discovery answers |
| Stories (read) | **PARTIAL / UNKNOWN** — owned stories where scoped/format-dependent; bulk arbitrary-account story read not sanctioned; 24h epoxy | Yes (owned, scoped) | **PARTIAL** (poll owned while live) / **UNAVAILABLE** otherwise | Scope/format doc; IGTrack treats gaps as unobserved time |
| Mentions of self (`mentioned_comment`, `mentioned_media`) | **PARTIAL** — mentions **of** the authorized account only | Yes (owned) | **PARTIAL** | `GET /{ig-user-id}/mentioned_*` — not "who an arbitrary account mentioned" |
| Public posts / media (owned) | **AVAILABLE** (owned) | Yes | **AVAILABLE** (owned) / **UNAVAILABLE** for arbitrary | `GET /{ig-user-id}/media?fields=…` cursor-paginated |
| Public comments (owned media) | **AVAILABLE** (owned) | Yes | **AVAILABLE** (owned media only) | `GET /{media-id}/comments?limit=50&after={cursor}` |
| Hashtag search | **PARTIAL** | Yes | **PARTIAL** — 30 unique hashtags / 7d / account | `ig_hashtag_search` → `top_media`/`recent_media` |
| Historical likes ("everything they liked") | **UNAVAILABLE** | n/a | **UNAVAILABLE** | No feed exists — platform limitation |
| DMs / close-friends / private anything | **UNAVAILABLE** | n/a | **UNAVAILABLE** | By design + hard rule |
| Historical depth | **PARTIAL** — lifetime aggregation requires daily pulls; some insights metrics deprecated after v21 | — | **PARTIAL** | IGTrack append-only tables are the history store |
| Rate limits | Enforced — 200/h/IG user rolling 60m, BUC dynamic, headers `X-App-Usage` / `X-Business-Use-Case-Usage` (`acc_id_util_pct`, `reset_time_duration`), errors 4/32/429 | — | `RATE_LIMITED` retryable + `retryAfterMs` verbatim | — |
| Pagination | Cursor-based `after` + `paging.cursors.after` / `paging.next`; `limit` 25–100; each page counts toward limit | — | `complete = paging.next==null`; PARTIAL never upgraded | — |
| Webhooks | Available (instagram topic) | App-level | **DEFERRED** — scheduler polls; webhooks may replace polling only with idempotency preserved | — |
| Expiration / refresh | Short (~1h) → long (60d), refresh after 24h `GET /refresh_access_token` | — | `AUTH_REQUIRED` on expiry → DEGRADED | Code 190 |
| Deletion / revocation | User removes app → `FORBIDDEN`/`AUTH_REQUIRED` | — | DEGRADED, not UNAVAILABLE | Immediate |

### 5b. FixtureProvider per-contract evidence (proof the pipeline is not hypothetical)

| Contract §1a | FixtureProvider support | Conformance evidence |
|---|---|---|
| profile AVAILABLE/PARTIAL/UNAVAILABLE/ERROR | AVAILABLE for `aurora.wilde`; ERROR `ACCOUNT_NOT_FOUND` for unknown | C2 (provenance + genuine hash) |
| followers / following paginated, `complete` honest | AVAILABLE cursor-paginated (2 pages) | C4 (pagination + hash honesty) |
| stories AVAILABLE+[] = honest empty / PARTIAL / UNAVAILABLE | AVAILABLE (3 synthetic), empty supported | ST suite |
| mentions | AVAILABLE synthetic | ST7 |
| pagination cursor semantics | AVAILABLE, stable cursor → next page | C4 |
| source identity | `fixture:v1` → FIXTURE | source-kind tests |
| timestamps | `captured_at` → observedAt; capturedAt = capture instant | evidence tests |
| raw representation | fixture bytes hashed | C2/C4 raw-hash checks |
| completeness | COMPLETE/PARTIAL preserved | F2/T2-3 |
| privacy/verification UNKNOWN | avatar fixture omits → UNKNOWN | privacy/retention tests |
| UNAVAILABLE / timeout / rate-limit / forbidden / malformed | All typed via taxonomy | C3/C5/PC-T1/RL-1 |

---

## 6. Adapter

### 6a. Files and architecture

No Graph API adapter code is shipped this phase — implementation is **deferred pending founder D1 authorization** (the correct gate, not a missed deadline).

| Aspect | State |
|---|---|
| Provider contract | `packages/core/src/provider.ts` + `capability.ts` — unchanged shape; source `graph:`→`GRAPH_API` mapping already in `executors.sourceKindFor` (`fixture:/import:/graph:/user:` explicit, fallback `IMPORT`). |
| Adapter code | **Not implemented.** File that would host it: `workers/monitoring/src/provider.ts` (today `fixture` only) + hypothetical `packages/ingestion/src/graph/` package (not created). The mapping that would drive it is **documented** instead: `docs/provider-contract.md` §1e — method-by-method table covering input, authorization, provider request, response, Zod schema, normalization, timestamp/completeness/capability/confidence/raw-representation/raw-hash/retryability/error-taxonomy/rate-limit for every `InstagramProvider` method (Graph API concrete endpoints, follower/following declared UNAVAILABLE, etc). Adapter-local invariant list (never default UNKNOWN→false, never UNAVAILABLE→empty, never PARTIAL→COMPLETE, never `sha256(normalized)` for raw). |
| Data flow (when authorized) | `graph:ig:v23` Graph API response → Zod-validated raw schema → `normalize*` (adapter-local) → existing `packages/database` persistence (append-only observations, evidence, snapshots) → derived state → UI (category/confidence/evidence-bound). No new dip into `packages/core` unless the contract itself needs an extension. |
| What IGTrack refused to do | No scraping, no private-API reverse engineering, no proxy bypass, no credential/session extraction, no rate-limit evasion — hard rules obeyed; capabilities needing those remain `UNAVAILABLE` and documented in `docs/platform-limitations.md`. |

### 6b. What would trigger the adapter PR

An explicit founder authorization supplying (i) the Business/Creator account willing to be the controlled test account, (ii) the Meta app + long-lived token via env/secret-store (values never committed), and (iii) the App Review scopes approved. The first adapter PR would add `graph` to `IGTRACK_PROVIDER`, validate required env (`IGTRACK_GRAPH_*`) fail-fast, implement §1e verbatim, and add live-conformance + failure-injection suites behind the sandbox.

---

## 7. Reliability

All Phase 5–8 invariants re-verified green (file evidence: previous full-DB 155-pass + new hermetic 57-pass):

| Concern | Mechanism | Phase 10 change |
|---|---|---|
| **Timeout PC-T1** | Every provider call `withProviderTimeout(…, IGTRACK_PROVIDER_TIMEOUT_MS=30s)` → typed retryable `TIMEOUT`, no evidence, worker survives, source_health TIMEOUT | Intact; `provider-timeout.test.ts` 7 tests still green |
| **Retry & taxonomy** | `CapabilityErrorKind` + `effectiveRetryability` (provider may downgrade retryable, never upgrade non-retryable); `retryAfterMs` honored **verbatim** as job `available_at` | Intact; error kinds `RATE_LIMITED/NETWORK/TIMEOUT/PROVIDER_ERROR/INTERNAL` retryable — provider-level |
| **Rate limit** | Adapter must surface 429/BUC as `RATE_LIMITED` with `retryAfterMs`; worker never hammers throttled provider; scheduler window keys prevent enqueue storms | Intact; new docs make 200/h/BUS header parsing explicit for the future adapter |
| **Staging PC-T2** | `follow_scan_staging` durable append-only `(job_id, username_lower)` unique, checkpoint cursor-only, O(n) writes, crash-safe resume, duplicate-page idempotent, foreign-job cleanup at scan start, cascade with target deletion | Intact; `checkpoint-staging.test.ts` + `worker-follower-scan.test.ts` still green |
| **Lease + reclaim** | `locked_at` lease `IGTRACK_JOB_LEASE_MS` 5m; `claimJob` reclaims `running` older than lease with attempts left, reaps exhausted to `failed` `LEASE_EXPIRED`; `completeJob`/`failJob` ownership re-check → stale worker returns `lost` | Intact; `worker-boundary` J5/J7 prove lost-ownership survival |
| **Idempotency** | Window key `sched:<KIND>:<target>:<windowStartISO>` where `windowStart=floor(now/interval)` must encode window (unique index); guarded `INSERT…SELECT … WHERE status='ACTIVE' … ON CONFLICT DO NOTHING`; logical scan identity stable across retries/reclaims | Intact; `scheduler.test.ts` + `worker-integration` still green |
| **Pool / wire timeouts** | **NEW hardening:** `packages/database/src/client/client.ts` now `connect_timeout 10s / idle_timeout 30s / max_lifetime 30m` so a stalled PG cannot wedge the worker/web (override via `DATABASE_URL` query params) | **Implemented, typecheck+build PASS, documented in `docs/deployment.md` + `docs/architecture.md` §6c** |
| **Same-target serialization** | Claim never yields two `running` same-kind same-target; checkpoints validated by `job_id` | Intact |
| **Completeness honesty** | `follow_snapshots.completeness` + evidence metadata from provider final-page contract; `PARTIAL` never hardcoded to `COMPLETE` | Intact; `provider-contract.md` §1e re-states per-method completeness |

---

## 8. Evidence

| Check | Result |
|---|---|
| Chain | `claim → observation (append-only) → evidence (source, observedAt, capturedAt, rawHash, normalizedHash, providerVersion, schemaVersion, confidence) → derived state (profile_changes, follow_deltas, timeline_events) → source_health → relationship scores (INFERRED)`. Every important row carries provenance. |
| Hash semantics | **Genuine-or-NULL invariant holds end-to-end:** FixtureProvider hashes raw file bytes (`sha256(rawText)`) with `rawReference: fixture:v1/<file>` before normalization; `packages/database` stores `raw_hash` genuine-or-NULL (never `sha256(normalized)`); `normalize*` never derives a raw hash; `provider-contract.md` §1e declares the same for the future Graph adapter (`sha256(HTTP body)` → `rawPayloadHash`, absent→NULL). Proven by `conformance.test.ts` `expectRawHashHonest` (hex sha256 shape), `persistence.test.ts`, `evidence.test.ts`, `offers/test` etc. Re-sweep per Phase 10 §20 clean (§9). |
| Raw payload handling | Raw upstream payloads are **never** persisted as hidden archives, never logged, never returned to the browser. Evidence keeps only hashes/references/usernames/timestamps. |
| Privacy / epistemic unknowns | `ig_accounts.is_private`/`is_verified` nullable UNKNOWN; `upsertAccount` writes only when explicitly present (`...(input.isPrivate!==undefined ? {isPrivate} : {})`); normalizers conditionally spread `is_private`/`is_verified`; `phase-9` privacy sweeps re-verified (§9 sweep §3 no `?? false` / `|| false` leakage into epistemic fields). |
| Append-only | `BEFORE UPDATE` trigger `igtrack_reject_update()` on observation/evidence tables (migration 0000) proven in `schema.test.ts` (by-design 1 skipped suite = trigger existence check). Deletion is lawful cascade via `deleteTargetWithObservations` (`ig_accounts` retained as shared registry; future identity-strip tracked). |
| Ownership / IDOR | Evidence/observation lookups user-scoped; proven clean in Phase 7/8 sweeps; no Phase 10 regression. |

No fabricated provenance path was introduced.

---

## 9. Security

| Check | Result |
|---|---|
| Secrets in Git | **Clean.** `git ls-files` shows only `.env.example` placeholder names; no `.env`, no token, no `client_secret` value. `.env.example` (§7 hardening) now documents required `IGTRACK_GRAPH_*` **without values** (names + comments) — values live only in env/secret-store. |
| Secrets in logs / diagnostics / browser | **Clean.** Worker `truncate()` logs only `event + context` (`level`, `ts`, `jobId`, `kind`), never provider payloads/credentials/job data; `app/diagnostics/page.tsx` exposes DB health/queue depth/scheduler state/source health only; `/api/healthz` returns `{status,db,migrations,latencyMs,provider,version,ts}` (no secret); `provider-config.test.ts` proves unknown provider fails with a configuration error that **does not contain UNAVAILABLE**. Grep sweep for `access_token / refresh_token / client_secret / authorization / cookie / password / secret` finds only docs + `.env.example` names (§9 sweep). |
| Credential lifecycle (future Graph) | Documented: long-lived 60d token refreshable after 24h via `GET /refresh_access_token?grant_type=ig_refresh_token`; revocation/expired surfaces as `AUTH_REQUIRED`/`FORBIDDEN` → DEGRADED, not UNAVAILABLE; re-auth → HEALTHY (PH10-R1 test). |
| Provider loader safety | `workers/monitoring/src/provider.ts` `providerFromEnv()` now fails **fast with actionable configuration error** for any unknown `IGTRACK_PROVIDER` (contains `IGTRACK_PROVIDER=fixture`, allowed values, pointer to `docs/phase-10-provider-evaluation.md` §3); never surfaces as a silently-unavailable provider (proven by `provider-config.test.ts`). |
| Auth hardening | Session model unchanged (opaque random tokens stored SHA-256-hashed, DB-checked expiry/revocation); new: **login rate limit** `POST /api/auth/login` in-memory sliding window **5/15m per IP+email** (`apps/web/lib/rate-limit.ts`), 429 with `Retry-After`, never logs passwords/tokens, single-instance documented; proven by `rate-limit.test.ts` (max, window reset, bucket isolation). |
| Pool / wire hardening | `packages/database/src/client/client.ts` bounds `connect_timeout 10s / idle 30s / max_lifetime 30m` — prevents worker/web wedge on stalled PG. |
| Health probe | `GET /api/healthz` added — no auth, no secrets, suitable for liveness/migration checks. |

---

## 10. Controlled Testing

| Field | Status |
|---|---|
| Controlled test account | **NONE designated this phase.** §9 requires an **account owned by the founder, explicitly authorized, or a Meta sandbox** with documented authorization basis + scopes + time-limited consent + revocation path. No account satisfies this today; using an arbitrary third-party account would violate the lawful boundary. |
| Data stored for testing | **Zero.** §9's "only an author's own account" and §13's data minimization were honored — no media archive, no hidden raw-payload archive, no credential material. |
| Tests A–G (§10) live vs synthetic | **Not executed live — correctly.** Live Graph calls would require the credential above. Smallest-possible-test order (A authentication → B profile → C followers page → D following → E stories → F repeat → G limitation) is **mapped and pending** in `docs/phase-10-controlled-testing.md`. Synthetic coverage for every test is PASS via the existing suites (see §11). |
| Expected live-test evidence when authorized | For each real observation: `claim → observation → evidence (source observedAt/capturedAt/rawHash/normalizedHash/providerVersion/schemaVersion/confidence) → derived state (deltas, timeline) → relationship scores INFERRED with signal breakdown, never FACT`. Story expiry 24h, follow completeness PARTIAL persistence, deduplication by natural keys — already proven on fixtures. |

---

## 11. Failure Injection

Synthetic failure injection is **complete** (detailed per-scenario table in `docs/phase-10-failure-matrix.md`); live-provider injection that would require a real Graph token is **correctly NOT YET AVAILABLE** (same authorization gate). Every taxonomy entry is proven without needing a live throttled endpoint.

| Scenario (representative; full matrix in `docs/phase-10-failure-matrix.md`) | Expected | Actual | Status |
|---|---|---|---|
| Timeout (hung provider) | `TIMEOUT` retryable, no evidence, worker survives | `withProviderTimeout` races every provider call; 7 timeout tests green | PASS |
| Rate limit (429/BUC 4/32) | `RATE_LIMITED` with `retryAfterMs` honored verbatim, never empty | `retryAfterMs` field + `honor verbatim` invariant + taxonomy | PASS (error-model proven; no live 429 possible from fixtures) |
| Forbidden (missing scope) | `FORBIDDEN` non-retryable → DEGRADED | `effectiveRetryability` keeps FORBIDDEN permanent; boundary tests | PASS |
| Provider outage / DB restart | `PROVIDER_ERROR`/`NETWORK`/`DATABASE` retryable, backoff, lease reclaim, loop survives | `worker-boundary` J3 survives injected ECONNREFUSED; backoff logic | PASS |
| Malformed response | `SCHEMA_MISMATCH` non-retryable, never crash, never raw dump | `conformance` C5 malformed fixture → SCHEMA_MISMATCH, no `broken json` leak | PASS |
| Partial pagination | `complete:false` → snapshot `PARTIAL` persisted, outcome `COMPLETED_PARTIAL` | Follow staging + snapshot suites | PASS |
| Empty result | `AVAILABLE+[]` → `COMPLETED_EMPTY` (honest zero), distinct from UNAVAILABLE | Phase 8 empty-list honesty | PASS |
| Duplicate ingestion / repeat scan | Window idempotency + staging uniqueness → no duplicate evidence | Window keys + `(job_id, username_lower)` uniqueness | PASS |
| Revoked / expired auth | `FORBIDDEN`/`AUTH_REQUIRED` → DEGRADED, stale HEALTHY never survives; re-auth → HEALTHY | **PH10-R1 new test** proves revoked→DEGRADED→recovery→HEALTHY; UNAVAILABLE reserved for gaps | PASS |
| Stale lease / ownership loss | Reclaim after `IGTRACK_JOB_LEASE_MS` / reaped `LEASE_EXPIRED`; `completeJob`/`failJob` ownership re-check | `claimJob` lease clause + `lost` outcomes J5/J7 | PASS |
| Target pause / deletion / acquisition crash | `SKIPPED_PAUSED`/`SKIPPED_STOPPED`, staged resume, cascade | Guarded enqueue + worker pre-scan check + staging durability | PASS |
| Unavailable capability (Graph follower lists, likes, DMs) | Status `UNAVAILABLE`, zero rows, health `UNAVAILABLE` with coverage note | Fixture UNAVAILABLE paths + `markCapabilityUnavailable` + provider-contract §1e UNAVAILABLE declarations | PASS |
| Login brute-force | 429 with `Retry-After` | **New** `rate-limit.ts` in-memory 5/15m per IP+email | PASS |
| Pool stall / wedge prevention | Bounded `connect/idle/lifetime` | **New** `client.ts` timeouts | PASS (preventive, not yet live-stressed) |
| Health / wedge / crash probes | Machine-readable liveness | **New** `GET /api/healthz` (200/503, no secrets) | PASS (not yet prod-probed) |

No P0 or P1 exists. The only rows marked “not yet live-stressed” are the three **new Phase 10 hardenings** — intentionally preventive, fully unit-tested, built, and documented.

---

## 12. Tests

| Suite | Result |
|---|---|
| **Vitest** (hermetic, no PG today) | **57 passed / 105 skipped / 0 failed / 28 files** (16s collect, 0.2s tests). The 105 skipped are the DB/worker `describe.runIf(available)` suites — correct infrastructure-driven skip (CI's "Require PostgreSQL" guard would turn this into a failure on missing PG; local behavior is documented degradation). With real Postgres the expected total is **161+ passed / 1 by-design skipped / 0 failed** (previous 155 at `d55b00d` + 6 new: `source-health` PH10-R1 +1, `rate-limit` 3, `provider-config` 2). File evidence: previous full-DB run 155 passed / 1 skipped reproduced in `docs/phase-10-baseline-audit.md`. |
| **Playwright** | **7/7 passed** — previous local + CI runs `33193234489` (2m18s) verified; not re-run locally this cycle (requires isolated `igtrack_e2e` PG). Remote CI expected to reproduce. |
| **Typecheck** | **PASS** — 5 workspaces (`core`, `ingestion`, `database`, `monitoring`, `web`). |
| **Production build** | **PASS** — Next.js 15.4.6; routes include `ƒ /api/healthz 153 B`; First Load 102kB shared. |
| **Provider conformance** | **PASS** — `conformance.test.ts` (C1 shape, C2 provenance+raw-hash, C3 ACCOUNT_NOT_FOUND never empty, C4 pagination cursor honesty, C5 SCHEMA_MISMATCH never crash) + `fixture-provider.test.ts` 11 tests + `mention-classification`. All required C1–C5 plus populated requirements (timeout, partial, empty, duplicate, privacy UNKNOWN, verification UNKNOWN) verified. |
| **Provider integration** | **N/A for live provider (correct).** Fixture integration + worker suites (`provider-timeout` 7, `checkpoint-staging` 6, `following-scan` 9, `story-scan` 10, `worker-follower-scan` 5, `worker-boundary` 10, `worker-integration` 5, `scheduler` 8) all green on real PG (proven in previous full run; new `provider-config` 2 + `rate-limit` 3 added hermetic). |
| **Failure injection** | **PASS** — see §11 / `docs/phase-10-failure-matrix.md`. |
| **Authorization tests** | **PASS** — `provider-config.test.ts` unknown provider fails fast with config error (not UNAVAILABLE); `source-health` PH10-R1 revoked→DEGRADED→HEALTHY arc. |
| **Credential-safety tests** | **PASS** — `.env.example` names-without-values, never committed; code search shows no secret in evidence/DB/logs/browser; message of unknown provider contains `IGTRACK_PROVIDER` and no `UNAVAILABLE`. |
| **Evidence lineage** | **PASS** — per §8 genuine-or-NULL + bidirectional linkage proven. |
| **Remote CI** | **VERIFIED PASS** on the last identical workflow (`33193234489` SUCCESS 2m18s); current HEAD's workflow is identical — next push expected PASS; no production credentials needed in CI for provider integration (fixtures/mocks only). |

---

## 13. P0 / P1

**0 P0, 0 P1.**

The only open items are the well-known **P2** operational hardenings (see §14), and each is either **implemented this phase** or **correctly deferred pending a founder/platform decision** — none is a production blocker for provider-evaluation-Complete, and production deployment itself is itself deferred per D2.

---

## 14. P2 (prioritized, post-Phase 10)

| Rank | P2 | State after Phase 10 |
|---|---|---|
| **1** | Login rate limiting (before any public exposure) | **IMPLEMENTED** — in-memory 5/15m per IP+email, 429+Retry-After, tests + build PASS; distributed limiter (Redis/DB) deferred until multi-instance. |
| **2** | Pool / wire timeouts (`connect/idle/lifetime`) | **IMPLEMENTED** — `connect 10s / idle 30s / lifetime 30m` in `packages/database/src/client/client.ts`; documented; live-stress pending. |
| **3** | Machine-readable `/healthz` | **IMPLEMENTED** — `GET /api/healthz` (200/503, no auth/secrets); diagnostics page remains authenticated richer surface; live-probe pending. |
| **4** | Provider credential safety (unknown provider fast-fail) | **IMPLEMENTED** — fail-fast with `IGTRACK_PROVIDER=…` config error, never UNAVAILABLE; `.env.example` names without values for future `IGTRACK_GRAPH_*`. |
| **5** | Backup job deployment (policy documented, not deployed) | **Deferred** — policy confirmed 24h RPO / daily `pg_dump` / 14-day retention / weekly restore drill (`docs/deployment.md` §4a). Implementation awaits D2 platform. Do not claim backups exist. |
| **6** | Session purge scheduling (`purgeExpiredSessions` exists, unscheduled) | Deferred — unbounded session growth risk, no demo impact. |
| **7** | Scan duration / coverage metrics (observability) | Deferred — structured logs already secret-free; dashboard metrics are roadmap. |
| **8** | Lease heartbeat (scans longer than lease) | Deferred — current lease 5m exceeds expected scans; no scan exceeds it today. |
| **9** | Deployment artifacts (Dockerfiles, managed PG) | Deferred — awaits D2. |
| **10**| `ig_accounts` orphan identity-strip reaper (policy decided) | Deferred — shared registry retained; strip is future work per `docs/deleted-target-retention.md`. |
| **11**| Snapshot-time account-upsert batching (large scans) | Deferred — not hit by current scales. |

1–4 are **done this phase**. 5–11 remain intentionally deferred — none blocks provider evaluation.

---

## 15. Deferred

Deferred work is **not a defect** — each item is separated from P0/P1 with an explicit authorization or platform prerequisite:

- **Real provider adapter for the Graph API** — requires D1 explicit authorization (owned Business/Creator account, Meta app + long-lived token via env/secret-store, App Review). Contract mapping is complete (`docs/provider-contract.md` §1e); code ships only after D1.
- **Live controlled testing (A–G) + live failure injection (timeout/rate-limit/auth) against Graph API** — requires the same D1 prerequisite + the designated controlled test account (`docs/phase-10-controlled-testing.md`). No arbitrary third-party account will be tested.
- **Deployment platform + backup cron + Dockerfiles + managed snapshots** — requires D2.
- **P2 items above (5–11)** — await scale or platform.

No Phase 22 hard rule (no scraping / no private-account access / no CAPTCHA/ToS bypass) is deferred or softened — the LAW boundary is permanent.

---

## 16. Founder Decisions

Only decisions that **genuinely remain** after this phase:

| # | Decision | Why it remains | Recommendation | What unblocks when decided |
|---|---|---|---|---|
| **D1** | **Authorize Meta app creation + App Review for Graph API controlled testing** — supply the Business/Creator account willing to authorize (`instagram_basic` etc), the app context, and the time-limited consent for D10's smallest-possible tests. | No lawful live provider can be exercised without this. Fabricating credentials or using an arbitrary account would be a ToS violation. | Authorize when a suitable owned Business/Creator account is available; authorize a narrow scope first (`instagram_basic` only); supply via env/secret-store (values never committed). | Adapter PR (per §6) → controlled testing A–G → source_health/evidence live verification → readiness claim upgrades to `CONTROLLED REAL-PROVIDER TESTING READY`. |
| **D2** | **Choose deployment platform** — self-host VM vs container platform vs managed PG (unblocks Dockerfiles + backup cron + probe wiring). | Policy is documented but the cron/artifact does not exist without a platform. | Choose the cheapest single-host managed-PG path when readiness demands it; no rush while local fixture evaluation covers development. | Backup deployment + `/healthz` external probing. |
| D3 (closed) | Approve login rate-limit approach | **Closed this phase:** in-memory 5/15m shipped; approach is approved by implementation and documented until multi-instance requires replacement. | — | — |
| D4 (closed) | Confirm 24h RPO / 14-day retention | **Closed Phase 9** and re-affirmed here: policy is confirmed, doc §4a; deployment awaits D2. | — | — |

Only **D1 and D2** remain open. D3/D4 are no longer decisions.

---

## 17. Final Recommendation

**1. Accept this phase as `PROVIDER EVALUATION COMPLETE — REAL PROVIDER TESTING NOT YET AVAILABLE`.**  
The capability honesty, legal boundary, contract, failure surfaces, and evidence chain are proven; the official provider is fully evaluated with a complete capability matrix; the adapter mapping is normative and adapter-local; and every honest `UNAVAILABLE` remains `UNAVAILABLE`. Pushing a stronger verdict without credentials would be a fabrication.

**2. If you want controlled Graph API testing, explicitly authorize D1.** Provide in a private channel (not Git/PR):
- one **owned Business/Creator** Instagram handle (or a Meta-provided sandbox) with its FB Page linkage,
- consent to create/link a **Meta Developer App** and request **`instagram_basic`** (add `instagram_manage_comments` later only if comment testing is wanted),
- and approval to store the **short→long token exchange** via `IGTRACK_GRAPH_CLIENT_ID / SECRET / ACCESS_TOKEN` in your local `.env` / secret store (names only in `.env.example`). The next PR will implement `IGTRACK_PROVIDER=graph` against `provider-contract.md` §1e, fetch the minimal permitted pages, and prove the evidence chain on the controlled account.

**3. Do not block other value on D1/D2.** Your product remains **evidence-first** and **capability-honest**: every claim is typed OBSERVED/DERIVED/INFERRED/UNAVAILABLE, timestamped, confidence-rated, and evidence-linked, even while synthetic-only. The operational hardenings shipped this phase (credential safety + pool timeouts + health probe + login rate limit) make the self-host deployment safer the day you pick D2.

**IGTrack is not an Instagram data-acquisition system at any cost. It is an evidence-first observation system constrained by what the authorized source legitimately makes knowable. This phase honors that rule completely.**

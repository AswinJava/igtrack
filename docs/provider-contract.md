# IGTrack — Provider Contract & Capability Matrix

`InstagramProvider` (packages/core/src/provider.ts) is the single ingestion boundary.
Providers return `CapabilityResult` — never throw parsing/availability failures — and
IGTrack never fabricates observations to compensate for provider gaps.

## 1. Capability matrix

| Method | Input | Output | Statuses | Pagination | Raw representation | Notes |
|---|---|---|---|---|---|---|
| `capabilities()` | — | `Record<CapabilityName, boolean>` | — | — | — | Static capability declaration; executors gate on it |
| `resolveAccount(username)` | username | `NormalizedAccountRef` | AVAILABLE / ERROR(ACCOUNT_NOT_FOUND, …) | — | optional hash+ref | Establishes which account data belongs to |
| `getProfile(account)` | `NormalizedAccountRef` | `NormalizedProfile` (counts, bio, isPrivate/isVerified **optional**) | AVAILABLE / PARTIAL / UNAVAILABLE / ERROR | — | `rawPayloadHash?`, `rawReference?` | Absent fields stay UNKNOWN downstream |
| `getStories(account)` | ref | `NormalizedStory[]` | AVAILABLE (may be empty) / PARTIAL / UNAVAILABLE / ERROR | — (single tray snapshot) | per-result hash+ref | Empty+AVAILABLE is an honest zero; UNAVAILABLE never becomes zero |
| `getFollowers(account, cursor?)` | ref, `Cursor?` | `NormalizedFollowPage` (`entries`, `complete`, `nextCursor?`) | AVAILABLE / PARTIAL / UNAVAILABLE / ERROR | cursor-based | per-page hash+ref | `complete` must be honest; PARTIAL persists as PARTIAL forever |
| `getFollowing(account, cursor?)` | ref, `Cursor?` | `NormalizedFollowPage` | same as getFollowers | cursor-based | per-page hash+ref | same contract |
| `getPublicPosts(account, cursor?)` | ref, `Cursor?` | `NormalizedPost[]` | same | cursor-based | per-page hash+ref | PARKED (Phase 15) — not consumed by any scan executor; no persistence, evidence, query, or UI |
| `getPublicComments(post, cursor?)` | post, `Cursor?` | `NormalizedComment[]` | same | cursor-based | per-page hash+ref | PARKED (Phase 15) — not consumed by any scan executor; no persistence, evidence, query, or UI |

Every result carries: `status`, `observedAt` (provider-declared capture instant),
`source` (`sourceId`, `SourceKind`, optional `reference`), `confidence`
(HIGH/MEDIUM/LOW/UNKNOWN), `note?` (for PARTIAL/UNAVAILABLE), `error?`
(`kind`, `message`, `retryable`).

Error kinds: `SOURCE_NOT_FOUND | ACCOUNT_NOT_FOUND | ACCOUNT_PRIVATE | RATE_LIMITED |
SCHEMA_MISMATCH | NETWORK | AUTH_REQUIRED | FORBIDDEN | TIMEOUT | PROVIDER_ERROR |
INTERNAL | UNKNOWN`. `RATE_LIMITED` must map to a retryable ERROR or an UNAVAILABLE
with note — **never** to an empty result. `TIMEOUT` is produced by the worker's
execution boundary (PC-T1), never by the provider.

Source classification (STEP 11): `sourceKindFor` maps the source-id class prefix
explicitly — `fixture:` → FIXTURE, `import:` → IMPORT, `graph:` → GRAPH_API,
`user:` → USER_PROVIDED; an unrecognized class falls back to IMPORT rather than
silently impersonating a permitted integration. A future authorized-API provider
must use the `graph:` class (or register a new explicit class) — it can never be
mislabeled as IMPORT by default.

## 1a. Result semantics (STEP 2, A–J) — the normative answers

| Q | Semantics (per operation) |
|---|---|
| A. AVAILABLE | Data for this operation is present and usable. For pages: `entries` + `complete` flag; for stories: the observed tray snapshot; for profile: the snapshot. AVAILABLE never implies completeness on its own. |
| B. PARTIAL | Some data, incomplete coverage. Followers/following: `complete:false` on the final page (status may still be AVAILABLE); stories: status PARTIAL = incomplete tray window. Snapshots persist PARTIAL forever — never upgraded. |
| C. UNAVAILABLE | The capability cannot be served at all (no access / source down / capability off). Zero rows are written; source health records UNAVAILABLE; outcome `UNAVAILABLE`. UNAVAILABLE is never zero, never empty. |
| D. ERROR | The provider failed for a typed reason (`CapabilityErrorKind`). No observations are produced; source health records the failure category; the job fails or retries per taxonomy. |
| E. Empty successful result | An honest positive observation of absence: stories AVAILABLE+[] → `COMPLETED_EMPTY` (no "no stories" claims); followers/following AVAILABLE + `complete:true` + zero entries → empty COMPLETE snapshot + `COMPLETED_EMPTY` (Phase 8 fix). Empty ≠ unavailable. |
| F. Incomplete page | `complete:false` → the scan continues while a cursor exists; a final incomplete page persists a PARTIAL snapshot (never COMPLETE). |
| G. Provider timeout | Worker-enforced (PC-T1): the call is raced against `IGTRACK_PROVIDER_TIMEOUT_MS` (default 30s). Timeout → typed `TIMEOUT`, retryable, source-health category TIMEOUT, **no evidence**, **no partial completion**. The worker loop survives. |
| H. Malformed provider data | `SCHEMA_MISMATCH`, non-retryable by taxonomy. Parsed inside the capability model — a provider parse failure is a `CapabilityResult`, never a thrown crash. Raw upstream payloads are never echoed into error messages. |
| I. Retryable | `RATE_LIMITED`, `NETWORK`, `TIMEOUT`, `PROVIDER_ERROR`, `INTERNAL` — unless the provider explicitly sets `retryable:false`. Provider may downgrade a retryable kind to non-retryable, never the reverse (`effectiveRetryability`). |
| J. Permanently non-retryable | `SOURCE_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_PRIVATE`, `AUTH_REQUIRED`, `FORBIDDEN`, `SCHEMA_MISMATCH`, `UNKNOWN`. |

## 1b. Rate-limit contract (STEP 10)

A provider communicates throttling through `CapabilityError`:

- `kind: RATE_LIMITED`, `retryable: true`.
- `retryAfterMs` (optional): the provider-supplied delay (Retry-After / reset). The
  worker honors it **verbatim** as the retry's `available_at` — no exponential
  backoff is stacked on top. Absent → standard backoff (30s → cap 15min).
- Rate limiting must never surface as zero data or an empty list.

Scheduler interaction is unchanged: rate-limited jobs wait in `retry_wait`; the
scheduler only enqueues due scans by window and never hammers a throttled provider.

## 1c. Checkpoint staging (PC-T2, STEP 5)

Acquired follow-scan members are staged durably in `follow_scan_staging`
(append-only, one row per member, unique `(job_id, username_lower)`), and the
checkpoint holds cursor/page only. Properties: crash-safe resume, duplicate-page
idempotency, stale-lease reclaim safety, first-acquisition ordering, cleanup on
completion (and foreign-job cleanup at scan start), cascade with target deletion.
The old O(n²) JSONB rewrite is gone; measured results are in
`docs/phase-8-founder-report.md` §21.

## 1d. Security boundary (STEP 13, PC-S1)

Provider credentials live exclusively in provider configuration (env, future secret
store). They must NEVER appear in: evidence rows, observation payloads, job metadata,
logs, diagnostics, or client responses. Evidence carries only hashes, references,
usernames, and timestamps. Raw upstream payloads are never persisted or logged.

## 1e. Adapter contract mapping — Graph API (T2, evaluation-ready, not yet integrated)

This section is the **normative method-by-method mapping** required by §5 of the
Phase 10 master prompt. No adapter code is shipped this phase (founder D1
authorization is still pending) — the mapping is the contract that a future
`graph:ig:<version>` adapter must satisfy before a single live call is merged.
Every field below is adapter-local; `packages/core` gains no
provider-specific type unless the contract itself genuinely requires an extension.

| Method | Input | Authorization | Provider request (Graph API) | Provider response (shape) | Zod schema | Normalization | Timestamp semantics | Completeness | Capability status | Confidence | Raw representation | Raw hash | Retryability | Error taxonomy | Rate-limit handling |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `resolveAccount(username)` | `username` (trim, lower, max 40, `^[a-z0-9._]+$`) | Owned IG Business/Creator account + FB Page linkage + Meta app + App Review; long-lived user token (`instagram_basic`). | Owned account: `GET /{ig-user-id}?fields=id,username,name` (self). Arbitrary Business/Creator: `GET /{caller-ig-id}?fields=business_discovery.username({username}){id,username}` (PARTIAL). Personal accounts: no endpoint. | `{id, username, name?}` on self; `business_discovery{ id, username }` on discovered; absent → no object / `(#100) Tried accessing nonexisting field`. | `z.object({ id: z.string(), username: z.string() })` plus optional `name`; business_discovery envelope validated as `z.object({ business_discovery: z.object({...}).nullable() })`. Parse failure → `SCHEMA_MISMATCH`. | `NormalizedAccountRef { username, igId: id, displayName: name?, isPrivate? absent → UNKNOWN, isVerified? absent → UNKNOWN }`. Never defaults absence to false. | `observedAt` = authoritative Graph API `captured` time if returned, else adapter's `new Date().toISOString()` at parse (never invent past time). Stored as ISO string; `capturedAt` is ingestion capture instant. | Single ref — completeness n/a; absent username is `ERROR ACCOUNT_NOT_FOUND`, not UNAVAILABLE, not empty. | AVAILABLE on self or discovered business account; ERROR ACCOUNT_NOT_FOUND for unknown/personal; ERROR FORBIDDEN if scopes missing; ERROR AUTH_REQUIRED if token expired. | HIGH on self, MEDIUM on business_discovery (limited fields), UNKNOWN on error. | HTTP JSON body hash (sha256 of raw response bytes) + `rawReference: "graph:ig:v23/{endpoint}?fields=…"` (no token/query secret). Transported as `rawPayloadHash` + `rawReference` when present; absent → `undefined` → DB `NULL`. | Genuine HTTP body hash derived in adapter *before* normalization; never `sha256(normalizedPayload)`. | Network/timeout/5xx/429 → retryable per taxonomy; ACCOUNT_NOT_FOUND/FORBIDDEN/AUTH_REQUIRED/SCHEMA_MISMATCH → non-retryable via `effectiveRetryability`. | Maps to `CapabilityErrorKind`: 190/102 AUTH_REQUIRED, 10/200 FORBIDDEN, 4/32/80004 RATE_LIMITED, 1/2 PROVIDER_ERROR, JSON parse SCHEMA_MISMATCH, 803 ACCOUNT_NOT_FOUND. `retryAfterMs` from `Retry-After` or `X-Business-Use-Case-Usage reset_time_duration *1000`. | 429 / BUC header `acc_id_util_pct≥100` → `RATE_LIMITED` with `retryAfterMs` verbatim as job `available_at`; never coalesced with exponential backoff; never surfaced as `[]` or `0`. |
| `getProfile(account)` | `NormalizedAccountRef` (from resolve) | Same as resolveAccount. | `GET /{ig-user-id}?fields=id,username,biography,website,followers_count,follows_count,media_count,profile_picture_url` (owned). Discovered fallback: `business_discovery.username({u}){followers_count,follows_count,media_count,biography,website,username,id}`. | `{ followers_count, follows_count, media_count, biography, website, profile_picture_url }`. Private flag not exposed as boolean on Graph API — absence must stay UNKNOWN. | Zod `rawProfileGraphV1` (pending): `id`+`username` required, `followers_count` etc nullable optional. Extra fields stripped (forward-compatible). | `NormalizedProfile { username, displayName?, bio?, externalUrl?, followerCount?, followingCount?, postCount?, isPrivate?: UNKNOWN, isVerified?: UNKNOWN, profilePicUrl? }`. Counts mapped 1:1; nullish fields omitted, not zeroed. | Same `observedAt` semantics as resolve. | N/A single snapshot; counts are point-in-time, not complete/incomplete. | AVAILABLE when fields return; PARTIAL when only business_discovery subset available (note carries "PARTIAL: business_discovery limited fields"); UNAVAILABLE never used for this method under Graph API (would be FORBIDDEN if scopes missing); ERROR on auth/parse. | HIGH owned, MEDIUM discovered, LOW on degraded payload. | Same raw hash/reference as above, per profile fetch. | Same. | Same taxonomy. | Same. |
| `getFollowers(account, cursor?)` | `ref`, `Cursor?` (`after` cursor string) | n/a — **no sanctioned follower-list endpoint exists**. | None (endpoint does not exist). | None. | None — method must not attempt a request. | No follow-page produced. | `observedAt` = call time for the UNAVAILABLE result. | UNAVAILABLE — must report PARTIAL/UNAVAILABLE honestly, never an empty list. | **UNAVAILABLE** with note `"Instagram Graph API does not expose a follower list for any account; only follower_count via profile. See docs/phase-10-provider-evaluation.md §3.6."` — `confidence UNKNOWN`, `data` absent. | UNKNOWN | No raw payload; `rawPayloadHash` absent (`NULL`). | `NULL` | Not retryable — capability gap, not a transient. | Maps to status `UNAVAILABLE`, not `ERROR`; source_health `UNAVAILABLE` with coverage note, never HEALTHY/DEGRADED. | Not applicable — no throttling because no calls are issued. |
| `getFollowing(account, cursor?)` | same | same — no sanctioned following-list endpoint | None. | None. | None. | Same. | Same. | Same. | **UNAVAILABLE** — same note as followers, direction `following`. | UNKNOWN | None / NULL | NULL | Not retryable — capability gap. | Same UNAVAILABLE. | Same. |
| `getStories(account)` | `ref` | Owned account with `instagram_basic` (story read scoped). Arbitrary accounts not supported for bulk story read. | Owned live stories (where scoped): `GET /{ig-user-id}/stories` or `/{ig-user-id}/media?fields=media_type,timestamp,…&limit=` where `media_type` includes story containers — **scope/format-dependent; not guaranteed**. | Array of story media objects (where exposed) with `id, media_type, timestamp, caption?, media_url?`. | Zod `rawStoriesGraphV1`: array of `{ id, media_type: enum, timestamp: iso, media_url? }`; empty array valid. | `NormalizedStory[]` via `normalizeStory` (canvas absent for Graph API). `expires_at` derived as `timestamp+24h` for live stories where API gives no expiry. | `observedAt` = per-call `timestamp` basis, never fabricated future. | Single tray snapshot; empty AVAILABLE means honest zero → `COMPLETED_EMPTY` (stored). `PARTIAL` if API documents truncated window; finality never invented. | AVAILABLE (+`[]` honest empty) when endpoint is available and returns; PARTIAL when truncated/window-limited; UNAVAILABLE when endpoint not exposed for this token scope; ERROR AUTH/parse otherwise. | HIGH when full tray, MEDIUM when truncated. | Per-call body hash + `"graph:ig:v23/{ig-user-id}/stories?...` reference. Absent → NULL. | Genuine body hash. | Retryable on network/429/5xx/timeout; non-retryable on AUTH/FORBIDDEN/SCHEMA. | Same header-derived `retryAfterMs` on 429. |
| `getPublicPosts(account, cursor?)` | `ref`, `Cursor?` (`after`) | Owned Business/Creator + token. | `GET /{ig-user-id}/media?fields=id,caption,media_type,media_url,permalink,timestamp,children{media_type,media_url}&limit=50&after={cursor}`. Cursor-based. | `{ data: Post[], paging: { cursors:{after}, next? } }`. | `z.object({ data: z.array(graphPost), paging: z.object({ cursors: z.object({after:z.string()}).optional(), next: z.string().optional() }).optional() })`. | `NormalizedPost[]` via `normalizePosts` (caption/media_type/permalink/timestamp). | Same. | Cursor page: `complete = paging.next == null`; final incomplete page persists PARTIAL. | AVAILABLE per page; PARTIAL when API truncates; UNAVAILABLE if caller lacks media scope; ERROR otherwise. | HIGH on last page, MEDIUM otherwise. | Per-page body hash + reference with cursor. | Body hash. | Retryable on 429/5xx/network/timeout. | Same. |
| `getPublicComments(post, cursor?)` | `NormalizedPost`, `Cursor?` | Owned media + token. | `GET /{media-id}/comments?fields=id,text,timestamp,username,like_count&limit=50&after={cursor}`. | `{ data: Comment[], paging:{ cursors, next } }`. Top/filtered views may hide items. | Comment Zod with `id,text,timestamp`. Missing text → SCHEMA_MISMATCH, not silent skip. | `NormalizedComment[]` via `normalizeComments`. | Same. | Same cursor `complete` semantics. | AVAILABLE per page; PARTIAL when filtered view hides items (note); ERROR on auth/parse. | HIGH last page, MEDIUM otherwise. | Per-page body hash. | Body hash. | Same. | Same. |

**Invariants the adapter must enforce** (adapter-local, not in `core`):
- Missing `is_private`/`is_verified`/nullable fields → `undefined` → DB `NULL` → UNKNOWN (never `?? false`).
- Missing timestamps → adapter time, never invented past time.
- `UNAVAILABLE` never produces `data` (no `[]`/`0`/`false`) and records `UNAVAILABLE` in source_health.
- `PARTIAL` never upgraded to `COMPLETE`; follow snapshots store `completeness` honestly.
- `rawPayloadHash` never derived from normalized data; absent raw → `NULL`.
- Raw payload bytes and tokens never persisted, logged, or returned to the browser; evidence carries only hashes/references/usernames/timestamps.
- Retryability governed by `effectiveRetryability` + `retryAfterMs` verbatim; rate-limits honored, not bypassed.

## 1f. Parked capabilities (Phase 15)

`getPublicPosts` / `getPublicComments` exist on the `InstagramProvider`
interface and on the fixture provider, but nothing else in the system consumes
them: there is no interaction scan job type, no posts/comments persistence
model, no evidence path, no query, and no UI. They are retained only so a
future lawful adapter has a typed slot to implement against.

Deliberate decision (Option A — park, do not half-build): until persistence,
executor, evidence, query, UI, and tests all exist for the complete synthetic
pipeline, product copy and docs must not imply that comments are currently
monitored. A provider method that looks supported while the pipeline silently
does nothing is worse than an explicitly parked one.

## 2. Requirements for any real provider (gate before integration)

| ID | Category | Requirement |
|---|---|---|
| PC-1 | IDENTITY | Provider proves which account each datum belongs to (account identity resolution is not guessed by IGTrack) |
| PC-2 | OBSERVATION TIME | Every result declares a truthful `observedAt`; absent time is not invented |
| PC-3 | RAW EVIDENCE | Provider transports `rawPayloadHash` (+ `rawReference`) or explicitly provides none; IGTrack stores NULL honestly |
| PC-4 | COMPLETENESS | `complete`/PARTIAL semantics are exact; partial lists can never be persisted as COMPLETE |
| PC-5 | CAPABILITY | All four statuses supported per method; UNAVAILABLE is a first-class answer |
| PC-6 | AUTHORIZATION | Provider documents the lawful authorization basis per account (user-owned/authorized vs public) — arbitrary-account claims require evidence, not assertions |
| PC-7 | RATE LIMIT | Throttling surfaces as RATE_LIMITED/UNAVAILABLE, never as zero data |
| PC-8 | DATA SCOPE | Provider documents exactly what is observable and what is not |
| PC-T1 | TIME BOUND | Every provider call must complete within a worker-enforced timeout (no unbounded hangs — currently missing, required before real providers) |
| PC-T2 | PAGE BOUND | Page sizes are bounded such that a full scan's checkpoint stays within the staging-table migration (see phase-7-failure-matrix §D) — large-member scans require the staging-table path first |
| PC-T3 | ERROR TAXONOMY | Failures map into the existing `CapabilityErrorKind` set; no new silent categories |
| PC-T4 | PROVIDER VERSION | `sourceId` encodes `name:version`; schema version recorded with evidence |

## 3. Lawful integration boundary

- **User-owned / authorized data** (Meta Graph API, Instagram Graph API for owned or
  granted business/creator accounts): permissible self-monitoring mode. T2 source tier.
- **Public arbitrary-account data**: Instagram does not offer a permitted API for
  third-party public-account monitoring. IGTrack must not promise it. Any provider
  claiming it requires explicit legal review (T3) and must not rely on ToS-violating
  collection.
- **User imports** (T1): data the user lawfully holds; responsibility documented.
- Never: credential harvesting, session/cookie theft, auth/CAPTCHA/challenge bypass,
  private-account access, evasion infrastructure. Capabilities requiring any of these
  are declared UNAVAILABLE and documented in `docs/platform-limitations.md`.

FixtureProvider remains the canonical development/test provider (T0).

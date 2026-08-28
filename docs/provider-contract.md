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
| `getPublicPosts(account, cursor?)` | ref, `Cursor?` | `NormalizedPost[]` | same | cursor-based | per-page hash+ref | Not yet consumed by a scan executor |
| `getPublicComments(post, cursor?)` | post, `Cursor?` | `NormalizedComment[]` | same | cursor-based | per-page hash+ref | Not yet consumed by a scan executor |

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

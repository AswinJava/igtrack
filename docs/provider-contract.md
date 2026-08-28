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
SCHEMA_MISMATCH | NETWORK | AUTH_REQUIRED | INTERNAL`. `RATE_LIMITED` must map to a
retryable ERROR or an UNAVAILABLE with note — **never** to an empty result.

`sourceKindFor` classifies sources: non-fixture providers currently map to IMPORT
(known Phase 7 limitation — a real provider requires a proper SourceKind mapping).

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

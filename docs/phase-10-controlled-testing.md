# Phase 10 — Controlled Testing

Date: 2026-09-01 · Baseline: `d55b00d` + Phase 10 hardening · Auditor: Founder / Architect / Security & Evidence Auditor
Scope: §9 (real-provider test target) and §10 (controlled testing) of the master prompt — executed only as far as authorization permits.

## 1. Authorization basis

No real-provider credentials exist for this workspace.

| Item | Status |
|---|---|
| Meta Developer App (Business/Creator) | **Not created** — founder has not authorized app registration (D1 deferred, `docs/phase-10-provider-evaluation.md` §1) |
| Instagram Business/Creator account willing to authorize | **Not supplied** — no account is designated as the controlled test account |
| Long-lived Graph API token (`instagram_basic` etc) | **Not obtained** — creation is prohibited without explicit authorization (§4) |
| App Review approval for requested scopes | **Not submitted** — requires the app + account above |
| Token storage plan | Documented only: env/secret-store, never Git/DB/logs/browser; `.env.example` names without values |

**Consequence:** §10 A–G (authentication → limitation) **cannot be exercised against a live provider** in this phase. Manufacturing credentials or using an arbitrary third-party account would violate the lawful boundary (ToS `§3` + `docs/platform-limitations.md` §3) and the "observation vs availability" principle. IGTrack therefore reports the honest outcome below.

## 2. Controlled test account (§9)

| Field | Value |
|---|---|
| Designation | **No controlled test account is designated this phase** |
| Required identity | Account owned by the founder, or an account where explicit written authorization exists, or a Meta sandbox/test account provided with the authorized provider |
| Required authorization record | Account identifier + authorization basis + scopes + time-limited consent + revocation path |
| Data minimization limit for testing | Fetch the smallest possible permitted page for each capability under test; store only what the current product scope requires (no media archive, no hidden raw-payload archive, no credential material) |
| What IGTrack would record for a future controlled run | `CONTROLLED TEST ACCOUNT — <@username, igId, sourceId, authorization basis, scopes, date>` stored only as job metadata where needed, never as embedded raw payload |

**No account is stored this phase.** Creating a test account entry without authorization would be a surveillance mechanic, which is a hard-rule violation. The next phase may populate this section only after D1 authorization supplies a real, owned account.

## 3. Controlled testing execution (§10) — result: NOT YET AVAILABLE

The master prompt's smallest-possible-test order is:

| Test | Objective | Expected result | Actual (this phase) | Verdict |
|---|---|---|---|---|
| **A — Authentication** | Verify provider authentication | HTTP 200 with valid token; typed `AUTH_REQUIRED`/`FORBIDDEN` with invalid token — never a fabricated observation | **Not executed** — no token exists to exercise; provider loader `providerFromEnv()` correctly fails fast with a *configuration* error for unknown provider (`IGTRACK_PROVIDER=graph`), not a fake UNAVAILABLE | **NOT YET AVAILABLE (correct)** |
| **B — Profile** | Fetch profile → verify identity, timestamps, privacy/verification, provenance | `NormalizedProfile` with honest `observedAt`, `isPrivate`/`isVerified` UNKNOWN when absent, genuine `rawPayloadHash` or NULL, `COMPLETE`/`PARTIAL` exact | **Not executed live** — synthetic coverage remains the reference: `conformance.test.ts` C2 proves provenance shape + genuine raw hash for `FixtureProvider`; new hardening keeps UNKNOWN honest | **NOT YET AVAILABLE (correct)** |
| **C — Followers** | Fetch smallest permitted page → verify pagination, completeness, normalized identities, evidence, raw hash | Cursor page with `entries`, `complete`, `nextCursor?`; staged durably; evidence per page; no fabricated list | **Not executed live — correctly UNAVAILABLE for Graph API.** `docs/provider-contract.md` §1e declares `getFollowers` **UNAVAILABLE** under the Graph API (no sanctioned endpoint); `FixtureProvider` pagination is preserved as the reference implementation (C4) | **NOT YET AVAILABLE / UNAVAILABLE (correct)** |
| **D — Following** | Same as C, direction `FOLLOWING` | Same | **Same as C — UNAVAILABLE for Graph API; FixtureProvider reference proven** | **NOT YET AVAILABLE / UNAVAILABLE (correct)** |
| **E — Stories** | Only if officially available + authorized: story identity, observed_at, expiry (24h), mentions, partial semantics | Tray snapshot, `PARTIAL` vs `AVAILABLE+[]` distinction, mention evidence with `MentionVisibilityClass` + confidence | **Not executed live** — Graph API story read is PARTIAL/scope-dependent; fixture story pipeline (3 synthetic stories via `story-scan.test.ts`) remains the reference | **NOT YET AVAILABLE (correct)** |
| **F — Repeat observation** | Same scan again → no duplicate observation/evidence/deltas | Deduplication by natural keys + evidence reuse | **Not executed live** — proven synthetically by `follows.test.ts` + staging idempotency + scheduler window idempotency + `worker-integration` repeat-scan cases | **NOT YET AVAILABLE (correct, synthetic coverage PASS)** |
| **G — Provider limitation** | Force an unavailable capability → `UNAVAILABLE` not `[]`/`0`/`false`/`COMPLETE` | Outcome `UNAVAILABLE`, source_health `UNAVAILABLE` with coverage note, UI honest | **Not executed live** — proven synthetically: `worker-boundary` UNAVAILABLE scan → outcome `UNAVAILABLE`; `source-health` UNAVAILABLE distinct-from-empty; Graph API follower/following mapping in provider-contract §1e already makes the limitation visible in `source_health` when exercised | **NOT YET AVAILABLE (correct, synthetic coverage PASS)** |

**No live provider observation was produced this phase.** That is the compliant outcome when authorization is absent — IGTrack must never manufacture a stronger verdict.

## 4. Failure injection (§11) — controlled-testing side

§11 requires that failures beyond the happy-path be exercised. The **synthetic failure injection** is complete (see `docs/phase-10-failure-matrix.md`); the **live-provider** injection that would require a credential (timeout during a real Graph call, real 429, real revoked token against Graph, expired token) is **NOT YET AVAILABLE** for the same authorization reason. The failure taxonomy and retryability contract are the same (`RATE_LIMITED`/`TIMEOUT`/`PROVIDER_ERROR` retryable; `FORBIDDEN`/`AUTH_REQUIRED` non-retryable), and the worker honoring `retryAfterMs` verbatim is proven by the executor and harness without needing a live throttled endpoint.

## 5. Evidence verification (§12) and data minimization (§13) for controlled testing

For every future real-provider observation the chain is already specified and proven on fixtures:

```
claim → observation → evidence (source, observedAt, capturedAt, rawHash, normalizedHash, providerVersion, schemaVersion)
       → derived state (profile_changes, follow_deltas, timeline_events) — only where observed
       → source_health (HEALTHY/DEGRADED/UNAVAILABLE per capability)
       → relationship scores = INFERRED with signal breakdown, never FACT
```

- `raw_hash` must be **genuine provider-transmitted raw hash or NULL** — enforced in `docs/provider-contract.md` §1e (`sha256(HTTP body)` before normalization, never `sha256(normalized)`), proven in `conformance.test.ts` `expectRawHashHonest` and `persistence.test.ts`. Controlled testing would verify the same field on each Graph response page.
- Data minimization: future controlled testing will fetch **only** what the current product scope needs (profile + a minimal followers/following pageCursor? but followers/following are UNAVAILABLE for Graph API — so only profile/posts/comments where authorized; story polling only if scope granted). No media archive, no hidden raw-payload store, no credential material in evidence/DB/logs. Deletion obeys `deleteTargetWithObservations` (cascade) + `ig_accounts` shared-registry semantics.

## 6. UI controlled-testing mode (§14) and source health (§15)

If live data ever becomes available, the UI must indicate the source:

- Banner label: **`AUTHORIZED PROVIDER`** (or `REAL / AUTHORIZED PROVIDER`) vs `SYNTHETIC (FixtureProvider)` — never called `LIVE INSTAGRAM` unless the exact `graph:` provider state is established.
- Unavailable capabilities stay visibly unavailable (same UI component that today renders source_health `UNAVAILABLE`); inferred scores stay labelled `INFERRED`.

Source health transitions are defined as:

```
HEALTHY → (any failure: NETWORK/TIMEOUT/PROVIDER_ERROR/RATE_LIMITED/FORBIDDEN/AUTH_REQUIRED) → DEGRADED → (success) → HEALTHY
HEALTHY → (revoked/expired) → DEGRADED with errorCategory FORBIDDEN/AUTH_REQUIRED → (re-auth success) → HEALTHY
capability gap → UNAVAILABLE (distinct state, never HEALTHY/DEGRADED)
```

The revocation arc is newly covered by the hermetic+PG test `PH10-R1` in `packages/database/test/source-health.test.ts`; the rest is proven across `source-health.test.ts` baseline, `worker-boundary`, and the staging suites.

## 7. Verdict

**CONTROLLED REAL-PROVIDER TESTING — NOT YET AVAILABLE (successful evaluation outcome).**

IGTrack is honest: it performed the smallest compliant controlled-testing preparation that authorization permits (contract mapping, hardening, failure taxonomy, evidence/data-minimization specification) and stopped precisely where live credentials would be required. That is the outcome §24 defines as **success** when no real credentials exist. The next controlled-testing execution will follow the authorization plan in `docs/phase-10-provider-evaluation.md` §3, against the designated owned account from §2, fetching the minimal permitted pages described in §3.

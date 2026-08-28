# Phase 9 — Provider Evaluation

## 1. Selection criteria (STEP 5)

Candidates ranked on: Legality, Authorization model, Capability coverage, Data
provenance, API stability, Rate-limit semantics, Pagination, Timestamp quality,
Privacy semantics, Cost, Operational complexity, Terms compatibility.

## 2. Candidate assessment

| Candidate | Legal basis | Authorization model | Coverage | Runtime integration | Verdict |
|---|---|---|---|---|---|
| **Meta Graph API / Instagram Graph API** | ToS-permitted; Meta contract | Account owner grants a token (business/creator) | self-owned profile/posts/stories (authorized accounts only); **no arbitrary-account data**; follower graphs require additional scopes and are historically partial/unsupported for pure-IG accounts | real network calls, OAuth, token lifecycle, app review | **NOT INTEGRATABLE THIS PHASE**: cannot exercise live without a Meta app + authorized token + app review, which are founder/legal prerequisites, not code |
| **User-import (owner export)** | User-owned data | User provides their own export | profile/posts/stories/follows the owner legitimately holds | no network; file ingest | **DESIGNED, NOT IMPLEMENTED** (import mode is a T1 roadmap item — not a lawful-provider integration) |
| **FixtureProvider (T0)** | synthetic, development/test only | none | full contract coverage, canonical | in-repo | **selected as the only integrable lawful provider this phase** |
| Web scrape / reverse-engineered private API | **UNLAWFUL / ToS-violating** | n/a | n/a | n/a | **REJECTED — hard boundary** |

## 3. Selected provider: FixtureProvider (canonical development/test provider)

- **Type**: synthetic fixture (T0), ship-included.
- **Authorization model**: none — contains no real user data; explicitly labeled
  `synthetic` in evidence metadata.
- **Why**: it is the only provider that can be lawfully integrated and exercised
  **now** against the real contract; it is the reference implementation for the
  conformance suite and the contract's regression baseline.
- **Legal boundary**: importing user-owned data and, later, an authorized Graph API
  integration are the *evaluation-ready* candidates — each requires a founder/legal
  decision before a real provider is wired in.

## 4. Capability matrix (STEP 6) — explicit classification

| Capability | FixtureProvider (T0) | Graph API (future) | Import (future) |
|---|---|---|---|
| Profile (public) | AVAILABLE | AVAILABLE (authorized accounts only) | AVAILABLE (user-held) |
| Followers | AVAILABLE (synthetic) | PARTIAL/UNKNOWN (scope-dependent, IG accounts) | AVAILABLE (exported data) |
| Following | AVAILABLE (synthetic) | PARTIAL/UNKNOWN | AVAILABLE |
| Stories | AVAILABLE (synthetic ephemeral) | PARTIAL (format-dependent) | AVAILABLE |
| Mentions (story) | AVAILABLE (synthetic) | PARTIAL/UNKNOWN | AVAILABLE |
| Pagination | AVAILABLE (cursor) | PARTIAL/UNKNOWN | AVAILABLE |
| Historical likes | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE (unless exported) |
| DMs / private anything | UNAVAILABLE | UNAVAILABLE by policy | UNAVAILABLE |
| Private-account access | UNAVAILABLE | AUTHORIZED-ONLY | USER-AUTHORIZED-ONLY |
| Raw representation | AVAILABLE (fixture files, genuine hash) | PARTIAL (response bodies, if retained) | AVAILABLE (imported files) |

**Rules enforced**: UNAVAILABLE never becomes `[]`, `0`, `false`, or `COMPLETE`.
Zero data from an unavailable capability is never persisted as absence.

## 5. STEP 4 contract matrix (every capability, explicit answer)

See `docs/provider-contract.md` §1a (A–J) for normative semantics. This matrix maps
each contract item to actual provider support and evidence:

| Capability | Contract (§1a) | FixtureProvider support | Conformance evidence |
|---|---|---|---|
| profile | AVAILABLE/PARTIAL/UNAVAILABLE/ERROR + provenance | AVAILABLE for fixture account; ERROR `ACCOUNT_NOT_FOUND` for unknown | C2 test (ingestion conformance) |
| followers | paginated pages, `complete` honest | AVAILABLE cursor-paginated (2 pages) | C4 test |
| following | same | AVAILABLE cursor-paginated | C4 test |
| stories | AVAILABLE+[] = honest empty / PARTIAL / UNAVAILABLE | AVAILABLE (3 synthetic stories); empty supported | C2/ST suite |
| mentions | derived per story, classification taxonomy | AVAILABLE (synthetic mentions) | ST7 |
| pagination | cursor semantics, complete/partial | AVAILABLE, stable cursor → next page | C4 |
| source identity | `sourceId` + SourceKind registry | `fixture:v1` → FIXTURE | source-kind tests |
| timestamps | observedAt/capturedAt distinction | fixture `captured_at` → observedAt; capturedAt = capture time | ST/evidence tests |
| raw representation | rawPayloadHash genuine or absent | fixture raw file bytes hashed | C2/C4 raw-hash checks |
| confidence | HIGH/MEDIUM/LOW/UNKNOWN | synthetic per fixture | evidence tests |
| completeness | COMPLETE/PARTIAL preserved | fixture `complete` flag | F2/T2-3 |
| privacy/verification | UNKNOWN (nullable) preserved | avatar fixture omits → UNKNOWN | privacy tests |
| unavailable | UNAVAILABLE → no rows, outcome UNAVAILABLE | capability-off paths | C3/F3/ST3 |
| timeout | TIMEOUT, retryable, no evidence | worker boundary (provider-agnostic) | PC-T1 suite |
| rate limit | RATE_LIMITED + retryAfterMs | error model supports; fixture has no 429 (synthetic) | RL-1 |
| forbidden | FORBIDDEN non-retryable | error model supports | taxonomy test |
| malformed response | SCHEMA_MISMATCH non-retryable | fixture parser returns CapabilityResult | C5 |
| provider error | typed kind | model supports all kinds | taxonomy test |

**Every contract item has an explicit answer.** No item is UNAVAILABLE-without-evidence
or UNKNOWN-without-reason.

## 6. Conclusion

FixtureProvider is the only candidate that can be lawfully integrated and exercised
now. Any real provider (Graph API / import) is **evaluation-ready but NOT integrated**
— wiring one in requires a founder decision plus, for Graph API, a Meta app review
and token lifecycle. This phase therefore **hardens and proves the contract via the
fixture provider and the conformance/failure-injection suites** rather than
fabricating a "real" integration.
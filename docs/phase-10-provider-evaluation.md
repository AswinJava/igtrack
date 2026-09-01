# Phase 10 — Provider Evaluation (Authorized Provider Evaluation Complete)

Date: 2026-09-01 · Auditor: Founder / Principal Architect / Security & Evidence Auditor
Baseline: `d55b00d` (Phase 9, `docs/phase-10-baseline-audit.md` verified)
Scope: move IGTrack from **Provider-Integration-Ready** to **Authorized Provider Evaluation Complete**, and only if every gate passes, to **Controlled Real-Provider Testing Ready**. No live credentials were created, requested, stored, or used for this phase.

---

## 1. Founder decision gate (§2) — disposition of the four Phase 9 decisions

| # | Decision | Options | Recommendation | Consequence of each option |
|---|---|---|---|---|
| **D1** | **Meta/platform authorization** — authorize creation of a Meta Developer App, Business/Creator account linkage, and App Review for the Instagram Graph API (self-monitoring mode). | A. Authorize now (founder supplies a Business/Creator account willing to grant `instagram_basic` etc; eng builds Graph API adapter behind `IGTRACK_PROVIDER=graph`). B. Defer. | **A — but only after the founder explicitly supplies the authorizing account.** This is the *only* gating decision for controlled testing. | **A authorized:** unblocks adapter implementation + controlled testing (§9–§11). **B deferred:** provider evaluation completes honestly but controlled real-provider testing remains `NOT YET AVAILABLE` — the correct Phase 10 outcome, no workaround permitted. |
| **D2** | **Deployment platform** — choose target (self-host single VM, container platform, managed Postgres, etc) to unlock Dockerfiles, backup cron, health probing. | A. Pick now. B. Defer. | **B Defer.** | **A:** enables backup deployment + `/healthz` external probing but is not required to evaluate or test a provider locally. **B (chosen):** deployment stays documented-not-deployed (`docs/deployment.md` §4a) — no correctness impact on provider evaluation. |
| **D3** | **Login rate-limit approach** — approve strategy before any public exposure. | A. In-memory sliding window (simple, single-instance, no extra infra). B. Postgres-backed or Redis-backed distributed limiter. C. Defer. | **A in-memory for MVP** (implemented this phase, §16), defer B until multi-instance. | **A:** blocks brute-force on `/api/auth/login` today, zero infra cost. **B:** over-engineered before scale. **C:** leaves a P2 open before public exposure. |
| **D4** | **Backup / RPO policy** — confirm the 24h RPO / 14-day daily `pg_dump` policy from Phase 9. | A. Confirm 24h/14d. B. Tighten (hourly). C. Defer deployment. | **A confirm 24h/14d, deployment still deferred** (policy already documented in `docs/deployment.md` §4a + `phase-9-forensic-audit.md` §3B). | **A (chosen):** policy is the gate; deployment awaits D2. **B:** justified only if story observation becomes a durability guarantee (not today). |

**Classification (required by §2):**

- **FOUNDATION REQUIRED FOR PROVIDER TESTING:** D1 only.
- **POSTPONABLE OPERATIONAL HARDENING:** D2, D3, D4.

No founder decision was silenced. D1 remains **deferred pending explicit founder authorization** — that is why this phase correctly concludes *Evaluation Complete, Testing Not Yet Available* (§24).

---

## 2. Provider strategy (§3) — priority order and selection principles

IGTrack evaluates providers strictly in the lawful priority order:

| Tier | Provider | Authorization basis | Status this phase |
|---|---|---|---|
| **T0** | **FixtureProvider** (`fixture:v1`, `SourceKind.FIXTURE`) | Synthetic, zero real data, no credentials; ships in-repo under `packages/ingestion/fixtures/v1/` | **SELECTED — only integrable provider now**; canonical conformance reference and CI/dev backbone |
| **T1** | **User data import** (`import:` class, `SourceKind.IMPORT`) | User supplies data they lawfully hold (own exports, authorized access) | **EVALUATION-READY, NOT IMPLEMENTED** — roadmap T1, requires founder data-handling decision (retention, deletion, provenance of user-held archives). No import adapter is shipped this phase. |
| **T2** | **Meta Graph API — Instagram Graph API for owned/authorized Business/Creator accounts** (`graph:` class, `SourceKind.GRAPH_API`) | Account owner grants an OAuth token to a Meta app the founder controls; lawful self-monitoring mode only | **EVALUATION-READY, NOT INTEGRATED** — app registration + App Review + token lifecycle are founder prerequisites (D1). No adapter is shipped until D1 is explicitly authorized. |
| **T3** | Any other lawful, explicitly authorized integration | Requires explicit legal review + new source class registration | **REJECTED THIS PHASE** — no candidate meets the lawful review bar. |

**Selection rule enforced:** a provider is never elevated merely because it exposes more data. The lawful provider that can be exercised today (FixtureProvider) remains canonical; a richer-looking unlawful source (scrape, private API, proxy bypass, credential extraction, rate-limit evasion) is rejected at the legal boundary and marked `UNAVAILABLE` — documented, not engineered around (`docs/platform-limitations.md` §3).

Every candidate was scored on the ten Phase 10 criteria:

| Criterion | Gate |
|---|---|
| legal authorization | must be Meta-ToS-permitted with documented OAuth scopes |
| documented API behavior | pinned Graph API version with changelog |
| acceptable terms | Meta Platform Terms + Instagram Terms, no scrape ToS violation |
| stable identity | `igId` + username identity resolution owned by the provider, not guessed |
| timestamps | truthful `observedAt` per result, never invented |
| pagination | cursor-based, bounded pages |
| capability semantics | AVAILABLE / PARTIAL / UNAVAILABLE / ERROR per method (provider-contract §1a A–J) |
| rate-limit semantics | typed `RATE_LIMITED` with `retryAfterMs` → worker honors verbatim |
| provenance | source id + version + raw hash/reference + confidence |
| raw-hash semantics | genuine provider-transmitted raw hash or `NULL`, never `sha256(normalized)` |
| privacy semantics | `is_private` / `is_verified` nullable UNKNOWN preserved, never defaulted to `false` |

Only T0 satisfies all ten today without a founder prerequisite. T1/T2 satisfy them *in principle* but require D1 or a data-handling decision before they are exercisable — they are therefore recorded as *evaluation-ready* with honest capability limits below.

---

## 3. Meta / Official API evaluation (§4) — no credentials created, no secrets stored

Evaluation performed against the **current public official documentation** (Meta for Developers — Instagram Platform / Instagram Graph API) and the community-maintained 2026 guides that track the same endpoints. No Meta app was registered, no token was obtained, no secret was handled, and no request was issued in this phase (per §4 prohibition). The findings below are the documentation truth at 2026-09-01 and carry implementation consequences for the adapter gate (§5).

### 3.1 Application registration requirements

- **Prerequisites:** an Instagram **Business or Creator** account (personal accounts are ineligible), a **Facebook Page** connected to that Instagram account, and a **Facebook account** linked to both. This triple linkage is mandatory — the Graph API is built on the Facebook Graph API.
- **Meta Developer App:** create an app at `developers.facebook.com` (Business type), enable the **Instagram Graph API** product, configure OAuth redirect URIs, and declare the scopes the app will request.
- **Versions:** the API is versioned (`v23.0+` observed in guides; default pin is required). Pinning is explicit; automatic upgrades are never assumed. Breaking changes between versions narrow permission scope — capability re-check is required after any upgrade.

### 3.2 App Review requirements

- All permissions beyond the most basic read are **gated by Meta App Review** before they work for accounts beyond testers/admins. In **Development Mode** the app can only interact with accounts explicitly added as testers/admins and operates with reduced rate limits. Production access requires a screencast, use-case justification, privacy policy, and compliance history. **No app enters production without review.**

### 3.3 Authorization model

Two sanctioned OAuth 2.0 flows (both produce a **short-lived token (~1h) exchanged for a long-lived token (~60 days)**):

1. **Instagram Business Login (direct OAuth):** `GET https://api.instagram.com/oauth/authorize?client_id={app-id}&redirect_uri={uri}&scope=instagram_business_basic,…&response_type=code` → code → `POST /oauth/access_token` → `GET /access_token?grant_type=ig_exchange_token&access_token={short}` → long-lived token. Scope set includes `instagram_basic`, `instagram_graph_user_profile`, `instagram_manage_messages` (when messaging). Chosen for single-owner / mobile / minimal Facebook infra.
2. **Facebook Login for Business (Instagram API with Facebook Login):** `pages_show_list` + `business_management` + `instagram_basic` on a Facebook Page-bound flow, then `GET /{PAGE_ID}?fields=instagram_business_account` to obtain the IG user id, then IG API calls against that id. Preferred for multi-client / enterprise / Business Manager.

**Refresh semantics:** long-lived tokens are refreshable only **after 24h** since issuance via `GET /refresh_access_token?grant_type=ig_refresh_token&access_token={long}`. Expiry is 60 days of non-refresh; re-auth is required after expiry. Revocation is user-initiated (remove app / deauthorize) and surfaces as `code 190` / `FORBIDDEN` / `AUTH_REQUIRED` on next call. Deletion/revocation must surface as a **DEGRADED** health transition, not UNAVAILABLE.

### 3.4 Scopes / permissions

| Scope | Grants |
|---|---|
| `instagram_basic` | read basic profile + media of the authorizing Business/Creator account |
| `instagram_manage_insights` / `instagram_graph_user_profile` | insights / profile fields beyond basic |
| `pages_show_list`, `business_management`, `pages_read_engagement` | Facebook Page linkage and business management (Facebook-login flow) |
| `instagram_manage_messages` | messaging (separate Messaging API, rate-limit independent) — not used by IGTrack |
| Hashtag search / Business Discovery | separate throttles and permissions (see below) |

Every scope beyond basic requires justified use in App Review.

### 3.5 Supported account types

- **Business and Creator** (`account_type` professional) — full Graph API coverage for the *authorizing* account.
- **Personal** — **not supported** after the Basic Display API deprecation (2024-12-04). The old Basic Display API is deprecated and IGTrack does not rely on it.
- **Private professional accounts** — observable only with authorization; without it the provider must answer `ERROR ACCOUNT_PRIVATE` / `FORBIDDEN`, never fabricated empty data.

### 3.6 Capability-by-capability findings (the honest map)

| Capability (§4 table) | Officially supported? | Authorization required? | IGTrack status if Graph API were wired | Evidence / Notes |
|---|---|---|---|---|
| **Profile** (`GET /{ig-user-id}?fields=id,username,biography,website,followers_count,follows_count,media_count,profile_picture_url,…`) | **AVAILABLE** — but only for the *authorizing* Business/Creator account (and, via Business Discovery, limited metadata for other Business/Creator accounts — see below). | Yes — long-lived user token; business_discovery variant needs the caller to own a linked IG account. | **AVAILABLE** (owned account); **UNAVAILABLE** for arbitrary public accounts without business_discovery. | Meta docs: `developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user`. Follower count is a field on the authorized account, not a list. |
| **Followers (list)** | **UNAVAILABLE** for arbitrary accounts. The Graph API does **not** expose a `/{ig-user-id}/followers` list endpoint. Only the counts (`followers_count`) are readable; full follower graphs are not part of the official API. Community and vendor confirmations converge: Netrows/KeyAPI analyses + StackOverflow business_discovery threads confirm no sanctioned follower-list endpoint. | n/a | **UNAVAILABLE** | IGTrack reports follower *counts* on owned profiles via profile, but `getFollowers()` pagination is **UNAVAILABLE** under Graph API today. Fabricating a list is prohibited. |
| **Following (list)** | **UNAVAILABLE** — symmetric to followers. Only `follows_count`. | n/a | **UNAVAILABLE** | Same reasoning as followers. |
| **Business Discovery (other accounts' metadata)** | **PARTIAL** — `GET /{ig-user-id}?fields=business_discovery.username({target}){id,followers_count,media_count,biography,website,username}` returns **limited metadata for other Business/Creator accounts only**; personal accounts not discoverable. One credit/response per target, counts toward rate limit. | Yes (caller must own an IG account). | **PARTIAL** — usable only as a *supplemental profile* source for Business/Creator targets when an authorizing account exists. Not a substitute for `getFollowers/getFollowing`. | Vendor docs (Netrows, KeyAPI) + SO `business_discovery` answers converge on this. Endpoint is rate-limited and does not return follower *lists*. |
| **Stories** | **PARTIAL / UNKNOWN** — the Graph API's story surface is narrow: container-then-publish for owned-account story creation, and limited read endpoints under platform review. Bulk historical story read for arbitrary accounts is not an official capability. IGTrack treats story observation as ephemeral (24h window) regardless of source. | Yes (owned account); arbitrary-account story observation is not sanctioned. | **PARTIAL** (poll own stories while live, if scoped); otherwise **UNAVAILABLE** | Story payload availability is format-dependent and permission-gated. Any adapter must map absence to `UNAVAILABLE` or `AVAILABLE+[]` (honest empty), never to invented stories. |
| **Mentions** (`mentioned_comment` / `mentioned_media` / `tags`) | **PARTIAL** — mentions **of the authorized account** are readable (`GET /{ig-user-id}/mentioned_comment`, `/mentioned_media`, `/tags`). Reading who an arbitrary account mentioned is not supported. | Yes (owned) | **PARTIAL** (mentions-of-self only) | IGTrack would map these to `Interaction` / `StoryMention` (actor = mentioner); `INFERRED` relationship scoring uses owned-account mention signals only, labeled `INFERRED`. |
| **Public posts / media** | **AVAILABLE** (owned) — `GET /{ig-user-id}/media?fields=id,caption,media_type,permalink,timestamp,…` + `/{media-id}/children` etc. Cursor-paginated. | Yes (owned) | **AVAILABLE** for owned account; **UNAVAILABLE** for arbitrary accounts (business_discovery recently-tagged media may offer a narrow PARTIAL). | Also supports carousel, reels, video — each with aspect/format constraints relevant only to publishing use cases, not IGTrack's read-only observation. |
| **Public comments** | **AVAILABLE** (owned media) — `GET /{ig-media-id}/comments?limit=50&after={cursor}` (cursor-based). Top/filtered views may hide items. | Yes (owned) | **AVAILABLE** (owned media only) | Rate limit per pagination step counts toward 200/h. |
| **Hashtag search** | **PARTIAL** — `ig_hashtag_search` → `/{ig-hashtag-id}/top_media` / `recent_media` / `recently_searched_hashtags`; **30 unique hashtags per 7 days** per IG account. | Yes | **PARTIAL** | Not yet consumed by any IGTrack scan executor; would require its own capability entry if adopted. |
| **Likes (historical "everything they liked")** | **UNAVAILABLE** | n/a | **UNAVAILABLE** | No public likes-history feed exists; consistent with `docs/platform-limitations.md`. Only like signals present in a specific payload, if any — reported PARTIAL/UNAVAILABLE. |
| **DMs / close-friends / hidden content / "who viewed profile"** | **UNAVAILABLE** | n/a | **UNAVAILABLE** | By platform design and IGTrack hard rule; never queried, never inferred. |
| **Historical data depth** | **PARTIAL** — fields/metrics are version-defined; some insights metrics deprecated after `v21` (e.g. `video_views` non-Reels, `email_contacts`, `profile_views`, `website_clicks`, `phone_call_clicks`). Lifetime aggregation requires daily pulls stored locally; the API itself does not serve full history pages. | — | **PARTIAL** | Consequence: IGTrack append-only observation tables are the durable store; the provider is not treated as a history server. |
| **Rate limits** | Enforced — 200 requests / hour / IG user (rolling 60min), BUS `dynamic CPU-time` per Business Use Case; headers `X-App-Usage`, `X-Business-Use-Case-Usage` (`acc_id_util_pct`, `reset_time_duration`); errors `4`/`32`/`429`; all requests (success or failure) count. | — | See §3.7. Maps to `RATE_LIMITED` retryable + `retryAfterMs` verbatim. | |
| **Pagination** | Cursor-based — `after={cursor}` + `paging.cursors.after` + `paging.next`; `limit` typically 25–100; five paginated comment fetches count as five requests. | — | Provider must be cursor-idempotent and keep `complete` honest. | |
| **Webhooks** | **Available** — `instagram` topic subscriptions (comments, mentions, story insights where scoped) — callback verification + delivery retries. | App-level | **DEFERRED** — IGTrack's Phase 6 scheduler polls; webhooks may replace polling only after authorization, with idempotency preserved. Not a capability-mixing excuse. | |
| **Expiration / refresh** | Short → long (≈60d) → refresh after 24h via `/refresh_access_token`; expiry → `code 190` / AUTH failure. | — | Maps to `AUTH_REQUIRED` non-retryable + source-health DEGRADED. Re-auth is user-driven. | |
| **Deletion / revocation** | User removes app or token revoked → immediate `FORBIDDEN` / `AUTH_REQUIRED`; no orphan dereference is permitted. | — | Must be surfaced as **DEGRADED** (not UNAVAILABLE); evidence retention respects deletion (see §13). | |

**Summary row counts:** of the nine IGTrack-core capabilities, the Graph API makes **~3 AVAILABLE (owned profile / posts / comments), ~3 PARTIAL (business_discovery profile, mentions-of-self, hashtag), and ~3 UNAVAILABLE (follower lists, following lists, historical likes, arbitrary-account observation)**. No capability is inferred from endpoint existence alone — each was judged by its configured authorization and scope state.

### 3.7 Rate-limit & pagination specifics (binding on any adapter)

- **Cap:** 200 calls / hour / IG user (rolling 60min; `200 × active IG users` at the app level). Business Use Case layer may throttle earlier on complex/expensive calls.
- **Counting:** every call (success, validation error, permission error) counts; pagination steps count individually; hashtag searches count toward the 30/week quota.
- **Signals:** header `X-Business-Use-Case-Usage: {"ig_api_usage":[{"acc_id_util_pct":50,"reset_time_duration":3600}]}`; app-level `X-App-Usage: {"call_count":x,"total_time":y,"total_cputime":z}`. Adapter should parse `acc_id_util_pct` and `Retry-After`/`reset_time_duration` into `CapabilityError.retryAfterMs`.
- **Errors:** `(#4) Application request limit reached`, `(#32) Page request limit reached`, HTTP `429 Too Many Requests`. IGTrack maps these to `CapabilityErrorKind.RATE_LIMITED`, `retryable:true`, `retryAfterMs = header-derived seconds * 1000`.
- **Pagination:** cursor-based (`after`, `paging.cursors.after`, `paging.next`); `limit` bounded; `next_cursor === null` / absent `next` means `complete:true`. Partial final pages propagate `complete:false` and persist as `PARTIAL` forever (never upgraded to `COMPLETE`).

### 3.8 Authorization lifecycle summary

| Event | Expected adapter mapping | Evidence / source-health effect |
|---|---|---|
| Re-auth / token refresh succeeds | Next scan resumes `AVAILABLE` | `recordCapabilitySuccess` → HEALTHY |
| Token revoked / removed by user | `ERROR FORBIDDEN` or `ERROR AUTH_REQUIRED`, retryable false | `recordCapabilityFailure(FORBIDDEN)` → **DEGRADED** (stale HEALTHY must not survive) |
| Token expired (60d non-refresh) | `ERROR AUTH_REQUIRED` | same DEGRADED |
| Permission narrowed after version upgrade / review revocation | `ERROR FORBIDDEN` on affected capability | DEGRADED on that capability only; UNAVAILABLE stays reserved for capability gaps |

---

## 4. Conclusion and verdict (§24 gate)

- **Authorized-provider evaluation:** **COMPLETE.** Every §4 question has an explicit AVAILABLE/PARTIAL/UNAVAILABLE/UNKNOWN answer with evidence, grounded in current Meta public documentation and reproduced community consensus. No scraping, ToS-violating, or unlawful provider is elevated; no capability is inferred from a bare endpoint.
- **Controlled real-provider testing:** **NOT YET AVAILABLE — correctly.** No Meta app, token, or authorizing Business/Creator account has been supplied, and none was manufactured for this phase (by prohibition). The adapter gate (§5) is mapped but **NOT IMPLEMENTED** until founder D1 is explicitly authorized.
- **Correct Phase 10 claim:** **PROVIDER EVALUATION COMPLETE — REAL PROVIDER TESTING NOT YET AVAILABLE** (the successful outcome defined in §24, not a failure).

The next phase of work begins only with an explicit founder authorization supplying (a) a Business/Creator account willing to be the controlled test account, (b) the Meta app credentials held as runtime env/secret-store only, and (c) App Review scope approval for the capabilities under test. Until then, IGTrack remains **FixtureProvider-only**, and every unavailable capability remains honestly unavailable.

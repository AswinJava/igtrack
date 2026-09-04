# Phase 16 — Permitted Data-Source Feasibility Spike

Date: 2026-09-04 · Baseline: Phase 15 complete (uncommitted working tree, `229b5d4` HEAD).
Author: research + contract spike (no production-code mandate).
Mode: **documentation/contract analysis only — no credentials exist, no live calls issued.**

Claim convention used throughout: **documented by Meta** | **experimentally verified**
| **inferred** | **unknown**. Inference is never presented as fact.

## 1. Executive conclusion

An authorized, supported data source exists for roughly half of IGTrack's
original vision and for none of its surveillance mechanics.

- **Viable:** self-monitoring mode for an owned Instagram Business/Creator
  account — profile snapshots/diffs, owned media catalog, owned-media comments
  (with authors, timestamps, replies), owned story existence + per-story
  insights, mentions-of-self/tags inbox, account/media insights analytics,
  and supplemental Business/Creator metadata via Business Discovery.
  Every one of these maps onto an IGTrack provider method or an already-built
  pipeline without weakening UNAVAILABLE semantics.
- **Not viable:** arbitrary-account follower/following lists and diffs,
  like histories and liker identities, hidden/ghost story-mention geometry,
  story viewers, Highlights, DMs, private/Close Friends data, and any
  personal-account observation. The official API exposes none of these, and
  Meta states the story-mention exclusion explicitly
  ("Mentions on Stories are not supported" — Mentioned Media reference,
  documented by Meta).
- **Strongest single finding:** the synthetic hidden-mention classifier
  (`is_hidden` + x/y geometry) **cannot be promoted** to a real Instagram
  capability. No supported endpoint returns mention stickers, coordinates,
  or visibility flags for stories.

Product consequence: IGTrack should become an **authorized-account
self-monitoring + evidence platform**, not an arbitrary-account intelligence
tool. Tier lists in §12. No adapter code is written in this phase (§11
proposal only).

## 2. Sources consulted

Official Meta documentation (primary; fetched 2026-09-04):

- IG User reference — `developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/` (updated 2026-04-22; v26.0 examples). Edges enumerated; no follower/following list edge exists.
- Stories reference — `.../reference/ig-user/stories/` (updated 2026-08-12). `GET /{ig-user-id}/stories` returns live story media IDs; 24h window; no Live Video; reshared stories excluded; one caption per story.
- IG Media (both login paths) — `developers.facebook.com/docs/instagram-platform/reference/instagram-media` (+ `/v21.0`, + Facebook-Login variant). Full field list: counts only for likes; `comments` edge; no sticker/geometry fields. `media_product_type` includes `STORY`.
- IG Comment — `developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/` (+ `/v21.0`). Fields `from/username/text/timestamp/hidden/like_count/media/parent_id/replies`; `replies` edge; `username` gated by manage-comments scope since 2024-08-27.
- Mentioned Media — `.../reference/ig-user/mentioned_media/` (updated 2026-08-12). Webhook-driven; requires media-id from webhook; **"Mentions on Stories are not supported."**
- Business Discovery — `.../instagram-graph-api/reference/ig-user/business_discovery/` (+ platform guide, updated 2026-08-12). Other Business/Creator metadata + nested `media` edge; no lists.
- Media Insights — `.../reference/instagram-media/insights` (updated 2026-06-18). Story metrics 24h-only, <5-viewer error, 2-year retention, 48h delay, EU/JP `replies == 0`.
- Platform API reference index — `developers.facebook.com/documentation/instagram-platform/reference` (two hosts: `graph.facebook.com` Facebook Login, `graph.instagram.com` Instagram Login).
- IG User Media — `.../reference/ig-user/media` (July 9 2025 note: `user_tags` x/y for story *publishing*).

Secondary (corroboration only, never sole evidence): community reference gist
(April 2026, v25.0), KeyAPI/HikerAPI guides (used only for their statements
about official-API limits, not their products), Elfsight/Zernio/BeyondComments
2026 guides, one Stack Overflow thread (2018–2023, follower-list absence).

Repo baseline re-confirmed in source: `packages/core/src/provider.ts` (7
methods; posts/comments PARKED Phase 15), `packages/core/src/capability.ts`
(AVAILABLE/PARTIAL/UNAVAILABLE/ERROR + taxonomy),
`workers/monitoring/src/{index.ts:165-173,executors.ts}` (4 scan kinds:
PROFILE/FOLLOWER/FOLLOWING/STORY), `docs/provider-contract.md` §1/§1e/§1f,
`docs/phase-10-controlled-testing.md` (testing NOT YET AVAILABLE — still true).

Prior-evaluation corrections recorded (§14): observed API version is now
**v26.0** (Phase 10 said v23.0+); story-ID listing upgrades from
PARTIAL/UNKNOWN to SUPPORTED-for-owned; story mentions downgrade to explicit
NOT_SUPPORTED (was implied).

## 3. Current API/product assumptions

- **Two sanctioned paths** (documented by Meta): Instagram API with Facebook
  Login (`graph.facebook.com`, superset: Business Discovery, hashtag search,
  media deletion) and with Instagram Login (`graph.instagram.com`, simpler;
  `instagram_business_*` scopes). IGTrack needs the Facebook-Login path for
  Business Discovery.
- **Account eligibility:** Business/Creator (professional) only. Personal
  accounts have zero API access (Basic Display fully sunset September 2025 —
  corroborated secondary; treat sunset date as inferred).
- **App Review** required before non-tester accounts work; Development Mode is
  tester-only with reduced limits (documented by Meta).
- **Tokens:** short-lived (~1h) exchanged for long-lived (~60d), refreshable
  only after 24h; revocation/expiry surfaces as code 190 / AUTH failures
  (documented by Meta; lifecycle mapping already specified in
  `provider-contract.md` §3.7–3.8 and `phase-10-controlled-testing.md` §6).
- **Rate limits:** 200 calls/hour/IG user rolling; hashtag 30 unique/7d;
  pagination steps count individually (documented by Meta + corroborated).
- **No credentials exist** in this workspace (`IGTRACK_GRAPH_ACCESS_TOKEN`
  absent, `IGTRACK_PROVIDER` unset — existence-checked 2026-09-04, values
  never read or printed). All statuses below are documentation-derived.

## 4. Capability matrix

Status: SUPPORTED | PARTIALLY_SUPPORTED | NOT_SUPPORTED | UNKNOWN.
Scope column: owned = authorizing account; discovery = other Business/Creator
via Business Discovery; arbitrary = any public account (unsupported by design).

| # | Requirement | Source | Account requirement | Permission | Status | Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | Target tracking | Graph API + business_discovery | Owned full; other Business/Creator metadata only | basic (both paths) | PARTIALLY_SUPPORTED | IG User ref; Business Discovery ref | high |
| 2 | Authorized account profile | `GET /{ig-id}?fields=id,username,biography,website,followers_count,follows_count,media_count,profile_picture_url` | Owned | basic | SUPPORTED | IG User ref fields table | high |
| 3 | Posts/media | `GET /{ig-id}/media` + `GET /{media-id}` (cursor, `since/until`, ~10K) | Owned; discovery nested `media` edge | basic | SUPPORTED (owned) / PARTIAL (discovery) | IG Media ref; gist §3 | high |
| 4 | Comments | `GET /{media-id}/comments` + `GET /{comment-id}` + `replies` edge | Owned media only | basic + manage_comments (`username` field) | SUPPORTED | IG Comment ref; fields incl. `hidden`, `like_count`, `parent_id` | high |
| 5 | Likes | `like_count` fields only (media + comment) | Owned/discovery counts | basic | NOT_SUPPORTED (identity/history) | IG Media ref: count semantics + hidden-like omission; no likers edge in node/edge lists | high |
| 6 | Story metadata | `GET /{ig-id}/stories` → IDs; `GET /{media-id}` STORY fields | Owned, live only | basic (+ pages_read_engagement, FB path) | SUPPORTED (IDs) / PARTIAL (content: omissions) | Stories ref; media_url omission rules | high |
| 7 | Story mentions | None | — | — | NOT_SUPPORTED | Mentioned Media ref: "Mentions on Stories are not supported" | high |
| 8 | Hidden/ghost mentions | None | — | — | NOT_SUPPORTED | §7 A–H; no geometry fields in IG Media ref | high |
| 9 | Followers (list) | None | — | — | NOT_SUPPORTED | IG User edges list contains no follower edge; counts only | high |
| 10 | Following (list) | None | — | — | NOT_SUPPORTED | Symmetric to followers | high |
| 11 | Follow changes | Counts polling + `follows_and_unfollows` insight | Owned | basic + manage_insights | PARTIALLY_SUPPORTED (count deltas only, no identity) | Insights metrics list | medium-high |
| 12 | Accounts followed by target | None | — | — | NOT_SUPPORTED | Follows from §9–10 | high |
| 13 | Accounts that followed target | None | — | — | NOT_SUPPORTED | Follows from §9–10 | high |
| 14 | Favourite people / relationships | Comments + mentions-of-self + tags + collaborators | Owned signals | basic + manage_comments | PARTIALLY_SUPPORTED (narrowed signal set) | §6; no follow/like edges | medium |
| 15 | Activity timeline | Owned profile/media/comment/story/insight events | Owned | basic (+ scopes per signal) | PARTIALLY_SUPPORTED | Composable from rows 2–4, 6 | medium-high |
| 16 | Alerts | Polling owned data (webhooks deferred) | Owned | per-signal scopes | PARTIALLY_SUPPORTED | Polling proven in-repo; webhooks exist but unintegrated | medium |
| 17 | Analytics | Media + account insights, demographics (100+ followers) | Owned | manage_insights | SUPPORTED | Media Insights ref (metrics table, retention, delay) | high |
| 18 | Media archive | `media_url` (owned) | Owned | basic | PARTIALLY_SUPPORTED (copyright omissions; policy TBD) | IG Media ref omission rules | medium-high |
| 19 | Highlights | None | — | — | NOT_SUPPORTED | No endpoint in reference index; publish guides confirm absence | high |
| 20 | Story viewer information | None (<5-viewer error shows privacy floor) | — | — | NOT_SUPPORTED | Media Insights story limits | high |
| 21 | DMs | Messaging API exists (customer-initiated) | — | messaging scopes | NOT_SUPPORTED for IGTrack (hard rule prohibits DMs regardless) | Platform policy + repo hard rules | high |
| 22 | Private / Close Friends | None | — | — | NOT_SUPPORTED | By platform design + hard rule | high |
| 23 | AI researcher | Grounded on owned evidence only | Owned evidence | — | PARTIALLY_SUPPORTED (scope-limited, no new source) | Follows from rows 2–4, 17 | medium |
| 24 | Social graph | Follow edges absent; comment/mention/tag/collaborator edges only | Owned ego-network | per-signal scopes | PARTIALLY_SUPPORTED (interaction ego-graph; follow-graph NOT_SUPPORTED) | Edge inventory §2 | medium-high |

## 5. Account-type requirements

- Business or Creator, owned by (or explicitly authorizing) the IGTrack user:
  full Tier A/B coverage. **Documented by Meta.**
- Other Business/Creator (no authorization): Business Discovery metadata +
  nested media only. **Documented by Meta.**
- Personal accounts (owned or third-party): zero API access. **Documented
  by Meta** (Basic Display sunset). IGTrack must treat personal-account
  targets as UNAVAILABLE-with-note, never as empty.
- Private professional accounts without authorization: `ERROR
  ACCOUNT_PRIVATE` / `FORBIDDEN`, never fabricated empties (existing
  taxonomy already supports this; unchanged).

## 6. Permission requirements

Facebook-Login path (superset IGTrack needs): `instagram_basic`,
`instagram_manage_insights`, `instagram_manage_comments` (required for
comment `username` since 2024-08-27), `pages_read_engagement` (+
`ads_management`/`ads_read` when Page role via Business Manager),
`pages_show_list`/`business_management` for the Page-bound flow.
Instagram-Login path equivalents: `instagram_business_basic`,
`instagram_business_manage_comments`, `instagram_business_manage_insights`.
Hashtag search and Business Discovery require the Facebook-Login path.
Messaging scopes are intentionally out of scope (hard rule). All beyond-basic
scopes need App Review justification. **Documented by Meta.**

## 7. Hidden-mention investigation (highest risk)

| Item | Verdict | Basis |
|---|---|---|
| A. A mention occurred in a story | NOT_SUPPORTED | "Mentions on Stories are not supported" (Mentioned Media ref) |
| B. Who was mentioned | NOT_SUPPORTED | Same; no story-mention read endpoint or webhook topic |
| C. Mention position | NOT_SUPPORTED | IG Media field list has no sticker/geometry fields |
| D. Sticker dimensions | NOT_SUPPORTED | Same |
| E. Off-canvas state | NOT_SUPPORTED | Same |
| F. Intentional hiding | NOT_SUPPORTED | Same; unknowable without C–E |
| G. Metadata after publication | NOT_SUPPORTED | 24h story window; post-expiry only aggregate insights |
| H. Story media itself accessible | SUPPORTED (owned, live, with omissions) | Stories edge + IG Media STORY type |

Related nuance: `user_tags` x/y for stories exists **publish-side only**
(July 2025 IG User Media changelog). Read-side `user_tags` on stories is
**unknown** — no documented read field; must not be assumed. Even if later
observed, tag coordinates are not hidden-mention proof.

**Conclusion:** the current synthetic classifier (`is_hidden` + x/y/width/
height/canvas → VISIBLE/POSSIBLY_HIDDEN/OFF_CANVAS/METADATA_ONLY/UNKNOWN)
**cannot be promoted** to a real Instagram capability. It remains a
fixture-geometry classifier, correctly labeled SYNTHETIC. Any future story
work is limited to existence + insights on owned stories.

## 8. Interaction conclusion

- **Likes:** aggregate `like_count` on owned (and discovery-nested) media and
  on comments; omitted when the owner hides likes. Liker identities,
  historical like feeds, and "likes by X on others' posts" do not exist in
  the official API. IGTrack keeps likes-history UNAVAILABLE permanently.
- **Comments:** fully readable on owned media — identity (`from`/`username`
  with manage-comments scope), text, timestamps, `hidden` flag, per-comment
  `like_count`, `parent_id` replies, `replies` edge, age-gate/restriction
  caveats. Comments *by* the monitored account on arbitrary others' posts
  are not retrievable (read surface is owned-media only; POST endpoints
  write as the owned account — not monitoring). Unparks the
  `getPublicComments` half of the Phase 15 PARKED contract for owned media.
- **Follows:** counts (`followers_count`/`follows_count`) plus the
  `follows_and_unfollows` insight metric. No lists, no identities, no
  arbitrary-account lists. Follow *identity* diffs stay UNAVAILABLE; count
  trend diffs are buildable.
- **Mentions/tags:** mentions-of-self via webhook + `mentioned_media` /
  `mentioned_comment` lookup (caption/comment mentions only, never
  stories); `tags` edge for photo-tags of the owned account; `collaborators`
  edge on owned media. `POST /{id}/mentions` is a reply action, not a read
  surface — must not be mistaken for one.

## 9. Follower/following investigation

No sanctioned list endpoint exists on either login path (edge inventory
confirms; corroborated by vendor guides and a 36k-view SO thread converging
on `followers_count`-only). Business Discovery returns counts, never lists.
Third-party list vendors exist and are **rejected** — unaudited
authorization basis, incompatible with the lawful-boundary rule. Do not infer
lists from counts, demographics (aggregated top-45, 100+ followers), or
`follows_and_unfollows` (net counts). `getFollowers`/`getFollowing` remain
UNAVAILABLE under any future `graph:` adapter; the fixture pagination stays
as the *mechanical* reference only.

## 10. Controlled test plan (manual; credentials absent — NOT executed)

Prerequisites (founder D1): owned Business/Creator account designated in
writing; Meta app (Development Mode tester = the owned account); long-lived
token in env/secret-store only; minimal scopes first (`instagram_basic`).

Known-data setup (founder-owned assets only, no real-user data): test post
with known caption; second owned tester account comments known text + reply;
caption @mention of the owned account; photo tag; live test story; one
Business/Creator discovery target (e.g. a brand account).

Cases (record raw status/fields present AND absent; store hashes only):

1. `GET /{id}?fields=id,username,biography,website,followers_count,follows_count,media_count,profile_picture_url` — expect AVAILABLE; note absent `is_private`/`is_verified` → UNKNOWN.
2. `GET /{id}/media?limit=5` + one `GET /{media-id}` — expect AVAILABLE; record pagination cursors; confirm `like_count` present, no likers field.
3. `GET /{media-id}/comments?limit=50` on the known-commented post — expect the planted comment with `from.username`, `timestamp`, `parent_id` on the reply; record whether `username` requires the manage-comments scope on this app.
4. `GET /{id}/stories` while the test story is live + after 24h — expect IDs then honest empty; record expiry behavior; confirm no mention/geometry fields on story media GET.
5. `GET /{id}/tags` + webhook-then-`mentioned_media.media_id()` for the planted mention — expect caption mention retrievable; confirm story-mention absence.
6. `business_discovery.username({brand}){followers_count,media_count,media}` — expect PARTIAL metadata; confirm no follower list field exists.
7. `GET /{media-id}/insights?metric=likes,comments,reach,views` — expect AVAILABLE; record delay/retention behavior.
8. Revocation probe (remove app tester or expire token in sandbox): expect `FORBIDDEN`/`AUTH_REQUIRED` → DEGRADED mapping; then re-auth → HEALTHY.

Success criteria: every planted datum observed with documented fields; every
absent field logged as absent (not failed); no UNAVAILABLE converted to empty.

## 11. Future adapter contract proposal (no implementation)

```
InstagramProvider (unchanged interface; posts/comments UNPARK for owned scope)
├── FixtureProvider      fixture:v1   (unchanged behavior, all tests intact)
└── GraphProvider (future) graph:ig:<vAPI>  (Facebook-Login path)
     ├── resolveAccount  → GET /{self-id} (self) | business_discovery (pro targets)
     ├── getProfile      → GET /{id}?fields=<profile set>            AVAILABLE (owned) / PARTIAL (discovery)
     ├── getStories      → GET /{id}/stories + media expansion       AVAILABLE (owned IDs) / PARTIAL (content) / UNAVAILABLE (others)
     ├── getFollowers    → no request issued                         UNAVAILABLE + coverage note (permanent)
     ├── getFollowing    → no request issued                         UNAVAILABLE + coverage note (permanent)
     ├── getPublicPosts  → GET /{id}/media cursor                    AVAILABLE (owned) / PARTIAL (discovery-nested)
     └── getPublicComments → GET /{media}/comments cursor            AVAILABLE (owned media)
```

New work the adapter needs (later phase): `graph:` source class (already
reserved by `sourceKindFor`), token lifecycle manager (refresh >24h,
190-mapping), `retryAfterMs` from `Retry-After`/`reset_time_duration`,
per-page body hashing, `INTERACTION_SCAN` executor unparking (comments only),
an `INSIGHTS_*` capability entry if analytics is adopted (new CapabilityName
+ executor + persistence — not free), webhook receiver (deferred).
Capability semantics preserved verbatim: UNAVAILABLE never becomes `[]`;
PARTIAL never upgrades; raw-hash-or-NULL; UNKNOWN stays nullable.

## 12. Product strategy tiers

**Tier A — buildable with supported authorized data:** owned profile
monitoring + diffs; owned media catalog + timeline; owned comment inbox
(authors, replies, hidden flags); owned story existence tracking; insights
analytics (media/account/demographics); mentions-of-self/tags inbox;
Business Discovery supplemental pro profiles; alerts polling on owned data;
evidence/provenance (already built, source-agnostic).

**Tier B — narrowed:** relationship signals from comments/mentions/tags/
collaborators only (no follow/like edges); follow-change detection as count
trends (no identity); media archive modulo copyright omissions; hashtag
monitoring (30/7d, 24h recent window, no usernames); AI summaries grounded
strictly on owned evidence; interaction-only ego network (no follow graph).

**Tier C — not viable:** follower/following identity lists + diffs; likes
history/likers; hidden story mentions + geometry; story viewers; Highlights;
DMs; private/Close Friends; arbitrary personal-account monitoring;
follow-graph visualization; any AI claim over unavailable data.

**Tier D — unknown pending controlled test:** read-side `user_tags` on
stories; reshared-story visibility; EU/JP `replies==0` impact magnitude on
comment signals; webhook real-time viability; `media` edge depth limits in
Business Discovery.

**Recommendation:** IGTrack becomes an **authorized-account
self-monitoring + evidence platform**: connect your Business/Creator
account → monitor your profile, content, audience interactions, and mentions
with evidence-grade provenance → optionally track competitor *Business/
Creator* metadata via Discovery. Drop arbitrary-account follow-graph and
ghost-mention features explicitly (document as Tier C, not as roadmap).

## 13. Explicit unsupported capabilities

Follower/following identity lists and diffs; liker identities and like
histories; story-mention metadata and hidden-mention detection; story viewer
lists; Highlights read; DMs; Close Friends/private content; personal-account
observation of any kind; "who viewed/unfollowed me" identity feeds;
third-party list-vendor data; any ToS-violating collection. All remain
UNAVAILABLE by platform design and IGTrack hard rule.

## 14. Open questions

1. Read-side `user_tags` on story media (publish field exists; read
   undocumented)?
2. Exact `media`-edge depth/cursor behavior inside Business Discovery?
3. Story `media_url` availability distribution (how often omitted)?
4. EU/JP reply suppression effect size on story/comment signals?
5. Webhook latency/reliability vs 30-min story polling for owned stories?
6. `instagram_business_*` (Instagram Login) vs Facebook-Login parity for
   mentions/tags/Discovery (Discovery + hashtag are FB-path-only — confirmed;
   rest assumed parallel, unverified)?
7. App Review friction for `instagram_manage_comments` + `instagram_manage_insights`
   on a single-owner self-monitoring app?
8. Should `INSIGHTS_*` become first-class capabilities or stay inside
   analytics-only reads (executor/persistence cost)?

## 15. Recommended Phase 17

**Founder authorization decision (D1) + read-only owned-account probe.**
The founder designates one owned Business/Creator account and provisions a
Development-Mode Meta app + long-lived token via secret-store; engineering
executes §10 cases 1–4 read-only (no writes, no publishing, no token
persistence beyond env), then reports observed-vs-absent fields. No adapter
code until the probe confirms the matrix. If D1 is declined, Phase 17 is:
re-scope the product spec to synthetic/demo + Tier A design freeze, and close
the live-ingestion track explicitly.

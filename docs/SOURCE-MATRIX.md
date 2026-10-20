# Source-capability matrix

**Date:** 2026-10-20 · **Status:** the operative answer to "what can IGTrack
actually get, from where, and what happens when it cannot?"

This document is written against the code, not against a plan. Every row names
the file that implements it and the test that pins it. Where the answer is
"no", the row says so plainly: a category that is platform-absent, refused by
policy, or simply not implemented is recorded as exactly that.

The product is a **username-first investigation engine**: one handle in, every
permitted source queried, one provenance-backed dossier out
(`igtrack investigate <username>`, MCP `igtrack_investigate`).

---

## 0. The evidence classes

Six classes. They are counted separately in every report and are **never
merged** into one unlabelled result.

| Class | What it is | Where it comes from | How it is labelled at rest |
|---|---|---|---|
| `PLATFORM_OBSERVATION` | A documented official API answered. | The Instagram Graph API, for the account the deployment is authorized for. | `sources.kind = GRAPH_API`; evidence rows carry raw + normalized hashes, observation id, observed vs captured time. |
| `PUBLIC_WEB` | A public page stated something. | The public-web research engine (search + fetch). | A claim row with its source URL, page title, excerpt, excerpt SHA-256 and retrieval time — or, for a read-only probe, a fact with the same citation. |
| `USER_EXPORT` | The operator's own Instagram data export. | The `import` provider. | `sources.kind = IMPORT`; the evidence note says the files carry no generation timestamp, so the observation time is when IGTrack read them. |
| `USER_PROVIDED` | The operator or their agent submitted it. | The claims ledger (`igtrack claims add`). | A claim row with a citation, a relation label and a review horizon. Never an observation. |
| `DERIVED` | Computed from the rows above. | Themes, cadence, relationship ranks, contradictions. | Always stated with the rows and the formula behind it. |
| `SYNTHETIC_FIXTURE` | Generated test data. | The packaged fixture set. | `sources.kind = FIXTURE`; `evidence.metadata.synthetic = true`; `_meta.synthetic = true` on every payload. |

**The class follows the SOURCE, not the fact that a source happened to answer.**
A fixture set that observes an account produces `SYNTHETIC_FIXTURE` evidence,
never `PLATFORM_OBSERVATION`. Getting this wrong is how generated data ends
up described as a live reading — so it is pinned by
`apps/cli/test/investigate.test.ts`.

---

## 1. The sources

| Source | Configured by | Makes network requests? | Status |
|---|---|---|---|
| **Instagram Graph API** (owned account) | `IGTRACK_PROVIDER=graph` + `IGTRACK_GRAPH_ACCESS_TOKEN` / `IGTRACK_GRAPH_IG_USER_ID` / `IGTRACK_GRAPH_USERNAME` | Yes — `graph.facebook.com` | Implemented. **NOT VERIFIED live in this environment**: no valid credential exists here. |
| **Instagram Graph API** (other account, Business Discovery) | the same + `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` | Yes | Implemented, opt-in, off by default. **NOT VERIFIED live** (no credential). |
| **Operator's own export** | `IGTRACK_PROVIDER=import` + `IGTRACK_IMPORT_DIR` + `IGTRACK_IMPORT_USERNAME` | No — local files | Implemented. |
| **Public web** | `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto` (keyless FreeSerp, or Brave with a key) | Yes — the search index and the fetched pages | Implemented and exercised live. |
| **Operator/agent findings** | `igtrack claims add` | No | Implemented. |
| **Fixture set** | `IGTRACK_PROVIDER=fixture` | No | Implemented; the default and the demo. |

`auto` is the shipped default: a real search with no account, no key and no
meter. `none` guarantees no request leaves the machine.

---

## 2. Category by category

### 2.1 Account identity and profile metadata

| | |
|---|---|
| **Fields sought** | `id`, `username`, `name`, `biography`, `profile_picture_url`, `followers_count`, `follows_count`, `media_count`, `website` |
| **Source** | Graph API, owned account (`GRAPH_PROFILE_FIELDS`, `packages/ingestion/src/graph/graph-provider.ts`) |
| **Supported / permitted** | Yes — the owned account only |
| **Requires** | A Business or Creator Instagram account connected to a Meta app; a long-lived user token; the Facebook Login product with `instagram_basic` (and `instagram_manage_insights` for insights, `pages_read_engagement` for the discovery route) |
| **Implementation** | Implemented — `getProfile` |
| **Pagination / limits** | Single node read; no pagination |
| **Freshness / provenance** | Every read is an evidence row: raw hash, normalized hash, observation id, source id, observed vs captured time, confidence |
| **When denied** | `ACCOUNT_NOT_FOUND` / `ACCOUNT_PRIVATE` / `AUTH_REQUIRED` / `FORBIDDEN` / `RATE_LIMITED` / `TIMEOUT`, each typed, each with the platform's reason, each **never** an empty success |
| **Tests** | `packages/ingestion/test/graph-provider.test.ts`, `packages/database/test/capability-depth.test.ts` |

The fixture set supplies the same shape, labelled `SYNTHETIC_FIXTURE`. The
export supplies **no** profile at all (`getProfile: false`).

### 2.2 Accessible public posts and content timeline

| | |
|---|---|
| **Fields sought** | `id`, `caption`, `timestamp`, `like_count`, `comments_count`, `permalink`, `shortcode`, `media_type`, `media_product_type`; album children: `id`, `media_type`, `permalink`, `shortcode`, `timestamp` |
| **Source** | Graph API media edge (`GRAPH_MEDIA_FIELDS`, `GRAPH_CHILD_FIELDS`) |
| **Supported / permitted** | Yes — owned account |
| **Requires** | as §2.1 |
| **Implementation** | Implemented — `getPublicPosts` + `getPostChildren`; presence and change rows recorded per post (D54–D58) |
| **Pagination / limits** | Cursor paging via `after`; the worker follows the cursor and stops on a repeated cursor, a page cap (`IGTRACK_FOLLOW_MAX_PAGES`, default 500) or a rate limit, recording PARTIAL — never COMPLETE |
| **Freshness / provenance** | `post_presence` carries first/last seen; `post_changes` carries append-only caption-change and no-longer-observed events, each with its own evidence row |
| **When denied** | `UNAVAILABLE` with the reason when the capability is off; a typed error when the route fails; the scan is PARTIAL, never a fabricated absence |
| **Tests** | `workers/monitoring/test/posts-scan.test.ts`, `posts-paging.test.ts`, `posts-changes.test.ts` |

### 2.3 Captions, hashtags, topics, media metadata

| | |
|---|---|
| **Fields sought** | The caption text, its hashtags, derived terms, `media_type` / `media_product_type` (so Reels and carousels are distinguishable), `reposts_count` when the platform returns it |
| **Source** | The stored captions (Graph or export) → `deriveThemes` (`packages/core/src/synthesis.ts`) |
| **Supported / permitted** | Yes — derived from rows the operator is entitled to |
| **Requires** | as §2.1 |
| **Implementation** | Implemented. The corpus size travels with the result: a term without its corpus is not shown |
| **Pagination / limits** | Bounded by the stored rows, not by the platform |
| **Freshness / provenance** | Every term names the caption count it came from; the derivation is stated, never presented as an observation |
| **When denied** | `UNAVAILABLE` with the reason (no captions stored yet) |
| **Tests** | `packages/core/test/synthesis.test.ts`, `apps/cli/test/research-benchmark.test.ts` |

`reposts_count` is a documented IG Media field, **not** a reshare relation:
who reposted is platform-absent (§2.9).

### 2.4 Comments, replies and threading

| | |
|---|---|
| **Fields sought** | `id`, `text`, `username`, `timestamp`, `parent_id`, `like_count`, `from{id,username}`, `replies{...}` |
| **Source** | Graph API comments edge (`GRAPH_COMMENT_FIELDS`) |
| **Supported / permitted** | Yes — comments on media the operator owns |
| **Requires** | as §2.1 |
| **Implementation** | Implemented — `getPublicComments`, with replies and parents resolved in one self-join |
| **Pagination / limits** | Cursor paging; a truncated comment fetch never suppresses or creates a media claim (D55) |
| **Freshness / provenance** | Each comment row carries its own evidence id, observed time and confidence; `like_count` is null when the platform withholds it, never zero-filled |
| **When denied** | `UNAVAILABLE` per post — the post is still recorded, the comment list is simply absent |
| **Tests** | `workers/monitoring/test/posts-scan.test.ts`, `packages/database/test/posts.test.ts` |

### 2.5 Mentions, tags and accessible interactions

| | |
|---|---|
| **Fields sought** | **Story metadata**: `id`, `timestamp`, `media_type`, `caption` (`GRAPH_STORY_FIELDS`). **Story mentions**: username, geometry, visibility class — **not exposed by the official API**. **The `tags` edge**: media by OTHER accounts in which the account is tagged (`id`, `username`, `caption`, `permalink`, `media_type`, `timestamp`). **The `mentioned_comment` read**: `timestamp`, `like_count`, `text`, `id`, `media` — one comment, on demand, by id. |
| **Source** | Graph API stories edge (metadata only), the `tags` edge, the `mentioned_comment` field expansion |
| **Supported / permitted** | Story **metadata**, `tags` and `mentioned_comment`: yes — owned account. **Story mentions: no.** Meta's documented stories read is limited to the authorized account's own tray and **exposes no story-mention field**; a mention is a sticker field the public reference does not carry. The registry records this as `DOCUMENTED_ABSENT` for the read path, and the project's own reverse-engineering of a real client confirms it independently: the mention arrays that client renders are produced **server-side by a third-party backend** proxying undocumented endpoints — a route this project forbids (invariant 3). |
| **Requires** | as §2.1; for `mentioned_comment`, a comment id delivered by a Meta webhook |
| **Implementation** | Implemented — `getStories` (metadata), `getTags`, `getMentionedComment`. The mention AGGREGATION (visibility classes, the hidden-mention roll-up) is implemented over the rows a source does expose; with the official API it reads empty, and says so |
| **Pagination / limits** | `tags` pages by cursor with the platform's default page size (no invented bound); mentions are read per story; `mentioned_comment` is a single read |
| **Freshness / provenance** | Visibility classes are recorded per mention (`VISIBLE` / `POSSIBLY_HIDDEN` / `OFF_CANVAS` / `METADATA_ONLY` / `UNKNOWN`); `UNKNOWN` is never promoted to "hidden" |
| **When denied** | `UNAVAILABLE` with the reason; a missing `tags` file in a fixture set is UNAVAILABLE, never an empty listing |
| **Tests** | `workers/monitoring/test/story-scan.test.ts`, `tags-scan.test.ts`, `packages/core/test/mention-intelligence.test.ts`, `packages/database/test/capability-consistency.test.ts` |

### 2.6 Followers, following, mutual follows

| | |
|---|---|
| **Fields sought** | `username` (and `igId` when the export carries one) |
| **Source** | **Only** the operator's own export (`import` provider, `followers_*.json` / `following.json`) |
| **Supported / permitted** | For the operator's OWN account: yes. For ANY other account: **platform-absent** — the Graph API exposes no follower or following list edge for a third-party account, and that is a structural fact, not a missing permission |
| **Requires** | The operator's own Instagram data export (the "Download your information" archive) and `IGTRACK_IMPORT_USERNAME` naming the export's owner |
| **Implementation** | Implemented — `getFollowers` / `getFollowing` in `packages/ingestion/src/import/import-provider.ts`. The Graph provider declares both **false** |
| **Pagination / limits** | One file per page; the last file in the enumeration is the complete listing. Partial exports are stored PARTIAL and are **never diffed**, so a truncated roster can never fabricate a loss |
| **Freshness / provenance** | The export files carry **no** generation timestamp, so the observation time is when IGTrack read them, and the evidence note says exactly that. A generation time is never invented |
| **When denied** | A missing export directory or owner is a **configuration error** (exit 3), never `UNAVAILABLE` — a missing file is not an empty roster |
| **Tests** | `packages/ingestion/test/import-provider.test.ts`, `packages/database/test/follows.test.ts` |

**A follower count is not a follower list.** The Graph API returns
`followers_count` for the owned account; that is a number, and the dossier
renders it as a number. It is never described as a roster.

### 2.7 Follow/unfollow changes over time

| | |
|---|---|
| **Fields sought** | `change` ∈ {`NEW_FOLLOWER`, `LOST_FOLLOWER`, `NEW_FOLLOWING`, `LOST_FOLLOWING`}, the account, the two snapshots it was derived from |
| **Source** | Derived from comparable COMPLETE rosters |
| **Supported / permitted** | Yes, from the export — and only from comparable rosters |
| **Implementation** | Implemented — `persistFollowDiff` (`packages/database/src/repositories/follows.ts`) |
| **Pagination / limits** | A diff compares only snapshots from the **same source**: a synthetic roster and a live roster are different populations, and diffing them would name real accounts as lost followers on the strength of synthetic data |
| **Freshness / provenance** | Each delta links both snapshot ids; the snapshots carry their own evidence rows |
| **When denied** | A PARTIAL snapshot is stored but never diffed, in either direction (invariant 4) |
| **Tests** | `packages/database/test/follows.test.ts`, `packages/core/test/follow-diff.test.ts` |

### 2.8 Related accounts and external references

| | |
|---|---|
| **Fields sought** | A public page's structured fields: JSON-LD `Person`/`Organization` (name, kind, locality, industry, email), `og:site_name`, `mailto:` addresses, and links to other public profiles |
| **Source** | The public-web research engine (`packages/ingestion/src/research/extract.ts`) |
| **Supported / permitted** | Yes — public pages, read through an SSRF/robots/size/time gate. **Instagram-family hosts are refused outright**: platform data reaches this product only through the Graph provider |
| **Requires** | A search provider (keyless FreeSerp by default, or Brave with a key) and/or operator-named `--url` pages |
| **Implementation** | Implemented. **Page prose is never mined** — only four fixed structured field families — so page text is structurally inert against prompt injection |
| **Pagination / limits** | At most 10 documents, depth 1 (links on a fetched page are counted, never followed), 10 s per document, 512 KB per document, 3 redirects, 24 h document freshness |
| **Freshness / provenance** | Every fact carries its source URL, page title, the exact structured field, the extraction method, the retrieval time and the document's SHA-256 |
| **When denied** | A machine-found page that never names the handle is **discarded**; a statement that names the source rather than the handle is **not attributed** to the account; a refused host is reported as `BLOCKED_BY_POLICY`, never as a failure |
| **Tests** | `packages/ingestion/test/research-extract.test.ts`, `research-fetch.test.ts`, `research-search.test.ts`, `apps/cli/test/research-run.test.ts` |

### 2.9 Publicly disclosed account connections (shares, likes, interactions)

| | |
|---|---|
| **Fields sought** | Nothing — **no supported source exposes them** |
| **Source** | None |
| **Supported / permitted** | **No.** The Graph API exposes no liker list, no interaction history and no repost object. `reposts_count` is a count on the media, not a relation |
| **Implementation** | Declared `false` in the capability registry with the reason; the `interactions` table is a documented, dormant landing zone, not a collector |
| **Tests** | `packages/database/test/capability-consistency.test.ts` pins the registry against the provider methods |

A mention, a like, a shared hashtag or a search result is **never** read as a
following relationship. `igtrack relationships` ranks only observed
story mentions, comment authorship on owned media, and recorded follow deltas
— and it renders the live and synthetic rankings apart.

### 2.10 Story highlights

| | |
|---|---|
| **Fields sought** | Nothing — **no supported source exposes them** |
| **Source** | None. The IG User edge list has no highlights edge; the stories edge returns only the last 24 h of stories |
| **Supported / permitted** | **No.** The only known route is a third-party backend that proxies Instagram's **undocumented** web/app endpoints with a shared secret — a route this project forbids (invariant 3, D3). The project's own reverse-engineering of that reference (`re/anonstories/api-evidence.json`) documents exactly this: the highlights it renders come from `/api/v1/highlights` on a third-party host, not from Meta's API, and its upstream is an undocumented Instagram endpoint. |
| **Implementation** | Declared unavailable with the reason and the unlock path |
| **Tests** | `packages/database/test/capability-consistency.test.ts`, `packages/core/test/capability.test.ts` |

The same evidence shows the other end of the trade: that reference's data is
**less** precise than the official route — `taken_at` arrives as a relative
string ("23 days") and its media is re-served through the third party's own
host. The official API gives a timestamp and the platform's own bytes.

### 2.11 Account type and verification state

| | |
|---|---|
| **Fields sought** | The account's type (business / creator) and its verification state |
| **Source** | The Graph API **does not expose** these on the IG User node |
| **Implementation** | The fields stay **absent**, never inferred. `is_verified` is null until an observation says otherwise; `account_type` is null because no documented field supplies it |
| **Tests** | `packages/ingestion/test/field-coverage.test.ts` — the field-coverage audit pins every requested field name against the Meta reference |

### 2.12 Account insights (own account)

| | |
|---|---|
| **Fields sought** | `follower_count` and `reach` (time series), `accounts_engaged`, `total_interactions` and `views` (total value), `follower_demographics` — the names are the platform's, split by the documented `metric_type` so a mismatched request cannot silently become an empty set |
| **Source** | The documented IG User insights edge |
| **Supported / permitted** | Yes — the owned account |
| **Implementation** | Implemented — `getAccountInsights` |
| **Freshness / provenance** | A metric the platform does not return is an **absence with a reason** (the documented rules: below 100 followers, 48 h demographic delay, empty data set), never a zero and never a fabricated point |
| **Tests** | `workers/monitoring/test/insights-scan.test.ts` |

---

## 3. What an investigation does with each source

`igtrack investigate <username>` runs the stages below in order. Each is
reported separately, with what it retrieved and why it stopped.

| Stage | What it does | When it is blocked |
|---|---|---|
| IDENTITY | Normalizes the reference; resolves the account through the permitted sources. The **platform id** is the identity, so two similar names are never merged — an id already bound to another username stops the investigation. | The source does not observe the account and the documented discovery route cannot reach it. |
| PLATFORM | Queues and executes every scan the source can answer, and reports the ones it refused and why. | The source does not observe the account (the worker refuses the scan; the queue is never given it). |
| CONTENT | Reads the accessible content back with its provenance: posts, captions, comments, mentions, tagged media. | Nothing was recorded. |
| RELATIONSHIPS | Ranks the accounts this one is observed to interact with — live and synthetic **apart**. | No interaction was observed. |
| WEB | Searches and fetches public pages, extracts structured facts, files the ones that survive the registry and the attribution gate. | No search provider is configured, or the pages could not be read. |
| CORRELATE | Derives themes, cadence and contradictions across the classes, stating the corpus each derivation came from. | — |
| DOSSIER | Assembles the report: the stages, the evidence classes, the coverage, the gaps and the next steps. | — |

**Exit codes.** 0 — a dossier was produced and something was retrieved. 2 —
usage or an invalid reference. 3 — the configuration is blocked. 4 — a dossier
was produced and **nothing** was retrieved. 4 is not a failure: it says the
investigation found nothing, which is a different claim from "the report
failed".

---

## 4. What is NOT VERIFIED

- **No live Instagram Graph API call has been made in this environment.** The
  credentials in `.env` are the example placeholders, the provider refuses to
  construct against them, and the report says `PLACEHOLDER` with the fix —
  never a value. Every Graph-shaped row in the test suite is a fixture, and
  is labelled as one.
- **The public-web path IS verified live**: the search index answers, pages
  are fetched through the real gate, and facts are extracted with their
  citations (`scripts/bench-search.ts` measures it).
- The import path is verified against a real export **format** (the packaged
  sample), not against a live download.

A passing fixture test is **not** proof of live access, and this document
never claims otherwise.

---

## 5. The refusals, and why they are refusals

These are not gaps in the implementation. They are the platform's shape, and
they are recorded as `whyUnavailable` in the capability registry
(`packages/core/src/capabilities.ts`) so no surface can quietly over-claim:

| Refused | Why |
|---|---|
| Liker lists | No liker edge exists on any supported interface. |
| Interaction history | No provider exposes it; `LIKE_SIGNAL` in the model describes a shape, not a collector. |
| Who reposted | No repost object or reshare edge exists in the platform reference. |
| Highlights | No highlights edge exists; the only known route is an undocumented private endpoint, which this project forbids. |
| Media bytes | The Graph media URLs are expiring; the fixture set carries none. There is no archivable source. |
| Other accounts' rosters | The follower/following lists exist only for the account the deployment owns. |
| Sensitive person-level facts | The claims registry refuses employment, health, religion, politics, sexuality, ethnicity, legal, residence, education, marital and relationship predicates **from every source**, with the reason. |
| Instagram-hosted pages over the web | Platform data has one lawful route: the Graph provider. |

Changing a refusal is a founding decision and needs a dated entry in
[FOUNDING.md](FOUNDING.md) — see §14.1/§14.2 there and AGENTS.md's binding
refusal list.

---

## 6. How this matrix was verified

- **Against the code**, not against a plan: every row names the file that
  implements it, and the request shapes were read from the provider modules
  rather than from memory.
- **Against the project's own reverse-engineering** of the reference client
  (`re/anonstories/api-evidence.json`, REA-captured bundle analysis plus a
  live browser capture). It confirmed two things independently:
  Meta's documented stories read exposes **no** story-mention field, and the
  highlights and per-story mention arrays a real client renders come from a
  third-party backend proxying **undocumented** endpoints — which is why this
  project refuses them.
  It also corrected one row of this document during drafting: story mentions
  are fixture-only here, not a platform capability, and the matrix now says
  so.
- **Against the live public-web path**: `scripts/bench-search.ts` measures the
  real pipeline over the real index, with a positive control, so a zero in a
  report can be read as "the index does not have it" rather than "the engine
  is broken".
- **Against the tests**: each row names the suite that pins it. A row without
  a test is a claim, not a fact.

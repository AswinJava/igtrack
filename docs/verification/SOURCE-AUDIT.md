# Source audit — lawful acquisition paths for an arbitrary username (2026-10-18)

## Method and limits of this audit

This is open-web **documentation research**, performed on 2026-10-18. Every claim below
carries the URL it was read from; all URLs were fetched on 2026-10-18 unless a capture
date is stated (Wayback). **No live API call to any Instagram/Meta endpoint was made**,
so runtime behaviours (actual pagination caps, actual field sets, tokenless oEmbed in
practice) are marked `NOT_VERIFIED` where docs alone could not settle them. The
websearch integration was unavailable during this audit; sources were reached by direct
fetch of official documentation, the Wayback Machine, DuckDuckGo HTML results, and the
GitHub API. GitHub projects listed in §6 are **implementation references, not
permission**: their existence says nothing about what IGTrack may lawfully do. Where a
project uses cookies, session auth, or undocumented endpoints, that is stated explicitly
and the technique is classified **refused** under invariant 3
(`docs/FOUNDING.md` §14).

---

## 1. Instagram Graph API — Business Discovery

Official edge reference (fetched 2026-10-18):
<https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery>
IG User node reference:
<https://developers.facebook.com/docs/instagram-api/reference/ig-user>

| Question | Documented answer |
|---|---|
| Still exists in current API versions? | **Yes.** Documented at current versions (docs examples use `v25.0`; current Graph reference shows `v26.0`). No deprecation entry for Business Discovery appears in the Instagram Platform changelog through its June 22, 2026 entry (<https://developers.facebook.com/docs/instagram-platform/changelog>, fetched 2026-10-18). |
| Query shape | `GET /<IG_USER_ID>?fields=business_discovery.username(<USERNAME>)`, performed **on the querying professional IG user**, targeting the other account by username. |
| Which login route | "Available for the Instagram API with Facebook Login" (edge page). The Instagram-API-with-Instagram-Login variant is not listed for this edge. |
| Permissions | `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement`; plus `ads_management` **or** `ads_read` if the token's Page role was granted via Business Manager (edge page). |
| Target account requirements | Target must be an **Instagram Business or Creator account** (IG User reference: the node "Represents an Instagram Business Account or an Instagram Creator Account"). Creator targets were added 2019-08-13 (changelog). |
| Refusals | "Data about age-gated Instagram Business IG Users will not be returned" (edge page). Consumer/private accounts are not addressable as Business/Creator nodes (structural, per node reference). |
| Profile fields available via field expansion | Fields marked **Public** on the IG User reference: `alt_text`, `biography`, `followers_count`, `media_count`, `username`, `website` (+ `id`, `name`, `profile_picture_url`, `follows_count` are listed but only some are marked public; per-field availability via BD should be verified empirically — `NOT_VERIFIED`). |
| Per-media metrics via BD | Sample on the edge page returns `comments_count`, `like_count`, `view_count` per media. `view_count` via BD was added for Reels on 2025-06-16; from 2026-04-22 it returns combined Instagram+Facebook views for crossposted video (changelog). |
| Media edge pagination | Current docs: the `/media` edge "supports cursor-based pagination", but when accessed **via field expansion** the response "will not include `previous` or `next` fields, so you will have to use the `before` and `after` cursors to construct `previous` and `next` query strings manually" (edge page). |
| The "12-media cap" | The often-cited "first ~12 media only, non-pageable" behaviour is **NOT_VERIFIED** against the current docs, which instead describe manual cursor construction (above). IGTrack must verify empirically whether BD field-expansion paging actually pages and where it stops; until then the capability registry should record BD media as *bounded* with an explicit reason. |
| Rate limits | Business Discovery is subject to **Platform Rate Limits**, not the Instagram BUC limit: app-level `Calls within one hour = 200 * Number of Users` on a rolling hour; per-user call counts are undisclosed (<https://developers.facebook.com/docs/graph-api/overview/rate-limiting>, "Instagram Platform" notes). |

## 2. Instagram oEmbed

Guide (fetched 2026-10-18): <https://developers.facebook.com/docs/instagram/oembed>
Reference (`v26.0`): <https://developers.facebook.com/docs/graph-api/reference/instagram-oembed>
Changelog entries: 2025-04-08 and 2026-05-15 (Instagram Platform changelog, URL above).

| Question | Documented answer |
|---|---|
| Endpoint | `GET /instagram_oembed` on `graph.facebook.com`; `url` parameter required. |
| Returns (current) | `html`, `provider_name`, `provider_url`, `type`, `version`, `width` (reference, v26.0). |
| Thumbnail/author fields | **Removed.** `author_name`, `author_url`, `thumbnail_url`, `thumbnail_width`, `thumbnail_height` were removed from Instagram post oEmbed responses effective **2025-11-03** (changelog 2025-04-08). Any plan premised on oEmbed returning "thumbnail + author name" is outdated. |
| Access token | **Not required since 2026-05-15**: "You can now call Instagram oEmbed API without an access token" (changelog 2026-05-15). The former oEmbed Read feature was replaced by "Meta oEmbed Read" (2025-04-08; old feature deprecated 2025-11-03). |
| Can it resolve a username? | The `url` parameter accepts `https://www.instagram.com/{username}` as a documented URL format (guide). So yes, a profile URL can be submitted — but see the purpose limit below. |
| Rate limit | 1,000 requests/hour (guide). |
| Refusals | Private, inactive, and age-restricted accounts; accounts with Embeds disabled; Stories (guide). |
| **Purpose limitation (decisive)** | The guide states the endpoint "is not to be used for any other purpose. **Using metadata and page, post, or video content (or their derivations) from the endpoint for any purpose other than providing a front-end view of the page, post, or video is strictly prohibited.** This prohibition encompasses consuming, manipulating, extracting, or persisting the metadata and content, including but not limited to deriving information about pages, posts, and videos from the metadata for analytics purposes." |

**Verdict for IGTrack:** even though it is an official, now-tokenless endpoint, its
contract restricts use to front-end embedding and explicitly forbids analytics-style
derivation. IGTrack's observation use case falls inside that prohibition → **refused
for IGTrack purposes**. This is a terms boundary, not a technical one.

## 3. Instagram Basic Display API — status

| Question | Documented answer |
|---|---|
| Status | **Deprecated and non-functional.** Announced 2024-09-04 (<https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/>); "Starting December 4th, 2024, Instagram Basic Display API will no longer be available… all Instagram Basic Display API requests will fail" (blog). Confirmed by the changelog entry of 2024-12-04 and by the archived docs page (Wayback capture 2025-01-05: <https://web.archive.org/web/20250105163654/https://developers.facebook.com/docs/instagram-basic-display-api/>). The live docs URL now returns HTTP 404 (checked 2026-10-18). |
| What it allowed | The deprecation blog describes it as being "used to connect Instagram accounts to third-party consumer apps (via sharing Profile, Images etc)" — i.e. the **authorized user's own account** via OAuth. "After December 4th, 2024, there will no longer be a set of Instagram APIs for consumer developer apps" (blog). That it never supported third-party username lookup follows from that own-account framing; a primary doc stating "no third-party lookup" verbatim was not located → that specific phrasing is `NOT_VERIFIED`, but the API's total shutdown makes the question moot. |

## 4. Rate limits and permission reality for an individual self-hosted operator

Sources (all fetched 2026-10-18):
- Access levels: <https://developers.facebook.com/docs/graph-api/overview/access-levels>
- Permissions reference: <https://developers.facebook.com/docs/permissions/reference/instagram_basic>
- Rate limits: <https://developers.facebook.com/docs/graph-api/overview/rate-limiting>

Documented facts:

- **Standard Access is automatic** for all permissions/features of an app's type, and is
  usable **only by app-role users** (admin/developer/tester). **Advanced Access** (usable
  by any app user) requires per-permission **App Review** and, since 2023-02-01, **Business
  Verification** (access-levels page).
- `instagram_basic` App Review requires a use-case description plus screencasts
  demonstrating the full login flow (permissions reference table). Meta states App Review
  is required "for apps that needs access to data that you do not own or manage".
- Permissions unused for 90 days must be regranted by the app user (permissions reference).
- Advanced-access apps must complete an annual **Data Use Checkup** (access-levels page).
- Instagram Platform (non-messaging, non-BD) calls use BUC limits
  `Calls within 24 hours = 4800 * Number of Impressions` with a floor of 10 impressions;
  **Business Discovery uses the 200 × users/hour Platform limit** instead (rate-limits page).

**Feasibility conclusion (mechanism documented, runtime `NOT_VERIFIED`):** a single
operator does **not** need App Review to use Business Discovery on their own behalf:
they can create their own Meta app, connect their own Instagram professional account
linked to a Facebook Page, hold a role on the app, and use Standard-Access permissions
as an app-role user. What they cannot avoid is: (a) a Facebook Page + linked
professional account for the Facebook-Login route, (b) the 200-calls/hour app ceiling,
(c) token expiry/renewal hygiene, and (d) App Review + Business Verification the moment
the tool is distributed so *other* people's tokens work. IGTrack should treat the
Graph provider as **operator-provisioned and optional**, never assumed present.

## 5. Lawful public-web sources (no instagram.com scraping)

All fetched 2026-10-18.

| Source | What it is | Pricing / key | Terms-relevant notes | Status |
|---|---|---|---|---|
| **Brave Search API** (<https://brave.com/search/api/>) | Official commercial web-search API with its own crawl index (vendor states zero Google/Bing dependency). | Search plan **$5 per 1,000 requests**, prepaid credits, **$5 free credits/month**, 50 qps; API key from Brave's dashboard. | Published vendor docs/ToS; Brave markets itself as the surviving official API after Bing's retirement and Google's closure. Whether derived results may be persisted/analyzed: `NOT_VERIFIED` (FAQ exists but answer text not captured). | Active; strongest general-web option found. |
| **Google Programmable Search / Custom Search JSON API** (<https://developers.google.com/custom-search/v1/overview>) | Official Google API over a configured Programmable Search Engine. | 100 free queries/day; $5 per 1,000 up to 10k/day — **for existing customers only**. | Page states: "**closed to new customers**"; existing customers "have until **January 1, 2027** to transition to an alternative solution." | **Closing 2027-01-01; not available to new users.** |
| **Bing Web Search API** (<https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/>) | Was Microsoft's official web-search API. | — | Microsoft Learn page is archived: front-matter shows `is_retired: true`, `is_archived: true`, relocated under `/previous-versions/`. Corroborated by Brave's public statement "Microsoft retired the Bing Search APIs" (Brave page above). Exact retirement date `NOT_VERIFIED`. | **Retired.** |
| **SerpApi** (<https://serpapi.com/pricing>) | Commercial SERP API. Pricing verified: free 250 searches/mo; Starter $25/mo = 1,000; Production $150/mo adds "U.S. Legal Shield… up to $2 million in coverage for the scraping and parsing of search engine data". | API key; month-to-month. | SerpApi obtains data by accessing third-party sites **on the customer's behalf**. For *general web search* it is a lawful commercial API; for its Instagram-specific engines (details `NOT_VERIFIED` — docs pages 404'd) it would be a **proxy for scraping instagram.com**, which invariant 3 refuses (cf. the "no proxy re-serving" clause). | Active. Use class split: general search = candidate; Instagram engines = refused. |
| **Wikipedia / Wikidata APIs** (<https://www.wikidata.org/w/api.php>, <https://www.mediawiki.org/wiki/API:Main_page>) | Public MediaWiki/Wikidata web APIs. Verified live: keyless `wbsearchentities&search=Instagram` returned `Q209330` (2026-10-18). | None (no key). | Public, documented, keyless. **Low yield**: only notable accounts have articles/items, and coverage is not per-post or per-metric. | Active; suitable only as a corroborating source for notable subjects. |
| **Instagram oEmbed-derived data** | See §2. | None since 2026-05-15. | **Purpose-limited to embedding; analytics derivation prohibited.** Refused for IGTrack. | Active but contractually out of scope. |

## 6. Open-source Instagram / OSINT projects — reference only, techniques refused

Repository metadata via GitHub API on 2026-10-18. **None of these techniques may be
copied into IGTrack.** Stars/activity are context, not endorsement.

| Project | What it does technically | Cookie/session or undocumented endpoints? | Maintenance | Stars |
|---|---|---|---|---|
| [instaloader/instaloader](https://github.com/instaloader/instaloader) | Downloads "public and private profiles, hashtags, user stories, feeds and saved media… comments, geotags and captions" (README). Talks to instagram.com directly, not the official Graph API; private content requires a logged-in session. | **Yes** — unofficial instagram.com access; login session for anything beyond the most public anonymous data. **Technique refused.** | Active (last push 2026-10-14); MIT. | 13,609 |
| [dilame/instagram-private-api](https://github.com/dilame/instagram-private-api) | "NodeJS Instagram private API client" — emulates Instagram's Android/Web mobile APIs, realtime/DM support; next major version is paid/private-repo. | **Yes** — private, undocumented API with account session auth. **Refused.** | Stale (last push 2024-08-09); MIT. | 6,484 |
| [subzeroid/instagrapi](https://github.com/subzeroid/instagrapi) | "Python library for Instagram Private API 2026 with HikerAPI SaaS". | **Yes** — private API + session. **Refused.** | Active (2026-10-17). | 6,982 |
| [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock) | Finds accounts by username "across 400+ social networks" by HTTP-requesting each site's profile URL for existence. | The Instagram leg requests instagram.com profile URLs — **scraping class; refused for Instagram**. | Very active (2026-10-18); MIT. | 94,410 |
| [soxoj/maigret](https://github.com/soxoj/maigret) | "Collect a dossier on a person by username from 6,000+ websites" — same URL-probing technique as Sherlock, plus parsed site tags. | Same class; Instagram probing refused. | Active (2026-10-18); MIT. | 39,190 |
| [qeeqbox/social-analyzer](https://github.com/qeeqbox/social-analyzer) | API/CLI/web app analysing profiles across 1,000+ sites with detection modules. | Same class (site-by-site HTTP probing). Note **AGPL-3.0** — reuse would also be a licensing hazard. | Last push 2026-01-12. | 24,327 |
| "LibInsta" | Not found: GitHub repository search for `LibInsta` returned no relevant project (2026-10-18). | — | — | `NOT_VERIFIED` (cannot confirm it exists) |

**Documented legal risk (cited, factual):**

- **Meta v. Voyager Labs.** Meta announced the suit 2023-01 (<https://about.fb.com/news/2023/01/leading-the-fight-against-scraping-for-hire/>): Voyager "created fake accounts and scrap[ed] user data" for law-enforcement surveillance software. Meta alleged >38,000 fake accounts; a federal judge allowed the suit to proceed (May 2024 MTD order, <https://www.courthousenews.com/wp-content/uploads/2024/05/meta-platforms-v-voyager-labs-order-mtd.pdf>); the case later **settled** with Voyager agreeing to refrain from scraping Meta platforms (Mediapost, <https://www.mediapost.com/publications/article/401661/analytics-company-voyager-labs-settles-scraping-ba.html>).
- **Meta v. Bright Data.** Meta sued Bright Data 2023-01 for harvesting/selling Facebook+Instagram data; in January 2024 a federal judge **denied Meta summary judgment on its contract-breach claim** — Bright Data won that round (Wikipedia summary with primary press citations: <https://en.wikipedia.org/wiki/Bright_Data>, "Litigation"; TechCrunch: <https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued/>). Bright Data separately lost to X Corp on similar facts in May 2024 (Reuters via same page). **Read-across:** even a *win* on a contract theory is specific to heavily-resourced scraping vendors; it does not make scraping lawful in general, nor safe for a self-hosted tool, and it does not touch Meta's contractual restrictions. Meta's own scraping terms page is login-gated and could not be read (`NOT_VERIFIED` content): <https://www.facebook.com/apps/site_scraping_tos_terms.php>.
- **Operational risk:** automated client libraries routinely trigger Instagram checkpoints and account bans (widely reported; `NOT_VERIFIED` here against a primary source — recorded as a known community hazard, one more reason invariant 3 exists).

## 7. MCP servers for Instagram

Searched GitHub (`instagram mcp`, `instagram-mcp in:name`, sorted by stars, 2026-10-18).

| Server | What it actually does | Lawful under invariant 3? |
|---|---|---|
| **Meta's own MCP presence** | Meta documents an `ads_mcp_management` permission for "the Meta ads Model Context Protocol (MCP) server" (permissions reference, §I table) — an official MCP, but for **ads management**, not Instagram organic data. No official Meta MCP for Instagram profile/media reads was found. | Official but out of scope (ads, not observation). |
| [jlbadano/ig-mcp](https://github.com/jlbadano/ig-mcp) (197★) | Wraps the **Instagram Graph API** with the operator's own Business account: profile info, media, insights, publishing, DMs with Advanced Access. README lists exactly the documented permissions (`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, …). | **Yes** — a lawful wrapper; useful as a reference for token/permission handling. |
| [pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp) (1,313★) | Meta Ads API MCP (Meta Business Partner). Ads data, not IG organic observation. | Lawful but out of scope. |
| [HasData/instagram-mcp](https://github.com/HasData/instagram-mcp) (16★) | Hosted MCP: "Look up a public profile by handle, and walk its public post feed… **It does not act as an account. There is nothing to connect**" (README) — i.e. it is **not** the official API; it re-serves scraped public-profile data from a commercial data vendor. | **No** — proxy-scraping of instagram.com; refused (same category as SerpApi's Instagram engines). |
| [Bob-lance/instagram-engagement-mcp](https://github.com/Bob-lance/instagram-engagement-mcp) (46★) | Engagement/lead analysis; setup says "add your Instagram credentials" to `.env` — consistent with unofficial session/credential-based access (exact mechanism `NOT_VERIFIED`). | **No** (unofficial access; do not copy). |
| [trypeggy/instagram_dm_mcp](https://github.com/trypeggy/instagram_dm_mcp) (186★) | Instagram DM access via MCP; DMs are not exposed to third parties by any official API, so the mechanism must be unofficial (private-API class, `NOT_VERIFIED` in detail). | **No** (do not copy). |

**Pattern:** the popular Instagram MCP servers either wrap the operator's own Graph API
account (lawful) or proxy private-API/scraping infrastructure (refused). There is no
lawful MCP route to arbitrary third-party data beyond what Business Discovery itself
gives (§1).

---

## 8. Verdict table

Legend — Lawful: **Y** = inside invariant 3; **N** = refused; **L** = lawful but low-yield.
`NOT_VERIFIED` = documented here but not confirmed by a live call.

| Candidate source | Profile fields | Media list | Counts | Comments | Likers | Followers list | Highlights | Auth needed | Target creds needed | Lawful (inv. 3) | Status | How IGTrack verifies |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Graph API Business Discovery** | Yes (public fields, §1) | Bounded (media edge via field expansion; paging `NOT_VERIFIED`) | Yes (`followers_count`, `media_count`, per-media `like_count`/`comments_count`/`view_count`) | Only aggregate `comments_count` on media; **no comment bodies for other accounts** | **No** | **No** (count only; no roster edge for other accounts) | **No** | Operator's FB user token + `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` (± `ads_read`/`ads_management`) | No — but operator must own a linked professional account to query *from* | **Y** | Docs current through 2026-06-22 changelog | Provider conformance test against a fixture + one operator-run live probe; record paging cap empirically |
| **Instagram oEmbed** | No (author/thumbnail fields removed 2025-11-03) | No | No | No | No | No | No | None since 2026-05-15 | No | **N** — terms forbid analytics/derivation; embedding-only | Active | Do not implement; cite §2 |
| **Basic Display API** | — | — | — | — | — | — | — | — | — | **N/A** | Dead since 2024-12-04 | None needed |
| **Brave Search API** | Indirect (search snippets only) | No | No | No | No | No | No | Paid API key | No | **Y** (general web search) | Active | Optional provider; verify snippet provenance in tests |
| **Google CSE JSON API** | No | No | No | No | No | No | No | API key | No | Y, but unusable for new adopters | Closed to new customers; dies 2027-01-01 | Exclude from default path |
| **Bing Web Search API** | — | — | — | — | — | — | — | — | — | Y in principle | **Retired** | Exclude |
| **SerpApi (general web)** | No | No | No | No | No | No | No | Paid key | No | Y for general search | Active | Optional; same treatment as Brave |
| **SerpApi (Instagram engines)** | (re-served scrape) | — | — | — | — | — | — | Paid key | No | **N** — proxy re-serving of instagram.com | Engine docs `NOT_VERIFIED` | Do not implement |
| **Wikidata/Wikipedia** | Sparse (notables only) | No | No | No | No | No | No | None | No | **Y** | Active (live-verified) | Optional corroboration source |
| **instaloader / instagrapi / instagram-private-api** | Yes (via scraping) | Yes | Yes | Yes | Partial | Yes (own account only) | — | Instagram session cookies | Effectively yes (session) | **N** — undocumented endpoints + session auth | Active except instagram-private-api | Reference only; never wire in |
| **sherlock / maigret / social-analyzer** | Existence check | No | No | No | No | No | No | None | No | **N** for the Instagram leg (requests instagram.com) | Active | Reference only |
| **MCP: ig-mcp (Graph wrapper)** | Same as BD | Same as BD | Same as BD | — | — | — | — | Operator token | No | **Y** | Active | Optional reference for token handling |
| **MCP: HasData / Bob-lance / DM MCPs** | (re-served scrape) | — | — | — | — | — | — | Vendor key / IG creds | No | **N** | Active | Do not use |

("Indirect" = via third-party pages mentioning the account, never as an
authoritative claim — provenance rules still apply.)

### Bottom line

1. **Business Discovery is the only lawful route to an arbitrary third-party public
   username**, and it is narrower than folklore suggests: professional accounts only,
   age-gated refused, counts + bounded media + per-media public metrics, no comment
   bodies, no likers, no follower rosters, no highlights, ~200 calls/hour app ceiling.
2. **oEmbed is officially reachable but contractually refused** for IGTrack's purpose,
   and no longer returns author/thumbnail fields anyway.
3. **Basic Display is dead** (2024-12-04); no consumer-API third-party lookup exists.
4. **Google CSE is closing (2027-01-01) and Bing is retired**; Brave Search API and
   (for general web only) SerpApi are the surviving commercial search options.
5. **Every popular "Instagram OSINT" library and many Instagram MCP servers use
   session auth or undocumented endpoints** — reference material only, techniques
   refused; the litigation record (Voyager settlement, Bright Data suit) shows Meta
   pursues scraping-for-hire even where outcomes are mixed.

---

## 9. Addendum (2026-10-19) — the keyless general-web search landscape

The 2026-10-18 audit left one gap in practice: Brave is healthy but **keyed**, so a
fresh installation (no account, no key) still could not run a single real search, and
the public-web phase answered `NOT_ATTEMPTED` for every handle. This addendum audits
the **keyless** general-web search landscape. Every candidate below was checked against
its own documentation on 2026-10-19, and where a live probe was decisive it is marked
`(live)`. No Instagram endpoint was involved in any probe.

| Candidate | What it offers keyless | Decisive finding | Verdict |
|---|---|---|---|
| **DuckDuckGo** instant-answer API (`api.duckduckgo.com/?q=…&format=json`) | Keyless JSON instant answers. | Documented, but instant answers only — no ranked web results; the HTML endpoint that returns a SERP is **undocumented** (invariant 3: no undocumented endpoints). | Excluded. Instant answers cannot supply candidate pages. |
| **Mojeek search API** (`api.mojeek.com`) | Was keyless with rate limits. | Now requires an API key: keyless requests return **HTTP 403** (live). | Excluded — keyed, and a newer entrant than Brave in this codebase's audit; not adopted. |
| **SearXNG** (self-hosted metasearch) | Keyless if self-hosted. | Aggregates upstream engines whose terms forbid automated access; running it moves the scraping one hop back (boundary 8: no proxy re-serving). | Excluded on the same principle as SerpApi's Instagram engines. |
| **GDELT** (`api.gdeltproject.org/api/v2/doc/doc`) | Keyless, documented news API. | News-only corpus — not general web search; no organic-result coverage for an arbitrary handle's pages. | Excluded — wrong corpus. |
| **Qwant / Marginalia / Brave Answer Engine / You.com / Perplexity** | Various. | Qwant's public API is keyed/deprecated for third parties; Marginalia is a niche non-commercial index with no general-web coverage; the rest are LLM answer products (inference-as-evidence is refused by §18.2) or keyed. | Excluded. |
| **Google Programmable Search / Bing Web Search** | — | Closed to new customers / retired (§5, unchanged). | Excluded (unchanged). |
| **FreeSerp** (`https://freeserp.ai/api.php`) | **Documented, first-party JSON API over its own crawl index**: `index=web`, `q`, `size`, `agent`/`project` identifiers; response `{ ok, results: [{ url, title, snippet }], engine_fallback? }`; error statuses 400 (`query_required`), 429 (rate limit), 502 (upstream); rate guidance "a few requests/second, identify yourself". No account, no key, no per-request meter, no telemetry beyond the `agent` string. Docs fetched 2026-10-19: <https://freeserp.ai/docs>. | Verified live (2026-10-19): keyless queries returned real ranked results with URLs, titles and snippets (`ok: true`); the documented error statuses match the implementation's handling. The index is **its own crawl**, not a re-served scrape of another engine's SERP — the distinction that excludes SearXNG/SerpApi-Instagram does not apply. | **Adopted as the keyless leg of `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto`** (FOUNDING §19, D73). Unmetered, so invariant 10 holds; Brave remains the keyed leg for deployments that hold a key. Caveat carried into the product: a `engine_fallback: true` response is surfaced as a `note` — results served from the vendor's narrower sites index are reported as possibly incomplete coverage, never as full-web results. |

**What this addendum does not change:** search results are *candidate URLs only*
(FOUNDING §19, D69/D70). Nothing is stored from a search hit; each URL still passes the
SSRF gate, robots check, content-type allowlist, byte cap and extractor, and a
retrieved page contributes a fact about a handle only if the page itself names the
handle (the relevance gate, D73). A keyless provider widens *reachability*, never
*epistemic status*.

---

## 10. Search-provider benchmark (D74) — measured 2026-10-19

Live, bounded runs of the **real audit pipeline** through `scripts/bench-search.ts`
(`opAuditWebProbe`, ≤4 queries × 5 documents — the identical path `igtrack audit`
runs). Saved measurements, deliberately separate from the mocked regression tests
that pin field mapping and error handling. FreeSerp (the keyless default) on this
date:

| Handle | Queries | Results | Unique candidates | Dedup removed | Fetched | Pages naming handle | Facts | Outcome |
|---|---|---|---|---|---|---|---|---|
| `sel_win_` (tokenizer stress: trailing `_`) | 4 | 20 | 15 | 25% | 4 (1 `TIMEOUT`) | 0 | 0 | `PAGES_IRRELEVANT` |
| `nasa` (control, real web presence) | 4 | 20 | 15 | 25% | 4 (1 `TIMEOUT`) | 4 | 41 | `EVIDENCE_EXTRACTED` |

What the benchmark proves — and what it does not:

- **The pipeline is honest in both directions.** The same extractor returned 41
  registry-accepted facts for the control handle and exactly **0** for the stress
  handle — reported as a coverage-limited zero with per-candidate dispositions and
  a weak-coverage next step, never as "no public evidence exists". A zero from one
  index is not a verdict.
- **FreeSerp's query language is shallow** (direct probes, same date): quoted
  phrases are ignored (`site:instagram.com "sel_win_"` → 0; all quoted variants →
  token-overlap junk such as "SEL Wins"/"sel wine"), `sel_win_` is tokenized into
  `sel` + `win`, and `site:` **is** honored. This is why the query strategy (D74)
  asks four *distinct* query forms and why exact-handle relevance is enforced
  **post-retrieval on the fetched page** (D73 gate), which a loose tokenizer
  cannot game.
- **Brave (keyed) is NOT MEASURED** — no `IGTRACK_RESEARCH_SEARCH_API_KEY` in this
  environment; the script prints that as a row rather than a number. Run
  `pnpm exec tsx scripts/bench-search.ts <handle…>` with the key set to fill it.
  Until then Brave's live numbers are an open item, pinned only by
  mocked-transport tests — the benchmark must not be read as Brave-vs-FreeSerp
  quality until both rows are measured.

The benchmark is live by design (network calls) and is therefore **never part of
`pnpm test`**; the regression suite exercises the same code path against a mocked
transport with fixed expectations.

## 11. Phase 3 (2026-10-19) - second-source evaluation and the audit-quality benchmark

Two questions, measured separately: *is there a second lawful source we are
missing?* and *does the pipeline's own evidence hold up when it runs against
the real web?*

### 11.1 Candidate sources evaluated in Phase 3 (probes run 2026-10-19)

| Source | Route probed | Probe evidence | Verdict |
|---|---|---|---|
| **Wikidata** | keyless `wbsearchentities` API (documented) | `sel_win_` → **0 entities**; `nasa` → first hit **Q309751** (plant genus, label-equals-handle) ahead of Q23548 (whose `P856` is nasa.gov) | **Rejected as a candidate source.** For a handle probe the API answers with *label-token* matches, and a homonym whose label equals the handle ranks first: an entity-selection ambiguity that can confidently bind a handle to the wrong entity. A wrong-entity answer is worse than an honest UNAVAILABLE. |
| **Hacker News (Algolia)** | keyless documented search API, HTTP 200 | 0 hits for `sel_win_` | **Rejected.** Zero coverage for the handle class this product is for; a second index that answers nothing only widens the "we searched N indexes" line without moving evidence. |
| **GitHub code search** | documented REST endpoint | HTTP **401** (auth required) | **Rejected.** No keyless path (invariant 10: no credential in the default path). |
| **Reddit** | documented endpoint | HTTP **403** (OAuth only) | **Rejected.** Auth required; also a platform whose ToS forbids unauthenticated data access. |
| **Operator `--url`** | already shipped (D70) | -- | **Retained:** the operator naming a page is the lawful, human-asserted route. |
| **Meta Business Discovery** | already shipped, gated `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` (§1) | -- | **Retained:** the only lawful platform route, opt-in. |
| **Brave Search API** | keyed (D73) | no `IGTRACK_RESEARCH_SEARCH_API_KEY` anywhere in this environment | **Framework only - NOT MEASURED.** The benchmark prints the absence rather than a number; both layers run it the moment a key exists. |

Net result: **no second keyless index was adopted.** The rejections above are
evidence, not preference - each carries the response that decided it.

### 11.2 Audit-quality benchmark (`scripts/bench-audit.ts`, `apps/cli/src/bench.ts`)

Seven-case evaluation set, one per category the mission names, with ground
truth verified **independently of the pipeline** (direct HTTP fetches dated
2026-10-19: nasa.gov 200/`og:site_name NASA`, github.com/about 200/`github`
x547, natgeo.com 200/`og:site_name National Geographic`, Wikidata entity lookups)
and kept strictly separate from expectations, which are honest guesses the run
may falsify:

| Case | Category | Expectation |
|---|---|---|
| `nasa` | ORG_LARGE_FOOTPRINT | REQUIRE_EVIDENCE |
| `natgeo` | ORG_EXTERNAL_REFERENCES | REQUIRE_EVIDENCE |
| `github` | SHORT_OR_AMBIGUOUS (control: short but unambiguous) | REQUIRE_EVIDENCE |
| `sel_win_` | HARD_TO_SEARCH (underscore tokenization) | REVIEW |
| `rgb` | SHORT_OR_AMBIGUOUS (three letters, huge unrelated footprint) | REVIEW |
| `nasaa` | NEGATIVE_NEAR_MISS (one char off `nasa`) | REVIEW - *corrected*, see below |
| `zqwxplm2026` | NEGATIVE_NONEXISTENT (plausible fake) | FORBID_EVIDENCE |

Measured, live, before the corrections (freeserp, same day):

| Case | Facts | Support | Headline defect |
|---|---|---|---|
| `nasa` | 41 | 100% | 71% duplicate statements; ground-truth homepage never fetched (subpage was) |
| `natgeo` | 24 | **79%** | **6 facts named the wrong entity** (wersm/detik/wtxl publishers); 3 share-button URLs stored as profile claims; 5 "unsupported" facts were escaping asymmetries in the checker, not missing evidence |
| `github` | 333 | 100% | 77% duplicates across github.com's own pages |
| `sel_win_` | 0 | n/a | honest zero (`PAGES_IRRELEVANT`) - correct |
| `rgb` | 22 | 86% | 22 ambiguous facts read as statements about an Instagram account, incl. `sRGB` pages matching `rgb` by inner substring |
| `nasaa` | 6 | 100% | **FORBID expectation breached** - ground truth was wrong |
| `zqwxplm2026` | 0 | n/a | honest zero (expectation MET) - correct |

Every defect above was traced to its page before anything was changed; each fix
is the fix for the traced root cause:

1. **Self-identification (search-found pages only).** A stored statement must
   literally involve the handle - its value names it, or the page's own host
   does. A third-party article about `@natgeo` also describes its *source*
   (og:site_name `WeRSM`, the publisher's social links, its contact address);
   those are now counted per document (`unattributed`) with an explaining note,
   never attributed. Operator `--url` pages bypass this exactly as they bypass
   the mention gate: the operator asserted relevance.
2. **Delimiter-aware handle matching** (`handleMentioned`): the handle must be
   a delimited token - letters/digits/underscore on either side disqualify the
   match (`nasaa` inside `nasaa_research`, `rgb` inside `sRGB`, `nasa` inside
   `nasal`). Deliberate residual, documented in the function: periods stay
   delimiters so `nasa.gov` keeps matching, which means a longer dot-joined
   handle still matches. Strengthening only - no previously-genuine match was
   removed, and the Phase-3 set shows every ground-truth page still matching.
3. **Profile-only related-account links.** Share/compose endpoints
   (`x.com/intent/...`, `linkedin.com/shareArticle`, `twitter.com/share`) name
   no profile and are no longer proposed, on *both* extraction paths; the
   Instagram-family refusal (D47) now applies to `ld+json sameAs[]` too - a
   `facebook.com` sameAs link had been stored because only the anchor walk
   enforced it.
4. **Support checking canonicalizes both sides** (entity decoding + JSON-LD
   `\/`), so a faithful page can no longer look unsupported over escaping.
5. **Attribution is a level, not a vibe:** `HOST` (identity) / `URL` / `TITLE`
   / `BODY` (topical); only HOST counts as strong. `wersm.com/natgeo-...`
   reading STRONG was the symptom.
6. **Ground-truth matching is host-level** (the verified page proves its
   domain; the probe may fetch another path on it first), and **`nasaa`'s
   ground truth was corrected after falsification**: the string names real
   organizations - nasaa-arts.org serves HTTP 200 and uses the brand 596 times,
   nasaa.org exists but answers 403 even to a browser user-agent (a documented
   coverage limitation). The case still tests what remains true: no `nasa.*`
   page may contribute to `nasaa`, and identity-unverified string matches are
   REVIEW, never verdicts.
7. **Duplicates are measured, not "fixed"**: per-document facts cite distinct
   URLs and relations never count same-domain repeats as corroboration, so the
   honest 77% github duplicate rate stays visible as a metric instead of being
   papered over by discarding citations.

After the corrections (live, same day, same provider):

| Case | Facts | Unattributed | Support | Outcome | Expect |
|---|---|---|---|---|---|
| `nasa` | 15 | 19 | 100% | `EVIDENCE_EXTRACTED` (gt 1/1 + 1/1) | **MET** |
| `natgeo` | 2 | 16 | 100% | `EVIDENCE_EXTRACTED` (0 source-identity facts) | **MET** |
| `github` | 333 | 0 | 100% | `EVIDENCE_EXTRACTED` (host github.com, 5/0) | **MET** |
| `sel_win_` | 0 | 0 | n/a | `PAGES_IRRELEVANT` | REVIEW |
| `rgb` | **0** | 17 | n/a | `RELEVANT_NO_FACTS` | REVIEW |
| `nasaa` | 6 | 0 | 100% | `EVIDENCE_EXTRACTED` (string-true, identity-unverified) | REVIEW (corrected) |
| `zqwxplm2026` | 0 | 0 | n/a | `PAGES_IRRELEVANT` | **MET** |

Three layers stay separate in the harness itself: **mocked** (vitest suites,
never network), **saved** (`--saved` replays committed recordings
`apps/cli/test/fixtures/bench/{nasa,natgeo,nasaa}.json` through the real probe -
offline, and reproducing the live numbers exactly), and **live** (this script's
default). Brave rows appear only when a key exists: NOT MEASURED, never a
fabricated comparison.

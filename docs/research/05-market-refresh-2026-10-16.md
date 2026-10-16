# Market refresh — Instagram observation tools, as of 2026-10-16

**Date:** 2026-10-16 · **Type:** fresh verification pass over docs/research/01–04 (2026-10-15), run on the open-source release runway.
**Method:** GitHub REST API and HTML pages scraped via Firecrawl (2026-10-16); vendor pricing/docs pages fetched via Firecrawl and WebFetch; official MCP registry queried via its API (`registry.modelcontextprotocol.io/v0/servers?search=instagram`); Hacker News via the Algolia API (stories and comments). GitHub star counts are from `api.github.com/repos/...` on 2026-10-16 unless stated.
**Labels:** `[V]` = primary source fetched this pass · `[C]` = vendor/third-party claim only · `[I]` = inference.
**Known gap this pass:** Reddit could not be fetched at all — Firecrawl's fetcher returns "we do not support this site" for `reddit.com` and `old.reddit.com`; Reddit material below is limited to search-result snippets (labeled) and is not full-thread reading. HypeAuditor publishes no self-serve price page `[V]` (verified absence).

---

## 0. What this refresh changes vs. the 2026-10-15 pass (files 00–04)

| Prior-pass claim (2026-10-15) | What this pass verified (2026-10-16) | Status |
|---|---|---|
| Socialinsider tiers history 3/6/12 months at $82/$124/$199 ([01](01-analytics-market.md)) | $83 / $124 / $199 per month (billed $990 / $1,490 / $2,390 yearly); the page still labels the tiers 3 / 6 / 12 months | **Re-verified** — annual-billing rounding only |
| Metricool Starter ~$22/mo flat, up to 10 brands ([01](01-analytics-market.md)) | Price now steps by brand count: $20 (5 brands) / $36 (10) in the USD block; €16 / €29 / €43 / €69 / €130 for 5–50 brands in the EUR block; free plan schedules 20 posts/mo. Billing toggle not fully resolved from the rendered page | **Moved** — structure changed; not a like-for-like delta |
| Iconosquare paid from €9/mo (3 profiles) ([01](01-analytics-market.md)) | Free plan now advertises **"1 month of analytics history"**; paid from $10/mo (yearly-billed, 3 profiles) → $17 (5) → $39 → $79, USD block | **Re-verified** — the retention cut on the free tier is the notable part |
| Stream 03: zero of ~78 surveyed Instagram MCP servers expose an append-only ledger, hashes, or UNAVAILABLE-with-reason ([03](03-oss-agent-ecosystem.md)) | Re-verified on this pass's narrower sample (9 GitHub-topic repos + 30+ official-registry entries): still zero | **Unchanged** |
| Stream 02: 40+ anonymous-viewer tools died 2024–25; both iganony domains now registered to Meta ([02](02-tracking-osint-market.md)) | The demand didn't die with the tools — an anonymous "private profile viewer" is now listed in the **official MCP registry** (`com.jojapi/instagram-private-profile-viewer`) | **Extended observation** |
| *(not in 01–04)* | `mgp25/Instagram-API`, the PHP private-API SDK, returns a GitHub **DMCA block** (reason `dmca`, created 2020-01-29) | **New this pass** |
| *(not in 01–04)* | Meta's updated commercial terms — letting *Meta* crawl websites "associated with" business accounts — effective **2026-10-30** (Nieman Lab, 2026-10-15) | **New this pass** |

Nothing this pass **reversed** a prior finding; two prices moved, and the MCP population was re-sampled on a narrower frame.

---

## 1. Open-source Instagram tools

All rows fetched from the GitHub API on 2026-10-16 unless noted. "Private/session" means the tool logs in as a user (credentials or session cookie) or drives the mobile/private API — IGTrack deliberately does not use any of these.

| Tool | Stars | License | Last activity | What it does | Private/session API? | Source |
|---|---|---|---|---|---|---|
| [instaloader/instaloader](https://github.com/instaloader/instaloader) | 13,594 | MIT | push 2026-10-14; release **v4.15.4** 2026-10-12 | Download posts/captions/metadata from public or logged-in Instagram | Yes — optional login; default anonymous, but "logged-in post fetching" keeps breaking | [V] API; [V] releases page |
| [subzeroid/instagrapi](https://github.com/subzeroid/instagrapi) | 6,962 | MIT (LICENSE file read 2026-10-16; GitHub badge shows "NOASSERTION") | push 2026-10-16; release **3.0.25** 2026-10-14 | "Python library for Instagram Private API 2026 **with HikerAPI SaaS**" | Yes — private mobile API; repo now markets a paid API (HikerAPI) as the safer path | [V] API; [V] raw LICENSE; [V] repo description |
| [subzeroid/aiograpi](https://github.com/subzeroid/aiograpi) | 477 | MIT | push 2026-10-16; release **2.0.20** 2026-10-13 | Async version of the above | Yes — private API | [V] API |
| [dilame/instagram-private-api](https://github.com/dilame/instagram-private-api) | 6,480 | MIT | **push 2024-08-09** (abandoned ~2 yrs); 408 open issues | NodeJS private API SDK | Yes — private API | [V] API |
| arc298/instagram-scraper | — | — | **GitHub page and API return 404 on 2026-10-16** | Was a popular public-page scraper ("instagram-scraper" pip package) | No (public pages), but no longer hosted | [V] `api.github.com/repos/arc298/instagram-scraper` → `"Not Found"`; gists still reference it |
| [mikf/gallery-dl](https://github.com/mikf/gallery-dl) | 20,108 | GPL-2.0 | push 2026-10-09; release **v1.32.16** 2026-10-09 | Media/gallery downloader incl. Instagram extractor | Optional login for some content; public by default | [V] API |
| [JustAnotherArchivist/snscrape](https://github.com/JustAnotherArchivist/snscrape) | 5,462 | GPL-3.0 | **push 2023-11-15; no releases** — dead | Multi-platform scraper; Instagram support was always the weakest limb | No, but abandoned; anything it did still do is unmaintained | [V] API |
| [drawrowfly/instagram-scraper](https://github.com/drawrowfly/instagram-scraper) | 905 | none detected | **push 2023-03-04** — dead | Node scraper for users/hashtags/locations + "people who liked" | No, dead | [V] API |
| [scrapfly/scrapfly-scrapers](https://github.com/scrapfly/scrapfly-scrapers) | 1,096 | "NOASSERTION" | **push 2026-10-16** (daily) | Vendor-maintained scrape scripts for +40 domains incl. Instagram | No login; instead pays a commercial unblocking service | [V] API |
| [njoylab/instatrack](https://github.com/njoylab/instatrack) | 4 | MIT | push 2026-05-15 | "Track your Instagram followers & following over time. Privacy-first, local-only data processing" (Next.js) | No — works off the operator's export, like IGTrack `[I from description]` | [V] API; Show HN 2025-10-02 [V] |
| [postaddictme/instagram-php-scraper](https://github.com/postaddictme/instagram-php-scraper) | 3,351 | MIT (LICENSE: "Copyright (c) 2016-2019 Raiymbek Kapishev") | **push 2025-05-28** | "Get account information, photos, videos, stories and comments." (PHP) | No login — public pages | [V] GitHub data via `ungh.cc` mirror; [V] raw LICENSE |
| [ping/instagram_private_api](https://github.com/ping/instagram_private_api) | 3,319 | MIT (LICENSE: "Copyright (c) 2017 ping") | **push 2024-05-06** — dead ~2.4 yrs | "A Python library to access Instagram's private API." | Yes — private API | [V] `ungh.cc` mirror |
| [althonos/InstaLooter](https://github.com/althonos/InstaLooter) | 2,109 | GPLv3+ (`setup.cfg`: `license = GPLv3+`; `COPYING`) | **push 2023-01-06**; the repo description itself says **"(defunct)"** | API-less picture/video downloader | No | [V] `ungh.cc` mirror; [V] raw `COPYING` / `setup.cfg` |
| [mgp25/Instagram-API](https://github.com/mgp25/Instagram-API) | — (blocked) | — | **GitHub serves a DMCA block, not the repo** — `"Repository access blocked"`, `reason: dmca`, created **2020-01-29**; block has stood ~6.7 years | PHP Instagram private-API SDK | Yes — was a private-API archetype | [V] `api.github.com/repos/mgp25/Instagram-API` JSON, 2026-10-16 |

**Breakage state, honestly:**

- Instaloader's newest release exists *because* of breakage: v4.15.4 "Fix profile resolution and logged-in post fetching (#2724, #2744, #2765)" (release notes, 2026-10-12) `[V]`. A recurring pattern: each release in 2026 (v4.15.1 March, v4.15.2 July, v4.15.3 July, v4.15.4 October) repairs GraphQL/profile fetching `[V]`.
- Instaloader's sponsors now include API-resale vendors (SocialAPIsHub, rocketapi-io listed in release notes) `[V]` — the OSS scraper ecosystem is financially entangled with the paid API re-selling business.
- Private-API libraries remain in a permanent arms race: instagrapi shipped 3.0.25 on 2026-10-14, two days before this pass `[V]`; its repo description itself now redirects users toward the paid HikerAPI route `[V]`.
- The general 2026 scraping picture, per practitioner docs: "Instagram scraping in 2026 requires working through complex blocking systems: IP quality detection, TLS fingerprinting, rate limiting" (Scrapfly, 2026) `[C]`; "check which open-source Twitter/X, Reddit, Instagram and TikTok scrapers still work in September 2026, what broke the rest" (Xpoz blog, 2026-09-01) `[C]`.
- No actively maintained, Instagram-capable OSS tool found this pass works without either (a) logging in, (b) paying a commercial unblocking/scraping service, or (c) doing downloads-only. `[I from all rows above]`
- **The private-API forebears are a graveyard, and the enforcement record explains why.** mgp25/Instagram-API: DMCA-blocked by GitHub since 2020-01-29 `[V]`; ping: last push 2024-05-06 `[V]`; dilame: last push 2024-08-09 `[V]`; InstaLooter: self-labelled "(defunct)" `[V]`. The single surviving private-API line (subzeroid: instagrapi + aiograpi) ships constantly *and* monetizes the risk by selling HikerAPI/DataLikers beside the library `[V]`.
- **What survives is download-oriented or vendor-funded.** Everything above that is both actively maintained and login-free is either a media downloader (gallery-dl, InstaLooter until 2023) or shipped by a commercial scraping vendor (scrapfly-scrapers, pushed daily). `[V rows; I]`

---

## 2. Commercial monitoring / intelligence

| Product | Pricing (fetched 2026-10-16 unless noted) | Verified capability | Unfollower/monitoring positioning | Data route |
|---|---|---|---|---|
| [Modash](https://www.modash.io/pricing) | Essentials **$199/mo** (annual $2,388), Growth **$499/mo**, Enterprise **from $14,700/yr** | "Discover / Manage / Track" creator marketing; Essentials = 300 opened profiles, 100 unlocked creator emails, 100 tracked creators' content, 3,000 "influential fans"; free fake-follower checker | Influencer *content tracking*, no unfollower feature | Creator database; source not documented `[I]` |
| [HypeAuditor](https://hypeauditor.com/pricing/) | **No self-serve price list published** — page offers demo + free plan only `[V]`. Third-party: Starter $299/mo, Cloud Pro $499/mo ([TrustRadius](https://www.trustradius.com/products/hypeauditor/pricing)) `[C]`; Capterra lists $399/user/mo `[C]` — figures conflict | Influence marketing platform: discovery, fraud audits, campaigns | No unfollower product | Creator database; source not documented `[I]` |
| [Social Blade](https://socialblade.com/) | Free tier + membership ("removes every ad and unlocks up to **3+ years of daily historical data**, weekly & daily charts", homepage) `[V via snippet]`; third-party price claims $3.99–$9.99/mo Bronze/Silver, plans $59.99–$1,439.99/yr (OutlierKit, CreatorStackClub) `[C]` | Cross-platform stat pages incl. Instagram; "historical data and ranking" | Monitoring openly — third-party account stats; history is *their* recording, sold as a membership tier | Data route not documented; no official IG API returns arbitrary-brand stats `[I]` |
| [PhantomBuster](https://phantombuster.com/pricing) | Plans **Start/Grow/Scale** ≈ $69/$159/$439 per month (annual ≈ $56/$128/$352); 14-day trial ([pricing page, blog](https://phantombuster.com/blog/ai-automation/phantombuster-pricing-explained/)) `[V snippet]` | Cloud automations ("Phantoms") incl. [Instagram Profile Scraper](https://support.phantombuster.com/hc/en-us/articles/26971088523666-How-to-Use-the-Instagram-Profile-Scraper): "**Step 1: Connect your Instagram account**" | Monitoring/scraping at scale via **the user's own logged-in session** | Session-login automation — the ban-risk route `[V via support docs]` |
| [Bright Data](https://brightdata.com/products/web-scraper/instagram) | **5,000 records/mo free**; pay-per-success; ~**$1.50/1,000 records** (SocialCrawl pricing table, verified July 2026; numbers on BD's own pricing widget are JS-hidden) `[V]+[C]` | Instagram Scraper API: account, bio, followers/following/post counts, post URL, hashtags, likes, comments, views, date posted; 4.6 Trustpilot `[V]` | Public-data collection at industrial scale | **Logged-off public scraping** — court-confirmed as their posture (see §5) `[V]` |
| [HikerAPI](https://hikerapi.com/pricing) | Pay-per-request tiers: $0.02 → $0.001 → $0.00069 → **$0.0006/req** ($20/$100/$300/$599 unlock balances); 100 free requests | "100+ Instagram endpoints" incl. profiles, stories, comments; markets itself against Bright Data | None (infrastructure) | Private-API wrapper ("same data as instagrapi") `[V]` |
| [Apify Instagram Scraper](https://apify.com/apify/instagram-scraper) | **from $1.50 / 1,000 results**; 4.7 stars (602 ratings); 432K users; third-party actor `apidojo` from $0.47/1,000 posts | Posts, reels, profiles, places, hashtags, carousels, comments; scheduling/export APIs | None (actor marketplace) | Scraping `[V]` |
| RapidAPI Instagram providers | e.g. `instagram-cheapest`: **from $0.10 / 1,000 requests** ([RapidAPI](https://rapidapi.com/search?term=instagram)) `[V via snippet]` | Raw JSON profiles/posts/reels/comments/audio, "no cache, no normalization" | None (marketplace) | Private-API/scraping resellers `[I]` |
| [DataLikers](https://datalikers.com/) (by subzeroid, same maintainer as instagrapi) | Cache API **from $0.0003/request**; MCP same pricing; datasets fixed price (e.g. Instagram Users USA: 10K rows $1; **3,130,259 rows $251**) | Profiles, posts, followers, comments; 31 MCP tools; dataset fields include **"face analysis (age, gender, race, emotion)"** | Threat-intel-style bulk data on people | Scraped **cache** sold as API/datasets `[V]` |
| [Not Just Analytics](https://app.notjustanalytics.com/e-commerce) | €32.50 / €57.50 / €90.83 per month (3 / 6 / 24 months of "business data" retained) `[V]` | Instagram/TikTok profile analytics, strategy reports; consumers: Forbes, Wired etc. (marketing) `[C]` | Analytics for brands/creators; not unfollower-specific | "Business data" retention tiers imply official insights for owned accounts `[I]` |
| [Iconosquare](https://www.iconosquare.com/pricing) | Free $0 — **"1 month of analytics history"**, 10 posts/mo per profile `[V]`; paid from **$10/mo** yearly-billed (3 profiles) → $17 (5 profiles) → $39 → $79, USD block (the page carries a monthly/yearly toggle; prior pass saw €9/€33/€69 in EUR) | Analytics-first IG/TikTok specialist; benchmarks; 100+ metrics ([01](01-analytics-market.md)) | Owned-account analytics; history cut down on the free tier is the retention pitch | Official APIs for the owned account `[I]` |
| [Metricool](https://metricool.com/pricing/) | Free (**20 posts/mo scheduling**); paid pricing now steps by brand count: **$20 (5 brands) / $36 (10)** USD block; **€16 / €29 / €43 / €69 / €130** for 5 / 10 / 15 / 25 / 50 brands EUR block | Scheduling + analytics across networks; "Metricool MCP" ships on the free plan (prior pass [01](01-analytics-market.md)) `[V prior]` | Owned-account analytics + competitor tiers; free-tier MCP = agent access is table stakes | Official APIs + own collection `[I]` |
| [Socialinsider](https://www.socialinsider.io/pricing) | **$83 / $124 / $199** per month (billed $990 / $1,490 / $2,390 yearly); tiers carry **3 / 6 / 12 months**; "monthly replacements" quotas 10 / 15 / 20 | Cross-network analytics + competitor benchmarking | **The history window *is* the tier ladder** — the retention-SKU archetype | Own collection + official APIs `[I]` |
| Unfollower-tracker apps (Play Store) | free w/ ads | "Followers & Unfollowers" **4.3 (255,649 ratings)**; "Unfollowers Unfollow Tracker" **4.2 (27,052 ratings)** — Play listing metadata, dynamic `[C]` | The unfollower demand at consumer scale | Mixed; vendor blogs say login-based mostly break and export-based is the survivor (see §4) |

**The retention ladder, side by side (each row verified 2026-10-16 unless marked):**

| Plan | What it buys | Price |
|---|---|---|
| Meta One (Advanced/Expert/Max) | Insights "beyond 90 days" + export `[V]` | paid plans; exact price not published |
| Iconosquare Free | 1 month of analytics history `[V]` | $0 |
| Socialinsider Adapt | 3 months `[V]` | $83/mo |
| Socialinsider Optimize | 6 months `[V]` | $124/mo |
| Socialinsider Predict | 12 months `[V]` | $199/mo |
| Not Just Analytics | 3 / 6 / 24 months of "business data" `[V]` | €32.50 / €57.50 / €90.83 per month |
| Social Blade | "up to 3+ years of daily historical data" `[V snippet]` | membership tier (third-party prices conflict `[C]`) |

None of these ladders is retrospective: the history starts the day the subscription starts.

**Cross-cutting observations (2026-10-16):**

- **Retention windows are still the core SKU.** Not Just Analytics sells 3/6/24-month data windows `[V]`; Social Blade sells "3+ years of daily historical data" as membership `[V snippet]`; Meta One sells "look back beyond 90 days and export your insights" (Advanced/Expert/Max plans) `[V]`.
- **Nobody sells evidence.** Every vendor page above advertises numbers and fields; none advertises provenance, raw hashes, or "unavailable with reason". The closest honesty artifact found in any competitor is Bright Data's "only pay for what's successfully delivered" — a billing rule, not an epistemic one. `[V pricing page; I]`
- **The paid ecosystem is the private-API ecosystem re-sold.** instagrapi's maintainer ships HikerAPI/DataLikers `[V]`; Instaloader is sponsored by rocketapi.io/SocialAPIsHub `[V]`; RapidAPI is full of thin resellers `[V]`. When the private API breaks (constantly), the resale layer prices that risk in.

---

## 3. MCP + agent ecosystem

**GitHub topic [`instagram-mcp`](https://github.com/topics/instagram-mcp) — all 9 repos, fetched 2026-10-16 `[V]`:**

| Repo | Stars | What it exposes | Last activity | License |
|---|---|---|---|---|
| [mcpware/instagram-mcp](https://github.com/mcpware/instagram-mcp) | 56 | "23 tools for the Graph API. Posts, comments, DMs, stories, hashtags, reels, carousels, analytics" | Sep 13, 2026 | MIT |
| [inssist/mcp](https://github.com/inssist/mcp) | 31 | "work inside your own Instagram session through the INSSIST Chrome extension" | Sep 22, 2026 | not stated `[V page]` |
| [HasData/instagram-mcp](https://github.com/HasData/instagram-mcp) | 16 | Hosted scraper: "Public profile and post-feed tools by handle" | Oct 12, 2026 | not stated `[V page]` |
| [subzeroid/datalikers-mcp](https://github.com/subzeroid/datalikers-mcp) | 9 | "29 Instagram & TikTok data tools. Thin stdio proxy" to the DataLikers API | Oct 6, 2026 | not stated `[V page]` |
| [postoncehq/instagram-mcp](https://github.com/postoncehq/instagram-mcp) | 1 | Publishing/scheduling "through Instagram's official API. No scraping, no developer app" | Oct 5, 2026 | not stated `[V page]` |
| [awpthorp/posterly-mcp-server](https://github.com/awpthorp/posterly-mcp-server) | 0 | Scheduling to Instagram + 13 more platforms | Oct 9, 2026 | not stated |
| [setsmart-git/instagram-mcp](https://github.com/setsmart-git/instagram-mcp) | 0 | DMs via official Meta Business APIs | Aug 26, 2026 | not stated |
| [selvin-paul-raj/Instagram-Alpic-mcp](https://github.com/selvin-paul-raj/Instagram-Alpic-mcp) | 0 | Graph API tools + OAuth + health monitoring | Jul 21, 2026 | not stated |
| [DevinChen2014/instagram-mcp](https://github.com/DevinChen2014/instagram-mcp) | 0 | "SocialDataX" user/post search, comments, Reels speech-to-text | Oct 11, 2026 | not stated |

**Notable Instagram MCP servers outside that topic `[V]`:** [jlbadano/ig-mcp](https://github.com/jlbadano/ig-mcp) 197★ (MIT, pushed 2026-02-09, "interact with Instagram Business accounts"); [duhlink/instagram-server-next-mcp](https://github.com/duhlink/instagram-server-next-mcp) 50★ (no license, dormant since Jan 2025); [anand-kamble/mcp-instagram](https://github.com/anand-kamble/mcp-instagram) 8★; [AleemHaider/instagram-mcp](https://github.com/AleemHaider/instagram-mcp) 6★ ("24 tools for posting, comments, DMs, and insights"); [CDataSoftware/instagram-mcp-server-by-cdata](https://github.com/CDataSoftware/instagram-mcp-server-by-cdata) 4★ (read-only bridge to a paid JDBC driver).

**Official MCP registry** (`registry.modelcontextprotocol.io`, query `instagram`, all active, fetched 2026-10-16) `[V]` — a materially different population: hosted remote servers, mostly scraper/session-backed, including:

- `app.hooksend/instagram` — comment-to-DM automation "on the official Meta API" (updated 2026-10-03).
- `co.civai.nova/instagram-web-agent` — description states it uses "your Instagram Web browser session … **via instagrapi, not Meta**" (updated 2026-09-21).
- `co.instapi/instagram`, `co.instavision/instagram-discovery` (niche/creator discovery), `com.hasdata/instagram` (scraping vendor), `com.jojapi/instagram-private-profile-viewer` (profile "viewer"), `com.ranovam/instagram-hashtag-discovery`, `com.superagnt/instagram-data`, `info.storiesig/instagram-mcp` ("stories, highlights … **no login**"), `io.github.AnshumanAtrey/instagram-profile-intel-no-login` (bio emails and 25+ fields).
- The registry search for `social media monitoring` timed out this pass; the `instagram` query returned 30+ entries, several duplicated per version. `[V partial]`

**Composition of the 9 GitHub-topic repos (this pass):** 4 wrap the official Graph API for the operator's own account (mcpware, postonce, setsmart, selvin); 2 are thin proxies to a paid data vendor (DataLikers, HasData); 1 rides the operator's logged-in browser session (inssist); 1 is a search wrapper over a third-party data service (DevinChen → "SocialDataX"); 1 is scheduling-only (posterly). **Zero store evidence.** `[V]`

**Does anything already offer lawful public-account monitoring + evidence via MCP? No.** `[V+I]` — the population splits between (a) official-API wrappers mostly aimed at the operator's own account/automation (mcpware, postonce, AleemHaider, HookSend), and (b) session/scrape-based data resale claiming exactly what IGTrack refuses (private-profile viewer, stories/highlights without login, follower data). Zero of the ~30 servers reviewed advertise a ledger, provenance, observed-vs-captured time, or UNAVAILABLE-with-reason semantics. The nearest independent validation of the niche is not an MCP server but [InstaTrack](https://github.com/njoylab/instatrack) (§1) and FollowGuard (§4), both export-based and both non-agent.

---

## 4. User pain (2025–2026)

Verbatim quotes below were fetched this pass; each has its source. Reddit thread *bodies* were unreachable (fetcher returns "we do not support this site" for reddit.com) — Reddit entries are search-result snippets, labeled.

**Building contact — the export route is what people build when they distrust logins:**

- HN, 2026-01-12 (Ask HN January 2026), user `faja` on FollowGuard: *"I got tired of seeing people lose their accounts to 'unfollower' apps that require login credentials and use unofficial APIs. Instead, I built this to parse official Instagram GDPR data ex…"* — [item 46586166](https://news.ycombinator.com/item?id=46586166) `[V]`
- HN, 2025-02-18, `gooddeedsman` (Meerkat extension): *"I had a hard time finding a trustable and easy to use option to track my IG following and unfollowers. I found a solution of David Arroyo that works by pasting some code to the browser console, but it is not easy to use and I gotta go copy the code from the internet over and over."* — [item 43095721](https://news.ycombinator.com/item?id=43095721) `[V]`
- HN, 2025-09-04, `Un_Tracker` ([dead] submission): *"I wanted to understand the 'why' behind follower drops, not just the 'who.' Most apps in this space feel spammy"* — the same comment claims "The Instagram API connection is handled through Meta's officially sanctioned Graph API endpoints where possible" — [item 45126360](https://news.ycombinator.com/item?id=45126360) `[V]`. That claim cannot be fully true as stated: the official API exposes no follower rosters (§5, FOUNDING §14), so "where possible" is carrying the whole unfollower product `[I]`.
- HN, 2026-04-18, `followbackscan`: *"If a website or app asks you to log in with your Instagram credentials to show you who doesn't follow you back, close the tab. Instagram removed public API access to follower and following lists. Any tool that still works is doing so by using your credentials to hit private, unofficial endpoints … And that's assuming the site isn't already stealing your credentials, selling your data, or using your account as part of a botnet. The only safe way to check who doesn't follow you back is through Instagram's official data export."* — [item 47815363](https://news.ycombinator.com/item?id=47815363) `[V]`
- HN, 2025-10-15, `gala8y`: *"I would much prefer to be able to download a reel or a whole account easily (using, say, Instaloader), without needing to climb their gardens' walls (obviously something which gets harder and harder), instead of their UIs."* — [item 45597063](https://news.ycombinator.com/item?id=45597063) `[V]`

**The meta/pain axis — API access friction:**

- Ask HN, 2025-05-05: *"Ask HN: Has anyone managed to pass Meta's Access Verification?"* — the title itself is the finding; author `hipgrave`: *"…my latest desperate attempt for reference. … Our app is used to authenticate users—specifically musicians—via the Instagram OAuth flow. We request access only to the…"* — [item 43897126](https://news.ycombinator.com/item?id=43897126) `[V]`
- HN, 2026-04-13, `xnx`: *"Tools like instaloader are a start, but screen scraping might be the best bet to avoid detection/banning."* — [item 47753051](https://news.ycombinator.com/item?id=47753051) `[V]`
- HN, 2026-08-25, `alex1138` (on Nitter/XCancel C&D notices): *"This thing of needing to log in to view public pages needs to die. It's not 'security'."* — [item 49442097](https://news.ycombinator.com/item?id=49442097) `[V]`
- HN, 2026-04-13, `harshitaneja`: on the Graph API being "accessible and provided a decent amount of functionality and access but was curtailed post public backlash from misuse" — [item 45042534](https://news.ycombinator.com/item?id=45042534) `[V]`

**Reddit (search snippets only, thread bodies not retrievable this pass; treat as directional):**

- r/Instagram, "Tracking unfollowers (2026)": *"I built something that uses your Instagram data export instead, so no login needed, it shows unfollowers, non-followers, and even pending…"* — [thread 1qojzqt](https://www.reddit.com/r/Instagram/comments/1qojzqt/tracking_unfollowers_2026/) `[C snippet]`
- r/Instagram: *"you can just import your followers and following .json files, Built a browser-only Instagram unfollower checker using Meta's official JSON export."* — [thread 1hlh3ej](https://www.reddit.com/r/Instagram/comments/1hlh3ej/how_to_see_who_doesnt_follow_you_back_on_instagram/) `[C snippet]`
- r/SideProject: *"You just download your Instagram data from Instagram, upload the file, and it shows the results right away. No login needed, no password…"* — [thread 1t2kktz](https://www.reddit.com/r/SideProject/comments/1t2kktz/) `[C snippet]`
- r/n8n (OSINT tool builder, recent): "I'm stuck on the Instagram module" of a social-footprint analyzer — the recurring wall for OSINT builders. [thread 1ps4hby](https://www.reddit.com/r/n8n/comments/1ps4hby/building_an_osint_tool_need_help_with_instagram/) `[C snippet]`

**Vendor-authored pain validation (competitors telling the same story):**

- Nonfollowers (2026 guide): *"the login-based ones mostly don't — and the ones that do put your account at serious risk"*; the export is "the one approach Instagram can't break". [nonfollowers.com/blog](https://www.nonfollowers.com/blog/do-instagram-unfollower-apps-still-work) `[C, consistent with §5 court/docs record]`
- Unfollowerstracker.io (2026-08-13): *"Instagram itself does not give you a simple historical list of everyone who unfollowed you"*; compares "browser-based analysis, Instagram export-file trackers, mobile apps, and automated unfollowing tools". [unfollowerstracker.io/blog](https://unfollowerstracker.io/blog/best-instagram-unfollowers-tracker-apps/) `[C]`
- Trustpilot for PhantomBuster: **3.3/5 from 113 reviews** (fetched 2026-10-16) — the session-automation category carries visible satisfaction debt `[V]`.

**What the pain clusters are, distilled:** (1) login-based tracking is perceived as ban-risk and increasingly is; (2) the export→diff workflow is the trusted path but manual and unautomated; (3) Meta's own friction (access verification, 90-day windows, paywalls) drives demand into whichever tool advertises itself loudest; (4) users distrust *numbers* from vendors more than they distrust storage.

---

## 5. Platform + legal changes (2025–2026)

**Graph API versions.** Current version is **v26.0 (2026-07-29)**; v25.0 shipped 2026-02-18; v24.0 shipped 2025-10-08 (retires 2028-02-18). Sunset calendar: **v20.0 retires 2026-09-24**; v19.0 already expired (2026-05-21); v18.0 expired (2026-01-26). Any deployed integration older than v21.0 is already dead. ([Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog), fetched 2026-10-16) `[V]`

**Sunset calendar (same changelog, fetched 2026-10-16) `[V]`:**

| Version | Shipped | Retires / retired |
|---|---|---|
| v26.0 — current | 2026-07-29 | — |
| v25.0 | 2026-02-18 | — |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v20.0 | — | **retired 2026-09-24** |
| v19.0 | — | retired 2026-05-21 |
| v18.0 | — | retired 2026-01-26 |

**Instagram Platform changelog 2026 (fetched 2026-10-16).** `[V]` Highlights:
- **2026-04-22:** new IG Media fields for Facebook-Login apps — `reposts_count`, `saved_count`, `shares_count` (the "save/share visibility" gap from the last pass is now partially closed — for FBL apps, on owned media); aggregated `total_like_count`/`total_comments`/`total_views` matching the Insights Dashboard; **Business Discovery `view_count` now returns combined Instagram + Facebook views for crossposted video** — competitor view numbers silently changed definition (IGTrack can cite this as the exact "definitions move under you" case).
- **2026-06-22:** AI-generated-content label (`is_ai_generated`) on published media; new Story metric `link_clicks` (FBL only).
- **2026-06-01:** Instagram Audio API (music/original sound retrieval for Reels).
- **2026-03-30:** Creator Marketplace Discovery rate limit 240 → 1,000 queries/user/hour; new growth/activity/device filters.
- **2025-12-03:** `reels_skip_rate`, `reposts`, `crossposted_views`/`facebook_views` insights; Trial Reels; DELETE media endpoint. (Note explicitly states Business Discovery `view_count` still Instagram-only at that date — superseded in April 2026, above.)
- **2025-01-21:** Insights available to Instagram-Login apps; `impressions` deprecation finally applied to all versions 2025-04-21.

**Business Discovery (fetched 2026-10-16).** Still documented, still Facebook-Login-only: "basic metadata and metrics about other Instagram professional accounts"; edge cases documented — age-gated accounts return nothing; `view_count` warning: "includes both paid and organic metrics". No reach, no saves, no demographics, no follower identities. `[V]`

**Hashtag Search (fetched 2026-10-16, doc updated 2026-08-17).** Alive but capped: **30 hashtags per rolling 7-day window per account**, App Review + "Instagram Public Content Access" feature required, no Story hashtags, generic error on sensitive tags. `[V]`

**Meta One has a paid retention SKU.** "Looking back beyond 90 days and exporting your insights are only available … with a Meta One subscription" (Advanced/Expert/Max). Help page updated ~4 weeks before this pass. `[V]`

**Follower lists are being hidden selectively (Jan 2026).** Meta hid followers/following lists for Iran-based accounts after a Cloudflare threat-intel report: wongmjane's Threads post "Update: Meta is now hiding the following/follower lists of Iran-based Instagram users…" (2026-01-19, surfaced via HN submission 46678904) `[C]`; [Iran International, 2026-01-18](https://www.iranintl.com/en/202601188600) `[C]`; Newsweek coverage `[C]`. Primary Threads post not directly fetchable this pass. `[V secondary fragments]`

**Meta v. Bright Data — final state.** Judge Edward Chen's summary-judgment ruling (2024-01-23): *"The Facebook and Instagram Terms do not bar logged-off scraping of public data; perforce it does not prohibit the sale of such public data."* Meta then dismissed its remaining claim and abandoned appeal: "Meta filed a notice to dismiss its claim… waives Meta's ability to appeal" (Bright Data CEO letter, March 2024). Logged-off public scraping is the lawful lane; logged-in automation is not covered by it. `[V both Bright Data pages]`

**hiQ aftermath.** The CFAA question "resolved" in 2022: scraping public data isn't access "without authorization" (9th Cir. 2022-04-18). But LinkedIn still won: summary judgment on breach of contract (Nov 2022), then a stipulated **$500,000 judgment + permanent injunction (2022-12-07)**. Net rule: public scraping is not a *crime*; it can still be a *contract breach*. `[V via Privacy World/HiQ Wikipedia via search; primary cited]`

**EU regulatory lane.** DSA **Article 40** data access: the Commission adopted the delegated act on researcher data access, **published 2025-07-02** (EU 2025/2050). This is the institutionalized alternative path to platform data (vetted researchers), not a route for self-hosted operators — but it legitimizes "data about platforms should be accessible under rules" as policy direction. `[V EC digital-strategy page]`

**Meta's own scraping posture (new, effective 2026-10-30).** Meta's updated commercial terms allow *Meta* to crawl websites "associated with" business accounts of its platforms, effective **October 30, 2026** (Nieman Lab, 2026-10-15, fetched 2026-10-16). Notable for framing: the platform is tightening third-party collection while expanding its own. `[V Nieman Lab article]`

---

## 6. Synthesis — the five strongest unmet needs, ranked by fit for a lawful, self-hosted, evidence-first, agent-friendly tool

Each need states the market evidence and IGTrack's fit.

1. **Own-account history that outlives the platform's 90-day window — owned by the operator.**
   *Evidence:* Meta One sells "beyond 90 days + export" as a subscription `[V]`; Socialinsider's tiers are literally 3/6/12 months `[V]`; Not Just Analytics sells 3/6/24-month windows `[V]`; Social Blade sells "3+ years of daily historical data" `[V snippet]`. No vendor sells backfill — retention is bought forward from the day the subscription starts.
   *Fit:* IGTrack's append-only snapshots are the same product at $0; the honest pitch is "start recording now". **Strongest fit.**

2. **Follower-change and unfollower answers without login risk.**
   *Evidence:* FollowGuard, InstaTrack, Meerkat, three Reddit export-checkers, and the HN comment ranking the export as "the only safe way" `[V]`; two competitor guides independently call the export "the one approach Instagram can't break" `[C]`; one Play app alone carries 255,649 ratings of consumer demand `[C]`.
   *Fit:* IGTrack `import:v1` → COMPLETE-only diffs automate exactly the manual workflow users already run, at zero ban risk. **Strong fit; demand proven at consumer scale.**

3. **Numbers that can be audited and explained when tools disagree.**
   *Evidence:* the platform itself redefines metrics mid-flight — `impressions`→`views` (2025), Business Discovery `view_count` silently absorbing Facebook views (2026-04-22) `[V]`; the category's satisfaction debt is visible (PhantomBuster 3.3/5 on Trustpilot) `[V]`; no reviewed competitor stores source, hash, or observed-vs-captured time `[V]`.
   *Fit:* every IGTrack claim carries provenance, so "why do these numbers differ" becomes answerable. **Strong fit; nobody else is even trying.**

4. **Agent-native operations with honest failure semantics.**
   *Evidence:* ~30 Instagram MCP servers reviewed this pass (78 in the prior pass): official-API wrappers, session/scrape resale, or paid-data proxies; several advertise capabilities IGTrack refuses (private-profile viewer, highlights without login) `[V]`; zero expose a ledger, hashes, or UNAVAILABLE-with-reason.
   *Fit:* typed errors + honest `_meta` + refusals-with-reasons occupy an unclaimed position on a surface (MCP) that is now table stakes. **Strong fit; largest whitespace, earliest market.**

5. **Lawful observation of non-owned professional accounts, in a narrow documented shape.**
   *Evidence:* the only sanctioned route (Business Discovery) is alive but narrowed — FBL-only, age-gated accounts return nothing, semantics changed 2026-04-22 `[V]`; what the market sells instead is scraping (Bright Data, Apify, HikerAPI, DataLikers' face-analysis datasets) `[V]`.
   *Fit:* an honest Business-Discovery-backed `DISCOVERY` target (documented fields only, UNAVAILABLE+reason otherwise) serves competitor-tracking demand without crossing the red lines — but it needs scope expansion and app review. **Conditional fit; ranks last deliberately.**

**Areas not completed this pass (stated as required):**
- Reddit thread bodies (every variant of `reddit.com`/`old.reddit.com` is rejected by the fetcher): quotes from Reddit are search-result snippets only. All conclusions resting on Reddit are marked `[C snippet]`.
- HypeAuditor: no public price exists to verify (self-serve pricing removed/gated); third-party figures conflict and are labeled contested.
- Social Blade: capability confirmed at the homepage/claim level; per-account stat tables did not render server-side for scraping, so "what an IG profile page actually shows" is not fully verified.
- MCP registry "social media monitoring" query timed out; a second pass with narrower keywords is recommended before release copy cites registry breadth.
- Meta One exact prices were not scraped (help page fetched confirms the feature gating only).
- One candidate source (Mashable "Instagram security feature") appeared undated in snippets and was excluded rather than guess its era.
- Social Status (`socialstatus.io/pricing`) rendered no price text to the fetcher this pass; dropped rather than guessed.
- `mgp25/Instagram-API`: only the DMCA block JSON is readable (reason and date); the repository body itself is not served, so description/stars for that row are unavailable by construction.

---

## Appendix — primary sources fetched this pass (2026-10-16)

| Source | What was read |
|---|---|
| `api.github.com/repos/...` | stars / license / push dates for instaloader, instagrapi, aiograpi, dilame/instagram-private-api, arc298 (404), gallery-dl, snscrape, drawrowfly, scrapfly-scrapers, njoylab/instatrack, mgp25 (DMCA block) |
| `ungh.cc` mirror + `raw.githubusercontent.com` | postaddictme/instagram-php-scraper, ping/instagram_private_api, althonos/InstaLooter (LICENSE / COPYING / setup.cfg) |
| `github.com/topics/instagram-mcp` | all 9 topic repos, table in §3 |
| `registry.modelcontextprotocol.io/v0/servers?search=instagram` | 30+ entries, hosted remote servers, §3 |
| developers.facebook.com — Graph API changelog + Instagram Platform changelog | version calendar (§5) and 2025-12 → 2026-06 platform changes |
| developers.facebook.com — Business Discovery + Hashtag Search docs | §5 |
| Vendor pricing pages | modash.io, hypeauditor.com, socialblade.com, phantombuster.com, brightdata.com, hikerapi.com, apify.com, rapidapi.com, datalikers.com, app.notjustanalytics.com, iconosquare.com, metricool.com, socialinsider.io, meta.com/help/subscriptions |
| `news.ycombinator.com` items + `hn.algolia.com` API | the quote-bearing items listed in §4 (IDs: 46586166, 45126360, 43095721, 43897126, 47753051, 49442097, 45042534, 47815363, 45597063) |
| Nieman Lab (2026-10-15) | Meta commercial terms effective 2026-10-30, §5 |

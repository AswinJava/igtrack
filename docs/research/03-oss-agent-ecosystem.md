# Stream 3 — OSS + AI-Agent Ecosystem Around Instagram Data

Research date: 2026-10-15. All figures are point-in-time snapshots and every claim
carries the command or URL that produced it. Read-only research; nothing in
`C:\Users\aswin\Desktop\igtrack` was modified.

**Method note on "last push":** GitHub `pushedAt` can be advanced by bot commits,
CI workflows, or README edits. Where staleness is load-bearing I cross-checked
with open-issue volume, release tags, and the actual content of the newest issues.
Upstream source of truth for stars/forks/issues was `gh api repos/OWNER/REPO`.

---

## 1. OSS HEALTH TABLE

```bash
# licence/star/issue truth
gh api repos/instaloader/instaloader --jq '{n:.full_name,s:.stargazers_count,p:.pushed_at,a:.archived,l:.license.spdx_id,oi:.open_issues_count,fs:.forks_count}'
# discovery
gh search repos "instagram" --sort stars --limit 30 --json fullName,stargazersCount,description,pushedAt,isArchived,license
gh search repos "instagram api" --sort stars --limit 25 ...
gh search repos "instagram scraper" --sort stars --limit 25 ...
gh search repos "instagram mcp" --sort stars --limit 25 ...
```

### 1a. The named targets

| Repo | Stars | Last push | Archived | License | Open issues | Latest release | What it is in 2026 |
|---|---|---|---|---|---|---|---|
| `instaloader/instaloader` | 13,587 | 2026-10-14 | no | MIT | 62 | v4.15.4 (2026-10-12) | Downloader/metadata reader via Instagram's **private web endpoints**. Actively maintained but permanently chasing breakage. 10,798 PyPI downloads/day, 223,770/month. |
| `subzeroid/instagrapi` | 6,958 | 2026-10-14 | no | NOASSERTION | 13 | 3.0.25 (2026-10-14) | Python **private mobile API** client. Description now reads "…Python library for Instagram Private API 2026 **with HikerAPI SaaS**" — the maintainer has pivoted to selling a hosted bypass. 10,381 PyPI downloads/day, 266,749/month. |
| `Datalux/Osintgram` | 15,026 | 2026-10-15 | no | GPL-3.0 | 1 | 2.0 (2026-09-14) | Interactive OSINT shell over a target's nickname — follower/email/phone harvesting. Appears active; note the 1 open issue is titled "Mass Issue Closing". |
| `megadose/toutatis` | 4,353 | **2024-12-05** | no | GPL-3.0 | **366** | none | Extracts email/phone from IG accounts. **Effectively dead** — see §2. |

### 1b. Other Instagram-related repos >500 stars found by the searches

| Repo | Stars | Last push | Archived | License | Notes |
|---|---|---|---|---|---|
| `InstaPy/InstaPy` | 18,300 | 2026-10-14 | no | GPL-3.0 | The largest IG bot. **583 open issues, zero releases.** Push date is not credible as a health signal. |
| `megadose/holehe` | 15,202 | 2024-09-10 | no | GPL-3.0 | Account-existence check across sites (not IG-specific). Stale ~2 yrs. |
| `dilame/instagram-private-api` | 6,478 | **2024-08-09** | no | MIT | Node/TS private API SDK. **Dead.** 408 open issues; #1845 is literally "Is it working?" (open since 2026-05-16). npm still ~4,200 downloads/day. |
| `crimera/piko` | 5,661 | 2026-10-15 | no | GPL-3.0 | ReVanced-style client patches (removes ads). Active, but not data tooling. |
| `una/CSSgram` | 5,387 | 2021-08-01 | no | MIT | CSS filter library. Dead, irrelevant. |
| `ThoughtfulDev/EagleEye` | 5,247 | 2024-04-25 | no | WTFPL | Reverse-image-search stalker tool. Stale. |
| `PageMenu/PageMenu` | 5,211 | 2021-08-07 | no | BSD-3 | iOS UI library. Name-collision only. |
| `Bitwise-01/Instagram-` | 5,193 | 2024-07-09 | no | MIT | **Bruteforce tool.** Out of scope on legal grounds, listed for completeness of the star landscape. |
| `davidarroyo1234/InstagramUnfollowers` | 4,955 | 2026-10-08 | no | MIT | In-browser non-follower checker. **Healthiest consumer-facing tool in the list** — 42 open issues, active. |
| `ohld/igbot` | 4,885 | 2026-01-28 | no | Apache-2.0 | Bot scripts + "free followers" wrapper. |
| `ramtinak/InstagramApiSharp` | 896 | 2025-05-18 | no | (none) | .NET private API. 69 open issues, slowing. |
| `huaying/instagram-crawler` | 1,362 | **2024-05-03** | no | MIT | Dead. |
| `drawrowfly/instagram-scraper` | 905 | **2023-03-04** | no | **no licence** | Dead, unlicensed. |
| `a-legotin/InstaSharper` | 517 | 2024-04-20 | no | — | Dead. |

### 1c. Archived / vendor-dead

| Repo | Stars | Archived | Note |
|---|---|---|---|
| `facebookarchive/python-instagram` | 3,074 | **yes** | Meta's own Python SDK, archived 2020-10-01. |
| `facebookarchive/instagram-ruby-gem` | 1,447 | **yes** | Meta's own Ruby SDK, archived 2019. |
| `ahmdrz/goinsta` | 894 | **yes** | Unofficial Go client. |
| `AnderGoig/SwiftInstagram` | 572 | **yes** | — |

**Read:** Meta archives its own SDKs; every surviving tool is either (a) a
private-endpoint scraper in permanent break/fix, or (b) a bot. There is no
maintained, lawful, evidence-producing OSS project in this space.

---

## 2. DEAD/BROKEN EVIDENCE

### `instaloader` — the flagship is in continuous breakage

Issue **#2726 "429 Too Many Requests on web_profile_info"**, opened 2026-08-07, **still OPEN** (18 comments):
<https://github.com/instaloader/instaloader/issues/2726>

> "↑ Note that this occurs on the first attempt ; I'm _**not**_ trying to scrape a bunch of profiles simultaneously."
> — `tjack9979`, 2026-08-07

> "Instagram has effectively retired the web_profile_info endpoint. … Basically, implementing a GraphQL fallback will fix the issue … Who decided that using private internal endpoints from IG would be a good idea in the long run? Why do seemingly none of these IG downloaders have any useful fallbacks implemented?"
> — `LiVeenMusic`, 2026-09-09 (6 👍)

> "I just updated to 4.15.3 and this issue still exists, and it doesn't work no matter what i try, And since there is no update on this, I switched to gallery-dl and yt-dlp which work great without any issue."
> — `AhmadrezaNarimisa`, 2026-08-14

> "You simply need an effective TLS-fingerprinting solution. If this is not implemented, any script — whether Python, Node.js, or otherwise — can be easily identified by its fingerprint. **I have such a solution available.**"
> — `mjohnsoncode`, 2026-08-30 (1 👍 / 3 👎) — note the *monetised-bypass* pattern.

Issue **#2724 "400 Bad Request when downloading posts"** — CLOSED, fixed in v4.15.4:
<https://github.com/instaloader/instaloader/issues/2724>

> deterministic per-account failure, not rate limiting: `HTTP 200` for `instagram, nasa, spotify, nike, cristiano, louvre, bbcnews`; `HTTP 400` for `starbucks, natgeo, github, figma, vercel, leomessi, airbnb`
> — `olakost`, 2026-07-30

> "some posts' `location` dict comes without `id` at all → `KeyError: 'id' in Post.location`"
> — `SeijiOokami`, 2026-08-29 (documenting **three** simultaneous upstream breakages)

Other open breakage at time of writing:
- **#2691 "failing downloads logged in or not"** — OPEN since 2026-05-02.
- **#2697 "Unable to fetch high quality profile pic"** — OPEN. `sophymarine`, 2026-05-27: *"Instagram moved the nested structure for `hd_profile_pic_url_info` to a completely different response node last week. **This breaks pipelines.** … Relying on social media image URLs for structured KYB checks has become incredibly fragile lately."*
- **#2750 "429: Too Many Requests"** — opened 2026-10-10, zero comments.
- **#2749 "Error handling fails when simplejson is installed."** — opened 2026-09-30.

### `instagrapi` — the open-issue list is a catalogue of covert-identity engineering

<https://github.com/subzeroid/instagrapi/issues>

- #2875 (OPEN, 2026-10-12): *"One client, three identities: public session UA is a 2017 desktop Safari while GraphQL fallbacks send an iOS Instagram 273 UA (private session is Android)"*
- #2873 (OPEN): *"Session app profile (app_version/version_code/bloks_versioning_id, UA) silently follows DEFAULT_APP_VERSION — **changes on library update, can regress**"*
- #2871 (OPEN): *"X-IG-Bandwidth-\* triplet: three independent per-request randoms, never satisfies bytes = speed x time"*
- #2870 (OPEN): *"Hardcoded per-action fields: X-IG-Nav-Chain constant + direct_send body nav_chain/send_attribution (**cold DMs look like mass-DM automation**)"*
- #2865 (OPEN): *"Reels have empty captions; restoring caption returns HTTP 400 feedback_required"*
- #2852 (CLOSED): *"Fresh login fails with HTTP 429 during CAA send_login_request"*
- #2840 (OPEN): *"Intermittent direct_send HTTP 403 item_ack"*
- #2874 (CLOSED): *"challenge_required triggers automatic challenge-resolution … and **does not surface ChallengeRequired to the caller**"*

**Read:** these are not bug reports, they are the maintenance cost of
impersonation. Note #2874 in particular — the failure is *swallowed*, which is
exactly the anti-pattern IGTrack's "never as a successful empty result" rule forbids.

### `toutatis` — abandoned, now an abuse helpdesk

Last commit **2024-12-05** (~22 months stale). **366 open issues**, no releases.
Newest issues are members of the public asking the issue tracker for personal data:

- #534 (2026-10-15): *"I want email I'd or phone number of my fake Instagram account"*
- #530 (2026-10-11): *"Instagram fake account"*
- #524 (2026-10-06): *"a shityy person make a id same as mine and also puts my same profile picture"*

`gh issue list --repo megadose/toutatis --limit 10 --state all`

### Others

- `dilame/instagram-private-api` — last push 2024-08-09; #1845 **"Is it working?"** OPEN since 2026-05-16; six identical CVE reports (#1848–#1853, `image-size` CVE-2025-71329/71330) closed 2026-08-10 with **no code change**.
- `Datalux/Osintgram` — #2681 **"Mass Issue Closing"** is the sole open issue ([#2688 "WHY THIS IS PAID"](https://github.com/Datalux/Osintgram/issues/2688) was closed). Recent activity looks like tracker grooming rather than development.
- Ecosystem-level: `adelaidasofia/instagram-mcp` README describes itself as *"ToS-safe, no private API"* — an explicit market signal that the private-API default is now seen as the liability.

---

## 3. MCP LANDSCAPE TABLE

### 3a. Official MCP Registry — hard counts

```bash
curl.exe -s "https://registry.modelcontextprotocol.io/v0/servers?search=instagram&limit=100"
```

| Registry search | Matches |
|---|---|
| `instagram` | **60** |
| `social+media` | 0 |
| `analytics` | 100 (cap) |

60 Instagram MCP servers exist as of today. Sample (all descriptions verbatim from the registry):

| Registry ID | What it exposes |
|---|---|
| `app.hooksend/instagram` | "Instagram comment-to-DM automation your AI can set up and leave running, on the official Meta API." |
| `co.civai.nova/instagram-web-agent` | "I use your **Instagram Web browser session** (Integrations → Instagram Web) via **instagrapi**, not Meta" — i.e. session-cookie automation. **Directly on the far side of IGTrack's §3 line.** |
| `co.instapi/instagram` | "Instagram search and posts for AI agents, with images and videos AI-parsed to text." |
| `co.instavision/instagram-discovery` | "Find Instagram creators and leads by niche, city, follower range or lookalike accounts." |
| `com.52choujiang/instagram-insights` | "Instagram public post search, details, comments, replies, user info, and user posts." |
| `cc.ssave/tiktok-instagram-downloader` | "Extract & download … media — HD, no watermark, MP3 export" |

### 3b. GitHub Instagram MCP servers

`gh search repos "instagram mcp" --sort stars --limit 25`

| Repo | Stars | Last push | Open issues | Licence | Exposes / notes |
|---|---|---|---|---|---|
| `pipeboard-co/meta-ads-mcp` | **1,305** | 2026-09-23 | 18 | NOASSERTION | Hosted **Meta Ads** MCP. "badged Meta Business Partner, free plan". Ads only — no organic observation, no provenance, no self-hosting. The category leader. |
| `jlbadano/ig-mcp` | 197 | 2026-02-09 | 7 | MIT | IG Graph API for Business accounts. Stale 8 months. |
| `Bob-lance/instagram-engagement-mcp` | 46 | 2025-04-26 | 1 | — | "tracking Instagram engagement, generating leads" — dead 18 months. |
| `mikusnuz/meta-mcp` | 30 | 2026-10-08 | 2 | MIT | "57 tools with Graph API v25.0" + Threads. Active. |
| `Narla-Venkata-Anand-Sai-Kumar/openinstaflow` | 20 | 2026-05-31 | 0 | none | Graph API → MCP. |
| `HasData/instagram-mcp` | 16 | 2026-10-12 | 0 | — | Hosted; "Public profile and post-feed tools by handle". |
| `arjun1194/insta-mcp` | 12 | 2025-12-28 | — | — | — |
| `adelaidasofia/instagram-mcp` | 8 | 2026-10-14 | 0 | — | "**ToS-safe, no private API**", review-gated DMs. |
| `AleemHaider/instagram-mcp` | 6 | 2026-05-29 | 0 | MIT | 24 tools (posting/comments/DMs/insights). |
| `official-Arvind/instagram-mcp` | 5 | 2026-06-20 | 0 | — | **"68+ tools … Built with FastMCP + instagrapi"** — private API under an agent surface. |
| `caicai-yao/social-trends-mcp` | 5 | 2026-03-20 | 0 | — | Trending topics across X/TikTok/YouTube/IG. |
| `CDataSoftware/instagram-mcp-server-by-cdata` | 4 | 2025-10-18 | 0 | MIT | JDBC-wrapper, read-only, vendor funnel. |
| `IvanBBaev/instagram-mcp` | 3 | 2026-10-15 | 4 | — | Graph API, 28 tools. |
| `Stupidoodle/instagram-mcp` | 3 | 2026-10-15 | 0 | NOASSERTION | "built entirely by Claude (Opus 4.5) in ~3 hours with mass auto-accept enabled". |
| `xishandong/instagram-mcp` | 2 | 2026-04-14 | 0 | none | Scrapes via a third-party mirror (`imginn.com`). |
| `postoncehq/instagram-mcp` | 1 | 2026-10-05 | 0 | — | Official API, paid. |

### 3c. Hosted commercial MCP servers that already do "Instagram data for agents"

Sourced from the curated catalogue at
<https://github.com/TensorBlock/awesome-mcp-servers/blob/main/docs/social-media--content-platforms.md>
(accessed 2026-10-15) and <https://mcpmarket.com/categories/social-media-management> (**"Browse 1118 servers"**).

| Product | Claim | Provenance/evidence model |
|---|---|---|
| **FastSocial Instagram Data** (`data.fastsocial.co/mcp`) | "Read-only public Instagram data for AI agents. **27 tools** cover profiles, posts, reels, stories, highlights, comments, likers, followers, hashtags, places, audio and search; **nothing logs in to Instagram** and nothing posts." MIT. Free 50 credits/mo. | None advertised. Public scraping at scale. |
| **Mellow Hub** (`mellow.world/mcp`) | 21 tools, publishing across 9 networks; "every action is journaled and revocation applies on the next request". | Journaling, but for *actions*, not claims. |
| **Breakreach** | "33 tools … read post and account analytics", 19 networks. | None advertised. |
| **Postqued** | "62 tools cover posts, media, approvals, engagement, and analytics with scoped permissions." | Scopes only. |
| **Nooticr** | "hands back the material rather than a verdict: posts with the creator's own recent median for context, transcripts of what was actually said aloud, frames sampled across a video". | **The closest existing thing to an evidence-first framing** — but no hash, no ledger, no unavailability semantics. |
| **Gumloop** (`mcp.gumloop.com/instagram/mcp`) | Built on **Apify's Instagram scraper**; "pull profile details, recent posts, reels, and follower counts for a whole list of usernames at once". | Third-party scraping, resold. |
| **Zapier** `instagram-for-business`, **Bright Data** `ai/mcp-server/social-media` | Hosted, OAuth, paid. | Vendor platform. |

### 3d. Verdict on the landscape

Across 60 registry servers, 18 GitHub repos, and ~10 hosted products:

- **Highest-star Instagram MCP is 1,305 — and it is Meta *Ads*, not organic observation.**
- **Zero** servers expose an append-only evidence ledger, content-addressed raw/normalized hashes, or a structural-`UNAVAILABLE`-with-reason contract.
- **Zero** distinguish "the platform does not expose this" from "the call failed" from "it is genuinely empty".
- The two dominant architectures are (1) official Graph API, owned accounts only, ~2–70 tools; (2) private API / session-cookie / third-party-scraper resale.
- Nearest neighbours by star count are in **analytics-as-a-service**: `irinabuht12-oss/google-ads-meta-ads-mcp` 5,004★ and `googleanalytics/google-analytics-mcp` 3,469★ — both wrap *first-party* platform analytics behind OAuth.

---

## 4. WHAT AGENT USERS WANT (verbatim + URL)

### 4a. "Does the MCP actually work, or is it a pricing-page badge?"

r/mcp — **"What social media tools have MCP integration for AI agents that actually works?"**
<https://www.reddit.com/r/mcp/comments/1vl9td8/what_social_media_tools_have_mcp_integration_for/>

> "What social media tools have mCP integration for AI agents that actually works, **not just listed on it and features page?** Genuinely starting to wonder if most MCP integration claims from social tools are just marketing at this point, feels like every schedule is slapped it onto their pricing page this year regardless of whether it actually does anything useful."
> — OP `JittimaJabs`

> "The pattern that separates working MCP integrations from marketing badges is whether there is a real API under the hood. Schedulers that wrap their own dashboard in an LLM prompt are the ones that feel fake; **the ones that hold up return structured data and fail loudly when they cannot.**"
> — `Easy-Purple-1659`

> "The test I use is whether it writes. **Loads of these are a read endpoint with an MCP sticker on it**, and you find out when you ask the agent to actually change something and it just describes what it would do."
> — `blendai_jack`

> "The test someone mentioned above is the right one: ask the agent to actually create and schedule a post, then check it shows up in the platform's queue. **I'd also check whether it supports OAuth for hosted clients like Claude, since an API-key-only server rules out a lot of setups.** … No Facebook/Instagram yet, so if you need IG, Planoly or SocialPilot fit better today."
> — `genfounder`

**Takeaway:** users cannot tell a real integration from a badge. *"Fail loudly"*
and *structured data* are named as the discriminators — that is IGTrack's pitch,
said back to us by the market.

### 4b. What people actually want an agent to do with Instagram data

r/ClaudeAI — **"Has anyone connected Claude to Instagram for reel analysis and content strategy?"** (16 upvotes)
<https://www.reddit.com/r/ClaudeAI/comments/1tqu6s9/has_anyone_connected_claude_to_instagram_for_reel/>

> "I run marketing for a real estate company and have Claude Pro. I've already shared Instagram Insights and Meta Business Suite data with Claude, but I'm looking for something deeper. What I want is for Claude to effectively act as a content strategist by analyzing: Reels and videos, **Audience retention drops**, Hook effectiveness, Content themes, **Engagement patterns**, Lead-generation potential. … if a reel loses 40% of viewers in the first 3 seconds, I'd like Claude to help identify whether the issue is the hook, pacing, visuals, messaging, or something else."

> "I've seen many creators say things like 'I gave Claude access to my Instagram and it helped me grow from 20 followers to 20k,' **but I'm not sure what their actual setup looks like.** … Are you using: Meta APIs? MCP servers? Zapier, Make, n8n, or another connector? A custom solution? **Manual exports from Meta Business Suite?**"

> "**How safe is it to give a third-party connector access to an Instagram business account? Are there any security or privacy concerns I should be aware of?**"

**The answers the community actually gave:** "Have you tried Apify connector?", "apify scraper is going to be your best best … take advantage of their free 5$ credit", "Windsor.ai", "Catchr.io", "Vaizle AI", "Planoly".

Two signals here:
1. **Demand is for analysis, and the user is explicitly unsure what is real.** Manual export is listed as a live option — the data-export path IGTrack supports is a real workflow, not a fallback nobody uses.
2. **Every recommendation is paid, hosted, and third-party.** Nobody offered a self-hosted, free, honest option, because none was in the candidate set.

### 4c. MCP reliability, auth and trust complaints

r/mcp — **"Anyone using MCP in production? Curious about real-world security..."**
<https://www.reddit.com/r/mcp/comments/1nldx5m/anyone_using_mcp_in_production_curious_about/>
> "Everyone should have security concerns with MCP servers … Things like **rate limits getting imposed, scale and reliability**."

Other recurring threads (titles + URLs, descriptions from search results):
- r/mcp **"How are you handling OAuth when running MCP servers remotely?"** — *"one of the pain points I keep hitting is around OAuth"* — <https://www.reddit.com/r/mcp/comments/1mw09b5/>
- r/mcp **"MCP is a security nightmare"** — *"Is anyone working on solving the security issues set forth by the current standard?"* — <https://www.reddit.com/r/mcp/comments/1jr7sfc/>
- r/mcp **"MCP servers are scary unsafe. Always check who's behind them!"** — <https://www.reddit.com/r/mcp/comments/1mbb1yf/>
- r/mcp **"Is building paid/premium MCP servers actually a viable business?"** — *"paid servers would have to win on reliability, security, support, and specificity"* — <https://www.reddit.com/r/mcp/comments/1mbpjr1/>
- r/mcp **"MCP for social media — looking for feedback on useful social media agent workflows"** — <https://www.reddit.com/r/mcp/comments/1s4gf6l/>
- r/ClaudeAI **"Claude Code got my Meta ads account permanently banned"** — <https://www.reddit.com/r/ClaudeAI/comments/1sg6vpl/>

### 4d. Agent observability

- r/LangChain — **"What are you using for AI agent observability in production"** — *"I'm trying to understand how people are actually handling observability for their agents in production — **not the docs version, the real version**."* — <https://www.reddit.com/r/LangChain/comments/1u94l1j/>
- r/Observability — **"Observing AI agents: logging actions vs understanding decisions"** — *"logs tell you 'what happened,' but without linking steps or reasoning you [can't tell why]"* — <https://www.reddit.com/r/Observability/comments/1pq49fd/>
- HN Ask — **"Multi-agent workflows in production"** (comment 49692303) — *"does anyone have any recommendations for stronger multi-agent observability. **I've not really seen anything outstanding in this space yet**"* — <https://news.ycombinator.com/item?id=49692303>
- HN comment 48265161 — a list of 8 operator reports of **"Dispatch fabrication … subagent reports 'task completed' with zero corresponding tool invocations"** — described as *"verification theater at compounding rate"* — <https://news.ycombinator.com/item?id=48265161>
- r/AI_Agents — **"Nobody agrees on what 'hallucination' means"** — *"the AI made something up that wasn't in any source"* — <https://www.reddit.com/r/AI_Agents/comments/1t68i2j/>

---

## 5. TRUST/PROVENANCE EVIDENCE (verbatim + URL)

### 5a. STRONGEST SUPPORT — the market has independently arrived at "tools return data, not prose"

r/mcp — **"The best thing I did for my MCP server was stop letting tools write prose"**
<https://www.reddit.com/r/mcp/comments/1uw8gjr/the_best_thing_i_did_for_my_mcp_server_was_stop/>

> "I spent the first version of my MCP server having tools return nice human-readable summaries. … **It felt helpful. It was actually the thing holding the whole server back.** Here is what changed once I made tools return only structured data and let the model own every word:
> - **Consistency went up.** When the tool writes the sentence, you get the tool author's phrasing forever.
> - **Composability went up.** A tool that returns numbers can feed the next step. **A tool that returns a paragraph is a dead end**, since the model has to parse English back into values to use it.
> - **Debugging got easier.** Structured output either matches the schema or it does not. **Prose output 'looks fine' right up until the model misreads it.**
> - **Token cost dropped.**
>
> The rule I settled on: **a tool returns what it computed, nothing about how to say it.**"
> — `Street_Inevitable_77` (5 upvotes)

> "This is called **response shaping** and an MCP server should never shape responses in a way that alters their interpretation. … It is MCPs job to tell a model what tools are available, what they offer, and how to use them. **It is not really MCPs job to tell the model how to interpret that data.** … Otherwise, **return an abstraction code and a correlation Id** that you can use to support the problem."
> — `brokerceej`

The OP's follow-up names the distinction precisely:

> "stripping cursors and meta filters is lossless, the same data with the plumbing removed, **whereas turning a number into a sentence is a lossy reinterpretation.** They feel like the same cleanup instinct until you name them apart."
> — `Street_Inevitable_77`

> "the moment our tools returned tight structured results instead of prose the client stopped choking on context and tool selection got more reliable."
> — `Future_AGI`

**This is the single best piece of supporting evidence for "evidence-first".**
It is a 2026 r/mcp front-page-of-the-subreddit conversation, from an unrelated
builder, independently converging on: structured-not-prose, tool-author's-phrasing
is a bug, "looks fine" is the failure mode, and errors should be typed codes.
That is IGTrack's design, arrived at from the opposite direction.

### 5b. "Failures look like nothing broke" — the exact failure class IGTrack exists to prevent

r/mcp — **"MCP servers aren't just servers — they're delegated authority"**
<https://www.reddit.com/r/mcp/comments/1qh45dg/mcp_servers_arent_just_servers_theyre_delegated/>

> "MCP servers don't just expose data or automation hooks — they delegate **authority** to an autonomous agent, without the deterministic guardrails we're used to in REST, webhooks, or workflow tools. In practice, this means:
> * **failures often look like 'nothing broke'**
> * prompt injection becomes an authorization problem, not a content problem
> * capability creep happens quietly through composition
> * responsibility still lands on the org, not the model"
> — `pstryder`

> "Authority used to be entirely derived from the user, but we've entered a regime when it now may be implicit, instead of explicit. In such a case, **the tools must better enforce the contract that was implicit in the security and access model, and include enforcement of an accountability layer that is potentially missing when naively implementing MCP servers.**"
> — `pstryder`

*"Failures often look like 'nothing broke'"* is a one-line description of a
metric that silently reads `0` because the read failed. And the response —
"the tools must enforce the accountability layer" — is precisely the
capability registry + evidence ledger.

### 5c. Supply chain: nobody can tell a good MCP server from a bad one

- **Cloud Security Alliance Labs**, *"MCP Security Crisis: Systemic Design Flaws in AI Agent Infrastructure"* — <https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-security-crisis-20260504-csa-styled/> ★ *"The first confirmed in-the-wild malicious MCP server appeared in September 2025, when a package named `postmark-mcp` — an impersonation of a legitimate Postmark email integration — **shipped fifteen clean versions to a public npm registry to establish a trust baseline** before version 1.0.16 silently added a single line that blind-carbon-copied every outgoing email to an attacker-controlled address."*
- **Practical DevSecOps**, *MCP Security Statistics 2026* — <https://www.practical-devsecops.com/mcp-security-statistics-2026-report/> ★ *"30–82% of public MCP servers carry exploitable flaws, only 8.5% use OAuth"* (publisher's summary figure; not independently reproduced here).
- **Checkmarx**, *11 Emerging AI Security Risks with MCP* — *"Clients that automatically trust the updated server unknowingly get compromised."* — <https://checkmarx.com/zero-post/11-emerging-ai-security-risks-with-mcp-model-context-protocol/>
- r/programming — *"MCP Security is still Broken"* — *"There is no security in its design and it's design means it can't be secure. **You are essentially running programs or calling 3rd party services.**"* — <https://www.reddit.com/r/programming/comments/1lgoa1b/mcp_security_is_still_broken/>

### 5d. HN on tool-output poisoning and the limits of "just be careful"

- **"Poison everywhere: No output from your MCP server is safe"**, 158 points — <https://news.ycombinator.com/item?id=44219755>
  > "This is an extension of previous reports that MCP tools you install can do bad things, so you need to be careful about what you install. I quite like this example of **parameter poisoning** … That's cute: a naive MCP client implementation might give the impression that this tool is 'safe' (by displaying the description), **without making it obvious that calling this tool could cause the LLM to read that `~/.ssh/id_rsa` file and pass that to the backend as well.**"
  > — `simonw`
  > "This is pretty much the definition of a supply chain attack vector. **Problem is — how many people will realistically take your advice of: Be careful what you install!**"
  > — `AdieuToLogic` (comment 44221113)
  > "So long as the control messages and the processed results are the same channel, they will be at an insecure standoff."
  > — `th0ma5` (comment 44221156)
- **"Damn Vulnerable MCP Server"**, 227 points — <https://news.ycombinator.com/item?id=43707021>
  > "The MCP spec makes it pretty clear that MCP servers are expected to be run in environments that are **implicitly trusted/trustable** for any client that can reach them. … In short, MCP servers are not meant to be accessible as public APIs … **It doesn't seem like this is widely understood.**"
  > — `kiitos` (comment 43708736)
- Security researcher, HN comment 44853596 — <https://news.ycombinator.com/item?id=44853596>
  > "**this type of hallucination and trust is one of the largest things we exploit** in our new LLM testing service. … we can plant what I have internally coined an 'unfolding injection.'"

### 5e. Provenance as the industry's stated remedy

- **Olostep**, *Data Provenance for AI Agents* — <https://www.olostep.com/blog/data-provenance-for-ai-agents>
  > "**Provenance does not stop a model from hallucinating, but it makes wrong claims easier to find.** With claim-to-source links, a reviewer can check…"

  This is an honest statement of the ceiling, and it is the right one to adopt:
  provenance is **auditability**, not correctness. IGTrack should say exactly this
  and no more.
- **Atlan**, *AI Agent Hallucination* — <https://atlan.com/know/ai-agent-hallucination/>
  > "*No provenance tracking*: Without decision traces, organizations can't identify why an agent acted incorrectly or detect patterns."
  > (also claims: governed metadata as agent context → "+38% relative SQL accuracy, 174 queries, 522 evaluations; p < 0.0001" — vendor-run study.)
- HN comment 48150139 — <https://news.ycombinator.com/item?id=48150139> ★
  > "the uncritical injection of insane, LLM generated bullshit into official business documents (fake KPIs for unmeasurable outcomes, references to nonsensical or non-existent process, **data-driven decisions backed by hallucinated data**. etc.)"
- HN comment 48124262 — <https://news.ycombinator.com/item?id=48124262> ★
  > "When Google first added Gemini to Sheets, I tried it and it **completely hallucinated transaction data** on the bank statement I was testing it on. **It's worse than incomplete, it's broken and dangerous.**"

### 5f. REFUTING / AGAINST — honest counterweights

The "evidence-first" pitch is not universally valued. Recorded so the positioning
is not built on one-sided evidence:

1. **"MCP servers are just tools."** r/mcp, `Jdonavan`, score 2, on the delegated-authority thread:
   > "MCP servers are just tools…."
   and `AyeMatey`:
   > "People seem to think MCP somehow requires new laws of physics or new mental models. It doesn't. The agent is the novel thing. … **You don't need a different mental model.** It might be easier if you just dropped the MCP term from your language and just talked about **tools.**"
   — <https://www.reddit.com/r/mcp/comments/1qh45dg/>

   **Implication:** do not market provenance as a "new paradigm". Market it as
   bookkeeping for a real, named failure mode.

2. **"Provenance is infeasible at scale"** — HN comment 36657209, on poisoning:
   > "it's not clear that enforcing a chain of model provenance is the correct approach to solve the problem of 'poisoned' data. **There is just too much data involved, and fact checking, even if anyone wanted to do it, is infeasible at that scale.**"
   — <https://news.ycombinator.com/item?id=36657209>

   **Implication:** scope the claim. IGTrack cannot verify that an observed
   follower count is *true about the world*; it can verify that it was
   *actually observed, once, from a named source, at a named time*. Be precise.

3. **"Hallucination" is a contested term** — HN comment 46355090 and r/AI_Agents
   <https://www.reddit.com/r/AI_Agents/comments/1t68i2j/> and HN 46355090:
   > "hallucinate is a wrong choice IMO. … we should distinguish between different semantic errors, such as: confabulating … lying … bullshitting…"
   — <https://news.ycombinator.com/item?id=46355090>

   **Implication:** IGTrack already distinguishes structural-unavailable from
   call-failed from genuinely-empty. That precision is a differentiator against
   the whole fuzzy "hallucination" discourse — but the words must stay exact.

4. **Cost of honesty is real.** ~60 registry servers and ~18 GitHub repos
   compete on breadth of tools and convenience. `pg`-only, no-telemetry,
   self-hosted will lose on "just works" for casual users. The users quoted in
   §4a are *asking* for exactly what is missing, but they are also choosing
   Apify.

### 5g. §5 verdict

Evidence **supports** evidence-first as a selling point, with two caveats:

- **Supported:** the structured-not-prose doctrine (§5a), the
  "failures look like nothing broke" framing (§5b), the supply-chain trust
  vacuum (§5c/§5d), and the "makes wrong claims easier to find" framing (§5e)
  are all independently articulated by non-IGTrack sources in 2026.
- **Not supported as a mass-market differentiator:** most users choose on
  convenience and price; the §5f objections are live. Provenance is a *trust and
  audit* feature that will win with operators who have a reason to need it
  (compliance, KYB, journalism, research), not with people scheduling Reels.

---

## 6. TAKEAWAYS FOR IGTRACK

1. **The entire named competitor set is dead or in permanent breakage.** `dilame/instagram-private-api` (6.5k★) last pushed 2024-08; `toutatis` (4.4k★) 2024-12 with 366 open issues; Meta archived both of its own SDKs. Only `instaloader` (13.6k★, 223k PyPI downloads/mo) and `instagrapi` (6.9k★) are alive — and both have open issues this month for 429s, removed endpoints, and silently-swallowed challenge errors. **A maintained, lawful, evidence-producing alternative has no incumbent.**

2. **`instagrapi` has already conceded the data fight and become a SaaS.** Its description now reads "with HikerAPI SaaS", and its open issues (#2875, #2873, #2871, #2870) are all about maintaining plausible impersonation identity. Do not compete there. The Graph API + data-export path is the side of the line that survives.

3. **60 Instagram MCP servers exist; not one is evidence-first.** Zero expose an append-only ledger, raw+normalized hashes, source id, observed-vs-captured time, or a structural `UNAVAILABLE`-with-reason. The nearest thing (`Nooticr`) advertises "hands back the material rather than a verdict" — evidence-first *framing* with none of the machinery. Highest-star IG-adjacent MCP is `meta-ads-mcp` at 1,305★ and it is ads-only. **This is whitespace, and it is whitespace in exactly the shape of IGTrack's invariants.**

4. **The market has independently written IGTrack's design doc, and it is on r/mcp.** [r/mcp 1uw8gjr](https://www.reddit.com/r/mcp/comments/1uw8gjr/): *"a tool returns what it computed, nothing about how to say it"*, *"prose output 'looks fine' right up until the model misreads it"*, *"turning a number into a sentence is a lossy reinterpretation"*. Cite this in the README. It is better marketing copy than anything IGTrack could write, because IGTrack did not write it.

5. **"Failures often look like 'nothing broke'" is the headline.** [r/mcp 1qh45dg](https://www.reddit.com/r/mcp/comments/1qh45dg/) names IGTrack's core invariant as its own problem statement. Astronauts of the category are asking for "an accountability layer that is potentially missing when naively implementing MCP servers". Lead with silent-wrong-zero, not with "provenance".

6. **"Fail loudly" is the feature users can actually test for.** §4a: *"the ones that hold up return structured data and fail loudly when they cannot"* — that is one line in a README and one command in the CLI. Make `igtrack status` and the `unavailable` reason string the demo.

7. **The demand-side gap is a real, quoted, unsolved user.** The r/ClaudeAI real-estate marketer asked for Reel retention-drop analysis, audience patterns and lead-gen insight, explicitly listed "manual exports from Meta Business Suite" as a workflow, and asked *"how safe is it to give a third-party connector access to an Instagram business account?"* Every answer was a paid scraper. **That user is IGTrack's persona.** Note the honest limit: retention/Insights data is *owned-account* data — that is a Graph API scope question, not a scraping question, so it is answerable without moving the §3 line.

8. **But do not oversell provenance.** §5f is real: "just tools", "provenance is infeasible at scale", paid-and-hosted wins on convenience. The defensible claim is narrow and exactly the Olostep one: *provenance does not make claims true, it makes wrong claims findable.* Say that, and say the `UNAVAILABLE` reasons, and let the ledger do the rest.

9. **Registry placement is free distribution.** 60 Instagram servers ship through `registry.modelcontextprotocol.io` and every serious social MCP appears in the curated `awesome-mcp-servers` social-media doc (57 KB, updated within hours of writing). Publishing IGTrack as a registered MCP server with a distinctive `_meta` block is a cheap, high-leverage discovery move — but the `_meta` block must be visible on *every* tool return or it is indistinguishable from the pack.

10. **Structural `UNAVAILABLE` is now backed by published policy, not just principle.** Storrito's 2026 explainer states plainly: *"What you can't access: other users' profiles or content, public hashtag streams, competitor behavior, follower lists, or broad discovery data"* and *"Official APIs in 2026 only allow access to accounts authorized by the user (business/creator)."* A tool that says "the platform does not expose follower lists — here is the reason" is now stating documented vendor policy, not an excuse. That is a capability matrix entry, not an error path.

---

## Appendix — source commands

```bash
gh api repos/OWNER/REPO --jq '{n:.full_name,s:.stargazers_count,p:.pushed_at,a:.archived,l:.license.spdx_id,oi:.open_issues_count,fs:.forks_count}'
gh issue list --repo instaloader/instaloader --search '429' --limit 8 --state all --json number,title,state,createdAt,comments
gh search repos "instagram mcp" --sort stars --limit 25 --json fullName,stargazersCount,description,pushedAt,isArchived
curl.exe -s "https://registry.modelcontextprotocol.io/v0/servers?search=instagram&limit=100"
curl.exe -s "https://hn.algolia.com/api/v1/search?query=<q>&tags=comment&hitsPerPage=12"
opencli reddit read "<thread-url>" -f yaml
opencli pypi downloads instaloader
opencli npm downloads instagram-private-api
```

Note on `gh` field names, since they cost time: `gh search repos` uses
`stargazersCount`; `gh repo view` uses `stargazerCount`; neither accepts
`archived` (use `isArchived` / `archivedAt`), and `gh issue list` rejects a
leading-`--repo` empty search.

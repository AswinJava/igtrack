# Market research synthesis — Instagram observation tools, October 2026

**Date:** 2026-10-15 · **Status:** adopted · **Feeds:** `docs/FOUNDING.md` §13 (Phase D)

Four read-only research streams were run against the live market (vendor pricing pages,
Meta's own documentation, Reddit threads read verbatim, GitHub, and the official MCP
registry). Full evidence, with every URL and verbatim quote, lives next to this file:

| # | Stream | Evidence file |
|---|---|---|
| 01 | Analytics / social-media-management tool market (pricing, retention tiers, user expectations) | [01-analytics-market.md](01-analytics-market.md) |
| 02 | Tracking / OSINT / unfollower tool market (risk, legality, accuracy) | [02-tracking-osint-market.md](02-tracking-osint-market.md) |
| 03 | Open-source and agent/MCP ecosystem | [03-oss-agent-ecosystem.md](03-oss-agent-ecosystem.md) |
| 04 | Platform API reality (what Instagram actually exposes, 2022–2026) | [04-platform-api-reality.md](04-platform-api-reality.md) |

Method note: several "best tools 2026" roundups are vendor-authored (SocialPilot,
OwlStat, OctoSpark, a SocialRails founder). Their pricing tables were used; their
recommendations are flagged `[vendor-authored]` in stream 01 and not treated as
evidence. One user claim that contradicts Meta's own help pages ("Meta Business has
all time analytics") is recorded in stream 01 as **contested**, because it is the
first objection IGTrack will face.

---

## 1. What the market is

The category splits into three pricing geometries, and the geometry matters more than
the headline number (stream 01):

- **Per seat** (Hootsuite $99–399/seat/mo; Sprout $79–399/seat/mo) — four people on
  Hootsuite Professional is **$796/mo**.
- **Per profile/channel** (Buffer from $5/channel/mo; Socialinsider from $82/mo for
  20 profiles; Minter.io ~$8.25/profile/mo).
- **Per brand / flat** (Metricool from ~$22/mo; SocialPilot from ~$25.50/mo).
- **Free native** (Instagram Insights / Meta Business Suite) — **90 days**, and the
  window is *shrinking* in places (users report 7/30-day presets appearing).

Two facts about this market do the heavy lifting for positioning:

1. **Retention is the category's favourite thing to charge for.** Socialinsider tiers
   history 3/6/12 months (year-over-year starts at $199/mo, not $82). Later sells
   3 months / 1 year / 2 years. Buffer sells 30 days vs unlimited. Six of twelve
   surveyed tools publish **no retention window at all** — including Sprout at
   $299/seat/mo `[vendor-authored]`.
2. **Meta now charges for the retention gap directly.** Meta One's paid plans list
   *"Extended Insights History (Instagram): See and download data … beyond 90 days"*
   ([meta.com help](https://www.meta.com/help/subscriptions/882345181477896/),
   [facebook.com/business/news](https://www.facebook.com/business/news/introducing-meta-one-plans-for-businesses)).
   IGTrack's core promise — history you own, kept by you — is a **direct free
   substitute for a priced Meta SKU**.

**History cannot be bought retrospectively at any price.** Any tool's backfill reads
only what Instagram still stores: at most 90 days, once. A tool's history compounds
with tenure. An incumbent cannot pay to jump that queue — the honest pitch is
*"start recording now"*.

**MCP is already table stakes, not a differentiator.** Metricool lists "Metricool MCP"
on its **free** plan; Sociality.io restructured its pricing page entirely around
"teams and AI agents." Agent reachability is becoming standard; what is not standard
is what the agent is allowed to *claim* (streams 01, 03).

## 2. What users demand — and what they get

Ranked by frequency × intensity across the collected threads (streams 01, 02):

1. **History that outlives the platform.** Beyond 90 days. Now behind Meta's paywall.
2. **A single follower-change number, and an unfollower list.** The native total-change
   metric was *removed*; the legitimate path is the operator's own data export, which
   users already diff by hand against listdiff-style sites — and one user reports Meta
   *degrading the export layout* to make HTML diffing harder. The demand is so strong
   that users attempt third-party apps and lose accounts for it: *"i got permanently
   disabled for using it, had to spend alot of time and money to get it back"*
   (r/Instagram).
3. **Hourly / by-country / by-day granularity**, and **demographic trend lines** —
   which the platform exposes only as a *current-state snapshot*, not a time series.
   "A tool showing 'audience by country for March' is showing today's audience under a
   date picker the API ignored. Storing monthly snapshots is the only way to get the
   trend" (stream 01, quoting a vendor analysis of Meta docs).
4. **Reconcilable numbers, or an explanation.** Same client, same period: *"Meta said
   80k, Iconosquare said 140k, Buffer said 120k"* (r/SocialMediaManagers). No product
   explains the difference.
5. **Save/share-level visibility per post** — exists at media level in the API; a
   product-surface gap rather than a platform gap.
6. **Reporting that is not an eight-hour manual job** — *"I am generating 16 reports
   on our numbers every year"* (r/SocialMediaMarketing).

The exhaustion baseline matters most for tone: *"Lmftfy. All social media analytics
are garbage."* — and, in a reporting thread: *"I genuinely don't believe any product
can do it to a good enough standard… Companies (including Sprout) promise this kind of
'automation' but the end product is shit and inflexible."* Blended reporting is a
**discredited promise**. A tool that answers "here is what was observed, here is what
was not, here is why" is not competing on the axis users stopped believing — it
changes the axis.

## 3. Where IGTrack already stands (mapped to evidence)

| Market complaint | IGTrack today |
|---|---|
| History beyond 90 days | **Solved in kind**: append-only snapshots with observed-vs-captured time. History starts the day recording starts — the honest pitch. |
| Single follower-change number / unfollowers | **Solved lawfully** (Phase B `import:v1`): the operator's own export → snapshots → `follow_deltas` ("newly observed" / "no longer observed"), COMPLETE-only diffs. This is the exact manual workflow the community recommends (r/Instagram 1,748-upvote export guide) — automated, and never a ban risk. |
| Numbers that don't reconcile | **Solved by construction**: every stored claim carries source id, raw/normalized hashes, observed vs captured time, confidence. A number can be audited, and two numbers can be *explained*. |
| Absence rendered as zero | **Invariant #1**, enforced by tests. The market treats this as a product difference ("a tool that plots zeros will invent fake crashes on your charts"). |
| Metric definitions changing under users (impressions → views, 2024-07-02) | **Solved by design**: a claim records what the provider said, when; a joined line across definitions cannot be produced silently. |
| Agent access | **Present where the market is just arriving**: CLI + MCP with typed errors and honest `_meta`. Stream 03 found **zero** of ~78 surveyed Instagram MCP servers expose an append-only ledger, hashes, or UNAVAILABLE-with-reason. |
| Demographics / hourly reach / own-account trends | **Not yet observed.** This is the largest in-scope gap (see §5). |

Stream 03's two quotes name IGTrack's thesis in strangers' words (r/mcp):
*"a tool returns what it computed, nothing about how to say it"*, and — on failure
modes — *"failures often look like 'nothing broke'"* with a call for tools that
*"include enforcement of an accountability layer"*. Lead with that, not with
"provenance".

## 4. What the platform actually allows (summary of stream 04)

- **Two products, not one.** Instagram Login (no Business Discovery, no Hashtag
  Search) vs Facebook Login (Page-linked; both cross-account routes).
- **Own-account observation needs no App Review.** Meta, verbatim: *"If your app only
  serves your Instagram professional account or an account you manage, Standard
  Access is all your app needs"* (updated 2026-06-30). Every gate, cost and rejection
  lives on the *other-account* routes.
- **The social graph is structurally unobservable**: no follower/following/liker/
  story-viewer/reposter edges exist. Not a permissions tier — the shape of the
  platform.
- **The data export is the only lawful follower-identity source.** `followers_N.json`
  + `following.json`; `timestamp` = follow-creation time; export delivery 30 days,
  download link valid 4 days.
- **Insights are documented and available to the owned account** (IG User insights,
  updated 2026-06-16): `reach`, `views`, `accounts_engaged`, `total_interactions`,
  `follower_count`, `follows_and_unfollows`, `follower_demographics`, `online_followers`
  and more; `impressions` deprecated; **unavailable metrics return an empty data set,
  not 0**; demographics are top-45 with a 48 h delay; `follower_count` and
  `online_followers` are unavailable below 100 followers; account insights default to
  a 24-hour lookback if `since`/`until` are omitted.
- **Business Discovery** (other public professional accounts) is alive but is a
  Facebook-Login-only edge, gated behind app review, age-gated accounts return
  nothing, and it exposes only public profile fields + media `like/comment/view_count`
  — **no reach, no saves, no demographics**. It is the edge every competitor-tracking
  product is forced to stand on.
- **Scraping is a dead end on every axis** (streams 02, 04): documented bans and
  forced password resets (Instaloader #1836/#2508, cookie auth broken again Mar 2026
  and closed *not planned*), residential proxies at $7–8/GB on top of per-result fees,
  and an OSINT tool market visibly collapsing (40+ anonymous-viewer tools died
  2024–25; both iganony domains are now registered to Meta). The one favourable
  ruling (*Meta v. Bright Data*, 2024) covers logged-off public collection only; the
  2025 Terms added a logged-in clause that is untested in court.

## 5. The gaps worth closing (and the ones to keep refusing)

**In scope, supported by evidence, not yet built — chosen for Phase D:**

- **Own-account insights over time (`ACCOUNT_INSIGHTS`).** The documented IG User
  insights edge, observed against the owned account (Standard Access; D4-compatible).
  It answers market demands #1, #3 and part of #2 directly: `follower_count` as a
  time series (the metric native Instagram removed), daily `reach`/`views`/
  `accounts_engaged`/`total_interactions`, and `follower_demographics` captured as
  point-in-time snapshots — the *only* way a demographic trend line can honestly
  exist. Absences (below 100 followers, 48 h lag, empty-set-not-zero) are stored as
  absences with the documented reason. Implemented in Phase D; see FOUNDING.md §13.

**Named, deferred, with reasons:**

- **Business Discovery (competitor tracking).** The market's biggest paid category —
  Socialinsider's entire product, Metricool/Hootsuite/Later competitor tiers — and the
  honest version does not exist (every competitor "reach" number is a derived
  estimate, admitted even by vendors). But it requires (a) changing the founding
  non-goal "monitoring accounts you do not own", (b) a Facebook-Login product +
  app review, and (c) accepting a narrow, age-gate-prone edge. This is a genuine
  scope decision for a founder pass *with live credentials to verify against*; it is
  recorded here rather than slipped in.
- **`igtrack bench`** — still no measured need (D-decision from Phase C stands).
- **Highlights, liker lists, interaction feeds, story-viewer identities, media bytes**
  — `DOCUMENTED_ABSENT`; unchanged by this research.
- **Hashtag attribution ("who arrived from a hashtag")** — not exposed by any
  supported interface; remains UNAVAILABLE with reason, exactly as the market's most
  sophisticated users already suspect.
- **Watchlist→alert alerts**: already deliverable through the agent today
  (`igtrack activity --since`); no new machinery justified by the evidence.

**Contested/uncertain, carried forward honestly:** the "Meta Business Suite already
shows all-time analytics" claim (stream 01, marked contested); Keyhole,
NotJustAnalytics and SocialBlade tier figures unverified; enterprise vendor pricing
beyond list prices not scraped.

## 6. Positioning consequence (one paragraph)

The honest product in this market is not a better dashboard; it is a **recording
instrument with an audit trail**, sold free and self-hosted, that answers with
evidence and refuses with reasons. The paid market cannot copy the honesty stance
without breaking its own retention-tier business model, and the scraping ecosystem is
dying under bans. The remaining work is to cover the *own-account* data the official
API does expose (insights — Phase D) while holding the line on everything it does not.

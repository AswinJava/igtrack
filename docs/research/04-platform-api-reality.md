# 04 — Platform API Reality: Instagram / Meta

**Research date:** 2026-10-15
**Scope:** what an operator-facing observation engine can *lawfully and actually* obtain from Instagram in late 2026, via (a) official Meta APIs and (b) the operator's own data export — plus the honest boundary of what is not obtainable at all.
**Method:** primary Meta developer documentation (`developers.facebook.com/documentation/...`, fetched via text-extraction proxy), the Instagram Platform changelog, third-party 2026 practitioner write-ups, and vendor bug-tracker issues. Every claim carries a source and a date. Where sources conflict, both are recorded.

**Reading note for IGTrack:** Meta's own docs are the only source of *positive* capability claims. Every row in §2 (NOT EXPOSED) is an **absence**, and absence in documentation is weaker evidence than presence — it is recorded as "no documented route exists as of `<date>`, and no third-party source reports otherwise", never as "impossible forever".

---

## 1. EXPOSED VIA OFFICIAL API

### 1.1 Two separate products, not one

Meta ships two distinct Graph products for Instagram. They have different scopes, different account requirements, and different field availability. Conflating them is the single most common documentation error in the ecosystem.

| | Instagram API with **Instagram Login** | Instagram API with **Facebook Login** |
|---|---|---|
| Requires a Facebook Page | No | Yes (Page linked to the IG professional account) |
| Scope names | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_content_publishing`, `instagram_business_manage_messages` | `instagram_basic`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages`, `instagram_content_publishing`, `pages_read_engagement`, `pages_show_list`, … |
| Business Discovery | **No** | **Yes** |
| Hashtag Search | **No** | **Yes** |
| Platform support | "Web or mobile Web is the only platform that currently supports Instagram API with Instagram Login" |
| Source | `https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login` (fetched 2026-10-15); `https://developers.facebook.com/documentation/instagram-platform/app-review` (Updated 2026-06-30) |

The Instagram-Login product explicitly **cannot access ads or tagging**. (Source: same overview page, fetched 2026-10-15.)

### 1.2 Exposed capabilities

| Capability | Route (edge / field) | Limits & caveats | Source |
|---|---|---|---|
| Own-account profile counts | `IG User`: `followers_count`, `follows_count`, `media_count` | Own account only (or Business Discovery for others, §1.3) | IG User reference, **Updated 2026-04-22** |
| Own-account profile text/media | `biography`, `name`, `username`, `website`, `profile_picture_url`, `has_profile_pic`, `is_published`, `alt_text`, `shopping_product_tag_eligibility` | — | same |
| List of own media | `IG User` → `media` edge | Cursor pagination only | same |
| Stories | `IG User` → `stories` edge | Insights available **only ~24 h**; use `story_insights` webhook for anything durable | IG User reference (2026-04-22); `https://wearesculpt.com/blog/export-instagram-stories-analytics` (**2026-08-19**): "Stories insights are only available for 24 hours, even if the stories are archived or highlighted" |
| Live media | `live_media` edge | — | IG User reference (2026-04-22) |
| Publishing | `media_publish`, `content_publishing_limit`, `collaboration_invites`, `collaborative_media` | Stories publishable by **business** accounts only (not creators) | IG User reference (2026-04-22); `https://developers.facebook.com/docs/instagram-api` (**Updated 2025-03-03**) |
| Comment moderation | `mentioned_comment`, `mentioned_media`, `mentions` edge, `is_comment_enabled`, `comments_count` | Mentions on Stories not supported; no commenting on photos you were tagged in; webhooks suppressed if the mentioning media came from a private account | `.../instagram-graph-api/reference/ig-user/mentions` (Updated **2025-01-21**; fetched 2026-10-15) |
| Per-media public metrics | `IG Media`: `comments_count`, `like_count`, `view_count`, `media_type`, `media_product_type`, `caption`, `permalink`, `shortcode`, `timestamp`, `username`, `owner`, `thumbnail_url`, `media_url` | `like_count` omitted when the owner hid like counts. `saved_count` only for media owner / accepted collaborator — not via Business Discovery, tags, mentions, or hashtag search. `shares_count` not via Business Discovery or hashtag search. `total_views_count` not via Business Discovery (use `view_count`). `media_url` **withheld** in some cases — see §4 | IG Media reference (fetched 2026-10-15); `https://developers.facebook.com/documentation/instagram-platform/changelog` (**Updated 2026-10-05**) |
| New engagement fields (2026) | `reposts_count`, `saved_count`, `shares_count`; aggregated `total_like_count`, `total_comments_count`, `total_views_count` | Availability varies by route (see above) | Changelog entry **2026-04-22** |
| Content provenance label | `is_ai_generated` (AI Info Label) | Read-only | Changelog entry **2026-06-22** |
| Audio metadata | `media_audio_type`; Instagram Audio API | Added with the Audio API | Changelog entries **2026-06-01** |
| Own-account insights | `IG User` → `insights`: `accounts_engaged`, `comments`, `engaged_audience_demographics`, `follows_and_unfollows`, `follower_demographics`, `likes`, `profile_links_taps`, `reach`, `replies`, `reposts`, `saves`, `shares`, `total_interactions`, `views` (`impressions` deprecated) | `follower_count` and `online_followers` **unavailable below 100 followers**; empty data set returned instead of 0; demographics are **top-45 only** with a **48 h delay**; breakdowns limited to `contact_button_type`, `follow_type`, `media_product_type`; `metric_type` = `time_series` or `total_value` | `.../api-reference/instagram-user/insights` (**Updated 2026-06-16**) |
| Per-media insights | `IG Media` → `insights`: `comments`, `crossposted_views`, `facebook_views`, `follows`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `likes`, `link_clicks`, `navigation`, `profile_activity`, `profile_visits`, `reach`, `reels_skip_rate`, `replies`, `reposts`, `saved`, `shares`, `total_interactions`, `views` (+ `total_comments` / `total_likes` / `total_views` on FB Login only) | Story metrics require ≥5 viewers (error code 10 otherwise) and expire at 24 h; insights **not available for media in an album**; metrics retained **up to 2 years**; `impressions` deprecated for media created after **2024-07-02** | `.../instagram-platform/reference/instagram-media/insights` (**Updated 2026-09-11**) |
| Other-account public profile + media (Business Discovery) | `IG User` → `business_discovery`: public profile fields + `media` edge with `comments_count`, `like_count`, `view_count` | **Facebook Login product only.** Requires `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` (+ `ads_management`/`ads_read` if Page role granted via Business Manager). **No `previous`/`next` paging** — page from `before`/`after` cursors manually. Age-gated accounts return **nothing**. A direct GET on a returned IG Media ID fails with insufficient permissions. `view_count` via Business Discovery was added **2025-06-16** for Reels | `.../instagram-api-with-facebook-login/business-discovery` and `.../instagram-graph-api/reference/ig-user/business_discovery` (**both Updated 2026-08-12**) |
| Other-account media by hashtag (Hashtag Search) | `GET /ig_hashtag_search`, `GET /{ig-hashtag-id}`, `/{ig-hashtag-id}/top_media`, `/{ig-hashtag-id}/recent_media`, `/{ig-user-id}/recently_searched_hashtags` | Max **30 unique hashtags per rolling 7 days** per Business/Creator account; *fetching media counts as querying*; cannot comment on hashtagged media; no story hashtags; no emojis; requires App Review for the `Instagram Public Content Access` feature + `instagram_basic` | `.../instagram-api-with-facebook-login/hashtag-search` (**Updated 2026-08-17**) |
| Content deletion | `DELETE /{ig_media_id}` with `instagram_manage_contents` | Own media | Changelog entry **2025-12-03** |
| Messaging | Conversations / messages / private replies; `POST /{ig-user-id}/mentions` for comment replies | 2 calls/sec/account; 100/sec private replies to Live comments; 750/hour private replies to post or reel comments; 100/sec text/link/reaction/sticker; 10/sec audio/video | `.../instagram-platform/overview` (**Updated 2026-09-28**); `.../reference/ig-user/mentions` (2025-01-21) |
| Webhooks | media, comments, mentions, messages, story_insights, and (2026-09-16) a Webhooks documentation section | Insights webhook **not supported** for Instagram Login | Changelog entries **2025-09-10**, **2026-09-16**; IG Media insights page (2026-09-11) |
| oEmbed | Public oEmbed without an access token | Available since **2026-05-15**; replaces the deprecated oEmbed Read (Meta oEmbed Read deprecated **2025-11-03**) | Changelog entries **2026-05-15**, **2025-04-08** |

### 1.3 Coverage ceiling of the exposed set

- Business Discovery surfaces only **public Business/Creator profiles** — never consumer accounts, never private accounts.
- One line from Meta's own overview governs the entire permission model: *"a permission only allows access to data created by the app user who granted the permission."* Co-authored media data is accessible only to the publisher — **except** hashtag `top_media` / `recent_media`.
- Both statements: `https://developers.facebook.com/documentation/instagram-platform/overview` (Updated 2026-09-28).

---

## 2. NOT EXPOSED

Every row below is a capability an unfollower tracker / engagement-audit product would want and the platform does not provide. Sources are dated. "Doc absence" means: the IG User and IG Media reference pages (both fetched 2026-10-15) enumerate every edge and field, and the capability is not among them.

| Not available | Evidence | Source + date |
|---|---|---|
| **Followers list** of any account (own or third-party) | Doc absence: `IG User` exposes `followers_count` only; no `followers` edge exists. Third-party: "The official Instagram Graph API does not allow access to follower lists of third-party accounts" / "No access to follower/following lists of third-party accounts" | IG User reference, **2026-04-22** (fetched 2026-10-15); `https://www.netrows.com/blog/best-instagram-data-apis-2026` (**2026**) |
| **Following list** of any account | Same — no `following` edge, only `follows_count` | IG User reference, **2026-04-22**; netrows, **2026** |
| **Who liked a given post** (likers list) | Doc absence: `IG Media` has `like_count` but no `likes` edge. The 2026-04-22 "Like Media and Comments API" adds the ability to *like* media, not to enumerate likers | IG Media reference (fetched 2026-10-15); changelog **2026-04-22** |
| **Story viewer identities** (even for your own stories) | Doc absence: no viewer-list edge. Third-party, explicit: "Does Instagram Data Download Include Story Viewers? Usually, no." | IG Media insights, **2026-09-11**; `https://redact.dev/blog/instagram-data-file-download` (**2026-06-12**) |
| **Highlights** as an addressable collection | Doc absence: `IG User` has `stories` but **no `highlights` edge**, so archived highlights are not enumerable after the 24 h story window | IG User reference, **2026-04-22** (fetched 2026-10-15); corroborated by wearesculpt, **2026-08-19** |
| **Who reposted** your media (reposter identities) | `reposts_count` exists as a *number* on IG Media (added 2026-04-22); no edge lists the reposting accounts | IG Media reference (fetched 2026-10-15); changelog **2026-04-22** |
| **Profile-viewer identities** | Third-party: export "doesn't usually include profile viewers, old story viewer lists, other users' private data, or a simple unfollower report" | `https://redact.dev/blog/instagram-data-file-download` (**2026-06-12**) |
| **Consumer (personal) account data** of any kind | "Instagram API cannot access Instagram consumer (non-Business/non-Creator) accounts"; "Personal or private accounts are not accessible"; Business Discovery requires a public Business/Creator profile | `https://developers.facebook.com/docs/instagram-api` (**Updated 2025-03-03**); `https://wpsocialninja.com/instagram-graph-api` (**2026**) |
| **Ads data / tagging** under Instagram Login | Instagram-Login product "cannot access ads or tagging" | `.../instagram-api-with-instagram-login` (fetched 2026-10-15) |
| **Ordered / sorted result sets** (e.g. "top followers by X", newest-first guarantees) | "Ordering results not supported"; all endpoints use cursor pagination except User Insights (time-based) | `https://developers.facebook.com/docs/instagram-api` (**Updated 2025-03-03**) |
| **Retroactive story insights** (>24 h old) | Story insights expire at 24 h; archived/highlighted stories do not retain them | IG Media insights **2026-09-11**; wearesculpt **2026-08-19** |
| **Insights for very small stories** | Fewer than 5 viewers returns error code 10 — "(#10) Not enough viewers for the media to show insights" | IG Media insights, **2026-09-11** |
| **Insights for media inside an album** | "Insights not available for media in an album" | IG Media insights, **2026-09-11** |
| **Media insights older than 2 years** | "Metrics stored up to 2 years" | IG Media insights, **2026-09-11** |
| **Follower-level demographics for small accounts** | `follower_count` / `online_followers` unavailable under 100 followers; demographics capped at top-45 with a 48 h delay; long timeframes (`last_14_days` … `prev_month`) removed 2024 | IG User insights, **2026-06-16**; changelog **2024-05-21** |
| **A ready-made unfollower report** from any official channel | Export contains relationship lists but no diff product; third-party confirms "no simple unfollower report" | `https://redact.dev/blog/instagram-data-file-download` (**2026-06-12**) |
| **Private-account content** via hashtag or mention routes | "Webhooks will not be sent if the Media upon which the comment or @mention appears was created by an account that is set to private" | `.../reference/ig-user/mentions` (**2025-01-21**) |
| **Age-gated accounts** via Business Discovery | Age-gated accounts return nothing | `.../instagram-api-with-facebook-login/business-discovery` (**2026-08-12**) |
| **Hashtag history / volume** | Hashtag Search returns media, not volume trends; `/recently_searched_hashtags` returns only what the account itself searched | `.../instagram-api-with-facebook-login/hashtag-search` (**2026-08-17**) |

---

## 3. RATE LIMITS & REVIEW

### 3.1 Limits

| Surface | Formula / quota | Source |
|---|---|---|
| Instagram Platform BUC | `Calls within 24 hours = 4800 * Number of Impressions`, per app + user pair, rolling 24 h | `.../instagram-platform/overview` (**2026-09-28**) |
| Business Discovery + Hashtag Search | **Platform Rate Limits**, not BUC: `Calls within one hour = 200 * Number of Users` | `.../instagram-platform/overview` (2026-09-28); `https://developers.facebook.com/docs/graph-api/overview/rate-limiting/` (fetched 2026-10-15) |
| Hashtag query budget | Max **30 unique hashtags per rolling 7 days** per Business/Creator account; fetching media counts as querying | `.../instagram-api-with-facebook-login/hashtag-search` (**2026-08-17**) |
| Messaging | 2 calls/sec/account; 100/sec private replies to Live comments; 750/hour private replies to post/reel comments; 100/sec text/link/reaction/sticker; 10/sec audio/video | `.../instagram-platform/overview` (**2026-09-28**) |
| Creator Marketplace Discovery | 5,000 calls/user/hour (raised from 240 on 2026-03-30, then to 1,000, then 5,000) | Changelog **2026-03-30**, **2026-09-22** |

**Usage headers** to read before throttling: `X-App-Usage`, `X-Ad-Account-Usage`, `X-Business-Use-Case-Usage` (keys include `business-id`, `call_count`, `estimated_time_to_regain_access`, `total_cputime`, `total_time`, `type` — with an `instagram` type — and `ads_api_access_tier`).
**Throttle error codes:** 4, 17, 17/subcode `2446079`, 32, 613, 613/subcode `1996`. Meta's own best practice: stop calling when limited, spread queries across the day, and read `X-App-Usage`.
Source: `https://developers.facebook.com/docs/graph-api/overview/rate-limiting/` (fetched 2026-10-15).

### 3.2 App Review — the decisive gate

| Scenario | Access level | App Review required? |
|---|---|---|
| "My app is only for a business I own or manage" — no login, Instagram Login, or Facebook Login | **Standard Access** | **No** |
| Tech Provider serving multiple businesses | **Advanced Access** | **Yes** — plus Business Verification |

Meta states it plainly: *"If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs."*
Source: `.../instagram-platform/app-review` (**Updated 2026-06-30**), and the scenario table on the same page.

**Submission requirements when review *is* needed:** an externally loadable app, a visible login button, use-case details, **≥1 successful API call**, a 1024×1024 app icon, Privacy Policy URL, App Category, Business Email, reviewer test instructions **with credentials**, and screencasts.
Source: `.../instagram-platform/app-review` (**2026-06-30**).

**Real-world review latency (2026):**
- "Meta App Review Now Takes 20 Days" — `https://bundle.social/blog/meta-app-review-20-days` (**2026**). Meta also rejects apps that request permissions they do not use.
- Reddit reports of 9–12 working days: `https://www.reddit.com/r/facebook/comments/1tat5o3/meta_app_review_delays_are_getting_worse_in_2026` (**2026**).
- Business Verification, not the API review, is the usual blocker: `https://communityforums.atmeta.com/discussions/Questions_Discussions/business-verification-has-been-stuck-in-review-for-several-weeks-meta-develop/1376671` (OP **2026-06-25**, reply **2026-06-30**); `https://developers.facebook.com/community/threads/1301900711052660` (stuck 2+ months, multiple confirmations); `https://www.reddit.com/r/WhatsappBusinessAPI/comments/1sh9kvy/meta_business_verification_stuck_for_3_months` (**2026**); `https://www.reddit.com/r/FacebookAds/comments/1slbq87/business_verification_stuck_in_review_for_18_days` (**2026**).

**Instagram Public Content Access (the Hashtag Search gate) is actively rejected for the use case an unfollower tracker would describe.** A Meta community thread records a rejection whose reason is literally *"Please note that IPCA cannot be used to retrieve metrics and insights of the content. Please resubmit accordingly."*
Sources: `https://developers.facebook.com/community/threads/731424062426753/` (**2026**); feature reference `https://developers.facebook.com/docs/features-reference/instagram-public-content-access/` — allowed usage is limited to *hashtag campaigns, public sentiment around your own brand, contest/sweepstakes entrants, and customer support*, and requires both App Review and business verification.

**Conflict to note:** third-party sources repeat a "200 req/hr per token" figure for the Graph API (`https://www.socialcrawl.dev/blog/instagram-scraping-2026`, **2026**) while Meta's own documentation specifies the `4800 × impressions` BUC formula for the Instagram Platform and `200 × users/hour` for Business Discovery and Hashtag Search. **Meta's published formulas are authoritative**; the "200/hr per token" figure appears to be a folk simplification that happens to coincide with the Platform Rate Limit coefficient.

`divipeople.com/instagram-api-2026` (**2026**) adds a practitioner detail consistent with the doc: after the Basic Display shutdown, personal (consumer) accounts are locked out of API access entirely, and review expects a screencast plus OAuth consent demonstration.

---

## 4. 2025-2026 CHANGES

Chronological, from Meta's own changelog (`https://developers.facebook.com/documentation/instagram-platform/changelog`, **Updated 2026-10-05**; 70 entries captured spanning 2022-06 → 2026-10). Entries most likely to invalidate an existing implementation are marked **⚠**.

### 2026
| Date | Change |
|---|---|
| **2026-10-05** | Phone/email quick replies disabled |
| **2026-09-28** | Caption add-ons (polls, comment prompts) in content publishing; new content-publishing error codes; non-blocking `config_issue` field; new Instagram Login auth errors |
| **2026-09-22** | Creator Marketplace Messaging API; Facebook creators on Creator Marketplace; new discovery filters; 5,000 calls/user/hour for Creator Marketplace Discovery |
| **2026-09-21** | Message replies for Instagram Login |
| **2026-09-16** | New Webhooks documentation section |
| **2026-08-12** | Business Discovery docs refreshed (both pages) |
| **2026-07-30** | **⚠ `media_url` restrictions** — download protection and copyright protection now withhold `media_url`. Affected endpoints enumerated by Meta: Business Discovery, tags, `mentioned_media`, `mentioned_comment`, hashtag `top_media` / `recent_media`, and `collaborative_media`. Treat `media_url` as **optional everywhere**. |
| **2026-06-22** | AI Info Label (`is_ai_generated`); new story insight `link_clicks` |
| **2026-06-01** | Instagram Audio API; `media_audio_type` field |
| **2026-05-15** | oEmbed available **without** an access token |
| **2026-05-06** | Multi-image messaging out of beta |
| **2026-04-22** | **⚠ New IG Media engagement fields** `reposts_count`, `saved_count`, `shares_count`; aggregated `total_like_count`, `total_comments_count`, `total_views_count`; `facebook_views` expansion; cross-platform `view_count` via Business Discovery; Collaborative Media API; Partnership Ads Label; Like Media and Comments API |
| **2026-03-30** | Creator Marketplace rate limit raised 240 → 1,000/user/hour; `profile_picture_url` added |
| **2026-03-13** | Direct Send with attachment IDs |
| **2026-02-06** | `enable_fb_login` OAuth parameter |

### 2025
| Date | Change |
|---|---|
| **2025-12-19** | PDF attachments in Instagram Direct |
| **2025-12-12** | `link_sticker_url` in the `reply_to.story` webhook |
| **2025-12-03** | Accept/Decline Collaboration Invites; new metrics `reels_skip_rate`, `reposts`, `crossposted_views`, `facebook_views`; trial reels; `DELETE /{ig_media_id}` with `instagram_manage_contents` |
| **2025-11-10** | Self-messaging |
| **2025-11-03** | Multi-image Direct (beta); **⚠ Meta oEmbed Read deprecated** |
| **2025-10-27** | Post shares in messaging webhooks |
| **2025-09-23** | Sender actions |
| **2025-09-10** | `message_edit` webhook |
| **2025-06-16** | **⚠ `view_count` field added — Business Discovery only, Instagram Reels only** |
| **2025-06-14** | `force_reauth` introduced; **⚠ `enable_fb_login` and `force_authentication` deprecated** |
| **2025-04-08** | Meta oEmbed Read replaces oEmbed Read; oEmbed response field removals |
| **2025-03-24** | `alt_text` for image posts |
| **2025-01-21** | **⚠ Insights APIs available for Instagram Login; `views` metric added; deprecations: `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `impressions`, `plays`; v1.0 endpoint deprecations moved to 2025-05-20** |
| **2025-01-27** | Old scope values stop working (new scope values announced 2024-09-17) |

### 2024 (still load-bearing in 2026)
| Date | Change |
|---|---|
| **2024-12-04** | **⚠ Instagram Basic Display API deprecated — all requests error.** This is what locks consumer accounts out of official access. |
| **2024-10-03 / 2024-10-02** | `video_views` removed; user insight time-series metrics removed: `email_contacts`, `get_direction_clicks`, `profile_views`, `text_message_clicks`, `website_clicks`, `phone_call_clicks` |
| **2024-09-17** | New scope values introduced (old values deprecated 2025-01-27) |
| **2024-07-23** | **Launch of Instagram API with Instagram Login** |
| **2024-06-11** | Unspecified |
| **2024-05-21** | **⚠ `last_14_days` / `last_30_days` / `last_90_days` and `prev_month` timeframes removed** for `reached_audience_demographics` and `engaged_audience_demographics` |

### Older but still cited
**2024-09-12**, **2023-09-12**, **2022-11-09**, **2022-10-31**, **2022-06-28**, and **2022-06-27** (legacy Instagram API docs removed) are in the changelog but predate the current product.

### Trend reading
1. **Metrics are being added, not removed, at the media level** (2025-12-03 and 2026-04-22 both added engagement metrics). The removals target *user-level time series* (`profile_views`, `website_clicks`, `impressions`) and *long timeframes*.
2. **Media bytes are being restricted while metadata expands** (2026-07-30 `media_url` withholding). A product should never assume it can proxy or display media.
3. **Access is consolidating toward owned accounts.** Basic Display is dead; consumer accounts are unreachable; the surviving cross-account routes (Business Discovery, Hashtag Search) are the two most gated.

---

## 5. EXPORT CONTENTS (the operator's own data export)

The only lawful source of follower/following *identity* data. Everything here is operator-supplied, not scraped.

**Mechanics** — `https://help.instagram.com/181231772500920` (*Review and export a copy of your Instagram information*): the tool now lives in **Accounts Center** as "Export your information". Downloads must be taken within **4 days**; the emailed link is valid **up to 30 days**. Practitioner guidance recommends setting the date range to **All time** for the widest coverage (`https://aurumspire.com/guides/instagram-data-export-time`, **2026**).

**Archive structure** (from a documented real export, `https://hooleft.me/blog/how-instagram-data-download-actually-works`, **2026-05-30**):

```
connections/            followers, following, close friends, blocked,
                        hidden stories, recent follow requests
messages/
your_instagram_activity/
personal_information/
media/
preferences/
ads_information/
security_and_login_information/
apps_and_websites_off_of_instagram/
logged_information/
```

**The two files that matter for observation:**

| File | Shape | Semantics |
|---|---|---|
| `connections/followers_and_following/followers_1.json` (then `followers_2.json`, … when paginated) | `relationships_followers` → `string_list_data[]` with `href`, `value`, `timestamp` | `value` is the **username as of export time** (not a stable id); `timestamp` is the **follow-creation time** (Unix seconds), *not* the export time |
| `connections/followers_and_following/following.json` | `relationships_following` → same shape | Same semantics |

Corroborated for existence of "Followers and following" in a real 2026 archive: `https://www.nmoore.nz/portfolio/2026-03-17-insta-export/start_here` (**2026-03-17**). Order within these files is **not meaningful** (`hooleft.me`, 2026-05-30).

**Broader content** — `https://redact.dev/blog/instagram-data-file-download` (**2026-06-12**): posts, reels, stories, comments, likes, followers, following, DMs, search activity, ad information, login history, settings, technical logs. Explicitly *not* included: "profile viewers, old story viewer lists, other users' private data, or a simple unfollower report"; and the article has a dedicated section titled **"Does Instagram Data Download Include Story Viewers? Usually, no."**

**Consequences for an evidence-first engine:**
- The export gives a **snapshot**, not a stream. Two exports produce a diff; the diff is the product.
- Usernames are the join key and they **change**. `timestamp` is follow-creation time, which makes a stable per-relationship ordering possible even when usernames rotate.
- An export older than the last one is **not** new evidence. Capture time ≠ observed time — the archive's internal timestamps must be preserved as observed time (this is exactly the distinction IGTrack's invariant 5 encodes).
- Nothing in the export identifies **why** a relationship ended. Attribution is unknowable; only the state change is observable.
- Meta's window is **up to 30 days**; the download link expires in **4 days**. A pipeline must fetch and persist immediately, or lose the data until the next export.

---

## 6. SCRAPER REALITY 2026

Recorded for completeness of the platform picture, and as the boundary IGTrack does not cross.

### 6.1 The market is real and priced

| Provider / route | Published rate | Source + date |
|---|---|---|
| Apify `instagram-scraper` (first-party) | from **$1.50 / 1,000 results** (Business), **$2.70 / 1,000** (Free) | `https://www.ugcroster.com/blog/apify-instagram-scraper-alternative` (**2026-10-01**); `https://chat4data.ai/blog/instagram-scraper` (**2026**) |
| Apify `instagram-profile-scraper` | from $1.60 / 1,000 profiles | same (**2026-10-01**) |
| Apify `instagram-hashtag-scraper` | from $1.90 / 1,000 (Business), $2.30 (Starter), $2.60 (Free) | same (**2026-10-01**) |
| apidojo third-party actor | $0.50 / 1,000 posts (free plan), $0.47 Gold | `https://imisofts.com/blog/best-instagram-scrapers-2026` (**rates read 2026-08-19**) |
| Bright Data | best publicly purchasable rate **$1.30 / 1,000** | same (**2026-08-19**) |
| ScrapeCreators | **$1.88 / 1,000** requests | `https://scrapecreators.com/blog/instagram-public-data-api` (**published 2026-09-10**) |
| HikerAPI | **~$1 / 1,000** — but "counts several client-error status codes as chargeable responses" | same (**2026-09-10**) |
| CreatorCrawl | $29 one-time / 5K credits, $99 / 20K, $299 / 100K | `https://creatorcrawl.com/vs/instaloader` (**2026**) |

Hidden costs are the story: Apify actor fees are **separate** from compute units, data transfer, **proxy ($7–$8/GB residential)**, and storage operations (`ugcroster`, 2026-10-01). Bright Data claims a **98.44% average success rate** in Scrape.do's independent benchmark of 11 providers (`https://brightdata.com/blog/web-data/best-web-scraping-apis`, **2026**) — a vendor-cited benchmark; treat as claimed, not verified.

### 6.2 Reliability is the real problem

- **Instagram is the hardest mainstream target.** "Instagram remains one of the most aggressive platforms for blocking automated scraping due to advanced anti-bot measures like TLS fingerprinting and IP reputation checks." — `https://aimultiple.com/instagram-scraping` (**2026**).
- **Tool quality inside a single vendor is uneven.** Apify's own first-party Actors, ratings pulled from the Actor API on **2026-08-19**: Profile Scraper **4.72/155**, Instagram Scraper **4.69/539**, Post Scraper **4.10/133**, Reel Scraper **3.85/99** (`imisofts`, 2026-08-19). Meanwhile a live Apify issue thread is titled *"The actor ran indefinitely past the 10 max results search limit"* (`https://apify.com/apify/instagram-scraper/issues/the-actor-ran-indefi-2AYohh3bfmpPBRVFD`, **2026**).
- **Public content now frequently requires a login.** Instaloader issues: *"Redirected to login page. Use --login or --load-cookies"* for public profiles (`https://github.com/instaloader/instaloader/issues/2458`) and *"Issue with downloading public content without login (Error 401)"* — "I have tried using different IPs, but all of them are blocked or return the same issue" (`https://github.com/instaloader/instaloader/issues/2508`).
- **Ban waves against the operator's own account are documented.** `https://github.com/instaloader/instaloader/issues/1836` ("Error 401, Server blocking and others"): "Using the `--login=ID` option with my personal account to DL like 60 private posts, IG blocked the DL halfway through and **required a change of password**… I guess it's not safe at all unless you want to risk getting blocked/banned." Also: "after DLing 1000 posts, IG blocked it." And `https://github.com/instaloader/instaloader/issues/1006`: "The built in rate limiter does not work and my account is eventually blocked returning error 400."
- **Cookie-based auth broke again in 2026.** `https://github.com/instaloader/instaloader/issues/2664` — "Instaloader Firefox Cookies Login Method Stopped Working – 401 GraphQL Error", **opened 2026-03-03, closed as *not planned* 2026-03-22**.
- **Vendors themselves describe the login requirement as a ban risk.** "Instagram detects automated access patterns and restricts or bans accounts used with tools like Instaloader… Account ban risk: None (hosted) vs High (Instagram detects automation)." — `https://creatorcrawl.com/alternatives/instaloader` (**2026**). Vendor framing, but the direction of the claim matches the GitHub evidence.
- **Error taxonomy practitioners plan around:** `429` on rate limits, `401` on expired tokens, `400` on **stale scope names** (`https://www.socialcrawl.dev/blog/instagram-scraping-2026`, **2026**) — the last is a direct consequence of the 2024-09/2025-01 scope migration in §4.

### 6.3 The legal position is not as simple as "scraping is illegal"

*Meta Platforms, Inc. v. Bright Data Ltd.*, No. 3:23-cv-00077-EMC (N.D. Cal.), Judge Edward Chen, **summary judgment 2024-01-23**: Meta's terms "do not bar logged-off scraping of public data; perforce it does not prohibit the sale of such public data." The court reasoned that Meta **removed** an "accessing = bound" clause after 2009, so the terms bind only active *users*, and it additionally held a perpetual "survival" clause unenforceable. Meta subsequently **dropped its remaining claim and waived its right to appeal**.
Sources: `https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data`; `https://www.quinnemanuel.com/the-firm/news-events/client-alert-meta-v-bright-data-significant-decision-for-web-scraping-industry`; `https://www.law360.com/cases/63b8bf2c5135aa01e9864a8e/articles`; `https://www.justia.com/cases/delaware/superior-court/2023/n23c-01-229-skr-ccld.html`.

**This does not license scraping in IGTrack.** The ruling turned on narrow contract-interpretation grounds for *logged-off* collection of *public* data; commentary at the time predicted Meta would redraft its terms to close the gap (`https://www.linkedin.com/posts/ondra-urban_i-reviewed-the-recent-meta-vs-brightdata-activity-7157716689927716865-d8EB`, **2024-01**). Logged-in scraping, session-cookie re-use, and proxy re-serving of media bytes sit outside the ruling and outside IGTrack's invariant 3 regardless of what is legally survivable.

### 6.4 Practitioner verdict on the API-vs-scraper tradeoff

> "In 2026, the Instagram Graph API is only good for verified accounts with special permissions, and 'unofficial' alternatives (scrapers, wrappers) are minefields of blocks and legal risks."
> — `https://mailerfind.com/instagram-api-in-2026-real-limitations-and-the-api-free-alternative-that-gives-you-all-the-data` (Jordi Valls, **2026-03-19**)

Same source, on the entry barrier: "Active and verified Facebook Developer account. Meta-approved app (**2–8 week process, frequent rejection**)."

And from a scraper vendor, unintentionally the best argument for the honest-API position: *"Use the Graph API when you only need accounts you own."* — `https://scrapecreators.com/blog/instagram-public-data-api` (**2026-09-10**).

---

## 7. TAKEAWAYS FOR AN HONESTY-FIRST PRODUCT

1. **The gating question is "whose account?"** Standard Access covers an app that serves only accounts the operator owns or manages, with **no App Review** (Meta, 2026-06-30). Every capability that reaches *other* accounts — Business Discovery, Hashtag Search — is where the gates, costs, and rejections live. Own-account observation is a fundamentally different (and lawful, free, unsupervised) product from third-party observation.
2. **The API structurally cannot see the social graph.** Followers, following, likers, story viewers, and profile viewers have no edge in any official product (IG User + IG Media references, 2026-04-22 / fetched 2026-10-15). This is not a permissions problem to be solved — it is the shape of the platform, and it should be reported as `UNAVAILABLE` with that reason, forever.
3. **The operator's own data export is the only lawful follower-identity source**, and it is a periodic snapshot: `connections/followers_and_following/followers_*.json` + `following.json`, where `timestamp` is *follow-creation time* and `value` is a *mutable username* (hooleft.me, 2026-05-30). Design the follower-diff feature around two exports, not around an API that will never exist.
4. **Absence must be modelled as a structural fact, not an error and not a zero.** Meta itself returns an *empty dataset* where a naive implementation expects `0` (follower/unfollower metrics below 100 followers; 2026-06-16). IGTrack's three-way distinction — *not exposed* vs *call failed* vs *genuinely empty* — is the correct model of the same reality Meta is describing, and it is the reason `UNAVAILABLE` must never render as a number.
5. **Anything timestamped is more perishable than it looks.** Story insights die at 24 h and vanish even for archived or highlighted stories (2026-09-11; wearesculpt 2026-08-19); media insights expire at 2 years; demographics carry a 48 h delay and a top-45 cap. A snapshot not captured in its window is gone, so capture time and observed time must both be stored.
6. **Treat every media byte as optional.** Since 2026-07-30 Meta withholds `media_url` for copyrighted/licensed-audio video and for reels whose owner disabled downloads — across Business Discovery, tags, mentions, and hashtag search. A design that depends on fetching or re-serving media bytes breaks on data Meta deliberately withholds, and IGTrack must not proxy those bytes in any case.
7. **`PARTIAL` is the normal case, not the exception.** Cursor-only pagination, no ordering support, a documented duplicate-post bug in hashtag `top_media` past ~45 pages, and `saved_count`/`shares_count`/`total_views_count` that silently disappear depending on route — a truncated read is routine. Never diff a partial snapshot; the exact bug class is reachable from documented platform behaviour alone.
8. **Rate limits are per-app-and-user and reported, not guessed.** Read `X-Business-Use-Case-Usage` (the `instagram` type key) and the `estimated_time_to_regain_access` field, honour the `4800 × impressions` / `200 × users` formulas, and never retry into a throttle code — Meta's own best practice is to stop and spread calls (2026-10-15 fetch; 2026-09-28 overview).
9. **Scraping is a dead end for this project on every axis.** It is banned by Meta's terms, it requires the operator's own credentials at risk (documented password-reset and ban events, Instaloader issues #1836 / #2508 / #2664, the last closed *not planned* on 2026-03-22), it breaks on every frontend change, its economics are worse than they look ($7–$8/GB residential proxy on top of per-result fees), and the one favourable court ruling (*Meta v. Bright Data*, 2024-01-23) covers logged-off public collection only. IGTrack's no-circumvention invariant is not an ideological stance; it is the only position that survives contact with the platform.
10. **Say the source out loud, every time.** The strongest differentiator available in this market is not more data — it is a product that answers "how do you know that?" with a URL, a permission name, and a timestamp, and that answers "why don't you know that?" with the same specificity.

---

## Appendix — Source index

**Primary (Meta)**
- `https://developers.facebook.com/documentation/instagram-platform/overview` — Updated 2026-09-28
- `https://developers.facebook.com/documentation/instagram-platform/changelog` — Updated 2026-10-05
- `https://developers.facebook.com/documentation/instagram-platform/app-review` — Updated 2026-06-30
- `.../instagram-platform/instagram-api-with-instagram-login` — fetched 2026-10-15
- `.../instagram-graph-api/reference/ig-user` — Updated 2026-04-22
- `.../instagram-graph-api/reference/ig-user/business_discovery` — Updated 2026-08-12
- `.../instagram-api-with-facebook-login/business-discovery` — Updated 2026-08-12
- `.../instagram-api-with-facebook-login/hashtag-search` — Updated 2026-08-17
- `.../instagram-graph-api/reference/ig-user/mentions` — Updated 2025-01-21
- `.../instagram-platform/reference/instagram-media` — fetched 2026-10-15
- `.../instagram-platform/api-reference/instagram-user/insights` — Updated 2026-06-16
- `.../instagram-platform/reference/instagram-media/insights` — Updated 2026-09-11
- `https://developers.facebook.com/docs/instagram-api` — Updated 2025-03-03
- `https://developers.facebook.com/docs/graph-api/overview/rate-limiting/` — fetched 2026-10-15
- `https://developers.facebook.com/docs/features-reference/instagram-public-content-access/` — 2026
- `https://developers.facebook.com/community/threads/731424062426753/` — 2026 (IPCA rejection wording)
- `https://developers.facebook.com/community/threads/1301900711052660` — 2026 (verification backlog)
- `https://help.instagram.com/181231772500920` — data export mechanics

> Note on URL form: Meta documentation moved from `/docs/instagram-platform/...` to `/documentation/instagram-platform/...`; legacy `/docs/...` paths commonly 404. Pages under `/documentation/.../instagram-graph-api/reference/...` were reachable during this research with the `instagram-platform` prefix.

**Export structure**
- `https://hooleft.me/blog/how-instagram-data-download-actually-works` — 2026-05-30
- `https://redact.dev/blog/instagram-data-file-download` — 2026-06-12
- `https://www.nmoore.nz/portfolio/2026-03-17-insta-export/start_here` — 2026-03-17
- `https://aurumspire.com/guides/instagram-data-export-time` — 2026

**App Review / verification reality**
- `https://bundle.social/blog/meta-app-review-20-days` — 2026
- `https://communityforums.atmeta.com/discussions/Questions_Discussions/business-verification-has-been-stuck-in-review-for-several-weeks-meta-develop/1376671` — OP 2026-06-25, reply 2026-06-30
- `https://divipeople.com/instagram-api-2026` — 2026
- Reddit: `/r/facebook/comments/1tat5o3`, `/r/facebook/comments/1th9u7n`, `/r/SaaS/comments/1rk1ozq`, `/r/WhatsappBusinessAPI/comments/1sh9kvy`, `/r/FacebookAds/comments/1slbq87` — all 2026

**Scraper market**
- `https://scrapecreators.com/blog/instagram-public-data-api` — 2026-09-10
- `https://www.ugcroster.com/blog/apify-instagram-scraper-alternative` — 2026-10-01
- `https://imisofts.com/blog/best-instagram-scrapers-2026` — rates read 2026-08-19
- `https://brightdata.com/blog/web-data/best-web-scraping-apis` — 2026 (vendor-cited benchmark)
- `https://brightdata.com/blog/web-data/best-instagram-scrapers` — 2026
- `https://aimultiple.com/instagram-scraping` — 2026
- `https://www.socialcrawl.dev/blog/instagram-scraping-2026` — 2026 (undated)
- `https://creatorcrawl.com/vs/instaloader`, `.../alternatives/instaloader` — 2026 (vendor)
- `https://www.socialfetch.dev/blog/best-instagram-data-apis-2026` — 2026
- `https://chat4data.ai/blog/instagram-scraper` — 2026
- `https://mailerfind.com/instagram-api-in-2026-real-limitations-and-the-api-free-alternative-that-gives-you-all-the-data` — 2026-03-19

**Scraper breakage / bans (primary bug tracker)**
- `https://github.com/instaloader/instaloader/issues/1836` — 401 / server blocking / password reset
- `https://github.com/instaloader/instaloader/issues/2508` — public content without login → 401, all IPs blocked
- `https://github.com/instaloader/instaloader/issues/2458` — "Redirected to login page" for public profiles
- `https://github.com/instaloader/instaloader/issues/2664` — Firefox cookie login → 401 GraphQL, opened 2026-03-03, closed not planned 2026-03-22
- `https://github.com/instaloader/instaloader/issues/1006` — built-in rate limiter ineffective, account blocked (400)
- `https://apify.com/apify/instagram-scraper/issues/rate-limit-question-wkZKfCL4lFLWYF7Ey` — 2026
- `https://apify.com/apify/instagram-scraper/issues/the-actor-ran-indefi-2AYohh3bfmpPBRVFD` — 2026

**Legal**
- `Meta Platforms, Inc. v. Bright Data Ltd.`, No. 3:23-cv-00077-EMC (N.D. Cal.) — summary judgment 2024-01-23
- `https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data`
- `https://www.quinnemanuel.com/the-firm/news-events/client-alert-meta-v-bright-data-significant-decision-for-web-scraping-industry`
- `https://www.justia.com/cases/delaware/superior-court/2023/n23c-01-229-skr-ccld.html`
- `https://www.courthousenews.com/federal-judge-rules-against-meta-in-data-scraping-case`

**Third-party capability claims**
- `https://www.netrows.com/blog/best-instagram-data-apis-2026` — 2026
- `https://wpsocialninja.com/instagram-graph-api` — 2026
- `https://wearesculpt.com/blog/export-instagram-stories-analytics` — 2026-08-19

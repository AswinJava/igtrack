# Capability matrix

> **Generated file — do not edit by hand.** `pnpm docs:capabilities` rewrites it
> from `CAPABILITY_REGISTRY` (`packages/core/src/capabilities.ts`); a test fails if it
> is stale. Prose cannot drift from the product because there is no prose.

19 of 24 capabilities are obtainable from a lawful source; 5 have no source at all (no provider method exists, and no operator-supplied rows can stand in). Separately, 8 capabilities are `DOCUMENTED_ABSENT`: the exhaustive platform reference lists no such field or edge, so their absence is a finding, not an assumption.

A capability can be available **and** documented-absent at the same time, and saying so is the point of this table: follower and following rosters are `DOCUMENTED_ABSENT` for any live interface — no roster edge exists — while the synthetic fixture provider exposes rosters so the pipeline can be built and tested end to end, and the operator's own Instagram export (`import:v1`) supplies the real roster lawfully.

## How to read this

| State | Means |
|---|---|
| `available` | At least one provider method supplies it — or, for the claims ledger, the operator does (the platform exposes no route and none can exist) — and its pipeline is wired end to end. |
| `UNAVAILABLE` | No provider method exists. The product reports it as unavailable **with the reason below** — never as zero, never as empty data. |
| `LIVE_VERIFIED` | Observed against the real provider during a live check. |
| `NOT_VERIFIED` | Implemented against documented fields; a live check under your credentials is still outstanding. |
| `DOCUMENTED_ABSENT` | The platform does not expose it. This is a finding, not a gap in the work. |

## Matrix

| Capability | State | Supplied by | Persists to |
|---|---|---|---|
| **Public profile** | available · `NOT_VERIFIED` | `resolveAccount`, `getProfile` | `igAccounts`, `profileSnapshots`, `profileChanges`, `evidence` |
| **Follower / following / post counts** | available · `NOT_VERIFIED` | `getProfile` | `profileSnapshots` |
| **Own-account insights over time** | available · `NOT_VERIFIED` | `getAccountInsights` | `insightPoints`, `evidence` |
| **Other public professional account profile and recent media** | available · `NOT_VERIFIED` | `discoverAccount` | `profileSnapshots`, `posts`, `evidence` |
| **Active stories** | available · `NOT_VERIFIED` | `getStories` | `stories`, `storySightings`, `evidence` |
| **Story metadata** | available · `NOT_VERIFIED` | `getStories` | `stories` |
| **Story mentions and tags** | available · `NOT_VERIFIED` | `getStories` | `storyMentions`, `evidence` |
| **Mention roll-up (not-established-visible accounts)** | available · `NOT_VERIFIED` | `getStories` | `storyMentions`, `evidence` |
| **Tagged media (media owned by others in which the account is tagged)** | available · `NOT_VERIFIED` | `getTags` | `taggedMedia`, `evidence` |
| **Mentioned comments (@mentions of the owned account on other media)** | available · `NOT_VERIFIED` | `getMentionedComment` | — |
| **Story highlights** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Public posts** | available · `NOT_VERIFIED` | `getPublicPosts` | `posts`, `postPresence`, `postChanges`, `evidence` |
| **Reels as a distinct type** | available · `NOT_VERIFIED` | `getPublicPosts` | `posts` |
| **Carousels and child media** | available · `NOT_VERIFIED` | `getPublicPosts`, `getPostChildren` | `posts`, `postChildren` |
| **Public comments** | available · `NOT_VERIFIED` | `getPublicComments` | `postComments`, `evidence` |
| **Comment replies and threading** | available · `NOT_VERIFIED` | `getPublicComments` | `postComments` |
| **Follower roster and history** | available · `DOCUMENTED_ABSENT` | `getFollowers` | `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence` |
| **Following roster and history** | available · `DOCUMENTED_ABSENT` | `getFollowing` | `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence` |
| **Public like data** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Interaction history** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | `interactions` |
| **Repost count metadata** | available · `NOT_VERIFIED` | `getPublicPosts` | `posts` |
| **Reshare relations (who reposted media)** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Media bytes and assets** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | `mediaAssets` |
| **Cited claims ledger and account research report** | available · `DOCUMENTED_ABSENT` | operator submissions (no platform route exists) | `claims` |

## The detail

### Public profile — `available`

- **Registry id:** `PROFILE`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment (harness: NOT_VERIFIED/CREDENTIALS_NOT_CONFIGURED). Request shape is docs-pinned: every requested field exists in the Meta IG User reference; account_type, is_verified, and category have no such field and stay absent.
- **Permissions:** Public account; graph observes the owned account only.
- **Provider methods:** `resolveAccount`, `getProfile`
- **Persists to:** `igAccounts`, `profileSnapshots`, `profileChanges`, `evidence`
- **Surfaced in:** `/targets/[id] (overview)`, `/lookup`, `POST /api/targets/lookup`

**Pipeline.** resolveAccount maps a username to a stable account reference; getProfile returns a normalized profile that is appended to profile_snapshots (never overwritten). The adapter requests only documented IG User fields, including website, which maps to externalUrl. Field-level diffs against the previous snapshot become DERIVED profile_changes rows, each backed by an evidence row.

### Follower / following / post counts — `available`

- **Registry id:** `COUNTS`
- **Live state:** `NOT_VERIFIED` — Same outstanding live check as PROFILE; the follower/following lists themselves are DOCUMENTED_ABSENT (see FOLLOWERS).
- **Permissions:** Same as PROFILE.
- **Provider methods:** `getProfile`
- **Persists to:** `profileSnapshots`
- **Surfaced in:** `/targets/[id] (overview)`, `/targets (cards)`, `/lookup`

**Pipeline.** Counts ride inside profile snapshots, so every count has a timestamp, a source, and a history. A missing count renders as unavailable, never zero — zero is a real observation of absence, only valid when the provider returns it.

### Own-account insights over time — `available`

- **Registry id:** `ACCOUNT_INSIGHTS`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. Request shape is docs-pinned against the IG User insights reference (updated 2026-06-16): metric names, period=today/day/lifetime tokens, metric_type=time_series\|total_value, breakdown=country. Documented constraints carried into the pipeline: unavailable metrics return an empty data set (not 0); follower_count and online_followers are unavailable below 100 followers; demographics are top-45 with a 48 h delay; account insights default to a 24-hour lookback unless since/until are supplied (the provider always supplies an explicit 30-day window).
- **Permissions:** Owned professional account only. The documented IG User insights edge; Standard Access covers an app used solely by the account's owner (Meta, 2026-06-30). No App Review for own-account observation.
- **Provider methods:** `getAccountInsights`
- **Persists to:** `insightPoints`, `evidence`
- **Surfaced in:** `igtrack insights (CLI)`, `insights (MCP tool)`

**Pipeline.** Each INSIGHTS_SCAN calls the documented IG User insights edge once for a fixed, docs-pinned metric set: daily time series for follower_count, reach, views, accounts_engaged and total_interactions, plus follower_demographics (country breakdown) as a lifetime total_value point-in-time snapshot. Points are appended to insight_points (append-only), so repeated scans build the history the native 90-day window deletes and the demographic time line the API itself cannot produce (demographics are a current-state snapshot, never a series). A metric the platform does not return becomes an ABSENCE row with the documented reason (below 100 followers, 48 h demographic delay) — never a zero.

### Other public professional account profile and recent media — `available`

- **Registry id:** `OTHER_ACCOUNT_PUBLIC`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. Request shape is docs-pinned against Meta's Business Discovery references (both updated 2026-08-12): no previous/next paging (before/after cursors only), a direct GET on a returned IG Media ID fails with insufficient permissions, view_count via Business Discovery is Reels-only (added 2025-06-16), and the route is limited by Platform Rate Limits (200 × users per hour) rather than the Instagram BUC formula.
- **Permissions:** Facebook Login product; the documented business_discovery edge. Public Business/Creator accounts only — consumer and private accounts are unreachable, age-gated accounts return nothing. Documented permissions: instagram_basic + instagram_manage_insights + pages_read_engagement. Opt-in on the graph provider: IGTRACK_GRAPH_BUSINESS_DISCOVERY=1 (D42).
- **Provider methods:** `discoverAccount`
- **Persists to:** `profileSnapshots`, `posts`, `evidence`
- **Surfaced in:** `igtrack lookup (CLI)`, `igtrack dossier (CLI)`, `igtrack targets add --observed (CLI)`, `lookup / dossier / igtrack_target_add (MCP tools)`

**Pipeline.** Two intents, one edge (D53). `lookup` is a probe, not a record: it renders the public profile fields plus the bounded recent-media preview and persists nothing — a probe is not a claim of record. Recording is operator-directed: `targets add <username> --observed` probes the route once, refuses on UNAVAILABLE with the platform's reason (a target that can never be scanned is not created), and creates a DISCOVERY target; DISCOVERY_SCAN then stores the documented profile fields as a COMPLETE, diffable snapshot and the media preview as posts rows. The preview is capped by the edge and cannot page (cap 12, DISCOVERY_MEDIA_PREVIEW_LIMIT): the cap is written into every media row's evidence, the scan completes as COMPLETED_PARTIAL, and no surface may call those rows the account's post history. Media rows carry the platform's published time and our first-observation time as separate fields. No documented route returns another account's media comments — that stays UNAVAILABLE with a reason.

### Active stories — `available`

- **Registry id:** `STORIES`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. Edge and fields are docs-pinned (GET /{ig-user-id}/stories; 24h-only, no live-video, no reshares).
- **Permissions:** Public account stories; graph returns the owned account's tray.
- **Provider methods:** `getStories`
- **Persists to:** `stories`, `storySightings`, `evidence`
- **Surfaced in:** `/targets/[id] (stories tab)`

**Pipeline.** Each scan appends new stories and records a sighting row for every story still present, so first-seen, last-seen, and observable duration are derived from evidence, not guessed. Stories expire after ~24h: a story missing from later scans is EXPIRED, never deleted-history.

### Story metadata — `available`

- **Registry id:** `STORY_METADATA`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. user_tags is publish-only (no story-mention read field exists); expiry has no field (lifetime derives from sightings).
- **Permissions:** Same as STORIES. Graph exposes id, timestamp, media type, and one caption only.
- **Provider methods:** `getStories`
- **Persists to:** `stories`
- **Surfaced in:** `/targets/[id] (stories tab)`, `evidence chain`

**What would unlock it.** Graph story objects would need richer read fields; until then the degraded path is explicit.

**Pipeline.** Caption (at most one per story, per provider docs), expiry, duration, link, stickers, poll, question, location, and music persist when the provider supplies them (fixture) and stay null when it does not (graph). The UI renders persisted fields only — absence is shown as absence.

### Story mentions and tags — `available`

- **Registry id:** `STORY_MENTIONS`
- **Live state:** `NOT_VERIFIED` — Fixture path implements the full pipeline synthetically. Graph exposes no story-mention read field (DOCUMENTED_ABSENT for the read path), so live graph stories carry no mentions by provider design.
- **Permissions:** Same as STORIES. Only provider-exposed mentions are stored.
- **Provider methods:** `getStories`
- **Persists to:** `storyMentions`, `evidence`
- **Surfaced in:** `/targets/[id] (stories tab)`, `/relationships`

**Pipeline.** Mentions normalize to username, optional platform id, geometry, and a visibility class (VISIBLE, POSSIBLY_HIDDEN, OFF_CANVAS, METADATA_ONLY, UNKNOWN). Geometry describes where the provider placed the sticker; it is never proof of intent to hide, and the UI says so.

### Mention roll-up (not-established-visible accounts) — `available`

- **Registry id:** `MENTION_INTELLIGENCE`
- **Live state:** `NOT_VERIFIED` — Aggregation is pure and covered by packages/core/test/mention-intelligence.test.ts; the fixture path exercises the full pipeline end to end. The underlying mentions are provider-exposed only — the Graph read path has no story-mention field (see STORY_MENTIONS), so live data yields no mentions by provider design, and this roll-up can only ever surface what a provider actually exposed.
- **Permissions:** Same as STORIES. Reads only mentions the provider already exposed.
- **Provider methods:** `getStories`
- **Persists to:** `storyMentions`, `evidence`
- **Surfaced in:** `/targets/[id] (stories tab, hidden-mention roll-up with /lookup?username= pivot)`

**Pipeline.** A pure read-side aggregation over stored story_mentions rows: per mentioned account, how many distinct stories named it, how many of those named it through a class that did not establish on-canvas rendering (POSSIBLY_HIDDEN, OFF_CANVAS, METADATA_ONLY), and which story ids those were. It fetches nothing, adds no provider method, and writes no new table. Merging is case-insensitive and per story, so one story naming an account twice counts once but stays hidden if any of its rows was hidden-class. UNKNOWN is deliberately excluded from the hidden classes: a missing visibility signal is absence of evidence, never a finding, and a classification is never proof of intent to hide.

### Tagged media (media owned by others in which the account is tagged) — `available`

- **Registry id:** `TAGS`
- **Live state:** `NOT_VERIFIED` — Fixture v1 implements the full pipeline synthetically (tagged-media listing, idempotent re-scan, PARTIAL on truncation). Request shape is docs-pinned (Meta tags reference, read 2026-10-16): GET /{ig-user-id}/tags with documented media fields, no limit parameter (the reference documents cursor paging only), private media excluded by the platform. No credentials in this environment, so the live edge has never been observed.
- **Permissions:** Owned account only; the documented IG User tags edge. Media from private accounts are excluded by the platform, and the edge is subject to Platform Rate Limits.
- **Provider methods:** `getTags`
- **Persists to:** `taggedMedia`, `evidence`
- **Surfaced in:** `igtrack tags (CLI)`, `igtrack_tags (MCP tool)`, `dossier counts (taggedMedia)`, `activity timeline (TAG_OBSERVED)`

**What would unlock it.** Live verification of the tags edge under this integration's credentials; the pipeline, table, scan kind, and CLI are already in place.

**Pipeline.** TAGS_SCAN pages the documented tags edge (cursor paging, hard page cap, lease renewal between pages) and stores one append-only row per (account, media, source) with first-observation-wins semantics: a re-scan never rewrites a stored observation, no removal is ever claimed (another account's edit history is not an observation stream), and the rows are never rendered as the account's own media nor diffed against the posts table. Each scan records one scan-keyed evidence row carrying the completeness of that listing; a capped or truncated listing completes PARTIAL and says so — never 'these are all the tags'. The tags edge is a reference listing: it answers 'this account appears tagged in that media', which is a fact about the media owner as much as about this account.

### Mentioned comments (@mentions of the owned account on other media) — `available`

- **Registry id:** `MENTIONED_COMMENTS`
- **Live state:** `NOT_VERIFIED` — Request shape is docs-pinned (Meta Mentioned Comment reference, read 2026-10-16): fields id, text, timestamp, like_count, media; the comment id is required and documented as arriving in webhook notification payloads; the read errors when comments are disabled on the underlying media. No credentials in this environment, so the live read has never been observed.
- **Permissions:** Owned account; the documented mentioned_comment read. The platform publishes no listing edge — comment ids arrive through Meta webhook notifications — so the read answers only for ids this app already holds. The call errors when comments are disabled on the underlying media.
- **Provider methods:** `getMentionedComment`
- **Persists to:** —
- **Surfaced in:** `igtrack mention <id> (CLI)`, `igtrack_mention_read (MCP tool)`

**What would unlock it.** A Meta webhook subscription on the comments field (the ids' only lawful source) plus live verification under this integration's credentials; the read and CLI/MCP surfaces are already in place. Until then the probe answers UNAVAILABLE with its reason for any id, and nothing is stored.

**Pipeline.** An on-demand, stateless single read: the operator supplies a comment id (from the app's webhook notification payload), the provider expands mentioned_comment.comment_id(<id>){id,text,timestamp,like_count,media} on the documented IG User node, and the normalized comment is returned without persisting anything — a probe is not a claim of record, mirroring the DISCOVERY lookup split (D53). There is deliberately no stored mentions table: the platform delivers these ids through the webhook channel, not a pollable edge, and manufacturing a listing from re-probing ids would present a feed that does not exist.

### Story highlights — `UNAVAILABLE`

- **Registry id:** `HIGHLIGHTS`
- **Live state:** `DOCUMENTED_ABSENT` — Exhaustive Meta IG User edge reference (v21.0–v26.0) lists no highlights edge. No credentials in this environment, but no credential could unlock an edge that does not exist.
- **Permissions:** Would require an official highlights edge.
- **Provider methods:** —
- **Persists to:** —
- **Surfaced in:** `/targets/[id] (highlights tab shows UNAVAILABLE with reason)`

**Why it is unavailable.** The Instagram Graph API exposes no highlights edge (the exhaustive IG User edge list has none; the stories edge returns last-24h stories only). The only known alternative is the undocumented private reels_media endpoint, which this project forbids: no private endpoints, no session use, no access-control circumvention.

**What would unlock it.** An official, documented highlights edge or object. If one appears: add a provider method, normalize to a highlights table, scan on the story cadence, and render from snapshots like stories.

**Pipeline.** There is no provider method, table, pipeline, or UI beyond the honest unavailable state — by decision, not oversight.

### Public posts — `available`

- **Registry id:** `POSTS`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. Request shape is docs-pinned (documented IG Media fields only); pagination and cursor behavior are implemented but not yet observed live.
- **Permissions:** Public account media; graph returns the owned account's media.
- **Provider methods:** `getPublicPosts`
- **Persists to:** `posts`, `postPresence`, `postChanges`, `evidence`
- **Surfaced in:** `/targets/[id] (content tab)`

**Pipeline.** Listings paginate with opaque cursors; the executor persists a checkpoint per page, resumes after crashes, stops on duplicate cursors (PARTIAL, never a loop), and records idempotently. The provider shortcode is preferred with permalink parsing as fallback. A page without a cursor is a complete listing. For OWNED targets each scan also records media change state (FOUNDING §16): the caption as last read per post, a CAPTION_EDITED event when a caption read differs from the caption last read, and — only when the media listing completed — a NO_LONGER_OBSERVED event for posts absent from that complete listing ('no longer observed', never 'deleted'). DISCOVERY previews are never diffed.

### Reels as a distinct type — `available`

- **Registry id:** `REELS`
- **Live state:** `NOT_VERIFIED` — Mapping is the strongest correct one (provider-declared product type). Under Instagram Login the field is unavailable and reels render untyped — absence-tolerant by design, not yet observed live.
- **Permissions:** Same as POSTS. media_product_type is Facebook-Login-only.
- **Provider methods:** `getPublicPosts`
- **Persists to:** `posts`
- **Surfaced in:** `/targets/[id] (content tab, Reel label)`

**Pipeline.** A post is labeled Reel only when the provider declares media_product_type REELS. Untyped items render as posts — classification is never inferred from appearance, duration, or dimensions.

### Carousels and child media — `available`

- **Registry id:** `CAROUSELS`
- **Live state:** `NOT_VERIFIED` — Implemented end-to-end and covered by mocked-edge tests, but the live children edge has never been observed (no credentials). The edge itself is a documented public IG Media edge.
- **Permissions:** Same as POSTS. Per-child detail comes from the dedicated children edge.
- **Provider methods:** `getPublicPosts`, `getPostChildren`
- **Persists to:** `posts`, `postChildren`
- **Surfaced in:** `/targets/[id] (content tab, Carousel label plus per-child rows)`

**What would unlock it.** Live verification of the children edge under this integration's credentials; the pipeline, tables, and UI are already in place.

**Pipeline.** A post is labeled Carousel only when the provider declares media_type CAROUSEL_ALBUM. The POSTS_SCAN executor then expands provider-declared carousels through the dedicated children edge (isolated per album, so a children failure degrades the scan to partial without endangering the parent post) and persists items in provider order to post_children, rendered as child rows. Fixture v1 ships no child source, so fixture carousels stay childless by fixture design.

### Public comments — `available`

- **Registry id:** `COMMENTS`
- **Live state:** `NOT_VERIFIED` — No credentials in this environment. Request shape is docs-pinned (documented IG Comment fields only, max 50 per query per provider docs).
- **Permissions:** Comments on observable media.
- **Provider methods:** `getPublicComments`
- **Persists to:** `postComments`, `evidence`
- **Surfaced in:** `/targets/[id] (content tab, per-post threads)`

**Pipeline.** Each post carries a comment state: OBSERVED (source read, even when empty), UNAVAILABLE (no exposed comment source), NOT_SCANNED (capability off). Comment pages paginate like post pages. Comment like counts and author platform ids persist when the provider supplies them; a missing like count renders as absent, never zero. Empty is never faked and never conflated with unavailable.

### Comment replies and threading — `available`

- **Registry id:** `REPLIES`
- **Live state:** `NOT_VERIFIED` — Implemented end-to-end and covered by mocked-expansion tests, but live reply payloads have never been observed (no credentials).
- **Permissions:** Same as COMMENTS.
- **Provider methods:** `getPublicComments`
- **Persists to:** `postComments`
- **Surfaced in:** `/targets/[id] (content tab, reply badges)`

**What would unlock it.** Live verification under this integration's credentials; the pipeline, column, join, and UI are already in place.

**Pipeline.** Threading arrives through the documented replies field expansion (the listing edge returns top-level comments only) plus explicit parent_id values, flattened into rows carrying in_reply_to_comment_id. Replies render with the parent author resolved in one self-join. When the provider returns no threading, threads stay flat — flatness is data, not a bug.

### Follower roster and history — `available`

- **Registry id:** `FOLLOWERS`
- **Live state:** `DOCUMENTED_ABSENT` — The exhaustive Meta IG User edge reference lists no roster edge — counts-only is provider design, not an auth tier away. Fixture rosters exercise the full pipeline synthetically. The operator's own export (import:v1) carries REAL rosters lawfully: Instagram ships them to the account owner directly, so no live edge is involved.
- **Permissions:** Fixture exposes synthetic rosters; import:v1 reads the operator's own Instagram export for the real one. Graph exposes counts only, never lists.
- **Provider methods:** `getFollowers`
- **Persists to:** `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence`
- **Surfaced in:** `/targets/[id] (followers tab)`, `/relationships`, `activity timeline`

**What would unlock it.** A supported list endpoint (the Graph API has none by design).

**Pipeline.** Each scan appends a snapshot (COMPLETE or PARTIAL) with stable member rows. Diffs derive only between two COMPLETE snapshots: a newcomer is 'newly observed', a disappearance 'no longer observed' — never 'followed at 14:03' unless the provider supplies the event. PARTIAL scans are recorded but never diffed, so truncation cannot fabricate losses. import:v1 pages the export's followers_*.json files — one raw file per page with a genuine payload hash — so real rosters run the identical snapshot/diff machinery.

### Following roster and history — `available`

- **Registry id:** `FOLLOWING`
- **Live state:** `DOCUMENTED_ABSENT` — Same evidence as FOLLOWERS: no roster edge in the exhaustive reference.
- **Permissions:** Same as FOLLOWERS.
- **Provider methods:** `getFollowing`
- **Persists to:** `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence`
- **Surfaced in:** `/targets/[id] (following tab)`, `/relationships`, `activity timeline`

**What would unlock it.** A supported list endpoint (the Graph API has none by design).

**Pipeline.** Identical mechanics to FOLLOWERS, tracked under the FOLLOWING direction with its own snapshots, pagination, checkpoints, and diffs.

### Public like data — `UNAVAILABLE`

- **Registry id:** `LIKES`
- **Live state:** `DOCUMENTED_ABSENT` — Meta IG Media and IG Comment references expose like_count only — no actor edge. No credential could unlock an edge that does not exist.
- **Permissions:** Would require a public likes feed, which does not exist.
- **Provider methods:** —
- **Persists to:** —
- **Surfaced in:** `Relationships page states UNAVAILABLE with reason; like counts on posts and comments are labeled provider metadata`

**Why it is unavailable.** Instagram exposes no liker list through any supported interface: no liker edge exists on IG Media or IG Comment (the Facebook Comment likes edge is Facebook-only and must not be conflated). Anything labeled 'likes' beyond post/comment metadata would be fabricated.

**What would unlock it.** A documented IG liker feed. Until then the correct state is UNAVAILABLE.

**Pipeline.** There is no writer and no reader for like actors: per-post and per-comment like_count is provider-supplied metadata shown as such, never observed like activity.

### Interaction history — `UNAVAILABLE`

- **Registry id:** `INTERACTIONS`
- **Live state:** `DOCUMENTED_ABSENT` — No interaction feed exists in the IG Platform reference (nodes: IG Comment, IG Container, IG Hashtag, IG Media, IG User, Page).
- **Permissions:** Would require a lawful interaction feed.
- **Provider methods:** —
- **Persists to:** `interactions`
- **Surfaced in:** —

**Why it is unavailable.** No supported provider exposes interaction history. LIKE_SIGNAL in the model describes a shape, not a source. The insights edge was considered and rejected: it yields aggregates without actors or per-event timestamps, which cannot satisfy actor+kind+timestamp evidence.

**What would unlock it.** A lawful interaction source. Activation criteria: a provider method returning actor, kind, timestamp, and evidence; then add the writer, ledger branch, and UI.

**Pipeline.** The interactions table exists as a typed landing zone with a documented rationale in schema comments, but has no writer: no supported source provides interaction actors, counts with history, or timestamps. The relationships page derives association signals from mentions and deltas instead, labeled as observed association — never 'favorite people'.

### Repost count metadata — `available`

- **Registry id:** `REPOSTS`
- **Live state:** `NOT_VERIFIED` — Fixture v1 carries reposts_count and exercises persist/read end-to-end. Live: never observed (no credentials). Documented shape: top-level media only, owner-hideable; carousel children cannot carry it.
- **Permissions:** reposts_count is a documented IG Media scalar, top-level media only; the owner can hide counts.
- **Provider methods:** `getPublicPosts`
- **Persists to:** `posts`
- **Surfaced in:** `/targets/[id] (content tab, repost count where the provider returned one)`

**What would unlock it.** Live verification of reposts_count under this integration's credentials (harness scripts/verify-graph-provider.ts); then add it to GRAPH_MEDIA_FIELDS so the default live path surfaces it.

**Pipeline.** Parse-when-present (FOUNDING §17): a reposts_count returned by any provider is stored on the post row under the same first-observation semantics as like and comment counts — absent stays absent, never zero-filled. No reshare relationship is ever inferred, and a post is never classified a repost without evidence; naming repost actors is a separate, structurally unavailable capability (RESHARES). The graph media request deliberately does not ask for the field yet: an unknown field name fails the whole listing call, and this scalar has never been observed live.

### Reshare relations (who reposted media) — `UNAVAILABLE`

- **Registry id:** `RESHARES`
- **Live state:** `DOCUMENTED_ABSENT` — The exhaustive IG Media and IG User references expose reposts_count only — no repost node and no reshare edge. No credential could unlock an edge that does not exist.
- **Permissions:** Would require a repost object or reshare edge.
- **Provider methods:** —
- **Persists to:** —
- **Surfaced in:** —

**Why it is unavailable.** No repost object or reshare edge exists anywhere in the IG Platform reference — cross-account attribution is structurally unavailable, not unimplemented. This is the repost-identities refusal recorded in FOUNDING §14: the count scalar carries no actors, so no lawful source can name who reposted what.

**What would unlock it.** A documented repost object or reshare edge. No credential can unlock a node that does not exist.

**Pipeline.** There is no writer and no reader for reshare relations: no account is ever named as having reposted media in which this account is tagged, and no post is ever classified as a repost without provider evidence. The reposts_count scalar on IG Media is a count without actors — surfaced as provider metadata under the REPOSTS capability, never as a relation.

### Media bytes and assets — `UNAVAILABLE`

- **Registry id:** `MEDIA`
- **Live state:** `DOCUMENTED_ABSENT` — The IG Media reference documents media_url omission rules that rule out archival use. Metadata links render as user-initiated outbound links only.
- **Permissions:** Would require archivable provider URLs plus a storage policy.
- **Provider methods:** —
- **Persists to:** `mediaAssets`
- **Surfaced in:** `Provider links render as user-initiated outbound links behind an http(s) guard; bytes are never auto-loaded`

**Why it is unavailable.** No archivable source: fixture carries no media URLs and graph media URLs are expiring CDN links with documented omission semantics (copyright, reel-download settings) — never stable enough to archive.

**What would unlock it.** Provider-supplied stable URLs plus documented download permission and expiry semantics; then write metadata-first rows and cache bytes behind retention rules.

**Pipeline.** Metadata (types, shortcodes, permalinks, link URLs) persists on posts and stories. The media_assets table stays writerless by decision: neither provider yields archivable asset URLs today, and storing bytes without settled expiry, permission, and retention answers would be the real integrity violation. Images are never auto-fetched (no third-party IP leak, no SSRF).

### Cited claims ledger and account research report — `available`

- **Registry id:** `ACCOUNT_RESEARCH`
- **Live state:** `DOCUMENTED_ABSENT` — The platform exposes no documented edge for claim-predicate facts (no identity/organization/contact fields on any IG node) — their absence from the API is a finding, restated in FOUNDING §18. Live verification is a category that does not apply: the pipeline is local (validate, hash, store, render) and fully exercised by tests without credentials, and a claim is never a platform observation regardless of what a credential would return.
- **Permissions:** No provider permission applies: claims are submitted by the operator or their agent, each with the source that stated it, and the report reads stored claims plus stored observations only. The platform exposes no edge for any claim predicate (organization, industry, contact, affiliation, stated relationships), which is why no provider method is listed — and none can be added.
- **Supplied by:** operator/agent submissions — no provider method exists, and none can (the platform exposes no route)
- **Persists to:** `claims`
- **Surfaced in:** `igtrack claims add/list/retract (CLI)`, `igtrack research (CLI, --format md for a hand-off document)`, `claim_add / claims_list / claim_retract / research (MCP tools)`, `igtrack dossier (ACCOUNT_RESEARCH coverage row)`

**Pipeline.** A claim is a finding the operator (or their agent) researched: a predicate from a closed 9-entry registry, a value, an optional absolute http(s) source URL, an excerpt (hashed on write), and stated/retrieved times. Writes are validated and deduplicated — re-submitting the same finding is refused, because it is not corroboration. `igtrack research <account>` composes a deterministic report: sections built only from stored observations (identity and route, observation summary, leads, closest connections, coverage) and one section built only from claims, with per-predicate relation labels derived from distinct web domains (CORROBORATED at two or more domains, SINGLE_SOURCE at one, OPERATOR_ASSERTED for operator-only, CONFLICTED when values disagree — both sides kept, nothing chosen). Sensitive person-level predicates (employment, health, religion, politics, sexuality, ethnicity, criminal or legal history, home address, education records, family and personal relationships) are refused at write time, from every source. Claims are never merged into platform observations, never upgraded to facts, and never expire silently: a claim whose retrieval basis is older than 180 days is flagged DUE_FOR_REVIEW and stays exactly as it was recorded.

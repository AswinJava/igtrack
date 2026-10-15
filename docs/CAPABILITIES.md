# Capability matrix

> **Generated file — do not edit by hand.** `pnpm docs:capabilities` rewrites it
> from `CAPABILITY_REGISTRY` (`packages/core/src/capabilities.ts`); a test fails if it
> is stale. Prose cannot drift from the product because there is no prose.

14 of 19 capabilities are obtainable from a lawful source; 5 have no provider method at all. Separately, 7 capabilities are `DOCUMENTED_ABSENT`: the exhaustive platform reference lists no such field or edge, so their absence is a finding, not an assumption.

A capability can be available **and** documented-absent at the same time, and saying so is the point of this table: follower and following rosters are `DOCUMENTED_ABSENT` for any live interface — no roster edge exists — while the synthetic fixture provider exposes rosters so the pipeline can be built and tested end to end, and the operator's own Instagram export (`import:v1`) supplies the real roster lawfully.

## How to read this

| State | Means |
|---|---|
| `available` | At least one provider method supplies it, and its pipeline is wired end to end. |
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
| **Active stories** | available · `NOT_VERIFIED` | `getStories` | `stories`, `storySightings`, `evidence` |
| **Story metadata** | available · `NOT_VERIFIED` | `getStories` | `stories` |
| **Story mentions and tags** | available · `NOT_VERIFIED` | `getStories` | `storyMentions`, `evidence` |
| **Mention roll-up (not-established-visible accounts)** | available · `NOT_VERIFIED` | `getStories` | `storyMentions`, `evidence` |
| **Story highlights** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Public posts** | available · `NOT_VERIFIED` | `getPublicPosts` | `posts`, `evidence` |
| **Reels as a distinct type** | available · `NOT_VERIFIED` | `getPublicPosts` | `posts` |
| **Carousels and child media** | available · `NOT_VERIFIED` | `getPublicPosts`, `getPostChildren` | `posts`, `postChildren` |
| **Public comments** | available · `NOT_VERIFIED` | `getPublicComments` | `postComments`, `evidence` |
| **Comment replies and threading** | available · `NOT_VERIFIED` | `getPublicComments` | `postComments` |
| **Follower roster and history** | available · `DOCUMENTED_ABSENT` | `getFollowers` | `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence` |
| **Following roster and history** | available · `DOCUMENTED_ABSENT` | `getFollowing` | `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence` |
| **Public like data** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Interaction history** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | `interactions` |
| **Reposts and reshares** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | — |
| **Media bytes and assets** | `UNAVAILABLE` · `DOCUMENTED_ABSENT` | — | `mediaAssets` |

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
- **Persists to:** `posts`, `evidence`
- **Surfaced in:** `/targets/[id] (content tab)`

**Pipeline.** Listings paginate with opaque cursors; the executor persists a checkpoint per page, resumes after crashes, stops on duplicate cursors (PARTIAL, never a loop), and records idempotently. The provider shortcode is preferred with permalink parsing as fallback. A page without a cursor is a complete listing.

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

### Reposts and reshares — `UNAVAILABLE`

- **Registry id:** `REPOSTS`
- **Live state:** `DOCUMENTED_ABSENT` — No repost object or reshare edge in the reference; the scalar alone is UNVERIFIED (see field-coverage audit). Deliberately not probed blind: a failed fields name would break the working media call.
- **Permissions:** Would require explicit repost metadata under this integration's credentials.
- **Provider methods:** —
- **Persists to:** —
- **Surfaced in:** —

**Why it is unavailable.** reposts_count (with shares_count/saved_count/total_*) is documented on IG Media but top-level-only, owner-gated, and unverified under this integration's credentials — and an unknown fields name fails the entire listing call, so it is not requested speculatively. There is no repost object or reshare edge at all.

**What would unlock it.** Live verification of repost metadata under this integration's credentials (harness scripts/verify-graph-provider.ts); then persist attribution and render reshare relationships.

**Pipeline.** No verified provider surface in this integration returns repost counts, reshare edges, or original-author attribution, so no repost relationship is stored or shown. Similar-looking content is never classified as a repost without evidence.

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

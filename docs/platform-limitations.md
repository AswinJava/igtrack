# IGTrack Platform Limitations

Truth over completeness. Every row below is backed by the current `fixture:v1` provider and the absence of any other adapter.

## Capability matrix

| Feature | Requested | Implemented | Actually Available | Source | Limitations |
| ------- | --------- | ----------- | ------------------ | ------ | ----------- |
| profile (username, display name, bio, counts, verified) | yes | yes | AVAILABLE (fixture target only) | `fixture:v1/profile.json` via `getProfile` → `profile_snapshots` + `profile_changes` | Only synthetic `aurora.wilde`; unknown usernames `ACCOUNT_NOT_FOUND`; private `ACCOUNT_PRIVATE`; counts `null` mean unobserved, never zero |
| follower count | yes | yes | AVAILABLE | same as profile | Same scope; stale vs live distinguished by `observedAt` |
| following count | yes | yes | AVAILABLE | same as profile | Same scope |
| stories (active, media, ordering, timestamps) | yes | yes | AVAILABLE (3 synthetic stories) | `fixture:v1/stories.json` via `getStories` → `stories` + `story_mentions` | Ephemeral 24h; expired stories disappear; no media bytes archived (`media_assets` unwired); viewing reads stored observations, anonymity vs Instagram not guaranteed for live providers |
| highlights | yes | no | UNAVAILABLE | none — no provider method, no table, no UI pipeline | UI `/targets/[id]?tab=highlights` states UNAVAILABLE honestly; never fabricated |
| public posts | yes | yes | AVAILABLE (fixture target via POSTS_SCAN; owned account via graph) | `posts` + `post_comments` tables via `POSTS_SCAN` executor → `content` tab | Fixture: 2 posts, first page only (normalized v1 shape carries no next-cursor; MEDIUM confidence completes as PARTIAL). Graph: owned account media only; reels surface as posts with no distinct type |
| reels | yes | no | UNAVAILABLE as distinct type | none | No separate capability; future adapters must type reels explicitly, never infer from posts |
| reposts | yes | no | UNAVAILABLE as distinct type | none | Same as reels; only explicitly identified reposts may be shown |
| public followers (list) | yes | yes | AVAILABLE (5 synthetic, 2 pages) | `followers/page-*.json` via `getFollowers` → `follow_snapshots` + `follow_deltas` | `complete` false until final page; `PARTIAL` surfaced; pagination cursor is previous-page `next_cursor` value |
| public following (list) | yes | yes | AVAILABLE (4 synthetic, 1 page) | `following/page-1.json` via `getFollowing` | Same honesty rules |
| public mentions/tags | yes | yes | AVAILABLE where exposed | `stories.json` mentions via `normalizeMention` → `story_mentions` with `VISIBLE/POSSIBLY_HIDDEN/OFF_CANVAS/METADATA_ONLY/UNKNOWN` | Classification describes geometry/flags only; never proof of intent to hide; hidden/deleted/non-public tags are never revealed |
| historical snapshots | yes | yes | AVAILABLE | append-only `profile_snapshots`, `follow_snapshots`, `stories`; `UNIQUE(account,source,observedAt)` dedupes | Current state derived; history never overwritten; late backfills can fork `profile_changes` chain (documented) |
| follower changes | yes | yes | AVAILABLE (derived) | `diffFollowSets` → `follow_deltas` (`NEW_FOLLOWER/LOST_FOLLOWER`) | Labeled DERIVED; “newly observed” ≠ “proved followed at exact time” |
| following changes | yes | yes | AVAILABLE (derived) | same, `NEW_FOLLOWING/LOST_FOLLOWING` | Same epistemic rule |
| public comments | yes | yes | AVAILABLE where exposed (fixture post-1 has 3, post-2 UNAVAILABLE) | `post_comments` table via `POSTS_SCAN` → per-post comment lists in `content` tab | Missing source returns `UNAVAILABLE`, never empty-faked; comment pagination unsupported in fixture (cursor → ERROR); graph supports owned-media comments |
| public likes / interactions | yes | no | UNAVAILABLE | none — `interactions` table exists but no writer | Instagram exposes no public likes feed; correct behavior is UNAVAILABLE, never simulated; relationships scorer counts mentions + follow deltas only |

## Anonymous viewing

The product reads stored observations; it does not place a view under the IGTrack user's Instagram identity. Anonymity against Instagram's own logging cannot be guaranteed for any live provider architecture. The fixture source makes no network calls, so the question is moot there; any future Graph/scraping adapter must document its exact mechanism or state the limitation.

## What is forbidden (hard rules)

Credential harvesting, session/cookie theft, account takeover, bypassing auth/CAPTCHA/challenges/access controls, private-account access without authorization, detection-evasion, anti-forensics, covert surveillance. When a capability requires violating these, it is `UNAVAILABLE` by design and documented here.

## Authorized Graph provider (`IGTRACK_PROVIDER=graph`)

Implemented in `packages/ingestion/src/graph/graph-provider.ts` (official Graph API only, token via env, never logged/persisted). It observes ONLY the owned account (`IGTRACK_GRAPH_USERNAME`); all other usernames are `ACCOUNT_NOT_FOUND`. Profile, owned media, owned-media comments, and stories are attempted; follower/following lists are `UNAVAILABLE` (the API exposes counts, not lists); highlights/likes have no endpoint and stay `UNAVAILABLE`. Missing credentials fail fast as configuration errors, never as empty data.

## Legitimate alternatives

- Public profile/follow/stories: fixture today; authorized Graph API provider (owned Business/Creator account + Meta app + token via env/secret-store, never committed) is the only lawful live path. No scraping.
- Posts/comments pipeline: wired (`POSTS_SCAN` executor + `posts`/`post_comments` tables + evidence + `content` tab).
- Highlights/likes/reels/reposts: require explicit provider capability + persistence + UI; until then UNAVAILABLE.

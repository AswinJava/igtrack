# IGTrack — Product Specification

Status: Phase 1 spec. Scope gates per `roadmap.md`.

## 1. Product boundary

Public-data monitoring and intelligence only. UI language: "Public monitoring",
"Observed interaction", "Evidence", "Confidence", "Last observed", "Strongest
observed connections". Banned claims: "100% complete", "everything they liked",
"everyone they secretly interact with", "undetectable", "stalking".

## 2. Epistemic model (core feature)

Every data point carries:

- `category`: OBSERVED | DERIVED | INFERRED | UNAVAILABLE
- `confidence`: HIGH | MEDIUM | LOW | UNKNOWN
- `observedAt`, `firstSeenAt`, `lastSeenAt`
- `source` + evidence reference (provenance)

Examples:

- OBSERVED: "Account X commented on Account Y's public post."
- DERIVED: "X commented on Y 7 times in the observed period."
- INFERRED: "Y appears to be one of X's strongest public interaction relationships."
- UNAVAILABLE: "Instagram does not expose a complete public feed of everything this account liked."

## 3. Feature areas

### A. Target management

Add public username → resolve → validate → save. Pause/resume monitoring,
rename locally, notes, tags, status. Target header shows: username, display
name, profile image, bio, follower/following/post counts (when available),
verification state, account type, last observed, monitoring health, data
coverage.

### B. Profile change monitoring

Tracked fields: username, display name, bio, profile image, follower count,
following count, post count, verification status, external link. Rendered as a
profile timeline ("Aug 27 — Bio changed"). Every change links to evidence.

### C. Story monitoring

Per story: existence, timestamp, media type, duration, caption/text metadata,
public mentions, stickers, links, poll/question/location/music metadata — each
**when publicly observable**. No claims beyond owner-public surface.

### D. Mention intelligence (differentiator)

When story metadata exposes mentions, capture: mentioned account, account id,
position, size, visibility-related metadata, timestamp, story id, evidence.

Visibility classification (adapter-derived, never fabricated):

| Class | Basis |
|---|---|
| VISIBLE | source marks visible, or coordinates inside canvas |
| POSSIBLY_HIDDEN | source flag or heuristics suggest concealment |
| OFF_CANVAS | coordinates outside visible canvas |
| METADATA_ONLY | mention present, no render/position data |
| UNKNOWN | insufficient fields to classify |

If a source exposes `is_hidden`, store it. If it exposes coordinates, store
them. If neither exists → UNKNOWN/METADATA_ONLY. Never invent hidden status.

### E. Follower / following change tracking

Snapshot-based. Normalized entities + snapshot/delta rows (no giant JSON
blobs). Deltas: NEW_FOLLOWING, LOST_FOLLOWING, NEW_FOLLOWER, LOST_FOLLOWER.
Large accounts: pagination, incremental sync, resumable checkpoints, rate
limits, partial-sync state surfaced honestly. UI: "Recently followed",
"Recently unfollowed", "New followers", "Lost followers" — each row shows
Observed at / First seen / Confidence.

### F. Public interaction monitoring

Collect where publicly observable: comments, replies, mentions, public tags.
Likes via capability layer: LIKE_SIGNAL_AVAILABLE | PARTIAL | UNAVAILABLE.
When unavailable: "Instagram does not currently provide enough public data to
establish this interaction."

### G. Relationship intelligence ("Strongest Connections")

Weighted score from observed evidence: mentions, comments, follows, mutual
follows, recurrence, recency (decay), persistence, reciprocity, cross-content
interaction. Stores contributing signals. UI answers "Why is this account
ranked #1?" with the evidence breakdown. Language: "strongest **observed**
connections" — never "their real favourites".

### H. Relationship graph (post-MVP flagship)

Nodes: target + interacted accounts. Edges: follows / followed-by / comments /
mentions / interactions; thickness = strength, color = type. Filters: date
range, interaction type, new/disappearing relationships.

### I. Activity timeline

Unified event stream: PROFILE_CHANGED, STORY_POSTED, STORY_EXPIRED,
MENTION_OBSERVED, FOLLOWING_ADDED/REMOVED, FOLLOWER_ADDED/REMOVED,
COMMENT_OBSERVED, INTERACTION_OBSERVED. Filters by type.

### J. Analytics (evidence-based)

Posting/story frequency, activity by hour/weekday, follower/following growth,
relationship growth, interaction concentration, strongest recurring accounts.

### K. Story archive (where caching is legitimate)

Media + metadata + observed/expiry timestamps + source + checksum + content
hash dedup. States: ACTIVE / ARCHIVED / EXPIRED. Label: "Observed by IGTrack at
[timestamp]" — never imply ownership of Instagram's archive.

### L. Alerts (post-MVP)

Event-based: new following/follower lost, new story, new mention, relationship
change, profile change, source degraded. Adapters: in-app, browser, email —
swappable providers.

### M. Search

Global: usernames, display names, events, dates, relationships, mentions.
Filters: target, event type, date, confidence, source.

### N. Evidence system (mandatory)

"Why do we know this?" opens an evidence panel: source type, source reference,
observed/captured timestamps, confidence, raw + normalized hashes.

## 4. UX direction

Modern, premium, minimal, dark-first (accessible contrast), high information
density, strong typographic hierarchy, subtle motion, responsive, desktop
optimized. Intelligence/research dashboard feel — timeline, relationships,
changes, evidence over card grids.

Nav: Overview · Targets · Stories · Activity · Relationships · Followers ·
Following · Mentions · Timeline · Analytics · Evidence · Alerts · Settings.

Target overview order: header (identity, status, last observed, coverage) →
today's changes → recent stories → new following/followers → strongest
connections → activity timeline → relationship graph → evidence.

Every screen handles empty, loading, and failure states.

## 5. Security & privacy

AuthN/AuthZ, rate limiting, request validation, secure cookies, CSRF where
applicable, security headers, audit logging. Scraper/source credentials never
reach the browser. Users can delete targets, observations, archived media, and
export their data. Retention policies from day one.

## 6. AI features (post-MVP)

AI never invents observations. Allowed: summarize timelines, explain scores,
identify patterns, answer questions about collected evidence — every conclusion
links to underlying observations. Banned: definitive claims about private
relationships.

## 7. Definition of done

Implemented, typed, persisted, tested, error handled, observable, documented,
reachable in UI, empty/loading/failure states, mobile responsive, security
reviewed.

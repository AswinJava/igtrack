# IGTrack — Platform Limitations (honest capability map)

This document is the single source of truth for what IGTrack **can and cannot**
know about Instagram data, and why. It exists because the product refuses to
fake coverage.

## 1. Public vs private

- **Public accounts**: profile metadata, posts, stories (while live, 24h),
  comments on public posts, follower/following *lists* (viewable on the web
  app), mention metadata inside story payloads — observable to a human.
- **Private accounts**: nothing beyond username/existence. IGTrack requires
  authorization for anything more and ships **no** private-account access.
- **Never available**: DMs, hidden/close-friends stories, private likes feeds,
  "who viewed my profile", anything behind login-only surfaces without
  user-authorized access.

## 2. What Instagram reliably exposes (and doesn't)

| Capability | Reliability | Notes |
|---|---|---|
| Profile metadata (bio, counts, verified) | Medium | Public web embeds change shape without notice; counts are point-in-time |
| Stories of public accounts | Medium | 24h expiry; missed poll windows = permanent gaps |
| Story mention metadata | Low–Medium | Only what the source payload includes; hidden-mention signals vary by source/version; never guaranteed |
| Follower/following lists | Low–Medium | Paginated, rate-limited, login-gated in most surfaces; large accounts may only sync partially |
| Comments on public posts | Medium | Paginated; top/filtered views may hide items |
| Likes | **Unavailable as history** | No public "everything they liked" feed exists. Only like signals present in specific payloads, if any → capability layer reports PARTIAL/UNAVAILABLE |
| DMs / private anything | Unavailable | By design and by rule |

## 3. Legal / ToS position

- Automated collection from Instagram's public web surfaces **violates Meta's
  Terms of Service** and is actively blocked (login walls, challenges,
  rate limiting). IGTrack does **not** ship scrapers or bypass mechanisms by
  default, and will not implement challenge/CAPTCHA/auth evasion at all.
- **Meta Graph API / Instagram API** is permitted but scoped: it serves
  accounts the user owns or has been granted access to (business/creator).
  This powers a legitimate **self-monitoring mode**, not arbitrary third-party
  surveillance.
- **User-provided imports**: data the user legitimately holds (their own
  exports, their own authorized access) can be imported. Responsibility for
  lawful collection rests with the user; IGTrack documents this.
- Jurisdictional privacy laws (GDPR etc.) apply to storing data about people.
  Retention policies, deletion, and export exist from day one.

## 4. Supported source tiers

| Tier | Source | Status |
|---|---|---|
| T0 | **fixture** — versioned fixtures under `packages/ingestion/fixtures/` | Ships in MVP; dev/demo/test backbone |
| T1 | **user-import** — JSON/CSV of data the user legitimately holds | Planned (post-MVP) |
| T2 | **permitted integration** — Meta Graph API for user-owned/authorized accounts (self-monitoring) | Planned; requires app review |
| T3 | any further provider | Only after explicit legal review; plugs into the same `InstagramProvider` contract |

## 5. Consequences baked into the product

- Every provider method returns `CapabilityResult` — UNAVAILABLE is a first-class answer.
- The scheduler is provider-agnostic: it only enqueues scans for ACTIVE targets
  and never fabricates work when a provider cannot serve them. A scheduled scan
  of an unavailable provider completes with outcome `UNAVAILABLE` — never as an
  empty dataset.
- Story scans respect ephemerality: only stories actually observed in a scan
  window are persisted. Gaps between scans are unobserved time, never "no
  stories existed".
- Source health dashboard shows degradation; UI degrades gracefully with honest copy.
- Relationship scores are INFERRED, evidence-linked, never definitive.
- Coverage gaps are displayed ("no story observations between Aug 3–5"), never papered over.

## 6. User responsibilities

- Monitor only where lawful in your jurisdiction.
- Do not use IGTrack for harassment, stalking, or covert surveillance.
- Respect retention: delete targets you no longer need.

## 7. Research log

Findings about source behavior go in `docs/research/` with date, question,
source, finding, confidence, and implementation consequence. Old
reverse-engineering posts are leads, not truth.

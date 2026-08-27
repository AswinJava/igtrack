# IGTrack — Founder Brief

## What

IGTrack is a web-based **public Instagram intelligence platform**. A user adds a
public Instagram username as a monitoring target; IGTrack continuously builds a
historical, evidence-backed picture of the publicly observable activity around
that account.

Questions it answers:

- What changed on this profile, and when?
- Who did this account recently follow / stop following?
- Who recently followed / unfollowed it?
- What public stories appeared, and whom did they mention?
- Which public accounts does it repeatedly interact with?
- What are its strongest observed public connections, and why?
- What happened in a date range — and what is the evidence for each claim?

## Why

Existing tools either over-promise ("see everything they like") or present
scraped data with zero provenance. IGTrack's differentiator is **epistemic
honesty as a product feature**: every claim is typed (observed / derived /
inferred / unavailable), timestamped, confidence-rated, and linked to evidence.
That makes it a research-grade instrument instead of a toy scraper.

## Core principle

**OBSERVATION ≠ FACT ≠ INFERENCE.**

| Category | Meaning |
|---|---|
| OBSERVED | directly obtained from an available source |
| DERIVED | computed from observed data (counts, diffs) |
| INFERRED | probabilistic conclusion (relationship scores) |
| UNAVAILABLE | cannot currently be reliably obtained — said out loud |

## Hard boundary

Public data, user-authorized access, or permitted integrations only. No
credential harvesting, no auth/CAPTCHA bypass, no private-account access, no
evasion mechanics, no covert surveillance. See `platform-limitations.md`.

## MVP (first shippable)

1. Add public target
2. Profile snapshots + change timeline
3. Story observation
4. Mention extraction where metadata exposes it
5. Follower / following snapshots
6. Follow diffs (new/lost)
7. Unified activity timeline
8. Evidence/provenance panel
9. Basic relationship ranking with explainable scores
10. Basic dashboard + source health

Post-MVP: alerts, relationship graph, media archive, analytics depth, AI
explanations.

## Decision rule (conflicts)

1. Safety/legal/platform integrity
2. Technical correctness
3. Data integrity
4. Product usefulness
5. Reliability
6. UX
7. Cost
8. Speed

Never sacrifice data integrity to make a feature appear to work.

## Cost posture

Open-source stack, runs locally, no paid SaaS dependency. Every external
dependency sits behind an abstraction. Zero-cost has real limits (rate limits,
storage, source availability) — documented, not hidden.

# Architecture

IGTrack is a small system with an unusual constraint: **every number it shows
must be traceable to an observation, and everything it cannot observe must say
so.** The architecture exists to make that property structural rather than
aspirational.

## Layers

```text
                       ┌──────────────────────────────────────────┐
  agent  ── MCP ──────▶ │  apps/cli  (tools.ts = operations layer) │
  human  ── CLI ──────▶ │  one implementation, two renderings      │
                       └────────────────┬─────────────────────────┘
                                        ▼
                       ┌──────────────────────────────────────────┐
                       │  packages/database  schema · repos · queue│
                       └────────────────┬─────────────────────────┘
                                        ▲
                       ┌────────────────┴─────────────────────────┐
                       │  workers/monitoring  claim → execute →    │
                       │  complete, checkpoints, scheduler         │
                       └────────────────┬─────────────────────────┘
                                        ▼
                       ┌──────────────────────────────────────────┐
                       │  packages/ingestion  fixture | graph      │
                       └────────────────┬─────────────────────────┘
                                        ▼
                       ┌──────────────────────────────────────────┐
                       │  packages/core  models · epistemics ·     │
                       │  capability results · diffs (no deps)     │
                       └──────────────────────────────────────────┘
```

Dependencies point downward only. `packages/core` has **zero** runtime
dependencies, which is why the epistemic rules are testable in isolation and
cannot be quietly re-implemented in a UI.

## The observation pipeline

1. **Queue** — the scheduler (`workers/monitoring/src/scheduler.ts`) computes a
   window per scan kind (`floor(now / interval)`), and calls
   `enqueueScheduledScan`, a single race-safe `INSERT … SELECT` guarded on target
   status with a unique idempotency key that encodes the window. A target paused
   between selection and insert can never receive a job; a duplicate window
   resolves to a no-op instead of a duplicate scan. The insert is also guarded on
   the target's **observation mode**: an owned-only kind is never queued for a
   `DISCOVERY` target and `DISCOVERY_SCAN` is never queued for an `OWNED` one
   (FOUNDING D47), so a scan that cannot succeed is refused before a job exists.
2. **Claim** — `claimJob` uses `FOR UPDATE SKIP LOCKED` with a lease and a
   heartbeat. Multiple workers are safe; a dead worker's job is reclaimed after
   the lease expires. `started_at` is preserved across retries and reclaims,
   which is what makes a *logical scan* identifiable.
3. **Execute** — one executor per kind (`PROFILE_SCAN`, `FOLLOWER_SCAN`,
   `FOLLOWING_SCAN`, `STORY_SCAN`, `POSTS_SCAN`, `TAGS_SCAN`, `INSIGHTS_SCAN`,
   and `DISCOVERY_SCAN` for observed accounts). Every provider call crosses
   `providerCall()`, which applies a timeout, counts the call, and converts a
   hang into a typed retryable `TIMEOUT` — never a silent success.
4. **Persist** — repositories write observations *and* their evidence row. The
   evidence ledger is append-only and carries the source id, observation id,
   observed vs. captured time, confidence, and hashes.
5. **Derive** — diffs (`persistFollowDiff`, profile changes) run **only between
   COMPLETE snapshots**. A partial listing is stored and labelled, and can never
   produce a "lost follower".
6. **Read** — the CLI and the agent tools read through the same repositories,
   scoped to one owner. There is no second data path to keep in sync.

## Reliability details worth knowing

- **Resumable scans**: paged scans checkpoint after each page (cursor + page) and
  stage acquired members in a durable table, so an interrupted scan resumes
  instead of restarting or losing a page.
- **Lease loss**: a scan that loses its lease stops writing and reports `lost`
  rather than racing the reclaim winner.
- **Retryability**: provider-declared retryability wins; a non-retryable kind is
  permanent regardless of what a broken provider claims. Backoff is computed
  from the failure classification.
- **Retention**: an hourly maintenance tick purges terminal job rows older than
  the retention window. Growth is bounded by default.
- **Source health**: every capability outcome updates a `source_health` row, so
  "degraded" and "structurally unavailable" are both visible and distinguishable.
- **Observed (non-owned) accounts**: `DISCOVERY_SCAN` records the documented
  Business Discovery profile as a COMPLETE, diffable snapshot and its
  recent-media preview as posts rows. The preview is a window the edge does not
  page, so each row carries the ceiling in its evidence metadata, the scan
  completes as `COMPLETED_PARTIAL`, and media rows keep the platform's published
  time apart from our first-observation time. `igtrack dossier <username>` reads
  the whole record back with per-capability coverage from the registry.

## Epistemics (the part that is the product)

| Concept | Meaning in this codebase |
|---|---|
| `CapabilityResult` | The return type of every provider call: `AVAILABLE` / `PARTIAL` / `UNAVAILABLE` / `ERROR`, plus confidence, observed time, and optional raw hash. |
| `UNAVAILABLE` | A documented fact about the source, with a note. Never an error, never empty data. |
| `PARTIAL` | A truncated read. Stored honestly, never diffed. |
| `null` | "Not observable". Never coerced to `0`, in SQL, JSON, CLI tables, or UI. |
| Confidence | Carried per observation from the provider's own assessment. |
| Evidence | The append-only ledger row that makes a claim auditable. |
| Capability registry | The single source of truth for what the product can show; `docs/CAPABILITIES.md` is generated from it and a test fails if it drifts. |

## Configuration and failure modes

- A missing database URL is a startup error, never an empty dataset.
- An unknown provider name fails fast at boot (worker) or first use (CLI).
- Missing Graph credentials fail fast. A missing credential must never be
  indistinguishable from "no data".
- Numeric env values out of range fall back to defaults — except the worker boot
  guard, which refuses to start on dangerous lease/poll values rather than
  silently duplicating scans.

## Reserved, and honest about it

These exist in the schema or environment but have no producer. They are kept
deliberately: they encode decisions, and tests assert they stay empty.

| Thing | State |
|---|---|
| `interactions` table | Dormant landing zone. No lawful provider supplies an interaction feed; `LIKE_SIGNAL` describes a shape, not a source. |
| `media_assets` table | Dormant. No archivable media source exists (expiring CDN URLs, copyright and download semantics). |
| `IGTRACK_MEDIA_DIR` | Read by nothing. Documented future home for media bytes. |
| Notification env vars | Reserved names only; no adapters. Alerts are an agent-side concern (`igtrack activity --since`). |

## Where to extend

| Goal | Touch |
|---|---|
| New agent operation | `apps/cli/src/tools.ts`, then the MCP server + CLI router + tests |
| New data source | `packages/ingestion` (`InstagramProvider`), then `providerFromEnv`, the capability registry, fixtures, conformance test |
| New persisted shape | `packages/database/src/schema` + a generated migration |
| New scan kind | `SCHEDULABLE_KINDS`, an executor, scheduler cadence, checkpoint expectations |
| New capability | The registry first (with a reason), then the provider method, then storage |

Read [AGENTS.md](../AGENTS.md) for the invariants that must survive any change,
and [FOUNDING.md](FOUNDING.md) for why the system was shaped this way.

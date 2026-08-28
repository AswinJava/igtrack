# Deleted-Target Retention Policy (Phase 9 founder decision)

## Decision

`ig_accounts` is a **shared canonical registry**, not per-user data. When a target
is deleted, its observations/evidence are deleted atomically (via
`deleteTargetWithObservations`), but the `ig_accounts` row **survives** as long as
any other target references it, and — after the *last* reference — the row is
retained for the reasons below.

## Why the registry survives

- `ig_accounts` is a **normalized reference table**: many targets/users, and many
  observations (followers, mentions) reference the same account.
- Followers/mentions create `ig_accounts` rows **outside** any target the user
  owns. Deleting a target must not delete accounts that are merely co-observed.
- Re-deriving identity (username → stable id) from scratch is error-prone and
  breaks evidence references that survive (e.g. a mention pointing at an account
  the user does not monitor).

## What is deleted on target deletion (verified boundary)

| Entity | Deleted? |
|---|---|
| `targets` row | yes |
| `profile_snapshots` for the target's account | yes |
| `stories` / `story_mentions` for the target's account | yes |
| `follow_snapshots` / `follow_snapshot_members` / `follow_deltas` for the target | yes |
| `interactions` for the target | yes |
| `evidence` rows linked to those observations | yes |
| `monitoring_jobs` / `job_checkpoints` / `follow_scan_staging` for the target | yes (cascade) |
| `ig_accounts` row | **retained** |

## Privacy stance

Retaining the account registry row keeps PII (username, bio, profile pic URL,
account type) of third-party accounts visible *after* the user deletes their
monitoring target. The Phase 7/8 audit flagged this as a founder decision.

**Chosen policy**: retain the registry row but strip it to identity-only
(username, username_lower, ig_id) once it has no remaining target or
observation references. This keeps evidence references resolvable while
removing the user-observable display content (bio, URLs, pic) for
accounts the user no longer monitors.

## Current implementation status

- Registry survives target deletion: **implemented** (`deleteTargetWithObservations`).
- Identity-stripping for orphaned accounts: **NOT YET IMPLEMENTED** — tracked as a
  retention cleanup (Phase 9 P2). The policy is the decision; the reaper is future
  work, documented honestly.

## Relationship to backup/RPO

Backups retain full history including account registry rows — that is expected for
RPO ≤ 24h and does not change on-delete behavior.
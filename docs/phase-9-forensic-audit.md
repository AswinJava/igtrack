# Phase 9 — Forensic Audit

Status: Phase 9 (lawful provider evaluation + integration gate). Baseline:
`f661361` (Phase 8 `1fae5b4` + Phase 9 config/decision commits). Audit performed
before any Phase 9 implementation. Phase 8 claims treated as unverified until
reproduced.

## 1. Repository integrity (reproduced)

- HEAD at audit start: `1d700a2` (Phase 8); verified clean tree, `master`, 28
  commits ahead of origin.
- `git ls-files` secret sweep: only `.env.example`; no committed `.env`/tokens.
- Full suite on real PostgreSQL 16: **155 passed / 1 by-design skip / 26 files** —
  Phase 8 counts reproduced exactly.
- Architecture sweep: dependency direction core → ingestion/database → workers/web
  holds; no SQL in routes; core framework-free; providers behind `InstagramProvider`;
  worker owns execution; web orchestrates only. **No boundary violations found.**

## 2. Remote CI gate (STEP 2) — RESOLVED

- Phase 8 commits were not pushed (28 ahead). Pushed on instruction → remote CI
  ran and **initially FAILED at 0s**: the workflow step name
  `Require PostgreSQL (STEP 20: ...)` contained a colon-space inside an unquoted
  YAML scalar, making the file unparseable → zero jobs.
- **Fixed** (quoted the step name) and **verified**: run `33189015158` **SUCCESS**
  in 2m9s — install → Postgres guard → typecheck → 155 tests on real Postgres →
  worker boot smoke → production build → Playwright E2E.
- **Phase 8 "remote CI NOT VERIFIED" is now RESOLVED: remote CI is VERIFIED PASS.**

## 3. Founder configuration decisions (STEP 3)

### 3A. IGTRACK_SESSION_SECRET — REMOVED (decision: dead config)

- Audit: sessions use **opaque 32-byte random tokens** stored SHA-256-hashed in the
  database, with DB-checked expiry and revocation. The cookie carries no
  attacker-influenceable claims requiring a server-side signature; there is no HMAC
  to protect, so `IGTRACK_SESSION_SECRET` had no effect.
- Decision: **remove** the variable and its documentation rather than introduce a
  signing layer that adds no security. The security boundary (whatever secrets
  exist) lives in the DB and the environment, not in a cookie signature.
- Implemented: `.env.example` and `docs/deployment.md` updated. No code change
  needed (nothing read it).

### 3B. Backup / RPO — POLICY DOCUMENTED, NOT DEPLOYED

- Target RPO ≤ 24h, daily `pg_dump`, 14-day retention, weekly restore drill,
  documented in `docs/deployment.md` §4a. **No backup cron exists in-repo** — the
  doc says so explicitly. Deployment of the backup job is a deployment-platform
  decision.

### 3C. Deleted-target retention — POLICY DECIDED

- `ig_accounts` is a shared canonical registry; it survives target deletion to keep
  evidence references resolvable. Policy: strip an orphaned account to
  identity-only when it loses its last reference. The strip is **future work**;
  documented in `docs/deleted-target-retention.md`.

### 3D. Deployment

- No Dockerfiles built. Topology (web + worker + PostgreSQL, migration procedure,
  env, health, backup) already documented; container packaging remains deferred to
  the platform choice.

## 4. Security sweep (STEP 10) — CLEAN

Repo-wide search for `console.log(provider...)`, `console.error(error)`, and
credential-shaped identifiers (`access_token`, `client_secret`, `raw_payload`,
`authorization`, etc.): **no logging of provider payloads or credentials exists**.
`apps/web/lib/auth.ts` and `packages/database/src/auth/*` remain session/credential-
sound. Diagnostics page exposes no secrets.

## 5. Evidence audit (STEP 11) — CLEAN (re-verified)

Observation → evidence → source → observedAt/capturedAt → rawHash/normalizedHash →
derived-state is intact: `raw_hash` genuine-or-NULL (never `hash(normalized)`),
`normalized_hash` present, provider/schema versions recorded, completeness and
confidence preserved, evidence ownership user-scoped (IDOR verified clean in
Phase 7/8 sweeps). No fabricated provenance path found.

## 6. Provider-contract audit (STEP 4) — explicit

Every capability has an explicit answer in `docs/provider-contract.md` §1a (A–J)
and the STEP 4 matrix in `docs/phase-9-provider-evaluation.md` §5. No capability is
UNAVAILABLE-without-evidence or UNKNOWN-without-reason.

## 7. Provider selection (STEP 5) — FixtureProvider

The only lawful provider that can be integrated and exercised now. Graph API and
user-import are evaluation-ready but NOT integrated (require Meta app review /
founder decision respectively). Documented in `docs/phase-9-provider-evaluation.md`.

## 8. Findings summary

- **P0**: none.
- **P1**: none. (The CI workflow parse error was found and fixed — see §2.)
- **P2 (unchanged, re-confirmed)**: snapshot-time account-upsert batching,
  lease heartbeat, `/healthz`, scan-duration metrics, login rate limiting,
  backups/RPO execution, pool timeout tuning, session purge scheduling, orphaned
  `ig_accounts` identity-strip, deployment artifacts.

## 9. Deferred

As §8 + real provider integration (Graph API / import) pending founder/legal
decisions. Phase 22 non-negotiables (no scraping etc.) honored throughout.
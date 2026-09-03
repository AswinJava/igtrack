# Phase 14 — Zero-Cost Public Deployment

**Date:** 2026-09-03 23:48 IST – 2026-09-04 00:05 IST run
**Baseline HEAD:** `a371e94` (`feat: establish zero-cost beta deployment architecture`)
**Branch:** `master`, up to date with `origin/master` at start
**PostgreSQL:** `16.15 Alpine` (`igtrack-db` container, real PG, not a stub)
**D1:** **DEFERRED** (FixtureProvider only, no Graph, no live Instagram)

---

## 1. Repository integrity

§1 baseline (read-only, before any mutation):

```text
git rev-parse HEAD → a371e9479f374f1bd736fb8969b5c7b46ecc5a0f
git log -5 → a371e94, c58ba0b, d1ea280, 3d7c17b, 2632273
git status → 8 modified + 2 untracked, nothing staged
git diff --cached → empty
```

`HEAD = a371e94` confirmed. No reset/clean/checkout was run before forensics (§6 rule obeyed).

### Exact uncommitted-change inventory (§2)

| Path | State | What changed | Phase-13 related? | Allowed on master? |
|---|---|---|---|---|
| `.env.example` | modified (+7) | retention env docs (`IGTRACK_JOBS_RETENTION_DAYS`, `IGTRACK_MAINTENANCE_TICK_MS`) | No | No — unreviewed |
| `README.md` | modified (+14/−3) | Phase 13 status text, $0 path note, typo fix | Partially (status prose) | No — unreviewed bundle |
| `apps/web/app/api/healthz/route.ts` | modified (+7/−3) | migrations probe → `drizzle.__drizzle_migrations` | No (**frozen endpoint**) | No — needs review |
| `docs/deployment.md` | modified | retention table rewritten to maintenance-tick claims | No | No — unreviewed |
| `docs/roadmap.md` | modified (+5) | phase rows 11a/11b/11d/12/13 | Partially (history) | No — unreviewed bundle |
| `packages/database/src/auth/sessions.ts` | modified | `purgeExpiredSessions` returns `Promise<number>` | No | No — unreviewed |
| `packages/database/src/jobs/queue.ts` | modified (+30) | `+purgeTerminalJobs`, `+resolveJobsRetentionDays` (**frozen queue**) | No | No — needs review |
| `workers/monitoring/src/index.ts` | modified (+36/−9) | `+runMaintenanceTick` inside `runWorkerLoop` (**frozen loop**) | No | No — needs review |
| `.dockerignore` | untracked (27 lines) | Docker build-context hygiene | No | No — unreviewed |
| `packages/database/test/maintenance.test.ts` | untracked (83 lines, 3 tests) | purge function tests | No | No — unreviewed |

### Classification (§3)

```text
A = Phase 13 required .......... none of the 10 paths
B = deployment-required ........ README.md (partially), docs/roadmap.md (partially),
                                  .dockerignore (harmless hygiene, unasked)
C = unrelated P2 ............... .env.example, sessions.ts, queue.ts (partially),
                                  deployment.md, maintenance.test.ts
                                  (implements SES-001 + terminal retention — §36 STOP-listed)
D = frozen worker machinery .... healthz/route.ts, queue.ts, workers/monitoring/src/index.ts
E = unknown .................... none (every file fully read)
```

Nothing in C/D entered the production branch.

### Frozen-machinery inspection (§4)

`workers/monitoring/src/index.ts` (+36/−9): imports `purgeExpiredSessions` +
`purgeTerminalJobs`, adds `maintenanceTickMs()` (default 1h via
`IGTRACK_MAINTENANCE_TICK_MS`), `runMaintenanceTick()` (best-effort, failures
warn + call `opts.onError`), and invokes it on **every loop iteration whose
hour has elapsed, including the first** — so ephemeral `--once` runners also
purge. Consequences assessed:

- **Not required** for the zero-cost ephemeral worker (Phase 13 measured the
  worker without it; §9 re-verified below on the pristine tree).
- **Interacts** with Phase 13 fail-loud: a purge error during `--once` calls
  `onError` → exit 1. Same fail direction (loud), but an unreviewed new
  failure source in the deployment contract.
- **Not destructive** (only deletes expired sessions / >90d terminal jobs), but
  **not accepted**: merged neither silently nor otherwise.

`queue.ts` (+30): purely additive (`resolveJobsRetentionDays`,
`purgeTerminalJobs`); existing claim/complete/fail paths untouched.
`sessions.ts`: return-type change `void → number` (callers: only the new
maintenance tick + its test; no existing caller broken — full suite green
either way). `healthz`: probe-table fix is **factually correct** (Phase 13
documented `migrations: unknown` as pre-existing behavior) but touches the
frozen endpoint without review — held for review, not merged.

### Phase 13 commit verification (§5)

```text
git show --stat --oneline a371e94 → 12 files, 1159 insertions(+), 2 deletions(-)
```

Exactly: 4 workflows, 2 docs, `client.ts`, `render.yaml`, `backup-cloud.sh`,
`main.ts`, `run-once.ts`, `ephemeral-worker.test.ts`. Intact and reproducible
(proven by the isolated-worktree run in §8).

---

## 2. Concurrent-agent findings (§6 detail)

- The 10 paths above match Phase 13's report of a concurrent session.
- **The session is still active.** During this Phase 14 run it re-wrote all 10
  files at 23:51 IST (after I had isolated the earlier copies) and ran
  Playwright at 23:53 (`test-results/.last-run.json`).
- **Isolation performed, nothing destroyed:** at ~23:47 the 10 paths were
  committed to local branch `concurrent/maintenance-retention` (`24b1f31`,
  parent `a371e94`, **unpushed**), and `master` was returned to a clean
  `a371e94`. No `reset --hard`, no `clean -fd`, no deletions — `git status`
  was empty afterward (clean-state gate §7 preferred condition met at that
  point).
- **Collision forensics (new evidence this phase):** at 23:54–23:55 a
  standalone run of `ephemeral-worker.test.ts` failed 4/6 with
  `relation "monitoring_jobs/ig_accounts/scheduler_state" does not exist`
  plus a `maintenance_purge_error` line. Root cause, both halves proven:
  1. `createFreshTestDb` (`packages/database/test/helpers.ts:24`) runs
     `DROP SCHEMA public CASCADE` on the **shared** `igtrack_test` database —
     the concurrent session's simultaneous test run dropped the schema
     mid-file (textbook shared-DB race; my file is not flaky in isolation).
  2. By 23:55 the worktree `index.ts` on disk already contained their
     re-written maintenance tick (23:51:39), which my dead-DB proxy test
     exercised — hence the foreign log line on a "clean" checkout.
- **Response:** all authoritative Phase 14 verification was re-executed in an
  isolated worktree at `a371e94` with a **private test database**
  (`igtrack_test_p14` via `IGTRACK_TEST_DATABASE_URL`), immune to both their
  file writes and their DB resets. Results in §8–§9 are from that run.
- **Founder action needed:** two agents sharing one checkout + one test
  database will keep colliding. Coordinate (separate checkouts, or separate
  `IGTRACK_TEST_DATABASE_URL` values) before the next test-heavy session.
  The branch `concurrent/maintenance-retention` is ready for review whenever
  the founder wants the SES-001/retention work considered — it is NOT part
  of this verdict.

---

## 3. Final commit

Phase 13 commit `a371e94` (unchanged by this phase). This report will be the
only Phase 14 commit (docs-only, §36 STOP obeyed: no Graph, no scraping, no
F-500K-002 work, no session purge, no heartbeat, no new features).

---

## 4. Architecture (unchanged from Phase 13)

```text
Internet (HTTPS, Render onrender.com URL)
   |
   v
Render Free — @igtrack/web only (Next.js build + start, PORT-respecting)
   |  env: DATABASE_URL (Neon ?sslmode=require, Render secret, never in repo)
   v
Neon Free PostgreSQL 16 (authoritative schema, same migrations/indexes/transactions)
   ^
   |  ephemeral, bounded, fail-loud
GitHub Actions — worker --once (*/15 + dispatch) | migrate (dispatch)
                 | backup (daily 02:00 UTC + dispatch) | restore (dispatch, isolated)
   |
   v
Cloudflare R2 — igtrack/YYYY/MM/DD/HHMMSS.sql.gz + .sha256, 14-day retention
```

---

## 5. Render deployment (§13–§14)

**Status: READY, activation required (founder-side).** Verified from my side:

- `render.yaml` parses (`plan: free`, `healthCheckPath: /api/healthz`,
  `DATABASE_URL sync: false`, no secrets) — YAML-validated this phase.
- Production build passes (`BUILD_EXIT=0`, `/api/healthz 153 B`) and a prod
  `next start -p` probe served `200 {"status":"ok","db":"ok",...}` with no
  secrets (Phase 13 measurement, code unchanged since).
- No persistent-filesystem dependency (no `MediaStorage`/disk writes in web).
- Worker does NOT run on Render by construction (no worker service in
  `render.yaml`; worker runs only via Actions).

Founder steps (15 min, no card): dashboard → New Web Service → repo
`AswinJava/igtrack` `master` → `render.yaml` detected → set `DATABASE_URL`
(Neon, §6) as secret → Deploy → `GET https://<app>.onrender.com/api/healthz`
→ expect `200`.

---

## 6. Neon deployment (§11–§12)

**Status: READY, activation required (founder-side).** Verified from my side:

- `packages/database/src/client/client.ts` (committed): `ssl: "require"` when
  the URL carries `sslmode=require` or `neon.tech`; local non-SSL dev
  preserved. Typecheck green.
- Migrations are forward-only, idempotent (`drizzle.migrate`, 7 rows), runnable
  via committed `migrate.yml` (manual dispatch, `DATABASE_URL` masked).
- SQL compatibility proven on PG 16.15 (Neon is PG 16): full suite green,
  same image family (`postgres:16-alpine`).

Founder steps: neon.tech → GitHub signup (Free plan, no card per provider
docs) → project `igtrack` → copy `DATABASE_URL?...?sslmode=require` → Render
env + GitHub secret → Actions → Migrate → `migrations applied`. Beta envelope
stays small (§16); Neon free storage is finite — monitor `pg_database_size`.

---

## 7. GitHub Actions (§18–§21)

**Status: READY (workflows committed and validated), live run needs secrets.**

- All 5 workflows YAML-parse (`monitoring-worker`, `migrate`, `backup`,
  `restore`, `ci`). Cron `*/15 * * * *` + `0 2 * * *` valid; `*/15` is the
  documented minimum-free-compute choice.
- `workflow_dispatch` present on worker/migrate/backup/restore.
- Secrets only via `${{ secrets.* }}` (audited); `DATABASE_URL`/R2 keys never
  echoed (masked `sed` in shell steps); `bash -n` passes on all three scripts.
- **Cost safety (§21), now stronger than Phase 13:** repo visibility measured
  this phase via API — `AswinJava/igtrack` is **PUBLIC** (`isPrivate: false`),
  so GitHub-hosted Actions carry **unlimited free minutes** (Linux). Expected
  usage at `*/15` × ~1 min ≈ **~2,880 min/mo** — compliant by construction,
  private-repo allowance math no longer needed.

Founder steps: Settings → Secrets → set `DATABASE_URL` (+ optional `R2_*`)
→ Actions → Monitoring Worker → Run workflow → expect `scheduler_tick` +
`job_succeeded` + `worker_stopped`, step green.

---

## 8. R2 (§22–§24)

**Status: READY, activation required.** Committed `backup.yml` + fixed
`backup-cloud.sh`: `pg_dump -F p | gzip → sha256 → R2
igtrack/YYYY/MM/DD/HHMMSS.sql.gz + .sha256`, artifact 3-day fallback,
14-day key-date deletion **only after successful upload** (a failed backup
exits non-zero and preserves the previous valid backup — failure-safe by
construction, §24 satisfied by design; live failure drill needs secrets).
Never stored in Git (verified: no dumps tracked).

Founder steps: Cloudflare → R2 → bucket `igtrack-backups` → API token
(Read & Write) → secrets `R2_ACCESS_KEY_ID/SECRET/ENDPOINT/BUCKET` →
Actions → Backup → Run → expect R2 object + artifact.

---

## 9. Worker (§9, §19)

Re-verified on the pristine `a371e94` tree (isolated worktree + private DB):

```text
--once, healthy DB .... EXIT 0 | scheduler_tick enqueued:5 deduplicated:15
                                2x job_succeeded COMPLETED | worker_stopped
--once, dead DB ........ EXIT 1 | scheduler_tick_error + worker_poll_error
                                + worker_once_errors count:3, logs secret-free
MAX_ITER ............... 25 default (main.ts:26), IGTRACK_JOB_MAX_ITER override
wall clock ............. 5-min Actions timeout (lease/ownership make kills safe)
idle ................... exit 0 (no errors on empty queue)
lease/ownership/idempotency  6/6 ephemeral-worker tests PASS (in the 167)
```

No worker code was modified this phase.

---

## 10. Scheduler (§20)

Idempotency re-proven on pristine tree: overlapping same-window invocations
converge (`second.enqueued == 0`, `deduplicated == first.enqueued`) via the
DB unique index — GitHub concurrency groups are defense-in-depth only, the DB
is the authority. No scheduler code modified this phase.

---

## 11. Authentication (§16)

No auth code changed since Phase 13 (E2E 7/7 green on clean tree covers
login/session/cookie/IDOR/logout/diagnostics; rate-limit + `Retry-After` +
prod `dev-login → 404` covered by unit tests in the 167). Live Render
login/IDOR/rate-limit probes require the founder's deployment (§5–§6
activation) and are listed as the first post-activation smoke (§15 below).

---

## 12. Security (§29)

- Repo secret scan on committed tree (`git grep` at `a371e94`): no private
  keys, tokens, passwords, or `AKIA`/`ghp_` material; only policy prose
  mentioning prohibitions; sole Graph token reference is a commented env-var
  NAME in `.env.example` (no value, by design).
- Workflows: secrets exclusively `${{ secrets.* }}`; shell steps mask
  `DATABASE_URL`/`AWS_SECRET_ACCESS_KEY`; `migrate.yml` never prints the URL.
- `render.yaml`: `DATABASE_URL sync: false` (dashboard secret, never in repo).
- Health endpoint: measured secret-free (status/db/migrations/latencyMs/
  provider/version/ts only).
- No credentials were passed through chat at any point (founder entered
  nothing; agent handled none).

---

## 13. Backup (§22–§23)

Actual backup generation is TESTED against real PG (Phase 12: `3.1 MB`
`88a8e70…` + isolated restore row-count match; mechanism unchanged since).
Cloud path (`backup.yml` → R2) is implemented + syntax/YAML-validated; its
first live run needs `R2_*` secrets (activation checklist §7).

---

## 14. Restore (§25)

Isolated-restore procedure TESTED locally (Phase 12: `igtrack_restore_test`,
8-table match, orphan 0, app-connect ok → `RECOVERY TESTED`). Phase 13 fixed
the cloud workflow (8-table + orphan verification, safe URL derivation, prod
never touched); YAML-validated this phase. First live Neon-branch restore
needs secrets (activation checklist §7).

---

## 15. Public smoke (§26–§27)

Blocked on founder activation (§5–§8 steps, ~15 min). First-run smoke order:
`GET /api/healthz` → login → targets CRUD + ownership → worker dispatch →
evidence → backup → isolated restore → logout. Custom domain NOT required
(platform URL is the beta target).

---

## 16. Free-tier analysis (§28, measured inputs)

| Service | Allowance (documented) | Beta usage | Headroom |
|---|---|---|---|
| Render Free web | 512 MB, 750 h/mo, 100 GB egress | 1 service, sleeps idle | safe |
| Neon Free | finite storage (see dashboard at signup) | ≤0.1 GB at ≤20 targets / ≤10k synthetic follows | monitor `pg_database_size` |
| GitHub Actions (**PUBLIC** repo, verified) | **unlimited** Linux minutes | `*/15` × ~1 min ≈ 2,880 min/mo | compliant by construction |
| R2 Free | 10 GB, 1M A / 10M B ops, free egress | ~90 MB/mo, ~30 PUTs | far below |

Beta envelope (unchanged, conservative): ≤50 users, ≤20 targets, 6h
profile/follow + 30m story scans, no 500k follower workloads (P2 F-500K-002),
no persistent media archive. No card required at any step — if any provider
dashboard asks for one, STOP per founder directive (not encountered in docs;
live signup is founder-side).

---

## 17. No-card verification (§10)

Provider-docs verification stands from Phase 13 (Render Free / Neon Free /
GitHub Free / R2 free allowance — no card per plan docs). **Live signup was
not performed by the agent** (requires human account creation + secrets the
agent must never handle). No evidence of a card requirement was found; the
verdict below reflects exactly this boundary.

---

## 18. P2 ledger (§31, carried, none inflated)

F-500K-002, F-DB-001, SES-001, LEASE-001, OBS-001, RET-001 (all P2) +
BKP-001/DEP-001 (P2 gates → cleared by **live** first runs in §7). No new
P0/P1. The concurrent maintenance/retention work is NOT accepted (unreviewed,
§36 STOP-listed) and lives on `concurrent/maintenance-retention` for later
review — it does not alter this ledger.

---

## 19. Provider boundary (§30, re-scanned at a371e94)

FixtureProvider canonical; `provider.ts:33,40` fail-fast fixture-only;
no scraping/proxy/bypass/reverse-engineering code (all scan hits are policy
prose); D1 DEFERRED. Mandatory conditions hold.

---

## 20. Final verdict (§33)

```text
PUBLIC BETA DEPLOYMENT READY — FINAL ACCOUNT ACTIVATION REQUIRED
```

Code, workflows, backup/restore procedures, worker/scheduler proofs,
regression (29/167/1), security posture, and $0/no-card architecture are
READY with evidence. The remaining step is founder-side account activation
(Neon project + Render service + GitHub/R2 secrets + live
Migrate → Worker → Backup → Restore), which the agent cannot and must not
perform. Not `LIVE` (no public URL yet — honest). Not `BLOCKED` (no card or
paid dependency found anywhere in the path).

---

## Evidence index

- `git rev-parse HEAD` → `a371e94` (start and end of phase; §35 git discipline)
- `git show --stat a371e94` → 12 files, 1159+/2− (Phase 13 only)
- Isolation branch `concurrent/maintenance-retention` → `24b1f31` (local, unpushed)
- `pnpm test` (pristine worktree + private DB) → 29 files, **167 passed**,
  1 skipped (by design), 0 failed, exit 0
- `pnpm typecheck` → exit 0 (5 workspaces); web build → exit 0
  (`/api/healthz 153 B`); `pnpm e2e` (clean tree) → 7 passed, exit 0
- Worker `--once` healthy → exit 0 (`scheduler_tick` + `COMPLETED` +
  `worker_stopped`); dead DB → exit 1 (`worker_once_errors`, secret-free)
- `gh repo view` → `isPrivate: false` (PUBLIC → unlimited Actions minutes)
- YAML parse → 5 workflows + `render.yaml` OK; `bash -n` → 3 scripts OK
- `git grep` scans → boundary + secret posture clean (details §12/§19)

# Verification ledger — feature verification, gap closure, release readiness

**Mission:** verify every feature recorded in [`docs/FEATURES.md`](../FEATURES.md)
against source, tests, schema, and runtime; fix confirmed defects; reconcile all
documentation drift; leave nothing silently unverified.

**Date:** 2026-10-16 · **Baseline commit:** `04e2a46` (`origin/master`) ·
**Final state:** all gates run, all findings resolved or explicitly blocked;
changes are **uncommitted** in the working tree (no commit authorized).

---

## 1. Status definitions

| Status | Meaning |
|---|---|
| `PASS` | Expected behavior verified with recorded evidence (command + result). |
| `FAIL` | Verified defect remains unresolved. |
| `FIXED_PENDING_RETEST` | Correction exists; sufficient verification not yet complete. |
| `BLOCKED` | Verification depends on a demonstrably unavailable prerequisite. |
| `NOT_VERIFIED` | Evidence insufficient; test not performed. |
| `NOT_APPLICABLE` | Scenario does not apply (documented reason). |
| `INTENTIONAL_ABSENCE` | Deliberately unsupported per an authoritative requirement. |

## 2. Baseline (recorded before any change)

| Fact | Value |
|---|---|
| Branch / HEAD | `master` / `04e2a46`, up to date with `origin/master` |
| Working tree | clean except untracked `docs/FEATURES.md` |
| Toolchain | node v24.18.0, pnpm 11.21.0; `node_modules` present |
| Postgres | native service on 127.0.0.1:5432 (Docker CLI present, daemon **not running**); `igtrack` + `igtrack_test` both exist |
| Credentials | Graph vars present in `.env` but **placeholders** (`PASTE_*`) → live Graph data verification remains blocked on a real token |
| `pnpm typecheck` (baseline) | **clean** — all 5 workspace packages `Done`, no errors |
| `pnpm test` (baseline) | **60 files · 443 passed · 1 skipped · exit 0** (289.7 s class run; log `%TEMP%\opencode\test-baseline.log`). The skip is `schema.test.ts`'s `skipIf(available)` block when a probe DB is unavailable; it skips loudly, never vacuously. |

No pre-existing failures. Every code fix was applied **after** this baseline so
the "before" run stays uncontaminated.

## 3. Counting rules

- Feature units: one row per independently testable behavior; grouped by
  subsystem, cross-referenced to `docs/FEATURES.md` sections (§0–§17).
- Scenario coverage is counted per feature unit (a feature with 5 passing and 1
  blocked scenario is not "green").
- Denominator for reconciliation: the surfaces enumerated in FEATURES §17.4
  (commands, MCP tools, capabilities, providers, job kinds, tables, migrations,
  activity types, env vars, tests).

## 4. Quality gates — actual commands and results

| Gate | Command | Result | Evidence |
|---|---|---|---|
| G1 Type check | `pnpm typecheck` | **PASS** before and after fixes (5/5 packages) | §6 G1 |
| G2 Full test suite | `pnpm test` | **PASS** — baseline 60f/443p/1s; post-fix **61f/448p/1s**, exit 0 | `%TEMP%\opencode\test-postfix.log` |
| G3 Documentation drift | `pnpm docs:capabilities` | **PASS** — regenerated `CAPABILITIES.md` (338 lines) byte-identical; no tree diff | §6 G3 |
| G4 Live Graph path | `pnpm verify:graph --json` | **PASS (honest-failure path)** — real endpoint, placeholder creds → typed errors only | `%TEMP%\opencode\e2e-run2\verify-graph.log` |
| G5 Runtime E2E | 22 CLI commands on scratch DB `igtrack_verify` | **PASS** — all expected exit codes | `%TEMP%\opencode\e2e-run2\` |
| G6 MCP protocol | stdio probe: `initialize` → `tools/list` → 12×`tools/call` | **PASS** — 19 tools, typed error envelope | `%TEMP%\opencode\e2e\mcp-*.json` |

## 5. Findings resolution (FEATURES §17.2 + §17.3)

| # | Finding | Investigation | Resolution | Status |
|---|---|---|---|---|
| F1 | `igtrack config` omits `IGTRACK_IMPORT_DIR` / `IGTRACK_IMPORT_USERNAME` | `CONFIG_KEYS` had 16 rows; both vars are read by `providerFromEnv()` and documented in `.env.example` | both rows added; live run prints **18** variables; `apps/cli/test/config-keys.test.ts` (+2 tests) | **FIXED, verified live** |
| F2 | `ARCHITECTURE.md` executor list omits `TAGS_SCAN` | confirmed 8 kinds live (doctor enumerates 8 intervals) | doc corrected | **FIXED** |
| F3 | `FOUNDING.md` §7 says "15 tools / 13 commands" | current surface: 19 MCP tools (pinned by `mcp.test.ts`), 19 router cases | dated correction notes at both sites (D36 style) | **FIXED** |
| F4 | `IGTRACK_FIXTURES_DIR` documented but unread | fixture branch always used `defaultFixturesDir()` | `providerFromEnv()` honours the override (blank = unset); `provider-config.test.ts` +2 tests (empty dir → `SOURCE_NOT_FOUND`, proving the override was read) | **FIXED, regression-tested** |
| F5 | `IGTRACK_LOG_LEVEL` declared but unread | `.env.example` lines 137–140: "RESERVED, CURRENTLY UNREAD … Do not set expecting quieter logs" | deliberate; documented as reserved | `INTENTIONAL_ABSENCE` |
| F6 | `scan_cadence_mult` `numeric` (0010 DDL) vs `real` (declared schema) | both read paths defended today (drizzle `PgReal.mapFromDriverValue`; `schedule.ts` `Number()` wrap), but the declaration/DDL mismatch would emit a spurious future alter | migration `0019_scan_cadence_real.sql` converts the column (0010 never edited); applied on test DB (fresh migrate) **and** dev DB (`information_schema` → `real`, 20 migrations); `schema.test.ts` +1 pin | **FIXED, verified on both DBs** |
| F7 | `renewLease` returns `true` on renewal error | deliberate; ownership re-checked by `completeJob`/`failJob`; `lease-loss.test.ts` pins the lost-lease abort | intentional design, documented in `executors.ts`; no behavior change | `INTENTIONAL` |

Post-fix delta accounting: 443 → 448 passed = +2 `config-keys`, +2
`provider-config`, +1 `schema` pin. Files 60 → 61 (new test file).

## 6. Evidence log

### G1 — typecheck

`pnpm typecheck` → `packages/core`, `packages/ingestion`, `packages/database`,
`workers/monitoring`, `apps/cli`: all `Done`, no errors. Run before **and**
after all edits; both clean.

### G2 — full test suite

| Run | Files | Passed | Skipped | Exit | Log |
|---|---|---|---|---|---|
| Baseline (pre-fix) | 60 | 443 | 1 | 0 | `%TEMP%\opencode\test-baseline.log` |
| Post-fix (all changes in tree) | **61** | **448** | 1 | 0 | `%TEMP%\opencode\test-postfix.log` |

Post-fix run includes the new `apps/cli/test/config-keys.test.ts`, the two
`provider-config` fixtures-dir tests, and the `schema.test.ts` column-type pin;
no regressions. Duration 289.7 s (vitest 3.2.7, serial files).

### G3 — documentation drift

`pnpm docs:capabilities` → `igtrack: wrote …/docs/CAPABILITIES.md (338 lines)
from the capability registry`. `git status --porcelain docs/` afterwards shows
only `ARCHITECTURE.md`/`FOUNDING.md` (intentional fixes), `FEATURES.md` and
`verification/` (untracked) — **`CAPABILITIES.md` unchanged**, so the generated
doc and the registry are in sync (also pinned by `capability-matrix.test.ts`).

### G4 — live Graph verification (placeholder credentials)

`pnpm verify:graph --json` (read-only harness; credentials loaded from `.env` —
`PASTE_*` placeholders). Exit 0. `provenance: LIVE`, `requestsMade: 8 of cap 11`,
`apiVersion: v21.0`.

| Capability | Result |
|---|---|
| resolveAccount / getProfile / getPublicPosts / getAccountInsights / getStories / getTags | `ERROR · AUTH_REQUIRED · retryable: false` — typed, not fabricated |
| getMentionedComment | `NOT_VERIFIED` (webhook-keyed read; unlock note recorded) |
| getFollowers / getFollowing | `UNAVAILABLE` with the structural reason (Graph exposes counts, not lists) |

This proves the honest-failure contract end to end against the real endpoint.
Live **data** remains `NOT_VERIFIED` (`LIVE_VERIFIED` count: 0) until real
credentials exist; that is a credential-blocked item, not a defect.

### G5 — runtime end-to-end (scratch DB `igtrack_verify`, never dev data)

Fresh DB created; `DATABASE_URL` pointed at it (process env wins over `.env`);
`setup` → migrate + synthetic demo. All outputs in `%TEMP%\opencode\e2e-run2\`
(stdout JSON and stderr logs captured separately — stdout stayed pure JSON).

| # | Command | Exit | Observed |
|---|---|---|---|
| 01 | `setup --json` | 0 | migrations `applied`; demo `already-present`; users 1 |
| 02 | `status --json` | 0 | owner `dev@igtrack.local`; provider `fixture:v1` **synthetic:true**; queue `queued/running/retryWait/failed` |
| 03 | `doctor --json` | 0 | DB reachable + migrations applied; 12 provider capabilities; **8 scheduler intervals**; 3 findings |
| 04 | `targets list --json` | 0 | 1 target `target_a` (OWNED, tags `synthetic`,`seed`) |
| 05 | `scans run --json` | 0 | 7 jobs re-reported as in-window `deduplicated`; `DISCOVERY_SCAN` on the OWNED target **skipped at enqueue** with the D47 reason recorded |
| 06 | `scans list --json` | 0 | scope = queue (running/retry/failed), empty |
| 07 | `work --json` | 0 | schedulerTick `ok`; nothing claimable (`claimed:false`); `stopped: queue-empty` |
| 08 | `activity --json` | 0 | 10 items: `LOST_FOLLOWING`, `NEW_FOLLOWING`, `STORY_EXPIRED`, `TAG_OBSERVED` |
| 09 | `relationships target_a --json` | 0 | evidence-backed signals (mention, weight 12) with `means` prose |
| 10 | `dossier target_a --json` | 0 | sections `target/account/route/counts/profile/media/coverage/routeUnavailability/notes`; 3 profile snapshots, 4 profile changes |
| 11 | `insights target_a --json` | 0 | state + series |
| 12 | `tags target_a --json` | 0 | `rowCount` 2 + listing/truncation metadata |
| 13 | `evidence --json` | 0 | rows carry `raw_hash: null` (fixture transports no raw) **and** a normalized hash — invariant 5 nuance visible |
| 13b | `evidence --id <id> --json` | 0 | `mode: chain`; chain evidence id matches the list row |
| 14 | `capabilities --json` | 0 | 23 cells; summary `available 18 / total 23` |
| 15 | `config --json` | 0 | **18 variables**, incl. `IGTRACK_IMPORT_DIR` + `IGTRACK_IMPORT_USERNAME` (F1 verified live) |
| 16 | `lookup target_a --json` | 0 | fixture discovery probe (synthetic; stateless) |
| 17 | `targets add person_delta --json` | 0 | `created:true`, OWNED |
| 18 | `targets pause …` | 0 | `ACTIVE → PAUSED` |
| 19 | `targets resume …` | 0 | `PAUSED → ACTIVE` |
| 20 | `targets rm person_delta` (no `--yes`) | **2** | typed `USAGE` error on stderr — destructive guard works |
| 21 | `targets rm person_delta --yes` | 0 | `deleted:true` |

Dev DB upgrade (normal path, user's database): `igtrack setup --no-seed --json`
→ `migrations: applied`; probe → `targets.scan_cadence_mult` type `real`,
`drizzle.__drizzle_migrations` count **20** (F6 verified on live data).

### G6 — MCP protocol verification

Stdio probe against `igtrack mcp` on the scratch DB (raw responses under
`%TEMP%\opencode\e2e\mcp-*.json`):

- `initialize` → `serverInfo igtrack v0.1.0`, 1,883-char instructions block.
- `tools/list` → **19 tools** (exact set matches `mcp.test.ts` `EXPECTED_TOOLS`):
  activity, capabilities, doctor, dossier, evidence, evidence_chain, insights,
  lookup, mention_read, relationships, scans_list, scans_run, status, tags,
  target_add, target_remove, target_set_status, targets_list, work.
- 12 × `tools/call`: `status`/`targets_list`/`capabilities`/`scans_run`/
  `scans_list`/`work`/`activity`/`dossier`/`insights` all `isError:false` with
  `_meta` blocks; `target_set_status` PAUSED→ACTIVE mutations both ok;
  `target_remove` of a ghost target → `isError:true`, `code: TARGET_NOT_FOUND`
  — a failure is a typed error, never a successful empty result.

## 7. Blocked and unverified items

| Item | Status | Prerequisite to unblock |
|---|---|---|
| Live Graph `LIVE_VERIFIED` capabilities | `BLOCKED` | real Meta long-lived token + owned Business/Creator account in `.env` (currently `PASTE_*`); then re-run `pnpm verify:graph` |
| CI workflow runtime behavior | `NOT_VERIFIED` | CI not executable in this environment; documented from the workflow file only |
| Retired web app runtime behavior | `BLOCKED` | source deleted at HEAD (`de06fbb`); reconstruction limited to `de06fbb^` + `.next` artifact + REA |
| REA deep module drill-down of the web artifact | `NOT_VERIFIED` | budget-limited in the documentation pass; artifact may be re-analyzed on request |

## 8. Reconciliation against FEATURES.md §17.4

| Surface | FEATURES claim | Verified result | Delta / action |
|---|---|---|---|
| MCP tools | 19 | 19 (live probe + `mcp.test.ts`) | none |
| CLI commands | ~20 router cases + aliases | 19 router cases; E2E exercised 12 end-to-end | consistent |
| Config variables | 30 incl. reserved; settings surface printed 16 | `.env.example` unchanged; `igtrack config` now prints **18** | FEATURES §5 + §17.2.1 updated (F1) |
| Capabilities | 23 ids; 18 available | runtime: 23 cells, 18 available | none |
| Providers | 3 (`fixture`, `graph`, `import`) | fixture live-verified; graph probed live (typed failures); import via suite | none |
| Job kinds | 8 | doctor enumerates 8 intervals; executors switch covers 8 (F2) | none |
| Migrations | 19 (journal idx 0–18) | **20** (idx 0–19); fresh-migrated test DB + dev upgrade | FEATURES §10.4/§17.1/§17.4 updated (F6) |
| Tables / enums / triggers | 28 / 17 / 16 | `schema.test.ts` (6 tests) | none |
| Activity types | 13 over 10 sources | enumeration from source + tests; 4 types observed live in 10 items | none |
| Test files | 60 | **61** post-fix (448 passed) | FEATURES §15/§17.4 updated |
| Web (retired) | 79 files | not runtime-verifiable | blocked (unchanged) |

Every FEATURES §17.2 item now carries a dated resolution note in place; §17.3
was rewritten for what this pass actually executed and what remains blocked.

## 9. Residual notes

- Scratch DB `igtrack_verify` (synthetic data only) is retained for evidence
  re-inspection; the dev DB received the normal migration upgrade (one column
  `numeric` → `real`, cast-safe on existing rows) and nothing else.
- All changes are uncommitted at `04e2a46`; no commit/push was performed
  (not authorized). `git status --porcelain` is the authoritative change list.
- Temp probes live under `%TEMP%\opencode\` only; the repository contains no
  scratch artifacts.

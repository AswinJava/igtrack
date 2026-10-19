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
- All changes were uncommitted at `04e2a46`; no commit/push was performed
  (not authorized). `git status --porcelain` is the authoritative change list.
  (Later committed as `323a254`; see §10 for the mission verification on top
  of it.)
- Temp probes live under `%TEMP%\opencode\` only; the repository contains no
  scratch artifacts.

## 10. Deep-account-intelligence mission verification (2026-10-17)

Scope: the claims ledger, the deterministic `research` report (including the
read-only depth sections — themes, cadence, audience, changes, `--since`,
`--format md`), the stateless `plan` planner, and the §7.2/§7.3 benchmark, all
on top of `323a254` (FOUNDING §18, D67/D68).

| Gate | Command | Result | Evidence |
|---|---|---|---|
| G1 Type check | `pnpm typecheck` | **PASS** — 5/5 packages clean | session log, exit 0 |
| G2 Full suite | `pnpm test` | **PASS** — 67 files, 547 passed / 1 skipped (548), exit 0, 273 s | shared `igtrack_test` under default logging config, clean once the orphaned concurrent runner was gone (§10.1); third consecutive green run (after a 7-file batch and an earlier full suite) |
| G3 Docs drift | `pnpm docs:capabilities` | **PASS** — regenerated `CAPABILITIES.md` byte-identical | no tree diff |
| G4 Benchmark | `apps/cli/test/research-benchmark.test.ts` | **PASS** — Q1–Q12 answer-classes, plus §7.3 pins: citation completeness, reason coverage (≥1 `UNAVAILABLE` node actually met), determinism modulo `computedAt`, dedup (`CLAIM_DUPLICATE`), no-zero-fill, P95 < 1500 ms | suite output |
| G5 Runtime smoke | `igtrack status` / `targets list` / `claims list target_a` / `plan target_a` / `research target_a [--format md]` on the dev DB | **PASS** — honest empty-claim state, D47-refused step renders `NOT_APPLICABLE`, single next action, every section renders | this session |
| G6 MCP stdio | `initialize` → `tools/list` | **PASS** — 24 tools, stdout pure JSON-RPC, diagnostics on stderr (`igtrack mcp: ready on stdio`) | `%TEMP%\opencode\mcp-smoke.mjs` |
| G7 Refusals | refused predicate (`CLAIM_PREDICATE_REFUSED`, message names FOUNDING); no liker capability available (`/liker/i` absent from available capabilities); DISCOVERY audience/changes `UNAVAILABLE` with reasons | **PASS** | `operations.test.ts`, benchmark Q6–Q8 |
| G8 Performance | `pnpm bench:research` (isolated `igtrack_bench` DB, synthetic fixture workload, 64 claims) | **PASS** — claims list p50 6.7 ms / p95 19.8 ms, research p50 42.5 ms / p95 60.0 ms, plan p50 7.0 ms / p95 9.5 ms; all far below the pre-established 1500 ms research threshold; CLI boot p50 ≈ 3.0 s paid once per MCP session | `scripts/bench-research.ts`, two runs 2026-10-16/17 (FOUNDING §18.3) |

### 10.1 A concurrency hazard found during verification, and its resolution

The first post-commit full runs failed non-deterministically — `deadlock
detected` inside `DROP SCHEMA`, `relation "…" does not exist` mid-test —
because **two schema-droppers were running against the shared `igtrack_test`
database at once**. Postgres forensics (server log + a `pg_stat_activity`
sampler during a failing run) caught the interleaving directly: one backend
`DROP SCHEMA public CASCADE` while a second backend was mid-migration in the
same schema (its transaction then rolled back), and later a backend dropped
`drizzle` while another was inserting into `__drizzle_migrations`.

The second dropper was not another user's work: an audit of every OpenCode
session's shell outputs on this machine found no foreign `igtrack` test run.
It was **an orphaned vitest coordinator left behind by our own
pipeline-killed runs** — piping vitest through `Select-Object -First N`
terminates the wrapper while the underlying vitest process survives and
keeps executing files (each file's `beforeAll` drops and recreates the
schema) for minutes afterwards. The failure windows line up with that
mechanism: errors appear only in the minutes after a killed run, a
`vitest run workers/monitoring/test/posts-changes.test.ts` process was
observed with no live parent run, and all failures cease once the orphan
finished (~08:01Z); every run since — a 7-file batch and two full suites,
all with statement logging on, showing 11 well-separated sequential
drop-pairs and no interleaving — passed.

Two operational rules follow, both now obeyed: never terminate a vitest run
by killing its output pipeline (redirect to a file and let it finish), and
verify no orphaned `node`/`vitest` process survives before starting the next
DB-backed run. A per-suite advisory lock over `igtrack_test` remains a
possible hardening (a concurrent suite would block with a clear message
instead of corrupting state) but was not implemented in this phase.

Two test-correctness bugs were fixed rather than tolerated (no threshold was
weakened): benchmark Q9 read `followerSnapshots` (the follow-list machinery)
where the seeded profile snapshots live under `profileSnapshots`; and three
`synthesis.test.ts` expectations mis-counted their own fixtures (a repeated
word, a hashtag word also tallied as a plain term, and a two-gap median).
The fixed suite is the green G2 above.

### 10.2 Working-tree state

`git status --porcelain` on top of `323a254`: `docs/FOUNDING.md` (§18),
`docs/DEEP-ACCOUNT-INTELLIGENCE.md` (§9), `docs/verification/VERIFICATION.md`
(this section), `docs/FEATURES.md` (§17.5), `CHANGELOG.md`, `README.md`,
`package.json` (`bench:research` script), `scripts/bench-research.ts`
(CLI-startup probe fix),
`apps/cli/test/research-benchmark.test.ts` and
`packages/core/test/synthesis.test.ts` (the two fixes above). Nothing was
pushed; no release tag was created; `docs/verification/COMPETITIVE-RESEARCH.md`
and `docs/verification/recon/` are separate uncommitted research artifacts and
were not touched.

Live-Graph items remain `NOT_VERIFIED` exactly as in §7: no credential exists
in this environment, and every row exercised by this mission is synthetic
fixture data or operator-submitted claims.

## 11. Deep-account-intelligence completion mission (2026-10-17 evening)

The completion mission for the roadmap in
[DEEP-ACCOUNT-INTELLIGENCE.md](../DEEP-ACCOUNT-INTELLIGENCE.md) began with a
full audit of that document against the working tree. Verdict: the roadmap was
already implemented and committed at `323a254` (that document's §9 is an
accurate delta) — migration 0020 with the dedup index, the closed predicate
registry and refusal list (`packages/core/src/claims.ts`), the claims
repository with the 23505 → typed-`CONFLICT` mapping, all five ops, all five
MCP tools, the CLI commands, the `ACCOUNT_RESEARCH` capability entry, the
seeded claim set, and the §7.2/§7.3 metric pins are present and test-pinned
`[V]`. The mission therefore verified the whole feature end to end and closed
the remaining honesty gaps; no new surface was invented.

### 11.1 Verification record (this mission)

| Check | Result |
|---|---|
| `pnpm typecheck` | clean, 5/5 workspaces, exit 0 `[V]` |
| Claims-focused suites (`core/claims`, `core/synthesis`, `core/references`, `database/claims`, `mcp`) | **48/48**, exit 0 `[V]` |
| Operations + research-benchmark + acceptance (isolated DB) | **83/83**, exit 0 `[V]` |
| **Full suite, combined tree** (both workstreams, isolated DB, watcher-gated) | **68 files, 574 passed, 1 skipped (the loud Postgres-down guard), 0 failed, exit 0, 403 s** `[V]` |
| Contended-run diagnosis | Two earlier full runs were contaminated by a second live session running its own suites in the same tree (all suite failures were `beforeAll` 30 s hook timeouts at `createFreshTestDb`; the 4 affected files re-passed **27/27** in isolation) `[V]` |
| `pnpm docs:capabilities` | regenerated, zero drift `[V]` |
| `pnpm bench:research` (uncontended, 64-claim synthetic workload) | research p50 198.73 ms / **p95 411.23 ms** vs the pre-established < 1500 ms pin; claims list p95 41.10 ms; plan p95 60.01 ms; CLI boot p50 4.33 s (dev-mode tsx, paid once per session) `[V]` |
| MCP surface | `EXPECTED_TOOLS` pinned at 24, confirm-gate (`z.literal(true)`) on retract, `readOnlyHint` on list/research/plan — `apps/cli/test/mcp.test.ts` `[V]` |
| CLI smoke, scratch DB `igtrack_smoke`, synthetic only | `setup` → `research target_a` (all sections; empty themes/cadence/audience carry reasons; the 257-day-old claim flags `due for review`; retracted claim rendered as retracted) → `claims add` (excerpt hash stored) → duplicate refused naming the existing claim (exit 2) → `EMPLOYMENT_STATUS` refused with the FOUNDING pointer (exit 2) → `claims retract --reason --yes` → `claims list` → `plan` (D47 kind `NOT_APPLICABLE`) → `--format md` → documented launcher `node apps/cli/bin/igtrack.mjs research --json` (`ok: true` envelope) `[V]` |

**Concurrency lesson, upgraded (addends §10.1):** this evening the colliding
runner was not an orphan but a second, live coding session working in the same
checkout. Two mitigations proved sufficient and are now the operating rule:
(1) point DB-backed runs at a scratch database via the documented
`IGTRACK_TEST_DATABASE_URL` (here `igtrack_test2`) so two sessions cannot
share schema state, and (2) gate a run on the absence of foreign
`vitest` processes. The per-suite advisory lock remains possible hardening,
still not implemented.

### 11.2 Fixes and deliberate non-changes

- **Plan §7.1 fixture-name drift fixed:** the seed's owned target is
  `target_a` (claims concern the fictional "Aurora Print Studio"), not the
  `aurora.wilde` the plan named; `dune.harbor` (discovery.json) was already
  correct.
- **README:** gained an honest "Records what sources say" bullet and a
  "Research with cited claims" section — implemented, verified functionality
  only.
- **Not changed:** the other workstream's uncommitted config-readiness files
  (this mission's runs simply cover them; the combined-tree green above
  includes them); the CHANGELOG's Deep-intelligence `**Docs:**` bullet, which
  the concurrent session is extending for its own work — one line, one writer.

### 11.3 Working-tree state

Uncommitted on top of `323a254`, two intermixed workstreams, nothing pushed,
no tag: the earlier verification mission's files (§10.2), plus this mission's
`docs/DEEP-ACCOUNT-INTELLIGENCE.md` (§7.1 drift fix + §10 status block),
`docs/FOUNDING.md` (§18.3 re-verification rows), `README.md` (research
section), and this section — alongside the concurrent session's config-readiness
work (`packages/ingestion/src/config/`, `graph-provider.ts`, CLI doctor
surfaces, `config-readiness.test.ts`).

`NOT_VERIFIED`, unchanged: every live-Graph row (no credential exists here),
and the §4.7 agent-workflow bounds, which remain a documented protocol by
design (DEEP-ACCOUNT-INTELLIGENCE §9).

## 12. Research-acquisition mission (2026-10-18)

Founder-mode mission: give the product an autonomous, bounded, lawful
public-web research-acquisition layer (FOUNDING D69; DEEP-ACCOUNT-INTELLIGENCE
11). This section records what was verified and how, in this environment.

### 12.1 Gates run, actual results

| Gate | Command | Result |
|---|---|---|
| Typecheck | pnpm typecheck | 5/5 workspaces clean (core, ingestion, database, monitoring, cli) |
| Research matrix | pnpm exec vitest run packages/core/test/research.test.ts packages/ingestion/test/research-{extract,fetch,search}.test.ts packages/database/test/research.test.ts apps/cli/test/research-run.test.ts apps/cli/test/mcp.test.ts | 93 passed, 0 failed (core 12, extract 14, fetch 19, search 12, database 10, engine 19, MCP 7) |
| Registry drift | pnpm docs:capabilities then the capability-matrix suite | regenerated 362-line docs/CAPABILITIES.md; test green; 20 of 25 obtainable |
| Capability honesty | pps/cli/test/output.test.ts | 13/13 � includes the new WEB_RESEARCH available pin and the engineSupplied supply-mode check |
| Dossier/coverage consumers | pps/cli/test/acceptance.test.ts, pps/cli/test/operations.test.ts | 82/82 combined on an isolated database � new coverage row adds no drift |

Isolation: DB-backed suites ran against IGTRACK_TEST_DATABASE_URL =
igtrack_test2 because a concurrent workstream's vitest process was
contending for the shared igtrack_test schema (the �2.6 hazard with an
external cause, recurring); one mid-run collision surfaced as 42P01
(undefined table) during a seed, and the re-run against the isolated database
passed 29/29 (engine 19 + database 10).

### 12.2 What the tests pin (the product promise, not just the code)

- Bounds are compile-time constants; a hypothetical env var cannot widen them
  (esearch.test.ts).
- Instagram-family hosts, credential URLs, non-http(s) schemes, non-standard
  ports, private/loopback/link-local/metadata addresses (post-DNS), and
  robots-disallowed paths are each refused with a typed reason; a redirect to
  an unsafe host is refused per-hop (esearch-fetch.test.ts).
- A page body carrying a prompt-injection payload produces zero extraction
  candidates; extraction reads only the four field families; a sensitive
  predicate from a page is refused by the shared registry, and the run stores
  nothing (esearch-extract.test.ts, esearch-run.test.ts).
- A run's per-document outcomes (fetched/reused/failed/refused) round-trip
  through migration 0021; owner scoping is unconditional; the cross-user
  denial scenario runs last and passes (esearch-run.test.ts,
  packages/database/test/research.test.ts).
- The MCP tool is schema-bounded (missing question / maxSources: 11 / 11
  URLs rejected by the zod schema itself) and declared eadOnlyHint: false
  (mcp.test.ts).

### 12.3 Working-tree state

Uncommitted on top of 323a254, intermixed with the concurrent session's
work (config-readiness, igtrack_audit); nothing staged, committed, tagged or
pushed. This mission touched: packages/core (research module, capability
registry + matrix, tests), packages/ingestion (research fetcher/extractor/
search + tests), packages/database (migration 0021, research repository,
dossier esearchRuns count, tests), pps/cli (engine op, CLI/MCP wiring,
engine + MCP tests), and the docs named in DEEP-ACCOUNT-INTELLIGENCE 11.1.
Foreign files and hunks (audit command/tests/tool, config-readiness) were not
modified.

### 12.4 NOT_VERIFIED, with the exact prerequisite

- **Live search — keyless leg VERIFIED 2026-10-19:** `igtrack audit sel_win_`
  with IGTRACK_RESEARCH_SEARCH_PROVIDER=auto and no key returned real
  SEARCH_SUCCEEDED results via the keyless FreeSerp index (2 queries, 10
  candidates; relevance gate then applied). **Live Brave search (keyed leg):**
  IGTRACK_RESEARCH_SEARCH_PROVIDER=brave +
  IGTRACK_RESEARCH_SEARCH_API_KEY, then one live igtrack research --run
  with a --url. Without a key, auto falls through to FreeSerp; =brave
  without a key answers UNAVAILABLE with the reason (never invented
  sources) — that honest path is itself test-pinned.
- **Live Graph:** unchanged � pnpm verify:graph with a real token.
- **CI:** not executable in this environment; no CI claim is made.

Status: **COMPLETE** for everything locally verifiable; the two live items
above are **BLOCKED - EXTERNAL PREREQUISITE** by credential absence, reported
as NOT_VERIFIED in the capability registry (WEB_RESEARCH liveState) and in
DEEP-ACCOUNT-INTELLIGENCE 11.3.

## 13. Arbitrary-username investigation mission (2026-10-18/19)

Scope: the founder's restated central requirement - enter an arbitrary unknown
username, receive the most comprehensive lawful evidence-backed report, with
every unavailability explained. The audit of the tree found one structural
gap: the research engine could only research a target the operator already
held, so the workflow began in the wrong place for a stranger's handle. Shipped
- FOUNDING 19 (D70-D72), opAuditWebProbe, the audit's `web` + `summary`
sections, CLI `--url`/`--max-sources`, MCP `igtrack_audit` urls/maxSources,
docs/verification/SOURCE-AUDIT.md, README/CHANGELOG/DEEP 12.

Verification:

- **Typecheck:** `pnpm typecheck` - 5/5 workspaces clean, exit 0.
- **Audit suite:** `apps/cli/test/audit.test.ts` - 21/21 (12 original + 9
  public-web scenarios), hookTimeout 180s against the live test database.
- **Extractor + transport:** `packages/ingestion/test/research-extract.test.ts`
  16/16, research-fetch + research-search green (47 checks across the three).
- **Full suite:** `pnpm exec vitest run` — **75/75 test files passed** on the
  finished tree (a longer budget only to defeat host load: the first concurrent
  run timed out one scheduler test that needs 19.2s of a 30s budget).
- **Scheduler:** 9/9 in isolation. S11 takes 19.2s of a 30s budget on this
  host, so the concurrent full-suite run timed it out - load-induced, not a
  regression; isolated re-run passes.
- **Environment note:** the Docker engine had stopped mid-session; `igtrack-db`
  was restarted with `docker compose up -d` and every DB-backed suite above
  was re-run afterwards against it.

Live verification (real internet, real fetcher, 2026-10-18):

- `igtrack audit sel_win_ --url "https://example.org,https://www.wikipedia.org"`
  - both FETCHED, HTTP 200, 577 B / 122197 B, real SHA-256 digests and
  retrieval timestamps; 383 links counted and NOT followed (depth 1); no rows
  written, no target registered; absent search provider reported UNAVAILABLE
  with the exact env-var remedy.
- `igtrack audit sel_win_ --url https://www.anthropic.com` - 201400 B, 4 cited
  facts (field, method, source URL, retrieval time, per-fact uncertainty).
- That probe found three honesty defects no fixture reproduced; all fixed and
  pinned under FOUNDING D72 (meta-description phrase mining deleted, HTML
  entities decoded at both extraction gates, CONFLICTED downgraded to
  SINGLE_SOURCE when only one domain disagrees with itself).

Status: **COMPLETE** for everything locally and publicly verifiable. Still
**BLOCKED - EXTERNAL PREREQUISITE**: live Brave search (needs
IGTRACK_RESEARCH_SEARCH_PROVIDER=brave + IGTRACK_RESEARCH_SEARCH_API_KEY) and
live Graph/Business Discovery (needs a real long-lived token +
IGTRACK_GRAPH_BUSINESS_DISCOVERY=1). Neither is exercised anywhere in this
repository without its credential.
*Addendum (2026-10-19, D73): the live-search prerequisite is DISCHARGED for the
default path — `igtrack audit sel_win_` with IGTRACK_RESEARCH_SEARCH_PROVIDER=auto
and no key ran a real keyless search (FreeSerp index: SEARCH_SUCCEEDED, 2 queries,
10 candidate URLs; retrieval COMPLETED_PARTIAL; relevance gate discarded every
non-naming page → 0 facts, honestly). Only the keyed Brave leg and live Graph
remain credential-blocked.*

## 14. Requirement-mapping mission (2026-10-19)

Scope: finish the founder-level requirement by (a) writing the part-1
deliverable — the clause-by-clause mapping of the central use case to
implementation, source, auth, ownership, legal constraint and verification —
and (b) closing the two reporting honesty gaps that remained in `igtrack audit`.

Delivered:

- **`docs/verification/REQUIREMENT-AUDIT.md`** (new). Maps FOUNDING §14.1
  A1-A10, §15, §18 and §19 to code paths (`opAudit`, `opAuditWebProbe`,
  `opLookup`, `opTargetAdd --observed`, `opResearch`, `opDossier`,
  `opClaimAdd`, `opResearchRun`, `opRelationships`, `opTaggedMedia`,
  `opMentionedCommentProbe`, the scan executors), names the lawful source and
  credential each needs, states whether the target must be owned, lists the
  refusals as refusals, cross-references the 25 registry entries by
  `liveState`, and gives the exact prerequisite for every `NOT_VERIFIED` row.
  The one live probe on record (public-web fetch, 2026-10-18) is cited for the
  web phase only; nothing else is claimed live.
- **Stale evidence is named, not hidden.** `opAudit` gained
  `record.claims.dueForReview` (claims whose retrieval basis is past
  `CLAIM_REVIEW_HORIZON_DAYS = 180`), a `Stale evidence:` limitation, a
  `DUE_FOR_REVIEW` marker in the summary's third-party-claim row, a `STALE —`
  prefix on plan steps whose stored observation is older than its cadence, and
  a human line naming the horizon. No existing vocabulary was invented:
  `DUE_FOR_REVIEW` and plan-step `STALE` already existed. Nothing is expired,
  retracted, downgraded or dropped (FOUNDING §18).
- **The audit's human screen renders each web fact's `uncertainty`** as a
  `caveat:` suffix, so a per-fact qualifier is no longer visible only in
  `--json`.
- Docs: `CHANGELOG.md` (dated subsection), `README.md` (audit section),
  `docs/DEEP-ACCOUNT-INTELLIGENCE.md` §13.

Gates run, actual results (2026-10-19):

- **Typecheck:** `pnpm typecheck` — 5/5 workspaces clean, exit 0.
- **Full suite:** `pnpm test` — **75/75 files, 686 passed, 1 skipped, 0
  failed** (baseline before this pass: 684 passed; +2 from the staleness
  tests).
- **New tests:** `apps/cli/test/audit.test.ts` now 23/23 —
  *"names stale evidence instead of letting it read as current"* (counts the
  horizon-passing claim, limitation text, summary marker, human line; asserts
  the count is strictly less than the active total so staleness cannot read as
  expiry) and *"carries the STALE label when the stored evidence behind a plan
  step is older than its cadence"* (backdates the job's `completed_at`, then
  asserts the label travels into the audit's next steps).
- **Debugging note:** the first attempt asserted against the wrong target —
  the seed's claim fixtures are attached to its own target `target_a`, not to
  the fixture account `aurora.wilde` (`packages/database/src/seed/seed.ts`,
  mirrored by `research-benchmark.test.ts`'s `SEEDED_USERNAME`). Verified
  against the test database with a direct query on `claims` joined to
  `targets`/`ig_accounts` before correcting the test; no product code was
  changed to make it pass.

Status: **COMPLETE** for everything locally verifiable. External blockers
unchanged and unfabricated: a real long-lived Graph token (+ 
`IGTRACK_GRAPH_BUSINESS_DISCOVERY=1`) for the 17 `NOT_VERIFIED` registry
entries, and a Brave-compatible key for search-provider candidates. CI was not
run (not runnable here; no workflow was activated).

## 15. Discovery-quality mission (2026-10-19, D74)

Scope: Phase 2 of the arbitrary-username workflow — improve the public-web
phase's **discovery quality** (query strategy, candidate ranking/dedup,
retrieval honesty, provider benchmarking, actionable sparse-result reporting)
without weakening any evidence standard.

Root cause, found by live diagnosis rather than summary counts: the keyless
index (FreeSerp) **ignores quoted phrases and tokenizes `sel_win_` into
`sel`+`win`**, so Phase 1's two derived queries (`"H" instagram`, `"H"
contact about`) requested token-overlap junk. Retrieval and the relevance gate
were correct — coverage was the defect. Evidence:
`site:instagram.com "sel_win_"` → 0 results; every quoted variant → "SEL
Wins"/"sel wine" junk; `site:` itself is honored; raw response shape matches
the adapter's `results[].url/title/snippet` mapping exactly.

Delivered (FOUNDING D74):

- **`handleSearchQueries`** (`packages/ingestion/src/research/queries.ts`):
  fixed budget of 4 distinct query forms (quoted, profile-URL, `@`-mention,
  bare), ordered, deduped, leading `@` stripped, `HANDLE_QUERY_LIMIT` named.
- **Explainable ranking + dispositions** in `opAuditWebProbe`: stable signal
  sort (handle-in-URL 3 > title 2 > snippet 1 > none; policy-refused last),
  every candidate reported `PLANNED` / `SKIPPED_BY_POLICY` / `NOT_FETCHED`
  with a reason, every query with its result count or error.
- **Policy refusals are `skipped`, never `failed`** (`skipped > 0` →
  `COMPLETED_PARTIAL`), separating "no request was made" from "a request
  broke".
- **Canonical-URL dedup** in `normalizeResearchUrl` (tracking params, fragment,
  host case, trailing slash; content params kept).
- **`outcomeClass`** — the seven one-label diagnoses of where the phase
  stopped — plus zero-fact next-step branching (`PAGES_IRRELEVANT` → weak
  coverage, never "no evidence exists"), an unsearched-source-classes note, and
  an `outcome` row in the human render.
- **`scripts/bench-search.ts`** — a live benchmark of the real pipeline,
  excluded from `pnpm test`, with an honest `NOT MEASURED` row for the keyed
  leg.

Gates run, actual results (2026-10-19):

- **Typecheck:** `pnpm typecheck` — 5/5 workspaces clean, exit 0.
- **Full suite:** `pnpm test` — **76 files, 707 passed, 1 known skip, 0
  failed** (baseline: 702 passed; +5 in `research-queries.test.ts`, +4 new
  audit scenarios, plus extended pins).
- **Docs:** `pnpm docs:capabilities` regenerated (WEB_RESEARCH `liveEvidence`
  now carries the Phase-2 numbers); FOUNDING D74, SOURCE-AUDIT §10 and the
  CHANGELOG dated bullets written; no stale "2 derived queries" wording
  outside dated historical records.
- **CLI smoke (live):** `igtrack audit sel_win_` (JSON and human) — 4 queries ×
  5 = 20 results → 15 canonical candidates, 4 fetched / 1 `TIMEOUT`, gate
  discarded 22 values from 4 non-naming pages, `outcomeClass
  PAGES_IRRELEVANT`, per-candidate dispositions, weak-coverage next step, no
  secret-like string in either rendering.
- **Live benchmark:** `sel_win_` → 0 facts / `PAGES_IRRELEVANT`; control
  handle `nasa` → 4/4 pages naming the handle, 41 facts /
  `EVIDENCE_EXTRACTED` (table in SOURCE-AUDIT §10).

Status: **COMPLETE** for everything locally verifiable. Remaining limitations,
stated as such: Brave's keyed leg is still live-**unverified** (no key in this
environment — `scripts/bench-search.ts <handle>` with
IGTRACK_RESEARCH_SEARCH_API_KEY set fills its row); coverage is one index
(`auto` without a key), so a zero result is a coverage statement, never a
verdict; FreeSerp's shallow query language is a permanent property the design
compensates for (four query forms + post-retrieval gate) rather than a bug to
fix. No credential was requested or written anywhere; no CI, push, release or
tag occurred.

## 16. Audit-quality benchmark mission (2026-10-19, D75)

Question: does the pipeline's evidence hold up against the real web, judged
against ground truth that the pipeline never saw?

Delivered (FOUNDING D75; tables in SOURCE-AUDIT §11):

- **Seven-case evaluation set** (`apps/cli/src/bench.ts`) — one handle per
  category the mission names, ground truth verified independently of the
  pipeline (direct HTTP fetches + entity lookups, dated), expectations kept
  separate from ground truth and falsifiable. The benchmark measures candidate
  precision, retrieval, exact-handle pages, support-checked claims (every fact
  re-verified against its retrieved body, canonicalized both ways), attribution
  as a level (HOST/URL/TITLE/BODY), duplicates, failures and latency — raw
  fact count is reported, never the verdict.
- **Three layers, separate by construction:** mocked (vitest, never network),
  saved (`--saved` replays committed recordings
  `apps/cli/test/fixtures/bench/{nasa,natgeo,nasaa}.json` through the real
  probe offline — reproducing the live numbers exactly), live
  (`pnpm bench:audit`, never part of `pnpm test`). Brave rows print
  `NOT MEASURED` when no key exists; no comparison was fabricated.
- **Five corrections, each traced to a defect the before-run produced:** the
  self-identification rule (6 of 24 natgeo facts named the wrong entity; 22
  confident facts for `rgb`), delimiter-aware handle matching (`nasaa` in
  `nasaa_research`, `rgb` in `sRGB`), profile-only related-account links
  (3 share-button URLs + 1 `facebook.com` sameAs), checker canonicalization
  (5 of natgeo's "unsupported" facts were escaping in the checker, not missing
  evidence), and host-level ground-truth matching (nasa's verified domain was
  reached via a subpage, reported as a miss).
- **One falsified expectation, corrected on the record:** `nasaa` FORBID was
  wrong — the string names real organizations (nasaa-arts.org HTTP 200, brand
  596×; nasaa.org exists behind 403 to any user-agent). Case is REVIEW with
  that evidence; the gate itself never moved.

After the corrections (live, 2026-10-19): nasa 15 facts/100% support/0%
duplicates/gt 1/1 fetched, natgeo 2 facts/100% support with 16 values counted
and none mis-attributed, github 333 facts/100% support/0 unattributed,
rgb 0 facts/`RELEVANT_NO_FACTS` (was 22 confident facts), nasaa 6
string-true facts/REVIEW, sel_win_ and zqwxplm2026 honest zeros — every
expectation MET or REVIEW, none MISSED.

Gates run, actual results (2026-10-19):

- **Typecheck:** `pnpm typecheck` — all workspaces clean, exit 0.
- **Full suite:** `pnpm test` — **78 files, 736 passed, 1 known skip, 0
  failed** (baseline §15: 76 files/707; +2 files — `bench.test.ts` 21 checks,
  `bench-saved.test.ts` 3 replay checks — plus +3 extractor profile-only
  checks and +2 audit self-identification/bypass scenarios, and 2 audit
  fixtures updated to keep their gate-contrast intent under the stronger rule).
- **Capability checks:** `pnpm docs:capabilities` regenerated; the core
  registry pin suite passes (10 files/79 tests); `igtrack capabilities` exit
  0 (20 of 25 obtainable). WEB_RESEARCH `liveEvidence` now carries the dated
  Phase-3 measurement alongside the Phase-2 record.
- **CLI smoke (live):** `igtrack audit nasa` — `SEARCH_SUCCEEDED` ·
  `EVIDENCE_EXTRACTED` · 15 facts; totals show `not attributed (page named the
  handle, value names the source) 19`; the note and per-document lines explain
  the rule and its `--url` asymmetry; secret scan of the full render clean.
  `pnpm bench:audit --cases nasa` — MET, Brave `NOT MEASURED`, exit 0.

Status: **COMPLETE** for everything locally verifiable. Stated limitations:
the Brave keyed leg remains live-unverified (no key anywhere in this
environment); the committed saved layer covers 3 of the 7 cases (re-recording
all seven is one command); natgeo's verified ground-truth host was not
returned by the one live index in the measured runs (reported 0/1 honestly,
not papered over); nasaa.org answers 403 to every user-agent, so that site's
coverage is a dated gap, not an absence. No credential was requested or
written anywhere; no CI, push, release or tag occurred; all work remains
uncommitted in the working tree.

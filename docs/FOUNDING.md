# Founding memo — IGTrack, second founding

**Date:** 2026-10-15 · **Author:** project founder (decision record) · **Status:** adopted

This document is the founding decision record for IGTrack's second life: from a
private product plan to a **free, open-source, agent-native observation engine**.
It is written to be read first by humans, then by the coding agents that will
operate and extend this repository.

---

## 1. The problem we actually solve

Anyone who runs a public account — a brand, a venue, a creator, a club, a
researcher — eventually asks the same question:

> *What actually changed, when did it change, and how do I know?*

The tools that claim to answer it today are of two kinds, and both lie:

1. **Scrapers and "anonymous viewers"** (the anonstories class of product) reach
   around access controls with undocumented endpoints, hardcoded service
   credentials, and proxy re-serving of bytes. They are brittle, they are
   ToS-violating, and — as our own reverse-engineering report showed — their
   "insights" are fields the upstream API handed them. They cannot tell you
   *whether* a mention was rendered; they just print names.
2. **Analytics dashboards** report numbers with no provenance. Absence is
   rendered as zero. A count that was never observable looks identical to a
   count that is zero. There is no way to audit a claim.

The gap is not "more data". The gap is **epistemic integrity**: a system that
records what was observed, when, from which source, under which permission, and
that shows absence *as absence* instead of inventing a number.

That is the core concept, and it is not negotiable in the second founding:

> **IGTrack is an evidence-first observation engine for Instagram accounts you
> are authorized to observe. Every claim carries provenance. Anything the law,
> the platform, or your permissions do not expose is reported as UNAVAILABLE
> with a reason — never as zero, never as a guess, never as a scrape.**

## 2. What the reverse-engineering pass established

Before changing anything, the shipped system was read end to end (schema,
providers, worker, web app, tests, deployment). Findings that drove decisions:

| Area | Reality |
|---|---|
| Domain core (`packages/core`) | Genuinely strong: observation categories, confidence, capability results, typed errors + retryability, evidence hashing, append-only diffs, mention-visibility classification. Zero runtime dependencies. This is the asset. |
| Providers (`packages/ingestion`) | Two: `fixture:v1` (deterministic synthetic data) and `graph` (official Instagram Graph API, **owned account only**). Well-tested normalizers, docs-pinned field audit. |
| Worker (`workers/monitoring`) | Real Postgres job queue (`FOR UPDATE SKIP LOCKED`), leases, heartbeats, resumable paged scans, checkpoints + staging table, retry classification, scheduler with per-target cadence, retention ticks. Production-grade discipline. |
| Web app (`apps/web`) | Next.js 15 App Router: dashboard, targets, activity, relationships, stories, content, evidence, diagnostics, lookup, settings. Session auth, CSRF, rate limits, ownership scoping. |
| Live capability ceiling | Followers/following **lists**, highlights, likes, interactions, reposts, media bytes are `DOCUMENTED_ABSENT` from the official API — not "an auth tier away". The project already documents this honestly, and tests pin it. |
| Marketing ceiling | The old headline ("monitor anyone's relationships") is **not deliverable lawfully**. Only the owned-account Graph path is real; everything else is synthetic. Honesty here is the product, not a limitation to hide. |
| Documentation | All project markdown had been deleted before this pass. There was no README, LICENSE, CONTRIBUTING, or agent contract. Open-sourcing was blocked on exactly this. |
| Distribution | Render free tier + Neon free Postgres + GitHub Actions cron + R2 backups. Free, but vendor-shaped and undocumented as a choice. |

## 3. The second founding: what changes

**Positioning.** From "relationship intelligence for public Instagram accounts"
to **"the evidence-first observation engine you self-host, driven by your own AI
agent."** Same core concept, radically different delivery.

**Distribution model: bring your own agent (BYO-agent).** There is no hosted
service, no subscription, no paid plan, and no plan to add one. IGTrack is a
library + CLI + MCP server + web UI that runs on the user's machine or their own
free-tier infrastructure. Users bring Claude Code, Codex, Cursor, or any MCP
client; the agent gets tools, not a bill.

**The agent-native surface is a first-class product**, not a wrapper:
- `igtrack` CLI — every operation, JSON-first, scriptable, no browser required.
- `igtrack mcp` — a stdio MCP server exposing the same operations as agent tools.
- `AGENTS.md` — the contract that tells an agent how to install, run, verify,
  and which invariants it must never break.

**What is cut.** SaaS-shaped assumptions: the vendor-specific deployment story as
the default (now optional recipes), any implication that arbitrary accounts can
be monitored, and dead weight that only served the private-product phase. The
`render.yaml`/Neon/R2/GitHub-Actions paths remain as *optional* free-tier
recipes, clearly labelled.

**What is added.** README/LICENSE/AGENTS/CONTRIBUTING/SECURITY/CoC, architecture
and capability docs, a full-stack `docker compose up` quickstart, the CLI, the
MCP server, and tests that pin the new surfaces.

## 4. Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | **License: AGPL-3.0-or-later** | The value of this project is a trust stance. A permissive license invites exactly the enclosure we are positioned against (a closed hosted fork of the same code selling subscriptions). AGPL keeps the code free for every self-hoster and for any agent, while requiring operators who *offer it as a network service* to publish their changes. |
| D2 | **Name: IGTrack** (repo `igtrack`, packages `@igtrack/*`, env prefix `IGTRACK_`) | Already consistent across code, schema, cookies and docs. Renaming identifiers would break every existing deployment for zero product value. "igtrac" is treated as a misspelling of the same name. |
| D3 | **Lawful sources only** | No undocumented/private endpoints, no session cookies, no access-control circumvention, no media-byte proxying. This is a hard invariant with tests. The anonstories-class capability is explicitly refused even though it is technically trivial. |
| D4 | **Authorized-observation default** | Live ingestion = the official Graph API against **your own** Business/Creator account. Everything else ships as: synthetic fixtures (default), and user-supplied captures/exports as evidence. |
| D5 | **No paid anything** | No hosted tier, no telemetry, no accounts-on-our-server, no third-party paid API in the default path. Free-tier recipes documented; the local path is fully offline after install. |
| D6 | **Postgres is the only required external service** | Already the queue, the store and the coordination layer. SQLite would fork the codebase for no gain; Docker makes Postgres a one-command local dependency (~200MB). |
| D7 | **Honesty is enforced by tests, not prose** | The capability registry stays machine-readable; every provider method ↔ table ↔ UI link is pinned. New surfaces get the same treatment. |
| D8 | **Absence ≠ zero** | Nullable everywhere; no zero-filling; `UNAVAILABLE` must carry a reason. Applies to new CLI/MCP output too. |
| D9 | **Diff only COMPLETE snapshots** | Truncated scans are recorded but never diffed, so partiality can never fabricate a loss. |
| D10 | **Evidence over convenience** | Raw + normalized hashes, observed vs captured time, source reference on every stored claim. Agents read evidence, not vibes. |
| D11 | **Keep the monorepo, keep pnpm + TS ESM + tsx** | No build step for the worker/CLI keeps iteration fast and the agent contract simple. |
| D12 | **Delete nothing that earns its keep** | Writerless tables (`interactions`, `media_assets`) stay as documented, dormant landing zones with emptiness tests — they encode policy, and deleting them would erase the rationale. |

## 5. Non-goals (deliberately not building)

- Monitoring accounts you do not own or are not authorized to observe.
- Private-account access, story/highlight proxy viewing, media download pipelines.
- Follower **lists** for arbitrary accounts (the platform does not expose them).
- Liker lists, interaction feeds, repost attribution, archived media bytes.
- Hosted multi-tenant SaaS, billing, seats, or any paid tier — ever.
- A mobile app, a browser extension, or a Chrome-automation path.
- Any AI inference that launders speculation into "findings". If it is not
  observed or derived from observations, it is not shown.

## 6. Roadmap

**Now (this pass):** open-source front door (README/license/agent contract/docs),
full-stack `docker compose` quickstart, `igtrack` CLI, `igtrack mcp` stdio server,
capability matrix generated from the registry, repo hygiene (third-party trees
ignored, vendor recipes demoted to optional).

**Next:** provider plugin contract + a `user-supplied import` provider
(Instagram's own data export / capture JSON becomes first-class evidence);
capability matrix as a generated artifact with a drift test; watchlist→alert
pipeline delivered through the agent (agent polls `igtrack activity --since`)
instead of a hosted notifier; benchmark harness exposed as `igtrack bench`.

**Later:** highlight-shaped storage ready for the day an official edge exists;
optional adapters for other lawful platforms behind the same provider contract;
a "provenance diff" view that shows a claim's full chain in one screen.

**Explicitly deferred:** anything requiring a hosted service we would have to pay
for or police on behalf of users.

## 7. Implementation log for this pass

What was actually built and verified, so the next pass can trust or challenge it:

| Item | Evidence |
|---|---|
| `docs/FOUNDING.md` (this record) | written first, before any code changed |
| `apps/cli` — operations layer (`src/tools.ts`), CLI (`src/main.ts` + `src/commands/*`), MCP server (`src/mcp/server.ts`, 15 tools) | `pnpm igtrack setup/status/doctor/scans run/work/activity/relationships/evidence/capabilities/lookup/targets …` run end to end against Docker Postgres; MCP handshake verified with a real client (`initialize` → `tools/list` → 15 `tools/call`, including a typed `isError`) |
| Agent-surface tests | `apps/cli/test/{output,mcp,operations}.test.ts` — 24 tests, including windowed queue dedupe, PAUSED-skip reasons, and "database down ⇒ `isError`, never an empty success" |
| Generated capability matrix | `packages/core/src/capability-matrix.ts` + `pnpm docs:capabilities` → `docs/CAPABILITIES.md`, with a drift test in `packages/core/test/capability-matrix.test.ts` |
| Zero-cost front door | `README.md`, `AGENTS.md`, `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOY.md` |
| Repo hygiene | third-party analysis tooling and its caches ignored; the vendor-specific `render.yaml` demoted to an explicitly optional recipe |
| Full verification | `pnpm typecheck` clean across 7 packages; `pnpm test` → **402 passed, 1 skipped (66 files)** — was 374 passing before this pass |

One honest correction found during implementation: `listScopedEvidence` typed
`raw_hash` as a string, but evidence rows legitimately carry no raw hash when the
provider cannot transport a raw representation (follow snapshots, for example).
The type now says `string | null`, the CLI renders that absence as
`unavailable`, and a test asserts a hash is either a real 64-char digest or
absent — never a placeholder and never a normalized hash wearing a raw hash's name.

## 8. Standing questions for the next founder pass

1. Does the user-supplied-import provider deserve to be the *second* real
   provider (ahead of any other platform)?
2. Should `igtrack bench` publish a public performance baseline, and against
   which hardware class?
3. When an official highlights edge appears, do we ship the pipeline
   immediately, or hold for a second independent confirmation?

---

## 9. Third founding — the agent surface becomes the only surface

**Date:** 2026-10-15 · **Author:** project founder (decision record) · **Status:** adopted

The second founding kept one SaaS-shaped artifact alive "as an optional
recipe": the Next.js web UI, its session-auth stack, its browser E2E suite, and
the vendor-specific deployment descriptors (Render, Neon-cron, R2 backups). The
third founding removes them. The BYO-agent model is no longer one delivery
option among several — it is the product.

### What the reverse-engineering pass (this one) established

- The agent surface (`apps/cli`: 13 commands, 15 MCP tools) already covers every
  read and mutation the web UI offered, through one operations layer with typed
  errors and honest `_meta`. The web app was a second rendering of the same
  repositories, not a capability.
- The web app carried the entire auth surface: `users.password_hash`, the
  `sessions` table, session purge in the worker's maintenance tick, CSRF, an
  in-memory rate limiter, a dev-login route, and ~14 test files — all to protect
  an HTTP surface that the target user (someone with Claude Code or Codex) never
  opens.
- The hosted descriptors (`render.yaml`, `monitoring-worker.yml`, `backup.yml`,
  `restore.yml`, `migrate.yml`) encoded one founder's account-specific
  deployment, implying a hosted service that D5 forbids.
- Nothing in the core, database, ingestion, or worker packages depended on the
  web app. The seam was clean.

### Decision log (this pass)

| # | Decision | Rationale |
|---|---|---|
| D13 | **Delete `apps/web` entirely** | One product surface. A second surface doubles the invariant-enforcement burden (every honesty rule would need enforcing in two renderings) and invites the repo back toward the SaaS shape D1/D5 exist to prevent. AGPL already protects against hostile forks; lean protects against drift. |
| D14 | **Delete web auth wholesale** — `sessions` table, `password_hash` column, `auth/{passwords,sessions}.ts`, `createUserWithPassword`, session purge in the worker (migration `0013_drop_web_auth`) | The agent surface authenticates to nothing; it is a local process the operator already controls. The `users` table stays as pure ownership scope so invariant 9 survives unchanged. |
| D15 | **Delete the hosted deployment surface** — `render.yaml`, `Dockerfile.web`, the web service in `docker-compose.prod.yml`, the Neon-cron/R2/deploy-hook GitHub workflows, `scripts/backup-cloud.sh` | A repo that ships someone's hosting account reads as a service. `docker-compose.prod.yml` (db + worker), `Dockerfile.worker`, and the generic pg_dump `backup.sh`/`restore.sh` remain and cover the real self-hosting path. |
| D16 | **Delete the browser E2E suite** — `e2e/`, `playwright.config.ts`, the Playwright dependency, the CI e2e jobs | There is no browser surface to drive. CI remains: typecheck, full test suite against real Postgres, worker boot smoke. |
| D17 | **Repo hygiene** — `.freebuff/`, `wc.out.txt`, `cleanup.ps1` removed; `.freebuff/` ignored | Local scratch never belongs in a public repo. |
| D18 | **Version stays 0.1.0** | No release has ever shipped; semver 0.x covers pre-1.0 breakage. A CHANGELOG starts when there is a consumer to inform. |

### What was deliberately NOT added

The second founding's roadmap (user-supplied-import provider, `igtrack bench`,
watchlist→alert via agent polling) stays roadmap. Shipping none of it in this
pass is the point: the third founding is subtraction. New capability earns its
place by serving the core concept — observed, derived, or honestly refused —
not by filling a changelog.

### Verification for this pass

| Item | Evidence |
|---|---|
| Web, E2E, auth, hosted-ops deleted | `git rm` of `apps/web/`, `e2e/`, `playwright.config.ts`, `Dockerfile.web`, `render.yaml`, `packages/database/src/auth/`, four workflows, `scripts/backup-cloud.sh` |
| Schema | `packages/database/migrations/0013_drop_web_auth.sql` (drops `sessions`, drops `users.password_hash`), journal entry idx 13 |
| Typecheck | `pnpm typecheck` clean across the 5 remaining workspace packages |
| Tests | `pnpm test` — see the commit record for the exact count after this pass |

---

## 10. Phase A — closing the honesty gaps (post-third-founding audit)

A source-code-only reverse-engineering audit (never the docs) found twelve
places where the code's behavior fell short of the stated invariants. Phase A
closes them; nothing new was added, only truthfulness restored.

### Decision log (Phase A)

| # | Decision | Rationale |
|---|---|---|
| D19 | **Profile snapshots record `completeness`** — new `snapshot_completeness` column on `profile_snapshots` (migration 0014), diff gated on `previous.completeness === "COMPLETE" && completeness === "COMPLETE"` | Invariant 4 applied symmetrically to profiles: a PARTIAL snapshot is never diffed in either direction. Diffing a truncated baseline would fabricate field changes, exactly like `LOST_FOLLOWER` from a half-read page. Mirrors `follow_snapshots.completeness` one-for-one. |
| D20 | **Graph 400/404 → UNAVAILABLE on every method, via one fix in `providerFailure`** | Only three of six catch paths honoured `err.unavailable`; the other three reported a failure where the platform structurally refuses. Honesty must not depend on which method was called. The three now-redundant explicit checks were deleted. |
| D21 | **Follow-scan evidence forwards the final page's confidence** instead of forcing HIGH | A PARTIAL scan's evidence must not claim more certainty than its pages gave. Snapshot `meta.confidence` follows the same rule. |
| D22 | **PARTIAL final page without a cursor ⇒ `truncated`** (posts, comments); fixture comments return PARTIAL when the payload declares pages it cannot serve | A listing that ends in a partial page but reports "complete" is a lie by omission. Fixture comments previously wore MEDIUM confidence as a complete-looking listing. |
| D23 | **Fixture provenance derives from the directory version** — `IGTRACK_FIXTURE_VERSION` labels `sourceId`, and the provider refuses a manifest whose version disagrees (SCHEMA_MISMATCH, fail-fast) | The hard-coded `"fixture:v1"` could lie about which bytes were read. |
| D24 | **`opScanList` owner-scoped** — `listQueueJobs` gained a `userId` filter; the no-target branch lists only the owner's jobs | Invariant 9: job rows carry usernames and error messages; the deployment-wide queue belongs in `status` (global by design), not in a caller's tool. |
| D25 | **`story_sightings` append-only** (0014 trigger, 13th table); **`run-once` runs `validateWorkerEnv`**; **doctor's dead `? 0 : 0` ternary removed**; stale "sessions" comment corrected | Housekeeping the audit flagged: the invariant family is complete, the dev worker shares the daemon's boot guard, and dead code that implies behavior that does not exist is deleted. |
| D26 | **Registry↔provider↔schema consistency test** (`capability-consistency.test.ts`) | The registry *claimed* its `providerMethods` and `persistence` entries were real; the claim was never executed. It is now a red test if it drifts. |

### Verification for Phase A

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` clean across the 5 workspace packages |
| Tests | `pnpm test` — 53 files, 353 passed, 1 skipped (new: consistency test, profile PARTIAL-diff gate, graph 400/404 symmetry, fixture provenance + comments PARTIAL; updated: append-only trigger pin 12→13 for D25) |
| Schema | `packages/database/migrations/0014_profile_completeness_sightings_trigger.sql`, journal idx 14 |

Deliberately NOT changed: multi-page follow evidence keeps `raw_hash: null`
(composite evidence honestly carries no single raw payload), and deployment-
level queue counts in `igtrack status` stay global — they describe the
deployment, not a tenant.

---

## 11. Phase B — the lawful real-data path (import:v1)

Instagram ships every account owner their own data export ("Download your
information", JSON). Phase B reads it: the first path to a REAL
follower/following roster that touches no access control, because the platform
hands the bytes to the operator itself.

### Decision log (Phase B)

| # | Decision | Rationale |
|---|---|---|
| D27 | **New `import:v1` provider** reading `connections/followers_and_following/{followers_N.json,following.json}` (`string_list_data` shape), wired via `IGTRACK_PROVIDER=import` + `IGTRACK_IMPORT_DIR` + `IGTRACK_IMPORT_USERNAME` | Invariant 3's lawful line: the export reaches no one else's data and circumvents nothing — Instagram delivers it to the account owner. Rosters were the one capability fixture could only fake; now the full pipeline runs on real bytes. |
| D28 | **Import observes exactly one account: its owner** — `resolveAccount` matches only `IGTRACK_IMPORT_USERNAME` (case-insensitive); every other username is a typed `ACCOUNT_NOT_FOUND` | The export contains one account's roster. Claiming more would fabricate scope; probing others would be scraping. Mirrors Graph's owned-account-only rule. |
| D29 | **Everything outside the roster answers UNAVAILABLE with the reason** — profile ("the export carries no profile snapshot"), stories (exports never contain them), posts/comments/children ("not read by this provider version"), and a missing roster file names the fix | Invariant 2's three cases honored exactly: structurally absent from an export ≠ not-yet-read by v1 ≠ genuinely empty. Never zero, never a guessed profile. |
| D30 | **One page = one raw export file** — cursor is the next filename, genuine sha256 per file, `COMPLETE` only on the last file; within-file usernames deduped; malformed entries fail loudly (SCHEMA_MISMATCH) instead of silently shrinking the roster | Per-file provenance keeps `raw_hash` genuine — no synthetic concatenation masquerading as a transported payload — and Phase A's last-page confidence rules apply unchanged. |
| D31 | **Fail-fast configuration** — missing `IGTRACK_IMPORT_DIR`/`IGTRACK_IMPORT_USERNAME` or a nonexistent directory throws a configuration error whose message never mentions UNAVAILABLE | Invariant 7: misconfiguration must never look like "no data". |
| D32 | **Registry, generated matrix, and the shared conformance harness all updated** — FOLLOWERS/FOLLOWING entries name the import source; `pnpm docs:capabilities` regenerated; `import:v1` passes the same C1–C5 contract as fixture | The registry stays the single source of truth (drift test enforced), and a second provider proving the harness keeps the contract honest. |

### Verification for Phase B

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` clean across the 5 workspace packages |
| Tests | `pnpm test` — 54 files, 372 passed, 1 skipped (new: import-provider 10, import conformance 5, provider-config +4; CAPABILITIES.md drift test green post-regen) |
| Sample | `packages/ingestion/fixtures/import-sample/` — synthetic two-file export, checked in, used by tests |

Not claimed: no live Graph token exists in this environment, so FOLLOWERS and
FOLLOWING stay `DOCUMENTED_ABSENT` for the live API edge — import supplies the
roster through the owner's export, which is not an edge at all. `LIVE_VERIFIED`
remains out of reach until a live provider check actually runs.

---

## 12. Phase C — pinning the agent-facing refusals

The surface an autonomous agent leans on hardest is not the happy path; it is
the refusals. Phase C closes the two honesty gaps those paths exposed and pins
the rest with tests.

### Decision log (Phase C)

| # | Decision | Rationale |
|---|---|---|
| D33 | **`opActivity` validates activity types at the operations layer** — unknown type → `UsageError` (`USAGE`) listing the allowed values | The old predicate claimed `t is ActivityType` after checking only nonemptiness, and the MCP schema accepts free strings: a junk filter was dropped downstream, so "no events of that type" read as "no events" — empty data posed as an answer. One validation site serves both consumers, per AGENTS.md §4. |
| D34 | **`guarded` classifies connection failures as `DB_UNAVAILABLE`**, not `INTERNAL` | "Could not look" is a different claim from "we broke," and an agent retries them differently. The predicate is the same one that already discards the cached context, so the classification reuses the codebase's own definition of a connection failure. Three honest classes remain: the operation's own `CliError` code, `DB_UNAVAILABLE`, `INTERNAL`. |
| D35 | **The refusals themselves get tests** — `resolveUser` precedence matrix (NO_USER on empty db and on an unmatched email, AMBIGUOUS_USER listing every candidate and the flag to resolve it, explicit beats env beats single-user default, case-insensitive); unknown scan kind → `USAGE` before anything enqueues; MCP deletion gated by `confirm` at the schema, proven by the absence of the guarded envelope; `error.code` asserted on the typed path | A refusal an agent cannot distinguish from empty data it will fill with guesses. These are the exact paths where that could happen. |

### Verification for Phase C

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` clean across the 5 workspace packages |
| Tests | `pnpm test` — 55 files, 381 passed, 1 skipped (new: `resolve-user.test.ts` 6, operations +2, MCP +1 with code assertions) |

Deliberately NOT built: `igtrack bench` — no measured need for a benchmark
surface yet (YAGNI); revisit if provider performance becomes a real question.

---

## 13. Phase D — own-account insights, informed by market research

**Date:** 2026-10-15 · **Status:** adopted

Four read-only research streams (vendor pricing pages, Meta's own documentation,
Reddit threads read verbatim, GitHub, the official MCP registry) were run before
this phase. The evidence lives in `docs/research/` — stream files 01–04 plus
`00-synthesis.md` — and it changed what Phase D builds.

What the research established, and what it meant here:

- **The 90-day wall is the market's central wound, and Meta now charges to remove
  it** ("Extended Insights History (Instagram)": a Meta One paid feature). History
  cannot be bought retrospectively — every tool's backfill reads the same 90 days,
  once. IGTrack's snapshots are already the honest answer; the pitch is "start
  recording now".
- **The lawful export-diff lane is where every honest competitor is converging**
  (FollowBuddy, Unfollr, FANS, followsback, OSS SilentSnitch) — and it is exactly
  Phase B's `import:v1` → snapshot → `follow_deltas` pipeline. The wedge is doing
  it automatically, with evidence, and never touching a session cookie.
- **"Absence is not zero" is a market differentiator, not just an invariant.**
  Meta's API returns an *empty data set* for unavailable metrics; vendor analyses
  concede that "a tool that plots zeros will invent fake crashes on your charts".
- **MCP access is table stakes by now** (Metricool ships MCP on its free plan;
  Sociality.io sells "for teams and AI agents"). The differentiator is what the
  agent is allowed to claim — of ~78 surveyed Instagram MCP servers, none exposes
  an append-only ledger, content hashes, or UNAVAILABLE-with-reason.
- **The own-account insights edge is documented, lawful, and needs no App Review**
  ("If your app only serves your Instagram professional account or an account you
  manage, Standard Access is all your app needs", Meta, 2026-06-30). It observes
  what the market's top-ranked unmet demands are about: follower-count history,
  daily reach/engagement, and demographics — which the API exposes only as a
  current-state snapshot, so a stored series is the *only* honest trend line.

### Decision log (Phase D)

| # | Decision | Rationale |
|---|---|---|
| D36 | **New capability `ACCOUNT_INSIGHTS` + provider method `getAccountInsights` (graph)** on the documented IG User insights edge: daily time series for `follower_count`, `reach`, `views`, `accounts_engaged`, `total_interactions`, plus `follower_demographics` (country breakdown) as a lifetime `total_value` snapshot. One method, one scan kind (`INSIGHTS_SCAN`), one append-only table (`insight_points`), one executor, one op (`igtrack insights` CLI + MCP tool). | The research's #1/#3 demands (history beyond 90 days, hourly/country granularity, demographic trend lines) map onto exactly the metrics this edge exposes. The provider always supplies an explicit 30-day window because the documented default is a trap (24-hour lookback when `since`/`until` are omitted), and requests `views` (not deprecated `impressions`) under a docs-pinned metric set. **Correction (2026-10-15, after reading the Instagram Account Insights reference):** only `reach` and `follower_count` are documented `time_series`-capable; `accounts_engaged`, `total_interactions` and `views` are `total_value` only. Requesting a metric under a `metric_type` it does not support yields an empty data set — which the absence pipeline would have stored as a *false* absence. The provider therefore splits the scan into three documented calls by type: time series (`follower_count,reach`, explicit 30-day `since`/`until`), totals (`accounts_engaged,total_interactions,views`), and demographics (`follower_demographics`, `lifetime`, `timeframe=this_month`, `breakdown=country`). Pinned as constants in `graph-provider.ts` and covered by the graph provider tests. |
| D37 | **A metric the platform does not return is stored as an ABSENCE row** — `insight_points.value` and `unavailable_reason` are XOR (schema CHECK): a row either carries a number or a reason, never both, never neither. Absences carry the documented rule (below 100 followers, 48 h demographic delay) when one applies. | Invariant 8's "empty data set, not 0" made structural. A metric going absent in scan N and present in scan N+1 is itself an observable event — and a value claim without a reason would be the exact zero-filling this project exists to prevent. |
| D38 | **`import:v1` refuses insights honestly** — `getAccountInsights` returns UNAVAILABLE with "the data export carries no account insight metrics"; the capability map says false. | D29's rule applied to a new method: an export legitimately contains rosters and media, not insights. Silence or a zero would be a lie; the refusal names the fix (use the graph provider). |
| D39 | **Fixture synthesizes a deterministic insight set and mirrors one documented rule**: a seeded daily series + country demographics, and — when the fixture account is below 100 followers — `follower_count` and `follower_demographics` come back as absences with the real platform reason verbatim. | The fixture path must exercise the absence pipeline, not just the happy path; mirroring the documented <100-follower rule keeps the synthetic data structurally faithful, which the conformance harness can then pin. |
| D40 | **Business Discovery stays deferred as a scope decision, on the record.** It is the market's biggest paid category, but it requires changing the founding non-goal ("monitoring accounts you do not own"), a Facebook-Login product behind app review, and acceptance of a narrow, age-gate-prone edge. The synthesis records the evidence and the question for a founder pass with live credentials. | D4's authorized-observation line is a scope decision, not an accident; expanding it silently while "finishing features" is exactly how a project's stance erodes. |
| D41 | **Insights cadence: every 6 hours**, `IGTRACK_SCAN_INSIGHTS_MS` overrides. | Insights move slowly but have perishable windows (metrics lag up to 48 h; story insights die at 24 h), and early capture is the entire value of a snapshot product. Matches PROFILE_SCAN's cadence. |

### Verification for Phase D

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — clean across all 5 workspace packages (2026-10-15) |
| Tests | `pnpm test` — 56 files, 394 passed, 1 skipped, 0 failed; new suites `workers/monitoring/test/insights-scan.test.ts`, `graph-provider.test.ts` (metric-type split), `fixture-provider.test.ts` (<100-follower absence), `operations.test.ts` + `mcp.test.ts` (agent surface) |
| End-to-end (fixture) | `igtrack setup` → `scans run` enqueues `INSIGHTS_SCAN` → `work` completes it → `insights target_a` prints 68 recorded values, 0 absences, 10 metric/breakdown rows oldest-value-first; `--json` carries `_meta` with `synthetic: true` |
| Schema | `packages/database/migrations/0015_insight_points.sql`, journal idx 15 |
| Docs | `docs/research/00-synthesis.md` (+ streams 01–04); `docs/CAPABILITIES.md` regenerated from the registry |

Not claimed in this phase: no live Graph credential exists in this environment, so
`ACCOUNT_INSIGHTS` is `NOT_VERIFIED` live; the request shape is docs-pinned against
the IG User insights reference (updated 2026-06-16). The metric set is v1 — 
`online_followers` (24 hourly buckets), `follows_and_unfollows` (breakdown-shaped),
and media-level insights are deliberately not requested yet; the unlock path is
recorded in the registry entry rather than guessed at here.


---

## 14. The fourth founding - the complete-account dossier requirement

**Date:** 2026-10-15 · **Status:** adopted (requirement recorded; Phase E built where lawful)

The founder stated the product requirement in full: given **any public account
username**, the system should surface that account's details (follower/following
counts, posts, tags, stories, highlights - *including hidden ones* - story and
highlight tags), every comment and like the account ever left on other public
accounts' posts, its reposts, an id-based lookup, who followed/unfollowed since
the last audit (both directions, by name), and a "closest contacts" analysis
built by analysing interactions (comments, likes, reposts, tags) not only on the
observed account but **recursively through its followers' and following's
accounts**. This section records that requirement faithfully, then maps every
clause to what is observable, what is absent by platform design, and what would
require access-control circumvention - which this project does not do (invariant
3), because that is the line that makes it lawful and the thing that gets
accounts disabled (stream 02, verbatim user reports).

The requirement is the north star. The refusals below are not TODOs and not
gaps-to-close-later: they are the platform's shape, verified in stream 04
against Meta's own references (dated). **Changing a refusal requires a new
dated founding entry here - not a feature PR, not a later agent's "finishing
the feature".**

### 14.1 The requirement, clause by clause, mapped

| # | The ask (as given) | Lawful route | Status |
|---|---|---|---|
| A1 | Give any public account username - show its details (follower/following counts, posts) | **Business Discovery** - `GET /{owned-ig-id}?fields=business_discovery.username({x}){...}`: public profile fields + bounded `media` edge with `comments_count`, `like_count` (the provider requests only the audited field set; `view_count` is Reels-only and outside it, so it is not requested). Public **Business/Creator** accounts only; consumer and private accounts are unreachable; age-gated accounts return **nothing** | **Built this phase** (D42): opt-in, probe-only, absence-with-reason for the unreachable classes |
| A2 | Tags (media the account is tagged in / tagged content) | Own account: the IG User `tags` edge exists (media where *you* were tagged) - not yet requested by any provider method. Other accounts: no tags edge on the generic node; the only cross-account route is Hashtag Search (App Review + 30 hashtags / rolling 7 days + business verification) | **Gap recorded** (D46): own-account tags edge is a lawful Phase E candidate; hashtag route is gated and deferred |
| A3 | Their stories | Own account: `stories` edge (implemented, STORIES). Other accounts: only the owner's tray exists - no story edge for third-party accounts | Own: **exists**. Others: **refused** (STORIES liveEvidence) |
| A4 | Their highlights, story tags, highlight tags - "even if it is hidden" | No `highlights` edge exists anywhere (IG User reference, 2026-04-22); archived story content is not enumerable after the 24 h window; story tags of others do not exist as readable fields; the export does not carry highlight content. "Even if hidden" = the owner's session cookie = unlawful | **Refused** (HIGHLIGHTS, DOCUMENTED_ABSENT) |
| A5 | All comments the account made on other public accounts' posts | No edge exists. Comments are readable only on media you own or manage (comments edge on own media, `mentioned_comment`); no route enumerates a third party's outgoing comments | **Refused** (INTERACTIONS, DOCUMENTED_ABSENT) |
| A6 | All likes the account made on other public accounts' posts | No edge exists and none can: the likers list is absent by design, and Instagram made like activity private. `like_count` is a number; who is never enumerated | **Refused** (LIKES, DOCUMENTED_ABSENT) |
| A7 | Reposts | `reposts_count` exists as a *number* on IG Media (added 2026-04-22) for media you can read; no edge lists reposting accounts; "the account's reposts" is not an API concept | **Partial**: count for owned media is requestable (recorded, D46); identities **refused** (REPOSTS) |
| A8 | "If anyone takes the user id, it should show" | No id → account route exists for arbitrary accounts. The platform id is an *output of* a username-based Business Discovery response, and a *credential input* for the owned account - never a lookup key | **Adopted semantics** (D44): id is returned by discovery; `lookup` stays username-keyed |
| A9 | Who followed / unfollowed since the last audit, both directions, by name | The operator's own export (import:v1 → snapshots → `follow_deltas` → `activity`), COMPLETE-only diffs; both directions; names included | **Already built** (Phase B); demonstrated in the demo feed as NEW_FOLLOWING / LOST_FOLLOWING rows |
| A10 | Closest contacts by analysing comments/likes/reposts/tags - and the same recursively through followers' and following's accounts | Observable signals on accounts the operator owns: story mentions (implemented), comment authorship on owned media (**built this phase**), follow deltas (implemented). The recursive input - the follow/following graph of arbitrary accounts plus their likes/comments/reposts - does not exist lawfully; the only way to obtain it is scraping/session access, which the market evidence shows gets accounts permanently disabled and is invariant-3 prohibited | Observed-evidence ranking: **extended** (D43). Recursive traversal: **refused, permanently** |

### 14.2 Decision log (Phase E)

| # | Decision | Rationale |
|---|---|---|
| D42 | **Adopt Business Discovery as the only route to other-account public data** - opt-in via `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1`; the audited profile + media field sets only (no `view_count`: Reels-only, not audited); results are a **probe, not a record** (no persistence, therefore no evidence obligation); unreachable classes (consumer, private, age-gated) become UNAVAILABLE **with the reason**; requires the Facebook Login product + `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement`; live state `NOT_VERIFIED` until a credential exists. | The ask behind A1 is the market's biggest paid category and the only lawful cross-account route. It changes D4's "owned accounts only" scope, so it is explicit, opt-in, and gated - and it refuses to pretend: age-gated accounts "return nothing" is Meta's own documented behavior, so nothing is what they get here, with the reason. |
| D43 | **Comment authorship on owned media becomes the third relationship signal** (weights: mentions 12, comments 10, deltas 8), ranked only from stored evidence. | It directly answers A10's core with data already observed (post_comments.author_account_id) - no new scans, no new tables. Weight rationale: a story mention is a public act naming the account; a comment is a direct interaction; a follow delta is a structural change. All three are observed facts; the score orders them, it never invents one. |
| D44 | **The platform id is an output, never a lookup key.** `lookup` accepts a username; discovery responses carry `id` where the platform returns it; the owned account's id remains a credential (`IGTRACK_GRAPH_IG_USER_ID`). | An id → account route does not exist. Any local mapping table would be fabricated knowledge, and any remote id resolution would be the undocumented-endpoint path (invariant 3). |
| D45 | **The dossier requirement is recorded as the product north star** (this section); AGENTS.md carries the binding refusal list; a change to any refused row requires a new dated founding entry. | The failure mode this prevents: a future agent asked "add likes-the-user-made" reading a TODO and building a scraper. The refusals are the product's lawfulness, not an oversight. |
| D46 | **Recorded, not built (unlock paths):** own-account `tags` edge (A2); media `reposts_count` / `saved_count` / `shares_count` on owned media (A7, documented 2026-04-22 fields); the `mentions` edge of the owned account (A5's only lawful sliver - comments where *you* were mentioned). Hashtag Search is **deferred as unpromising**: App Review actively rejects the analytics use case verbatim ("IPCA cannot be used to retrieve metrics and insights of the content"), plus a 30 hashtags / 7 days budget. | Each is a lawful, documented edge with a real increment; each deserves its own phase with tests rather than being smuggled into this one. Hashtag Search fails the cost/benefit test on Meta's own rejection evidence. |

### 14.3 What was deliberately NOT added

- Any session-cookie, headless-browser, proxy, or undocumented-endpoint path - for
  any clause of the requirement. The requirement does not override invariant 3;
  it is exactly the pressure invariant 3 exists to withstand.
- Any local username/id mapping table, any identity inference ("this liker
  pattern suggests..."), any zero-fill for unobserved counts.
- Recursive crawl scaffolding ("crawl the follow graph later") - the input does
  not exist lawfully, so the scaffolding would be a promise the product cannot
  keep.

### Verification for Phase E

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — clean across all 5 workspace packages (2026-10-15) |
| Tests | `pnpm test` — 56 files, 405 passed, 1 skipped, 0 failed; new coverage: `graph-provider.test.ts` (discovery on/off, unreachable classes, crafted-username refusal, 403 vs 400), `fixture-provider.test.ts` (discovery file, undeclared file, own-target refusal), `import-provider.test.ts` (refusal names the lawful route), `operations.test.ts` (lookup routes to discovery as a probe), `activity-relationships.test.ts` (comment signal counts, owner's own comments excluded) |
| End-to-end (fixture) | `igtrack lookup dune.harbor` → `route discovery`, AVAILABLE, synthetic profile + 2 bounded media rows, note "nothing was persisted"; `igtrack lookup nobody.at.all` → `ACCOUNT_NOT_FOUND` naming the set's only discovery entry; `igtrack relationships target_a` → new `comments` column, @noah.frames 2 / @mira.lens 1 with scores 40/30 |
| Capability registry + docs | `OTHER_ACCOUNT_PUBLIC` added; `pnpm docs:capabilities` regenerated `docs/CAPABILITIES.md` (15 of 20 obtainable); matrix test green |
| Config surface | `igtrack config` lists `IGTRACK_GRAPH_BUSINESS_DISCOVERY` as presence only; `.env.example` documents the opt-in |

Not claimed in this phase: no live Graph credential exists in this environment,
so Business Discovery is `NOT_VERIFIED` live; the request shape is docs-pinned
against Meta's Business Discovery references (both updated 2026-08-12). The
media preview is bounded (12) because paging does not exist on this edge — it
is a preview, said as such in the note, never "the account's posts".

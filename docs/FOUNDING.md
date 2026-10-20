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

**Correction (2026-10-16):** the counts in the table above record this first
pass. As of this date the agent surface has grown to 19 MCP tools and 19 CLI
commands; `apps/cli/test/mcp.test.ts` pins the full tool list, so the current
number is machine-checked rather than prose.

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
  *(Correction 2026-10-16: today the surface is 19 CLI commands and 19 MCP
  tools; the 13/15 figures are the third-founding state.)*
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

---

## 15. The fifth founding — the public-account dossier, executed where lawful

**Date:** 2026-10-15 · **Status:** adopted (Phase F built; refusals restated)

The founder restated the requirement as a full mission: enter **any public
account's** username or user id and systematically collect, analyse, organise and
**track** its publicly accessible information, its interactions across other
public accounts, its followers/following by name, its tags, recaps and highlights
"even if hidden", the likes and comments it left elsewhere, who followed and
unfollowed it since the last audit, "closest contacts" ranked through the whole
follow graph **recursively**, plus historical audits, change detection, and
consistent account identification.

§14 recorded that requirement and mapped it clause by clause, and Phase E built
its lawful core (the Business Discovery probe). This section answers the *mission
as given* — including the parts §14 refused — with one change of substance:

> **The lawful cross-account route stops being a probe and becomes a record.**
> §14.1 A1's answer was "another account's public data has exactly one lawful
> route, and we render it without persisting". That made cross-account
> *tracking* (the mission's §3 and §4) impossible by construction: no
> persistence, no history, no diff. D42's probe was the right first step and the
> wrong final shape. Phase F records what the edge returns, with the same
> evidence discipline as everything else.

### 15.1 What this phase changes, and what it does not

**Changed (D47–D52):**

1. A target can be **observed** (`observation_mode = DISCOVERY`) instead of owned
   (`OWNED`). An observed target is a public professional account the operator
   points at explicitly; it is scanned by the documented Business Discovery edge
   on a cadence, and its profile and bounded recent media are recorded as
   observations with evidence.
2. Those observations are **diffable**: profile field changes over time become
   `profile_changes` rows, and media carries both its **published timestamp**
   (provider) and its **first-observed timestamp** (ours), so "newly discovered"
   can never be printed as "newly created".
3. `igtrack dossier <username>` answers the mission's read question for one
   account: identity and how it was identified, observed profile history, media
   with both timestamps, follow history when the account is owned, relationship
   ranks when the account is owned, **per-capability coverage** (observed /
   unavailable-with-reason / never attempted), and the registry's refusals for
   this account.
4. `targets add <username> --observed` refuses to create the target unless the
   discovery route answers *now*: an unreachable class (consumer, private,
   age-gated, nonexistent) and a switched-off route are both refused with the
   reason, because a target whose every scan is guaranteed to be a no-op is the
   "misconfiguration looks like no data" failure invariant 7 forbids.
5. Account identification prefers the **stable platform identifier**: when the
   provider supplies an `igId`, an existing row is matched by id first, so a
   username change updates the account instead of forking its history into a new
   row. The id remains an *output*, never a lookup key (D44 stands).

**Not changed — the refusals stand, unaltered:**

| # | Refused | Why (unchanged) |
|---|---|---|
| A4 | Highlights, story/highlight tags of others, "hidden" anything | No highlights edge exists (IG User reference, 2026-04-22); archived story content is not enumerable; "hidden" means the owner's session cookie, which invariant 3 forbids |
| A5 | All comments another account left on others' posts | No such edge. The comment edge reads comments on media you own or manage; the discovery media objects cannot be navigated to a comments edge (insufficient permissions, documented) |
| A6 | All likes another account made | No liker feed exists. `like_count` is a number; *who* is never enumerated |
| A7 | Repost **identities** | No repost object or reshare edge. `reposts_count` is a scalar on media you can read, and remains unrequested until a live check verifies it under this integration's credentials |
| A9 | Rosters of other accounts (followers/following by name) | No roster edge exists for any live interface. For a `DISCOVERY` account only `followers_count`/`follows_count` are observable — never the lists |
| A10 | Recursive traversal of the follow graph | The input does not exist lawfully. Phase F records observations of accounts the **operator named**, one by one; it never walks from one account to another on its own. No traversal queue, no "expand neighbours", no depth parameter — there is nothing to traverse |

Invariant 3 is untouched: the new route is the same documented edge D42 adopted,
reached with the same Facebook-Login permission set, off unless
`IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` is set. Nothing in Phase F reads an
undocumented endpoint, a session cookie, or another account's non-public data.

### 15.2 Decision log (Phase F)

| # | Decision | Rationale |
|---|---|---|
| D47 | **A target carries an observation mode: `OWNED` (default) or `DISCOVERY`** (migration 0016). Owned-only scan kinds are refused for a `DISCOVERY` target and `DISCOVERY_SCAN` is refused for an `OWNED` one, at both the scheduler and the executor. | The mission's §3/§4 need cross-account tracking, and the queue, scheduler, checkpoints, evidence ledger and activity feed already exist. A mode column reuses all of it; a parallel subsystem would have duplicated every invariant. Refusing the wrong kind for the wrong mode keeps "scan that cannot succeed" out of the queue instead of recording it as a repeated provider failure. |
| D48 | **`DISCOVERY_SCAN` records the profile as a COMPLETE snapshot and the media preview as a bounded one, and the scan always reports `COMPLETED_PARTIAL`.** The bound (12) is written into the evidence metadata of every media row, not just into a note. | Two different completeness facts in one response: the profile read finished (so it is a lawful diff baseline), the media listing is a window that paging cannot extend (so it can never be diffed or described as "the account's posts"). Putting the bound in the evidence row means the claim itself carries its coverage limit — durable, and readable years later. |
| D49 | **`targets add --observed` probes the route once and refuses on UNAVAILABLE**, naming the platform's reason or the unlock flag. | Invariant 7, applied to the new mode: an unreachable account is a fact the operator should learn at add time, not after a week of scans that can never produce data. The probe also answers §6's "handles unavailable, deleted, renamed, private accounts appropriately" at the moment of identification. |
| D50 | **`igtrack dossier <username>` is the reporting surface for one account**, ownership-scoped, read-only, and composed from stored observations plus the capability registry — not from a new table. It reports, per capability, `OBSERVED` (with row counts), `UNAVAILABLE` (with the registered reason) or `NOT_OBSERVED`, and lists the platform-level refusals that apply. | Mission §3/§9.9 require "which accounts and data categories have been investigated, which remain incomplete, and why". Deriving it from observations + registry means coverage cannot drift from what was actually stored, and the refusals are the registry's own words, not a second copy. |
| D51 | **Relationship ranks gain recency, per-account evidence rows, and an explicit method block**; counts are de-duplicated at the source (`count(DISTINCT story_db_id)`, unique comment ids, unique delta keys) so the same interaction cannot be counted twice through two paths. | Mission §5 asks for frequency, recency, evidence and explanation. The score stays a sum of observed counts — recency is *reported* (`lastSignalAt`, 30-day count), never folded into the score as an invented decay, because a decay constant is a guess about people dressed as arithmetic. |
| D52 | **Account identity is matched by platform id first** when the provider supplies one; a username change then updates the row instead of creating a second account, and the rename surfaces as a `username` profile change. | Mission §6 wants the same account recognized across audits and username changes handled "when reliable identifiers make this possible". They do make it possible — the id is returned by both the owned profile and the discovery response — so this is the one place the mission's ask was both lawful and unfinished. The id is still never a lookup key (D44). |
| D53 | **`lookup` stays a stateless probe; `targets add --observed` + `dossier` are the recording path.** | Two different intents: "tell me about this account right now" must leave no residue in a tool an agent calls freely; "watch this account" is an explicit act with storage consequences. Conflating them would make every exploratory lookup write third-party data. |

### 15.3 What was deliberately NOT added

- **No traversal machinery.** No neighbour expansion, no depth setting, no
  discovered-account queue, no "crawl from a mention". The refusal in §14.1 A10
  is structural: the follow graph of a third-party account is not observable, so
  a depth parameter would be a knob wired to nothing.
- **No new provider method.** The mission's asks that have a lawful route are
  served by `discoverAccount` (Phase E) and the existing owned-account methods.
  The own-account `tags` edge and the `mentions` edge remain recorded unlocks
  (D46) — they are the next lawful increment, not smuggled into this one.
- **No identity inference, no local id→username mapping, no "similar-looking
  content is a repost" classifier.** Same refusals as §14.3.
- **No demo/dashboard surface.** The CLI and MCP are the product (D13).

### 15.4 Prioritized plan and where each item landed

| Priority | Item | Status in Phase F |
|---|---|---|
| P0 | Recorded cross-account observations (observation mode, `DISCOVERY_SCAN`, evidence, bounded-preview metadata) | **Built** (D47, D48) |
| P0 | Dossier reporting with per-capability coverage and registry refusals | **Built** (D50) |
| P0 | Historical comparison for observed accounts (profile diffs; published-vs-first-observed for media) | **Built** (D48, reuses Phase A's COMPLETE-only diff gate) |
| P1 | Identification by stable id + username-change handling | **Built** (D52) |
| P1 | Relationship ranking transparency (recency, evidence rows, method block, de-duplication) | **Built** (D51) |
| P2 | Own-account `tags` / `mentions` edges (A2, A5 sliver) | **Recorded, not built** (D46) — next lawful increment |
| P2 | `reposts_count` on owned media (A7 partial) | **Recorded, not built** (D46) — needs a live credential check first, because an unknown field name fails the whole media call |
| — | Likers, third-party comment/like feeds, repost identities, other-account rosters, highlights, recursive traversal | **Refused** (§14.1, restated in §15.1) |

### 15.5 Verification for Phase F

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — clean across the 5 workspace packages (2026-10-15) |
| Tests | `pnpm test` — **425 passed / 1 skipped, 58 files** (baseline before Phase F: 405/56). New/extended coverage: `workers/monitoring/test/discovery-scan.test.ts` (10 cases: COMPLETE profile snapshot, bounded media with the ceiling in evidence metadata, published-vs-first-observed, re-run de-duplication, UNAVAILABLE → reason in `source_health`, provider without the route, wrong-mode refusal non-retryable, enqueue guard, worker dispatch → `COMPLETED_PARTIAL`, failing route → retryable `JobExecutionError`, dossier read-back); `packages/database/test/dossier.test.ts` (4 cases: owner scoping, stored-count read-back, unobserved target, route-unavailability only from observing sources); `activity-relationships.test.ts` (recency window beside counts, evidence rows, deterministic order); `apps/cli/test/operations.test.ts` (`--observed` refusal by owned account / unknown username / route-less provider, full record → scan → dossier flow); `scan-prefs.test.ts` (mode routing); `mcp.test.ts` (tool surface) |
| End-to-end (fixture) | Run against the live database (2026-10-15): `igtrack targets add dune.harbor --observed` (probe AVAILABLE, DISCOVERY target created) → `igtrack scans run --kinds DISCOVERY_SCAN --target dune.harbor` (1 job enqueued; the 6 owned kinds skipped with the mode reason) → `igtrack work` (job `succeeded`, outcome `COMPLETED_PARTIAL`) → `igtrack dossier dune.harbor` (profile snapshot COMPLETE with 18420 followers; 2 media rows with `publishedAt` 2026-08-21/26 vs `firstObservedAt` 2026-08-27; coverage states per capability; bounded-preview note; route unavailability with reasons) |
| Capability registry | `OTHER_ACCOUNT_PUBLIC` now persists (`profileSnapshots`, `posts`, `evidence`) and describes both intents; `pnpm docs:capabilities` regenerated; matrix drift test green |

Not claimed: no live Graph credential exists in this environment, so the
`DISCOVERY_SCAN` request shape is docs-pinned and `NOT_VERIFIED` live, exactly
like Phase E. The media bound (12) is Meta's documented behavior for this edge,
not a choice this project made.

---

## 16. Phase G — media change detection (post edits and disappearances)

**Date:** 2026-10-16 · **Status:** adopted (Phase G built; claims only where a COMPLETE listing exists)

The mission recorded in §15 asks, in its historical-audit clause, to "maintain
persistent audit history and compare each new audit against previous results"
and to identify and report "new, edited, deleted, or otherwise changed posts
and observable content". New posts were already covered (the posts row plus the
`POST_PUBLISHED` activity item). **Edited and disappeared posts were not**: the
posts table is append-only and first-observation-wins (`recordPost`
deduplicates and never updates), and no surface recorded what a media listing
contained at each scan, so a caption change or a post leaving the listing was
undetectable. This phase closes that gap for the one target class where it is
lawful to close it — targets the operator owns, read through the owned-account
media edge, with the full listing paginated to completion.

**Changed:**

1. An owned target's `POSTS_SCAN` records, per stored post row, a **presence
   state** (`post_presence`): first observed, last logical scan that observed
   it, the caption as last read, and `PRESENT`/`ABSENT`.
2. Two new append-only events land in `post_changes`: `CAPTION_EDITED` (with
   the old and new caption text) and `NO_LONGER_OBSERVED` (with the last-read
   caption as the old value). Both carry the **logical scan instant** as
   `detected_at`, a confidence, and a linked `posts_listing` evidence row.
3. The activity feed carries the two event types (`POST_EDITED`,
   `POST_REMOVED`); the dossier counts `postChanges`; the `POSTS` capability
   entry names the new persistence.

**Not changed — the refusals stand, unaltered:** no session cookie, no
undocumented endpoint, no traversal. DISCOVERY targets gain nothing here
(D59): their media edge is a bounded, non-pageable preview, and a fixed window
cannot distinguish "no longer observable" from "fell out of the window".

### 16.1 Decision log (Phase G)

| # | Decision | Rationale |
|---|---|---|
| D54 | **A presence state, not per-scan media snapshots.** `post_presence` holds one mutable row per stored post (`state`, `first_seen_at`, `last_scan_at`, `last_caption`); `post_changes` holds append-only events deduplicated by `(post, change, detected_at)`, where `detected_at` is the logical scan instant (`job.startedAt`, stable across retries and lease reclaims). | The mission asks to preserve what is *required* to identify changes. A full membership snapshot per scan would cost O(posts × scans) to carry a fact the change rows already state durably. Follow rosters keep per-scan snapshots because membership there is the claim; for media, the post row itself is the membership record. |
| D55 | **Disappearance is claimed only from a COMPLETE media listing, and it is never called "deleted".** The media listing's completeness is tracked **separately** from comment/children truncation: a truncated comment fetch neither suppresses nor creates a media claim. The event reads `NO_LONGER_OBSERVED` — "absent from a complete media listing at T". | Invariant 4/D9 applied to media: truncation may never fabricate a loss, and the claim states exactly what was observed. A post can leave a listing for reasons we did not verify (archival, gating, platform ordering/limits) — a deletion claim would assert more than we know. |
| D56 | **Caption differences are recorded from what was read, not gated on listing completeness.** An edit claim asserts "the caption we read at T differs from the caption we last read"; it asserts nothing about absence, so the COMPLETE gate (which exists for absence) does not apply. A caption field the provider omits is "not exposed in this observation" — never an edit to empty, and it never clears the stored value. | Presence claims and absence claims have different epistemics (same distinction as §15.1's published-vs-first-observed). Only the absence half can be fabricated by truncation. |
| D57 | **Reappearance is a state return, not an event.** A post observed again after absence flips back to `PRESENT` with no row emitted; a *later* disappearance is a new event under a new `detected_at`. | The mission asks for new/edited/deleted; "returned" would be a fourth event type with no ask behind it. The state itself answers the read question ("is it in the listing now"), and cycles still produce an event per genuine disappearance. |
| D58 | **Change rows link one `posts_listing` evidence row per logical scan** (observation id stable across retries; created lazily on the first change, never for scans with no changes). No raw hash rides on it: the raw representation arrives per page and is not one artifact, and per invariant 5 an unset raw hash is the honest state. New posts keep their per-page raw hash on the post's own evidence. | The evidence obligation (invariant 5) is met without fabricating a payload identity that does not exist. |
| D59 | **Owned-only, enforced at execution.** `POSTS_SCAN` writes presence and changes only when the target's `observation_mode` is `OWNED` (wrong-mode jobs are already refused at enqueue; the executor gate makes the new claim unreachable even if a job reaches it another way). | D48's bound made structural: no code path may produce a change claim from a bounded preview window. |

### 16.2 What was deliberately NOT added

- Any phrase, column, or summary that says "deleted" / "removed by the owner" —
  the graph does not tell us that, so neither does the product (D55).
- An "edited at" timestamp — the observation bounds the edit interval
  (`detected_at` is when *we* first saw the difference), nothing narrower is
  knowable.
- A `POST_RETURNED`/`POST_REOBSERVED` activity type (D57), and per-scan media
  snapshot tables (D54).
- Any change machinery for DISCOVERY targets (D59); any diffing of the bounded
  preview as if it were a listing.
- The `tags`/`mentions` edges stay recorded unlocks (D46) — this phase closes
  the mission's change-detection clause; they remain the next lawful increment.

### 16.3 Verification for Phase G

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — all five workspaces (`core`, `ingestion`, `database`, `monitoring`, `cli`) `tsc --noEmit` clean, exit 0 |
| Tests | `pnpm test` — 59 files, 432 passed, 1 skipped (the Postgres-down suite skips loudly), exit 0. `workers/monitoring/test/posts-changes.test.ts` pins G1–G7: silent first scan, one `CAPTION_EDITED` per difference with old/new + listing evidence, absence once per genuine disappearance with silent return and a fresh `detected_at` on re-disappearance, PARTIAL suppression of absence alongside edit recording, first-caption/omitted-caption rules, the DISCOVERY execution gate, and retry idempotence |
| End-to-end (fixture) | `igtrack setup` (migrations 0016+0017 applied) → `scans run` (owned kinds refused for the DISCOVERY target at enqueue) → `work --max 20` (all succeeded) → `dossier dune.harbor` (bounded-preview caveat and published-vs-first-observed rendered) → `activity`. In the live database afterwards: 2 `post_presence` rows `PRESENT` with captions for the owned fixture target, none for the DISCOVERY target, and 0 `post_changes` — a static fixture must and does produce no change claim |
| Capability registry + docs | `pnpm docs:capabilities` regenerated `docs/CAPABILITIES.md` from the registry (POSTS entry now names `postPresence`/`postChanges`); the capability-matrix drift test and the schema-consistency test are green |

Not claimed: caption edits and disappearances are verified against a mutable
provider double and the worker boundary — not live. No Graph credential exists
in this environment, so a real account's edit cycle remains `NOT_VERIFIED`
live, same standing as every other Graph route.

---

## 17. Phase H — the tags edge, the mentioned-comment read, and the repost scalar

**Date:** 2026-10-16 · **Status:** adopted (Phase H built; tag claims only where the listing says what it read)

§16 closed the mission's change-detection clause and named the `tags`/`mentions`
edges as the next lawful increment (D46, restated in §16.2). This phase builds
that increment as far as the platform actually offers a route, and records the
places where it does not: the tags edge is a listing the owned account may page,
`mentioned_comment` is a single-item read with no listing edge at all, and
`reposts_count` is a scalar with no relation behind it.

**Changed:**

1. Owned-target `TAGS_SCAN` (24h cadence, `IGTRACK_SCAN_TAGS_MS`): pages the
   documented IG User `tags` edge (cursor paging, 25-page cap, lease renewal
   between pages), stores append-only `tagged_media` rows unique per
   `(account, media, source)` with first-observation-wins, and records one
   scan-keyed `tagged_media_listing` evidence row per read carrying that
   listing's completeness (COMPLETE/PARTIAL + pages). A capped or truncated
   read completes PARTIAL and says so where the rows live.
2. `igtrack tags` (CLI) and `igtrack_tags` (MCP): read back the rows with the
   owning account, the provider's published time and our first observation kept
   distinct, the shared evidence link, and the latest listing's completeness.
3. `igtrack mention <id> [--account]` (CLI) and `igtrack_mention_read` (MCP):
   on-demand read of one mentioned comment; persists nothing.
4. `reposts_count` parity: parsed when any provider returns it, stored on the
   new nullable `posts.reposts_count` under the same first-observation
   semantics as every other count; the dossier gains a REPOSTS coverage row
   that counts posts which actually carried the value (never zero-filled).
5. Registry: REPOSTS becomes the observable scalar; RESHARES is added as the
   structurally absent relation, so the two repost facts cannot be read as one
   claim.
6. The Graph request set is unchanged: `reposts_count` stays OUT of
   `GRAPH_MEDIA_FIELDS` until the live one-node probe in
   `scripts/verify-graph-provider.ts` returns; an unknown field name fails the
   whole listing call, so a speculative request is how a working scan becomes a
   broken one.

### 17.1 Decision log (Phase H)

| # | Decision | Rationale |
|---|---|---|
| D60 | **Tagged media are first-observation references.** `tagged_media` is append-only, unique per `(account, media, source)`; a re-scan never rewrites a stored row, a row absent from a later listing is never "removed", and the rows are never diffed against `posts`. Each row carries the evidence of the listing that observed it. | Another account's edit/delete history is not our observation stream; the only observable facts are "this media listed this account at T" and what that listing returned. |
| D61 | **One listing evidence row per scan carries the listing's completeness**, and a capped/truncated read completes PARTIAL. No surface may present a bounded or truncated read as "all the tags". | D48's rule applied where the claim lives: the row count alone cannot say whether the platform returned everything. |
| D62 | **`TAGS_SCAN` is owned-only, guarded at enqueue AND at execution** (schedulable kind list + `OWNED_ONLY_KINDS` + executor gate). | D47/D59 extended: a job that arrives another way still cannot produce a claim for a target class it does not describe. |
| D63 | **Mentions: an on-demand stateless read, never a listing.** `mentioned_comment` is keyed by webhook-supplied comment ids; the read persists nothing (mirrors the D53 lookup), and with more than one owned target it refuses to guess which account a notification belongs to (`--account` required). The MENTIONED_COMMENTS capability reports UNAVAILABLE with the webhook note until a notification feed exists; mentions are never inferred locally. | There is no listing edge to page; inventing one — or backfilling ids from crawled comments — would be traversal by another name (§14.1 A10). |
| D64 | **`reposts_count` parses when present and is requested only after live verification.** Nullable column, first-observation semantics, coverage row states the unlock. The field is not added to `GRAPH_MEDIA_FIELDS` on documentation alone. | A wrong field name fails the whole listing; docs-pinning a request would trade a working scan for a speculative one. Absence stays absent — never zero-filled. |
| D65 | **REPOSTS is the scalar; RESHARES is the relation.** The registry entry for the count is obtainable (`getPublicPosts` supplies it when the platform does); naming repost actors gets its own entry marked structurally absent. | One entry claiming both would either overclaim the relation or hide the datum; the split keeps each claim exactly as strong as its evidence (repost identities stay refused, §14). |
| D66 | **Relationship ranking does not consume tags, mentions, or reposts yet.** The ranking inputs remain story mentions, comment authorship on owned media, and follow deltas (§15.1). Any future inclusion needs stored rows behind it and a dated entry here. | Ranking is a claim about association; a new input without a filed decision would be the quiet scope creep this document exists to prevent. |

### 17.2 What was deliberately NOT added

- Any removal claim for tagged media (D60); any tag diffing against posts or
  against earlier tag listings.
- A mentions listing, local mention inference, or comment-crawl backfill (D63).
- Repost relations, repost-actor identities, or post classification from
  counts (D64/D65).
- Relationship-ranking weights over the new rows (D66).
- Recursive traversal of tagging accounts: a tag row names a media owner; it
  never creates a target (§14.1 A10).

### 17.3 Verification for Phase H

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — all five workspaces (`core`, `ingestion`, `database`, `monitoring`, `cli`) `tsc --noEmit` clean, exit 0 |
| Tests | `pnpm test` — 60 files, 443 passed, 1 skipped (the Postgres-down suite skips loudly), exit 0. New `workers/monitoring/test/tags-scan.test.ts` (TG1–TG8) pins: append-only rows sharing one listing evidence row, a re-scan never rewriting a stored observation and an absent row never claimed as removed, cursor paging with the top-level `nextCursor` contract, PARTIAL-on-truncation recorded in the listing metadata, UNAVAILABLE storing nothing, a page ERROR throwing retryably without a half listing, capability-off with zero provider calls, and the DISCOVERY execution gate |
| CLI surface | `apps/cli/test/operations.test.ts` pins tags read-back (owner account, published vs first-observed, a null permalink stays null, the ANOTHER-account note), the mention read incl. the multi-owned-target ambiguity refusal, and the dossier rows (TAGS OBSERVED 2, MENTIONED_COMMENTS UNAVAILABLE with its reason, REPOSTS OBSERVED 1, repostsCount 128 / null) |
| End-to-end (fixture) | `targets add aurora.wilde` → `scans run --kind TAGS_SCAN` → `work` (COMPLETED) → `tags aurora.wilde` (listing COMPLETE, 1 page, two rows sharing one evidence id) → `mention mentioned-comment-1 --account aurora.wilde` (AVAILABLE, likeCount 12, media other-media-77) → `mention no-such-id` (UNAVAILABLE with the fixture's reason); the read persists nothing |
| Capability registry + docs | `pnpm docs:capabilities` regenerated `docs/CAPABILITIES.md` from the registry (REPOSTS/RESHARES split reflected); the capability-matrix drift test and the schema-consistency test are green |
| Docs-pinned requests | `packages/ingestion/src/graph/field-coverage.ts` — tags area: 6 requested fields all present in `GRAPH_TAG_FIELDS`; mentions rows `READ_THROUGH` (requested and delivered to the caller only, never persisted); `media.reposts_count` UNVERIFIED with the one-node probe as the named unlock |

Not claimed: every Graph route in this phase is docs-pinned and
fixture-verified, not live — no Graph credential exists in this environment.
The one-node `reposts_count` probe (`pnpm verify:graph`), and the tags/mentions
reads against a real account, remain `NOT_VERIFIED` live until an operator with
credentials runs them. The mentioned-comment webhook subscription remains the
recorded activation step; until then `MENTIONED_COMMENTS` is UNAVAILABLE by
design.

## 18. Deep account intelligence Phase 1 — the claims ledger, the research report, the planner

Phase 1 of [DEEP-ACCOUNT-INTELLIGENCE.md](DEEP-ACCOUNT-INTELLIGENCE.md) shipped
2026-10-16, together with that document's read-only depth items (themes,
cadence, audience summary, `--since`, `--format md`) and the planner the
mission required. **No platform route was added, no traversal exists, and
`research` makes zero provider or network calls** — it reads stored rows only.

### 18.1 Decision log (Phase 1)

| # | Decision | Rationale |
|---|---|---|
| D67 | **The claims ledger stores what sources state; it never generates, fetches, or infers.** Claims are operator/agent-submitted rows (`source_kind` `OPERATOR` or `WEB`; never `PLATFORM` — platform facts live only in the observation tables). The predicate registry is closed (9 predicates, `packages/core/src/claims.ts`); sensitive person-level predicates (employment, health, religion, politics, sexuality, ethnicity, immigration, criminal/legal, home address, education, family/relationship) are refused at write time with the FOUNDING §14/§18 pointer, even when a source states them. Dedup is a unique index over `(target_id, predicate, value, coalesce(source_url,''))`; a duplicate insert is a typed `CLAIM_DUPLICATE` refusal naming the existing claim, and a re-submission never counts as corroboration. Corroboration and contradiction are derived, never stored: `CONFLICTED` (differing normalized values — both shown, no winner), `CORROBORATED` (same normalized value from ≥2 distinct www-stripped domains), `SINGLE_SOURCE`, `OPERATOR_ASSERTED`; an operator assertion is not a source domain, so it can be corroborated but can never itself corroborate. Retraction sets `status=RETRACTED` + reason and the row stays readable (it loses its relation label); destructive retraction requires `confirm: true`. Review horizon is 180 days on `retrieved_at ?? recorded_at`: the row is flagged `dueForReview`, never hidden, never auto-retracted. Follows, mentions and tags never auto-convert into claims, and a `RELATED_ACCOUNT_ASSERTED` claim never creates a target (A10 stands). | The founder requirement's identity questions are answerable only by citing sources; storing the citation — not a synthesized "profile" — is the line that keeps claims from laundering into platform facts (the §3 legal frame: profiling a third party from Platform Data is outside permitted purposes). |
| D68 | **The research report and the investigation planner are deterministic reads over stored rows — never stored state, never a provider call.** `research` composes labelled sections (platform observations, themes, cadence, audience, claims, contradictions, changes, leads, connections, coverage); every empty or inapplicable section carries a non-empty reason, derived figures state their corpus size, the DISCOVERY media preview carries the D48 bounded caveat verbatim, and claims are never blended into platform counts. Audience, changes and connections are OWNED-only: on a DISCOVERY target they are `UNAVAILABLE` with the platform-absence reason. `plan` recomputes every step status from jobs, targets and claims on each call (DONE/PENDING/READY/STALE/BLOCKED/NOT_APPLICABLE + one `nextAction`); there is no plan record and no cursor, so an interrupted investigation resumes by asking again. D47 refusals render `NOT_APPLICABLE` (never queued), an unusable provider renders `BLOCKED` with its reason, an unknown goal is a `USAGE` error, and `--since` filters the claims section only, saying so and counting what it omitted. | A report whose numbers move between identical calls is indistinguishable from one that guesses; and a plan that persists its own status drifts from the rows it was derived from. Both surfaces must answer the same question the same way every time, or their state labels stop being evidence. |
| D69 | **The engine acquires, the registry declares, and the bounds live in code.** `igtrack research <target> --run --question "..."` (MCP `igtrack_research_run`) is the product's first autonomous acquisition: it plans at most `RESEARCH_MAX_SOURCES=10` public documents at `RESEARCH_MAX_DEPTH=1` — operator `--url` pages first, then search-provider candidates (no provider configured means `UNAVAILABLE` with the exact reason, never invented sources), then the source URLs of prior claims; deduplicated, sliced. Every URL and every redirect hop passes the static gate: `http(s)` on port 80/443 only, no embedded credentials, Instagram/localhost/metadata hosts refused by policy (platform data belongs to the Graph API adapters, §14/§19), DNS answers checked against private/loopback/link-local/metadata ranges; robots.txt is respected, content types are allowlisted, the body is streamed to a 512KB byte cap under a 10s wall-clock timeout. Extraction reads four fixed field families (JSON-LD, meta tags, mailto, public profile links) — never page prose, so a page cannot prompt-inject its way into a claim; retrieved text is data, never instructions. Each candidate passes the same closed predicate registry as operator claims before storage; duplicates are counted, never re-stored; a document fetched within 24h is `REUSED` unless `--refresh`. Every per-document outcome — fetched, reused, failed, refused — is recorded on the run, and a `PARTIAL` run never fabricates success. Runs are refused for `DISCOVERY` targets at enqueue and at execute (D47 stands: observation is operator-directed, never traversal-derived). Bounds are compile-time constants pinned by `packages/core/test/research.test.ts`, not environment variables: a deployment choice could not widen the product's safety envelope. The capability registry gains `WEB_RESEARCH` with a new `engineSupplied` flag — a third honest supply mode, distinct from platform methods and from operator-typed rows — and the dossier coverage row reports it `UNAVAILABLE` with the D47 reason on a DISCOVERY target. | The founder requirement is that the product itself plans, fetches, extracts, validates and stores source-backed evidence — with bounds enforced in code and verified by tests, not merely documented. The registry is invariant 6's single source of truth, so the new capability must be declared there; and "who supplies this row" has exactly three honest answers — the platform, the operator, or the bounded engine — so the matrix renders them distinctly rather than conflating an engine fetch with a human submission. |

### 18.2 What was deliberately NOT added

- Unbounded fetching, background crawling, or a queue kind for research: D69's
  acquisition run is foreground, operator-initiated, bounded (10 sources,
  depth 1, 512KB, 10s, 3 redirects) and refused for DISCOVERY targets. The
  report and the planner remain deterministic reads over stored rows (D68) —
  a run stores, then the report reads what was stored.
- An in-process LLM, claim generation, or web crawling: the operator's agent
  researches outside IGTrack and submits findings (D67).
- Numeric confidence scores; the repo's "count of stored rows, not an inferred
  affinity" precedent holds.
- Claim extraction from opted-in discovery data (Platform Data is never input
  to the claims layer).
- Traversal: a `RELATED_ACCOUNT_ASSERTED` claim cites a source; it never
  creates, expands, or queues a target (FOUNDING §14.1 A10).
- Hard deletion of claims (retraction only; rows cascade with the target).
- Silent expiry: the 180-day horizon is a display flag, nothing is hidden.
- A persisted plan, plan history, or resumable cursor (D68).

### 18.3 Verification for Phase 1

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — all five workspaces clean, exit 0 |
| Tests | `pnpm test` — `61 → 67` files; `448 → 547` passed, 1 skipped (loud Postgres-down guard), exit 0; consecutive green runs on 2026-10-17 against the shared test database after an orphaned concurrent vitest (left by a pipeline-killed run) was identified and gone (VERIFICATION.md §10.1). New: `packages/core/test/claims.test.ts` (28 checks), `packages/database/test/claims.test.ts` (6), `apps/cli/test/acceptance.test.ts` (A01–A26 scenarios), plus claims/research/plan assertions inside `apps/cli/test/operations.test.ts` and the confirm-gate test in `apps/cli/test/mcp.test.ts`. 2026-10-17 evening re-verification (completion mission; tree now 68 files after an unrelated concurrent workstream added a test file): claims-focused suites 48/48, operations + research-benchmark + acceptance 83/83 on an isolated test database (`IGTRACK_TEST_DATABASE_URL`), every hardening suite green, and the 4 load-induced hook timeouts of a contended full run re-passed in isolation (27/27) — VERIFICATION.md §11 |
| MCP + CLI surface | `EXPECTED_TOOLS` pinned at 24 (adds `igtrack_plan`, `igtrack_research`, `igtrack_claims_list`, `igtrack_claim_add`, `igtrack_claim_retract`); CLI adds `claims add|list|retract`, `research <target> [--format md] [--since]`, `plan <target> [--goal]`; capability registry `ACCOUNT_RESEARCH` is available via operator submissions with zero provider methods, and `pnpm docs:capabilities` regenerated `docs/CAPABILITIES.md` (19 of 24 obtainable) |
| End-to-end (fixture, scratch DB) | `claims list` renders groups with CORROBORATED/CONFLICTED/OPERATOR_ASSERTED/stale flags; a refused predicate exits 2 naming FOUNDING; a duplicate names the existing claim; retraction without `--yes` is refused; `research` renders all sections with `ACCOUNT_RESEARCH OBSERVED`; `plan` shows `NOT_APPLICABLE` for the D47-refused kind and `READY`/`DONE` elsewhere; `--goal connections` filters; `--format md` renders |
| Determinism | two consecutive `research` calls over unchanged rows are byte-identical modulo `computedAt` (A20); two `plan` calls produce identical step statuses (A23) |
| Performance (synthetic fixture workload, local Postgres, 64 claims) | `scripts/bench-research.ts`, two runs: 2026-10-16 — claims list p50 6.7 ms / p95 19.8 ms, research p50 42.5 ms / p95 60.0 ms, plan p50 7.0 ms / p95 9.5 ms; 2026-10-17 re-run — claims p95 37.7 ms, research p50 133.2 ms / p95 238.7 ms, plan p95 44.5 ms; 2026-10-17 evening (completion mission, load-affected host) — claims p50 26.6 / p95 41.1 ms, research p50 198.7 / p95 411.2 ms, plan p50 33.8 / p95 60.0 ms. All far below the pre-established 1500 ms research threshold (the spread is host load, not a code change); CLI process boot (tsx, dev-mode, `help`) p50 ≈ 3.0–4.3 s, paid once per MCP session, not per tool call |

Not claimed: no live account was observed by any of this; every row above comes
from the synthetic fixture provider or from operator-submitted claims, and the
acceptance suite pins `synthetic: true` on its envelope (A01) so no reading of
it can be mistaken for live verification.

---

## 19. The operator-directed investigation of an arbitrary username

**Date:** 2026-10-18 · **Status:** adopted (Phase 2 of the deep-intelligence
requirement; the §18 refusals are unchanged)

The founder restated the product's CENTRAL use case, and this time the subject
of the question is the point: *an unknown username supplied by an operator*,
not an account the operator owns, and not one they have registered. The
requirement is to enter a handle and receive the most comprehensive,
evidence-backed, LAWFUL report this product can produce from supported
Instagram sources and independently accessible public-web sources — and to
state, for anything it cannot produce, exactly why and what the lawful
alternative is.

§14/§15 answered the platform side of that question (Business Discovery, and
the refusals around it). §18 answered the citation side (the claims ledger,
then the acquisition engine). What neither phase could do is the FIRST thing
an investigation of a stranger's handle needs: read what the public web states
about the handle **without requiring that the handle first become a tracked,
owned, or observed target**. Before this phase, the engine could only research
a target it already held — which meant the workflow began in the wrong place.

### 19.1 What this phase adds

`igtrack audit <username> [--url URL[,URL…]] [--max-sources N]` gains a fifth
phase — `opAuditWebProbe` (`apps/cli/src/tools.ts`), `igtrack_audit`'s optional
`urls`/`maxSources` inputs — and the report gains a `web` section plus a
`summary` that names the six evidence classes separately.

### 19.2 Decision log (Phase 2)

| # | Decision | Rationale |
|---|---|---|
| D70 | **A handle the operator typed may be researched read-only, bounded, and unstored — and the six evidence classes never blur.** The web phase plans at most `AUDIT_WEB_MAX_SOURCES=5` documents (hard ceiling `RESEARCH_MAX_SOURCES=10`), depth 1: operator `--url` pages first, then candidates from a configured search provider; a phase with no source reports `NOT_ATTEMPTED` with the exact reason and the exact remedy, and never invents candidates. Every URL and redirect hop passes the same SSRF gate, DNS check, robots check, content-type allowlist, byte cap (512KB) and timeout (10s) as an acquisition run — so an `instagram.com`-family URL is `BLOCKED_BY_POLICY` here too: the platform's own website is not a "public web source" for this product, and platform data still has exactly one lawful route (the Graph adapters, §14). Extraction reads the same four fixed field families, never prose; every candidate passes the same closed predicate registry (`classifyClaimPredicate` → `validateClaimValue` → `validateClaimExcerpt`), so a sensitive predicate is refused here exactly as it is in the ledger. Each accepted fact is labelled `PUBLIC_WEB_DOCUMENTED` and carries its source URL, page title, exact field, extraction method, retrieval time and the document's SHA-256 — a **third-party statement about a handle**, never an observation of an account. Corroboration and contradiction are DERIVED with the same `deriveClaimRelation` the ledger uses: ≥2 distinct domains stating one normalized value is `CORROBORATED`; differing values are `CONFLICTED` and show **both** sides with their sources — no winner, no numeric confidence, ever. The phase takes no database handle, so it cannot store, register, queue or mutate: "this audit wrote nothing" is structural, not a convention. The `summary` block keeps six evidence classes apart — platform observation, stored record, public-web statement, stored third-party claim, operator evidence, **inference (always `NONE`)** — because the failure mode this product exists to prevent is a report in which a page's claim reads like a platform fact. An unknown `IGTRACK_RESEARCH_SEARCH_PROVIDER` is a `CONFIGURATION_ERROR` (exit 3), never an empty web section — invariant 7 holds on this surface too. | The founder's question is about a stranger's handle, so the workflow may not hold ownership (or even registration) as a precondition for reading public pages; but "unregistered" must not become "unbounded, unstored-by-accident, or unlabelled". The bounds, the gate and the registry already existed (D69) — this phase reuses them and adds exactly one thing: it does not require a target, and it does not create one. |
| D71 | **Sources were audited before being built, and the refusals are dated evidence, not vibes.** `docs/verification/SOURCE-AUDIT.md` (2026-10-18) records the lawful-source landscape with citations: Business Discovery remains the only lawful arbitrary-username platform route (professional accounts only; consumer, private and age-gated accounts unreachable); Instagram **oEmbed** is now tokenless but its terms prohibit analytics/derivation, so it is **refused on contract**, not on capability; the **Basic Display API** was retired 2024-12-04; Google Programmable Search is closed to new customers and Bing's Search API is retired, leaving the keyed Brave API as the one healthy official search route (invariant 10: opt-in, never the default path); and every popular Instagram OSINT library (instaloader, instagrapi, instagram-private-api) plus most Instagram MCP servers obtain their data through session auth or undocumented endpoints, with a public litigation record behind that risk class. | A refusal the next agent can check beats a refusal they must trust. It also fixes the direction of travel for future source work: the answer to "can we get more?" is a dated citation, and the answer to "why not scrape it?" is already written down (invariant 3, §14.3). |
| D72 | **Quoted evidence is decoded, prose is never mined, and a contradiction needs two sources.** Found by the first LIVE probe (2026-10-18), not by any fixture, and fixed where they live: (a) the extractor's `meta description` "specialization phrase" miner produced the value `that&` from a real marketing sentence — deleted outright, because phrase-mining prose is prose interpretation (the module's own contract forbids it) and `INDUSTRY_OR_FIELD` already arrives from JSON-LD where the page states it as a field; (b) HTML entities survived into stored values and quoted excerpts, so a legal name could be permanently stored as `Smith &amp; Wesson` — the extractor now decodes the seven entities HTML actually uses in text (`amp lt gt quot #39 #x27 nbsp`) at both gates (`textOf` for meta/anchor text, `asString` for JSON-LD strings), deliberately not a general entity decoder since this file parses with regexes on purpose; (c) one page asserting three different social links was labelled `CONFLICTED`, which would have told an operator that independent sources disagree when none do — the web phase now downgrades a same-domain disagreement to `SINGLE_SOURCE` (the differing values still show, with their citations; only the label stops lying). All three are pinned: `research-extract.test.ts` (16 checks) and the audit matrix's corroboration scenario. | A fixture page is written by the people who know what the extractor does; a live page is written by everyone else. This is the concrete argument for probing real pages early: three of the phase's honesty defects existed for as long as the extractor did and were invisible until a real site was fetched. It also fixes a general rule — **a conflict is a relation between SOURCES, not between VALUES**, and the same-domain case must never borrow the word "contradiction". |
| D73 | **A default path that needs an account is not a default path; and a search that ran is never confused with a search that found nothing.** Until now, a fresh installation had no search provider, so the public-web phase answered `NOT_ATTEMPTED` for every handle — the exact dead end D70's remedies promised not to be. Provider resolution is now: unset (code default) stays `none`, so tests and "no search request may leave this machine" deployments stay deterministic; the shipped `.env`/`.env.example` set `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto`, which is Brave when `IGTRACK_RESEARCH_SEARCH_API_KEY` is present and otherwise the **keyless, unmetered, documented FreeSerp JSON API over its own crawl index** (`https://freeserp.ai/api.php` — first-party docs for parameters, response shape, error statuses and rate guidance; no account, no key, no per-request meter, only the `agent` identifier the docs ask for); explicit `brave`, `freeserp` and `none` are also accepted; an unknown name is a CONFIGURATION_ERROR (exit 3), never a silent `none`; `brave` without a key degrades to `none` with a reason that names the variable (invariant 7), and Brave transport errors are key-redacted before any string can reach a report. Every excluded alternative is dated evidence in `docs/verification/SOURCE-AUDIT.md` (2026-10-19 addendum): DuckDuckGo publishes only an instant-answer API (its HTML endpoint is undocumented → refused under invariant 3), Mojeek now requires an API key, SearXNG aggregates engines that forbid it (boundary 8), Google Programmable Search is closed to new customers, and Bing's Search API is retired. The search step is reported in its own vocabulary — `SEARCH_NOT_CONFIGURED` / `SEARCH_SUCCEEDED` / `SEARCH_NO_RESULTS` / `SEARCH_FAILED` — separate from retrieval's `NOT_ATTEMPTED` / `COMPLETED` / `COMPLETED_PARTIAL` / `FAILED`, so "the provider answered zero results" can never be rendered as "the phase did not run" or as "the account has no web presence". And a search hit stays a candidate, never a statement: a SEARCH-result page contributes a fact only if the retrieved page itself names the exact handle in its URL, title or body — otherwise its structured values are counted and discarded with the reason shown; operator `--url` pages bypass that gate because the operator asserted the relevance. Candidates the fetch gate would refuse by policy (Instagram-family hosts) are ordered last, so a doomed host never consumes a readable page's document slot. Pinned by `research-search.test.ts` (FreeSerp mapping, 400/429/502, `ok:false` with a conservative token echo, timeout, `engine_fallback` note, `auto` resolution, Brave key redaction) and the audit matrix's four search states plus the relevance gate. | Invariant 10 says no metered dependency in the default path — it never said the default path must be blind. The keyed route remains the official API for deployments that hold a key; the keyless route makes the honest zero ("the provider ran two queries and found nothing") reachable on a fresh install, which is exactly the state this product must be able to distinguish from silence. |

| D74 | **Discovery quality is a query-strategy problem, solved deterministically — and the retrieval outcome gets its own one-label diagnosis so a weak index is never read as a verdict.** The Phase-2 live diagnosis (2026-10-19, `docs/verification/SOURCE-AUDIT.md` §10) found that FreeSerp **ignores quoted phrases and tokenizes `sel_win_` into `sel`+`win`**, so the two derived queries Phase 1 issued (`"H" instagram`, `"H" contact about`) asked for token-overlap junk while retrieval and the relevance gate were working correctly: coverage, not honesty, was the defect. Fixes, all deterministic and tested: (a) **`handleSearchQueries(handle, limit=4)`** (`packages/ingestion/src/research/queries.ts`) asks a fixed, ordered, deduped budget of four query forms that differ by *what they ask* — `"H" instagram`, `instagram.com/H`, `"@H"`, bare `"H"` — leading `@` stripped, empty handles yield zero queries, the budget is a named constant; (b) **exact-handle relevance stays enforced post-retrieval on the fetched page** (D73 gate), never on snippets — query forms change what the index is asked for, the gate is what makes an answer count, and a loose tokenizer therefore cannot game it; (c) **ranking is an explainable stable signal sort** — handle-in-URL 3 > title 2 > snippet 1 > none 0, policy-refused candidates ordered last so a doomed host never consumes a readable page's slot — and every candidate is reported with its disposition (`PLANNED` / `SKIPPED_BY_POLICY` / `NOT_FETCHED`) and reason; (d) **canonical-URL dedup** in `normalizeResearchUrl` (strips `utm_*`, `fbclid`, `gclid`, `igsh`, `ref`, `mc_cid`, `mc_eid`, `mkt_tok`, `yclid`, the fragment, and lowercases host / drops a trailing slash; all other query params are kept because some are content), so the same page found by three query forms is planned once; (e) **a policy refusal is `skipped`, never `failed`** — `BLOCKED_BY_POLICY` means no request was ever made, so counting it as a failure would misreport a structural refusal as a broken fetch, and `skipped > 0` yields `COMPLETED_PARTIAL`; (f) **one deterministic `outcomeClass`** diagnoses where the phase stopped — `SEARCH_UNAVAILABLE` / `SEARCH_FAILED` / `SEARCH_NO_CANDIDATES` / `CANDIDATES_INACCESSIBLE` / `PAGES_IRRELEVANT` / `RELEVANT_NO_FACTS` / `EVIDENCE_EXTRACTED` — and the zero-fact next-step branches on it: `PAGES_IRRELEVANT` says **weak coverage, not proof that no public evidence exists** (and names the keyed Brave option), `CANDIDATES_INACCESSIBLE` says retry or `--url`, anything earlier reports the registry's own remedy; the report also lists the source classes this phase never searches. Live-verified both directions: `sel_win_` → 4 queries × 5 = 20 results, 15 canonical candidates (25% dedup), 4 fetched / 1 `TIMEOUT`, gate discarded 22 values from 4 non-naming pages, 0 facts, `PAGES_IRRELEVANT` with the weak-coverage wording; control handle `nasa` through the identical pipeline → 4/4 pages naming the handle, 41 facts, `EVIDENCE_EXTRACTED`. Pinned in `apps/cli/test/audit.test.ts` (query array, ranking-to-the-naming-page, near-miss `sel_win` ≠ `sel_win_`, tracking-variant dedup, policy-skip semantics, all seven outcome classes) and `packages/ingestion/test/research-queries.test.ts`. | The failure this fixes was invisible in every summary count: four queries "succeeded" while asking the wrong questions, and a one-line explanation ("0 facts") gave an operator nothing to do next. Two principles carry it forward: **query forms differ by intent, gate decides truth** — never move relevance scoring into snippets to "improve" recall, because snippets are the index's claim about a page, not the page; and **six zero-result situations deserve six names** (`SEARCH_UNAVAILABLE`, `SEARCH_FAILED`, `SEARCH_NO_CANDIDATES`, `CANDIDATES_INACCESSIBLE`, `PAGES_IRRELEVANT`, `RELEVANT_NO_FACTS`) because their remedies differ completely, and only the last one is even close to "the evidence isn't there" — which, for one index, it still isn't. Benchmark evidence, including the FreeSerp tokenizer probes and the honest `NOT MEASURED` row for Brave (no key in this environment), is `docs/verification/SOURCE-AUDIT.md` §10; `scripts/bench-search.ts` re-runs it live and is never part of `pnpm test`. |

| D75 | **The pipeline's evidence quality is a measured property, not a design claim - and each Phase-3 correction traces to a defect a live run actually produced.** A seven-case evaluation set (one per category: large-footprint org, externally-referenced account, short-but-unambiguous control, underscore-tokenized handle, three-letter ambiguity, one-char near-miss, plausible nonexistent) with ground truth verified independently of the pipeline (`docs/verification/SOURCE-AUDIT.md` §11) runs through the real probe in three deliberately separate layers: mocked (vitest, never network), saved (`--saved` replays committed recordings through the real probe offline - `apps/cli/test/fixtures/bench/{nasa,natgeo,nasaa}.json`, reproducing the live numbers exactly), and live (`scripts/bench-audit.ts`, never part of `pnpm test`). The measured defects and their fixes, all strengthening: (a) **a stored statement must involve the handle** - on search-found pages its value names the handle as a token or the page's own host does, so a third-party article about `@natgeo` has its publisher's identity (og:site_name, own socials, own contacts) *counted* per document and in a report note as `unattributed`, never attributed; operator `--url` pages bypass this exactly as they bypass the mention gate, because the operator asserted relevance; (b) **relevance is a delimiter-aware token match** (`handleMentioned`): letters/digits/underscore on either side disqualify (`nasaa` in `nasaa_research`, `rgb` in `sRGB`, `nasa` in `nasal`), with the documented residual that periods stay delimiters so `nasa.gov` keeps matching; (c) **related-account links are profile-only on every extraction path**: share/compose endpoints (`x.com/intent/...`, `linkedin.com/shareArticle`, `twitter.com/share`) name no profile and are never proposed, and the D47 Instagram-family refusal now also covers `ld+json sameAs[]`, which had stored a `facebook.com` link the anchor walk would have refused; (d) **the benchmark's support checker canonicalizes both sides** (entity decoding + JSON-LD `\/`), because 5 of 5 "unsupported" facts in the before-run were escaping asymmetries in the *checker*, not missing evidence - a measurement-layer fix that changes no stored data; (e) **attribution is reported as a level** (`HOST` identity / `URL` / `TITLE` / `BODY` topical, only HOST reads strong), ground truth is matched at host level (the verified page proves its domain; the probe may fetch another path first), and duplicates are *measured* (77% on github.com's own pages) rather than papered over, since relations already refuse same-domain repeats as corroboration; (f) **expectations are falsifiable and were falsified**: the `nasaa` FORBID was wrong - the string names real organizations (nasaa-arts.org HTTP 200 with the brand 596x; nasaa.org exists behind 403 to any user-agent, a dated coverage limitation) - so the ground truth was corrected to REVIEW with the evidence, and the near-miss property that remains true (no `nasa.*` page contributes) is what the case now tests; the gate itself was never relaxed. And **no second keyless source was adopted**: Wikidata answers handle probes with label-token matches where a homonym ranks first (entity-selection ambiguity - a confident wrong entity beats an honest UNAVAILABLE), Hacker News Algolia returned zero hits for the target handle class, GitHub code search 401s and Reddit 403s (auth), Brave stays NOT MEASURED because no key exists. Pinned by `bench.test.ts` (21 offline checks), `bench-saved.test.ts` (3 replay checks), 3 new extractor profile-only checks, and 2 new + 2 updated audit-probe checks. | The mission's rule was "facts are never the verdict": before this benchmark, 6 of 24 natgeo facts named the wrong entity and an ambiguous three-letter handle produced 22 confident facts - neither was visible from fixtures, because fixtures are written by people who know what the extractor does. The rule this phase adds: **a claim's value and its attribution must both involve the handle being audited**, and when a falsified expectation disagrees with evidence, the expectation is what changes - on the record, with the response that decided it. |

### 19.3 What this phase deliberately does NOT add

- **No fetch of instagram.com/facebook.com/threads.net/whatsapp.com**, by any
  path, including the operator naming one: the host policy list refuses them
  before any DNS lookup (D69), and the audit reports the refusal as a
  document outcome rather than dropping it.
- **No storage.** An audit creates no `research_runs` row, no
  `research_documents` row, no claim and no target. The path from a web fact
  to a record is the operator filing it (`igtrack claims add`) — a human
  judgement, with its citation, that the ledger can then corroborate.
- **No identity inference.** A handle appearing on a page is that page's
  statement. The report says so in its own words, and no section asserts that
  a particular person or organization operates an account.
- **No model output as evidence.** `inferences` is the statement of an
  absence; there is no LLM in the loop, no generated summary of page prose,
  and no confidence score (§18.2 holds).
- **No silent substitution.** A synthetic (fixture) or imported source stays
  labelled in the summary's own row, and a synthetic `ACCOUNT_NOT_FOUND`
  is now explicitly called out as a property of the data set, not of
  Instagram.
- **No relaxation of D47.** A DISCOVERY target still cannot commission a
  stored acquisition run. The web phase is not a run: it stores nothing, and
  it exists precisely so the operator does not have to register a stranger's
  handle in order to begin looking.

### Verification for Phase 2

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — 5/5 workspaces clean (`tsc --noEmit`, exit 0) |
| Tests | `apps/cli/test/audit.test.ts` extended with a 9-scenario public-web matrix on the real engine over a scripted transport: facts labelled third-party statements with URL/field/time/SHA-256 and the ledger byte-identical afterwards; `CORROBORATED` across independent domains and `CONFLICTED` showing both values with no winner; a real-gate `instagram.com` refusal (`BLOCKED_BY_POLICY`) plus a non-URL rejection; a failed document reported as `FAILED`, never as an absence of facts; `NOT_ATTEMPTED` with the exact env-var remedy; a search-provider cap that is enforced and reported (`documentsTruncated`); a page's sensitive predicates never proposed; a broken `IGTRACK_RESEARCH_SEARCH_PROVIDER` exiting 3; and the human screen rendering the same web section the JSON carries |
| MCP + CLI surface | `igtrack_audit` gains optional `urls` (≤10) and `maxSources` (1–10) inputs, `readOnlyHint: true` retained; CLI gains `--url` and `--max-sources`; `EXPECTED_TOOLS` unchanged (24) |
| Docs | `docs/verification/SOURCE-AUDIT.md` (dated, URL-cited); this section; `docs/DEEP-ACCOUNT-INTELLIGENCE.md` §12 |
| Live public-web probe | **VERIFIED 2026-10-18** in this environment, against the real internet with the real fetcher: `igtrack audit sel_win_ --url "https://example.org,https://www.wikipedia.org"` fetched both pages (`FETCHED`, HTTP 200, 577 B and 122197 B, real SHA-256 digests, real retrieval timestamps) and reported **383 links counted and NOT followed** at depth 1; `--url https://www.anthropic.com` fetched 201400 B and yielded **4 cited facts** with field, method, source URL, retrieval time and per-fact uncertainty. The search provider was absent and was reported as `UNAVAILABLE` with its exact remedy, not as an empty result. No row was written and no target was registered in either run |
| Live-found defects, fixed | That live probe is also how three honesty defects were found that no fixture page reproduced: (a) phrase-mining a marketing `meta description` produced the value `that&`; (b) undecoded HTML entities left `&amp;` inside claim values and quoted excerpts; (c) one page's three social links were labelled `CONFLICTED`. Fixed under D72 and pinned by tests |

Not claimed: no live search provider was exercised (no key exists in this
environment — the phase reports `UNAVAILABLE` with the exact env vars, which is
itself the pinned behaviour). The transport's failure modes remain pinned
separately in `packages/ingestion/test/research-fetch.test.ts`; the three live
fetches above verify the success path, not the internet's full behaviour.

---

## 20. Phase I — the identity gate: an observation belongs to the account it is about

**Date:** 2026-10-20 · **Status:** adopted

### 20.1 The defect, as it actually showed up in a live database

A deployment configured with `IGTRACK_PROVIDER=fixture` was asked about a real
handle. The `sel_win_` target ended up holding:

- two COMPLETE follow snapshots (5 followers, 4 following) whose members were
  the fixture set's invented accounts, with `evidence.source_reference` set to
  `sel_win_`;
- two posts, three comments and 68 insight points from the same fixture set,
  filed under the same target;
- and a genuine WEB claim — a public Instagram reel published by `@serpaix.ai`
  that names `sel_win_` beside it — which is real research evidence and is
  preserved untouched.

The evidence rows were labelled `synthetic: true` and the source was
`fixture:v1`. That was not enough. The rows were filed under a REAL account's
record, and from that point on every downstream derivation — the follower
roster, the follow/unfollow deltas, the relationship score, the "own-account
insights" coverage row, the dossier's "77 stored rows" — was a statement
about a person who had never been observed.

The cause was structural, not a missing check in one place:

| # | Fact | Where |
|---|---|---|
| 1 | A fixture set observes exactly one account. | `packages/ingestion/fixtures/v1/manifest.json` declares `target_username` |
| 2 | Only `resolveAccount` compared the requested username with the set's subject. | `fixture-provider.ts` |
| 3 | The worker never called `resolveAccount`: it went from a target row straight to a capability call. | `workers/monitoring/src/executors.ts` |
| 4 | The follow diff compared the newest snapshot of ANY source with the new one, so a synthetic roster could be diffed against a live one. | `follows.ts` `latestFollowSnapshot` |
| 5 | The relationship ranking aggregated story mentions, comments and deltas with no source filter at all. | `app-queries.ts` `getRelationshipsForUser` |

So: the provider served one account's bytes for any username it was handed,
and the storage path believed it.

### 20.2 Decision log (Phase I)

| # | Decision | Rationale |
|---|---|---|
| D76 | **A provider declares which account it observes** (`InstagramProvider.observesAccount?`, a local, no-I/O predicate). The worker checks it before a single row is written, `igtrack scans run` and the scheduler refuse to enqueue a scan it cannot answer, and the fixture provider additionally refuses every account-scoped capability for a foreign account, at its own boundary. | The provider is where the knowledge lives, so the guard belongs there; the worker is the only writer, so the guard belongs there too. One predicate, checked in one place at write time and at both enqueue paths, closes every route — including a job enqueued by some other path. The refusal says "this source does not observe that account", never "that account does not exist". |
| D77 | **A relationship ranking is computed over ONE evidence class at a time, and the classes are never blended.** `getRelationshipsForUser` takes the source classes as an argument; the CLI renders a live ranking and a synthetic ranking as separate sections. | A synthetic interaction is evidence about a fixture, not about a person: letting it into a live score would be demo data moving a real number. Excluding it outright was the other option, and it is wrong too — it would silently empty the product's own demo and hide the fact that observations exist. Two labelled rankings say both things: "no live observation" AND "here is what the fixture produced". |
| D78 | **A follow diff only ever compares snapshots from the same source**, and a stored record carries the class of the evidence behind it (`SYNTHETIC` / `LIVE` / `MIXED` / `NONE`) on every surface that shows its rows. | "There are rows" and "the account was observed" are different facts, and only the second one may be rendered as "OBSERVED". The class travels with the row counts, the coverage table, the stored-record state and the audit's Observation block, so a reader never has to infer it from a source id. |
| D79 | **The synthetic seed no longer enqueues a provider scan.** It writes its own observations, with their own evidence and source id, and the demo flow is "add a target the configured source can observe, then scan". | The seed's queued `PROFILE_SCAN` was for an account no provider observes, so it could only ever fail — and before the gate it filed the fixture set's roster under that account. The seed is a data seeder; scanning is the worker's job, driven by the operator's target list. |
| D80 | **`igtrack audit` distinguishes "a report was produced" from "the account was observed":** exit 0 means the configured source returned an observation, exit 4 means the report was produced and NO observation was made, and the report's `observation` block says in one place whether a real platform request reached Instagram. | The mission's own complaint: an audit report that generates successfully is not the same thing as an account that was observed, and a script must be able to tell them apart without parsing prose. Exit 0 means "the source answered" — the class (LIVE / IMPORTED / SYNTHETIC) is reported separately, because a fixture or an export source can never set `realPlatformRequest`. |
| D81 | **The research run applies the same two gates the audit probe applies**: a machine-found page that never names the handle is discarded, and a machine-found statement that names the source rather than the handle is not attributed to the account. The run also issues the handle's own four-query budget and reports a search transport failure instead of dropping it. | The probe and the run are two doors into the same ledger; a gate on one door only is a door that leaks. The run's hardcoded `"H" organization` / `"H" about contact` pair was the near-duplicate the shared query module was written to replace, and dropping `outcome.error` turned a broken index into a silent zero-candidate run. |
| D82 | **No stored row was deleted.** The contaminated `sel_win_` rows are labelled `SYNTHETIC` on every surface that shows them; the target and the WEB claim are preserved. | The ledger is append-only, the rows are now honestly labelled, and an operator's database is not the agent's to prune. The remediation is documented and reversible rather than executed unasked (see §20.4). |
| D83 | **The scheduler carries the same identity gate.** `runSchedulerTick` takes the provider as an optional dependency and skips a target the source does not observe, so the automatic path never queues a scan that cannot succeed. | D47's rule is "refuse at enqueue AND at execute", and the scheduler is the automatic enqueue path. A permanently-failing job per window per kind is noise that trains the operator to ignore failures. The dependency is optional and narrow — the scheduler still decides WHAT is due, never what is observable — and the worker's execute-time gate stays the backstop for a job that arrives by another route. |
| D84 | **A fixture set whose manifest and profile name different accounts is REFUSED, not resolved.** And `igtrack targets add` tells the operator immediately when the configured source does not observe the account they are adding. | The two files name the same subject; a set that disagrees would serve one account's bytes under another's name — the same contamination, reached by configuration instead of by a username. Fail-closed is the only safe reading of a broken set. And a target the source cannot observe is still created (a target is not an observation, and the operator may be registering it before configuring the source) — but the operator is told now, on the same principle as D49: an unreachable account is a fact to learn at add time, not after a week of scans that can never produce data. |

### 20.3 What was deliberately NOT added

- **No "account binding" option on the fixture provider.** A constructor
  argument that rebinds a fixture set to any account would have made the
  contamination easy to re-introduce on purpose. Tests that need their own
  subject copy the set and rebind it there
  (`workers/monitoring/test/fixture-set.ts`).
- **No deletion of the contaminated rows.** See D82 and §20.4.
- **No new capability, no new provider route, no new table.** The gate is a
  check, not a feature: it closes a path that should never have been open.
- **No weakening of the refusals.** Nothing in §14 is touched: likers, other
  accounts' rosters, highlights and hidden interactions stay platform-absent.

### 20.4 Operator remediation for a record that was contaminated before this phase

The rows this phase found in a live database are left in place (D82). They are
labelled `SYNTHETIC` everywhere they surface, and no scan can add another one
— the gate refuses the source that produced them. If an operator wants the
wrong rows gone, here is the reviewed statement, with the cascade rules it
relies on (`follow_snapshot_members`, `follow_deltas`, `post_comments`,
`post_children`, `post_presence` and `post_changes` all cascade from their
parent; `insight_points` and `evidence` do not).

It removes the observation rows only. The target, the account, the operator's
WEB claim and every other row stay exactly where they are.

```sql
BEGIN;
-- Capture the evidence ids FIRST: the child rows below are the only thing
-- that identifies them, and deleting them first would orphan the ledger.
CREATE TEMP TABLE igtrack_doomed_evidence AS
SELECT e.id FROM evidence e
WHERE e.source_id = 'fixture:v1'
  AND (
       e.source_reference = 'sel_win_'
    OR e.id IN (SELECT ip.evidence_id FROM insight_points ip
                JOIN ig_accounts ia ON ia.id = ip.ig_account_id
                WHERE ia.username = 'sel_win_')
    OR e.id IN (SELECT p.evidence_id FROM posts p
                JOIN targets t ON t.id = p.target_id
                JOIN ig_accounts ia ON ia.id = t.ig_account_id
                WHERE ia.username = 'sel_win_')
    OR e.id IN (SELECT pc.evidence_id FROM post_comments pc
                JOIN posts p ON p.id = pc.post_db_id
                JOIN targets t ON t.id = p.target_id
                JOIN ig_accounts ia ON ia.id = t.ig_account_id
                WHERE ia.username = 'sel_win_')
  );

DELETE FROM follow_snapshots fs
  USING targets t, ig_accounts ia
 WHERE fs.target_id = t.id AND t.ig_account_id = ia.id
   AND ia.username = 'sel_win_';      -- cascades: members, deltas

DELETE FROM posts p
  USING targets t, ig_accounts ia
 WHERE p.target_id = t.id AND t.ig_account_id = ia.id
   AND ia.username = 'sel_win_';      -- cascades: comments, children, presence, changes

DELETE FROM insight_points ip
  USING ig_accounts ia
 WHERE ip.ig_account_id = ia.id AND ia.username = 'sel_win_';

DELETE FROM evidence e USING igtrack_doomed_evidence d WHERE e.id = d.id;
DROP TABLE igtrack_doomed_evidence;
COMMIT;
```

Take a `pg_dump` first. The statement is written for one target; the account
name is the only thing to change.

### 20.5 Verification for Phase I

| Item | Evidence |
|---|---|
| Typecheck | `pnpm typecheck` — clean across every workspace package |
| Provider isolation | `packages/ingestion/test/fixture-identity-guard.test.ts` — every account-scoped capability refuses a foreign account with `ACCOUNT_NOT_FOUND`; the refusal text says it is not a statement about the account's existence; a set whose manifest and profile disagree is refused |
| Write-path isolation | `workers/monitoring/test/worker-identity-gate.test.ts` — a refused scan writes no snapshot, no member, no delta and no evidence row; the refusal is permanent; the scheduler never queues such a scan |
| Ranking isolation | `packages/database/test/activity-relationships.test.ts` — a synthetic mention is absent from the live ranking and present in the synthetic one |
| Audit | `apps/cli/test/audit.test.ts` — exit 0 for an observed account, exit 4 for a report with no observation, exit 3 for a blocked configuration; the `observation` block names the class and whether a real platform request happened; a stored record of synthetic rows renders as `SYNTHETIC`, never as `OBSERVED` |
| Public-web run | `apps/cli/test/research-run.test.ts` — the run path now discards a machine-found page that never names the handle and refuses to attribute a statement that names the source rather than the handle |

---

## 21. Phase J — the username-first investigation: one handle in, one dossier out

**Date:** 2026-10-20 · **Status:** adopted

### 21.1 The founder decision

The core product is **not** an export importer, not a bag of disconnected
commands, and not a manual research assistant. It is:

> Input one Instagram username → automatically investigate all permitted and
> technically accessible sources → extract and correlate information → produce
> the deepest possible evidence-backed intelligence dossier.

The operator should not have to collect profile details, supply separate
search queries, or configure an investigation one step at a time.

### 21.2 What the repository actually did before this phase

Audited, not assumed:

| | Before |
|---|---|
| A username took **five commands** | `targets add` → `scans run` → `work` → `research` / `dossier` → `audit`. The orchestration was the operator's job. |
| The read surfaces were separate | `audit` (read-only, one probe + stored record + web phase), `research` (over stored rows), `dossier` (the stored record), `relationships`, `insights`, `activity`. A dossier existed, but the operator had to assemble it from four reports. |
| The public-web phase was a separate opt-in | `research --run --question "…"` — the operator had to know it existed, phrase the question, and name the sources. |
| The capability truth lived in a registry, not in a report | `igtrack capabilities` printed 25 rows. Nothing told an operator *for this account* what was obtainable, from which source, and what was missing. |
| A target detail bundle existed but was unused | `getOwnedTargetDetail` already read back posts, comments, mentions, children, rosters, deltas and jobs. No surface rendered it. |

### 21.3 Decision log (Phase J)

| # | Decision | Rationale |
|---|---|---|
| D85 | **One command orchestrates every stage: `igtrack investigate <username>`** (MCP `igtrack_investigate`). Stages run in order — IDENTITY, PLATFORM, CONTENT, RELATIONSHIPS, WEB, CORRELATE, DOSSIER — and each is reported separately, with what it retrieved and why it stopped. | The founder's acceptance criterion, expressed as code. Orchestration is the product: the stages already existed, but the operator had to know them, order them, and read their results in three places. |
| D86 | **The investigation reuses the existing operations rather than reimplementing them.** It calls `opTargetAdd`, `opScanRun`, the worker drain, `opRelationships`, `opResearchRun` / `opAuditWebProbe` and `opResearch` — so the dossier is literally the `igtrack research` report plus the investigation's own framing. | One operations layer, two surfaces, no drift: a bug fixed in the report is fixed for the investigation too, and the two can never disagree. |
| D87 | **The evidence class follows the SOURCE, not the fact that a source answered.** A fixture set that observes an account produces `SYNTHETIC_FIXTURE` evidence; the six classes are counted separately in every report. | Phase I's lesson, applied to the new surface: the class is the single most load-bearing label in the product, and deriving it from "did we get data" would credit a demo run with a platform observation. |
| D88 | **The platform id is the identity, and it is checked BEFORE anything is written.** A resolved id already bound to a different username stops the investigation with `IDENTITY_CONFLICT`; nothing is recorded. | Two accounts cannot share one platform id. A handle that merely looks similar is a different person, and merging them would merge two histories. The check is the same one the account repository already enforces on write — moved earlier, where it can still be explained. |
| D89 | **A DISCOVERY target is created only when the documented Business Discovery route actually answered.** Otherwise the target is the account the deployment was asked to observe, and the platform stages report — with the source's own words — that the source does not observe it. The public-web stage still runs. | A third-party investigation must not be blocked by the absence of a platform credential: the open web is a lawful source for any handle, and the report says plainly which stages could not run. A target is not an observation, so creating one is not a false claim. |
| D90 | **The public-web stage runs the read-only probe for a DISCOVERY target and the acquisition run for an owned one.** The probe's findings are reported and NOT filed; the refusal of an autonomous run against an account the operator has not owned is D47's, unchanged. | D47 is a refusal, and changing a refusal needs its own dated decision with evidence. The founder's ask — "continue with other useful sources" — is satisfied without lifting it: the findings are still in the dossier, with their citations, and the dossier says they were not filed. |
| D91 | **Exit 4 means "the dossier was produced and NOTHING was retrieved."** Exit 0 means something was retrieved; 2 is usage; 3 is a blocked configuration. | A dossier full of gaps is a real answer, and a script must be able to tell it from a dossier with findings without parsing prose. |
| D92 | **The scan cadence is respected by default; `--force` re-reads now.** A repeated investigation is therefore cheap and does not hammer the platform, while the observations themselves stay incremental (they dedupe by identity). | The founder's "repeat investigations, change detection, incremental collection" is a property of the storage, not of the queue. Re-reading on every invocation would have made a repeat investigation a rate-limit hazard. |
| D93 | **`docs/SOURCE-MATRIX.md` is the operative per-category truth**: fields sought, source, permission, credentials, status, limits, freshness, the refusal behaviour, and the test that pins it. | The capability registry already knew this per capability, but it was not reachable as "what can I get for THIS account, and why not the rest". A matrix written against the code is the difference between a plan and a reference. |
| D94 | **No new table.** The investigation run is composed from the target, the jobs, the observations, the claims and the research runs that already exist. | A run record would be a second place for the same facts, and it would drift. Everything the dossier says is already stored, with its own evidence. |
| D95 | **The full research report shows the synthetic class too, labelled.** `connections` carries `syntheticRanks` beside `ranks`, and `leads` carries `syntheticItems` beside `items`. | Phase I split the ranking by evidence class, and the research report — which reads the LIVE ranking — went quiet: a fixture deployment showed "Connections: (none)" while its coverage table said four story mentions were observed. Under-reporting is its own dishonesty. The two classes stay apart and both are shown. |

### 21.4 What was deliberately NOT added

- **No crawling, no private endpoints, no session cookies, no anti-bot
  evasion, no authenticated access to a private profile.** The founder's
  "do not circumvent source restrictions simply to increase apparent coverage"
  is a hard line, and the matrix's refusals are the same ones §14.1 records.
- **No "import required" gate.** A third-party investigation never requires
  the operator's own export; the export is one source among several, and the
  dossier says which stages it could not run.
- **No second implementation of the dossier.** The investigation composes the
  existing report; it does not re-derive themes, ranks or coverage.
- **No inference about a person.** Leads are reported as leads, separately
  from the confirmed findings, and the dossier carries no inferred
  relationships, proximity or private attributes.

### 21.5 Verification for Phase J

| Item | Evidence |
|---|---|
| Orchestration | `apps/cli/test/investigate.test.ts` — the stages run in order, each with a source and a reason; the account is resolved, recorded and observed in one command |
| Evidence classes | the same file — a fixture set's rows are `SYNTHETIC_FIXTURE` and `PLATFORM_OBSERVATION` stays 0; the stored record agrees |
| Relationship separation | the same file — the live ranking is empty and the synthetic ranking is not, for the same account |
| Missing credentials / inaccessible accounts | the same file — every stage is BLOCKED with the source's own reason, the refusal says the account's existence is not denied, and "a scan can still run" is NOT used as the explanation |
| Exit codes | the same file — 4 when nothing was retrieved, 0 when something was; usage is 2 |
| Incremental re-runs | the same file — a second investigation adds no duplicate rows and reuses the same target |
| CLI/MCP parity | the same file — the MCP tool returns the same stages in the same order, from the same operation |
| MCP surface | `apps/cli/test/mcp.test.ts` — `igtrack_investigate` is in the published tool set |
| Live public-web path | `scripts/bench-search.ts` — the real pipeline over the real index, with a positive control |

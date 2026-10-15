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

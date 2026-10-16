# IGTrack — complete feature documentation (reverse-engineered)

> **What this document is.** A clause-by-clause inventory of every feature the
> IGTrack repository at `HEAD = 04e2a46` contains — CLI, MCP server, worker,
> ingestion providers, domain core, database, deployment assets, and the
> retired web dashboard that survives only as a built artifact and as git
> history. Produced by reverse engineering, in this order:
>
> 1. **REA static analysis** of the only closed artifact in the tree — the
>    built Next.js web app at `apps/web/.next` (its source is not in HEAD).
> 2. **Direct source reading** of every tracked file in `packages/*`,
>    `workers/*`, `apps/cli`, `scripts/*`, `docs/*`, compose files and CI.
> 3. **Runtime probing** of the CLI (`igtrack --help`, `status`, `config`,
>    `doctor`, `capabilities`) and of the MCP server over stdio
>    (`tools/list` handshake).
> 4. **Git-history archaeology** for the deliberately deleted web app
>    (commit `de06fbb`, "third founding: the agent surface is the only
>    product surface").
>
> Every claim below is traceable to a file path, a runtime capture, a git
> object, or the REA evidence IDs recorded in §17.

---

## 0. How this was verified (evidence ledger for *this* document)

| Source | What it yielded | Identifier |
|---|---|---|
| REA `analyze_javascript_application` on `apps/web/.next` (format `directory`, detail `summary`) | 191 relevant files, 139 parsed JS files, 481 modules, 708,832 AST nodes, 2,150 findings, 0 parse failures; coverage partial (155 application unknowns, 21,355 semantic unknowns; budget-limited expansions retained on file nodes) | parent evidence `ev_710d05d020fbca83f0116b65f38872a5d67dc564c1a222cbe67a82d9dea4e5af`; summary evidence `ev_9e145ea11ad2b771dab725dd6d683a1ad94c137960d5805077e8fcceb2aadf11`; artifact sha256 `19723f60b0aa0b2b63bdd3847002959dc2a1aa342db1d78f65649be315105eb9` |
| REA `inspect_analysis_view` (modules page + middleware item) | 1,245 module nodes; `server/middleware.js` content digest `198d6485…`, its source-map-original recovered **byte-identical** to the former tracked `apps/web/middleware.ts` | module node `jag_node_86b04d67754950274855a3df272abf457c5847e6cec8c82e9939993045d1fadf`, parent evidence above |
| Runtime capture | `igtrack --help`, `status`, `config --json`, `doctor`, `capabilities --json`; MCP `initialize` + `tools/list` (19 tools) | this session, against the local checkout; Postgres reachable; provider `fixture` |
| Git history | `de06fbb` deleted 79 files under `apps/web` (full list in §12.1); `de06fbb^` still holds every one of them | commit `de06fbb`, parent `de06fbb^` |

Repository state at analysis time: `git status` empty, commit `04e2a46`
("fourth founding"), no source modifications were made by this analysis.

---

## 1. Product overview

**IGTrack** is a free, self-hosted, agent-driven **evidence-first observation
engine** for Instagram accounts the operator is authorized to observe
(`README.md:1-6`). Its defining property is *epistemic honesty*: every stored
claim carries provenance, and anything unobservable is reported
`UNAVAILABLE` **with a reason** — never as zero, never as a guess
(`AGENTS.md` preamble, `README.md:24-46`).

What it does, at feature level:

| Pillar | Meaning |
|---|---|
| **Observes** | profiles, active stories, story mentions, follower/following counts, public posts, comments, carousels, tagged media (owned), own-account insights — each with source id, observation id, observed vs captured time, confidence, SHA-256 hashes in an append-only ledger (`README.md:42-46`) |
| **Derives** | follow deltas, profile changes, post caption edits and disappearances ("no longer observed", never "deleted"), story lifetimes, mention roll-ups, relationship rankings from stored signals only, insight series — every derived row points at observations (`README.md:44`, `docs/ARCHITECTURE.md:39-66`) |
| **Refuses out loud** | follower rosters of other accounts, liker lists, another account's comments/likes, repost identities, other accounts' highlights, media bytes — machine-readable in the capability registry, printed by `igtrack capabilities` (`README.md:40-46`, §6 below) |
| **Runs itself** | Postgres job queue (`FOR UPDATE SKIP LOCKED`, leases, heartbeats, resumable paged scans with checkpoints, retry classification) + scheduler with per-target cadence (§9) |
| **Speaks agent** | JSON-first CLI and a stdio MCP server exposing the same operations layer (§3, §4) |

Founding invariants that shape every feature (`AGENTS.md §3`, ten bullets):
absence is not zero; `UNAVAILABLE` is never an error and never empty data; no
access-control circumvention; partial never becomes a claim; every stored
claim has evidence; the capability registry is the single source of truth;
configuration failures fail fast and loud; secrets never leave the
environment; ownership scoping is unconditional; no paid dependencies in the
default path.

---

## 2. Repository map (tracked files at HEAD)

| Path | Files | Responsibility |
|---|---|---|
| `packages/core` | (part of 140 under `packages/`) | Pure domain: observation categories, confidence, `CapabilityResult`, typed errors + retryability, evidence hashing, profile/follow diffs, mention classification, capability registry. **Zero runtime dependencies** |
| `packages/database` | ” | Drizzle schema, repositories, append-only evidence ledger, job queue + scheduling primitives, migrations (`0000`–`0018`), synthetic seed |
| `packages/ingestion` | ” | Providers (`fixture`, `graph`, `import`), normalizers, raw schemas v1, documented-field audit |
| `workers/monitoring` | 31 | Job execution: claim/complete, per-kind executors, checkpoints + staging, lease heartbeat, provider timeout, scheduler, retention |
| `apps/cli` | 17 | `igtrack` CLI + `igtrack mcp` server; all agent-facing capability in `apps/cli/src/tools.ts` |
| `docs/` | 10 | Architecture, capability matrix, deployment, founding decisions, research corpus |
| `scripts/` | 5 | backup, restore, capability-matrix generator, graph verifier, perf harness |
| `.github/workflows/ci.yml` | 1 | CI: Postgres service, typecheck, tests, worker boot smoke |
| root | ~20 | `package.json` scripts, compose files, `Dockerfile.worker`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `LICENSE` (AGPL-3.0-or-later), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.env.example` |
| `apps/web` (untracked) | — | only `.next/` build output remains; source deleted (§12) |

Root scripts (`package.json`): `test` (vitest), `test:watch`, `typecheck`
(`pnpm -r`), `verify:graph`, `docs:capabilities`, `igtrack`, `mcp`, `worker`.
No build step anywhere in the default path — everything runs TypeScript
directly through `tsx` (`AGENTS.md §1`).

---

## 3. CLI — every command

Entry: `apps/cli/bin/igtrack.mjs` spawns `node --import tsx src/main.ts …`
(stdio inherited, exits with the child's code); `pnpm igtrack` →
`pnpm --filter @igtrack/cli run start`. Version string `0.1.0`.

Argument grammar (`apps/cli/src/output.ts:73-114`): `--k=v`; `--k v` (consumed
only when the next token is not `-…`); bare `--k` → `true`; short `-x v`;
`--` ends flag parsing; first positional = command, default `help`.

Global behavior: `--version`/`-v` printed before env load; `--json` on every
command (bare, `=true`, `=1` count; `--json false` disables). Exit codes:
`0` ok, `1` runtime/INTERNAL, `2` usage/selection, `3` configuration or
connectivity (`apps/cli/src/main.ts:36-38`, `output.ts:45-61`).
`loadProjectEnv()` runs before dispatch; `<cwd>/.env` then `<repoRoot>/.env`;
existing process env always wins (`env.ts:51-83`).

### 3.1 Router table

| Command | Positionals | Flags (default) | Behavior |
|---|---|---|---|
| `setup` | — | `--local`, `--no-seed`, `--json` | `SELECT 1` → migrate → seed-if-empty; `--local` fabricates and persists `postgresql://igtrack:igtrack@localhost:5432/igtrack` into repo `.env` when no URL is set |
| `config` | — | `--json` | repo root/cwd/env files + 16-variable table, all values redacted (§5) |
| `status` | — | `--json` | Owner, provider usability, targets table (followers/following/last observed), queue counts, source health |
| `doctor` | — | `--json` | provider, DB reachability, migrations, graph credential presence, scheduler on/off, source-health rows, findings list, capability summary. **Always exits 0** — findings never change the exit code (`main.ts` comment) |
| `targets <sub>` | `list` default; `help` | `--json` per sub | `list` \| `add <username> [--name --tags --observed]` \| `pause <ref>` \| `resume <ref>` \| `rm <ref> --yes` (aliases `remove`, `delete`); `--observed` is a bare flag only and probes the Business Discovery route before creating (refuses on UNAVAILABLE with the platform's reason) |
| `scans <sub>` | `list` default; `help` | `--json` per sub | `run [target] [kinds…] [--kind --target --force]` queues (never runs); `list [target] --limit` shows jobs. Kinds: the 8 of §9 |
| `work` | — | `--max N` (25), `--no-scheduler`, `--json` | one scheduler tick + drain the queue in the foreground |
| `activity` | — | `--type a,b --since --limit N (30) --target --query --json` | what changed, newest first |
| `relationships <target>` | required | `--limit N` (25), `--json` | ranked contacts with method block |
| `dossier <target>` | required | `--json` | full recorded dossier + per-capability coverage + refusals |
| `evidence` | — | `--id <eid> --limit N (20) --json` | ledger listing, or one evidence chain |
| `lookup <username>` | required | `--json` | stateless probe of one public professional account; persists nothing |
| `tags <target>` | required | `--limit N` (50), `--json` | media by other accounts that tag the owned account |
| `mention <commentId>` | required | `--account <username>`, `--json` | one webhook-keyed mentioned comment; persists nothing |
| `insights <target>` | required | `--metric M --limit N (200) --json` | recorded insight series + absences |
| `capabilities` | — | `--available`, `--json` | the registry: `18 of 23 capabilities are obtainable from a lawful source` |
| `mcp` | — | — | stdio MCP server; stdout carries only JSON-RPC, ready line on stderr |
| `help` / `version` | — | — | banner / `0.1.0` |

Unknown command → stderr `igtrack: unknown command "<x>"` + HELP, exit 2.
Every `op*` failure prints `igtrack: <message>` (or `{ok:false,error:{code,message}}`
with `--json`) to **stderr**.

### 3.2 Rendering rules (human mode)

`display(v)` maps `null`/`undefined` → `"unavailable"`, `""` → `"(empty)"`,
`[]` → `"none"` (`output.ts:156-162`) — the invariant "absence is not zero"
survives all the way to the table renderer. `relativeTime(null)` → `"never"`.
Tables have no rows → `"(none)"`. `--json` envelope:
`{ok:true,data,_meta}` on stdout (`output.ts:31-43,222-241`).

### 3.3 Notable honesty mechanics in commands

- `scans run` prints the note *"Jobs are queued, not run — start a worker with
  `igtrack work` or the daemon."*
- `lookup` footer: UNAVAILABLE → *"The requested route does not expose this.
  Nothing was written."*; otherwise *"Nothing was persisted: `lookup` is a
  read-only probe."*
- `dossier` prints profile snapshots, media with **published vs first-observed**
  timestamps kept apart, the bounded-preview statement, and a
  `Routes that answered UNAVAILABLE` table.
- `evidence --id` prints `Raw hash` as the string `unavailable` with an
  explanation when the source transported no raw representation: *"the
  normalized hash is not a substitute."*
- `tags` notes a PARTIAL listing as PARTIAL; `insights` distinguishes "never
  recorded" from "platform reported absent".

---

## 4. MCP server — the agent surface

`igtrack mcp` (`apps/cli/src/mcp/server.ts`) speaks MCP over stdio.
Server identity (observed at runtime via `initialize`):
`{name: "igtrack", version: "0.1.0", description: "Evidence-first Instagram
observation engine (self-hosted, fixture-first)"}`. The process **owns
stdout** (JSON-RPC only); diagnostics go to stderr.

`instructions` (sent to MCP clients) mandate: call `igtrack_status` first;
`igtrack_scans_run` queues and `igtrack_work` executes; read via
activity/relationships/insights/tags/evidence; `null` means not observable;
echo `_meta.synthetic`; and refuse lawfully-unavailable data at prompt level
(pinned by `apps/cli/test/mcp.test.ts:71-74`).

### 4.1 The 19 tools (runtime-observed; `tools/list`)

| # | Tool | Required inputs | Optional inputs | Annotations | Semantics |
|---|---|---|---|---|---|
| 1 | `igtrack_status` | — | — | readOnly | deployment/owner overview |
| 2 | `igtrack_capabilities` | — | — | readOnly | registry verbatim; **DB-free, no `_meta`** |
| 3 | `igtrack_doctor` | — | — | readOnly | diagnostics + findings |
| 4 | `igtrack_targets_list` | — | — | readOnly | owner's targets |
| 5 | `igtrack_target_add` | `username` | `localName`, `tags[]`, `observed` | mutating | track account; `observed:true` = DISCOVERY route probed once |
| 6 | `igtrack_target_set_status` | `target`, `status` enum `ACTIVE\|PAUSED` | — | mutating | pause/resume |
| 7 | `igtrack_target_remove` | `target`, `confirm: literal(true)` | — | mutating | `confirm` is a **schema gate**; description says "Ask the user before calling this." |
| 8 | `igtrack_scans_run` | — | `target`, `kinds[]` (enum of 8), `force` | mutating | queues scans only |
| 9 | `igtrack_scans_list` | — | `target`, `limit 1..200` | readOnly | job history |
| 10 | `igtrack_work` | — | `max 1..500` (25), `skipScheduler` | mutating | executes queue work — actually observes |
| 11 | `igtrack_activity` | — | `since`, `limit 1..200`, `target`, `types[]`, `query` | readOnly | activity feed |
| 12 | `igtrack_relationships` | `target` | `limit 1..200` | readOnly | ranked contacts |
| 13 | `igtrack_dossier` | `target` | — | readOnly | full dossier report |
| 14 | `igtrack_evidence` | — | `limit 1..200` | readOnly | ledger list |
| 15 | `igtrack_evidence_chain` | `evidenceId` | — | readOnly | one chain |
| 16 | `igtrack_insights` | `target` | `metric`, `limit 1..1000` | readOnly | insight series |
| 17 | `igtrack_lookup` | `username` | — | readOnly | stateless probe |
| 18 | `igtrack_tags` | `target` | `limit 1..200` | readOnly | tagged media |
| 19 | `igtrack_mention_read` | `commentId` | `account` | readOnly | stateless mentioned-comment read |

No `destructiveHint` is set anywhere; deletion gating lives in the schema
(`confirm`) plus the CLI (`--yes`). `EXPECTED_TOOLS` in
`apps/cli/test/mcp.test.ts:14-34` pins this list — a rename is a breaking
change.

### 4.2 Result envelope, `_meta`, errors

- Success: `{ok:true, data, _meta}` in `content[0].text` (pretty JSON) and in
  `structuredContent` for objects. `igtrack_capabilities` is the one tool that
  returns the operations payload directly (no context, no `_meta`).
- `_meta` (always present otherwise; `withMeta`, `context.ts:71-89`):
  `provider`, `sourceId` (or `null` on config failure), `synthetic`
  (`sourceId` contains `fixture`; `true` on config failure), `production`
  (`NODE_ENV === "production"`), `studio: "cli"`, `generatedAt`, and a `note`
  — e.g. *"Synthetic fixture data. Not a real account observation."* or
  *"Live observation of the authorized account via the official Instagram
  Graph API."*
- Failure: `isError:true` with `{ok:false,error:{code,message}}`; connection
  failures become `DB_UNAVAILABLE` via a message/cause regex; everything else
  `INTERNAL`. The context handle is discarded on a connection failure so the
  next call reconnects (`server.ts:94-127`).
- Pinned by tests: unreachable DB → `DB_UNAVAILABLE` (not empty data);
  invalid enum rejected at schema level; missing `confirm` rejected by the SDK
  with no error envelope; `igtrack_capabilities` succeeds with the DB down.

---

## 5. Configuration — every environment variable

**Loading.** `loadProjectEnv()` reads `<cwd>/.env` then `<repoRoot>/.env`;
a key is applied only if its current value is `undefined` or `""`, so process
env always wins (`apps/cli/src/env.ts:51-83`). `igtrack setup --local` writes
`DATABASE_URL` into the repo `.env` when none is set (header comment added if
the file is created; never duplicates an existing `(IGTRACK_)?DATABASE_URL`
line).

**Redaction** (`env.ts:96-117`): unset → `"(unset)"`;
`IGTRACK_GRAPH_ACCESS_TOKEN` → `"(set)"`; anything containing `DATABASE_URL` →
`postgresql://user:***@host/db` (unparsable → `"(set, unparsable)"`). No
credential value is ever printed by `config`, `doctor`, `setup`, logs or
error messages (invariant 8).

| Variable | Default | Meaning | Failure mode |
|---|---|---|---|
| `DATABASE_URL` | none — required | primary Postgres connection | startup throws *"Database URL is not configured"*; only `setup` maps it to typed `DATABASE_URL_MISSING` (exit 3); everything else exits 1 / MCP `INTERNAL` |
| `IGTRACK_DATABASE_URL` | — | alias, checked first | same |
| `IGTRACK_TEST_DATABASE_URL` | `postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test` | test DB (created by `docker/initdb`) | DB-backed suites **skip loudly**, never pass vacuously |
| `IGTRACK_USER_EMAIL` | — | which user owns CLI operations when >1 user exists; precedence: `--user` flag (documented but currently inert — no command passes it) → this var → the only user | none → `NO_USER` (2); >1 and no selection → `AMBIGUOUS_USER` (2) |
| `IGTRACK_PROVIDER` | `fixture` | `fixture \| graph \| import` | **unknown name throws at startup** — never an empty dataset |
| `IGTRACK_FIXTURE_VERSION` | `v1` | fixture set under `packages/ingestion/fixtures/`; also labels `sourceId` | version mismatch fails fast (`SCHEMA_MISMATCH`) |
| `IGTRACK_FIXTURES_DIR` | — | override fixture directory | documented in `.env.example` but **consumed by no code path** (the worker resolves fixtures relative to the module) |
| `IGTRACK_GRAPH_ACCESS_TOKEN` | — | long-lived Graph token (secret) | missing → fail fast when `provider=graph` |
| `IGTRACK_GRAPH_IG_USER_ID` | — | owned IG user id | ” |
| `IGTRACK_GRAPH_USERNAME` | — | owned IG username | ” |
| `IGTRACK_GRAPH_API_VERSION` | `v21.0` | Graph API version | — |
| `IGTRACK_GRAPH_BUSINESS_DISCOVERY` | off | `1` enables the Business Discovery probe of other public professional accounts (D42) | without it, `discoverAccount` answers UNAVAILABLE with the unlock |
| `IGTRACK_IMPORT_DIR` | — | operator's own Instagram export root | missing/nonexistent → configuration error naming the variable (never UNAVAILABLE) |
| `IGTRACK_IMPORT_USERNAME` | — | the export's owner — the only account `import` observes | missing → configuration error |
| `IGTRACK_MEDIA_DIR` | `./data/media` | **RESERVED — read by nothing**; documented future home for media bytes | — |
| `IGTRACK_JOB_POLL_MS` | `5000` | worker poll interval | `<=0`/NaN → worker **refuses to boot** (`worker_invalid_config`, exit 1) |
| `IGTRACK_JOB_LEASE_MS` | `300000` | job lease before reclaim | ” (instant-reclaim would duplicate scans) |
| `IGTRACK_PROVIDER_TIMEOUT_MS` | `30000` | per provider call timeout; exceeding → typed retryable `TIMEOUT` | ” |
| `IGTRACK_JOB_MAX_ITER` | ∞ (daemon); `25` for `--once` | drain bound | `<=0` → refuses to boot |
| `IGTRACK_WORKER_ONCE` | unset | `1` = bounded one-shot worker | — |
| `IGTRACK_SCHEDULER_ENABLED` | enabled | only the exact string `"false"` disables ticking (queue still drains manual jobs) | — |
| `IGTRACK_SCHEDULER_TICK_MS` | `60000` | scheduler tick cadence | `<=0` → refuses to boot (hot-spin) |
| `IGTRACK_SCHEDULER_BATCH` | `200` | max targets per tick (fleet rotation) | invalid → falls back to 200 |
| `IGTRACK_MAINTENANCE_TICK_MS` | `3600000` | retention purge cadence | invalid → default |
| `IGTRACK_JOBS_RETENTION_DAYS` | `90` | terminal jobs older than this are purged | invalid → 90 |
| `IGTRACK_SCAN_PROFILE_MS` | `21600000` (6 h) | per-kind cadence overrides | non-finite/`<=0` → default |
| `IGTRACK_SCAN_FOLLOWERS_MS` | 6 h | ” | ” |
| `IGTRACK_SCAN_FOLLOWING_MS` | 6 h | ” | ” |
| `IGTRACK_SCAN_STORY_MS` | `1800000` (30 min) | stories live 24 h; a missed poll is a permanent gap | ” |
| `IGTRACK_SCAN_POSTS_MS` | 6 h | ” | ” |
| `IGTRACK_SCAN_INSIGHTS_MS` | 6 h | metrics lag up to 48 h; platform keeps ~90 days | ” |
| `IGTRACK_SCAN_TAGS_MS` | `86400000` (24 h) | tagged-media cadence | ” |
| `IGTRACK_SCAN_DISCOVERY_MS` | 24 h | cross-account discovery; spends the shared 200×users/hour Platform Rate Limit | ” |
| `IGTRACK_SMTP_URL`, `IGTRACK_EMAIL_FROM` | — | **reserved names only — no adapters implemented** | — |
| `IGTRACK_LOG_LEVEL` | `info` | **RESERVED, unread**; worker logs JSON lines today | — |
| `NODE_ENV` | `development` | reported in `_meta.production`; `production` + synthetic provider is a `doctor` finding | informational |

The worker's boot guard rejects non-positive/non-finite values for lease, poll,
provider timeout, scheduler tick and max-iter **in one pass**, listing every
bad key (`workers/monitoring/src/config.ts`, pinned by `worker-config.test.ts`).
Out-of-range *cadence* values silently fall back instead — the difference is
deliberate: cadences are policy, boot values are correctness.

`igtrack config` prints exactly 18 variables with a stated meaning per row —
the original 16 plus the `import` provider's `IGTRACK_IMPORT_DIR` and
`IGTRACK_IMPORT_USERNAME`, which `.env.example` documented and
`providerFromEnv()` read but the settings surface omitted (§17.2.1, fixed
2026-10-16; `CONFIG_KEYS` in `apps/cli/src/commands/setup.ts`).
`.env.example` is the complete reference for the rest.

---

## 6. The capability registry — 23 capabilities

Single source of truth in `packages/core/src/capabilities.ts`; `igtrack
capabilities` renders it; `docs/CAPABILITIES.md` is **generated** from it by
`pnpm docs:capabilities` with a drift test
(`packages/core/test/capability-matrix.test.ts`) that fails when the doc is
stale. Each entry carries: `id`, `label`, `providerMethods`, `permissions`,
`persistence` (tables), `ui` (surfaces), `howItWorks` prose,
`whyUnavailable`, `unlock`, `liveState`, `liveEvidence`.

Runtime observation (this session): **23 capabilities, 18 available**
(`igtrack capabilities --json`). Available = `whyUnavailable === null &&
providerMethods.length > 0`.

| ID | Label | Provider methods | Persists to | State |
|---|---|---|---|---|
| `PROFILE` | Public profile | `resolveAccount`, `getProfile` | `igAccounts`, `profileSnapshots`, `profileChanges`, `evidence` | available · NOT_VERIFIED |
| `COUNTS` | Follower/following/post counts | `getProfile` | `profileSnapshots` | available · NOT_VERIFIED |
| `ACCOUNT_INSIGHTS` | Own-account insights over time | `getAccountInsights` | `insightPoints`, `evidence` | available · NOT_VERIFIED |
| `OTHER_ACCOUNT_PUBLIC` | Other public professional account profile + recent media | `discoverAccount` | `profileSnapshots`, `posts`, `evidence` | available · NOT_VERIFIED (opt-in) |
| `STORIES` | Active stories | `getStories` | `stories`, `storySightings`, `evidence` | available · NOT_VERIFIED |
| `STORY_METADATA` | Story metadata | `getStories` | `stories` | available · NOT_VERIFIED |
| `STORY_MENTIONS` | Story mentions and tags | `getStories` | `storyMentions`, `evidence` | available · NOT_VERIFIED |
| `MENTION_INTELLIGENCE` | Mention roll-up (not-established-visible accounts) | `getStories` | `storyMentions`, `evidence` (read-side aggregation only) | available · NOT_VERIFIED |
| `TAGS` | Tagged media (media owned by others in which the account is tagged) | `getTags` | `taggedMedia`, `evidence` | available · NOT_VERIFIED |
| `MENTIONED_COMMENTS` | @mentions of the owned account on other media | `getMentionedComment` | — persists nothing | available · NOT_VERIFIED |
| `HIGHLIGHTS` | Story highlights | — | — | **UNAVAILABLE · DOCUMENTED_ABSENT** |
| `POSTS` | Public posts | `getPublicPosts` | `posts`, `postPresence`, `postChanges`, `evidence` | available · NOT_VERIFIED |
| `REELS` | Reels as a distinct type | `getPublicPosts` | `posts` | available · NOT_VERIFIED |
| `CAROUSELS` | Carousels and child media | `getPublicPosts`, `getPostChildren` | `posts`, `postChildren` | available · NOT_VERIFIED |
| `COMMENTS` | Public comments | `getPublicComments` | `postComments`, `evidence` | available · NOT_VERIFIED |
| `REPLIES` | Comment replies and threading | `getPublicComments` | `postComments` | available · NOT_VERIFIED |
| `FOLLOWERS` | Follower roster and history | `getFollowers` | `followSnapshots`, `followSnapshotMembers`, `followDeltas`, `evidence` | available · **DOCUMENTED_ABSENT** at the platform |
| `FOLLOWING` | Following roster and history | `getFollowing` | same as FOLLOWERS | available · **DOCUMENTED_ABSENT** at the platform |
| `LIKES` | Public like data | — | — | **UNAVAILABLE · DOCUMENTED_ABSENT** |
| `INTERACTIONS` | Interaction history | — | `interactions` (dormant table) | **UNAVAILABLE · DOCUMENTED_ABSENT** |
| `REPOSTS` | Repost count metadata (scalar) | `getPublicPosts` | `posts.repostsCount` | available · NOT_VERIFIED |
| `RESHARES` | Reshare relations (who reposted) | — | — | **UNAVAILABLE · DOCUMENTED_ABSENT** |
| `MEDIA` | Media bytes and assets | — | `mediaAssets` (dormant) | **UNAVAILABLE · DOCUMENTED_ABSENT** |

Condensed registered reasons / unlocks (verbatim text in `docs/CAPABILITIES.md`
and the registry):

- `HIGHLIGHTS` — the exhaustive IG User edge list (v21.0–v26.0) has no
  highlights edge; the only alternative is the undocumented `reels_media`
  private endpoint, which the project forbids. Unlock: *an official,
  documented highlights edge.*
- `FOLLOWERS`/`FOLLOWING` — no roster edge exists (counts-only is provider
  design, not an auth tier). Still *available* because the operator's own
  export (`import` provider) and fixtures supply them lawfully; diffs only
  between COMPLETE snapshots. Unlock: *a supported list endpoint.*
- `LIKES` — only `like_count` exists; no actor edge (the Facebook Comment
  likes edge is Facebook-only and must not be conflated). Unlock: *a
  documented IG liker feed.*
- `INTERACTIONS` — no interaction feed in the platform reference; the insights
  edge was considered and rejected (aggregates, no actors/timestamps).
  Activation criteria: *a provider method returning actor, kind, timestamp,
  and evidence.*
- `RESHARES` — no repost object/reshare edge anywhere; this is the §14
  repost-identities refusal. Unlock: *a documented repost object or reshare
  edge. No credential can unlock a node that does not exist.*
- `MEDIA` — expiring CDN URLs with documented omission rules are never stable
  enough to archive; metadata links render as user-initiated outbound links
  only. Unlock: *provider-supplied stable URLs plus documented download
  permission.*

`liveState` vocabulary: `LIVE_VERIFIED` | `NOT_VERIFIED` | `DOCUMENTED_ABSENT`
(with `liveEvidence` prose). Everything Graph-backed is currently
`NOT_VERIFIED` because this deployment has no credentials — *"Request shape is
docs-pinned"*, verifiable with `pnpm verify:graph` (§15). `DOCUMENTED_ABSENT`
is stated as *"a finding, not a gap in the work."*

Registry consumers: `opCapabilities` (CLI/MCP), the web diagnostics page (in
the retired app), the CAPABILITIES.md generator, and consistency tests that
pin registry ↔ provider methods ↔ schema tables ↔ evidence writers
(`packages/database/test/capability-consistency.test.ts`,
`docs/ARCHITECTURE.md:94-100`).

---

## 7. Ingestion — providers, schemas, normalizers, field audit

### 7.1 Provider contract (`packages/core/src/provider.ts`)

`InstagramProvider` = `sourceId` + `capabilities()` + **12 methods**
(`CapabilityName`): `resolveAccount`, `getProfile`, `getStories`,
`getFollowers`, `getFollowing`, `getPublicPosts`, `getPublicComments`,
`getPostChildren`, `getTags`, `getMentionedComment`, `getAccountInsights`,
`discoverAccount`. Contract rules: a result without `nextCursor` is a
**complete listing**; a complete empty tags listing *is* a claim ("no tags
observed"); the platform id is an output, never a lookup key (D44); a provider
with no route for a capability reports UNAVAILABLE with the reason (and the
unlock when one exists). `cursor: { value: string }`.

A key nuance surfaced while documenting: **capability flags and method
behavior are deliberately decoupled** — the graph provider declares
`getFollowers/getFollowing: false` yet implements both, returning honest
UNAVAILABLE-with-reason; the fixture declares `getPostChildren: false` and
returns UNAVAILABLE; `import` declares only its three routes true. Consumers
must branch on the *result status*, not only the flag.

### 7.2 `fixture` — the default provider

`FixtureProvider` (`fixtures/v1/`, `sourceId = "fixture:v1"`). The manifest
pins `target_username: "aurora.wilde"`, `captured_at: 2026-08-27T09:15:00Z`
and file lists; **manifest version ≠ declared version fails fast** ("serving a
v2 directory while labelled v1 would poison every evidence row with a false
source id"). Optional files absent → UNAVAILABLE-with-reason, never a schema
rejection. Fixture set: profile, stories, **two** follower pages (the only
pagination exercise), one following page, one posts page, comments for post-1,
insights, discovery, tags, mentioned-comments.

| Method | Result |
|---|---|
| `resolveAccount` / `getProfile` | AVAILABLE (HIGH); wrong username → `ACCOUNT_NOT_FOUND`; private flag → `ACCOUNT_PRIVATE`; raw hash of the profile file |
| `getStories` | AVAILABLE; canvas dims feed mention classification |
| `getFollowers`/`getFollowing` | AVAILABLE; cursor = next page's `next_cursor`; unknown cursor → `INTERNAL` (never a guessed page) |
| `getPublicPosts` | AVAILABLE HIGH on last page, MEDIUM + `nextCursor` otherwise |
| `getPublicComments` | AVAILABLE, or **PARTIAL** when the payload declares unservable further pages; missing per-post file → UNAVAILABLE |
| `getPostChildren` | UNAVAILABLE always — "never an empty album masquerading as observed structure" |
| `getTags` | AVAILABLE, PARTIAL when payload declares more |
| `getMentionedComment` | AVAILABLE for ids present in the file; unknown id → UNAVAILABLE |
| `getAccountInsights` | AVAILABLE (MEDIUM); mirrors the below-100-followers gate from the profile's own count and appends absences with the verbatim platform text |
| `discoverAccount` | AVAILABLE (HIGH) with `recentMedia` sliced to `DISCOVERY_MEDIA_PREVIEW_LIMIT` (12) and `recentMediaLimit: 12`; own target → UNAVAILABLE "use the profile path" |

All fixture errors are `retryable: false`; parse failures stay inside the
capability model (never thrown).

### 7.3 `graph` — the official-API provider

`GraphProvider` (`sourceId = "graph:v1"`), config from env (§5): three
required credentials, optional `IGTRACK_GRAPH_API_VERSION` (default `v21.0`)
and the `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` opt-in ("an empty, misspelled, or
placeholder value must not silently widen the provider's read scope"). Token
travels only in the `Authorization` header; 15 s request timeout.

Request-shape constants (exported; pinned by the field-coverage audit):

| Constant | Value (abridged) |
|---|---|
| `GRAPH_PROFILE_FIELDS` | `id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website` |
| `GRAPH_MEDIA_FIELDS` | `id,caption,timestamp,like_count,comments_count,permalink,shortcode,media_type,media_product_type` — **`reposts_count` deliberately excluded** |
| `GRAPH_CHILD_FIELDS` | `id,media_type,permalink,shortcode,timestamp` |
| `GRAPH_STORY_FIELDS` | `id,timestamp,media_type,caption` |
| `GRAPH_COMMENT_FIELDS` | id/text/username/timestamp/parent_id/like_count/from + one-level `replies{…}` expansion |
| `GRAPH_TAG_FIELDS` | `id,username,caption,permalink,media_type,timestamp` (no `limit` sent) |
| `GRAPH_MENTIONED_COMMENT_FIELDS` | `timestamp,like_count,text,id,media` |
| Insights | time series `follower_count,reach`; totals `accounts_engaged,total_interactions,views`; demographics `follower_demographics` (`lifetime`/`this_month`/`country`); `GRAPH_INSIGHTS_WINDOW_DAYS = 30` (explicit — documented default is 24 h) |
| Discovery | `GRAPH_DISCOVERY_MEDIA_LIMIT = 12`; `graphDiscoveryFields(username)` embeds the username in the `fields` expression |

Method semantics worth recording:

- `resolveAccount` — **only the owned username**; any other → `ACCOUNT_NOT_FOUND` ("never probed, never scraped").
- `getStories` — graph exposes **no story-mention read path**; mentions come out empty *by provider design* (the fixture exercises the full mention pipeline synthetically).
- `getPublicPosts` — `limit=25` + `after` cursor; cursor present → **PARTIAL** with `nextCursor`.
- `getPublicComments` — nested replies are flattened in the same call with the enclosing comment as parent ("authoritative even when the nested parent_id is absent"); author falls back to `"unknown"`, never fabricated.
- `getPostChildren` — separate edge per album; a child failure degrades to partial, never endangers the parent.
- `getTags` — cursor paging; result carries `complete` + `nextCursor`; rows are references, never the account's own media.
- `getMentionedComment` — `?fields=mentioned_comment.comment_id(<id>){…}`; ids arrive only via Meta webhooks; non-numeric `like_count` strings stay absent (never coerced), timestamp stored verbatim; nothing persisted.
- `getAccountInsights` — **three documented calls in one method**; a 400/404 (`GraphFailure.unavailable`) converts those metrics into absence rows carrying the platform's own message, while auth/rate-limit/network/5xx rethrow as failures: *"a temporary error must never be recorded as 'the platform doesn't expose this'."* No raw hash (three calls); MEDIUM.
- `discoverAccount` — username guard `/^[a-z0-9._]{1,30}$/` (the value is embedded in a `fields` expression); flag off → UNAVAILABLE naming the unlock; consumer/private/age-gated → UNAVAILABLE ("never an empty profile and never a zero"); success note states the preview is bounded (12), "not the account's full post history"; MEDIUM; no hash (probe, not record).
- `probeMediaNode(mediaId, fields)` — read-only helper for `scripts/verify-graph-provider.ts`; no executor calls it; exists because "an unknown `fields` name fails the WHOLE Graph request."

Error mapping (`graphHttpFailure` → `providerFailure`, honored on every catch
path): 401/code-190 → `AUTH_REQUIRED` (false — "configuration failures, never
retried as data"); 403 → `FORBIDDEN` false; 429 → `RATE_LIMITED` true with
`retryAfterMs = retry-after × 1000`; **400/404 → PROVIDER_ERROR with
`unavailable: true` → surfaced as UNAVAILABLE**; ≥500 → retryable
`PROVIDER_ERROR`; fetch timeout → `TIMEOUT` true; network → `NETWORK` true.

### 7.4 `import` — the operator's own export

`ImportProvider` (`sourceId = "import:v1"`) reads the Instagram "Download your
information" export — *"the only lawful path to a REAL follower/following
roster."* Capabilities: `resolveAccount`, `getFollowers`, `getFollowing` only,
"declared exactly, so doctor and the capability matrix never over-claim."

- `resolveRosterDir` tries `<dir>/connections/followers_and_following`, then
  `<dir>` itself, else **throws at construction** (configuration error, never
  UNAVAILABLE); empty username also throws.
- Followers: `followers_<n>.json` sorted **numerically**; bare `followers.json`
  only when no numbered files exist. Following: `following.json`.
- Entries: `{title?, string_list_data:[{href?, value?, timestamp?}]}` — an
  entry with neither value nor title **fails loudly** ("rather than silently
  shrinking the roster"); dedupe case-insensitive, first casing kept.
- Paging: **one raw export file = one page**; the cursor is the next filename;
  unknown cursor → `INTERNAL`, "never a guessed page"; COMPLETE only on the
  last file; each file carries `rawPayloadHash = sha256(file text)` and
  `rawReference = import:v1/<file>` — genuine payload hashes.
- Every other method → UNAVAILABLE with a capability-specific reason
  (profile absent, insights not in export, discovery points at Business
  Discovery, etc.).

### 7.5 Raw schemas v1 (`raw-schemas/v1.ts`) — 18 zod schemas

`isoDatetime = z.string().datetime({ offset: true })` everywhere. Schemas:
`rawUserV1`, `rawProfileV1`, `rawMentionV1`, `rawStoryV1`, `rawStoriesV1`,
`rawFollowPageV1` (each with `schema_version: "v1"`, `captured_at`),
`rawPostV1` (`reposts_count?` — "absence is an absence, never a zero"),
`rawPostsPageV1`, `rawCommentV1`, `rawCommentsPageV1`, `rawInsightPointV1`,
`rawInsightAbsenceV1` (**reason min length 1** — "an absence without a reason
would be indistinguishable from missing data"), `rawInsightsV1`,
`rawDiscoveryV1`, `rawTaggedMediaV1`, `rawTagsPageV1`,
`rawMentionedCommentV1`, `rawMentionedCommentsV1`. 13 inferred types exported.

Normalizers (`normalize/*`): `normalizeProfile`, `normalizeStory`,
`normalizeMention`, `normalizeFollowPage` (`complete = next_cursor === null`),
`normalizePosts` (maps `reposts_count` when present), `mapRawMediaType`,
`normalizeComments`, `normalizeTagPage` (page-level completeness so "a partial
listing can never masquerade as a complete one"), `normalizeMentionedComment`.

### 7.6 Field-coverage audit (`graph/field-coverage.ts`) — 81 rows

"RAW RESPONSE → PROVIDER TYPE → NORMALIZER → DOMAIN MODEL → DATABASE → QUERY
→ API → UI. One row per provider field we considered." Statuses: `MAPPED` 41,
`READ_THROUGH` 5, `INTENTIONALLY_IGNORED` 15, `UNVERIFIED` 6, `PROVIDER_ABSENT`
14. `requested: true` on exactly the 46 MAPPED+READ_THROUGH rows, pinned by
test against the `GRAPH_*_FIELDS` constants.

Highlights: `website→externalUrl` MAPPED ("Recovered 2026-09");
`account_type`/`is_verified`/`category` PROVIDER_ABSENT ("stay null until a
provider exposes it"); `media_url`/`thumbnail_url` INTENTIONALLY_IGNORED
(expiring CDN, no archival policy); `reposts_count` UNVERIFIED ("a bad field
fails the whole listing, so it is not in `GRAPH_MEDIA_FIELDS` yet");
`user_tags (read)`, `expiry`, `reshared stories` PROVIDER_ABSENT; tags rows
all MAPPED; mentioned-comment rows READ_THROUGH (no `persistedIn`); structural
absence rows for rosters, highlights, likers, interactions, reshare edge and
media bytes.

Machinery: `REQUESTED_FIELDS_BY_AREA` (7 areas), `COVERAGE_AREA_BY_CAPABILITY`
(8 probe capabilities), `coverageKeysForArea(area, keySpace)` with key spaces
`provider` (raw graph field names) and `normalized` (last segment of
`mappedTo`, "flags normalizer drift"), and `findUnmappedFields(...)` feeding
the `NEW_PROVIDER_FIELD_NOT_MAPPED` diagnostic emitted by `pnpm verify:graph`.

---

## 8. Domain core (`packages/core`, zero runtime dependencies)

### 8.1 `CapabilityResult` — the honesty type

`CapabilityStatus`: `AVAILABLE` | `PARTIAL` | `UNAVAILABLE` | `ERROR`.
Result fields: `status`, `data?`, `observedAt`, `source: SourceRef`,
`confidence`, `note?`, `error?`, `rawPayloadHash?` ("genuine hash of the RAW
source payload — never derived from normalized data"), `rawReference?`,
`nextCursor?` ("absent means the listing is complete").

Constructors enforce the invariants:
- `available(data, meta)` — no `note` slot (three providers attach a note
  post-construction, the only place an AVAILABLE may carry one).
- `partial(data, meta)` — `note` is **required**.
- `unavailable(meta, note)` — **`data` omitted**, `confidence: "UNKNOWN"`, no
  error; the reason rides the `note`.
- `errored(meta, error)` — no `data`, `confidence: "UNKNOWN"`.
- `isUsable(result)` — true only for AVAILABLE|PARTIAL with defined data.

`SourceKind`: `FIXTURE` | `IMPORT` | `GRAPH_API` | `USER_PROVIDED`.

### 8.2 Errors and retryability

`CapabilityErrorKind` (12): `SOURCE_NOT_FOUND`, `ACCOUNT_NOT_FOUND`,
`ACCOUNT_PRIVATE`, `RATE_LIMITED`, `SCHEMA_MISMATCH`, `NETWORK`,
`AUTH_REQUIRED`, `FORBIDDEN`, `TIMEOUT`, `PROVIDER_ERROR`, `INTERNAL`,
`UNKNOWN`. Retryable set: `{RATE_LIMITED, NETWORK, TIMEOUT, PROVIDER_ERROR,
INTERNAL}`. `effectiveRetryability(kind, override?)` — only `override === false`
wins; "a non-retryable kind is permanently non-retryable regardless of
override" (providers may only downgrade). `retryAfterMs` is "honored verbatim
by the worker as the job's next availability time; never combined with
exponential backoff."

Separate application-error plane: `AppErrorCode` (10: `VALIDATION_ERROR`,
`NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`,
`CAPABILITY_UNAVAILABLE`, `PROVIDER_ERROR`, `DATABASE_ERROR`, `JOB_ERROR`,
`INTERNAL_ERROR`), `class AppError`, `isAppError`.

### 8.3 Epistemics and evidence

`ObservationCategory`: `OBSERVED`, `DERIVED`, `INFERRED`, `UNAVAILABLE`.
`Confidence`: `HIGH`(3), `MEDIUM`(2), `LOW`(1), `UNKNOWN`(0); helpers
`confidenceRank`, `higherConfidence`.

`Evidence` = `{observationKind, observationId, sourceType, sourceReference?,
observedAt, capturedAt, confidence, rawHash, normalizedHash}`.
`stableStringify` — deterministic JSON (sorted keys, `undefined`-valued keys
dropped). **Core computes no hashes**; providers hash raw payload text, the
worker computes `normalizedHash = sha256(stableStringify(payload))`.

`TargetStatus`: `ACTIVE` | `PAUSED` | `STOPPED`;
`isLegalTargetTransition` (ACTIVE↔PAUSED→STOPPED; STOPPED terminal; no
self-transition).

### 8.4 Models (29 exports, `models.ts`)

Honesty-bearing highlights: `NormalizedPost.permalink` "never reconstructed";
`children` "present ONLY when the provider returned them — absence ≠
single-item post"; `repostsCount` "never zero-filled";
`NormalizedComment.likeCount` "absent when the provider omits it";
`NormalizedStory.linkUrl` "absent when the provider exposes no URL — never
fabricated from the boolean"; `NormalizedTaggedMedia` "a reference, not the
account's media"; `NormalizedInsightAbsence.reason` "never a value claim of
any kind"; `NormalizedDiscoveredAccount.recentMediaLimit` "absent means the
route declared no ceiling (then nothing may claim one)";
`InteractionKind.LIKE_SIGNAL` "describes a shape, not a source";
`DISCOVERY_MEDIA_PREVIEW_LIMIT = 12`.

### 8.5 Mention classification (`mentions.ts`) — precedence is the contract

1. `isHidden === true` → `POSSIBLY_HIDDEN` (first, overrides geometry).
2. Full geometry (`x,y,width,height`) **plus** canvas dims → `OFF_CANVAS`
   when the rectangle lies fully outside the canvas, else `VISIBLE`.
3. Full geometry **without** canvas dims → `UNKNOWN` ("geometry half-present
   is not a visibility claim").
4. `isHidden === false` → `VISIBLE`.
5. Fallback → `METADATA_ONLY`.

"Not established visible" = `POSSIBLY_HIDDEN | OFF_CANVAS | METADATA_ONLY`;
**`UNKNOWN` is deliberately excluded** — "treating it as hidden would convert
absence of evidence into a finding"; "nothing here is proof of intent to
hide." Aggregation (`aggregateMentionIntelligence`): per-story dedupe first
(hidden if any row hidden), per-username case-insensitive accumulation with
first-observed casing, distinct classes in declared order, deterministic sort
(hiddenMentions desc → stories desc → username asc). Pure read-side — "fetches
nothing, adds no provider method, and writes no new table."

### 8.6 Diffs — and where the PARTIAL refusal actually lives

`diffFollowSets(previous, next)` — set-based, sorted `added`/`removed` +
`unchangedCount`; content-blind.
`diffProfileFields(previous, next)` — 10-field fixed order (`username`,
`displayName`, `bio`, `profilePicUrl`, `externalUrl`, `followerCount`,
`followingCount`, `postCount`, `isVerified`, `isPrivate`), `undefined → null`
normalization so first-appearance and disappearance both register.

**The core primitives have no completeness parameter.** The "partial never
becomes a claim" refusal is enforced by callers, and knowing exactly where is
essential to the design:
- Follows: `workers/monitoring/src/executors.ts:843-856` gates `persistFollowDiff`
  on `lastPageComplete && previous.completeness === "COMPLETE"` — pinned by
  `workers/monitoring/test/posts-paging.test.ts:483` ("never diffs a PARTIAL
  snapshot (no fabricated LOST_*)").
- Profiles: `packages/database/src/repositories/observations.ts:193-200`
  requires COMPLETE on **both** sides — pinned by
  `packages/database/test/persistence.test.ts:146`.
- Posts: `NO_LONGER_OBSERVED` only from a complete media listing; DISCOVERY
  previews never diffed.

`capability-matrix.ts` renders `docs/CAPABILITIES.md` from the registry
("a hand-written matrix drifts … and the drift always errs in the flattering
direction"); a test fails when the doc is stale.

---

## 9. Observation engine — queue, scheduler, worker

### 9.1 Job queue (`packages/database/src/jobs/queue.ts`)

| Behavior | Detail |
|---|---|
| Terminal reap | `running` + expired lease + `attempts >= max_attempts` → `failed` with `{kind:"LEASE_EXPIRED", retryable:false}` |
| Claimable set | (`queued`/`retry_wait` and `available_at <= now`) or (`running`, lease expired, `attempts < max`) |
| Same-kind serialization | never two running jobs of one kind for one target (checkpoint isolation), via `NOT EXISTS` |
| Order | `priority DESC, available_at ASC, id ASC`, `LIMIT 1`, `FOR UPDATE SKIP LOCKED` |
| Claim mutations | `attempts+1`, lease set, `started_at = coalesce(started_at, now)` — **preserved across retries so a logical scan keeps one instant** |
| Complete | ownership re-checked in the UPDATE; mismatch → `JobStateError` |
| Fail | retryable && attempts<max → `retry_wait` (`available_at = now + clamp(retryAfterMs, backoff)`); else `failed` + `completed_at`; `error = {message, kind?, retryable, failedAt, attempt}` |
| Backoff | `30_000 × 2^(min(attempts-1,20))`, cap `900_000`; `retryAfterMs` honored (clamped to 1 h) |
| Max attempts | schema default 3; the worker never sets it |
| Cancel | `cancelJob` on `queued`/`retry_wait` only |
| Retention | terminal `succeeded|failed|cancelled` older than `IGTRACK_JOBS_RETENTION_DAYS` (90) purged by the maintenance tick; non-terminal never touched |
| Lease renew | sets `locked_at=now()` only while `running AND locked_by=workerId`; `false` = lost |

Job statuses: `queued, running, retry_wait, succeeded, failed, cancelled`.
Outcomes: `COMPLETED, COMPLETED_EMPTY, COMPLETED_PARTIAL, UNAVAILABLE,
SKIPPED_PAUSED, SKIPPED_STOPPED`.

### 9.2 Scheduler (`workers/monitoring/src/scheduler.ts` + `jobs/schedule.ts`)

Orchestration only — no provider logic. Enabled unless
`IGTRACK_SCHEDULER_ENABLED="false"`; tick `IGTRACK_SCHEDULER_TICK_MS`
(default 60 s); batch `IGTRACK_SCHEDULER_BATCH` (default 200, floored).

- **Fleet rotation** (S11): `rotationKey = floor(now/60000)`;
  `offset = (rotationKey % pageCount) × batchLimit` — "a stable ORDER BY +
  fixed LIMIT would starve every target beyond the first batch." Pinned with
  250 targets across 2 rotation keys → all 250 covered.
- **Mode filter before user prefs**: `kindsForTarget(scanKinds,
  observationMode)` — a DISCOVERY target can never be scheduled for an owned
  kind (D47).
- **Per-target cadence**: `max(1, floor(base × clamp(mult, 0.25, 8)))`.
- **Window**: `floor(now/interval) × interval`.
- **Stagger**: deterministic FNV-1a hash of the target id modulo the interval,
  `availableAt = windowStart + stagger` — "fully observable via the job's
  `available_at`"; lives in the DB layer so a web layer could forecast the
  identical schedule.
- **Dedupe key**: `sched:<kind>:<targetId>:<windowStart ISO>` — "a bare
  target+kind key would permanently suppress all future scans."
- **Race-safe enqueue**: one `INSERT … SELECT … FROM targets WHERE
  status='ACTIVE' AND (observation_mode='DISCOVERY') = (kind='DISCOVERY_SCAN')`
  + `ON CONFLICT (idempotency_key) DO NOTHING` — the mode is read in the same
  statement that inserts, so it cannot go stale.
- **Health**: `scheduler_state` singleton (`last_tick_at`, `last_success_at`,
  `last_error{message≤300,failedAt}`), surfaced by `status`/`doctor`.

Default cadences: profile 6 h, followers 6 h, following 6 h, stories 30 min,
posts 6 h, insights 6 h, tags 24 h, discovery 24 h. All eight overridable
(§5). Pinned behaviors: second tick dedupes to 0 enqueued / 7 deduplicated;
two concurrent instances converge (6 enqueued total); PAUSED → nothing
considered; dead DB → tick throws, recovery clears `last_error`.

### 9.3 Worker loop (`workers/monitoring/src/index.ts`)

Worker id `worker-<pid>-<epoch>`; poll `IGTRACK_JOB_POLL_MS` (5 s); iteration
bound `IGTRACK_JOB_MAX_ITER` (∞ daemon, 25 one-shot); scheduler tick due
first iteration; maintenance tick on the **first iteration too**; idle →
delay (no spin); poll errors logged and loop continues; a failing scheduler
tick advances the tick clock regardless (retries at interval, not per poll);
shutdown cooperative (SIGINT/SIGTERM checked between iterations, in-flight
job finishes, no forced abort); `--once`/`IGTRACK_WORKER_ONCE=1` runs a
bounded drain and **exits 1 if any error was recorded** (fail-loud in CI),
daemon semantics unaffected. Boot guard: invalid boot values → logged
`worker_invalid_config` and exit 1 *before* opening the pool.

The failure boundary (`executeOne`) distinguishes: `JobExecutionError` →
`retry_wait`/`failed` per retryability; `JobStateError` (ownership race) →
`lost` (the rival owns the job); `PostgresError` (walking up to 5 `cause`
links) → retryable `DATABASE`; anything else → `failed`,
`error.kind:"UNEXPECTED"`; recorded outcome states:
`succeeded | retry_wait | failed | lost | unrecorded | none`. An unknown job
kind → non-retryable `UNKNOWN_JOB`. A non-ACTIVE target short-circuits
pre-dispatch to `SKIPPED_PAUSED`/`SKIPPED_STOPPED` (`state:"succeeded"`); a
pause landing *after* claim does **not** stop the in-flight scan — "its
observations are genuine" (pinned).

### 9.4 Job kinds — eight executors

`JobResult → outcome`: `succeeded→COMPLETED`,
`succeeded-empty→COMPLETED_EMPTY`, `succeeded-partial→COMPLETED_PARTIAL`,
`unavailable→UNAVAILABLE`.

| Kind | Gate | What it does |
|---|---|---|
| `PROFILE_SCAN` | `getProfile` | appends a `profile_snapshots` row (never overwrites), diffs field changes **only between COMPLETE snapshots**, one evidence row; observation id `profile:<username>@<observedAt>` |
| `DISCOVERY_SCAN` | `discoverAccount` | execute-time mode guard (only DISCOVERY targets); profile snapshot written COMPLETE (the documented field set *is* the whole set, so it is diffable); media preview rows with `commentsState: UNAVAILABLE` (structural — no route returns another account's media comments); per-media evidence metadata carries `previewPosition`, `previewLimit`, `previewBounded`; **always `COMPLETED_PARTIAL` when a preview limit is set** (D48); re-runs dedupe |
| `FOLLOWER_SCAN` / `FOLLOWING_SCAN` | `getFollowers`/`getFollowing` | one shared engine; logical scan identity = `job.startedAt` (preserved across retries); checkpoint owned by job id; **staging** (`follow_scan_staging`, unique `(job_id, username_lower)`) with per-page durable writes, lease heartbeat per page (lost → non-retryable `LEASE_LOST`), crash-resume keeps every acquired page; snapshot + members + one evidence row (confidence = final page's confidence, never forced HIGH); **deltas only between two COMPLETE snapshots**; empty roster → `succeeded-empty` |
| `STORY_SCAN` | `getStories` | per story: row + mentions (per-mention evidence) + **sighting on every scan that sees it** (wall-clock scan time, deliberately not the provider timestamp); PARTIAL preserved, never upgraded; zero stories → `succeeded-empty`; dedup across scans → 1 row, 2 sightings |
| `TAGS_SCAN` | `getTags` | owned-only execute-time guard (raw-inserted job still refused, zero provider calls); page cap 25 with cursor-loop guard; page UNAVAILABLE on page 0 → nothing stored, after items → break (tail unavailable, what was read is still real); writes one `tagged_media_listing` evidence row + append-only rows sharing it; first-observation-wins, removal never claimed |
| `POSTS_SCAN` | `getPublicPosts` (+comments, +children) | checkpoint resume; comments fetched **before** each post row (posts are append-only, per-post comment state must be known at insert); duplicate cursor → truncated, never a loop; children only for `CAROUSEL` when the gate is on; owned targets record `post_presence` + `post_changes` (caption edits deduped on `(post, change, detected_at)`); **absence (`NO_LONGER_OBSERVED`) only from a COMPLETE media listing** — completeness tracked separately from comment/children truncation; media change tracking is owned-only (DISCOVERY previews record nothing) |
| `INSIGHTS_SCAN` | `getAccountInsights` | `recordInsightSet` appends points **and absence rows** (value null + required reason, never 0, never a failure); evidence metadata records the requested window; UNAVAILABLE → no rows at all; zero points → `succeeded-empty` |

Cross-cutting executor mechanisms: every provider call crosses
`providerCall()` → timeout, call counting, hang → typed retryable `TIMEOUT`;
`recordProviderMetrics` writes `capability_metrics` (ok/timedOut/rateLimited/
latencyMs) and can never break a scan; `evidenceFrom` builds every evidence
row (rawHash **only when the provider transported a raw representation** —
"a normalized hash must never masquerade as one"); `sourceKindFor` maps the
source-id prefix (fixture/import/graph/user; unknown class → `IMPORT`).

Notable quirk recorded for operators: `renewLease` returns `true` on a
renewal *exception* — a heartbeat DB error is indistinguishable from success
to the caller; the ownership guards in `completeJob`/`failJob` are the
backstop.

**There is no job kind for `getMentionedComment`** — the mentioned-comment
capability is served only by the stateless CLI/MCP probe.

---

## 10. Persistence (`packages/database`)

Drizzle schema + **hand-authored migrations 0000–0019** (journal idx 0–19;
snapshots exist only for 0000–0005). **28 live tables**, **17 enums**, **16
append-only triggers**, **4 CHECK constraints**. PKs are app-generated text
UUIDs; every table gets `created_at` except `follow_snapshot_members`,
`source_health`, `capability_metrics`, `scheduler_state`. FK policy: `users →
targets` CASCADE; target-scoped rows CASCADE from `targets`; `ig_accounts`
**RESTRICT everywhere** (the shared registry survives target deletion);
evidence links are SET NULL on the observation side plus explicit deletion by
`deleteTargetWithObservations`.

### 10.1 The 28 tables

| Table | Purpose and key facts |
|---|---|
| `users` | Pure ownership scope (invariant 9). `email` UNIQUE. **No credentials** — auth columns dropped by 0013 |
| `sources` | Provider registry (`fixture`/`graph`/`import`/`user_provided`) with `provider_version` |
| `ig_accounts` | Shared account registry; identity is the platform id (D52), `username_lower` UNIQUE, partial unique on `ig_id`; `is_private`/`is_verified` nullable tri-state — UNKNOWN is never written as `false` (0002) |
| `targets` | Operator-directed target; `(user_id, ig_account_id)` UNIQUE; `observation_mode` OWNED/DISCOVERY (D47); `scan_cadence_mult` 0.25–8; `scan_kinds` NULL=all |
| `evidence` | The provenance ledger. `(observation_kind, observation_id)` UNIQUE; `raw_hash` CHECK `char_length = 64`, NULL-legal — a normalized hash must never masquerade as a raw one |
| `profile_snapshots` | Append-only profiles; `(account, source, observed_at)` UNIQUE; `completeness` COMPLETE/PARTIAL gates diffing (0014) |
| `profile_changes` | Derived field diffs between COMPLETE snapshots; `(account, field, to_snapshot_id)` UNIQUE |
| `stories` | First-observation-wins, immutable; `(account, story_id, source)` UNIQUE; sticker/poll/question/location/music JSONB; `link_url` never fetched |
| `story_mentions` | Per-story mentions with geometry + `visibility_class` beside `raw_visibility_flag`; `(story, mentioned_account)` UNIQUE |
| `story_sightings` | Append-only re-observation log (0010); `(story, observed_at)` UNIQUE so retries collapse; one row per scan that still sees the story |
| `posts` | Owned-target media, insert-once; `(account, post_id, source)` UNIQUE; `comments_state` OBSERVED/UNAVAILABLE/NOT_SCANNED; `reposts_count` NULL = not returned |
| `post_comments` | Insert-once per comment; `like_count` NULL = provider omitted; `in_reply_to_comment_id` source-scoped threading |
| `post_children` | Carousel items in provider order (`position`); written only from returned children |
| `post_presence` | Phase G mutable current state (D54): PRESENT/ABSENT per stored post; `last_scan_at` = our logical scan instant; **deliberately not append-only** |
| `post_changes` | Append-only CAPTION_EDITED / NO_LONGER_OBSERVED; `(post, change, detected_at)` UNIQUE |
| `tagged_media` | §17 tags edge: media owned by others; insert-once, first-observation-wins, no removal claim; never rendered as the account's own media |
| `follow_snapshots` | `(target, direction, taken_at, source)` UNIQUE; `completeness`; `total_observed`; `cursor_state` |
| `follow_snapshot_members` | Composite PK `(snapshot_id, ig_account_id)` — membership is the fact; no id, no created_at |
| `follow_deltas` | NEW/LOST × FOLLOWER/FOLLOWING; 5-column idempotency unique; `first_seen_at` = to-snapshot's `takenAt` |
| `insight_points` | **Value XOR reason** CHECK; `value` double precision (exact round-trip, not real); coalesce-expression idempotency index; absences are rows |
| `interactions` | Reserved, **writerless by decision**; dormancy pinned by test |
| `media_assets` | Reserved, **writerless by decision**; `content_hash` UNIQUE; `retention_state` for a future byte path |
| `monitoring_jobs` | Queue state machine; partial unique `idempotency_key`; CHECKs `attempts >= 0`, `max_attempts > 0`; claim index only over queued+retry_wait |
| `job_checkpoints` | One row per `(target, kind)`; cursor/page/progress + last job |
| `follow_scan_staging` | Durable acquired members (`bigserial` id = first-acquisition order); `(job_id, username_lower)` UNIQUE; foreign-job rows cleared at scan start |
| `scheduler_state` | Singleton `id='default'`; last tick/success/error for diagnostics |
| `source_health` | Per `(source, capability)`: HEALTHY/DEGRADED/UNAVAILABLE, consecutive failures incremented atomically in the upsert |
| `capability_metrics` | Best-effort operational counters per `(source, capability)` — never on the correctness path |

### 10.2 The 17 enums

`target_status` (ACTIVE, PAUSED, STOPPED) · `follow_direction` (FOLLOWERS,
FOLLOWING) · `observation_mode` (OWNED, DISCOVERY) · `snapshot_completeness`
(COMPLETE, PARTIAL) · `follow_change` (NEW_FOLLOWING, LOST_FOLLOWING,
NEW_FOLLOWER, LOST_FOLLOWER) · `post_presence_state` (PRESENT, ABSENT) ·
`post_change_kind` (CAPTION_EDITED, NO_LONGER_OBSERVED — never "deleted") ·
`interaction_kind` (COMMENT, REPLY, MENTION, TAG, LIKE_SIGNAL) ·
`observation_category` (OBSERVED, DERIVED, INFERRED, UNAVAILABLE) ·
`confidence_level` (HIGH, MEDIUM, LOW, UNKNOWN) · `mention_visibility`
(VISIBLE, POSSIBLY_HIDDEN, OFF_CANVAS, METADATA_ONLY, UNKNOWN) · `media_type`
(IMAGE, VIDEO, CAROUSEL, UNKNOWN; rebuilt in 0007 via `media_type_v2`) ·
`job_status` (queued, running, retry_wait, succeeded, failed, cancelled) ·
`job_outcome` (COMPLETED, COMPLETED_EMPTY, COMPLETED_PARTIAL, UNAVAILABLE,
SKIPPED_PAUSED, SKIPPED_STOPPED) · `source_health_status` (HEALTHY, DEGRADED,
UNAVAILABLE) · `source_kind` (FIXTURE, IMPORT, GRAPH_API, USER_PROVIDED) ·
`retention_state` (RETAINED, PENDING_DELETION, DELETED).

### 10.3 Append-only enforcement

One PL/pgSQL function `igtrack_reject_update()` fires a `<table>_no_update`
BEFORE UPDATE trigger on **16 tables**: the 9 original (0000) + 2 in 0006
(posts, post_comments) + 1 in 0011 (post_children) + 1 in 0014
(story_sightings) + 1 in 0015 (insight_points) + 1 in 0017 (post_changes) +
1 in 0018 (tagged_media). `test/schema.test.ts:65` pins exactly 16 — adding a
17th requires a founding decision. `post_presence` is the one Phase-G table
**without** a trigger, by design: it is mutable current state, not a claim.

The four CHECKs: `evidence_raw_hash_length_chk`, `insight_points_value_xor_reason_chk`,
`monitoring_jobs_attempts_chk`, `monitoring_jobs_max_attempts_chk`.

### 10.4 Migrations, 0000–0019

| # | Name | Highlights |
|---|---|---|
| 0000 | `chilly_jimmy_woo` | 17 core tables + all FKs/indexes + the 4 CHECKs + the 9 original triggers — append-only shipped with the schema |
| 0001 | `slow_liz_osborn` | `sessions` + `users.password_hash` (the web-auth experiment) |
| 0002 | `futuristic_zemo` | drops DEFAULT/NOT NULL on `is_private`/`is_verified` — UNKNOWN becomes representable |
| 0003 | `shiny_human_cannonball` | `evidence.raw_hash DROP NOT NULL` |
| 0004 | `romantic_wallow` | `scheduler_state` + `monitoring_jobs.outcome` |
| 0005 | `eager_white_queen` | `follow_scan_staging` (durable staging) |
| 0006 | `posts_privacy_hardening` | `posts`, `post_comments` + triggers, staging→jobs FK, several indexes |
| 0007 | `posts_media_comments` | `media_type` enum rebuild (CAROUSEL/UNKNOWN), posts media columns, comment threading |
| 0008 | `metrics_link_indexes` | `capability_metrics`; `stories.link_url`; 7 performance indexes |
| 0009 | `posts_permalink` | `posts.permalink` |
| 0010 | `target_cadence_sightings` | `scan_cadence_mult` (see drift note), `scan_kinds`, `story_sightings` |
| 0011 | `post_children` | `post_children` + trigger |
| 0012 | `comment_like_count` | `post_comments.like_count` nullable — "not exposed" ≠ 0 |
| 0013 | `drop_web_auth` | `DROP TABLE sessions`; `DROP COLUMN users.password_hash` — users becomes pure ownership scope |
| 0014 | `profile_completeness_sightings_trigger` | `profile_snapshots.completeness` (backfill justified in-comment) + sighting trigger |
| 0015 | `insight_points` | the XOR table + coalesce idempotency index + trigger |
| 0016 | `target_observation_mode` | `observation_mode` enum + column (D47) |
| 0017 | `post_change_detection` | `post_presence` (mutable) + `post_changes` |
| 0018 | `tagged_media_reposts` | `tagged_media` + `posts.reposts_count` (§17) |
| 0019 | `scan_cadence_real` | `targets.scan_cadence_mult` → `real`, matching the declared schema (§17.2.6) |

### 10.5 Seed (`src/seed/seed.ts`)

Idempotent synthetic demo, all fiction, deterministic from
`BASE = 2026-08-20T09:00Z`: user `dev@igtrack.local`; target `target_a`;
3 accounts (`person_alpha/beta/gamma`); **3 profile snapshots** (420/87/12 →
427/87/13 → 431/88/13, fixed 64-hex hashes, `metadata {synthetic:true}`) so the
diff machinery has a COMPLETE baseline; one story `seed-story-1` with two
mentions (alpha VISIBLE with geometry + `rawVisibilityFlag:false`, beta
METADATA_ONLY LOW); **2 FOLLOWING snapshots** producing one NEW_FOLLOWING and
one LOST_FOLLOWING delta (guarded so a re-run does not re-diff); source health
spanning HEALTHY/DEGRADED/UNAVAILABLE (including `getLikesHistory` UNAVAILABLE
with the coverage note); one queued PROFILE_SCAN keyed
`seed:profile-scan:day-2`.

### 10.6 Repositories (16 files)

| File | Exports (semantics condensed) |
|---|---|
| `app-queries.ts` (2,002 lines) | Read/presentation layer — `listTargetsForUser` (no N+1, LATERAL latest snapshot/job), `getUserActivityFeed`, `getDashboardOverview`, `getOwnedTargetDetail`, `RELATIONSHIP_SIGNAL_WEIGHTS`, `RELATIONSHIP_RECENCY_WINDOW_DAYS`, `getRelationshipsForUser`, `getTargetDossier`, `listScopedEvidence`, `getEvidenceChain`, `listQueueJobs`, `listJobsForTarget`, `getOperationsSnapshot`, `ACTIVITY_TYPES` |
| `observations.ts` | `recordProfileSnapshot` (transaction: snapshot + evidence + COMPLETE-only diff), `listProfileSnapshots`, `listProfileChanges`, `getEvidenceForObservation` |
| `stories.ts` | `recordStory`, `listStories`, `listMentionsForStory(WithAccount)`, `recordStorySighting`, `sightingSummariesForAccount` |
| `posts.ts` | `recordPost`, `recordPostComment`, `listPosts`, `recordPostChildren`, `listChildrenForPost`, `listCommentsForPostWithAccount` |
| `post-changes.ts` | `recordPostPresence` (caption edit only vs a stored previous caption, D56), `finalizePostPresence` (no-op unless COMPLETE, D55; batched ABSENT flips, one `posts_listing` evidence per logical scan) |
| `tagged-media.ts` | `recordTaggedMedia` (scan-keyed listing evidence, insert-once), `listTaggedMedia`, `latestTagsListingEvidence` (COMPLETE vs capped where the claim lives, D48) |
| `follows.ts` | `recordFollowSnapshot` (5,000-row batches), `latestFollowSnapshot`, `listMembersForSnapshot`, `persistFollowDiff`, `listRecentDeltas` |
| `insights.ts` | `recordInsightSet`, `listInsightSeries` (values only), `insightLatest` (DISTINCT ON incl. coalesced dimension), `insightState` (latest instant + absences with reasons) |
| `evidence.ts` | `upsertEvidence` (insert-on-conflict re-read — evidence is immutable), `getEvidenceByObservation` |
| `accounts.ts` | `upsertAccount` (zod-validated; matches by platform id first — rename rewrites, D52; presence-gated fields), `getAccountByUsername`, `getAccountById` |
| `targets.ts` | `createTarget`, `listTargets`, `getTarget`, `setTargetStatus`, `updateTargetMeta`, `deleteTargetWithObservations`, `getOwnedTarget`, `updateOwnedTargetMeta`, `transitionTargetStatus` (core legality, illegal → CONFLICT), `deleteOwnedTarget` |
| `source-health.ts` | `recordCapabilitySuccess/Failure`, `markCapabilityUnavailable`, `getSourceHealth` |
| `capability-metrics.ts` | `recordProviderMetrics` (atomic increments, best-effort), `listProviderMetrics` |
| `follow-staging.ts` | `stageFollowScanMembers`, `clearForeignFollowScanStaging`, `clearStagedFollowScanMembers`, `loadStagedFollowScanMembers` |
| `sources.ts` | `ensureSource`, `getSource` |
| `types.ts` | `SourceInput`, `EvidenceRecordInput`, `ObservationKind`: `profile_snapshot, story, story_mention, follow_snapshot, interaction, post, post_comment, posts_listing, tagged_media_listing, account_insights` |

Support modules: `transactions.ts` (`withTransaction`), `client/client.ts`
(`createDb` → pool + drizzle + `close()`; fails loud on unreachable DB) and
`client/migrate.ts` (`runMigrations` / `migrateCli`, `__drizzle_migrations`
table, idempotent).

### 10.7 Retention and deletion

`resolveJobsRetentionDays` / `purgeTerminalJobs` (default 90 days, env-
overridable; terminal rows only) run from the worker maintenance tick (§9.3).
Manual deletion is `deleteTargetWithObservations`: account-scoped rows are
removed **only when no sibling target shares the account**; target-scoped rows
always; then evidence by deleted observation ids; `ig_accounts` deliberately
survives. Bounded-by-construction tables (`source_health`,
`capability_metrics`, `scheduler_state`, `job_checkpoints`, staging) need no
purge.

### 10.8 Recorded drift

`migrations/0010_...sql` creates `targets.scan_cadence_mult` as **`numeric`**;
`src/schema/tables.ts:123` declares `real(...)`. No migration reconciles them,
so a future `drizzle-kit generate` would emit a spurious type-alter.
TypeScript is unaffected; only snapshot comparison is dirty.

---

## 11. Derived analyses and read surfaces

The engine's derived products, and the exact rules that keep each one
evidence-bound.

### 11.1 Activity feed — 13 event types

`ACTIVITY_TYPES` (`app-queries.ts:217`): `PROFILE_CHANGED`, `NEW_FOLLOWER`,
`LOST_FOLLOWER`, `NEW_FOLLOWING`, `LOST_FOLLOWING`, `STORY_POSTED`,
`STORY_EXPIRED`, `POST_PUBLISHED`, `POST_EDITED`, `POST_REMOVED`,
`COMMENT_POSTED`, `MENTION_OBSERVED`, `TAG_OBSERVED`.

Built as a UNION ALL of ten source queries (profile changes; four follow-delta
classes; stories; expired stories; posts; post changes; comments; story
mentions; tagged media), each scoped through the owner's targets and each
CAPPED at `limit` before the merge, then re-sorted by `occurred_at` desc.
Every item carries the **originating observation's persisted category and
confidence** ("nothing here is assigned or invented") and the
`evidenceId` of the backing row, so each feed line links to provenance.
Wording rules are load-bearing: `POST_REMOVED` reads "no longer observed in a
complete listing", `TAG_OBSERVED` means "first observed in the tag listing",
never "tagged you just now". Filters: `types[]` whitelisted at the operations
layer (D33), and a LIKE-escaped case-insensitive `query` over username/summary
(capped at 100 chars).

### 11.2 Relationship ranking

Weights live in one place (`RELATIONSHIP_SIGNAL_WEIGHTS` =
`{mention: 12, comment: 10, delta: 8}`, D51) with a 30-day recency window
(`RELATIONSHIP_RECENCY_WINDOW_DAYS`). Inputs are **stored rows only** (D43):
mentions = distinct stories; comment authorship = comments on owned media
(the owner's own comments excluded); follow deltas = aggregates. Each signal
is reported as a total **and** a window count, with up to 3 evidence rows per
account (window functions, no N+1). "Stable members" (present in both the
earliest and latest snapshot, capped 100/direction) rank last with structural
evidence. Score = weighted counts; ties break recency → name. Confidence is
`UNKNOWN`/`LOW`/`MEDIUM` derived from signal mass, upgraded to `LOW` only by
observed presence. `firstSeenBasis` distinguishes `delta` (pinned) from
`snapshot` (weaker) — the method block renders which. D66: ranking does not
consume tags, mentions-of-others, or reposts yet.

### 11.3 Dossier (`getTargetDossier`, D50)

A read-back report over stored observations only: **16 count blocks** (profile
snapshots/changes, follower/following snapshots, deltas, stories, mentions,
sightings, tagged media, posts, comments, children, post changes,
`repostsObserved`, insight points, interactions), each `{count, latestAt}`;
the latest profile snapshot; a `media` summary (25 newest by `taken_at`, with
`publishedAt` and `firstObservedAt` kept apart) plus the preview-cap metadata
read from the newest row's evidence (`previewLimit`/`previewBounded`/
`previewPosition`, D48); `observingSources` (only sources that actually wrote
rows for this account); and `routeUnavailability` restricted to observing
sources — "a source that recorded health but never observed the account
contributes no reason" (pinned by `dossier.test.ts`).

### 11.4 Evidence ledger and chains

`listScopedEvidence` merges evidence across seven ownership EXISTS clauses —
"no row appears without provably belonging to the caller's targets".
`getEvidenceChain` drills one id into `claim` + `lineage` per kind:
profile_snapshot (values rendered "unavailable" when null; derived-change
sides; producing scan job), follow_snapshot (direction, completeness,
"first N of M" members, delta count), story/story_mention, post ("not declared
by provider"; comments observation state), post_comment threading, and
interaction; unknown kinds return `null` rather than a fabricated chain.

### 11.5 Insight read side

`listInsightSeries` returns values only (`value IS NOT NULL` by construction —
a chart line never includes an absence). `insightLatest` uses DISTINCT ON with
coalesced dimensions so demographics do not collapse to one arbitrary bucket.
`insightState` reports, SQL-side, the latest instant plus the absences
reported at that instant **with their reasons** — "never recorded" and
"platform reported absent" stay distinguishable.

### 11.6 Presence and change read side

`post_presence` gives one row per stored post with a PRESENT/ABSENT state and
`last_scan_at` (our logical scan instant); `post_changes` stores caption edits
(old/new exact) and disappearances. Reappearance is a state return, not an
event (D57), and caption changes are recorded from what was read, not gated on
listing completeness (D56).

### 11.7 Tags and source health

`latestTagsListingEvidence` lets any consumer state COMPLETE vs
PARTIAL/capped where the claim lives (D48/D61). `getSourceHealth` feeds
`status`/`doctor`/the dashboard: per (source, capability) rows with
HEALTHY/DEGRADED/UNAVAILABLE, consecutive failures, last reason, latency and
coverage note.

---

## 12. The retired web dashboard (evidence-only reconstruction)

`apps/web` source **does not exist at HEAD** — the entire surface was deleted
in commit `de06fbb` ("third founding: the agent surface is the only product
surface"), per decisions D13–D16 (delete `apps/web` entirely; delete web auth
wholesale; delete the hosted deployment surface; delete the browser E2E
suite). What remains on disk is the built Next.js artifact
`apps/web/.next/**` (untracked), and the full source recoverable from
`git show de06fbb^:apps/web/...`.

This section was reconstructed from (a) REA static analysis of the built
artifact, (b) the git history, and (c) the artifact's source maps, where the
former `middleware.ts` was recovered **byte-identical** to the git source. The
web app is documented here as part of the product's feature history; it is not
an available surface today.

### 12.1 The 79 deleted files

- **App pages (11) + shell (5)**: `app/page.tsx` (dashboard), `app/activity`,
  `app/diagnostics` (+ `_jobs.tsx`), `app/evidence`, `app/evidence/[id]`,
  `app/login`, `app/lookup` (+ `track-button.tsx`), `app/relationships`,
  `app/settings`, `app/targets`, `app/targets/[id]`; `layout.tsx`,
  `error.tsx`, `loading.tsx`, `not-found.tsx`, `globals.css`.
- **API routes (11 files)**: `api/auth/{login,logout,dev-login}`,
  `api/diagnostics/capabilities`, `api/healthz`, `api/targets`,
  `api/targets/lookup`, `api/targets/[targetId]`,
  `.../[targetId]/{pause,resume,sync}`.
- **Components (10)**: `layout/sidebar` (nav: Dashboard, Tracked Accounts,
  Activity, Relationships, Lookup, Evidence, Diagnostics, Settings),
  `auth/login-form`, `targets/create-target-form` (12 KB),
  `targets/target-controls` (11.8 KB), and the UI kit
  `badge/button/card/confirm-dialog/empty/evidence-drawer`.
- **Libs (19)**: `auth`, `csrf`, `rate-limit`, `guard`, `db`, `api-helpers`,
  `data`, `provider`, `dev-users`, `capability`, `capability-diagnostic`,
  `relationships`, `sync-state`, `target-validation`, `username`,
  `account-preview`, `external-url`, `format`, `source-badge`.
- **Tests (14)**: capability-diagnostic, capability-registry, capability,
  csrf, evidence, external-url, format, lookup-validation,
  product-capabilities, rate-limit, relationships, source-badge, sync-state,
  target-validation.
- Config: `next.config.ts`, `package.json`, `tsconfig`, `postcss.config.js`,
  `eslint.config.mjs`, `next-env.d.ts`, `middleware.ts`.

### 12.2 What each page did (from the built bundles)

| Page | Feature evidence in the artifact |
|---|---|
| `/` (dashboard) | "Active monitoring targets", "Append-only observations", "Derived deltas", cards for TRACKED ACCOUNTS / PROFILE SNAPSHOTS / FOLLOW CHANGES / STORIES OBSERVED; "Recent activity"; "Source health"; empty-state instructions ("Run `pnpm igtrack setup`"); the line "Observed, not scraped" |
| `/targets` | Tracked-accounts list; create-target form (username, local name, tags); target controls |
| `/targets/[id]` | The largest page (42.8 KB source): overview, profile snapshots/changes, stories (+ mentions, per-story sightings), content tab with posts/comments; "unavailable" rendering throughout |
| `/activity` | Multi-select "Event types" filter, "Account or text" search, "Clear filters", and the 10 human event labels: Profile changed, Newly observed follower / following, No longer observed follower / following, Story posted, Story expired, Post published, Comment posted, Mention observed; "No events match the current filters." |
| `/relationships` | Ranked contacts — "Higher observed activity…" ordering with per-signal evidence, mirroring `getRelationshipsForUser` |
| `/evidence` + `/evidence/[id]` | Ledger listing and per-claim chain view (the evidence drawer component) |
| `/lookup` | Stateless probe of a public professional account + "track" button (`targets add --observed`) |
| `/diagnostics` | Capability matrix rendering + `_jobs.tsx` job monitors |
| `/settings` | Account/runtime settings |
| `/login` | Login form (session-based auth, below) |
| API `healthz` | Liveness endpoint |
| API `diagnostics/capabilities` | Registry read for the diagnostics page |
| API `targets*` | CRUD + pause/resume/sync/lookup; mutations re-validated server-side |

### 12.3 The auth model that was deleted

Migration `0001` had added `sessions` + `users.password_hash`; the web app
used them via `lib/auth.ts` (`issueSession`, `resolveSession`,
`SESSION_TTL_MS`, `verifyPassword`), a session cookie `igtrack_session`
(httpOnly), CSRF protection (`lib/csrf.ts`), request rate limiting
(`lib/rate-limit.ts`), and a guard (`lib/guard.ts`). `middleware.ts` enforced
`PUBLIC_PATHS` and was **defense-in-depth only** — every route re-authorized
server-side. `dev-login` existed for local development. Migration `0013`
(`drop_web_auth`) then removed the tables/columns, and D14 removed the code:
"users" today is a pure ownership scope with no credentials anywhere.

### 12.4 Reconstruction evidence

REA analysis of `apps/web/.next`: 481 modules, 1,245 module nodes, full route
inventory, per-page strings, client fetch endpoints, server env vars, typed
error codes, and the middleware source recovered from `sourcesContent`.
`server/middleware.js` module node `jag_node_86b04d67754950274855a3df272abf457c5847e6cec8c82e9939993045d1fadf`
(parent evidence `ev_710d05d020fbca83f0116b65f38872a5d67dc564c1a222cbe67a82d9dea4e5af`).
Extraction artifacts and the full deleted-file list are reproducible with
`git show de06fbb^:apps/web/<path>`.

---

## 13. Deployment, operations, repository tooling

### 13.1 Three ways to run it (`docs/DEPLOY.md`, 100 lines)

1. **Local** — `pnpm install` → `cp .env.example .env` → `docker compose up -d`
   → `pnpm igtrack setup` → drive by hand/agent; `pnpm worker` for the
   long-running daemon. `setup --local` records the Compose URL when none is
   set.
2. **One host, containers** — `docker compose -f docker-compose.prod.yml up -d
   --build`. Agents on the host talk to the deployment through `igtrack` /
   `igtrack mcp` — **there is no network-facing app container, by design**.
3. **Cron-driven worker** — `IGTRACK_WORKER_ONCE=1 pnpm --filter
   @igtrack/monitoring start` drains up to 25 jobs and exits; queue leases and
   idempotency keys make overlapping runs safe.

Plus a production checklist (TLS URL not in git; migrations applied
deliberately; **read doctor's findings**; provider chosen honestly; backups
verified by an actual restore; one or many workers) and operating notes (the
worker is where observation happens — a deployment with no worker looks empty
and doctor says so; story cadence exists because the window is 24 h; **alerts
are not built in** — an agent or cron calling `igtrack activity --since` is
the notification path; pausing beats deleting).

### 13.2 Compose and image

- `docker-compose.yml` (dev): `postgres:16-alpine`, healthcheck, volume,
  `docker/initdb` mounted (creates `igtrack_test`).
- `docker-compose.prod.yml`: `db` (password required via
  `${POSTGRES_PASSWORD:?}`) + `worker` built from `Dockerfile.worker`,
  `env_file: .env`, `DATABASE_URL`/`IGTRACK_DATABASE_URL` constructed to the
  compose network, **no ports on the worker**, healthcheck via `pgrep`.
- `Dockerfile.worker`: node:22-alpine, pnpm 11.21.0 via corepack, two stages;
  the base stage runs `pnpm --filter @igtrack/monitoring typecheck` as a build
  gate and states "No build step — worker runs via tsx (keeps source maps, no
  extra compile)"; the runner stage runs as non-root `igtrack`, with a pgrep
  HEALTHCHECK and `pnpm --filter @igtrack/monitoring start` as CMD.

### 13.3 Scripts (5)

| Script | Behavior |
|---|---|
| `scripts/backup.sh` (61 lines) | `pg_dump` → `backups/igtrack_<ISO>.sql.gz` + SHA-256 checksum + log; **14-day retention**; prefers the DB container, falls back to a host client; a failure exits non-zero and **does not delete old backups** |
| `scripts/restore.sh` (82 lines) | Restores into a temporary database on the same instance and verifies — "isolated test, never destroys prod DB" |
| `scripts/capability-matrix.ts` (22 lines) | Regenerates `docs/CAPABILITIES.md` from the registry (`pnpm docs:capabilities`); a core test fails when the doc is stale — "a hand-written matrix drifts … and the drift always errs in the flattering direction" |
| `scripts/verify-graph-provider.ts` (245 lines) | Read-only live Graph verification harness: one first-page call per capability, hard request cap, **never prints credential values** (presence/field names/types/lengths only), no disk writes; with no credentials it reports every capability `NOT_VERIFIED` / `CREDENTIALS_NOT_CONFIGURED` and **exits 0 — the honest state, not a failure**; it is also the single-node probe that would move `reposts_count` from UNVERIFIED into the requested field set (D64) |
| `scripts/perf-release.ts` (255 lines) | Release performance measurements: synthetic workloads only, **real PostgreSQL and real worker executors** with stub providers, in an isolated `igtrack_perf` database |
| `packages/database/scripts/bench-staging.ts` | Phase-11b scale harness driving the **real production staging APIs** at scales 1,000 → 500,000 with per-phase wall-times/RSS/relation sizes, plus three correctness benches (duplicate pages dedupe, reordered pages yield identical sets, cross-job isolation). Any integrity miss sets exit code 1 |

### 13.4 CI (`.github/workflows/ci.yml`)

Push to `master` and PRs; `cancel-in-progress` concurrency. One `verify` job
on ubuntu-latest with a `postgres:16-alpine` service (healthchecked), env
`DATABASE_URL` + `IGTRACK_TEST_DATABASE_URL` + `PGPASSWORD`. Steps: checkout →
pnpm setup → node 22 with pnpm cache → `pnpm install --frozen-lockfile` →
create `igtrack_test` → **"Require PostgreSQL (infrastructure failure must
FAIL CI, never silently skip DB suites)"** → `pnpm typecheck` → `pnpm test`
(unit + integration + worker against real PostgreSQL, migrations applied) →
**worker daemon boot smoke** (`pnpm --filter @igtrack/monitoring start` with
`IGTRACK_JOB_MAX_ITER: 1`, `IGTRACK_JOB_POLL_MS: 100`).

### 13.5 Repository tooling and hygiene

- `package.json` scripts: `test`, `test:watch`, `typecheck` (`pnpm -r`),
  `verify:graph`, `docs:capabilities`, `igtrack`, `mcp`, `worker`. No build
  step anywhere in the default path (`tsx` everywhere).
- `opencode.json` — the repo's OpenCode harness config (snapshot on; watcher
  ignores `node_modules`, `.next`, `dist`, `coverage`, `data`, `storage`);
  not an IGTrack runtime feature.
- `.gitignore` deliberately excludes `re/` ("local reverse-engineering scratch
  notes — see docs/FOUNDING.md for what they drove"), `rea/` and
  `graphify-out/` ("third-party analysis tooling and its caches — local only,
  never part of the product"), backups data (scripts tracked,
  `backups/.gitkeep` only), `.env`/`.env.*` (example tracked), and local
  OpenCode state.
- Singleton/local-only analysis directories present on this machine:
  `re/anonstories/` holds the project's own pre-refusal browser/API evidence
  (`FINDINGS.md`, `api-evidence.json`, `browser-scenario.json`,
  `scenario-capture*.json/.err`); `rea/` holds the REA tool's local cache;
  `graphify-out/` holds a prior knowledge-graph report.

---

## 14. Refusals and the founding decision log

The refusals ARE product surface. `docs/FOUNDING.md` (17 sections, one per
founding/phase) records every one of them; this section indexes the binding
content. **Changing a refusal is a founding decision** — a dated entry with
evidence; "the user asked again" is not evidence.

### 14.1 The founder's dossier requirement (§14.1), clause by clause

| # | Requirement | Lawful route or refusal | Landed |
|---|---|---|---|
| A1 | Any public account's details (counts, posts) | **Business Discovery only** — public Business/Creator accounts; consumer/private/age-gated → UNAVAILABLE with the platform's reason | Built (D42): opt-in `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1`, probe-only or operator-directed `--observed` |
| A2 | Tags (media the account is tagged in) | Own account: the documented `tags` edge — "not yet requested by any provider method" at the time | Built in Phase H (§17): `TAGS` capability, `TAGS_SCAN`, `tagged_media` |
| A3 | Their stories | Own: `stories` edge (implemented). Other accounts: only the owner's tray exists — absent | Own-only, by platform design |
| A4 | Highlights, story/highlight tags — "even if it is hidden" | No `highlights` edge anywhere; archived story content is not enumerable; the only alternative is the undocumented `reels_media` endpoint | **Refused** (`HIGHLIGHTS` = DOCUMENTED_ABSENT) |
| A5 | All comments the account made on others' posts | No edge. Comments readable only on media you own/manage; `mentioned_comment` reads single webhook-keyed ids | **Refused** |
| A6 | All likes the account made | No liker feed exists; `like_count` is a number, *who* never enumerated | **Refused** (`LIKES`) |
| A7 | Reposts | `reposts_count` exists as a **number** on readable media; no edge lists reposting accounts | Scalar built (D64/D65, §17); **identities refused** (`RESHARES`) |
| A8 | "If anyone takes the user id, it should show" | No id→account route; the platform id is an *output of* a username-based discovery, never a fetch key (D44) | **Refused**; D52 allows id-based *matching* of accounts already on record |
| A9 | Who followed/unfollowed, by name, both directions | The operator's own export (`import:v1`) → snapshots → `follow_deltas` → `activity`; COMPLETE-only diffs | **Built** (§11.1, `FOLLOWERS`/`FOLLOWING`) |
| A10 | Closest contacts + the same recursively through followers'/following's accounts | Observable signals on owned accounts: story mentions, comment authorship, follow deltas (D43/D51); **no traversal** — observation is operator-directed, never derived from any listing | Ranking built; **traversal refused** |

The binding rules following from §14 (also in `AGENTS.md §8`): refused is
refused (no building, scaffolding, or local inference); other-account data has
exactly one lawful route (Business Discovery, opt-in, documented fields only);
observation is operator-directed (never auto-create a DISCOVERY target from a
mention/comment/tag/follower row/discovery response; no depth/expand
parameter); a bounded listing says so where the claim lives (12-media preview
cap recorded per row, `COMPLETED_PARTIAL`, never "the account's posts", D48);
published time and first-observed time are different facts; owned and observed
targets do not share scan kinds (refused at enqueue AND execute, D47); the
platform id is an output never a lookup key (D44), usable only to *match*
(D52); relationship ranking uses observed evidence only; changing a refusal is
a founding decision.

### 14.2 The complete decision log (D1–D66)

**§4 (initial):** D1 License AGPL-3.0-or-later · D2 Name IGTrack · D3 Lawful
sources only · D4 Authorized-observation default · D5 No paid anything ·
D6 Postgres the only required external service · D7 Honesty enforced by tests,
not prose · D8 Absence ≠ zero · D9 Diff only COMPLETE snapshots · D10 Evidence
over convenience · D11 Monorepo, pnpm + TS ESM + tsx · D12 Delete nothing that
earns its keep.

**§9 (third founding — agent surface only):** D13 Delete `apps/web` entirely ·
D14 Delete web auth wholesale · D15 Delete the hosted deployment surface ·
D16 Delete the browser E2E suite · D17 Repo hygiene · D18 Version stays 0.1.0.

**§10 (Phase A — honesty gaps):** D19 Profile snapshots record `completeness` ·
D20 Graph 400/404 → UNAVAILABLE on every method via one fix in
`providerFailure` · D21 Follow-scan evidence forwards the final page's
confidence · D22 PARTIAL final page without a cursor ⇒ `truncated` ·
D23 Fixture provenance derives from the directory version · D24 `opScanList`
owner-scoped · D25 `story_sightings` append-only · D26 Registry↔provider↔schema
consistency test.

**§11 (Phase B — import:v1):** D27 New `import:v1` provider · D28 Import
observes exactly one account: its owner · D29 Everything outside the roster
answers UNAVAILABLE with the reason · D30 One page = one raw export file ·
D31 Fail-fast configuration · D32 Registry, generated matrix, and shared
conformance harness all updated.

**§12 (Phase C — agent-facing refusals):** D33 `opActivity` validates activity
types at the operations layer · D34 `guarded` classifies connection failures
as `DB_UNAVAILABLE` · D35 The refusals themselves get tests.

**§13 (Phase D — insights):** D36 New capability `ACCOUNT_INSIGHTS` + graph
method · D37 A metric the platform does not return is stored as an ABSENCE row ·
D38 `import:v1` refuses insights honestly · D39 Fixture synthesizes a
deterministic insight set and mirrors one documented rule (below-100-followers) ·
D40 Business Discovery stays deferred as a scope decision, on the record ·
D41 Insights cadence: every 6 hours.

**§14 (Phase E — the dossier requirement):** D42 Adopt Business Discovery as
the only route to other-account public data · D43 Comment authorship on owned
media = the third relationship signal · D44 The platform id is an output,
never a lookup key · D45 The dossier requirement is recorded as the product
north star · D46 Recorded, not built (unlock paths).

**§15 (Phase F — public-account dossier):** D47 A target carries
`observation_mode` OWNED/DISCOVERY · D48 DISCOVERY records the profile as
COMPLETE, the media preview as bounded, and always reports
`COMPLETED_PARTIAL` · D49 `targets add --observed` probes once and refuses on
UNAVAILABLE · D50 `igtrack dossier` is the reporting surface · D51 Relationship
ranks gain recency, per-account evidence rows, and an explicit method block ·
D52 Account identity is matched by platform id first · D53 `lookup` stays a
stateless probe; `targets add --observed` + `dossier` are the recording path.

**§16 (Phase G — media change detection):** D54 A presence state, not per-scan
media snapshots · D55 Disappearance claimed only from a COMPLETE listing, and
never called "deleted" · D56 Caption differences recorded from what was read,
not gated on completeness · D57 Reappearance is a state return, not an event ·
D58 Change rows link one `posts_listing` evidence row per logical scan ·
D59 Owned-only, enforced at execution.

**§17 (Phase H — tags, mentioned comments, reposts):** D60 Tagged media are
first-observation references · D61 One listing evidence row per scan carries
the listing's completeness · D62 `TAGS_SCAN` is owned-only, guarded at enqueue
AND execution · D63 Mentions: an on-demand stateless read, never a listing ·
D64 `reposts_count` parses when present and is requested only after live
verification · D65 REPOSTS is the scalar; RESHARES is the relation · D66
Relationship ranking does not consume tags, mentions, or reposts yet.

### 14.3 Non-goals (FOUNDING §5, verbatim intent)

Monitoring accounts you do not own or are not authorized to observe;
private-account access, story/highlight proxy viewing, media download
pipelines; follower **lists** for arbitrary accounts; liker lists, interaction
feeds, repost attribution, archived media bytes; hosted multi-tenant SaaS,
billing, seats, or any paid tier — ever; a mobile app, a browser extension, or
a Chrome-automation path; any AI inference that launders speculation into
"findings" — "if it is not observed or derived from observations, it is not
shown."

---

## 15. Testing and verification

**60 test files** across four packages (`vitest`, discovered at
`{packages,apps,workers}/*/test/**/*.test.ts`; behavior-named tests, no
snapshots for business logic). Database suites probe
`IGTRACK_TEST_DATABASE_URL` and **skip loudly** when it is down — never pass
vacuously.

| Package | Files | Coverage |
|---|---|---|
| `apps/cli` | 4 | `mcp.test.ts` (pins the 19 `EXPECTED_TOOLS`, `_meta` semantics, error envelopes, DB-down behavior), `operations.test.ts` (op* semantics), `output.test.ts` (arg parsing, exit codes, `display(null)`), `resolve-user.test.ts` |
| `packages/core` | 6 | capability result invariants, generated-matrix drift, follow-diff, profile-diff, mention-intelligence, next-cursor |
| `packages/database` | 21 | `schema` (28 tables, exactly 16 triggers, CHECKs, enum values), `migration-safety`, `persistence` (PARTIAL never diffed either direction), `follows` (COMPLETE-only diffs), `posts`, `stories`, `story-sightings`, `dossier`, `source-health`, `capability-consistency` (registry↔methods↔schema exports both directions), `capability-depth`, `isolation` (ownership never leaks), `privacy` (D1 unknown semantics), `concurrency` (no double-claim; dormancy pin for `interactions`/`media_assets`), `activity-relationships`, `jobs`, `queue-hardening` (lease/retry clamps), `retention`, `maintenance` (deletion cascade), `scheduler` (cadence math, pause/resume), `scan-prefs` |
| `packages/ingestion` | 9 | `conformance` (the shared provider-contract harness every provider passes), fixture provider + hardening (manifest/version/provenance failures), graph provider (mocked edges, error mapping), import provider, media-and-paging, mention-classification, field-coverage (drift guards + new-field detection per key space), `e2e-journey` |
| `workers/monitoring` | 20 | `worker-config` (boot guard), `worker-boundary` (failure classification), `provider-config`, `provider-timeout`, `lease-loss`, `checkpoint-staging`, per-kind scans (`discovery`, `following`, `story`, `posts`, `posts-paging` — including "never diffs a PARTIAL snapshot (no fabricated LOST_*)", `posts-changes`, `tags`, `insights`), `scheduler` + `scheduler-stagger` (fleet rotation pinned with 250 targets across 2 keys; tick dedupe), `ephemeral-worker`, `run-once-entry`, `worker-follower-scan`, `worker-integration` |

Verification assets beyond tests: `pnpm verify:graph` (live Graph harness,
honest exit-0 when unconfigured), the generated-matrix drift test
(`docs:capabilities` + `capability-matrix.test.ts`), `scripts/perf-release.ts`
(isolated DB, stub providers, real executors), and
`packages/database/scripts/bench-staging.ts` (real staging APIs to 500 k rows
+ 3 correctness benches; integrity miss → exit 1). CI runs the full loop and
the worker boot smoke against real PostgreSQL (§13.4).

**Runtime verification performed for this document:** `igtrack --help`,
`igtrack status`, `config --json` (redaction confirmed), `doctor` (DB reachable;
source health), `capabilities --json` (23/18), `targets list` (3 demo targets;
`@dune.harbor` DISCOVERY), `scans list`, and a live MCP `initialize` +
`tools/list` over stdio (19 tools enumerated with schemas/annotations). The
test suite itself was **not re-run** during this read-only pass; its contents
were read, not executed.

---

## 16. Research basis and project history

- `docs/research/` (6 files): `00-synthesis`, `01-analytics-market`,
  `02-tracking-osint-market`, `03-oss-agent-ecosystem`,
  `04-platform-api-reality`, `05-market-refresh-2026-10-16` — the market and
  platform-reality corpus behind the phase decisions (the refresh is dated the
  day of this analysis and informed Phase H, §17).
- The founding document itself records two reverse-engineering passes (its
  §2 and §9) — platform API reality mapping and the decision to keep only the
  agent surface — and the local, gitignored `re/anonstories/` evidence
  (`FINDINGS.md`, raw API/browser capture JSON) is what those passes drove.
- `CHANGELOG.md` tracks the phases; `LICENSE` is AGPL-3.0-or-later (D1);
  `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` ship with the repo.
- The product's own history is a feature: three "foundings" (the initial
  build, the web deletion, the dossier requirement) and five execution phases
  (A–H in §10–§17 of FOUNDING.md), each with its own decision log and
  verification section.

---

## 17. Coverage, evidence, and limitations of this document

### 17.1 Evidence ledger

| Kind | Reference |
|---|---|
| REA parent evidence | `ev_710d05d020fbca83f0116b65f38872a5d67dc564c1a222cbe67a82d9dea4e5af` — `analyze_javascript_application` on `apps/web/.next` (directory/summary): 191 relevant files, 139 parsed JS, 481 modules, 708,832 AST nodes, 2,150 findings, 0 parse failures, coverage partial (155 application unknowns, 21,355 semantic unknowns; expansions budget-limited) |
| REA summary evidence | `ev_9e145ea11ad2b771dab725dd6d683a1ad94c137960d5805077e8fcceb2aadf11` |
| REA artifact digest | sha256 `19723f60b0aa0b2b63bdd3847002959dc2a1aa342db1d78f65649be315105eb9` |
| REA module node (middleware) | `jag_node_86b04d67754950274855a3df272abf457c5847e6cec8c82e9939993045d1fadf` (`server/middleware.js` digest `198d6485…`; recovered source byte-identical to `de06fbb^:apps/web/middleware.ts`) |
| Runtime captures (documentation pass) | CLI help/status/config/doctor/capabilities/targets/scans; MCP `initialize` + `tools/list` (19 tools); provider `fixture`; DB reachable (native Postgres; docker CLI unavailable) |
| Runtime captures (verification pass, 2026-10-16) | full CLI E2E on scratch DB `igtrack_verify` — 22 commands, setup→work→dossier/relationships/insights/tags→evidence chain→config→target lifecycle, all expected exit codes (only deliberate no-confirm delete = 2); MCP probe `initialize`→`tools/list`(19)→12×`tools/call` incl. typed `TARGET_NOT_FOUND`; `pnpm verify:graph` against the live endpoint (8/11 capped requests, typed `AUTH_REQUIRED`, no fabricated data); dev DB upgraded to 20 migrations. Raw outputs: `%TEMP%\opencode\e2e-run2\` |
| Git anchors | HEAD `04e2a46`; web deletion `de06fbb` (79 files), source at `de06fbb^`; migrations journal idx 0–19 |

### 17.2 Cross-document and schema drift found while documenting

1. `igtrack config` prints 16 variables and omits the `import` provider's two
   (`IGTRACK_IMPORT_DIR`, `IGTRACK_IMPORT_USERNAME`) though both are
   first-class runtime config (§5, `.env.example`).
   **Resolution (2026-10-16, FIXED):** both rows added to `CONFIG_KEYS`; a live
   `igtrack config --json` on a scratch database now prints **18** variables;
   `apps/cli/test/config-keys.test.ts` pins presence and meaning.
2. `docs/ARCHITECTURE.md`'s executor enumeration omits `TAGS_SCAN` (the eighth
   kind, added in §17).
   **Resolution (2026-10-16, FIXED):** `TAGS_SCAN` added to the enumeration.
3. `docs/FOUNDING.md §7` says "15 tools / 13 commands"; today the surface is
   **19 MCP tools** and a larger CLI router (README's "nineteen tools" is
   current).
   **Resolution (2026-10-16, FIXED):** dated correction notes added at both
   sites (D36 house style); `mcp.test.ts`'s `EXPECTED_TOOLS` (19) is the
   machine-checked count.
4. `IGTRACK_FIXTURES_DIR` is documented in `.env.example` but read by no code
   path (fixtures resolve relative to the module).
   **Resolution (2026-10-16, FIXED):** `providerFromEnv()` now honours the
   override (blank string = unset); regression tests in
   `workers/monitoring/test/provider-config.test.ts` (empty override dir →
   `SOURCE_NOT_FOUND`, proving it was read; unset → fixture still available).
5. `IGTRACK_LOG_LEVEL` is declared reserved and unread.
   **Resolution (2026-10-16, INTENTIONAL_ABSENCE):** `.env.example` states
   "RESERVED, CURRENTLY UNREAD — do not set expecting quieter logs"; kept as
   deliberate, no behavior change.
6. Schema drift: `targets.scan_cadence_mult` is `numeric` in migration 0010 but
   `real` in `src/schema/tables.ts:123`; a future `drizzle-kit generate` would
   emit a spurious alter (§10.8).
   **Resolution (2026-10-16, FIXED):** migration
   `0019_scan_cadence_real.sql` converts the column to `real` — the declared
   schema is the contract; 0010 is never edited. Applied on the test DB
   (fresh migrate) and on the dev DB (20 migrations; `information_schema`
   reports `real`); pinned by `packages/database/test/schema.test.ts`.
7. `renewLease` returns `true` on a renewal exception (a heartbeat DB error is
   indistinguishable from success to the caller); job ownership guards in
   `completeJob`/`failJob` are the backstop (§9.4).
   **Resolution (2026-10-16, INTENTIONAL):** the trade-off is documented in
   `workers/monitoring/src/executors.ts`; ownership is re-checked on
   complete/fail and `lease-loss.test.ts` pins the lost-lease abort path. No
   behavior change.

### 17.3 What this document could not verify

- **The web dashboard cannot be run** — its source is deleted; everything in
  §12 comes from the built artifact, git history, and REA, not from live
  behavior.
- **No live Graph verification** — `.env` holds **placeholder** credentials
  (`PASTE_*`), so every Graph-backed capability stays `NOT_VERIFIED`
  (`LIVE_VERIFIED` count: 0). The honest-failure path *was* executed against
  the live endpoint (2026-10-16): `pnpm verify:graph` made 8/11 capped
  requests and returned typed `ERROR / AUTH_REQUIRED` (retryable: false) for
  the six credentialed reads, structural `UNAVAILABLE` for
  `getFollowers`/`getFollowing`, and `NOT_VERIFIED` for
  `getMentionedComment` — no fabricated data. Unlock: a real long-lived token
  plus the owned Business/Creator account in `.env`, then re-run
  `pnpm verify:graph`.
- **REA coverage was partial** (application/semantic unknowns recorded above);
  module-level drill-down beyond what §12 needed was budget-limited.
- **Docker tooling is absent in this environment** — compose files were read,
  not executed; Postgres was reached as a native service.
- **CI workflows were not executed** (documented from the workflow file, not
  observed). The local suite *was* executed in the verification pass:
  baseline `60 files · 443 passed · 1 skipped`, post-fix
  `61 files · 448 passed · 1 skipped` — both exit 0; the skip is the
  database-down guard in `schema.test.ts`, which skips loudly rather than
  passing vacuously.

### 17.4 Completeness cross-check (every counting surface)

CLI: 1 router, ~20 commands/subcommands + 3 aliases (§3) · MCP: 19 tools (§4)
· Config: 30 environment variables incl. reserved (§5) · Capabilities: 23
registry ids, 18 available, 5 UNAVAILABLE, 7 DOCUMENTED_ABSENT (§6) ·
Providers: 3 (`fixture`, `graph`, `import`) + 12-method contract, 18 raw
schemas, 9 normalizers, 81 field-coverage rows (§7) · Core: 93 exports (§8)
· Work: 8 job kinds, 6 job statuses, 6 outcomes (§9) · Database: 28 tables,
17 enums, 16 triggers, 4 CHECKs, 20 migrations, 16 repositories, seed (§10)
· Activity: 13 event types over 10 sources (§11) · Web (retired): 79 files —
16 app files, 11 API routes, 10 components, 19 libs, 14 tests (§12) ·
Deployment: 3 run modes, 2 compose files, 1 Dockerfile, 6 root scripts,
1 CI workflow (§13) · Refusals: 10 founder clauses, 66 decisions, 7 non-goals
(§14) · Tests: 61 files (§15) · Research: 6 documents (§16).

**The documentation pass created only this document.** The 2026-10-16
verification pass added the fixes recorded in §17.2, three test files, and
[`docs/verification/VERIFICATION.md`](verification/VERIFICATION.md). Nothing
is committed; the tree sits on `04e2a46` with those uncommitted changes.

# AGENTS.md — working in the IGTrack repository

You are an AI coding agent. This file is your contract with this repository.
Read it before changing anything; it is short on purpose.

IGTrack is an **evidence-first observation engine** for Instagram accounts the
operator is authorized to observe. It is free, self-hosted, agent-driven, and
its distinguishing feature is *epistemic honesty*: every claim carries
provenance, and anything not observable is reported as UNAVAILABLE **with a
reason** — never as zero, never as a guess.

That property is the product. Most of what follows exists to stop you from
breaking it while making something else work.

---

## 1. Set up and verify (do this first)

```bash
pnpm install
cp .env.example .env          # only if .env is missing; it is gitignored
docker compose up -d          # Postgres 16 on localhost:5432 (required for tests)
pnpm igtrack setup            # migrate + synthetic demo; `setup --local` if no URL is set
```

The verification loop, in order:

```bash
pnpm typecheck                # every workspace package; must be clean
pnpm test                     # vitest, all packages; needs the Postgres container
pnpm igtrack status           # sanity check the runtime end to end
```

Notes that save time:

- **There is no build step** anywhere in the default path. Everything runs
  TypeScript directly through `tsx`.
- Tests are discovered by the root [vitest.config.ts](vitest.config.ts) at
  `{packages,apps,workers}/*/test/**/*.test.ts`. Put new tests there.
- Integration tests that need Postgres use `IGTRACK_TEST_DATABASE_URL`
  (default `postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_test`, created by
  `docker/initdb`). If the database is down, a database-backed suite should
  **skip loudly**, never pass vacuously.
- Migrations: `pnpm --filter @igtrack/database db:generate` then `db:migrate`.
  Never edit an applied migration; add a new one.

## 2. Repo map

| Path | Responsibility |
|---|---|
| `packages/core` | Pure domain: observation categories, confidence, `CapabilityResult`, typed errors + retryability, evidence hashing, profile/follow diffs, mention classification, the **capability registry**. **Zero runtime dependencies — keep it that way.** |
| `packages/database` | Drizzle schema, repositories, append-only evidence ledger, job queue + scheduling primitives, migrations, synthetic seed. |
| `packages/ingestion` | Providers (`fixture`, `graph`), normalizers, raw schemas, documented-field audit. |
| `workers/monitoring` | Job execution: claim/complete, per-kind executors, checkpoint + staging, lease heartbeat, provider timeout, scheduler, retention. |
| `apps/cli` | `igtrack` CLI and `igtrack mcp` server. **All agent-facing capability lives in `apps/cli/src/tools.ts`.** |
| `docs/` | Architecture, capability matrix, deployment recipes, founding decisions. |

## 3. Invariants — do not break these

Each one has tests. If your change makes a test fail, the change is wrong, not
the test. Fixing a test to match new behaviour requires explaining why the new
behaviour is more honest.

1. **Absence is not zero.** A count that was never observed is `null`/`UNAVAILABLE`
   with a reason. No zero-filling, no defaulting, no "probably 0". Applies equally
   to SQL, JSON payloads and CLI tables (`display(null) === "unavailable"`).
2. **`UNAVAILABLE` is never an error and never empty data.** A capability the
   platform does not expose is a *structural* fact. Distinguish "the platform
   does not expose this" from "the call failed" from "it is genuinely empty".
3. **No access-control circumvention.** Official APIs and operator-supplied data
   only. No undocumented endpoints, no session cookies, no proxy re-serving of
   media bytes, no headless-browser scraping. This is the line that makes the
   project lawful; do not move it for a feature.
4. **Partial never becomes a claim.** A truncated (`PARTIAL`) scan is stored but
   never diffed against a previous snapshot. Fabricating `LOST_FOLLOWER` from a
   half-read page is the exact bug class this project exists to prevent.
5. **Every stored claim has evidence.** Raw + normalized hashes, source id,
   observation id, observed vs. captured time. A raw hash is recorded only when
   the provider actually transported a raw representation — a normalized hash
   must never masquerade as one.
6. **The capability registry is the single source of truth** for what the product
   can show. `igtrack capabilities` prints it, tests pin
   it. Never hardcode a capability claim in presentation code.
7. **Configuration failures fail fast and loud.** An unknown provider name, a
   missing credential, or an unreachable database is an error, never an empty
   dataset. A missing credential must never look like "no data".
8. **Secrets never leave the environment.** No tokens in fixtures, evidence,
   logs, URLs, error messages or browser bundles. `igtrack config` and
   `igtrack doctor` print presence, never values.
9. **Ownership scoping is unconditional.** Every read and write is scoped to the
   resolved owner user (or `user.sub` in a hosted context). Never accept a
   caller-supplied user id where an authenticated one exists.
10. **No paid dependencies in the default path.** No hosted service, no metered
    API, no telemetry. Postgres is the only required external service.

## 4. Adding capability to the agent surface

One operations layer, two consumers. To add an operation:

1. Implement it once in [apps/cli/src/tools.ts](apps/cli/src/tools.ts) as
   `opSomething(ctx, input): Promise<JsonSerializable>`. Scoping, honesty and
   error typing happen here.
2. Register it as an MCP tool in [apps/cli/src/mcp/server.ts](apps/cli/src/mcp/server.ts)
   (`registerTool` with a zod `inputSchema`, `readOnlyHint` when it only reads).
   Return `withMeta(ctx, data)` so the caller always gets the `_meta` block.
3. Expose it in the CLI router in `apps/cli/src/main.ts` (and render it for
   humans — a table, with `unavailable` for nulls).
4. Add the tool name to `EXPECTED_TOOLS` in
   [apps/cli/test/mcp.test.ts](apps/cli/test/mcp.test.ts) and assert the new
   semantics in [apps/cli/test/operations.test.ts](apps/cli/test/operations.test.ts).

Rules for this surface specifically:

- The MCP process **owns stdout** (JSON-RPC). Never `console.log` in code
  reachable from `igtrack mcp`; write diagnostics to stderr.
- A failure must be returned as `isError` with a typed `error.code` — never as a
  successful empty result.
- Destructive operations require an explicit confirmation parameter.

## 5. Adding a data source

Implement `InstagramProvider` (`packages/core/src/provider.ts`) in
`packages/ingestion`, normalizing into the `Normalized*` models, and return
`CapabilityResult` values — including honest `UNAVAILABLE` with a note for
anything the source cannot supply. Then:

- teach `providerFromEnv()` (`workers/monitoring/src/provider.ts`) to
  construct it;
- update the capability registry entries and their `whyUnavailable` reasons;
- run the field-coverage audit (`packages/ingestion/src/graph/field-coverage.ts`)
  if it touches the Graph API;
- add fixtures and a conformance test. Fixture-only providers are welcome;
  unlawful ones are not.

## 6. Conventions

- TypeScript ESM, `NodeNext` resolution, `strict` +
  `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Import specifiers
  end in `.js` inside packages; use conditional spreads for optional properties.
- Comments explain **why**, especially where a rule above is enforced. Prose that
  restates the code is noise.
- Tests: `vitest`, `describe`/`it`, behavior-named ("never diffs a PARTIAL
  snapshot"), no snapshot tests for business logic.
- Keep diffs small and scoped. Do not reformat files you are not changing.
- Never commit `.env`, credentials, or generated build output.
- Run `pnpm typecheck` and the tests for the packages you touched before saying
  you are done. Report anything you could not run.

## 7. When in doubt

Ask what is *true* about the data, then make the system say exactly that — no
more, no less. If a design decision is forced between "looks better" and "is
honest", be honest, and write the reason down where the next agent will read it.

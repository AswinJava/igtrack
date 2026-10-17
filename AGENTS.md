# AGENTS.md

Instructions for AI coding agents working in this repository. Humans are welcome
too — this is the shortest path to not breaking the product.

## What this project is

IGTrack observes Instagram accounts the operator is authorized to observe, and
records **what was observed, when, from which source, under which permission**.
Anything the platform does not expose is reported `UNAVAILABLE` with a reason.
That property is the product. Code that makes an unavailable capability look
available is a regression, even if the demo looks better.

## Commands

```bash
pnpm install
docker compose up -d          # PostgreSQL 16
pnpm igtrack setup            # migrate + synthetic demo

pnpm typecheck                # all packages — must pass
pnpm test                     # unit + integration — needs PostgreSQL
pnpm verify:graph             # live Graph probe (credentials required)
pnpm docs:capabilities        # regenerate docs/CAPABILITIES.md from the registry
```

`pnpm test` fails loudly when PostgreSQL is missing. Do not weaken a test to make
it skip; report the environment limitation instead.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/core` | Pure domain: models, `CapabilityResult`, errors/retryability, evidence hashing, diffs, mention rules, capability registry. **No runtime dependencies.** |
| `packages/database` | Drizzle schema, migrations, repositories, evidence ledger, queue/scheduler primitives, seed. |
| `packages/ingestion` | Providers, normalizers, page parsers, fixtures, research acquisition. |
| `workers/monitoring` | Job runner: claim, execute, checkpoint, complete/fail, retention. |
| `apps/cli` | The operations layer (`tools.ts`), CLI router, renderers, MCP server. |

Dependencies point downward. Never import `database`, `ingestion` or `cli` from
`core`.

## Invariants

1. **Never zero-fill.** A missing metric is `null` with a reason — in SQL, JSON,
   tables and prose. `0` means the source said zero.
2. **Typed refusals.** "Could not look" is never rendered as "the platform does
   not expose this": every `UNAVAILABLE` carries a note and a
   capability-registry reason, and the registry is the single source of truth.
3. **No unlawful acquisition.** No session cookies, undocumented endpoints,
   private-account access, authenticated browser automation, or media
   re-serving. Evidence classes never merge: synthetic, graph, import,
   public-web and aggregator rows stay distinguishable end to end.
4. **Never diff a partial read.** `PARTIAL` scans are stored and labelled; they
   cannot produce a "lost follower", a "deleted post" or an empty roster result.
5. **Evidence integrity.** Every persisted fact has an evidence row with source
   id, observation id, observed/captured times, confidence and a hash when one
   exists. Recorded facts are never dropped, replayed or downgraded.
6. **The registry decides capability.** A capability is `available` only when a
   provider method supplies it and the pipeline is wired end to end;
   `docs/CAPABILITIES.md` is generated from the registry and a test fails when
   it drifts.
7. **No fabricated absence.** A refused or failed read never yields an empty
   dataset or a zero: the refusal is reported as a typed error with its reason.
8. **No secrets in output.** `config`, `doctor`, logs, errors and evidence rows
   print presence and shape, never values.
9. **Ownership scoping.** Every read and write is scoped to the deployment
   owner; no query can reach another owner's targets, rows or evidence.
10. **Unmetered by default.** A metered or credential-requiring API is never
    reached without explicit opt-in; synthetic data is labelled everywhere
    (`_meta.synthetic`, source ids, banners).

## Changing things

| Goal | Start here |
|---|---|
| New agent operation | `apps/cli/src/tools.ts` → `apps/cli/src/mcp/server.ts` → `apps/cli/src/main.ts` → tests |
| New capability | `packages/core/src/capabilities.ts` (state + reason) → provider method → persistence → `pnpm docs:capabilities` |
| New provider | Implement `InstagramProvider` in `packages/ingestion/src/`, register in `providerFromEnv`, add fixtures + conformance test |
| Schema change | `packages/database/src/schema/` then generate a migration; keep migrations additive |
| Scan behaviour | `workers/monitoring/src/` and `packages/database/src/jobs/` |
| Exit codes / errors | `packages/core/src/errors.ts`; keep the documented taxonomy stable |

## Tests

- Prefer behavior tests over implementation tests.
- A bug fix needs a test that fails before it and passes after.
- Keep database tests order-independent: drain queues, use unique fixtures.
- Assert the **absence** behavior explicitly — a missing reason is a real bug.
- One operations layer: CLI and MCP call the same functions in
  `apps/cli/src/tools.ts`; never add a second data path.
- A fixture set observes one account: never widen a fixture manifest to make a
  demo easier.

## Style

- TypeScript strict; no `any` in new public surfaces.
- Comments explain **why**, not what. Do not add comments that restate the code.
- Commit messages explain the reason for the change, not a file list.
- Do not reformat unrelated files or bump dependencies in a feature PR.

## Before you finish

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes, or the environment limitation is stated explicitly.
- [ ] `pnpm docs:capabilities` run if the registry changed.
- [ ] No new `null`-to-zero coercion, no new unlabelled synthetic path.
- [ ] README/docs updated if a user-facing command or default changed.

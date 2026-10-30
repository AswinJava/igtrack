# Contributing to IGTrack

Thanks for considering it. This project has an unusual constraint, so read the
first section before picking up an issue — it explains what counts as a good
contribution here.

## The one rule that matters

**Honesty about what is observable beats every other feature.**

IGTrack exists because other tools render "we don't know" as `0`. A change that
adds a capability is welcome. A change that makes an unavailable capability look
like an available one, that fills a null with a default, or that implies
observation where there was none, is not — no matter how good the demo looks.

Concretely, before you open a PR, ask:

- Does any new number claim more than the data supports?
- Does a new `UNAVAILABLE` case carry a reason?
- Could a partial/truncated read become a "change" or "loss" claim?
- Is a synthetic value clearly marked as synthetic to both humans **and** agents?

## Never acceptable

- Anything that circumvents access controls: undocumented endpoints, session
  cookies, private-account access, story/highlight proxying, media-byte
  re-serving, browser automation against Instagram.
- A paid, metered, or hosted dependency in the default path.
- Telemetry, analytics, phone-home, or a required account on someone else's
  server.
- Secrets in the repository, in fixtures, in logs, in URLs, or in error text.

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d          # Postgres 16 (also creates the igtrack_test database)
pnpm igtrack setup            # migrate + synthetic demo data
```

## Before you open a PR

```bash
pnpm typecheck                # must be clean
pnpm test                     # needs the Postgres container running
```

Report anything you could not run. A PR that says "tests not run, no Docker
here" is far more useful than one that implies everything passed.

## Where to change what

| You want to… | Go to |
|---|---|
| Add an agent-facing operation (CLI + MCP) | `apps/cli/src/tools.ts`, then `apps/cli/src/mcp/server.ts` + `apps/cli/src/main.ts` + tests |
| Add or change what the product can observe | `packages/core/src/capabilities.ts` (the registry) and the provider that supplies it |
| Add a data source | `packages/ingestion/src/` implementing `InstagramProvider` |
| Change persistence | `packages/database/src/schema/`, then generate a migration |
| Change scan behaviour, retries or resumability | `workers/monitoring/src/` |

Architecture and invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
If you are an AI coding agent, read [AGENTS.md](AGENTS.md) — it is written for you.

## Adding a provider

Providers are how IGTrack stays useful without bending rules. A new provider is
welcome when the data comes from a lawful source you are entitled to read:

1. Implement `InstagramProvider` and return `CapabilityResult` values, including
   honest `UNAVAILABLE` notes.
2. Normalize into the existing `Normalized*` models — do not add a parallel shape.
3. Register the source kind, teach `providerFromEnv()` to construct it, and fail
   fast on missing configuration (a missing credential is an error, never "no data").
4. Update the capability registry and its reasons.
5. Add fixtures plus a conformance test (see `packages/core/test/conformance-harness.ts`).

Ideas that fit the rules: an importer for Instagram's own data export, a
user-supplied capture/JSON provider, or another platform's official API.

## Commit and PR style

- Small, scoped commits with a message that explains **why** the change is right,
  not just what moved.
- One logical change per PR. Include the verification you actually ran.
- Do not reformat unrelated files, and do not bump dependencies unnecessarily.

## License

Contributions are accepted under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
By opening a PR you confirm you have the right to contribute the code under that
license.

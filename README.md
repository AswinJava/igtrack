# IGTrack

**An evidence-first observation engine for Instagram accounts you are authorized to observe — self-hosted, fixture-first, and driven by your own AI agent.**

Free forever. No subscription, no hosted tier, no telemetry, no account to create here. You run it on your machine or your own free-tier infrastructure, and you point Claude Code, Codex, Cursor, or any MCP client at it.

```text
Paste today's brand hashtags?  No.

               observed            derived              refused
               ────────            ───────              ───────
profile        snapshot 12:00      +40 followers        follower *list* (not exposed)
stories        tray 12:00          count delta 40→46    liker lists
posts          media 12:00         mention appeared     highlights
follow lists   page 1..3 COMPLETE  relationship rank    media bytes
comments       page 1..2 COMPLETE  (all with evidence)
```

---

## The problem

Anyone who runs a public account eventually asks: **what changed, when, and how do I know?**

Two kinds of tools claim to answer it, and both lie:

- **Scrapers and "anonymous viewers"** reach around access controls with undocumented endpoints and hardcoded credentials. They are brittle and unlawful, and their "insights" are fields the upstream API handed them. They cannot tell you whether a mention was *rendered*.
- **Analytics dashboards** report numbers with no provenance. Absence is drawn as zero, so a count that was **never observable** looks identical to a count that **is** zero.

The gap is not more data. The gap is **epistemic integrity**: record what was observed, when, from which source, under which permission — and show absence *as absence*.

> Every claim carries provenance. Anything the law, the platform, or your permissions do not expose is reported **UNAVAILABLE with a reason** — never as zero, never as a guess, never as a scrape.

## What it does

- **Observes** — profile, active stories, story mentions, following/follower counts, public posts, comments, carousels, **tagged media** (media by other accounts that tag the owned account, through the documented tags edge — stored first-observed-wins; removal is never claimed), and **own-account insights** (follower-count series, daily reach/views/engagement, country demographics). Each observation is stored with source id, observation id, observed vs. captured time, confidence, and SHA-256 hashes in an append-only evidence ledger. When explicitly enabled, `igtrack lookup <username>` also **probes** another public professional account's public profile and recent media through the documented Business Discovery edge — read-through, persisted nowhere. Recording such an account is a second, explicit act: `igtrack targets add <username> --observed` probes the route once, refuses with the platform's reason if it cannot answer, and only then tracks it; `igtrack dossier <username>` reads the recorded profile, its bounded media preview (the ceiling is stated, never shown as "the account's posts"), the per-capability coverage, and the refusals, each with its reason. `igtrack mention <commentId>` reads one comment that mentions the owned account, on demand, from an id delivered by a Meta webhook — read-through, persisted nowhere.
- **Derives** — follow deltas, profile changes, **post caption edits and disappearances** (posts no longer observed in a complete media listing — never called "deleted"), story lifetimes, mention roll-ups, relationship rankings (story mentions, comment authorship on owned media, follow deltas) and **insight series**. Every derived row points at the observations it came from. Truncated (PARTIAL) scans are recorded but **never diffed**, so partiality cannot fabricate a "lost follower" or a vanished post, and a metric the platform did not return is stored as an **absence with a reason**, never a zero.
- **Refuses, out loud** — follower/following *rosters* of other accounts, liker lists, another account's comments/likes, repost identities, other accounts' highlights, and media bytes are not exposed by any supported interface. IGTrack names the reason instead of inventing a number — including on the one cross-account route it does support, where unreachable classes (consumer, private, age-gated) return the platform's reason, never an empty profile. `igtrack capabilities` prints the whole registry.
- **Runs itself** — a Postgres-backed job queue (`FOR UPDATE SKIP LOCKED`, leases, heartbeats, resumable paged scans, checkpoints, retry classification) plus a scheduler with per-target cadence.
- **Speaks agent** — `igtrack`, a JSON-first CLI, and `igtrack mcp`, a stdio MCP server exposing the same operations as tools. One operations layer, two surfaces, no drift.

## Quickstart (free, ~2 minutes)

Requires Node ≥ 22, pnpm, and Docker (for Postgres).

```bash
pnpm install
cp .env.example .env                     # local Postgres defaults already work
docker compose up -d                     # Postgres 16 on localhost:5432

pnpm igtrack setup                       # migrate + load the synthetic demo
pnpm igtrack status                      # provider, targets, queue, source health
pnpm igtrack scans run                   # queue scans
pnpm igtrack work --max 10               # run the worker: this is what observes
pnpm igtrack activity                    # what was observed, with evidence ids
pnpm igtrack insights target_a           # own-account insights: the recorded series, absences named
```

No database configured yet? `pnpm igtrack setup --local` uses the Docker Compose
database and records the URL in `.env` for you.

Everything in the default path is **synthetic fixture data**, labelled as such on
every payload (`_meta.synthetic: true`) and on every screen. It is deterministic,
offline, and legal to run forever. It exists so you can see the whole system
working — including its honesty surfaces — before pointing it at a real account.

## Use it with your AI agent

Add the MCP server to any MCP client:

```bash
claude mcp add igtrack -- node /absolute/path/to/igtrack/apps/cli/bin/igtrack.mjs mcp
```

Or in JSON form, for clients that take a config file:

```json
{
  "mcpServers": {
    "igtrack": {
      "command": "node",
      "args": ["/absolute/path/to/igtrack/apps/cli/bin/igtrack.mjs", "mcp"]
    }
  }
}
```

Then ask your agent things like:

> *"Queue a scan, run the worker, and tell me everything that changed on aurora.wilde in the last 7 days. Quote the evidence id for each claim. If something isn't observable, say so instead of guessing."*

The server ships instructions that tell the agent the same rules this README does: `null` means *not observable* (never zero), synthetic data must be declared as synthetic, and lawfully unavailable data must not be chased. Nineteen tools are exposed, all backed by the same operations the CLI uses.

Prefer plain CLI? Everything is JSON-first and scriptable:

```bash
pnpm igtrack status --json | jq '.data.provider'
pnpm igtrack activity --since 7d --json | jq '.data.items[] | {type, summary, evidenceId}'
pnpm igtrack evidence --id <evidenceId> --json | jq '.data.chain.lineage'
```

Machine-readable output goes to **stdout** and diagnostics to **stderr**, so
piping is always safe. The launcher is a plain Node script, so anything that can
run Node can call it without pnpm:
`node apps/cli/bin/igtrack.mjs status --json`.

## Capability honesty, in one screen

```bash
pnpm igtrack capabilities
```

`18 of 23 capabilities are obtainable from a lawful source.` The rest are marked
`DOCUMENTED_ABSENT` with the exact reason and what would unlock them. This table
is generated from the same registry the CLI reads — the CLI cannot advertise
more than the code delivers. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

## Going live (optional, lawful path only)

Live observation uses the **official Instagram Graph API against your own
Business/Creator account**. It is the only lawful path, and it is a narrow one: the
Graph API exposes profile, stories, media and comments for the authorized account
— plus own-account **insights** (follower-count series, daily reach/views/
engagement, country demographics) that no other source can supply — but not
follower rosters for arbitrary accounts.

```bash
# .env  (never commit these; use your platform's secret store in production)
IGTRACK_PROVIDER=graph
IGTRACK_GRAPH_ACCESS_TOKEN=...        # long-lived token
IGTRACK_GRAPH_IG_USER_ID=...
IGTRACK_GRAPH_USERNAME=...
# Optional, explicit opt-in: the documented Business Discovery edge, the ONE
# route to another public professional account's public data. `igtrack lookup
# <username>` then renders that account's public profile plus a bounded
# recent-media preview — a probe that persists nothing. Consumer and private
# accounts are unreachable; age-gated accounts return nothing; both are
# reported with the reason, never as an empty profile.
IGTRACK_GRAPH_BUSINESS_DISCOVERY=1
```

```bash
pnpm igtrack doctor          # confirms provider usability, never prints secrets
pnpm igtrack scans run && pnpm igtrack work
```

There is no provider, now or planned, that reaches around access controls. See
[docs/CAPABILITIES.md](docs/CAPABILITIES.md) and the non-goals below.

## Real rosters from your own export (import provider)

Instagram ships your account's data to you directly ("Download your
information", JSON form). Point IGTrack at it and the **real**
follower/following roster runs the same evidence pipeline as everything else —
no cookies, no scraping, no session:

```bash
IGTRACK_PROVIDER=import
IGTRACK_IMPORT_DIR=/path/to/export   # its root, connections/, or followers_and_following/
IGTRACK_IMPORT_USERNAME=yourhandle   # the export's owner — the only account observed
```

The export carries rosters and nothing else: profile, stories, posts and
insights answer `UNAVAILABLE` with the reason, never zero. A synthetic example
layout lives at `packages/ingestion/fixtures/import-sample/`.

## Running the worker

```bash
pnpm igtrack work --max 25            # foreground: one scheduler tick + drain the queue
pnpm --filter @igtrack/monitoring start   # long-running daemon (scheduler + poll loop)
```

One worker process is enough for a personal deployment; the queue is
multi-worker safe if you scale out.

## How it is built

| Path | What it is |
|---|---|
| `packages/core` | Domain core: observation categories, epistemics, capability results, typed errors with retryability, evidence hashing, profile/follow diffs, mention classification. **Zero runtime dependencies.** |
| `packages/database` | PostgreSQL schema (Drizzle), repositories, append-only evidence ledger, job queue + scheduler primitives, migrations, synthetic seed. |
| `packages/ingestion` | Providers and normalizers: `fixture:v1` (deterministic synthetic) and `graph` (official Graph API, owned account). Includes the documented-field audit behind the capability registry. |
| `workers/monitoring` | Job runner: claim → execute → complete, per-kind executors, checkpoints + staging, lease heartbeats, provider timeouts, retention. |
| `apps/cli` | `igtrack` CLI and `igtrack mcp` server. The agent surface. |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and the
invariants that hold it together, and [AGENTS.md](AGENTS.md) if you are an AI
coding agent working in this repository.

## Verify it yourself

```bash
pnpm typecheck      # all packages
pnpm test           # unit + integration (needs the Docker Postgres)
```

## Non-goals (deliberately not built)

- Monitoring accounts you do not own or are not authorized to observe.
- Private-account access; story/highlight proxy viewing; media download pipelines.
- Follower **rosters** for arbitrary accounts, liker lists, interaction feeds
  (another account's comments/likes on posts you do not own), repost attribution,
  other accounts' highlights (visible or hidden), tags on other accounts' stories,
  and any recursive crawl of the follow graph — the platform does not expose them,
  and inferring them locally would be dishonest. Each refusal with its evidence is
  recorded in [docs/FOUNDING.md](docs/FOUNDING.md) §14.
- Hosted multi-tenant SaaS, billing, seats, or any paid tier. Ever.
- Mobile app, browser extension, or browser-automation path.
- Any AI inference that launders speculation into "findings". If it was not
  observed or derived from observations, it is not shown.

## License

**AGPL-3.0-or-later.** Use it, self-host it, modify it, build on it. If you run a
modified version as a network service for others, publish your changes — that is
the whole point of the choice. See [LICENSE](LICENSE) and the reasoning in
[docs/FOUNDING.md](docs/FOUNDING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

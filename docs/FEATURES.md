# Feature reference

Everything IGTrack exposes, in one place. For the reasoning behind the system,
read [ARCHITECTURE.md](ARCHITECTURE.md); for the state of every capability, read
[CAPABILITIES.md](CAPABILITIES.md).

- [Surfaces](#surfaces)
- [CLI commands](#cli-commands)
- [MCP tools](#mcp-tools)
- [Providers](#providers)
- [Evidence model](#evidence-model)
- [Reports and periods](#reports-and-periods)
- [Research and claims](#research-and-claims)
- [Configuration](#configuration)
- [Testing](#testing)

## Surfaces

| Surface | Entry point | Best for |
|---|---|---|
| CLI | `igtrack <command>` | Humans, scripts, cron |
| Plain English | `igtrack ask "…"` or `igtrack "…"` | First-time use, exploratory questions |
| MCP server | `igtrack mcp` | Claude Code, Codex, Cursor, any MCP client |
| JSON | every command accepts `--json` | Automation; stdout is data, stderr is diagnostics |

A bare `igtrack` opens an interactive session. `igtrack guide` prints a
plain-language tour. `igtrack help <command>` prints that command's contract.

## CLI commands

### Setup and diagnosis

| Command | What it does |
|---|---|
| `igtrack setup` | Migrate the database and, on an empty database, load the synthetic demo. `--local` uses the Compose database. |
| `igtrack config` | Show resolved configuration — presence and shape, never secret values. |
| `igtrack status` | Provider, synthetic flag, targets, queue depth, source health. |
| `igtrack doctor` | Explain why a provider or deployment is not usable, with the fix. |
| `igtrack capabilities` | The full capability registry: state, supplier, reason. |

### Targets and observation

| Command | What it does |
|---|---|
| `igtrack targets list \| add \| rm \| pause \| resume` | Manage observed accounts. `add --observed` uses the documented Business Discovery edge for another public professional account. |
| `igtrack scans run` | Queue scans. Queuing is not observing. |
| `igtrack scans list` | Inspect queued, running and terminal jobs. |
| `igtrack work` | Execute queued jobs in the foreground (one scheduler tick + drain). |
| `igtrack activity` | The change feed, with evidence ids. `--since 7d`, `--type`, `--json`. |
| `igtrack relationships` | Relationship ranking by evidence class. |
| `igtrack dossier` | Read back everything recorded about one account, with coverage and gaps. |
| `igtrack evidence` | One evidence row and its lineage. |
| `igtrack evidence chain` | The full chain behind a claim. |

### Read-through (writes nothing)

| Command | What it does |
|---|---|
| `igtrack public <handle>` | Read a logged-out public profile page in local headless Chrome. |
| `igtrack post <post URL>` | Read one public post/reel/tv page from its permalink. |
| `igtrack anonstories <handle>` | Login-free stories, highlights and story mentions via a third-party aggregator. |
| `igtrack lookup <handle>` | Probe another public professional account through the documented Business Discovery edge. |
| `igtrack mention <commentId>` | Read one comment that mentions the owned account, by id. |
| `igtrack audit <handle>` | The read-only investigation report: config, probe, stored record, public web, refusals. `--url`, `--max-sources`, `--json`. |

### Investigation and reports

| Command | What it does |
|---|---|
| `igtrack investigate <handle>` | The primary workflow: every supported stage, one dossier. `--url`, `--no-web`, `--force`, `--json`. |
| `igtrack report <target> --period weekly\|monthly\|quarterly\|yearly` | Compose one calendar period from stored rows. `--at <date>`, `--format md`, `--out`. |
| `igtrack reports <target>` | Which periods have stored data. |
| `igtrack audience <target>` | Mutuals and one-way follows over COMPLETE rosters only. |
| `igtrack recent <target>` | First-seen follow changes since the stored baseline. `--direction`. |
| `igtrack insights <target>` | Own-account insight series, with absences named. |
| `igtrack tags <target>` | Tagged media rows. |
| `igtrack export <target> --kind <kind> --format csv\|json` | Stored rows with provenance columns. `--search`, `--out`. |
| `igtrack digest` | Short change summary across targets. `--since`, `--out`. |
| `igtrack alerts` | The same events as alert records; `--out <dir>` is an idempotent local outbox. |

### Claims and research

| Command | What it does |
|---|---|
| `igtrack claims add \| list \| retract` | The cited-claims ledger. Sensitive person-level predicates are refused at write time. |
| `igtrack research <target>` | Deterministic report of platform observations and external claims, kept separate. `--format md`. |
| `igtrack research <target> --run --question "…"` | Bounded public-web acquisition, extraction and validation. `--url`, `--max-sources`, `--refresh`. |
| `igtrack plan <target>` | The one next action derived from stored state; recomputed on every call. |

### Agent surfaces

| Command | What it does |
|---|---|
| `igtrack ask "…"` | Plan and run operations from a sentence; returns understanding, assumptions, steps and answer. `--dry-run`. |
| `igtrack mcp` | Start the stdio MCP server. |

## MCP tools

38 tools, all backed by the same operations layer as the CLI.

**Orientation** — `igtrack_ask`, `igtrack_status`, `igtrack_capabilities`,
`igtrack_doctor`, `igtrack_plan`

**Targets and jobs** — `igtrack_targets_list`, `igtrack_target_add`,
`igtrack_target_set_status`, `igtrack_target_remove`, `igtrack_scans_run`,
`igtrack_scans_list`, `igtrack_work`

**Read-back** — `igtrack_activity`, `igtrack_relationships`, `igtrack_dossier`,
`igtrack_evidence`, `igtrack_evidence_chain`, `igtrack_tags`, `igtrack_insights`

**Read-through** — `igtrack_public`, `igtrack_post`, `igtrack_anonstories`,
`igtrack_lookup`, `igtrack_mention_read`, `igtrack_audit`

**Investigation and periods** — `igtrack_investigate`, `igtrack_report`,
`igtrack_reports`, `igtrack_audience`, `igtrack_recent`, `igtrack_export`,
`igtrack_digest`, `igtrack_alerts`

**Claims and research** — `igtrack_claims_list`, `igtrack_claim_add`,
`igtrack_claim_retract`, `igtrack_research`, `igtrack_research_run`

The server ships tool descriptions that state the negative contract next to the
positive one: what the tool will refuse, what `null` means, and when a result is
synthetic. An agent does not need this README to use it correctly.

## Providers

| Id | Source | Evidence class | Persists | Notes |
|---|---|---|---|---|
| `fixture` | Deterministic synthetic set | `SYNTHETIC` | Yes | Default. Labels every payload. Observes only its manifest's account. |
| `graph` | Meta Instagram API | `GRAPH_API` | Yes | Owned Business/Creator account. Optional Business Discovery for another public professional account. |
| `import` | Your own Instagram export | `IMPORT` | Yes | Real rosters, lawfully. Profile/posts/insights are `UNAVAILABLE` — the export does not carry them. |
| `public` | Logged-out profile/post/reels pages | `PUBLIC_WEB` | Opt-in | Local headless Chrome. No cookies, no login wall bypass. |
| `anonstories` | Third-party story aggregator | `PUBLIC_AGGREGATOR` | Opt-in | Medium confidence; username is validated on every response. |
| research engine | Public web, operator-named or search-discovered | `WEB` | Claims | Bounded, SSRF-gated, robots-respecting, closed predicate registry. |

Provider selection: `IGTRACK_PROVIDER`. See the full variable reference in
[.env.example](../.env.example).

## Evidence model

Every observation writes two things: the row and its evidence.

| Field | Meaning |
|---|---|
| `source_id` | Which provider and version produced the row. |
| `observation_id` | Stable identity for the observation event. |
| `observed_at` | When the source says the fact was true. |
| `captured_at` | When this deployment read it. |
| `confidence` | The provider's own assessment, carried through unchanged. |
| `raw_hash` | SHA-256 of the transported payload, when one exists. |

The ledger is append-only. Derived rows point at the observation ids they used.
A `CapabilityResult` is one of `AVAILABLE`, `PARTIAL`, `UNAVAILABLE` or `ERROR`;
`UNAVAILABLE` always carries a reason.

Three rules are enforced in code and tests:

1. **Never zero-fill.** A metric the source did not return is `null` with a
   reason, in SQL, JSON, tables and reports.
2. **Never diff a partial read.** Truncated scans are stored and labelled; they
   cannot produce a "lost follower" or a "deleted post".
3. **Never merge evidence classes.** A synthetic row is never presented as live;
   a public-web statement is never presented as a platform observation.

## Reports and periods

`report` composes eleven sections from stored rows: profile, audience, content,
engagement, stories, comments, story mentions, tagged media, insights,
relationships, and coverage/provenance. Each section is `OBSERVED`, `DERIVED`,
`EMPTY` or `UNAVAILABLE`. Weeks start Monday; all boundaries are UTC with an
exclusive end.

A report never scans, queues or writes, so the same window renders the same
document later. `--at` selects the period containing a date. `reports` indexes
which periods can be composed.

`audience` uses the latest COMPLETE follower and following snapshots only. A
PARTIAL snapshot would make every unread member look like a non-follower, so it
is refused with the reason. `recent` uses the first COMPLETE roster on a side as
its baseline and reports first-seen times — Instagram exposes no follow
timestamp, and IGTrack never invents one.

## Research and claims

The claims ledger stores findings an operator or agent researched under its own
authority:

- a closed predicate registry;
- source URL, short excerpt and SHA-256;
- stated, retrieved and recorded times kept distinct;
- write-time refusal of sensitive person-level predicates;
- derived `CORROBORATED` (≥2 distinct domains) and `CONFLICTED` (both shown, no
  winner) labels, computed from rows and never stored;
- duplicate submissions refused — repetition is not corroboration.

`research --run` is the only acquisition path. It is bounded to 10 documents at
depth 1, 10s per document, 512KB per document, 3 re-validated redirects and a
24h freshness window. Every URL passes an SSRF gate; private, loopback,
link-local and metadata addresses are refused, Instagram-family hosts are refused
by policy, and robots.txt is respected. Extraction reads four fixed field
families (JSON-LD, meta tags, mailto, public profile links), never page prose —
a fetched page cannot prompt-inject its way into a claim.

## Configuration

Configuration is environment-only. `.env.example` documents every variable,
its default, and its effect.

| Group | Key variables |
|---|---|
| Database | `DATABASE_URL`, `IGTRACK_TEST_DATABASE_URL` |
| Provider | `IGTRACK_PROVIDER`, `IGTRACK_FIXTURE_VERSION`, `IGTRACK_GRAPH_*`, `IGTRACK_IMPORT_*` |
| Browser reads | `IGTRACK_CHROME_PATH` |
| Worker | `IGTRACK_JOB_POLL_MS`, `IGTRACK_JOB_LEASE_MS`, `IGTRACK_JOB_MAX_ITER`, `IGTRACK_RETENTION_*` |
| Research | `IGTRACK_RESEARCH_SEARCH_PROVIDER`, `IGTRACK_RESEARCH_SEARCH_API_KEY` |
| Logging | `IGTRACK_LOG_LEVEL` |

A missing database URL is a startup error, never an empty dataset. An unknown
provider name fails fast. Missing Graph credentials fail fast. A missing
credential must never be indistinguishable from "no data".

## Testing

```bash
pnpm typecheck      # every package
pnpm test           # unit + integration against real PostgreSQL
pnpm verify:graph   # live probe for Graph fields, when credentials exist
```

The suite covers the queue, scanner resumability, lease loss, retention, the
evidence ledger, every refusal path, the capability registry drift check, and the
CLI/MCP surfaces. Tests that need PostgreSQL fail loudly when it is missing
instead of skipping.

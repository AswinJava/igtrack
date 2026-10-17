# IGTrack — user guide

IGTrack answers questions about Instagram accounts you are authorized to
observe, and it tells you exactly what it saw, when, and what it could **not**
see. This guide is the non-technical tour: how to start it, how to ask, how to
read the answer, and what it will refuse to do.

## 1. Start it (about two minutes)

You need Node 22+, pnpm and Docker installed.

```bash
pnpm install
cp .env.example .env
docker compose up -d          # starts Postgres
pnpm igtrack setup            # creates the database, loads the synthetic demo
```

Then:

```bash
pnpm igtrack guide            # a tour, with examples
pnpm igtrack ask "what can you do?"
```

The first run uses **synthetic demo data**. Every answer says so
(`_meta.synthetic: true`). Nothing in the demo is an observation of a real
person.

## 2. Three ways to use it

| You want | Type | Notes |
| --- | --- | --- |
| Plain English | `igtrack ask "…"` | Easiest. Also works without `ask`: `igtrack "…"` |
| Exact commands | `igtrack investigate <username>` | Every command accepts `--json` |
| Your AI agent | `igtrack mcp` | The agent calls `igtrack_ask` with your sentence |

With no prompt at all, `igtrack` opens an interactive session. Type `help` for
the tour, `exit` to leave.

For an AI agent (Claude Code shown; any MCP client works):

```bash
claude mcp add igtrack -- node /absolute/path/to/igtrack/apps/cli/bin/igtrack.mjs mcp
```

Then just ask the agent in your own words. It passes the sentence to
`igtrack_ask`, which does the same planning and returns the same answer you
would get in the terminal.

## 3. What you can ask

| Ask | What runs |
| --- | --- |
| "investigate @name" / "who is @name?" / "what do we know about @name?" | Full investigation, one dossier |
| "what changed on @name in the last 7 days?" | Recorded change events, with evidence ids |
| "who does @name interact with most?" / "top 10 connections" | Relationship ranking |
| "show me the insights for @name" | Recorded metrics, with absences named |
| "which posts is @name tagged in?" | Tagged media rows |
| "show claims about @name" / "any contradictions?" | Claims ledger and research report |
| "what should I do next for @name?" | The next step derived from stored state |
| "show me the evidence for ev_…" | One evidence row and its lineage |
| "give me the weekly report for @name" | One period composed from stored rows |
| "which weeks have data for @name?" | The period index, with stored event counts |
| "who doesn't follow @name back?" | Mutuals and one-way follows over complete rosters |
| "who did @name recently follow?" / "who unfollowed @name?" | First-seen follow changes since the stored baseline |
| "export @name's posts as csv" | Stored rows as CSV or JSON |
| "what changed in the last 7 days?" | A short change digest, with evidence ids |
| "track @name" / "scan @name now" | Records the account / queues and runs scans |
| "what's the status?" / "what can't you do?" | Deployment status / capability registry |

Time windows ("today", "last week", "since 2026-01-01", "24h"), limits
("top 5"), evidence ids and public URLs are picked out of the sentence
automatically.

### Reports, audience and exports as commands

If you prefer exact commands:

```bash
pnpm igtrack report @name --period weekly            # the current week; --at picks another date
pnpm igtrack reports @name                           # which weeks/months have stored data
pnpm igtrack audience @name                          # mutuals, follows-you-not-back, vice versa
pnpm igtrack recent @name --direction following      # newly followed / unfollowed since the baseline
pnpm igtrack export @name --kind posts --format csv --out posts.csv
pnpm igtrack digest --since 7d --out digest.txt      # what changed across all tracked accounts
pnpm igtrack alerts --since 7d --out alerts/         # one file per alert; re-runs write nothing twice
```

A report is built only from what is already stored — it never scans or writes.
Every section says **OBSERVED** (rows with evidence), **DERIVED** (arithmetic
over rows), **EMPTY** (the source answered; nothing was recorded in this
window) or **UNAVAILABLE** (the source cannot answer, with the reason). Weeks
start on Monday and all boundaries are UTC. An empty week is a gap in the
record, not a quiet account. The Markdown never prints the time it was
composed, so `--at` on the same ledger reproduces the same document later;
the JSON payload still carries `generatedAt`.

Every exported observation ends with its provenance: `evidence_id`,
`evidence_observed_at`, `source_id` and `synthetic`. If an evidence id cannot
be resolved those cells are left empty, never filled with a guess. The derived
`audience` export names both roster snapshot evidence ids on every row, and
only claims a source when both sides agree. `digest --out` writes exactly the
text it prints, so cron or an agent can deliver the file without a daemon.

`audience` refuses to use a truncated roster: if only a partial follower or
following read exists, it prints that instead of calling everyone a
non-follower. `export followers`/`export following` likewise refuse without a
complete roster. "Recent mutuals" lists the accounts that are mutuals now
**and** appear in the follow movement since `--since`; it is empty only when
both rosters are complete and no such movement was recorded, and `null` when
a roster side is missing.

`recent` answers the "who did they recently follow?" question on its own, with
no paywall and no async run. The first COMPLETE roster on the chosen side is the
baseline; every stored add or removal since then is listed with the time this
ledger **first saw it** — Instagram exposes no follow timestamp, so that time is
never presented as the follow time. The answer is `OBSERVED` with rows, `EMPTY`
when a baseline exists and nothing moved, or `UNAVAILABLE` when no COMPLETE
roster exists, with the source's reason. A side with no baseline reports `null`
counts, not zeros; `present now` and `mutual now` stay `null` when the roster
that would answer them is absent. Edges older than the baseline cannot be
dated and are never called recent.

`alerts` is the digest's events as alert records. `--out <dir>` writes each
one to its own file named by the event id and never overwrites an existing
file, so a cron job or agent can poll the window repeatedly without sending
the same alert twice; the run reports how many files it `written` and how many
already `existing`. There is no email, SMS or webhook: the folder is the
outbox.

## 4. How to read an answer

Every answer has the same shape:

```
You asked:           your sentence, unchanged
I understood:        the operations, the account, the window
Assumptions:         anything it had to infer, in plain words
Answer:              the result, with evidence ids in brackets
What ran:            each operation and its outcome
Next:                useful follow-ups
```

Rules that never change:

- **`null` / "unavailable" means not observable — never zero.** A missing
  number is not "0 followers"; it is a gap, and the reason is printed.
- **Synthetic data is labelled.** Never read a fixture answer as a real
  observation.
- **A gap is a finding.** "No stored change events" is a fact about the record,
  not proof that nothing happened.
- **Evidence ids are the receipt.** Quote one and `igtrack evidence --id <id>`
  shows the full chain behind the claim.

## 5. What it will not do from a prompt

- **Remove an account.** "delete @name" returns the exact command
  (`igtrack targets rm name --yes`) as a suggestion; you run it yourself after
  confirming. Deletion is irreversible.
- **Guess an account.** If the sentence names no account and none can be
  inferred, it asks which one, listing what is tracked.
- **Read stories or logged-out pages as part of `ask`.** Those use separate
  transports with different evidence classes; the answer names the command
  (`igtrack anonstories <name>` / `igtrack public <name>` /
  `igtrack post <post URL>`).
- **Fetch data the platform does not expose.** Follower/liker rosters of other
  accounts, other accounts' highlights, and media bytes are refused with a
  reason. `igtrack capabilities` prints the whole registry.

## 6. Troubleshooting

| Message | Do this |
| --- | --- |
| "No users exist" | `igtrack setup` |
| "Cannot reach Postgres" | `docker compose up -d`, then `igtrack doctor` |
| "provider is not usable" | `igtrack doctor` shows the exact gap |
| "No tracked target matches …" | `igtrack targets list`, or `igtrack investigate <username>` |
| Anything confusing | `igtrack ask "what can you do?"` |

IGTrack appends a "What to do next" line to every human-mode error when it
knows the fix. With `--json`, the same information arrives as a typed `code`
(`DB_UNAVAILABLE`, `TARGET_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, …), so a script
can branch on it without parsing prose.

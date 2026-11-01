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
| "audit user @name" / "collect everything you can about @name" | A collecting full audit: archive count history and every supported stage, then the read-only report |
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

If a sentence names no account, IGTrack asks which one instead of guessing:
the tracked accounts are listed as numbered options, and you can answer with a
number, an `@handle`, or `cancel`. With `--json` (or an AI agent) the same
question arrives as status `NEEDS_INPUT` with a structured `input` field, so
the agent asks you and re-sends the completed sentence.

### Reports, audience and exports as commands

If you prefer exact commands:

```bash
pnpm igtrack report @name --period weekly            # the current week; --at picks another date
pnpm igtrack reports @name                           # which weeks/months have stored data
pnpm igtrack tracker                               # watchlist, latest closed period
pnpm igtrack tracker @name --period monthly --at 2026-08-15  # one account's period card
pnpm igtrack activity-report @name --period monthly --at 2026-08-15  # four-tab Activity Report
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

`tracker` is the watchlist: one card per tracked account with new followings,
unfollows, posts, stories, comments, tags and mentions for the latest **closed**
period, and a detail card (rosters, commenters, comments, posts, hashtags,
next-scan state) when you name an account. It reads the same stored rows as
`activity-report`, so the counts agree; it never scans or writes. `--at`
selects a window exactly and may show the current one, marked `IN_PROGRESS`.
Unmeasured metrics are never zero: a follow count shows a number only when a
COMPLETE roster comparison measured it, and everything else carries its reason.

`activity-report` is the four-tab Activity Report over stored rows: Activity
Analytics, Ties & Trails, Stories & Highlights and AI Insights, with `daily`,
`weekly`, `monthly`, `quarterly` (SEASON) and `yearly` periods. `--data-id` reopens an
exact period listed in the inventory. The output still never zero-fills:
likes given, liker identities, interaction history, highlights and AI
inferences have no lawful source here, so they are `null` with
`UNAVAILABLE` and the capability-registry reason. `--json` carries the full
structure; the Markdown carries the same four tabs.

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
when a baseline exists and no add or removal was recorded in the window, or
`UNAVAILABLE` when no COMPLETE roster exists, with the source's reason. `EMPTY`
says which of two facts it is in its own note: a COMPLETE roster re-read inside
the window with nothing changed is a computed no-change, while no re-read inside
the window only means nothing was observed between the older reads — never an
observed no-change. A side with no baseline reports `null`
counts, not zeros; `present now` and `mutual now` stay `null` when the roster
that would answer them is absent. Edges older than the baseline cannot be
dated and are never called recent.

`recent` also returns `countActivity`: the dated follower / following / post
counts stored for the account, the delta between consecutive observations, and
a net figure. Counts are exact integers from the source; a count delta is
movement of a number and never names who moved. It is `UNAVAILABLE` when fewer
than two comparable observations exist, with that reason — never a zero.

### The first look: `audit --full`

`recent` needs a baseline, so the first look at an account would otherwise
answer only "nothing is stored yet". The prompt `audit user @name` runs this
collecting audit too. `igtrack audit @name --full` adds a
collection phase that reads the public web archive's captures of the account's
profile page:

```bash
pnpm igtrack audit @name --full                 # last 30 days of archive captures
pnpm igtrack audit @name --full --days 180      # widen the window (1..365)
pnpm igtrack audit @name --full --json          # the full JSON envelope
```

Each archived capture carries a timestamp and the exact counts the page held at
that moment. They are stored as `PUBLIC_WEB` profile snapshots with
`observedAt` = capture time, marked `PARTIAL` (counts only) so they never
produce a profile change. The read-back then derives the count series and its
deltas for the days **before** this deployment ever saw the account.

What this is not: a roster. An archived capture proves the count moved, never
who followed or unfollowed. Named edges still require a COMPLETE roster (an
owner export or an authorized Graph session); the audit reports that gap with
its reason instead of filling it. Archive coverage is per-account and uneven,
so an empty window is a gap in the record, not a quiet account, and an
unreachable archive is `UNAVAILABLE` — a failure to look, never "no history".
Running the same audit again deduplicates captures already on record.

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
  `igtrack post <post URL>` / `igtrack viewer <name> --source both`).
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

import { CAPABILITY_REGISTRY, isCapabilityAvailable } from "@igtrack/core";
import { VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// The friendly surface: a welcome, a tour, and example prompts in plain
// language. Everything here is derived from the capability registry, so the
// guide cannot promise a capability the engine refuses.
// ---------------------------------------------------------------------------

export function welcomeText(version = VERSION): string {
  return `IGTrack ${version} — evidence-first Instagram observation engine (self-hosted)
No account here. No subscription. Your data stays on your machine.

Ask in plain English:
  igtrack ask "who is @aurora.wilde?"
  igtrack ask "what changed on @aurora.wilde in the last 7 days?"

New here?                     igtrack setup --local
Is this checkout ready?       igtrack status
Show me around (examples)     igtrack guide
Every command                 igtrack help

Anything you type that is not a command is treated as a prompt:
  igtrack "what changed on @aurora.wilde this week"`;
}

const UNAVAILABLE_EXAMPLES = (): string[] => {
  const unavailable = CAPABILITY_REGISTRY.filter((entry) => !isCapabilityAvailable(entry));
  const picked = unavailable.slice(0, 6).map((entry) => `  - ${entry.label}: ${entry.whyUnavailable ?? "not exposed"}`);
  return picked;
};

export function guideText(version = VERSION): string {
  const available = CAPABILITY_REGISTRY.filter((entry) => isCapabilityAvailable(entry)).length;
  const total = CAPABILITY_REGISTRY.length;
  return `IGTrack ${version} — what it is and how to use it

WHAT IT DOES
  Give it an Instagram username and it produces an evidence-backed dossier:
  the public profile, what was observed and when, what changed, who the account
  interacts with, public-web statements with citations, and — just as
  important — what it could NOT see and why.

  It is built for accounts you are authorized to observe. It does not log in,
  scrape private data, or circumvent access controls, and it says so instead
  of inventing a number.

THE ONE RULE
  A missing value is printed as "unavailable" with a reason, never as 0.
  Synthetic demo data is labelled synthetic on every output.

THREE WAYS TO USE IT
  1. Prompt it (easiest):
       igtrack ask "investigate @aurora.wilde"
       igtrack ask "what changed on @aurora.wilde this week?"
       igtrack ask "top 5 accounts @aurora.wilde interacts with"
     You can also skip the word "ask": igtrack "who is @aurora.wilde?"

  2. Command it (precise flags and JSON):
       igtrack investigate @aurora.wilde
       igtrack activity --since 7d --json
       igtrack dossier @aurora.wilde

  3. Give it to your AI agent (MCP):
       igtrack mcp
     Every operation is a tool; igtrack_ask accepts a raw sentence and routes it.

60-SECOND START
  1. pnpm install
  2. docker compose up -d
  3. pnpm igtrack setup --local
  4. pnpm igtrack investigate aurora.wilde
  5. pnpm igtrack ask "what can you do?"

WHAT YOU CAN ASK
  Investigation     "investigate @name", "who is @name?", "tell me everything about @name"
  Changes           "what changed on @name in the last 7 days?", "what's new?"
  Relationships     "who does @name interact with most?", "top 10 connections"
  Content           "which posts is @name tagged in?", "show recent activity"
  Insights          "show insights for @name", "reach and engagement for @name"
  Stored record     "what do we know about @name?", "dossier @name"
  Sources           "what claims do we have about @name?", "show citations"
  Operations        "track @name", "scan @name now", "what's the status?"
  Limits            "what can't you do?", "is this legal?"
  Next step         "what should I do next for @name?"

COMMANDS
  setup                    Prepare .env, Postgres, migrations and demo data
  status                   Provider, targets, queue and source health
  doctor                   Diagnose configuration problems
  investigate <username>   The full workflow: every stage, one dossier
  public <username>        Logged-out public-page read (needs local Chrome)
  anonstories <username>   Login-free stories/highlights (third-party relay)
  audit <username>         One evidence-honest report, read-only
  activity                 What changed, newest first, with evidence ids
  relationships <target>   Accounts ranked by observed signal
  dossier <target>         Everything stored about one account, and its gaps
  insights <target>        Recorded metrics, with absences named
  tags <target>            Media by other accounts this account is tagged in
  evidence [--id <id>]     The evidence ledger and provenance chains
  targets list|add|pause|resume|rm
  scans run|list           Queue scans (work executes them)
  work                     Run the scheduler once and drain the queue
  research <target>        Full report: observations, claims, contradictions
  plan <target>            The honest next step from stored state
  capabilities             What can and cannot be observed, with reasons
  mcp                      Start the stdio MCP server for your AI agent

CONNECT YOUR AI AGENT
  Claude Code:
    claude mcp add igtrack -- node /absolute/path/to/apps/cli/bin/igtrack.mjs mcp

  Any MCP client (JSON):
    {
      "mcpServers": {
        "igtrack": {
          "command": "node",
          "args": ["/absolute/path/to/apps/cli/bin/igtrack.mjs", "mcp"]
        }
      }
    }

  Ask the agent: "Use igtrack_ask with my question. Quote evidence ids, and
  never turn 'unavailable' into zero."

WHAT IT DELIBERATELY REFUSES
  ${available} of ${total} registry capabilities are obtainable with this build.
  The refusals are product decisions, not missing features:
${UNAVAILABLE_EXAMPLES().join("\n")}

  Run "igtrack capabilities" for the complete registry with every reason.

TROUBLESHOOTING
  "No users exist"              igtrack setup
  "Cannot reach Postgres"       docker compose up -d
  "provider is not usable"      igtrack doctor
  "No targets"                  igtrack ask "investigate @yourhandle"
  Anything confusing            igtrack ask "what can you do?"

Every command accepts --json and prints { ok, data, _meta }. The _meta block
names the active provider and whether the data is synthetic.`;
}

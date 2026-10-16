import { loadProjectEnv } from "./env.js";
import { CliError, errorEnvelope, isJson, parseArgs, type ParsedArgs } from "./output.js";
import {
  CONFIG_HELP,
  runConfig,
  runDoctor,
  runSetup,
  runStatus,
  SETUP_HELP,
} from "./commands/setup.js";
import { runTargets, TARGETS_HELP } from "./commands/targets.js";
import { runScans, runWork, SCANS_HELP } from "./commands/scans.js";
import {
  CAPABILITIES_HELP,
  DOSSIER_HELP,
  INSIGHTS_HELP,
  LOOKUP_HELP,
  MENTION_HELP,
  runActivity,
  runCapabilities,
  runDossier,
  runEvidence,
  runInsights,
  runLookup,
  runMention,
  runRelationships,
  runTags,
  TAGS_HELP,
} from "./commands/read.js";
import { runMcp } from "./mcp/server.js";

// ---------------------------------------------------------------------------
// igtrack — the command line for a self-hosted, agent-driven observation engine.
//
// Contract for every command: it either prints one JSON envelope with an
// `ok: true|false` discriminant (--json) or a human table, and it exits 0 on
// success. Exit codes: 0 ok, 1 runtime failure, 2 usage/selection error,
// 3 configuration or connectivity error.
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";

const HELP = `igtrack ${VERSION} — evidence-first Instagram observation engine (self-hosted)

Usage: igtrack <command> [options]

Getting started
  setup                 Prepare this checkout: .env, Postgres, migrations, demo data
  status                Owner, provider, targets, queue, source health
  doctor                Diagnostic: provider usability, DB, scheduler, findings
  config                Effective configuration with credentials redacted

Track
  targets <sub>         list | add | pause | resume | rm        (targets --help)
  scans <sub>           run | list                              (scans --help)

Observe
  work                  Run the worker now: one scheduler tick + drain the queue
  activity              What changed, newest first, with evidence ids
  relationships <t>     Accounts ranked by observed signal, with provenance
  dossier <target>      Everything recorded about one account, with its gaps
  evidence              Evidence rows (audit trail) and --id chains
  lookup <username>     Ask the source what it can observe, persisting nothing
  insights <target>     Account metrics this deployment recorded, with absences
  tags <target>         Media by other accounts this account is tagged in
  mention <commentId>   Read one mentioned comment by id, persisting nothing

Know the limits
  capabilities          What can and cannot be observed, and exactly why

Agent surface
  mcp                   stdio MCP server exposing every operation above as a tool

Every command accepts --json and prints { ok, data, _meta }. \`_meta\` names the
active provider and whether the data is synthetic — fixture data is never
mistakable for a real observation.

Run \`igtrack <command> --help\` for command-specific detail.`;

function wantsHelp(args: ParsedArgs): boolean {
  return args.flags["help"] === true || args.flags["h"] === true;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  switch (args.command) {
    case "setup":
      if (wantsHelp(args)) {
        process.stdout.write(`${SETUP_HELP}\n`);
        return 0;
      }
      return runSetup(args);
    case "config":
      if (wantsHelp(args)) {
        process.stdout.write(`${CONFIG_HELP}\n`);
        return 0;
      }
      return runConfig(args);
    case "status":
      return runStatus(args);
    case "doctor":
      return runDoctor(args);
    case "targets":
      if (wantsHelp(args) || args.positionals[0] === "help") {
        process.stdout.write(`${TARGETS_HELP}\n`);
        return 0;
      }
      return runTargets(args);
    case "scans":
      if (wantsHelp(args) || args.positionals[0] === "help") {
        process.stdout.write(`${SCANS_HELP}\n`);
        return 0;
      }
      return runScans(args);
    case "work":
      return runWork(args);
    case "activity":
      return runActivity(args);
    case "relationships":
      if (wantsHelp(args)) {
        process.stdout.write(
          "igtrack relationships <target id|username> [--limit N]\n\nRank accounts by observed signal strength (story mentions, comment authorship\non owned media, follow deltas) against one tracked target, with\nmutual/observed state, first/last seen, the newest signal, and the stored rows\nbehind each count (--json includes them).\n",
        );
        return 0;
      }
      return runRelationships(args);
    case "dossier":
      if (wantsHelp(args)) {
        process.stdout.write(`${DOSSIER_HELP}\n`);
        return 0;
      }
      return runDossier(args);
    case "evidence":
      if (wantsHelp(args)) {
        process.stdout.write(
          "igtrack evidence [--limit N] [--json]\nigtrack evidence --id <evidenceId>\n\nThe evidence ledger: hashes, source, observed vs captured time, and — for one\nrow — its full provenance chain.\n",
        );
        return 0;
      }
      return runEvidence(args);
    case "lookup":
      if (wantsHelp(args)) {
        process.stdout.write(`${LOOKUP_HELP}\n`);
        return 0;
      }
      return runLookup(args);
    case "tags":
      if (wantsHelp(args)) {
        process.stdout.write(`${TAGS_HELP}\n`);
        return 0;
      }
      return runTags(args);
    case "mention":
      if (wantsHelp(args)) {
        process.stdout.write(`${MENTION_HELP}\n`);
        return 0;
      }
      return runMention(args);
    case "insights":
      if (wantsHelp(args)) {
        process.stdout.write(`${INSIGHTS_HELP}\n`);
        return 0;
      }
      return runInsights(args);
    case "capabilities":
      if (wantsHelp(args)) {
        process.stdout.write(`${CAPABILITIES_HELP}\n`);
        return 0;
      }
      return runCapabilities(args);
    case "mcp":
      // No context is built here: the server resolves it lazily on first call
      // so a client can connect even while the database is down.
      await runMcp();
      return 0;
    case "help":
    case "--help":
      process.stdout.write(`${HELP}\n`);
      return 0;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      process.stderr.write(`igtrack: unknown command "${args.command}".\n\n${HELP}\n`);
      return 2;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags["version"] === true || args.flags["v"] === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  // The web app is started by Next.js, which loads .env itself; the CLI and the
  // worker are plain Node processes, so the CLI loads it explicitly. Existing
  // environment variables always win.
  loadProjectEnv();
  const code = await dispatch(args);
  process.exitCode = code;
}

main().catch((err: unknown) => {
  const json = process.argv.includes("--json") || isJson(parseArgs(process.argv.slice(2)).flags);
  const code = err instanceof CliError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  const exitCode = err instanceof CliError ? err.exitCode : 1;
  if (json) {
    process.stderr.write(`${JSON.stringify(errorEnvelope(code, message), null, 2)}\n`);
  } else {
    process.stderr.write(`igtrack: ${message}\n`);
  }
  process.exitCode = exitCode;
});

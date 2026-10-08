import { loadProjectEnv } from "./env.js";
import { VERSION as CLI_VERSION } from "./version.js";
import { CliError, errorEnvelope, errorHint, isJson, parseArgs, type ParsedArgs } from "./output.js";
import {
  CONFIG_HELP,
  runConfig,
  runDoctor,
  runSetup,
  runStatus,
  SETUP_HELP,
} from "./commands/setup.js";
import { AUDIT_HELP, runAudit } from "./commands/audit.js";
import { INVESTIGATE_HELP, runInvestigate } from "./commands/investigate.js";
import { PUBLIC_HELP, runPublic } from "./commands/public.js";
import { POST_HELP, runPost } from "./commands/post.js";
import { ANONSTORIES_HELP, runAnonstories } from "./commands/anonstories.js";
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
import { ASK_HELP, runAsk, runAskPrompt, runBare, runGuide } from "./commands/ask.js";
import {
  ALERTS_HELP,
  AUDIENCE_HELP,
  DIGEST_HELP,
  EXPORT_HELP,
  RECENT_HELP,
  REPORT_HELP,
  REPORTS_HELP,
  runAlerts,
  runAudience,
  runDigest,
  runExport,
  runRecent,
  runReport,
  runReports,
} from "./commands/report.js";
import {
  CLAIMS_HELP,
  PLAN_HELP,
  RESEARCH_HELP,
  runClaims,
  runPlan,
  runResearch,
} from "./commands/intel.js";

// ---------------------------------------------------------------------------
// igtrack — the command line for a self-hosted, agent-driven observation engine.
//
// Contract for every command: it either prints one JSON envelope with an
// `ok: true|false` discriminant (--json) or a human table, and it exits 0 on
// success. Exit codes: 0 ok, 1 runtime failure, 2 usage/selection error,
// 3 configuration or connectivity error.
// ---------------------------------------------------------------------------

const VERSION = CLI_VERSION;

const HELP = `igtrack ${VERSION} — evidence-first Instagram observation engine (self-hosted)

Usage: igtrack <command> [options]

Getting started
  setup                 Prepare this checkout: .env, Postgres, migrations, demo data
  status                Owner, provider, targets, queue, source health
  doctor                Diagnostic: provider usability, DB, scheduler, findings
  config                Effective configuration with credentials redacted

Ask anything (plain English)
  ask "..."             One sentence in, one honest answer out
  guide                 A plain-language tour with examples and limits
  <anything else>       Treated as a prompt: igtrack "who is @aurora.wilde?"

Track
  targets <sub>         list | add | pause | resume | rm        (targets --help)
  scans <sub>           run | list                              (scans --help)

Observe
  investigate <username>  One username in, one dossier out: every supported
                           stage, what was retrieved, and what is still unknown
  public <username>     Full logged-out public-page dossier: profile, links,
                           highlights, every exposed post, and the gaps
  post <post URL>       One post from its own permalink: caption, owner,
                           counts, media, and what the page does not expose
  anonstories <username>  Login-free stories, highlight contents and story
                           mentions via a third-party aggregator; rows are
                           PUBLIC_AGGREGATOR, never a platform observation
  audit <username>      One evidence-honest report: config, probe, stored record
  work                  Run the worker now: one scheduler tick + drain the queue
  activity              What changed, newest first, with evidence ids
  relationships <t>     Accounts ranked by observed signal, with provenance
  dossier <target>      Everything recorded about one account, with its gaps
  evidence              Evidence rows (audit trail) and --id chains
  lookup <username>     Ask the source what it can observe, persisting nothing
  insights <target>     Account metrics this deployment recorded, with absences
  tags <target>         Media by other accounts this account is tagged in
  mention <commentId>   Read one mentioned comment by id, persisting nothing

Reports and exports
  report <target>       One period composed from stored rows (Markdown; --out)
  reports <target>      Recent periods and whether stored rows exist
  audience <target>     Mutuals and one-way follows over COMPLETE rosters
  recent <target>       New/lost follows since the stored baseline (first-seen)
  export <target>       Stored rows as CSV/JSON (--kind; --out)
  digest [target]       Short local change digest (--since; --out)
  alerts [target]       Digest events as an idempotent local outbox (--out <dir>)

Know the limits
  capabilities          What can and cannot be observed, and exactly why

Research (claims ledger; IGTrack stores, never generates)
  claims <sub>          list | add | retract                       (claims --help)
  research <target>     The full report: observations, claims, contradictions
  plan <target>         The stateless next step for a goal, from stored state

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
    case "ask":
      if (wantsHelp(args)) {
        process.stdout.write(`${ASK_HELP}\n`);
        return 0;
      }
      return runAsk(args);
    case "guide":
      return runGuide(args);
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
    case "audit":
      if (wantsHelp(args)) {
        process.stdout.write(`${AUDIT_HELP}\n`);
        return 0;
      }
      return runAudit(args);
    case "investigate":
      if (wantsHelp(args)) {
        process.stdout.write(`${INVESTIGATE_HELP}\n`);
        return 0;
      }
      return runInvestigate(args);
    case "public":
      if (wantsHelp(args)) {
        process.stdout.write(`${PUBLIC_HELP}\n`);
        return 0;
      }
      return runPublic(args);
    case "post":
      if (wantsHelp(args)) {
        process.stdout.write(`${POST_HELP}\n`);
        return 0;
      }
      return runPost(args);
    case "anonstories":
      if (wantsHelp(args)) {
        process.stdout.write(`${ANONSTORIES_HELP}\n`);
        return 0;
      }
      return runAnonstories(args);
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
      if (wantsHelp(args)) {
        process.stdout.write(
          "igtrack work [--max N] [--no-scheduler] [--json]\n\nRun the worker in the foreground: one scheduler tick, then claim and execute\nqueued jobs until the queue is empty or --max is reached. This acquires and\nstores observations; it does not compose reports.\n",
        );
        return 0;
      }
      return runWork(args);
    case "activity":
      if (wantsHelp(args)) {
        process.stdout.write(
          "igtrack activity [target] [--since 7d] [--limit N] [--json]\n\nWhat changed, newest first, with evidence ids. Covers every tracked target\nwhen none is named. Read-only: nothing is fetched, this is a report over\nstored observations.\n",
        );
        return 0;
      }
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
    case "report":
      if (wantsHelp(args)) {
        process.stdout.write(`${REPORT_HELP}\n`);
        return 0;
      }
      return runReport(args);
    case "reports":
      if (wantsHelp(args)) {
        process.stdout.write(`${REPORTS_HELP}\n`);
        return 0;
      }
      return runReports(args);
    case "audience":
      if (wantsHelp(args)) {
        process.stdout.write(`${AUDIENCE_HELP}\n`);
        return 0;
      }
      return runAudience(args);
    case "recent":
      if (wantsHelp(args)) {
        process.stdout.write(`${RECENT_HELP}\n`);
        return 0;
      }
      return runRecent(args);
    case "export":
      if (wantsHelp(args)) {
        process.stdout.write(`${EXPORT_HELP}\n`);
        return 0;
      }
      return runExport(args);
    case "digest":
      if (wantsHelp(args)) {
        process.stdout.write(`${DIGEST_HELP}\n`);
        return 0;
      }
      return runDigest(args);
    case "alerts":
      if (wantsHelp(args)) {
        process.stdout.write(`${ALERTS_HELP}\n`);
        return 0;
      }
      return runAlerts(args);
    case "claims":
      if (wantsHelp(args) || args.positionals[0] === "help") {
        process.stdout.write(`${CLAIMS_HELP}\n`);
        return 0;
      }
      return runClaims(args);
    case "research":
      if (wantsHelp(args)) {
        process.stdout.write(`${RESEARCH_HELP}\n`);
        return 0;
      }
      return runResearch(args);
    case "plan":
      if (wantsHelp(args)) {
        process.stdout.write(`${PLAN_HELP}\n`);
        return 0;
      }
      return runPlan(args);
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
    default: {
      // `igtrack scan --help` must never run the words as a prompt: a help
      // request is a read, and a bare verb can otherwise queue real scans.
      if (wantsHelp(args)) {
        process.stdout.write(`${HELP}\n`);
        return 0;
      }
      // Not a command: treat the whole line as a plain-English prompt. This is
      // what makes `igtrack who is @someone` and a mistyped command both work.
      const prompt = [args.command, ...args.positionals].join(" ").trim();
      if (prompt === "") {
        process.stderr.write(`igtrack: unknown command "${args.command}".\n\n${HELP}\n`);
        return 2;
      }
      return runAskPrompt(prompt, args);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv();
  if (argv.length === 0) {
    process.exitCode = await runBare(parseArgs([]));
    return;
  }
  const args = parseArgs(argv);
  if (args.flags["version"] === true || args.flags["v"] === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  // The web app is started by Next.js, which loads .env itself; the CLI and the
  // worker are plain Node processes, so the CLI loads it explicitly. Existing
  // environment variables always win.
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
    const hint = errorHint(code, message);
    if (hint !== null) process.stderr.write(`\nWhat to do next:\n  ${hint}\n`);
  }
  process.exitCode = exitCode;
});

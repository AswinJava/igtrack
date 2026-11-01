import { loadProjectEnv } from "./env.js";
import { VERSION as CLI_VERSION } from "./version.js";
import {
  CliError,
  envelope,
  errorEnvelope,
  errorHint,
  isJson,
  parseArgs,
  UsageError,
  type OutputMeta,
  type ParsedArgs,
} from "./output.js";
import { COMMAND_HELP, HELP, unknownFlags } from "./help-registry.js";
import { setRequestedOwner } from "./context.js";
import { runConfig, runDoctor, runSetup, runStatus } from "./commands/setup.js";
import { runAudit } from "./commands/audit.js";
import { runInvestigate } from "./commands/investigate.js";
import { runPublic } from "./commands/public.js";
import { runPost } from "./commands/post.js";
import { runAnonstories } from "./commands/anonstories.js";
import { runViewer } from "./commands/viewer.js";
import { runTargets } from "./commands/targets.js";
import { runScans, runWork } from "./commands/scans.js";
import {
  runActivity,
  runCapabilities,
  runDossier,
  runEvidence,
  runInsights,
  runLookup,
  runMention,
  runRelationships,
  runTags,
} from "./commands/read.js";
import { runMcp } from "./mcp/server.js";
import { runAsk, runAskPrompt, runBare, runGuide } from "./commands/ask.js";
import {
  runAlerts,
  runAudience,
  runDigest,
  runExport,
  runRecent,
  runReport,
  runReports,
} from "./commands/report.js";
import { runActivityReport } from "./commands/activity-report.js";
import { runTracker } from "./commands/tracker.js";
import { runClaims, runPlan, runResearch } from "./commands/intel.js";

// ---------------------------------------------------------------------------
// igtrack — the command line for a self-hosted, agent-driven observation engine.
//
// Contract for every command: it either prints one JSON envelope with an
// `ok: true|false` discriminant (--json) or a human table, and it exits 0 on
// success. Exit codes: 0 ok, 1 runtime failure, 2 usage/selection or
// not-found error, 3 configuration or connectivity error, 4 a read that
// completed and found nothing (never the same answer as 0).
// ---------------------------------------------------------------------------

const VERSION = CLI_VERSION;

/** Verbs whose subcommand contract is also reachable as `<command> help`. */
const SUBCOMMANDED = new Set(["targets", "scans", "claims", "evidence"]);

/**
 * `_meta` for a read of static CLI metadata. `provider: "none"` is deliberate:
 * answering `help`/`version` must not construct a provider, so claiming one
 * would be a lie about work that never happened.
 */
function staticMeta(note: string): OutputMeta {
  return {
    provider: "none",
    sourceId: null,
    synthetic: false,
    production: process.env["NODE_ENV"] === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
    note,
  };
}

function wantsHelp(args: ParsedArgs): boolean {
  // Presence, not `=== true`: `igtrack targets --help list` parses the token
  // after `--help` as its value, and a help request is never a value.
  return args.flags["help"] !== undefined || args.flags["h"] !== undefined;
}

/**
 * The registered command whose contract this call wants to read, if any.
 * Resolution goes through the registry so `igtrack help <command>` and
 * `igtrack <command> --help` cannot print two different contracts.
 */
function helpTopicRequested(args: ParsedArgs): string | undefined {
  const subcommandHelp = args.positionals[0] === "help" && SUBCOMMANDED.has(args.command);
  if (!(wantsHelp(args) || subcommandHelp)) return undefined;
  return COMMAND_HELP[args.command] === undefined ? undefined : args.command;
}

function printHelp(topic: string, flags: Record<string, string | boolean>): number {
  const text = COMMAND_HELP[topic];
  const json = isJson(flags);
  const meta = staticMeta("static CLI metadata: no provider was constructed, no source was contacted");
  if (text === undefined) {
    const message = `There is no igtrack command "${topic}". Run \`igtrack help\` for the list.`;
    if (json) {
      process.stderr.write(`${JSON.stringify(errorEnvelope("UNKNOWN_COMMAND", message), null, 2)}\n`);
    } else {
      process.stderr.write(`igtrack: ${message}\n`);
    }
    return 2;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope({ command: topic, help: text }, meta), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${text}\n`);
  return 0;
}

function printGeneralHelp(flags: Record<string, string | boolean>): number {
  if (isJson(flags)) {
    process.stdout.write(
      `${JSON.stringify(
        envelope(
          { commands: Object.keys(COMMAND_HELP), help: HELP },
          staticMeta("static CLI metadata: no provider was constructed, no source was contacted"),
        ),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`${HELP}\n`);
  return 0;
}

function runHelpTopic(args: ParsedArgs): number {
  const topic = args.positionals[0];
  if (topic === undefined) return printGeneralHelp(args.flags);
  // `igtrack help activity-report` and `igtrack help igtrack activity-report`
  // are the same question; hyphens, underscores and casing are how people type
  // a command name, not a different command.
  const tokens = args.positionals.map((token) => token.trim().toLowerCase()).filter((t) => t !== "");
  if (tokens[0] === "igtrack") tokens.shift();
  const key = (tokens[0] ?? "").replace(/_/g, "-");
  return printHelp(key, args.flags);
}

/**
 * Record the owner selection. `--user` is part of every command's contract, and
 * no command reads the parsed flags — each builds its own context — so the
 * router is the one place that can honour it. A bare `--user` is refused rather
 * than read as "no selection": silently falling back to the environment, or to
 * an ambiguity refusal, is the drop this gate exists to prevent.
 */
function selectOwner(flags: Record<string, string | boolean>): void {
  const value = flags["user"];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(
      "--user needs the owner's email, as in `igtrack status --user someone@example.com`. " +
        "No owner was named, so nothing ran.",
    );
  }
  setRequestedOwner(value);
}

async function dispatch(args: ParsedArgs): Promise<number> {
  const helpTopic = helpTopicRequested(args);
  if (helpTopic !== undefined) return printHelp(helpTopic, args.flags);

  // A flag the command has no contract for is refused before anything runs,
  // rather than read as nothing: an answer that silently ignored the caller's
  // request looks exactly like an answer that fulfilled it.
  const rejected = unknownFlags(args.command, args.flags);
  if (rejected.length > 0) {
    const names = rejected.map((name) => (name.length === 1 ? `-${name}` : `--${name}`)).join(", ");
    throw new UsageError(
      `igtrack ${args.command} does not accept ${names}. ` +
        `Run \`igtrack ${args.command} --help\` for the flags it reads.`,
    );
  }

  selectOwner(args.flags);

  switch (args.command) {
    case "ask":
      return runAsk(args);
    case "guide":
      return runGuide(args);
    case "setup":
      return runSetup(args);
    case "config":
      return runConfig(args);
    case "audit":
      return runAudit(args);
    case "investigate":
      return runInvestigate(args);
    case "public":
      return runPublic(args);
    case "post":
      return runPost(args);
    case "anonstories":
      return runAnonstories(args);
    case "viewer":
      return runViewer(args);
    case "status":
      return runStatus(args);
    case "doctor":
      return runDoctor(args);
    case "targets":
      return runTargets(args);
    case "scans":
      return runScans(args);
    case "work":
      return runWork(args);
    case "activity":
      return runActivity(args);
    case "relationships":
      return runRelationships(args);
    case "dossier":
      return runDossier(args);
    case "evidence":
      return runEvidence(args);
    case "lookup":
      return runLookup(args);
    case "tags":
      return runTags(args);
    case "mention":
      return runMention(args);
    case "insights":
      return runInsights(args);
    case "tracker":
      return runTracker(args);
    case "activity-report":
      return runActivityReport(args);
    case "report":
      return runReport(args);
    case "reports":
      return runReports(args);
    case "audience":
      return runAudience(args);
    case "recent":
      return runRecent(args);
    case "export":
      return runExport(args);
    case "digest":
      return runDigest(args);
    case "alerts":
      return runAlerts(args);
    case "claims":
      return runClaims(args);
    case "research":
      return runResearch(args);
    case "plan":
      return runPlan(args);
    case "capabilities":
      return runCapabilities(args);
    case "mcp":
      // No context is built here: the server resolves it lazily on first call
      // so a client can connect even while the database is down.
      await runMcp();
      return 0;
    case "help":
      return runHelpTopic(args);
    case "version":
      if (isJson(args.flags)) {
        process.stdout.write(
          `${JSON.stringify(
            envelope(
              { version: VERSION },
              staticMeta("static CLI metadata: no provider was constructed, no source was contacted"),
            ),
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default: {
      // `igtrack scan --help` must never run the words as a prompt: a help
      // request is a read, and a bare verb can otherwise queue real scans. A
      // bare mistyped verb is then answered exactly as `igtrack help <typo>`
      // answers it (registry refusal, exit 2); a sentence that also asked for
      // help wanted the tour, and gets it through the `--json` envelope rather
      // than as prose that breaks the one-shape contract.
      if (wantsHelp(args)) {
        return args.positionals.length === 0
          ? printHelp(args.command, args.flags)
          : printGeneralHelp(args.flags);
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
    // One answer, one shape: the `version` command renders both the prose and
    // the `--json` envelope, so `igtrack --version --json` cannot print a bare
    // string the caller's JSON parser then chokes on.
    process.exitCode = await dispatch({ command: "version", positionals: [], flags: args.flags });
    return;
  }
  // The CLI and the worker are plain Node processes, so the CLI loads .env
  // explicitly; an MCP client that spawns this process gets the same behavior.
  // Existing environment variables always win.
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

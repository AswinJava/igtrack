import { emit, flagBool, flagNumber, flagString, isJson, relativeTime, table, type ParsedArgs } from "../output.js";
import { createContext } from "../context.js";
import { opScanList, opScanRun, opWork, SCAN_KINDS } from "../tools.js";

export const SCANS_HELP = `igtrack scans <subcommand> | igtrack work

  scans run [--target id|username] [--kind PROFILE_SCAN] [--force]
                                Queue scans for tracked targets. Default: every
                                kind, every active target, deduplicated inside
                                the current scheduling window (--force bypasses
                                the dedupe).
  scans list [--target id|username] [--limit N]
                                Recent jobs and their outcomes.
  scans <target>                Shorthand for \`scans list --target <target>\`.
  work [--max N] [--no-scheduler] [--json]
                                Run the worker in the foreground: one scheduler
                                tick, then claim and execute jobs until the queue
                                is empty or --max is reached. This is the
                                zero-infrastructure way to get real observations:
                                queue with "scans run", execute with "work".

Kinds: ${SCAN_KINDS.join(", ")}.

A target runs only the kinds its observation mode can answer: OWNED targets run
the owned-account kinds, and a DISCOVERY target (another public account) runs
only DISCOVERY_SCAN. The other kinds are refused at enqueue with the reason
rather than queued to fail.

"scans run" never executes anything by itself — it enqueues, and the worker
executes. That separation is what makes a scan resumable, retryable, and safe to
interrupt.`;

export async function runScans(args: ParsedArgs): Promise<number> {
  const first = args.positionals[0];
  // `igtrack scans <username>` is the read people actually type. Only the two
  // documented verbs change behavior: anything else is a list selector, which
  // is read-only, so a typo can never enqueue a scan.
  const explicit = first === "run" || first === "list";
  const rest = first === undefined || explicit ? args.positionals.slice(1) : args.positionals;
  const json = isJson(args.flags);
  return first === "run" ? scansRun(args, rest, json) : scansList(args, rest, json);
}

async function scansRun(
  args: ParsedArgs,
  rest: string[],
  json: boolean,
): Promise<number> {
  const kinds = [
    ...(flagString(args.flags, "kind") ?? "")
      .split(",")
      .map((k) => k.trim().toUpperCase())
      .filter((k) => k.length > 0),
    ...rest.slice(1).map((k) => k.toUpperCase()),
  ];
  const ctx = await createContext();
  try {
    const result = await opScanRun(ctx, {
      target: rest[0] ?? flagString(args.flags, "target"),
      kinds,
      force: flagBool(args.flags, "force"),
    });
    const human = [
      result.enqueued.length === 0
        ? "Nothing queued."
        : table(
            ["target", "kind", "job", "note"],
            result.enqueued.map((e) => [
              `@${e.username}`,
              e.kind,
              e.jobId,
              e.deduplicated ? "already queued in this window" : "new",
            ]),
          ),
      ...(result.skipped.length === 0
        ? []
        : [
            "",
            "Skipped:",
            ...result.skipped.map((s) => `  @${s.username} ${s.kind}: ${s.reason}`),
          ]),
      "",
      result.note,
    ].join("\n");
    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

async function scansList(
  args: ParsedArgs,
  rest: string[],
  json: boolean,
): Promise<number> {
  const ctx = await createContext();
  try {
    const result = await opScanList(ctx, {
      target: rest[0] ?? flagString(args.flags, "target"),
      limit: flagNumber(args.flags, "limit", 20),
    });
    const human = [
      `Scope  ${result.scope}`,
      "",
      result.jobs.length === 0
        ? "No jobs recorded."
        : table(
            ["kind", "target", "status", "outcome", "attempts", "updated", "error"],
            result.jobs.map((j) => [
              j.kind,
              j.targetUsername === null ? "n/a" : `@${j.targetUsername}`,
              j.status,
              j.outcome ?? "pending",
              `${j.attempts}/${j.maxAttempts}`,
              relativeTime(j.completedAt ?? j.startedAt ?? j.availableAt),
              j.errorMessage ?? "",
            ]),
          ),
    ].join("\n");
    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}
export async function runWork(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const result = await opWork(ctx, {
      max: flagNumber(args.flags, "max", 25),
      skipScheduler: flagBool(args.flags, "no-scheduler"),
    });

    const executed = result.outcomes.filter((o) => o.state !== "none");
    const human = [
      `Provider   ${result.provider.sourceId}${result.provider.synthetic ? " (synthetic)" : ""}`,
      `Scheduler  ${result.schedulerTick}${result.schedulerError === null ? "" : ` — ${result.schedulerError}`}`,
      `Executed   ${executed.length} job(s); stopped because the queue is ${result.stopped === "queue-empty" ? "empty" : `still busy after ${result.outcomes.length} claims (--max)`}.`,
      "",
      executed.length === 0
        ? "Nothing was pending. Queue work with `igtrack scans run`."
        : table(
            ["job", "kind", "state"],
            executed.map((o) => [o.jobId ?? "n/a", o.kind ?? "n/a", o.state]),
          ),
    ].join("\n");

    emit({ json, meta: ctx.meta, data: result, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

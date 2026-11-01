import { emit, flagBool, flagNumber, flagString, isJson, relativeTime, strictFlagBool, table, UsageError, type ParsedArgs } from "../output.js";
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

export const WORK_HELP = `igtrack work [--max N] [--no-scheduler] [--json]

Run the worker in the foreground: one scheduler tick, then claim and execute
queued jobs until the queue is empty or --max is reached. This is the
zero-infrastructure way to get real observations: queue with \`igtrack scans
run\`, execute here.

  --max <n>         jobs executed before exiting (default 25, 1–500)
  --no-scheduler    drain what is already queued without a scheduling tick
  --json            standard JSON envelope around the result

Work acquires and stores observations; it does not compose reports. Jobs are
claimed with a lease, so a second worker can run alongside this one. Exits 1
when a job failed, lost its lease or could not be recorded, or when the
scheduler tick threw — the table says which.`;

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
      force: strictFlagBool(args.flags, "force"),
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
  // Same budget the MCP tool accepts. `--max 0` would claim the queue was empty
  // without having looked, and a runaway number is not a work plan.
  const max = flagNumber(args.flags, "max", 25);
  if (!Number.isSafeInteger(max) || max < 1 || max > 500) {
    throw new UsageError(`--max expects a whole number of jobs from 1 to 500 (got ${max}).`);
  }
  const ctx = await createContext();
  try {
    const result = await opWork(ctx, {
      max,
      skipScheduler: flagBool(args.flags, "no-scheduler"),
    });

    const executed = result.outcomes.filter((o) => o.state !== "none");
    // A job that failed, lost its lease or could not record is not a clean run,
    // and a scheduler that threw is a degraded one. Both say so in the exit code
    // as well as the table: `igtrack work && echo ok` must not lie.
    const broken = executed.filter(
      (o) => o.state === "failed" || o.state === "lost" || o.state === "unrecorded",
    );
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
      ...(broken.length === 0
        ? []
        : ["", `${broken.length} job(s) did not record an observation — see the states above.`]),
      ...(result.schedulerTick === "error"
        ? ["", "The scheduler tick failed, so nothing new was queued; already-queued work still ran."]
        : []),
    ].join("\n");

    emit({ json, meta: ctx.meta, data: result, human });
    return broken.length === 0 && result.schedulerTick !== "error" ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

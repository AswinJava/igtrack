import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createContext, type CliContext } from "../context.js";
import { CliError } from "../output.js";
import {
  opActivity,
  opCapabilities,
  opDoctor,
  opEvidence,
  opLookup,
  opRelationships,
  opScanList,
  opScanRun,
  opStatus,
  opTargetAdd,
  opTargetList,
  opTargetRemove,
  opTargetSetStatus,
  opWork,
  SCAN_KINDS,
} from "../tools.js";

// ---------------------------------------------------------------------------
// igtrack mcp — the same operations, as MCP tools.
//
// Protocol rules enforced here:
//   * stdout belongs to JSON-RPC. Nothing writes to it except the transport;
//     diagnostics go to stderr.
//   * Tool results are the same JSON the CLI prints, wrapped in the same
//     `_meta` honesty block, so an agent can tell synthetic data from live
//     observation on every single call.
//   * A failure is returned as isError with a typed code — never as an empty
//     successful result. "No data" and "could not look" stay distinguishable.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `IGTrack is an evidence-first observation engine for Instagram accounts you are authorized to observe.

How to use these tools:
1. Call \`igtrack_status\` first. It names the active provider and whether data is synthetic.
2. \`igtrack_scans_run\` only QUEUES work. \`igtrack_work\` executes it. Nothing is observed until a worker runs.
3. Read with \`igtrack_activity\`, \`igtrack_relationships\`, \`igtrack_evidence\`. Every row carries its source id, confidence, and evidence id — quote them when you report a claim.
4. \`igtrack_capabilities\` lists what can and cannot be observed, with the reason. Never present an unavailable capability as a zero/empty result.

Non-negotiable rules for you as the agent:
- \`null\` means "not observable", never 0. Do not fill gaps with estimates.
- If \`_meta.synthetic\` is true, say so. Never describe fixture data as a real observation of a real account.
- This tool set refuses lawfully unavailable data by design. Do not attempt to obtain followers, likers, interactions, highlights or media for accounts that the official API does not expose.`;

let cached: CliContext | null = null;

function isConnectionFailure(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err);
  return /ECONNREFUSED|ECONNRESET|Connection terminated|connection|terminating|timeout/i.test(
    message,
  );
}

async function withContext<T>(fn: (ctx: CliContext) => Promise<T>): Promise<T> {
  if (cached === null) cached = await createContext();
  const ctx = cached;
  try {
    return await fn(ctx);
  } catch (err) {
    // A dropped database connection must not poison the server for the rest of
    // the session: discard the handle so the next call reconnects, then surface
    // the real error to the agent.
    if (isConnectionFailure(err)) {
      cached = null;
      await ctx.close().catch(() => undefined);
    }
    throw err;
  }
}

// The SDK's CallToolResult carries an index signature, so results produced here
// declare one too rather than being cast at every call site.
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function jsonResult(payload: unknown): ToolResult {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(typeof payload === "object" && payload !== null
      ? { structuredContent: payload as Record<string, unknown> }
      : {}),
  };
}

async function guarded(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    // Typed codes, three honest classes: the operation's own refusal (CliError),
    // "could not look" when the database itself is unreachable (same predicate
    // that discards the cached context), and everything else INTERNAL.
    const code = err instanceof CliError
      ? err.code
      : isConnectionFailure(err)
        ? "DB_UNAVAILABLE"
        : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: { code, message } }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

function withMeta(ctx: CliContext, data: unknown): { ok: true; data: unknown; _meta: unknown } {
  return { ok: true, data, _meta: ctx.meta };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "igtrack",
      version: "0.1.0",
      description: "Evidence-first Instagram observation engine (self-hosted, fixture-first)",
    },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "igtrack_status",
    {
      title: "Deployment status",
      description:
        "Owner, active provider (and whether its data is synthetic), tracked targets, queue depth, and source health. Start here.",
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => withContext(async (ctx) => withMeta(ctx, await opStatus(ctx)))),
  );

  server.registerTool(
    "igtrack_capabilities",
    {
      title: "Capability registry",
      description:
        "What this system can and cannot observe, and the exact reason for each gap. Use this before claiming any data is unavailable or absent.",
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => opCapabilities()),
  );

  server.registerTool(
    "igtrack_doctor",
    {
      title: "Diagnostics",
      description:
        "Secret-free deployment diagnostic: provider usability, database reachability and migrations, scheduler intervals, source health, provider metrics, and findings.",
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => withContext(async (ctx) => withMeta(ctx, await opDoctor(ctx)))),
  );

  server.registerTool(
    "igtrack_targets_list",
    {
      title: "List tracked targets",
      description:
        "Every account this deployment tracks, with status, latest counts and last observation.",
      annotations: { readOnlyHint: true },
    },
    async () => guarded(async () => withContext(async (ctx) => withMeta(ctx, await opTargetList(ctx)))),
  );

  server.registerTool(
    "igtrack_target_add",
    {
      title: "Track an account",
      description:
        "Start tracking a public account. Idempotent per owner. Only accounts you are authorized to observe; live observation requires the official Graph API on an owned account.",
      inputSchema: {
        username: z.string().describe("Instagram username, with or without leading @"),
        localName: z.string().optional().describe("Human label for this target"),
        tags: z.array(z.string()).optional().describe("Free-form tags"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opTargetAdd(ctx, {
              username: args.username,
              localName: args.localName,
              tags: args.tags,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_target_set_status",
    {
      title: "Pause or resume a target",
      description: "PAUSED stops new scans while keeping all history. ACTIVE resumes scheduling.",
      inputSchema: {
        target: z.string().describe("Target id or username"),
        status: z.enum(["ACTIVE", "PAUSED"]).describe("Desired status"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opTargetSetStatus(ctx, { target: args.target, status: args.status })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_target_remove",
    {
      title: "Delete a target and its data",
      description:
        "Irreversible: removes the target and every observation, snapshot and evidence row retained for it. Ask the user before calling this.",
      inputSchema: {
        target: z.string().describe("Target id or username"),
        confirm: z
          .literal(true)
          .describe("Must be true — explicit confirmation that deletion is intended"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) => withMeta(ctx, await opTargetRemove(ctx, args.target))),
      ),
  );

  server.registerTool(
    "igtrack_scans_run",
    {
      title: "Queue scans",
      description:
        "Enqueue scans for tracked targets. This only queues — call igtrack_work to execute. Deduplicated inside the current scheduling window unless force is true.",
      inputSchema: {
        target: z.string().optional().describe("Target id or username; omit for every active target"),
        kinds: z
          .array(z.enum(SCAN_KINDS))
          .optional()
          .describe(`Scan kinds to queue. Default: all (${SCAN_KINDS.join(", ")})`),
        force: z.boolean().optional().describe("Bypass the within-window deduplication"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opScanRun(ctx, { target: args.target, kinds: args.kinds, force: args.force }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_scans_list",
    {
      title: "Recent scan jobs",
      description: "Job history with outcomes, attempts and failure reasons.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().optional().describe("Target id or username"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opScanList(ctx, { target: args.target, limit: args.limit })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_work",
    {
      title: "Run the worker",
      description:
        "Execute queued scans in the foreground: one scheduler tick, then claim and execute jobs until the queue is empty or max is reached. This is what actually produces observations.",
      inputSchema: {
        max: z.number().int().min(1).max(500).optional().describe("Maximum jobs to claim (default 25)"),
        skipScheduler: z.boolean().optional().describe("Skip the scheduler tick"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opWork(ctx, { max: args.max, skipScheduler: args.skipScheduler })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_activity",
    {
      title: "Activity feed",
      description:
        "Derived and observed events (profile changes, follow deltas, story sightings, posts, comments, mentions), newest first. Each item carries confidence and its evidence id.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        since: z.string().optional().describe('Duration ("7d", "24h", "30m") or ISO timestamp'),
        limit: z.number().int().min(1).max(200).optional(),
        target: z.string().optional().describe("Target id or username"),
        types: z.array(z.string()).optional().describe("Filter by activity type"),
        query: z.string().optional().describe("Substring match over username and summary"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opActivity(ctx, {
              since: args.since,
              limit: args.limit,
              target: args.target,
              types: args.types,
              query: args.query,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_relationships",
    {
      title: "Relationship ranking",
      description:
        "Accounts ranked by observed signal strength (story mentions + follow deltas) with mutual/currently-observed state and honest first/last-seen provenance.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id or username"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opRelationships(ctx, { target: args.target, limit: args.limit })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_evidence",
    {
      title: "Evidence list",
      description:
        "Recent evidence rows: hashes, source, observation id, observed vs captured time. This is the audit trail behind every claim.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) => withMeta(ctx, await opEvidence(ctx, { limit: args.limit }))),
      ),
  );

  server.registerTool(
    "igtrack_evidence_chain",
    {
      title: "Evidence chain",
      description:
        "Full lineage for one evidence row: the same claim the UI shows, plus which scan produced it and what it was derived from.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        evidenceId: z.string().describe("Evidence row id, as returned by igtrack_evidence"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) => withMeta(ctx, await opEvidence(ctx, { id: args.evidenceId }))),
      ),
  );

  server.registerTool(
    "igtrack_lookup",
    {
      title: "Probe one account",
      description:
        "Ask the configured source what it can observe about a single account, persisting nothing. Answers 'is this observable at all, and from which source?'.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        username: z.string().describe("Instagram username, with or without leading @"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) => withMeta(ctx, await opLookup(ctx, { username: args.username }))),
      ),
  );

  return server;
}

export async function runMcp(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("igtrack mcp: ready on stdio\n");
}

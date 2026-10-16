import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createContext, type CliContext } from "../context.js";
import { CliError } from "../output.js";
import {
  opActivity,
  opCapabilities,
  opClaimAdd,
  opClaimList,
  opClaimRetract,
  opDoctor,
  opDossier,
  opEvidence,
  opInsights,
  opLookup,
  opMentionedCommentProbe,
  opPlan,
  opRelationships,
  opResearch,
  opScanList,
  opScanRun,
  opStatus,
  opTaggedMedia,
  opTargetAdd,
  opTargetList,
  opTargetRemove,
  opTargetSetStatus,
  opWork,
  PLAN_GOALS,
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
3. Read with \`igtrack_activity\`, \`igtrack_relationships\`, \`igtrack_insights\`, \`igtrack_tags\`, \`igtrack_evidence\`. Every row carries its source id, confidence, and evidence id — quote them when you report a claim.
4. \`igtrack_dossier\` is the read-back of everything recorded about ONE account, including per-capability coverage and the gaps. Use it instead of assembling a profile from several calls.
5. \`igtrack_capabilities\` lists what can and cannot be observed, with the reason. Never present an unavailable capability as a zero/empty result.
6. \`igtrack_plan\` derives the honest next step from stored state (jobs, target, claims). It is recomputed on every call — there is no plan record and no cursor, so re-asking after an interruption is safe and correct.
7. \`igtrack_research\` is the full read-back in separate sections: identity, platform observations, themes, cadence, audience, recorded changes, claims, contradictions, leads, connections, coverage. The claims ledger is managed by \`igtrack_claims_list\`, \`igtrack_claim_add\` and \`igtrack_claim_retract\`.

Claims protocol (read this before reporting anything you learned outside these tools):
- A claim is an operator/agent-submitted finding about an outside source. You supply predicate, value, sourceUrl and a short excerpt; IGTrack stores it, cites it and never fetches or generates it.
- Predicates are a closed registry (\`igtrack_claims_list\` shows stored predicates; refused predicates come back with the reason). Person-level sensitive predicates (employment, health, religion, politics, ethnicity, education, family, address, legal) are REFUSED at write time — do not attempt to route around the refusal.
- Re-submitting the same finding is refused: duplication is not corroboration. Two distinct domains asserting the same value is CORROBORATED; conflicting values are CONFLICTED and both stay visible — never pick a winner.

Two observation modes exist and they do not mix:
- OWNED (default): accounts this deployment's credentials observe. Owned scans only.
- DISCOVERY: ANOTHER public account, tracked with \`igtrack_target_add { observed: true }\` through the documented Business Discovery edge. Only \`DISCOVERY_SCAN\` runs for it, its profile fields are recorded like any snapshot, and its media rows are a BOUNDED, non-pageable preview: never describe them as "the account's posts". Its media rows carry both the platform's publish time and when we first saw the row — "newly discovered" is not "newly created".

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
        "Start tracking a public account. Idempotent per owner. Only accounts you are authorized to observe; live observation requires the official Graph API on an owned account. Set observed: true to track ANOTHER public account through the documented Business Discovery edge (mode DISCOVERY, only DISCOVERY_SCAN runs for it). That route is probed once first and the target is REFUSED if the platform answers UNAVAILABLE — the error carries the platform's reason or the flag that unlocks it.",
      inputSchema: {
        username: z.string().describe("Instagram username, with or without leading @"),
        localName: z.string().optional().describe("Human label for this target"),
        tags: z.array(z.string()).optional().describe("Free-form tags"),
        observed: z
          .boolean()
          .optional()
          .describe(
            "Track another public account (Business Discovery route, mode DISCOVERY) instead of an owned account",
          ),
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
              observed: args.observed,
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
        "Accounts ranked by observed signal strength (story mentions + comment authorship on owned media + follow deltas) with mutual/currently-observed state and honest first/last-seen provenance. Each rank carries signalsWithinWindow, lastSignalAt and up to three stored evidence rows behind its counts; the result's `method` block states the exact score formula and says that recency is NOT folded into the score.",
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
    "igtrack_dossier",
    {
      title: "Account dossier",
      description:
        "Everything this deployment has RECORDED about one tracked account, read back with its gaps intact: identity, profile snapshots and changes, follow deltas, stories/mentions, stored media rows, and a per-capability coverage list (OBSERVED / NOT_OBSERVED / UNAVAILABLE) where every state is computed from rows that exist and every reason comes from the platform or the capability registry. Read-only: nothing is fetched. For a DISCOVERY target the media rows are a bounded preview and carry publishedAt (platform) separately from firstObservedAt (us).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id or username"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) => withMeta(ctx, await opDossier(ctx, { target: args.target }))),
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
    "igtrack_insights",
    {
      title: "Account insights",
      description:
        "Instagram account insights as recorded by this deployment: the latest value per metric and breakdown, plus every metric the platform reported ABSENT with its reason. Insights are not kept by the platform indefinitely — the accumulation window is part of the answer. Pass metric to get one metric's series oldest-first.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id or username"),
        metric: z
          .string()
          .optional()
          .describe('One metric series, e.g. "reach" or "follower_count"'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opInsights(ctx, {
              target: args.target,
              metric: args.metric,
              limit: args.limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_lookup",
    {
      title: "Probe one account",
      description:
        "Ask the configured source what it can observe about a single account, persisting nothing. Answers 'is this observable at all, and from which source?'. The observed account is answered by `resolve`; another account answers via `discovery` when the documented Business Discovery edge is enabled (public Business/Creator accounts only — consumer/private accounts are unreachable and age-gated accounts return nothing; both are reported with the reason). The result's `via` field says which route answered, and a discovery answer carries the platform id as an output, never as a lookup key.",
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

  server.registerTool(
    "igtrack_tags",
    {
      title: "Tagged media",
      description:
        "Media owned by OTHER accounts in which a tracked account was tagged, read back from what TAGS_SCAN recorded via the documented IG User tags edge. Rows are references to other accounts' media — never this account's own posts — and are first observations: a row absent from a later listing is never reported as removed. The completeness of the most recent listing read (COMPLETE or PARTIAL) is returned with the rows, and the platform excludes media from private accounts. Read-only: nothing is fetched.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id or username"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opTaggedMedia(ctx, { target: args.target, limit: args.limit })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_mention_read",
    {
      title: "Read one mentioned comment",
      description:
        "Read ONE mentioned comment (@mention of the owned account on another account's media) by its id, persisting nothing. The platform publishes no listing edge for these: ids arrive through Meta webhook notifications, and the documented read answers only for ids the app already holds. A comment id the platform does not recognize answers UNAVAILABLE with the platform's reason — which never means \"no mention exists\". Reading a media whose comments are disabled returns that error with its reason. Nothing is written.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        commentId: z
          .string()
          .describe("Comment id from the app's webhook notification payload"),
        account: z
          .string()
          .optional()
          .describe(
            "The account the mention belongs to; defaults to this deployment's single owned target",
          ),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opMentionedCommentProbe(ctx, {
              commentId: args.commentId,
              account: args.account,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_plan",
    {
      title: "Plan the next investigation step",
      description:
        "Derive the honest next step for a goal (FULL, PROFILE, POSTS, STORIES, TAGS, INSIGHTS, CONNECTIONS, RESEARCH) from STORED state: per-scan-kind job history, target status and mode, provider usability, recorded claims. Every step carries status DONE/PENDING/READY/STALE/BLOCKED/NOT_APPLICABLE with the reason, plus nextAction (the exact tool and params to call). Stateless: recomputed on every call, so an interrupted investigation resumes by asking again — there is no plan record to drift.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id, username, @handle or instagram.com profile URL"),
        goal: z
          .enum(PLAN_GOALS)
          .optional()
          .describe("Defaults to FULL (every kind this target's mode allows)"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(ctx, await opPlan(ctx, { target: args.target, goal: args.goal })),
        ),
      ),
  );

  server.registerTool(
    "igtrack_research",
    {
      title: "Account research report",
      description:
        "The full read-back for ONE target in separate sections: identity + route, platform observations (counts, profile, media — with the bounded-preview caveat for DISCOVERY), themes and cadence derived from stored captions/timestamps (corpus and formula stated), audience (platform-reported insights; platform-absent for DISCOVERY), recorded claims with relation labels (CONFLICTED/CORROBORATED/SINGLE_SOURCE/OPERATOR_ASSERTED) and review flags, contradictions with both sides, recorded change events in a stated window, leads (stored signal rows, not claims), connections (OWNED only — platform-absent for DISCOVERY, with the reason), capability coverage, and notes. Platform observations and claims are never merged, and every empty or unavailable section states its reason. Read-only and deterministic within a day.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id, username, @handle or instagram.com profile URL"),
        connectionLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max ranked connections to include (owned targets only)"),
        since: z
          .string()
          .optional()
          .describe(
            "Narrow the CLAIMS section to rows retrieved since this time (ISO date or 7d/24h/30m). The count of omitted rows is stated in the report; nothing is deleted.",
          ),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opResearch(ctx, {
              target: args.target,
              connectionLimit: args.connectionLimit,
              since: args.since,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_claims_list",
    {
      title: "List recorded claims",
      description:
        "The claims ledger for one target: active claims grouped by predicate with the predicate's relation label and source domains, plus retracted rows on request. Empty means nobody submitted research yet — it is not a statement that the account has no public footprint. Read-only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        target: z.string().describe("Target id, username, @handle or instagram.com profile URL"),
        predicate: z
          .string()
          .optional()
          .describe("Filter to one predicate (normalized; refused predicates return the reason)"),
        includeRetracted: z.boolean().optional().describe("Also return retracted rows"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opClaimList(ctx, {
              target: args.target,
              predicate: args.predicate,
              includeRetracted: args.includeRetracted,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_claim_add",
    {
      title: "Record a sourced claim",
      description:
        "Store ONE research finding you obtained OUTSIDE this tool set, with its source. Provide a predicate from the closed registry (see igtrack_claims_list for stored ones), a short value, and — for web findings — an http(s) sourceUrl plus a short excerpt (hashed at rest). Nothing is fetched, generated or verified against the platform: a claim is a cited statement, never an observation. Sensitive person-level predicates are REFUSED with the reason, and an exact duplicate is refused — duplication is not corroboration. Omit sourceUrl only for an operator assertion (your own knowledge); it can support a claim but never corroborates one.",
      inputSchema: {
        target: z.string().describe("Target id, username, @handle or instagram.com profile URL"),
        predicate: z
          .string()
          .describe("e.g. ORGANIZATION_NAME, LOCATION_STATED, PRODUCT_OR_SERVICE, CONTACT_CHANNEL"),
        value: z.string().describe("The claimed designation (short: a name, a city, a URL)"),
        sourceUrl: z.string().optional().describe("Absolute http(s) URL of the source"),
        sourceTitle: z.string().optional().describe("Page or article title, for readability"),
        excerpt: z
          .string()
          .optional()
          .describe("Short quotation supporting the claim (<=500 chars; hashed at rest)"),
        statedAt: z
          .string()
          .optional()
          .describe("ISO 8601 time the source stated it, when known"),
        retrievedAt: z
          .string()
          .optional()
          .describe("ISO 8601 time you retrieved the source; this is the review-basis clock"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opClaimAdd(ctx, {
              target: args.target,
              predicate: args.predicate,
              value: args.value,
              sourceUrl: args.sourceUrl,
              sourceTitle: args.sourceTitle,
              excerpt: args.excerpt,
              statedAt: args.statedAt,
              retrievedAt: args.retrievedAt,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "igtrack_claim_retract",
    {
      title: "Retract a claim",
      description:
        "Mark ONE claim retracted with the reason. The row stays readable (nothing is deleted), stops participating in relation labels, and remains visible in research with its retraction reason. Ask the user before retracting.",
      inputSchema: {
        claimId: z.string().describe("Claim id, from igtrack_claims_list"),
        reason: z.string().describe("Why it is retracted — required, shown to the next reader"),
        confirm: z
          .literal(true)
          .describe("Must be true — explicit confirmation that retraction is intended"),
      },
    },
    async (args) =>
      guarded(async () =>
        withContext(async (ctx) =>
          withMeta(
            ctx,
            await opClaimRetract(ctx, {
              claimId: args.claimId,
              reason: args.reason,
              confirm: args.confirm,
            }),
          ),
        ),
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

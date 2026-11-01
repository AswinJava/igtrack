import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";

// ---------------------------------------------------------------------------
// The MCP surface is a published contract for other people's agents. These
// tests pin the tool names (renaming one is a breaking change) and the error
// semantics: a failure must arrive as isError, never as a successful empty
// result, because "nothing to report" and "could not look" are different
// claims and an agent will act on them differently.
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  "igtrack_activity",
  "igtrack_activity_report",
  "igtrack_alerts",
  "igtrack_anonstories",
  "igtrack_ask",
  "igtrack_audience",
  "igtrack_audit",
  "igtrack_capabilities",
  "igtrack_claim_add",
  "igtrack_claim_retract",
  "igtrack_claims_list",
  "igtrack_digest",
  "igtrack_doctor",
  "igtrack_dossier",
  "igtrack_evidence",
  "igtrack_evidence_chain",
  "igtrack_export",
  "igtrack_full_audit",
  "igtrack_insights",
  "igtrack_investigate",
  "igtrack_lookup",
  "igtrack_mention_read",
  "igtrack_plan",
  "igtrack_post",
  "igtrack_public",
  "igtrack_recent",
  "igtrack_relationships",
  "igtrack_report",
  "igtrack_reports",
  "igtrack_research",
  "igtrack_research_run",
  "igtrack_scans_list",
  "igtrack_scans_run",
  "igtrack_status",
  "igtrack_tags",
  "igtrack_target_add",
  "igtrack_target_remove",
  "igtrack_target_set_status",
  "igtrack_targets_list",
  "igtrack_tracker",
  "igtrack_viewer",
  "igtrack_work",
].sort();

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, close: () => client.close() };
}

describe("igtrack mcp", () => {
  const saved = { url: process.env.IGTRACK_DATABASE_URL, databaseUrl: process.env.DATABASE_URL };

  beforeEach(() => {
    delete process.env.IGTRACK_DATABASE_URL;
    delete process.env.DATABASE_URL;
    // Point the pool at a port that refuses instantly, so the "cannot look"
    // path is exercised without needing a live database or a long timeout.
    process.env.IGTRACK_DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/none";
    process.env.DATABASE_URL = process.env.IGTRACK_DATABASE_URL;
  });

  afterEach(() => {
    if (saved.url === undefined) delete process.env.IGTRACK_DATABASE_URL;
    else process.env.IGTRACK_DATABASE_URL = saved.url;
    if (saved.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.databaseUrl;
  });

  it("exposes the documented tool set and instructions", async () => {
    const { client, close } = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
      const instructions = client.getInstructions() ?? "";
      // The epistemic rules must travel with the server, not live only in docs.
      expect(instructions).toContain("null");
      expect(instructions).toContain("igtrack_work");
    } finally {
      await close();
    }
  });

  it("answers a database-free tool in the same envelope as every other tool", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "igtrack_capabilities", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        ok: boolean;
        data: { capabilities: unknown[]; summary: { available: number; total: number } };
        _meta: { provider: string; sourceId: string | null; synthetic: boolean; studio: string; note: string };
      };
      // One contract for every tool: a client that parses { ok, data, _meta }
      // must not need a special case for the registry.
      expect(payload.ok).toBe(true);
      expect(payload.data.capabilities.length).toBe(payload.data.summary.total);
      expect(payload.data.summary.available).toBeGreaterThan(0);
      // The registry is a static product statement: it is not synthetic data,
      // it comes from no provider, and it was answered over MCP.
      expect(payload._meta.synthetic).toBe(false);
      expect(payload._meta.sourceId).toBeNull();
      expect(payload._meta.studio).toBe("mcp");
      expect(payload._meta.note).toMatch(/independent of the active data source/i);
    } finally {
      await close();
    }
  });

  it("refuses an argument the tool never declared instead of ignoring it", async () => {
    const { client, close } = await connect();
    try {
      // A client that invents a filter must be told it did not apply. Silently
      // dropping the key returns the unfiltered report as if the filter worked.
      const result = await client.callTool({
        name: "igtrack_activity_report",
        arguments: { target: "aurora.wilde", tab: "podcast" },
      });
      expect(result.isError).toBe(true);
      expect(errCode(result)).toBeNull(); // refused at the schema, handler never ran

      const tools = await client.listTools();
      const report = tools.tools.find((t) => t.name === "igtrack_activity_report");
      expect((report?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(
        false,
      );
    } finally {
      await close();
    }
  });

  it("refuses arguments on tools that declare none", async () => {
    const { client, close } = await connect();
    try {
      const tools = await client.listTools();
      // The SDK skips validation entirely for a tool with no input schema, so a
      // no-argument tool that leaves its schema unstated accepts anything it
      // cannot honour: `igtrack_status {target:"x"}` would answer the whole
      // deployment and the client would read that as a filtered one. Declaring
      // an empty strict object is what makes "takes no arguments" a contract.
      const zeroArg = tools.tools.filter(
        (t) =>
          t.name === "igtrack_status" ||
          t.name === "igtrack_capabilities" ||
          t.name === "igtrack_doctor" ||
          t.name === "igtrack_targets_list",
      );
      expect(zeroArg).toHaveLength(4);
      for (const tool of zeroArg) {
        const shape = tool.inputSchema as {
          additionalProperties?: unknown;
          properties?: Record<string, unknown>;
        };
        expect(shape.properties, tool.name).toEqual({});
        expect(shape.additionalProperties, tool.name).toBe(false);
      }

      for (const name of ["igtrack_status", "igtrack_capabilities", "igtrack_targets_list"]) {
        const result = await client.callTool({ name, arguments: { target: "aurora.wilde" } });
        expect(result.isError, name).toBe(true);
        expect(errCode(result), name).toBeNull();
        // Every tool answers one sentence for a refusal; a declared schema that
        // swallows keys silently is the failure this pins shut.
        const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
        expect(text, name).toMatch(/target/);
      }

      // With no arguments the same tools still answer normally.
      const clean = await client.callTool({ name: "igtrack_capabilities", arguments: {} });
      expect(clean.isError).toBeFalsy();
    } finally {
      await close();
    }
  });

  it("states the MCP surface as the studio on every tool result", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "igtrack_status", arguments: {} });
      expect(result.isError).toBe(true); // database is unreachable in this suite
      // A refusal still says which surface answered it.
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("DB_UNAVAILABLE");

      const answer = await client.callTool({
        name: "igtrack_ask",
        arguments: { prompt: "what can you do?" },
      });
      const payload = JSON.parse((answer.content as Array<{ text: string }>)[0]?.text ?? "") as {
        _meta: { studio: string };
      };
      expect(payload._meta.studio).toBe("mcp");
    } finally {
      await close();
    }
  });

  it("answers a free-form prompt without the database when the plan needs none", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "igtrack_ask",
        arguments: { prompt: "what can you do?" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        ok: boolean;
        data: { status: string; understanding: { intents: string[] }; answer: string[] };
        _meta: { synthetic: boolean };
      };
      expect(payload.ok).toBe(true);
      expect(payload.data.understanding.intents).toEqual(["guide"]);
      expect(payload.data.status).toBe("ANSWERED");
      expect(payload.data.answer.length).toBeGreaterThan(0);
      expect(typeof payload._meta.synthetic).toBe("boolean");
    } finally {
      await close();
    }
  });

  it("returns the plan for a dry run without executing it", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "igtrack_ask",
        arguments: { prompt: "delete @aurora.wilde", dryRun: true },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        data: { plan: { intents: string[]; primary: string }; understanding: string };
      };
      // Parsed, understood, and NOT executed: the destructive intent is only
      // the plan's primary step.
      expect(payload.data.plan.primary).toBe("untrack");
      expect(payload.data.understanding.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("treats a database-backed prompt as could-not-look when the database is down", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "igtrack_ask",
        arguments: { prompt: "what changed on @aurora.wilde in the last 7 days?" },
      });
      expect(result.isError).toBe(true);
      expect(errCode(result)).toBe("DB_UNAVAILABLE");
    } finally {
      await close();
    }
  });

  it("returns isError (not an empty success) when the database cannot be reached", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "igtrack_status", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as { ok: boolean; error: { code: string; message: string } };
      expect(payload.ok).toBe(false);
      // "could not look" is its own typed class, distinct from a bug (INTERNAL)
      // and from an operation's own refusal (a CliError code like USAGE).
      expect(payload.error.code).toBe("DB_UNAVAILABLE");
      expect(payload.error.message.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("rejects invalid input before touching any dependency", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "igtrack_target_set_status",
        arguments: { target: "x", status: "DELETED" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("gates target deletion behind explicit confirmation, before any dependency", async () => {
    const { client, close } = await connect();
    try {
      // Without confirm the input schema refuses the call itself: no guarded
      // error envelope appears, proving the handler — and the deletion it
      // would perform — was never reached.
      const missing = await client.callTool({
        name: "igtrack_target_remove",
        arguments: { target: "x" },
      });
      expect(missing.isError).toBe(true);
      expect(errCode(missing)).toBeNull();

      // confirm: true passes the schema and reaches the context, which fails on
      // the unreachable database — a different gate, with the typed code.
      const confirmed = await client.callTool({
        name: "igtrack_target_remove",
        arguments: { target: "x", confirm: true },
      });
      expect(confirmed.isError).toBe(true);
      expect(errCode(confirmed)).toBe("DB_UNAVAILABLE");
    } finally {
      await close();
    }
  });

  it("gates claim retraction behind explicit confirmation, before any dependency", async () => {
    const { client, close } = await connect();
    try {
      // Retraction is a write with a reader-visible reason; the schema demands
      // confirm: true so an agent cannot retract by accident.
      const missing = await client.callTool({
        name: "igtrack_claim_retract",
        arguments: { claimId: "x", reason: "changed my mind" },
      });
      expect(missing.isError).toBe(true);
      expect(errCode(missing)).toBeNull();

      const confirmed = await client.callTool({
        name: "igtrack_claim_retract",
        arguments: { claimId: "x", reason: "changed my mind", confirm: true },
      });
      expect(confirmed.isError).toBe(true);
      expect(errCode(confirmed)).toBe("DB_UNAVAILABLE");
    } finally {
      await close();
    }
  });

  it("enforces igtrack_research_run's bounds in the schema, before any dependency", async () => {
    const { client, close } = await connect();
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === "igtrack_research_run");
      // The one research tool that WRITES: the annotation says so, so an
      // agent can tell acquisition from reporting at a glance.
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.title).toMatch(/acquisition/i);

      // Missing question: refused by the schema itself, no envelope code —
      // the handler (and any fetch it would perform) was never reached.
      const noQuestion = await client.callTool({
        name: "igtrack_research_run",
        arguments: { target: "x" },
      });
      expect(noQuestion.isError).toBe(true);
      expect(errCode(noQuestion)).toBeNull();

      // The §4.7 bounds are contract, not commentary: 11 sources and an
      // 11-element url list are rejected at the door.
      const overBudget = await client.callTool({
        name: "igtrack_research_run",
        arguments: { target: "x", question: "q", maxSources: 11 },
      });
      expect(overBudget.isError).toBe(true);
      expect(errCode(overBudget)).toBeNull();

      const tooManyUrls = await client.callTool({
        name: "igtrack_research_run",
        arguments: {
          target: "x",
          question: "q",
          urls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
        },
      });
      expect(tooManyUrls.isError).toBe(true);
      expect(errCode(tooManyUrls)).toBeNull();
    } finally {
      await close();
    }
  });
});

/** The typed error code in a tool result's envelope, or null when absent. */
function errCode(result: unknown): string | null {
  const content = (result as { content?: unknown }).content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof first === "object" && first !== null && "text" in first
      ? String((first as { text?: unknown }).text ?? "")
      : "";
  if (text === "") return null;
  try {
    const payload = JSON.parse(text) as { error?: { code?: string } };
    return typeof payload.error?.code === "string" ? payload.error.code : null;
  } catch {
    return null; // not our envelope (e.g. an SDK schema-rejection message)
  }
}

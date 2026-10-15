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
  "igtrack_capabilities",
  "igtrack_doctor",
  "igtrack_evidence",
  "igtrack_evidence_chain",
  "igtrack_insights",
  "igtrack_lookup",
  "igtrack_relationships",
  "igtrack_scans_list",
  "igtrack_scans_run",
  "igtrack_status",
  "igtrack_target_add",
  "igtrack_target_remove",
  "igtrack_target_set_status",
  "igtrack_targets_list",
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

  it("answers a database-free tool without touching the database", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "igtrack_capabilities", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        capabilities: unknown[];
        summary: { available: number; total: number };
      };
      expect(payload.capabilities.length).toBe(payload.summary.total);
      expect(payload.summary.available).toBeGreaterThan(0);
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

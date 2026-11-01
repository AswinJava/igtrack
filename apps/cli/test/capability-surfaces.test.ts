import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CAPABILITY_REGISTRY } from "@igtrack/core";
import { buildServer } from "../src/mcp/server.js";
import { COMMAND_HELP } from "../src/help-registry.js";

// ---------------------------------------------------------------------------
// The registry's "surfaced in" column is what `igtrack capabilities` and the
// published matrix tell operators and agents about where a fact can be read.
// This deployment ships a CLI and an MCP server — no web app — so a surface
// naming a route, a page, or a panel is a claim about software that does not
// exist. These tests keep the column honest in both directions: the names must
// resolve to a command the router dispatches or a tool the server registers.
// ---------------------------------------------------------------------------

const FICTIONAL_SURFACE =
  /(?:^|[ (])\/(?:targets|api|lookup|relationships|posts|stories|evidence)\b|\b(?:web |landing )?page\b|\btimeline\b|\bpanel\b/;

async function registeredTools(): Promise<string[]> {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "surface-test", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("capability registry surfaces", () => {
  it("names a CLI command or MCP tool for every capability that has a surface", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      expect(new Set(entry.ui).size, `${entry.id}: duplicate surface`).toBe(entry.ui.length);
      for (const surface of entry.ui) {
        expect(surface, `${entry.id}: ${surface}`).toMatch(
          /^(?:igtrack[ _]|Research runs section of igtrack)/,
        );
        expect(surface, `${entry.id}: ${surface}`).toMatch(/\(CLI|\(MCP/);
        expect(surface, `${entry.id}: ${surface}`).not.toMatch(FICTIONAL_SURFACE);
      }
    }
  });

  it("references only commands the CLI actually dispatches", () => {
    const commands = new Set(Object.keys(COMMAND_HELP));
    for (const entry of CAPABILITY_REGISTRY) {
      for (const surface of entry.ui) {
        for (const match of surface.matchAll(/igtrack ([a-z][a-z-]*)/g)) {
          expect(commands.has(match[1] ?? ""), `${entry.id}: ${surface}`).toBe(true);
        }
      }
    }
  });

  it("references only tools the MCP server actually registers", async () => {
    const names = new Set(await registeredTools());
    expect(names.size).toBeGreaterThan(0);
    for (const entry of CAPABILITY_REGISTRY) {
      for (const surface of entry.ui) {
        for (const match of surface.matchAll(/igtrack_[a-z_]+/g)) {
          expect(names.has(match[0]), `${entry.id}: ${surface}`).toBe(true);
        }
      }
    }
  });
});

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/mcp/server.js";

// ---------------------------------------------------------------------------
// `ask --dry-run` is a promise about work that will NOT happen. These tests
// hold it to that promise: the same sentence that fails when the database is
// unreachable must answer successfully as a preview, which is only possible if
// the preview really opens no connection, constructs no provider and runs no
// step. And both surfaces must describe one sentence identically, or an agent
// that previews through MCP and executes through the CLI is being told two
// different things about its own request.
// ---------------------------------------------------------------------------

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A database that cannot be reached, so any real read or write fails loudly. */
const BROKEN_DB = {
  IGTRACK_DATABASE_URL: "postgresql://igtrack:igtrack@127.0.0.1:1/igtrack_unreachable",
  DATABASE_URL: "postgresql://igtrack:igtrack@127.0.0.1:1/igtrack_unreachable",
};

// Async on purpose: a synchronous spawn blocks this worker's event loop for the
// whole run, which starves the vitest worker→runner RPC and fails the suite with
// a timeout even though every assertion passed.
function cli(args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/main.ts", ...args],
      {
        cwd: cliRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ...BROKEN_DB, ...env },
      },
      (error, stdout, stderr) => {
        // A refusal exit code is a result under test, not an error.
        const exit = (error as { code?: unknown } | null)?.code;
        resolve({
          code: error === null ? 0 : typeof exit === "number" ? exit : -1,
          out: stdout ?? "",
          err: stderr ?? "",
        });
      },
    );
  });
}

interface Envelope {
  ok: boolean;
  data: {
    prompt?: string;
    dryRun?: boolean;
    understanding?: string;
    plan?: { intents: string[]; primary: string; needsUsername: boolean; executable: boolean };
    examples?: string[];
    status?: string;
    answer?: string[];
    steps?: unknown[];
    input?: unknown;
  };
  error?: { code: string; message: string };
  _meta?: { provider: string; synthetic: boolean };
}

function parse(out: string): Envelope {
  return JSON.parse(out) as Envelope;
}

describe("ask --dry-run executes nothing", () => {
  it("answers a write sentence while the same sentence cannot run", async () => {
    const preview = await cli(["ask", "track @dryrun.probe and run the first scan", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    const body = parse(preview.out);
    expect(body.ok).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.plan?.intents).toEqual(["track", "scan"]);
    expect(body.data.plan?.primary).toBe("scan");
    // The account the sentence names is carried into the preview untouched.
    expect(body.data.prompt).toContain("@dryrun.probe");
    // A preview has no execution to report: no steps, no answer, no status.
    expect(body.data.steps).toBeUndefined();
    expect(body.data.answer).toBeUndefined();
    expect(body.data.status).toBeUndefined();

    // Proof that the environment really is unreachable: the identical request
    // without the flag fails instead of pretending to have written rows.
    const real = await cli(["ask", "track @dryrun.probe and run the first scan", "--json"]);
    expect(real.code).not.toBe(0);
  });

  it("does not ask a clarification a real run would ask", async () => {
    const run = await cli(["ask", "audit the account", "--dry-run", "--json"]);
    expect(run.code).toBe(0);
    const body = parse(run.out);
    expect(body.data.plan?.needsUsername).toBe(true);
    // NEEDS_INPUT is an execution-time state; a preview never produces it.
    expect(body.data.status).toBeUndefined();
    expect(body.data.input).toBeUndefined();
    expect(run.out).not.toContain("NEEDS_INPUT");
  });

  it("says in prose that nothing ran", async () => {
    const run = await cli(["ask", "remove @dryrun.probe", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Plan only");
    expect(run.out).toContain("nothing ran");
    expect(run.out).toContain("steps");
    expect(run.out).toContain("untrack");
  });

  it("honours --dry-run placed before the sentence, not around it", async () => {
    // The parser used to read the sentence as the value of --dry-run, which
    // turned "do not execute" into a string the request never saw and ran the
    // write anyway. A switch no longer eats the token after it, so flag order is
    // a style choice rather than a trap — and the refusal path stays reachable
    // for a value typed ON the switch (`--dry-run=maybe`).
    const before = await cli(["ask", "--dry-run", "track @dryrun.probe and run the first scan", "--json"]);
    expect(before.code).toBe(0);
    const body = parse(before.out);
    expect(body.ok).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.steps).toBeUndefined();
    expect(body.data.prompt).toContain("@dryrun.probe");

    const nonsense = await cli(["ask", "track @dryrun.probe", "--dry-run=maybe", "--json"]);
    expect(nonsense.code).toBe(2);
    expect(parse(nonsense.err).error?.message).toContain("--dry-run is a switch");
  });

  it("matches the MCP dryRun answer for the same sentence", async () => {
    const sentence = "track @dryrun.probe and run the first scan";
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dry-run-parity", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "igtrack_ask",
        arguments: { prompt: sentence, dryRun: true },
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const mcp = JSON.parse(text) as Envelope;
      const cliBody = parse((await cli(["ask", sentence, "--dry-run", "--json"])).out);
      expect(mcp.data.understanding).toBe(cliBody.data.understanding);
      expect(mcp.data.plan?.intents).toEqual(cliBody.data.plan?.intents);
      expect(mcp.data.plan?.primary).toBe(cliBody.data.plan?.primary);
      expect(cliBody.data.dryRun).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("documents the flag on both help entry points", async () => {
    const viaCommand = await cli(["ask", "--help"]);
    const viaTopic = await cli(["help", "ask"]);
    expect(viaCommand.out).toContain("--dry-run");
    expect(viaCommand.out).toBe(viaTopic.out);
  });
});

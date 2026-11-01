import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_HELP, HELP } from "../src/help-registry.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Async on purpose. Each case really spawns the CLI, and a synchronous spawn
// blocks this worker's event loop for the whole run — 70+ seconds here — which
// starves the vitest worker→runner RPC and fails the suite with
// `Timeout calling "onTaskUpdate"` while every assertion still passes.
function spawn(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/main.ts", ...args],
      { cwd: cliRoot, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        // A non-zero exit is the result under test (refusals), not an error.
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

async function helpFor(command: string): Promise<string> {
  const r = await spawn([command, "--help"]);
  expect(r.code, `${command} --help`).toBe(0);
  return r.out;
}

describe("--help is a read, never an execution", () => {
  it("prints status help without opening the database", async () => {
    expect(await helpFor("status")).toContain("igtrack status [--json]");
  });

  it("prints doctor help without running diagnostics", async () => {
    expect(await helpFor("doctor")).toContain("igtrack doctor [--json]");
  });

  it("prints mcp help without starting the stdio server", async () => {
    expect(await helpFor("mcp")).toContain("igtrack mcp");
  });
});

describe("one contract for both help entry points", () => {
  // `help <command>` and `<command> --help` read the same registry, so a
  // command cannot advertise an option in one place and reject it in the other.
  const sampled = ["status", "activity", "evidence", "tracker", "report", "targets", "scans", "claims", "version"];

  it.each(sampled)("help %s prints the same text as %s --help", async (command) => {
    const topic = await spawn(["help", command]);
    expect(topic.code).toBe(0);
    expect(topic.out).toBe(await helpFor(command));
  });

  it("resolves subcommand help typed as a positional", async () => {
    for (const command of ["targets", "scans", "claims"]) {
      const viaPositional = await spawn([command, "help"]);
      expect(viaPositional.code, command).toBe(0);
      expect(viaPositional.out, command).toBe((await spawn(["help", command])).out);
    }
  });

  it("prints the generic help for --help, -h and no topic", async () => {
    expect((await spawn(["help"])).out).toBe(`${HELP}\n`);
    expect((await spawn(["--help"])).out).toBe(`${HELP}\n`);
    expect((await spawn(["-h"])).out).toBe(`${HELP}\n`);
  });

  it("lists every registered command in the generic help", () => {
    for (const command of Object.keys(COMMAND_HELP)) {
      expect(HELP, `generic help omits ${command}`).toContain(command);
    }
  });

  it("answers help --json with the command list and the same text", async () => {
    const r = await spawn(["help", "--json"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.ok).toBe(true);
    expect(body.data.commands).toEqual(Object.keys(COMMAND_HELP));
    expect(body.data.help).toBe(HELP);
    expect(body._meta.provider).toBe("none");
    expect(body._meta.synthetic).toBe(false);
  });

  it("answers help <command> --json with that command's contract", async () => {
    const r = await spawn(["help", "tracker", "--json"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.data.command).toBe("tracker");
    expect(body.data.help).toBe(COMMAND_HELP["tracker"]);
  });

  it("refuses an unknown topic instead of printing the generic help", async () => {
    const r = await spawn(["help", "nosuchcommand"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain('There is no igtrack command "nosuchcommand"');
    const j = await spawn(["help", "nosuchcommand", "--json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.err).error.code).toBe("UNKNOWN_COMMAND");
  });

  it("accepts casing, underscores and an igtrack prefix in the topic", async () => {
    const expected = (await spawn(["help", "activity-report"])).out;
    expect((await spawn(["help", "ACTIVITY-REPORT"])).out).toBe(expected);
    expect((await spawn(["help", "activity_report"])).out).toBe(expected);
    expect((await spawn(["help", "igtrack", "activity-report"])).out).toBe(expected);
  });

  it("treats help on an unknown verb as a read, never as a prompt", async () => {
    // A mistyped verb plus --help must not reach the plain-English path: that
    // path can enqueue real work, and a help request is a read.
    const r = await spawn(["scan", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${HELP}\n`);
  });

  it("gives every command a contract that states its own usage line", () => {
    for (const [command, text] of Object.entries(COMMAND_HELP)) {
      // `help` is the generic listing, so it opens with the tool banner.
      if (command === "help") continue;
      expect(text, command).toMatch(new RegExp(`^igtrack ${command}`));
    }
  });
});

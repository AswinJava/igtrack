import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_HELP, GLOBAL_FLAGS, documentedFlags, unknownFlags } from "../src/help-registry.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// A flag is part of a command's contract, so an unrecognised one cannot be read
// as nothing. `igtrack status --form=jsonl` printing a table is the caller's
// request dropped in silence, and an agent has no way to tell that answer from
// the one it asked for. The accepted set is derived from the command's own help
// text — which is what makes the refusal and the documentation one list rather
// than two that can drift.
// ---------------------------------------------------------------------------

function spawn(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/main.ts", ...args],
      { cwd: cliRoot, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
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

describe("the flag contract", () => {
  it("reads the accepted flags out of the command's own contract", () => {
    const report = documentedFlags("report");
    for (const flag of ["period", "at", "format", "out", "json"]) {
      expect(report.has(flag), `--${flag}`).toBe(true);
    }
  });

  it("refuses a misspelled option instead of running the command anyway", () => {
    expect(unknownFlags("status", { json: true, form: "jsonl" })).toEqual(["form"]);
    expect(unknownFlags("report", { period: "weekly", format: "md" })).toEqual([]);
  });

  it("refuses a short flag the parser was never told about", () => {
    expect(unknownFlags("status", { u: "someone@example.com" })).toEqual(["u"]);
    // -h and -v are the two documented shorts.
    expect(unknownFlags("status", { h: true })).toEqual([]);
  });

  it("counts every documented flag of a command as accepted", () => {
    // The refusal list cannot disagree with the contract it was derived from.
    for (const command of Object.keys(COMMAND_HELP)) {
      const accepted = documentedFlags(command);
      for (const flag of accepted) {
        expect(unknownFlags(command, { [flag]: true }), `${command} --${flag}`).toEqual([]);
      }
    }
  });

  it("keeps the owner selection and the envelope switch global", () => {
    // A flag every command reads is not something each command's text has to
    // repeat; these are the four the router answers before any command runs.
    expect([...GLOBAL_FLAGS].sort()).toEqual(["h", "help", "json", "user", "v", "version"]);
    for (const command of ["status", "report", "targets", "evidence", "tracker"]) {
      expect(unknownFlags(command, { user: "someone@example.com", json: true })).toEqual([]);
    }
  });

  it("says nothing about flags for a verb with no contract", () => {
    // A mistyped verb becomes a plain-English prompt, and a prompt reads the
    // whole line — refusing its tokens would refuse the question.
    expect(unknownFlags("whos", { json: true, mention: "someone" })).toEqual([]);
  });

  it("exits 2 and names the flag rather than printing the answer", async () => {
    const run = await spawn(["status", "--form=jsonl"]);
    expect(run.code).toBe(2);
    expect(run.out).toBe("");
    expect(run.err).toContain("igtrack status does not accept --form");
    expect(run.err).toContain("igtrack status --help");
  }, 40_000);

  it("answers the refusal in the same envelope shape as every other error", async () => {
    const run = await spawn(["report", "dune.harbor", "--forma=md", "--json"]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.err) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("USAGE");
    expect(envelope.error.message).toContain("does not accept --forma");
  }, 40_000);
});

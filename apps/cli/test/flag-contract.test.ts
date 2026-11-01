import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_HELP, GLOBAL_FLAGS, documentedFlags, unknownFlags } from "../src/help-registry.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(cliRoot, "src");

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

interface SourceFile {
  readonly rel: string;
  readonly text: string;
}

/**
 * Every spelling of "this file reads the flag": direct index, property access,
 * or a flag helper called with the literal name.
 */
function readsFlag(text: string, flag: string): boolean {
  return [
    new RegExp(`flags\\["${flag}"\\]`),
    new RegExp(`flags\\.${flag}\\b`),
    new RegExp(`[A-Za-z]*[Ff]lag[A-Za-z]*\\([^)]*"${flag}"`),
  ].some((pattern) => pattern.test(text));
}

function sourceFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts")) {
      out.push({
        rel: full.slice(srcRoot.length + 1).replace(/\\/g, "/"),
        text: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

const HANDLER_FILES = sourceFiles(srcRoot);

/** The file whose `runX` main.ts dispatches to, or null for a verb answered in the router. */
function handlerFile(command: string): string | null {
  const pascal = command.replace(/(^|-)([a-z])/g, (_match, _sep, letter: string) =>
    letter.toUpperCase(),
  );
  return (
    HANDLER_FILES.find(({ text }) =>
      new RegExp(`(export )?(async )?function run${pascal}\\b`).test(text)
    )?.rel ?? null
  );
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

  it("reads only flags some code in the CLI actually looks at", () => {
    // The accepted set is derived from prose, so prose is load-bearing: a flag
    // that appears in a help text and in no handler is accepted by the gate and
    // then ignored by the command. That is the same silent drop the gate exists
    // to refuse, moved one level up — the caller asked for it, the CLI said nothing,
    // and the answer came back as though it had been honoured.
    const unimplemented: string[] = [];
    for (const command of Object.keys(COMMAND_HELP)) {
      for (const flag of documentedFlags(command)) {
        if (GLOBAL_FLAGS.has(flag)) continue;
        if (!HANDLER_FILES.some(({ text }) => readsFlag(text, flag))) {
          unimplemented.push(`${command} --${flag}`);
        }
      }
    }
    expect(unimplemented).toEqual([]);
  });

  it("reads each documented flag in the command it was documented for", () => {
    // A flag can be implemented and still belong to someone else: `igtrack
    // scans` once carried the worker's `--max` in its own help text, so the gate
    // accepted it and scans ignored it. Attribution is per command, not global.
    //
    // The scan below only checks commands whose handler it can find, so the
    // exemptions are named rather than inferred: a command that quietly stopped
    // following the `runX` convention would drop out of the guard without anyone
    // noticing, and an empty `misplaced` list would then be measuring nothing.
    // `help` and `version` are the two verbs main.ts's own dispatch answers, so
    // no handler file reads their flags — and the command-index refusal is pinned
    // separately below.
    const unansweredByHandler: string[] = [];
    const misplaced: string[] = [];
    for (const command of Object.keys(COMMAND_HELP)) {
      const handler = handlerFile(command);
      if (handler === null) {
        unansweredByHandler.push(command);
        continue;
      }
      const text = HANDLER_FILES.find((file) => file.rel === handler)?.text ?? "";
      for (const flag of documentedFlags(command)) {
        if (GLOBAL_FLAGS.has(flag)) continue;
        if (!readsFlag(text, flag)) misplaced.push(`${command} --${flag} (handler ${handler})`);
      }
    }
    expect(unansweredByHandler.sort()).toEqual(["help", "version"]);
    expect(misplaced).toEqual([]);
  });

  it("keeps the owner selection and the envelope switch global", () => {
    // A flag every command reads is not something each command's text has to
    // repeat; these are the six tokens the router answers before any command
    // runs — the envelope switch, both help switches, both version switches and
    // the owner selection.
    expect([...GLOBAL_FLAGS].sort()).toEqual(["h", "help", "json", "user", "v", "version"]);
    for (const command of ["status", "report", "targets", "evidence", "tracker"]) {
      expect(unknownFlags(command, { user: "someone@example.com", json: true })).toEqual([]);
    }
  });

  it("refuses a flag the index mentions but the index itself does not read", () => {
    // `igtrack help` prints the index, and the index names every other command's
    // flags. Deriving its own contract from that text would accept
    // `igtrack help --since 7d` and print the index as though the window had been
    // honoured — so the exempt command is exempt from prose, not from refusal.
    const help = documentedFlags("help");
    expect(help.has("since")).toBe(false);
    expect(help.has("out")).toBe(false);
    expect(unknownFlags("help", { since: "7d" })).toEqual(["since"]);
    expect(unknownFlags("help", { json: true })).toEqual([]);
  });

  it("says nothing about flags for a verb with no contract", () => {
    // A mistyped verb becomes a plain-English prompt, and a prompt reads the
    // whole line — refusing its tokens would refuse the question.
    expect(unknownFlags("whos", { json: true, mention: "someone" })).toEqual([]);
  });

  it("keeps one command's flags off another command's contract", () => {
    // `igtrack scans` lists `work` in the same help topic, and that text once
    // spelled out the worker's flags. Deriving the accepted set from help then
    // told `igtrack scans --max 5` that the flag was fine — and scans ignored
    // it, which is the silent drop this gate exists to refuse.
    expect(documentedFlags("work").has("max")).toBe(true);
    expect(documentedFlags("work").has("no-scheduler")).toBe(true);
    expect(documentedFlags("scans").has("max")).toBe(false);
    expect(documentedFlags("scans").has("no-scheduler")).toBe(false);
    expect(unknownFlags("scans", { max: "5" })).toEqual(["max"]);
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

  it("refuses a --user with no email rather than scoping to somebody", async () => {
    // `--user` alone is the caller naming no owner. Running it as "no selection"
    // would answer about whichever owner the environment happens to point at —
    // a read scoped to the wrong person, which is the one thing the flag exists
    // to prevent.
    for (const args of [["status", "--user"], ["status", "--user", "   "]]) {
      const run = await spawn(args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.out, args.join(" ")).toBe("");
      expect(run.err, args.join(" ")).toContain("--user needs the owner's email");
    }
  }, 90_000);
});

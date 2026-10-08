import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createContext, previewMeta, type CliContext } from "../context.js";
import { emit, errorHint, isJson, table, type ParsedArgs } from "../output.js";
import { opAsk, type AskResult } from "../ask/execute.js";
import { planAsk } from "../ask/parse.js";
import { guideText, welcomeText } from "../ask/guide.js";

// ---------------------------------------------------------------------------
// `igtrack ask` — the prompt surface.
//
// One sentence in, one honest answer out. The same entry point is exposed to AI
// agents as the `igtrack_ask` MCP tool, so a user who types a request to their
// agent gets identical behaviour to a user who types it here.
// ---------------------------------------------------------------------------

export const ASK_HELP = `igtrack ask "<plain-English request>"

Ask for work in your own words. IGTrack reads the sentence, picks the
operation(s), runs them against the same evidence layer the commands use, and
answers with what it found — plus what it could not see, and why.

  igtrack ask "investigate @aurora.wilde"
  igtrack ask "what changed on @aurora.wilde in the last 7 days?"
  igtrack ask "who does @aurora.wilde interact with most?"
  igtrack ask "show me the insights for @aurora.wilde"
  igtrack ask "track @somehandle and run the first scan"
  igtrack ask "what can you do?"

Notes:
  - A bare prompt works too: igtrack "who is @aurora.wilde?"
  - No prompt opens an interactive session (when run in a terminal).
  - Partial sentences are completed with stated assumptions, never silent
    guesses. If the account is missing, it asks which one.
  - Destructive requests (removing an account) return the exact command instead
    of running it.
  - --json returns { ok, data, _meta }; every step keeps its full operation
    result, so an agent can quote evidence ids and never fill gaps with guesses.

Exit codes: 0 answered (including a clarification), 1 every requested operation
failed, 2 usage, 3 configuration or connectivity.`;

function renderAskHuman(result: AskResult): string {
  if (result.understanding.intents.length === 1 && result.understanding.intents[0] === "guide") {
    return [
      `You asked: ${result.prompt}`,
      "",
      guideText(),
    ].join("\n");
  }

  const lines: string[] = [
    `You asked: ${result.prompt}`,
    `I understood: ${result.understanding.summary}`,
  ];
  if (result.understanding.assumptions.length > 0) {
    lines.push("Assumptions:");
    for (const assumption of result.understanding.assumptions) lines.push(`  - ${assumption}`);
  }
  lines.push("", "Answer");
  if (result.answer.length === 0) {
    lines.push("  (nothing to report)");
  } else {
    for (const item of result.answer) lines.push(`  - ${item}`);
  }

  if (result.steps.length > 0) {
    lines.push(
      "",
      "What ran",
      table(
        ["result", "operation", "outcome"],
        result.steps.map((step) => [
          step.status,
          step.intent,
          step.summary.replace(/\s+/g, " ").slice(0, 140),
        ]),
      ),
    );
    const suggested = result.steps.filter((step) => step.suggestion !== undefined);
    for (const step of suggested) {
      lines.push("", `To do that, run:`, `  ${step.suggestion ?? ""}`);
    }
  }

  if (result.next.length > 0) {
    lines.push("", "Next");
    for (const command of result.next) lines.push(`  ${command}`);
  }
  return lines.join("\n");
}

function reportError(err: unknown): void {
  const code = (err as { code?: string }).code ?? "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  stderr.write(`igtrack: ${message}\n`);
  const hint = errorHint(code, message);
  if (hint !== null) stderr.write(`\nWhat to do next:\n  ${hint}\n`);
}

async function runInteractive(): Promise<number> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let ctx: CliContext | null = null;
  stdout.write(`${welcomeText()}\n\n`);
  stdout.write(`Type a request in plain English. "help" shows the tour, "exit" leaves.\n\n`);
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question("you> ");
      } catch {
        break;
      }
      const prompt = line.trim();
      if (prompt === "") continue;
      if (/^(exit|quit|bye|q)$/i.test(prompt)) break;
      if (/^(help|guide|\?)$/i.test(prompt)) {
        stdout.write(`\n${guideText()}\n\n`);
        continue;
      }
      const plan = planAsk(prompt);
      if (plan.needsDb && ctx === null) {
        try {
          ctx = await createContext();
        } catch (err) {
          reportError(err);
          continue;
        }
      }
      try {
        const result = await opAsk(ctx, plan, {
          onProgress: (message) => stderr.write(`  … ${message}\n`),
        });
        stdout.write(`\n${renderAskHuman(result)}\n\n`);
      } catch (err) {
        reportError(err);
      }
    }
    return 0;
  } finally {
    rl.close();
    await ctx?.close().catch(() => undefined);
  }
}

/** The one prompt path shared by `ask`, a bare prompt, and the interactive loop. */
export async function runAskPrompt(prompt: string, args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const plan = planAsk(prompt);
  const ctx = plan.needsDb ? await createContext() : null;
  try {
    const onProgress = json
      ? undefined
      : (message: string): void => {
          stderr.write(`  … ${message}\n`);
        };
    const result = await opAsk(ctx, plan, onProgress === undefined ? {} : { onProgress });
    emit({
      json,
      meta: ctx?.meta ?? previewMeta(),
      data: result,
      human: renderAskHuman(result),
    });
    return result.status === "FAILED" ? 1 : 0;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

export async function runAsk(args: ParsedArgs): Promise<number> {
  const prompt = args.positionals.join(" ").trim();
  if (prompt !== "") return runAskPrompt(prompt, args);
  if (isJson(args.flags)) {
    return runAskPrompt("what can you do?", args);
  }
  if (stdin.isTTY) return runInteractive();
  stdout.write(`${guideText()}\n`);
  return 0;
}

/** Bare `igtrack` — a welcome, then the prompt loop when a terminal is attached. */
export async function runBare(args: ParsedArgs): Promise<number> {
  if (isJson(args.flags)) {
    return runAskPrompt("what can you do?", args);
  }
  if (stdin.isTTY) return runInteractive();
  stdout.write(`${welcomeText()}\n`);
  return 0;
}

export async function runGuide(args: ParsedArgs): Promise<number> {
  if (isJson(args.flags)) {
    return runAskPrompt("what can you do?", args);
  }
  stdout.write(`${guideText()}\n`);
  return 0;
}

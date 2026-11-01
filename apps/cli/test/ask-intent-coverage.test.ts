import { describe, expect, it } from "vitest";
import { opAsk } from "../src/ask/execute.js";
import { ASK_INTENTS, planAsk, type AskIntent } from "../src/ask/parse.js";
import { CliError } from "../src/output.js";

// ---------------------------------------------------------------------------
// Every intent a sentence can name, and what happens when it does.
//
// The ask surface is a dispatcher over 29 intents, and the failure mode of a
// dispatcher is the silent one: an intent that parses but has no branch throws
// "Unknown intent" at runtime, and an intent whose phrase stops parsing answers
// a real question with a guide. `PHRASE` is typed `Record<AskIntent, string>`,
// so adding an intent without a phrase fails typecheck rather than a user's
// prompt. Nothing here needs a database: the point is which branch each intent
// takes and that no branch is missing.
// ---------------------------------------------------------------------------

/** Intents answered from configuration alone — they never open a connection. */
const DATABASE_FREE: readonly AskIntent[] = ["guide", "capabilities"];

/**
 * Intents that deliberately stop at the exact command. Each one either deletes
 * recorded observations or reads through a local browser, so a sentence must
 * never cause it — the operator types the command.
 */
const ADVISORY: readonly AskIntent[] = ["untrack", "stories", "public", "post"];

const PHRASE: Record<AskIntent, string> = {
  guide: "what can you do?",
  capabilities: "what are the limitations?",
  status: "what is the status of this deployment?",
  targets: "which accounts are tracked?",
  track: "track @aurora.wilde",
  untrack: "stop tracking @aurora.wilde",
  scan: "scan @aurora.wilde now",
  work: "run the pending work",
  investigate: "investigate @aurora.wilde",
  changes: "what changed on @aurora.wilde in the last 7 days?",
  relationships: "who does @aurora.wilde interact with most?",
  insights: "what do the insights for @aurora.wilde say?",
  tags: "what tags does @aurora.wilde appear in?",
  dossier: "give me the dossier for @aurora.wilde",
  research: "research @aurora.wilde on the public web",
  plan: "what is the plan for @aurora.wilde",
  evidence: "show the evidence for @aurora.wilde",
  full_audit: "collect everything you can about @aurora.wilde",
  // "audit …" deliberately routes to the full audit (see parse.ts), so the
  // single-word read is named with its verb instead.
  audit: "verify @aurora.wilde",
  lookup: "look up @aurora.wilde",
  stories: "show the stories for @aurora.wilde",
  public: "what does the public page of @aurora.wilde say?",
  post: "read this post https://www.instagram.com/p/DeM2pENH67Y/",
  report: "show me the last report for @aurora.wilde",
  reports: "list the reports for @aurora.wilde",
  recent: "who did @aurora.wilde recently follow?",
  audience: "who is the audience of @aurora.wilde?",
  export: "export the posts of @aurora.wilde",
  digest: "give me a digest for @aurora.wilde",
};

type Outcome =
  | { kind: "result"; status: string; stepStatus: string | undefined; suggestion: string | undefined }
  | { kind: "error"; code: string };

async function run(intent: AskIntent): Promise<Outcome> {
  try {
    const result = await opAsk(null, planAsk(PHRASE[intent] ?? ""));
    const step = result.steps.find((s) => s.intent === intent) ?? result.steps[0];
    return {
      kind: "result",
      status: result.status,
      stepStatus: step?.status,
      suggestion: step?.suggestion,
    };
  } catch (err) {
    if (err instanceof CliError) return { kind: "error", code: err.code };
    throw err;
  }
}

describe("every ask intent is reachable and dispatched", () => {
  it("has one phrase for every registered intent", () => {
    // The Record type is the real gate; this names the count in the failure.
    expect(Object.keys(PHRASE).sort()).toEqual([...ASK_INTENTS].sort());
  });

  for (const intent of ASK_INTENTS) {
    it(`${intent}: a sentence names it and it takes a real branch`, async () => {
      const phrase = PHRASE[intent] ?? "";
      const plan = planAsk(phrase);
      expect(plan.intents, `phrase ${JSON.stringify(phrase)} parsed to ${plan.intents.join("+")}`)
        .toContain(intent);
      expect(plan.primary).toBe(intent);

      const outcome = await run(intent);

      if (ADVISORY.includes(intent)) {
        // A destructive or browser-mediated read is never executed from prose.
        expect(outcome.kind).toBe("result");
        if (outcome.kind === "result") {
          expect(outcome.stepStatus).toBe("SUGGESTED");
          expect(outcome.suggestion).toMatch(/^igtrack /);
        }
        return;
      }

      if (DATABASE_FREE.includes(intent)) {
        expect(outcome.kind).toBe("result");
        if (outcome.kind === "result") {
          expect(outcome.status).toBe("ANSWERED");
          expect(outcome.stepStatus).toBe("OK");
        }
        return;
      }

      // Everything else genuinely reads stored rows: it either asks which
      // account first, or refuses for want of a connection. What it may not do
      // is answer with nothing, or report an intent nobody implemented.
      if (outcome.kind === "result") {
        expect(["NEEDS_INPUT", "ANSWERED", "PARTIAL"]).toContain(outcome.status);
        if (outcome.status === "ANSWERED") {
          expect(outcome.stepStatus).toBe("OK");
        }
        return;
      }
      expect(outcome.code).toBe("DB_UNAVAILABLE");
    });
  }

  it("never reports an unimplemented intent", async () => {
    for (const intent of ASK_INTENTS) {
      const outcome = await run(intent);
      if (outcome.kind === "error") {
        expect(outcome.code, `intent ${intent} threw ${outcome.code}`).not.toBe("USAGE");
      }
    }
  });
});

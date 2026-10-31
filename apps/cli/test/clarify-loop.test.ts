import { describe, expect, it } from "vitest";
import { opAsk } from "../src/ask/execute.js";
import { planAsk } from "../src/ask/parse.js";
import { clarifyLoop } from "../src/commands/ask.js";

// ---------------------------------------------------------------------------
// The interactive loop: ask, read one line, fold it into the sentence, run it.
// The UI is injected, so the whole conversation is exercised without a real
// terminal — while the CLI still uses the same function with readline.
// ---------------------------------------------------------------------------

function fakeUi(answers: string[]): {
  writes: string[];
  asked: string[];
  write: (text: string) => void;
  question: (query: string) => Promise<string>;
} {
  const writes: string[] = [];
  const asked: string[] = [];
  return {
    writes,
    asked,
    write: (text) => {
      writes.push(text);
    },
    question: async (query) => {
      asked.push(query);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no answer queued");
      return answer;
    },
  };
}

async function unanswered(prompt: string) {
  const result = await opAsk(null, planAsk(prompt));
  expect(result.status).toBe("NEEDS_INPUT");
  return result;
}

describe("clarifyLoop", () => {
  it("asks once, merges the answer, and runs the completed sentence", async () => {
    const first = await unanswered("show the stories");
    const ui = fakeUi(["natgeo"]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(ui.asked).toEqual(["account> "]);
    expect(ui.writes.join("\n")).toContain("Which Instagram account should I work on?");
    expect(ui.writes.join("\n")).toContain("Using @natgeo. You asked: show the stories @natgeo");
    expect(result.status).toBe("ANSWERED");
    expect(result.understanding.username).toBe("natgeo");
    expect(result.steps[0]?.status).toBe("SUGGESTED");
    expect(result.steps[0]?.suggestion).toBe("igtrack anonstories natgeo");
  });

  it("accepts a numbered option from the tracked list", async () => {
    const first = await unanswered("show the stories");
    first.input = {
      kind: "USERNAME",
      question: "Which account do you mean?",
      options: [{ value: "aurora.wilde", label: "@aurora.wilde", detail: "OWNED" }],
      allowFreeText: true,
    };
    const ui = fakeUi(["1"]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(ui.writes.join("\n")).toContain("1. @aurora.wilde — OWNED");
    expect(result.understanding.username).toBe("aurora.wilde");
    expect(result.steps[0]?.suggestion).toBe("igtrack anonstories aurora.wilde");
  });

  it("runs nothing when the operator cancels", async () => {
    const first = await unanswered("show the stories");
    const ui = fakeUi(["cancel"]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(ui.asked).toHaveLength(1);
    expect(ui.writes.join("\n")).toContain("Nothing was run.");
    expect(result).toBe(first);
    expect(result.status).toBe("NEEDS_INPUT");
  });

  it("gives an unreadable answer another try instead of guessing", async () => {
    const first = await unanswered("show the stories");
    const ui = fakeUi(["not sure", "natgeo"]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(ui.asked).toHaveLength(2);
    expect(ui.writes.join("\n")).toContain("could not read an account");
    expect(result.status).toBe("ANSWERED");
    expect(result.understanding.username).toBe("natgeo");
  });

  it("stops after three unreadable answers and keeps the question open", async () => {
    const first = await unanswered("show the stories");
    const ui = fakeUi(["not sure", "still not", "no account here"]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(ui.asked).toHaveLength(3);
    expect(result.status).toBe("NEEDS_INPUT");
    expect(result.input).toBeDefined();
  });

  it("returns the open question when the terminal cannot be read", async () => {
    const first = await unanswered("show the stories");
    const ui = fakeUi([]);
    const result = await clarifyLoop(ui, null, first, undefined);

    expect(result).toBe(first);
    expect(result.status).toBe("NEEDS_INPUT");
  });
});

import { describe, expect, it } from "vitest";
import {
  formatInputQuestion,
  isCancellation,
  mergeClarification,
  resolveUsernameAnswer,
  type AskInput,
} from "../src/ask/clarify.js";
import { planAsk } from "../src/ask/parse.js";

// ---------------------------------------------------------------------------
// The clarification is the only interaction the prompt surface needs. These
// tests pin the three outcomes — answer, cancel, unreadable — and that the
// merged sentence goes back through the SAME parser, so the answer can never
// become a different request than the one asked.
// ---------------------------------------------------------------------------

const input: AskInput = {
  kind: "USERNAME",
  question: "Which account do you mean?",
  options: [
    { value: "aurora.wilde", label: "@aurora.wilde", detail: "OWNED · last observed 2026-10-01T00:00:00Z" },
    { value: "dune.harbor", label: "@dune.harbor" },
  ],
  allowFreeText: true,
};

describe("resolveUsernameAnswer", () => {
  it("picks an option by its number", () => {
    expect(resolveUsernameAnswer(input, "1")).toBe("aurora.wilde");
    expect(resolveUsernameAnswer(input, "2.")).toBe("dune.harbor");
    expect(resolveUsernameAnswer(input, "#2")).toBe("dune.harbor");
  });

  it("picks an option by its value or @label, ignoring case", () => {
    expect(resolveUsernameAnswer(input, "dune.harbor")).toBe("dune.harbor");
    expect(resolveUsernameAnswer(input, "@Dune.Harbor")).toBe("dune.harbor");
  });

  it("reads free text through the sentence parser", () => {
    expect(resolveUsernameAnswer(input, "natgeo")).toBe("natgeo");
    expect(resolveUsernameAnswer(input, "@NatGeo.")).toBe("natgeo");
    expect(resolveUsernameAnswer(input, "https://www.instagram.com/natgeo/")).toBe("natgeo");
  });

  it("rejects an answer that is a sentence, not a handle", () => {
    // "not sure" must never become the account "sure".
    expect(resolveUsernameAnswer(input, "not sure")).toBeNull();
    expect(resolveUsernameAnswer(input, "the account is @natgeo")).toBeNull();
  });

  it("accepts a one-character handle only when free text is allowed", () => {
    expect(resolveUsernameAnswer(input, "x")).toBe("x");
    expect(resolveUsernameAnswer({ ...input, allowFreeText: false }, "x")).toBeNull();
  });

  it("rejects an option that does not exist instead of wrapping around", () => {
    expect(resolveUsernameAnswer(input, "9")).toBeNull();
    expect(resolveUsernameAnswer(input, "0")).toBeNull();
  });

  it("rejects unknown free text when only options are allowed", () => {
    expect(resolveUsernameAnswer({ ...input, allowFreeText: false }, "natgeo")).toBeNull();
  });
});

describe("mergeClarification", () => {
  it("appends the account and the parser resolves the completed sentence", () => {
    const first = planAsk("audit user");
    expect(first.needsUsername).toBe(true);

    const merged = mergeClarification(first.prompt, input, "1");
    expect(merged.kind).toBe("answer");
    if (merged.kind !== "answer") return;
    expect(merged.username).toBe("aurora.wilde");
    expect(merged.prompt).toBe("audit user @aurora.wilde");

    const replanned = planAsk(merged.prompt);
    expect(replanned.username).toBe("aurora.wilde");
    expect(replanned.needsUsername).toBe(false);
    expect(replanned.intents).toContain("full_audit");
  });

  it("turns a stop word into a cancellation, never an account", () => {
    for (const answer of ["", "cancel", "quit", "never mind", "NO"]) {
      expect(mergeClarification("audit user", input, answer)).toEqual({ kind: "cancel" });
    }
  });

  it("reports an unreadable answer without guessing", () => {
    expect(mergeClarification("audit user", input, "not sure yet")).toEqual({ kind: "unreadable" });
    expect(mergeClarification("audit user", input, "1 2")).toEqual({ kind: "unreadable" });
  });
});

describe("formatInputQuestion", () => {
  it("numbers the options and says free text is accepted", () => {
    const text = formatInputQuestion(input);
    expect(text).toContain("Which account do you mean?");
    expect(text).toContain("1. @aurora.wilde — OWNED · last observed");
    expect(text).toContain("2. @dune.harbor");
    expect(text).toContain("or type any username");
  });

  it("asks for a typed username when nothing is tracked", () => {
    const text = formatInputQuestion({ ...input, options: [] });
    expect(text).toContain("type a username");
    expect(text).not.toContain("1.");
  });
});

describe("isCancellation", () => {
  it("treats an empty line and stop words as cancel", () => {
    expect(isCancellation("")).toBe(true);
    expect(isCancellation("  Cancel ")).toBe(true);
    expect(isCancellation("q")).toBe(true);
  });

  it("does not treat a handle as cancel", () => {
    expect(isCancellation("@natgeo")).toBe(false);
    expect(isCancellation("natgeo")).toBe(false);
  });
});

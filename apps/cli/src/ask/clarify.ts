import { parseUsernameAnswer } from "./parse.js";

// ---------------------------------------------------------------------------
// The one interaction the prompt surface needs: "which account?"
//
// The question is data, not prose, so every surface can answer it in its own
// way: the terminal reads a line, an agent asks its own operator, and the JSON
// shape stays stable for both. Merging the answer re-uses the sentence parser —
// there is no second interpretation path.
// ---------------------------------------------------------------------------

export interface AskInputOption {
  /** What the answer resolves to (the bare username). */
  value: string;
  /** What the operator sees ("@aurora.wilde"). */
  label: string;
  /** One line of context, e.g. the observation mode and last observation. */
  detail?: string;
}

export interface AskInput {
  kind: "USERNAME";
  question: string;
  /** Selectable accounts, in display order. Empty means "type a username". */
  options: AskInputOption[];
  /** When false, only the listed options are accepted. */
  allowFreeText: boolean;
}

const CANCELLATION_WORDS = new Set([
  "",
  "cancel",
  "nevermind",
  "never mind",
  "stop",
  "abort",
  "exit",
  "quit",
  "q",
  "no",
  "nope",
]);

/** An empty line or a stop word means the operator changed their mind. */
export function isCancellation(answer: string): boolean {
  return CANCELLATION_WORDS.has(answer.trim().toLowerCase());
}

/** The question plus its answerable options, exactly as a terminal shows it. */
export function formatInputQuestion(input: AskInput): string {
  const lines = [input.question];
  for (const [index, option] of input.options.entries()) {
    lines.push(`  ${index + 1}. ${option.label}${option.detail === undefined ? "" : ` — ${option.detail}`}`);
  }
  if (input.allowFreeText) {
    lines.push(
      input.options.length > 0
        ? "  or type any username; \"cancel\" stops here"
        : "  type a username (for example @name); \"cancel\" stops here",
    );
  }
  return lines.join("\n");
}

/**
 * Read one answer to the question. A number picks an option; an option's value
 * or @label names it; free text is parsed by the same rule the prompt uses.
 * Returns null when the answer does not name an account.
 */
export function resolveUsernameAnswer(input: AskInput, answer: string): string | null {
  const trimmed = answer.trim();
  if (trimmed === "" || isCancellation(trimmed)) return null;

  if (input.options.length > 0) {
    const numeric = /^#?(\d{1,3})[.)]?$/.exec(trimmed);
    if (numeric !== null) {
      const index = Number.parseInt(numeric[1] ?? "", 10) - 1;
      const option = input.options[index];
      return option === undefined ? null : option.value;
    }
    const bare = trimmed.replace(/^@/, "").toLowerCase();
    const exact = input.options.find(
      (option) => option.value.toLowerCase() === bare || option.label.replace(/^@/, "").toLowerCase() === bare,
    );
    if (exact !== undefined) return exact.value;
  }

  if (!input.allowFreeText) return null;
  return parseUsernameAnswer(trimmed);
}

export type Clarification =
  | { kind: "answer"; prompt: string; username: string }
  | { kind: "cancel" }
  | { kind: "unreadable" };

/**
 * Fold the operator's answer into the original sentence. The account is
 * appended as @handle, so the same parser sees a complete request; nothing is
 * re-interpreted by hand.
 */
export function mergeClarification(prompt: string, input: AskInput, answer: string): Clarification {
  if (isCancellation(answer)) return { kind: "cancel" };
  const username = resolveUsernameAnswer(input, answer);
  if (username === null) return { kind: "unreadable" };
  return {
    kind: "answer",
    username,
    prompt: `${prompt.trim()} @${username}`,
  };
}

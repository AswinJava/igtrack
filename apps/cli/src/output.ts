import { CAPABILITY_REGISTRY, isCapabilityAvailable, type CapabilityRegistryEntry } from "@igtrack/core";

// ---------------------------------------------------------------------------
// Output conventions for the agent-native surface.
//
// Two hard rules, both inherited from the product's epistemic contract:
//   1. Every machine-readable payload carries a `_meta` block naming the active
//      provider and whether the data is synthetic. Fixture data must never be
//      mistakable for live observation — by a human OR by an agent.
//   2. Absence is printed as absence. A null count prints as "unavailable",
//      never as 0.
// ---------------------------------------------------------------------------

export interface OutputMeta {
  provider: string;
  sourceId: string | null;
  /** True when the active provider does not observe reality. */
  synthetic: boolean;
  production: boolean;
  studio: "cli";
  generatedAt: string;
  note?: string;
}

export interface JsonEnvelope<T> {
  ok: true;
  data: T;
  _meta: OutputMeta;
}

export interface JsonErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
  _meta?: OutputMeta;
}

export function envelope<T>(data: T, meta: OutputMeta): JsonEnvelope<T> {
  return { ok: true, data, _meta: meta };
}

export function errorEnvelope(code: string, message: string): JsonErrorEnvelope {
  return { ok: false, error: { code, message } };
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super("USAGE", message, 2);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Argument parsing — small, explicit, no dependency.
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length === 2) {
      const short = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[short] = next;
        i += 1;
      } else {
        flags[short] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  const command = positionals.shift() ?? "help";
  return { command, positionals, flags };
}

export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  return value === true || value === "true" || value === "1";
}

export function flagNumber(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`--${name} expects a number, received "${raw}"`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

export function isJson(flags: Record<string, string | boolean>): boolean {
  return flagBool(flags, "json");
}

/** Render a value for a human: null/undefined is "unavailable", never 0. */
export function display(value: unknown): string {
  if (value === null || value === undefined) return "unavailable";
  if (value === "") return "(empty)";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return String(value);
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "(none)";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function relativeTime(value: Date | string | null): string {
  if (value === null) return "never";
  const date = value instanceof Date ? value : new Date(value);
  const deltaMs = Date.now() - date.getTime();
  if (!Number.isFinite(deltaMs)) return "unknown";
  const abs = Math.abs(deltaMs);
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [unitMs, suffix] of units) {
    if (abs >= unitMs) {
      const n = Math.floor(abs / unitMs);
      return deltaMs >= 0 ? `${n}${suffix} ago` : `in ${n}${suffix}`;
    }
  }
  return "just now";
}

// ---------------------------------------------------------------------------
// Capability rendering — the honesty surface in text form. Mirrors the
// capability registry so the CLI cannot drift into marketing.
// ---------------------------------------------------------------------------

export interface CapabilityLine {
  id: string;
  label: string;
  available: boolean;
  why: string | null;
  liveState: CapabilityRegistryEntry["liveState"];
}

export function capabilityLines(): CapabilityLine[] {
  return CAPABILITY_REGISTRY.map((entry) => ({
    id: entry.id,
    label: entry.label,
    available: isCapabilityAvailable(entry),
    why: entry.whyUnavailable,
    liveState: entry.liveState,
  }));
}

// ---------------------------------------------------------------------------
// Emission — the single place output leaves the process.
// ---------------------------------------------------------------------------

/**
 * Print one operation result.
 *
 * JSON mode always prints the same envelope shape (`ok`, `data`, `_meta`) so an
 * agent can parse every command with one rule. Human mode prints the prepared
 * text. Nothing else in the CLI writes to stdout — the MCP stdio transport owns
 * stdout in `igtrack mcp`, and a stray print there would corrupt JSON-RPC.
 */
export function emit(options: {
  json: boolean;
  meta: OutputMeta;
  data: unknown;
  human: string;
}): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(envelope(options.data, options.meta), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${options.human}\n`);
}

export function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined || raw === "") return null;
  const relative = /^(\d+)([smhd])$/.exec(raw);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const unitMs =
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`--since expects a duration (7d, 24h, 30m) or an ISO date, received "${raw}"`);
  }
  return parsed;
}

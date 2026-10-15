import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Environment resolution for the CLI.
//
// The web app is launched by Next.js, which loads `.env` automatically. The
// worker (tsx) and this CLI are plain Node processes, which do not — so the CLI
// loads `.env` itself. Only variables that are NOT already set are applied, so
// an explicit `DATABASE_URL=... igtrack status` always wins over the file, and
// nothing here can silently override a deployment's real environment.
// ---------------------------------------------------------------------------

export interface EnvLoadResult {
  files: string[];
  appliedKeys: string[];
}

export function repoRoot(): string {
  // apps/cli/src/env.ts → repo root is three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Parse a dotenv-shaped file. Deliberately small: KEY=value, optional `export`,
 * `#` comments, blank lines, and single/double quoted values. No interpolation,
 * no multi-line values — `.env.example` is the canonical reference for what
 * this project actually uses.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadEnvFiles(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EnvLoadResult {
  const files: string[] = [];
  const appliedKeys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const path = resolve(candidate);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    files.push(path);
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] !== undefined && env[key] !== "") continue;
      env[key] = value;
      appliedKeys.push(key);
    }
  }
  return { files, appliedKeys };
}

/** Load the repository `.env` (and a `.env` in the caller's cwd, if different). */
export function loadProjectEnv(): EnvLoadResult {
  const root = repoRoot();
  return loadEnvFiles([join(process.cwd(), ".env"), join(root, ".env")]);
}

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw !== "false" && raw !== "0";
}

// ---------------------------------------------------------------------------
// Human-facing configuration summary. Values only for non-secret keys; secrets
// are reported as present/absent — the CLI never prints tokens.
// ---------------------------------------------------------------------------

export const SECRET_ENV_KEYS = [
  "IGTRACK_GRAPH_ACCESS_TOKEN",
  "DATABASE_URL",
  "IGTRACK_DATABASE_URL",
] as const;

export function redactEnvValue(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "(unset)";
  if ((SECRET_ENV_KEYS as readonly string[]).includes(key)) {
    // Postgres URLs carry credentials; show the shape, never the password.
    if (key.includes("DATABASE_URL")) {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.username}:***@${url.host}${url.pathname}`;
      } catch {
        return "(set, unparsable)";
      }
    }
    return "(set)";
  }
  return value;
}

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, seed, users } from "@igtrack/database";
import { assessReadiness, isBlocking } from "@igtrack/ingestion";
import { loadProjectEnv, repoRoot, redactEnvValue } from "../env.js";
import { CliError, emit, isJson, type OutputMeta, type ParsedArgs, table } from "../output.js";
import { opCapabilities, opDoctor, opStatus, type DoctorReport } from "../tools.js";
import { createContext } from "../context.js";

// ---------------------------------------------------------------------------
// setup — take a fresh checkout to "working" in one command.
//
// Deliberately does NOT use createContext(): a brand-new database has no users
// yet, so user resolution (which every other command requires) cannot succeed
// until this has run. This is the only command that builds its own handle.
// ---------------------------------------------------------------------------

export interface SetupData {
  envFiles: string[];
  database: string;
  migrations: "applied";
  demoData: "seeded" | "already-present" | "skipped";
  users: number;
  targets: number;
  provider: string;
  next: string[];
}

export const SETUP_HELP = `igtrack setup [--local] [--no-seed] [--json]

Prepare this checkout: load .env, verify Postgres, apply migrations, and — on a
database with no users — load the synthetic demo so there is something real to
look at. All demo data is synthetic and every payload says so (_meta.synthetic).

  --local     When no database URL is configured, use the local Docker Compose
              default (postgresql://igtrack:igtrack@localhost:5432/igtrack).
              Crude but deliberate: an explicit flag, never a silent fallback.
  --no-seed   Migrate only. Never insert demo rows.
  --json      Machine-readable envelope.`;

/** The exact URL docker-compose.yml provisions. Never used implicitly. */
export const LOCAL_DATABASE_URL = "postgresql://igtrack:igtrack@localhost:5432/igtrack";

export async function runSetup(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const withSeed = !args.flags["no-seed"];
  const envFiles = loadProjectEnv();
  let usingLocalDefault = false;
  let envWritten: string | null = null;

  if (args.flags["local"] === true) {
    if ((process.env.IGTRACK_DATABASE_URL ?? process.env.DATABASE_URL ?? "") === "") {
      process.env.IGTRACK_DATABASE_URL = LOCAL_DATABASE_URL;
      usingLocalDefault = true;
      // Persist the choice, because every other command reads .env (the web app
      // and worker included). .env is gitignored and holds no secret here — the
      // Compose password is public and local-only.
      envWritten = persistLocalDatabaseUrl();
    }
  }

  if ((process.env.IGTRACK_DATABASE_URL ?? process.env.DATABASE_URL ?? "") === "") {
    throw new CliError(
      "DATABASE_URL_MISSING",
      [
        "No database URL is configured.",
        "",
        "  docker compose up -d      # Postgres 16 on localhost:5432",
        "  igtrack setup --local     # use that database",
        "",
        "Or set IGTRACK_DATABASE_URL / DATABASE_URL to any Postgres you control.",
      ].join("\n"),
      3,
    );
  }

  const handle = createDb();
  try {
    try {
      await handle.sql`SELECT 1`;
    } catch (err) {
      const hint = usingLocalDefault
        ? "\n  docker compose up -d      # no database answered on localhost:5432"
        : "\n  docker compose up -d      # or point IGTRACK_DATABASE_URL at your own Postgres";
      throw new CliError(
        "DATABASE_UNREACHABLE",
        [
          `Cannot reach Postgres: ${err instanceof Error ? err.message : String(err)}`,
          hint,
          "  igtrack setup",
        ].join("\n"),
        3,
      );
    }

    await runMigrations(handle.db);

    const userCountRows = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    const usersBefore = userCountRows[0]?.count ?? 0;

    let demoData: SetupData["demoData"] = "skipped";
    if (usersBefore > 0) {
      demoData = "already-present";
    } else if (withSeed) {
      await seed(handle.db);
      demoData = "seeded";
    }

    const targetRows = await handle.db.execute(
      sql`SELECT count(*)::int AS count FROM targets`,
    );
    const targetCount = Number(
      (targetRows as unknown as Array<{ count: number }>)[0]?.count ?? 0,
    );
    const userRows = await handle.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);

    const url = process.env.IGTRACK_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
    const data: SetupData = {
      envFiles: envFiles.files,
      database: redactEnvValue("DATABASE_URL", url),
      migrations: "applied",
      demoData,
      users: userRows[0]?.count ?? 0,
      targets: targetCount,
      provider: process.env.IGTRACK_PROVIDER ?? "fixture",
      next: [
        'igtrack ask "what can you do?"',
        "igtrack investigate aurora.wilde",
        "igtrack status",
        "igtrack mcp   # expose these operations to your AI agent",
      ],
    };

    const human = [
      "IGTrack setup",
      table(
        ["step", "result"],
        [
          [
            "env files",
            envFiles.files.length === 0
              ? "(none — using process env)"
              : envFiles.files.join(", "),
          ],
          ["database", data.database],
          ["migrations", "applied"],
          [
            "demo data",
            demoData === "seeded"
              ? "seeded (synthetic)"
              : demoData === "already-present"
                ? "already present (left untouched)"
                : "skipped",
          ],
          ["users", String(data.users)],
          ["targets", String(data.targets)],
          ["provider", data.provider],
          ...(usingLocalDefault
            ? [["database url", "local Docker Compose default (--local)"]]
            : []),
          ...(envWritten === null ? [] : [["env written", envWritten]]),
        ],
      ),
      "",
      "Next:",
      ...data.next.map((n) => `  ${n}`),
    ].join("\n");

    emit({ json, meta: metaFor(), data, human });
    return 0;
  } finally {
    await handle.close();
  }
}

/**
 * Record the local Compose database URL in the repository `.env`, creating the
 * file when it is absent. Only ever called from `setup --local` after nothing
 * else configured a URL, so it cannot overwrite a real deployment's setting.
 * Returns a human description of what was written, or null on failure.
 */
function persistLocalDatabaseUrl(): string | null {
  const path = join(repoRoot(), ".env");
  const line = `DATABASE_URL=${LOCAL_DATABASE_URL}`;
  try {
    if (!existsSync(path)) {
      writeFileSync(
        path,
        `# IGTrack local environment — written by \`igtrack setup --local\`.
# This file is gitignored. Never put real secrets in it.
${line}\n`,
        "utf8",
      );
      return ".env (created)";
    }
    const existing = readFileSync(path, "utf8");
    if (/^\s*(export\s+)?(IGTRACK_)?DATABASE_URL\s*=/m.test(existing)) return null;
    const separator = existing.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${separator}\n# Added by \`igtrack setup --local\` (Docker Compose default).\n${line}\n`, "utf8");
    return ".env (appended)";
  } catch {
    // A read-only checkout still works: the URL is already in this process.
    return null;
  }
}

function metaFor(): OutputMeta {
  const provider = process.env.IGTRACK_PROVIDER ?? "fixture";
  return {
    provider,
    sourceId: null,
    // Only the fixture provider is a synthetic source. Hardcoding `true` here
    // would label a graph deployment's own configuration "synthetic" — the
    // same class of lie the rest of the product refuses.
    synthetic: provider === "fixture",
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// config — what this process actually resolved, secrets redacted.
// ---------------------------------------------------------------------------

export const CONFIG_HELP = `igtrack config [--json]

Show the effective configuration: which .env files were loaded, the resolved
values of the core variables with credentials redacted, and whether secret
values are set (they are never printed). The state column is a LOCAL check
(MISSING / PLACEHOLDER / INVALID_CONFIGURATION / NOT_VERIFIED) over the
variables igtrack reads — it makes no API request and never prints a value,
so "NOT_VERIFIED" is the best any credential can show here. .env.example
documents every variable IGTrack reads.`;

export const CONFIG_KEYS: Array<{ key: string; meaning: string }> = [
  { key: "DATABASE_URL", meaning: "Postgres connection (required)" },
  { key: "IGTRACK_DATABASE_URL", meaning: "Overrides DATABASE_URL" },
  { key: "IGTRACK_PROVIDER", meaning: "fixture | graph | import | public | anonstories" },
  { key: "IGTRACK_FIXTURE_VERSION", meaning: "Fixture dataset version" },
  { key: "IGTRACK_FIXTURES_DIR", meaning: "Override fixture directory" },
  { key: "IGTRACK_CHROME_PATH", meaning: "Chrome/Chromium executable (public + anonstories providers)" },
  { key: "IGTRACK_ANON_MAX_HIGHLIGHTS", meaning: "Highlights read per anonstories dossier (default 5)" },
  { key: "IGTRACK_IMPORT_DIR", meaning: "Export directory (import provider)" },
  { key: "IGTRACK_IMPORT_USERNAME", meaning: "Export owner (import provider)" },
  { key: "IGTRACK_GRAPH_ACCESS_TOKEN", meaning: "Graph token (secret)" },
  { key: "IGTRACK_GRAPH_IG_USER_ID", meaning: "Owned IG user id" },
  { key: "IGTRACK_GRAPH_USERNAME", meaning: "Owned IG username" },
  { key: "IGTRACK_GRAPH_API_VERSION", meaning: "Graph API version" },
  {
    key: "IGTRACK_GRAPH_BUSINESS_DISCOVERY",
    meaning: "1 enables the Business Discovery probe of other public accounts",
  },
  { key: "IGTRACK_USER_EMAIL", meaning: "Owner user for CLI operations" },
  {
    key: "IGTRACK_SCHEDULER_ENABLED",
    meaning: "Set exactly \"false\" to disable in-process scheduling",
  },
  { key: "IGTRACK_JOB_POLL_MS", meaning: "Worker poll interval" },
  { key: "IGTRACK_JOB_LEASE_MS", meaning: "Job lease duration" },
  { key: "IGTRACK_SCAN_STORY_MS", meaning: "Story scan interval" },
  { key: "NODE_ENV", meaning: "development | production" },
];

export async function runConfig(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const loaded = loadProjectEnv();
  // Same assessment `doctor` uses, so the two commands can never disagree
  // about whether a value is a placeholder. Names and states only — the value
  // column stays redacted exactly as before.
  const readiness = assessReadiness(process.env);
  const states = new Map(readiness.variables.map((v) => [v.name, v.state]));
  const rows = CONFIG_KEYS.map(({ key, meaning }) => [
    key,
    redactEnvValue(key, process.env[key]),
    states.get(key) ?? "not assessed",
    meaning,
  ]);

  const data = {
    repoRoot: repoRoot(),
    cwd: process.cwd(),
    envFiles: loaded.files,
    // Keys present in the files are safe to name: values are redacted below.
    appliedFromFiles: loaded.appliedKeys,
    variables: Object.fromEntries(
      CONFIG_KEYS.map(({ key }) => [key, redactEnvValue(key, process.env[key])]),
    ),
    readiness,
  };

  const human = [
    `repo root   ${data.repoRoot}`,
    `cwd         ${data.cwd}`,
    `env files   ${loaded.files.length === 0 ? "(none found — using process env only)" : loaded.files.join(", ")}`,
    `readiness   ${readiness.status}${
      readiness.problems.length === 0
        ? " — no problems found"
        : ` — ${readiness.problems.length} variable(s) need attention (below)`
    } · no API request was made (networkCallMade=${String(readiness.networkCallMade)})`,
    "",
    table(["variable", "value", "state", "meaning"], rows),
    ...(readiness.problems.length === 0
      ? []
      : ["", "Problems (each names a variable and a fix; no values are shown):", ...readiness.problems.map((p) => `  · ${p}`)]),
  ].join("\n");

  emit({ json, meta: metaFor(), data, human });
  return 0;
}

// ---------------------------------------------------------------------------
// doctor / status / capabilities convenience wrappers live here so setup.ts is
// the single "operate this deployment" module.
// ---------------------------------------------------------------------------

/**
 * Doctor's exit code, computed from the report alone so the JSON envelope and
 * the human screen cannot disagree about it.
 *
 * Advisory findings (a degraded source row, an unreachable database) stay
 * non-fatal — scripts call `doctor` and a warning must not break them. A
 * configuration that cannot run is different: an unusable provider, or a
 * required variable that is MISSING, is the literal `PASTE_..._HERE` the
 * example file ships with, or is structurally impossible, exits 3 — so
 * "doctor says fine" can never describe a deployment whose credentials are
 * still the example text.
 */
export function doctorExitCode(report: DoctorReport): number {
  return isBlocking(report.env.config.status) || report.provider.error !== null ? 3 : 0;
}

/**
 * The human screen, derived from the same `report` object the JSON envelope
 * carries. It renders `report.env.config.variables` directly — one list, two
 * renderings — so the two outputs cannot drift apart.
 */
export function renderDoctorHuman(report: DoctorReport): string {
  const cfg = report.env.config;
  const graphVars = cfg.variables.filter((v) => v.name.startsWith("IGTRACK_GRAPH_"));
  const requiredGraph = graphVars.filter((v) => v.required);
  const usableGraph = requiredGraph.filter((v) => v.state === "NOT_VERIFIED");
  return [
    table(
      ["item", "value"],
      [
        ["provider", `${report.provider.name} (${report.provider.sourceId ?? "unusable"})`],
        [
          "synthetic",
          report.provider.error !== null
            ? "n/a — the provider is unusable, so no evidence is being described"
            : report.provider.synthetic
              ? "YES — synthetic fixture data, not live Instagram evidence"
              : "no — live Graph API or the operator's own export",
        ],
        ["database", report.database.reachable ? "reachable" : "unreachable"],
        ["migrations", report.database.migrationsApplied ? "applied" : "NOT applied"],
        [
          "config",
          cfg.status === "NOT_APPLICABLE"
            ? "no required variables (IGTRACK_PROVIDER unset → fixture default)"
            : isBlocking(cfg.status)
              ? `BLOCKED (${cfg.status}) — fix the variable(s) under "configuration readiness"`
              : `locally valid (${cfg.status}) — no API request was made${
                  cfg.problems.length === 0
                    ? ""
                    : ` · ${cfg.problems.length} optional-variable problem(s) reported below`
                }`,
        ],
        [
          "graph credentials",
          !cfg.graphCredentialsRequired
            ? `not consumed (IGTRACK_PROVIDER=${cfg.provider}); reported only because they are set`
            : requiredGraph.length === 0
              ? "none set"
              : `${usableGraph.length}/${requiredGraph.length} required variables usable`,
        ],
        ["api connectivity", "NOT_VERIFIED — doctor makes no network request"],
        ["scheduler", report.scheduler.enabled ? "enabled" : "disabled"],
        ["source health rows", String(report.sourceHealth.length)],
      ],
    ),
    "",
    "Configuration readiness (local checks only — variable names and fixes, never values):",
    table(
      ["variable", "required", "state", "action"],
      cfg.variables.map((v) => [v.name, v.required ? "required" : "optional", v.state, v.action]),
    ),
    "",
    "Findings:",
    ...(report.findings.length === 0 ? ["  (none)"] : report.findings.map((f) => `  - ${f}`)),
    "",
    `Capability summary: ${opCapabilities().summary.available}/${opCapabilities().summary.total} obtainable from a lawful source.`,
    "Full registry: `igtrack capabilities`.",
  ].join("\n");
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const report = await opDoctor(ctx);
    emit({ json, meta: ctx.meta, data: report, human: renderDoctorHuman(report) });
    return doctorExitCode(report);
  } finally {
    await ctx.close();
  }
}

export async function runStatus(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const report = await opStatus(ctx);
    const human = [
      `Owner        ${report.owner.email}`,
      `Provider     ${report.provider.name}${report.provider.synthetic ? " (synthetic — fixture data)" : ""}${report.provider.usable ? "" : ` — UNUSABLE: ${report.provider.error ?? ""}`}`,
      "",
      table(
        ["target", "status", "followers", "following", "last observed", "last scan"],
        report.targets.items.map((t) => [
          `@${t.username}`,
          t.status,
          t.followerCount === null ? "unavailable" : String(t.followerCount),
          t.followingCount === null ? "unavailable" : String(t.followingCount),
          t.lastObserved === null ? "never" : t.lastObserved.toISOString(),
          t.latestJobOutcome ?? "none",
        ]),
      ),
      "",
      `Queue        queued ${report.queue.queued} · running ${report.queue.running} · retry-wait ${report.queue.retryWait} · failed ${report.queue.failed}`,
      `Source health ${report.sourceHealth.length === 0 ? "no observations recorded yet" : report.sourceHealth.map((h) => `${h.capability}:${h.status}`).join(" · ")}`,
    ].join("\n");
    emit({ json, meta: ctx.meta, data: report, human });
    return 0;
  } finally {
    await ctx.close();
  }
}

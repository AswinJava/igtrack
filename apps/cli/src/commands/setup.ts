import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, seed, users } from "@igtrack/database";
import { loadProjectEnv, repoRoot, redactEnvValue } from "../env.js";
import { CliError, emit, isJson, type OutputMeta, type ParsedArgs, table } from "../output.js";
import { opCapabilities, opDoctor, opStatus } from "../tools.js";
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
        "igtrack status",
        "igtrack scans run",
        "igtrack work --max 10",
        "igtrack activity",
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
  return {
    provider: process.env.IGTRACK_PROVIDER ?? "fixture",
    sourceId: null,
    synthetic: true,
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// config — what this process actually resolved, secrets redacted.
// ---------------------------------------------------------------------------

export const CONFIG_HELP = `igtrack config [--json]

Show the effective configuration: which .env files were loaded, every variable
IGTrack reads, and the resolved value with credentials redacted. Tokens are
never printed — only whether they are set.`;

const CONFIG_KEYS: Array<{ key: string; meaning: string }> = [
  { key: "DATABASE_URL", meaning: "Postgres connection (required)" },
  { key: "IGTRACK_DATABASE_URL", meaning: "Overrides DATABASE_URL" },
  { key: "IGTRACK_PROVIDER", meaning: "fixture | graph" },
  { key: "IGTRACK_FIXTURE_VERSION", meaning: "Fixture dataset version" },
  { key: "IGTRACK_FIXTURES_DIR", meaning: "Override fixture directory" },
  { key: "IGTRACK_GRAPH_ACCESS_TOKEN", meaning: "Graph token (secret)" },
  { key: "IGTRACK_GRAPH_IG_USER_ID", meaning: "Owned IG user id" },
  { key: "IGTRACK_GRAPH_USERNAME", meaning: "Owned IG username" },
  { key: "IGTRACK_GRAPH_API_VERSION", meaning: "Graph API version" },
  {
    key: "IGTRACK_GRAPH_BUSINESS_DISCOVERY",
    meaning: "1 enables the Business Discovery probe of other public accounts (D42)",
  },
  { key: "IGTRACK_USER_EMAIL", meaning: "Owner user for CLI operations" },
  { key: "IGTRACK_SCHEDULER", meaning: "1 enables in-process scheduling" },
  { key: "IGTRACK_JOB_POLL_MS", meaning: "Worker poll interval" },
  { key: "IGTRACK_JOB_LEASE_MS", meaning: "Job lease duration" },
  { key: "IGTRACK_SCAN_STORY_MS", meaning: "Story scan interval" },
  { key: "NODE_ENV", meaning: "development | production" },
];

export async function runConfig(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const loaded = loadProjectEnv();
  const rows = CONFIG_KEYS.map(({ key, meaning }) => [
    key,
    redactEnvValue(key, process.env[key]),
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
  };

  const human = [
    `repo root   ${data.repoRoot}`,
    `cwd         ${data.cwd}`,
    `env files   ${loaded.files.length === 0 ? "(none found — using process env only)" : loaded.files.join(", ")}`,
    "",
    table(["variable", "value", "meaning"], rows),
  ].join("\n");

  emit({ json, meta: metaFor(), data, human });
  return 0;
}

// ---------------------------------------------------------------------------
// doctor / status / capabilities convenience wrappers live here so setup.ts is
// the single "operate this deployment" module.
// ---------------------------------------------------------------------------

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const json = isJson(args.flags);
  const ctx = await createContext();
  try {
    const report = await opDoctor(ctx);
    const human = [
      table(
        ["item", "value"],
        [
          ["provider", `${report.provider.name} (${report.provider.sourceId ?? "unusable"})`],
          ["synthetic", report.provider.synthetic ? "YES — not a real observation" : "no"],
          ["database", report.database.reachable ? "reachable" : "unreachable"],
          ["migrations", report.database.migrationsApplied ? "applied" : "NOT applied"],
          [
            "graph credentials",
            report.env.graphCredentials === "all-set"
              ? "all three set (presence only — validity is proven by a call, not by this check)"
              : `${report.env.graphCredentials} (needs all three to use the graph provider)`,
          ],
          ["scheduler", report.scheduler.enabled ? "enabled" : "disabled"],
          ["source health rows", String(report.sourceHealth.length)],
        ],
      ),
      "",
      "Findings:",
      ...(report.findings.length === 0 ? ["  (none)"] : report.findings.map((f) => `  - ${f}`)),
      "",
      `Capability summary: ${opCapabilities().summary.available}/${opCapabilities().summary.total} obtainable from a lawful source.`,
      "Full registry: `igtrack capabilities`.",
    ].join("\n");
    emit({ json, meta: ctx.meta, data: report, human });
    // Doctor is informational: findings never change the exit code — a
    // deployment with advisory findings must not break the scripts calling it.
    return 0;
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

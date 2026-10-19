import { asc, sql } from "drizzle-orm";
import { createDb, users, type Database } from "@igtrack/database";
import { providerFromEnv } from "@igtrack/monitoring";
import type { InstagramProvider } from "@igtrack/core";
import { loadProjectEnv, repoRoot, type EnvLoadResult } from "./env.js";
import { CliError, type OutputMeta } from "./output.js";

// ---------------------------------------------------------------------------
// Shared context for every command and every MCP tool.
//
// Ownership model: the CLI is a single-operator surface. It resolves ONE user
// (the owner of this deployment) and scopes every read/write to that user, so
// the CLI can never accidentally read another user's targets. Ambiguity is an
// error, never a guess.
// ---------------------------------------------------------------------------

export interface ProviderDescriptor {
  /** Configured provider name from IGTRACK_PROVIDER. */
  name: string;
  /** Provider-reported source id (fixture:v1, graph:owned, …) or null. */
  sourceId: string | null;
  /** Configuration failure (unknown provider, missing credentials, …). */
  error: string | null;
  /** True when the provider does not observe reality. */
  synthetic: boolean;
  provider: InstagramProvider | null;
}

export interface CliContext {
  db: Database;
  sql: ReturnType<typeof createDb>["sql"];
  userId: string;
  userEmail: string;
  provider: ProviderDescriptor;
  meta: OutputMeta;
  envFiles: EnvLoadResult;
  close(): Promise<void>;
}

export interface ContextOptions {
  /** Override user selection (--user / IGTRACK_USER_EMAIL). */
  userEmail?: string | undefined;
  /** Skip provider construction (used by tests that only touch the DB). */
  skipProvider?: boolean;
}

/**
 * Whether a provider of this name produces synthetic data. The fixture provider
 * is the only synthetic source; everything else is the operator's own export or
 * the live Graph API. Used wherever a descriptor has to say what kind of
 * evidence it is *without* having a provider instance to ask.
 */
function isSyntheticProviderName(name: string): boolean {
  return name !== "graph" && name !== "import";
}

function describeProvider(): ProviderDescriptor {
  const name = process.env.IGTRACK_PROVIDER ?? "fixture";
  try {
    const { provider } = providerFromEnv();
    return {
      name,
      sourceId: provider.sourceId,
      error: null,
      synthetic: isSyntheticProviderName(name),
      provider,
    };
  } catch (err) {
    // Unknown provider name or missing credentials: a configuration failure,
    // never an empty dataset (same rule the worker enforces at boot).
    //
    // `synthetic` describes what the SELECTED provider would have produced,
    // not what a failure is. Hardcoding `true` here made an unusable graph
    // deployment report "synthetic fixture data", which is the same class of
    // mislabel the product refuses elsewhere: the fixture provider is the only
    // synthetic source, and a graph failure is not one.
    return {
      name,
      sourceId: null,
      error: err instanceof Error ? err.message : String(err),
      synthetic: isSyntheticProviderName(name),
      provider: null,
    };
  }
}

export function providerMeta(descriptor: ProviderDescriptor): OutputMeta {
  const base: OutputMeta = {
    provider: descriptor.name,
    sourceId: descriptor.sourceId,
    synthetic: descriptor.synthetic,
    production: process.env.NODE_ENV === "production",
    studio: "cli",
    generatedAt: new Date().toISOString(),
  };
  if (descriptor.error !== null) {
    return { ...base, note: `Provider is not usable: ${descriptor.error}` };
  }
  return descriptor.synthetic
    ? { ...base, note: "Synthetic fixture data. Not a real account observation." }
    : {
        ...base,
        note: "Live observation of the authorized account via the official Instagram Graph API.",
      };
}

export async function createContext(options: ContextOptions = {}): Promise<CliContext> {
  const envFiles = loadProjectEnv();
  const handle = createDb();
  try {
    const user = await resolveUser(handle.db, options.userEmail);
    const provider =
      options.skipProvider === true
        ? {
            name: process.env.IGTRACK_PROVIDER ?? "fixture",
            sourceId: null,
            error: null,
            // Derived from the selected name, not hardcoded: a test that skips
            // provider construction while the deployment selects `graph` must
            // not have its metadata labelled synthetic fixture data.
            synthetic: isSyntheticProviderName(process.env.IGTRACK_PROVIDER ?? "fixture"),
            provider: null,
          }
        : describeProvider();
    return {
      db: handle.db,
      sql: handle.sql,
      userId: user.id,
      userEmail: user.email,
      provider,
      meta: providerMeta(provider),
      envFiles,
      close: handle.close,
    };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

export interface UserRow {
  id: string;
  email: string;
}

/**
 * Resolve the deployment owner.
 *
 * Precedence: explicit flag → IGTRACK_USER_EMAIL → the only user in the
 * database. Zero users means the database was never seeded (setup needed);
 * several users means the operator must say which one — the CLI refuses to pick
 * arbitrarily because every read is scoped to a user.
 */
export async function resolveUser(
  db: Database,
  explicit: string | undefined,
): Promise<UserRow> {
  const requested = (explicit ?? process.env.IGTRACK_USER_EMAIL ?? "").trim();
  const selection = { id: users.id, email: users.email };
  const rows =
    requested === ""
      ? await db.select(selection).from(users).orderBy(asc(users.createdAt))
      : await db
          .select(selection)
          .from(users)
          .where(sql`lower(${users.email}) = lower(${requested})`)
          .orderBy(asc(users.createdAt));

  if (rows.length === 0) {
    throw new CliError(
      "NO_USER",
      requested === ""
        ? "No users exist in this database. Run `igtrack setup` to migrate and seed the synthetic demo."
        : `No user matches "${requested}".`,
      2,
    );
  }
  const first = rows[0];
  if (first === undefined) {
    throw new CliError("NO_USER", "User resolution failed.", 2);
  }
  if (requested === "" && rows.length > 1) {
    throw new CliError(
      "AMBIGUOUS_USER",
      `This database has ${rows.length} users (${rows.map((u) => u.email).join(", ")}). ` +
        "Pass --user <email> or set IGTRACK_USER_EMAIL to choose the owner.",
      2,
    );
  }
  return { id: first.id, email: first.email };
}

export function projectRoot(): string {
  return repoRoot();
}

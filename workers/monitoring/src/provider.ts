import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnonStoriesProvider, FixtureProvider, GraphProvider, ImportProvider, PublicWebProvider, graphConfigFromEnv } from "@igtrack/ingestion";
import type { InstagramProvider } from "@igtrack/core";
import { buildSource, type ExecutionSource } from "./executors.js";

export interface ProviderConfig {
  name: "fixture" | "graph" | "import" | "public" | "anonstories";
  fixturesDir?: string;
  fixtureVersion?: string;
  importDir?: string;
  importUsername?: string;
}

export function createExecutionSource(config: ProviderConfig): ExecutionSource {
  let provider: InstagramProvider;
  switch (config.name) {
    case "fixture":
      provider = new FixtureProvider({
        fixturesDir: config.fixturesDir ?? defaultFixturesDir(),
        // Evidence is labelled with the directory version actually requested;
        // the provider cross-checks it against the manifest and fails fast.
        version: config.fixtureVersion ?? process.env.IGTRACK_FIXTURE_VERSION ?? "v1",
      });
      break;
    case "graph":
      // Authorized path: owned Business/Creator account via the official
      // Graph API. Credentials come from env/secret-store only — a missing
      // credential is a fail-fast configuration error, never UNAVAILABLE.
      provider = new GraphProvider(graphConfigFromEnv());
      break;
    case "import": {
      // Lawful real data: the operator's own Instagram export. Missing path
      // or owner username is a configuration error, never UNAVAILABLE —
      // providerFromEnv validates both before reaching here.
      const dir = config.importDir;
      const owner = config.importUsername;
      if (dir === undefined || dir === "" || owner === undefined || owner === "") {
        throw new Error(
          "igtrack worker: import provider requires importDir (IGTRACK_IMPORT_DIR) and importUsername (IGTRACK_IMPORT_USERNAME)",
        );
      }
      provider = new ImportProvider({ importDir: dir, username: owner });
      break;
    }
    case "public":
      // Explicitly opt-in observation of logged-out public pages through a
      // local headless browser. Not the Graph API and never labelled as such:
      // every row is stored under SourceKind.PUBLIC_WEB.
      provider = new PublicWebProvider({
        ...(process.env.IGTRACK_CHROME_PATH !== undefined &&
        process.env.IGTRACK_CHROME_PATH !== ""
          ? { chromePath: process.env.IGTRACK_CHROME_PATH }
          : {}),
        ...(process.env.IGTRACK_PUBLIC_ENRICH_BUDGET_MS !== undefined &&
        process.env.IGTRACK_PUBLIC_ENRICH_BUDGET_MS !== "" &&
        Number.isFinite(Number(process.env.IGTRACK_PUBLIC_ENRICH_BUDGET_MS)) &&
        Number(process.env.IGTRACK_PUBLIC_ENRICH_BUDGET_MS) > 0
          ? { enrichBudgetMs: Number(process.env.IGTRACK_PUBLIC_ENRICH_BUDGET_MS) }
          : {}),
      });
      break;
    case "anonstories":
      // Login-free stories, highlight contents and story mentions through a
      // third-party aggregator, called from a local Chrome page context. The
      // rows are stored under SourceKind.PUBLIC_AGGREGATOR: a relayed
      // third-party answer, never a platform page and never the Graph API.
      provider = new AnonStoriesProvider({
        ...(process.env.IGTRACK_CHROME_PATH !== undefined &&
        process.env.IGTRACK_CHROME_PATH !== ""
          ? { chromePath: process.env.IGTRACK_CHROME_PATH }
          : {}),
        ...(process.env.IGTRACK_ANON_MAX_HIGHLIGHTS !== undefined &&
        process.env.IGTRACK_ANON_MAX_HIGHLIGHTS !== ""
          ? { maxHighlights: Number(process.env.IGTRACK_ANON_MAX_HIGHLIGHTS) }
          : {}),
      });
      break;
    default:
      throw new Error(`igtrack worker: unknown provider "${(config as { name: string }).name}"`);
  }
  return { provider, source: buildSource(provider) };
}

export function defaultFixturesDir(): string {
  // Resolved relative to this module so the worker behaves identically no
  // matter which directory it is started from (repo root, package dir, etc.).
  const version = process.env.IGTRACK_FIXTURE_VERSION ?? "v1";
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "..", "..", "packages", "ingestion", "fixtures", version);
}

export function providerFromEnv(): ExecutionSource {

  const name = process.env.IGTRACK_PROVIDER ?? "fixture";
  // Credential-safety: an unknown provider name or a missing Graph credential
  // is a *configuration* failure, not a provider UNAVAILABLE. The worker must
  // fail fast before any observation is attempted so a missing credential
  // can never be mis-surfaced as an empty dataset.
  if (name === "graph") {
    return createExecutionSource({ name: "graph" });
  }
  if (name === "import") {
    const importDir = process.env.IGTRACK_IMPORT_DIR;
    const importUsername = process.env.IGTRACK_IMPORT_USERNAME;
    if (importDir === undefined || importDir === "") {
      throw new Error(
        "igtrack worker: missing required env IGTRACK_IMPORT_DIR when IGTRACK_PROVIDER=import — point it at your Instagram data-export directory (its root, connections/, or followers_and_following/).",
      );
    }
    if (importUsername === undefined || importUsername === "") {
      throw new Error(
        "igtrack worker: missing required env IGTRACK_IMPORT_USERNAME when IGTRACK_PROVIDER=import — the account the export belongs to (the only account this provider observes).",
      );
    }
    return createExecutionSource({ name: "import", importDir, importUsername });
  }
  if (name === "public") {
    return createExecutionSource({ name: "public" });
  }
  if (name === "anonstories") {
    // Login-free stories/highlight mentions via a third-party aggregator,
    // driven through a local Chrome page context (IGTRACK_CHROME_PATH when
    // the browser is not in a standard location; IGTRACK_ANON_MAX_HIGHLIGHTS
    // bounds the highlight reads per dossier). Rows are PUBLIC_AGGREGATOR.
    return createExecutionSource({ name: "anonstories" });
  }
  if (name !== "fixture") {
    const expected =
      'IGTRACK_PROVIDER=fixture|graph|import|public|anonstories (allowed values: "fixture", "graph", "import", "public", "anonstories"; the Graph API provider requires an owned Business/Creator account + Meta app + token via env: IGTRACK_GRAPH_ACCESS_TOKEN, IGTRACK_GRAPH_IG_USER_ID, IGTRACK_GRAPH_USERNAME; the import provider requires IGTRACK_IMPORT_DIR + IGTRACK_IMPORT_USERNAME; the public provider renders logged-out Instagram pages in a local Chrome, using IGTRACK_CHROME_PATH when the browser is not in a standard location; the anonstories provider reads stories and highlight contents through a third-party aggregator in a local Chrome page context)';
    throw new Error(
      `igtrack worker: no provider implementation for "${name}". Expected ${expected}.`,
    );
  }
  // Operator override, documented in .env.example and `igtrack config`. An
  // empty value is treated as unset so a blank line never silently redirects
  // fixture reads away from the packaged set.
  const fixturesDir = process.env.IGTRACK_FIXTURES_DIR;
  return createExecutionSource({
    name: "fixture",
    fixturesDir:
      fixturesDir !== undefined && fixturesDir !== ""
        ? fixturesDir
        : defaultFixturesDir(),
  });
}

export * from "./executors.js";


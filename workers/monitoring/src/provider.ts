import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureProvider, GraphProvider, graphConfigFromEnv } from "@igtrack/ingestion";
import type { InstagramProvider } from "@igtrack/core";
import { buildSource, type ExecutionSource } from "./executors.js";

export interface ProviderConfig {
  name: "fixture" | "graph";
  fixturesDir?: string;
}

export function createExecutionSource(config: ProviderConfig): ExecutionSource {
  let provider: InstagramProvider;
  switch (config.name) {
    case "fixture":
      provider = new FixtureProvider({
        fixturesDir: config.fixturesDir ?? defaultFixturesDir(),
      });
      break;
    case "graph":
      // Authorized path: owned Business/Creator account via the official
      // Graph API. Credentials come from env/secret-store only — a missing
      // credential is a fail-fast configuration error, never UNAVAILABLE.
      provider = new GraphProvider(graphConfigFromEnv());
      break;
    default:
      throw new Error(`igtrack worker: unknown provider "${config.name}"`);
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
  if (name !== "fixture") {
    const expected =
      'IGTRACK_PROVIDER=fixture|graph (allowed values: "fixture", "graph"; the Graph API provider requires an owned Business/Creator account + Meta app + token via env: IGTRACK_GRAPH_ACCESS_TOKEN, IGTRACK_GRAPH_IG_USER_ID, IGTRACK_GRAPH_USERNAME)';
    throw new Error(
      `igtrack worker: no provider implementation for "${name}". Expected ${expected}.`,
    );
  }
  return createExecutionSource({
    name: "fixture",
    fixturesDir: defaultFixturesDir(),
  });
}

export * from "./executors.js";


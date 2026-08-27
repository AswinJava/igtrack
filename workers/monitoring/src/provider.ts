import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureProvider } from "@igtrack/ingestion";
import type { InstagramProvider } from "@igtrack/core";
import { buildSource, type ExecutionSource } from "./executors.js";

export interface ProviderConfig {
  name: "fixture";
  fixturesDir: string;
}

export function createExecutionSource(config: ProviderConfig): ExecutionSource {
  let provider: InstagramProvider;
  switch (config.name) {
    case "fixture":
      provider = new FixtureProvider({ fixturesDir: config.fixturesDir });
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
  if (name !== "fixture") {
    throw new Error(`igtrack worker: no provider implementation for "${name}"`);
  }
  return createExecutionSource({
    name: "fixture",
    fixturesDir: defaultFixturesDir(),
  });
}

export * from "./executors.js";


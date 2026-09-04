import { join } from "node:path";
import { FixtureProvider, GraphProvider, graphConfigFromEnv } from "@igtrack/ingestion";
import type { InstagramProvider } from "@igtrack/core";

let cached: InstagramProvider | null = null;

export function getProvider(): InstagramProvider {
  if (cached) return cached;
  const name = process.env.IGTRACK_PROVIDER ?? "fixture";
  if (name === "graph") {
    cached = new GraphProvider(graphConfigFromEnv());
    return cached;
  }
  if (name !== "fixture") {
    throw new Error(
      `igtrack web: no provider implementation for "${name}". Expected IGTRACK_PROVIDER=fixture|graph.`,
    );
  }
  const version = process.env.IGTRACK_FIXTURE_VERSION ?? "v1";
  const fixturesDir =
    process.env.IGTRACK_FIXTURES_DIR ??
    join(process.cwd(), "..", "..", "packages", "ingestion", "fixtures", version);
  cached = new FixtureProvider({ fixturesDir });
  return cached;
}

export function resetProviderForTest(): void {
  cached = null;
}

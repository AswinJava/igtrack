import {
  getSourceHealth,
  listProviderMetrics,
  resolveScanIntervals,
  type ScanIntervalConfig,
} from "@igtrack/database";
import type { ProviderCapabilities } from "@igtrack/core";
import { getDatabase } from "./db.js";
import { getProvider } from "./provider.js";

// Secret-free capability self-diagnostic (§33-feed): answers "what can this
// deployment observe, and why" without ever touching credentials. Only env
// key PRESENCE is read for graph config; the access token value is never
// loaded, logged, or returned. Numbers mirror worker defaults; each default
// cites its authoritative source so drift is visible.
export interface CapabilityDiagnostic {
  provider: string;
  sourceId: string | null;
  production: boolean;
  fixtureInProduction: boolean;
  providerError: string | null;
  capabilities: ProviderCapabilities | null;
  fixture: { version: string } | null;
  graph: {
    configured: boolean;
    username: string | null;
    igUserId: string | null;
    apiVersion: string;
  };
  scheduler: {
    tickMs: number;
    batchLimit: number;
    intervalsMs: ScanIntervalConfig;
  };
  worker: { pollMs: number; leaseMs: number; providerTimeoutMs: number };
  sourceHealth: Awaited<ReturnType<typeof getSourceHealth>>;
  metrics: Awaited<ReturnType<typeof listProviderMetrics>>;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function getCapabilityDiagnostic(): Promise<CapabilityDiagnostic> {
  const env = process.env;
  const provider = env.IGTRACK_PROVIDER ?? "fixture";
  const production = env.NODE_ENV === "production";

  let sourceId: string | null = null;
  let capabilities: ProviderCapabilities | null = null;
  let providerError: string | null = null;
  try {
    const instance = getProvider();
    sourceId = instance.sourceId;
    capabilities = instance.capabilities();
  } catch (err) {
    // Unknown provider name or graph without credentials: configuration
    // failure, reported here instead of thrown, still secret-free.
    providerError = err instanceof Error ? err.message : String(err);
  }

  const graphConfigured =
    Boolean(env.IGTRACK_GRAPH_ACCESS_TOKEN) &&
    Boolean(env.IGTRACK_GRAPH_IG_USER_ID) &&
    Boolean(env.IGTRACK_GRAPH_USERNAME);

  let sourceHealth: CapabilityDiagnostic["sourceHealth"] = [];
  let metrics: CapabilityDiagnostic["metrics"] = [];
  try {
    const db = getDatabase();
    [sourceHealth, metrics] = await Promise.all([
      getSourceHealth(db).catch(() => []),
      listProviderMetrics(db).catch(() => []),
    ]);
  } catch {
    // Database unreachable: configuration still reports; health stays empty.
  }

  return {
    provider,
    sourceId,
    production,
    fixtureInProduction: production && provider === "fixture",
    providerError,
    capabilities,
    fixture:
      provider === "fixture"
        ? { version: env.IGTRACK_FIXTURE_VERSION ?? "v1" }
        : null,
    graph: {
      configured: graphConfigured,
      username: env.IGTRACK_GRAPH_USERNAME?.toLowerCase() ?? null,
      igUserId: env.IGTRACK_GRAPH_IG_USER_ID ?? null,
      apiVersion: env.IGTRACK_GRAPH_API_VERSION ?? "v21.0",
    },
    scheduler: {
      // Defaults mirror workers/monitoring/src/scheduler.ts.
      tickMs: positiveInt(env.IGTRACK_SCHEDULER_TICK_MS, 60_000),
      batchLimit: positiveInt(env.IGTRACK_SCHEDULER_BATCH, 200),
      intervalsMs: resolveScanIntervals(env),
    },
    worker: {
      // Defaults mirror workers/monitoring/src/index.ts (poll) and
      // packages/database/src/jobs/queue.ts (lease) + timeout.ts.
      pollMs: positiveInt(env.IGTRACK_JOB_POLL_MS, 5000),
      leaseMs: positiveInt(env.IGTRACK_JOB_LEASE_MS, 300_000),
      providerTimeoutMs: positiveInt(env.IGTRACK_PROVIDER_TIMEOUT_MS, 30_000),
    },
    sourceHealth,
    metrics,
  };
}

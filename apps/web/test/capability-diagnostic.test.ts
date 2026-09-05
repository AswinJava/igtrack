import { afterEach, describe, expect, it } from "vitest";
import { getCapabilityDiagnostic } from "../lib/capability-diagnostic.js";
import { resetProviderForTest } from "../lib/provider.js";

const SENTINEL = "sekret-token-xyz-123";

afterEach(() => {
  delete process.env.IGTRACK_GRAPH_ACCESS_TOKEN;
  delete process.env.IGTRACK_GRAPH_IG_USER_ID;
  delete process.env.IGTRACK_GRAPH_USERNAME;
  resetProviderForTest();
});

describe("capability self-diagnostic", () => {
  it("reports provider identity, capabilities, and config without secrets", async () => {
    process.env.IGTRACK_GRAPH_ACCESS_TOKEN = SENTINEL;
    process.env.IGTRACK_GRAPH_IG_USER_ID = "999";
    process.env.IGTRACK_GRAPH_USERNAME = "owned.account";
    resetProviderForTest();
    const diag = await getCapabilityDiagnostic();
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("sekret");
    expect(diag.graph.configured).toBe(true);
    expect(diag.graph.username).toBe("owned.account");
    expect(diag.provider).toBe(process.env.IGTRACK_PROVIDER ?? "fixture");
    expect(typeof diag.fixtureInProduction).toBe("boolean");
    expect(Array.isArray(diag.sourceHealth)).toBe(true);
    expect(Array.isArray(diag.metrics)).toBe(true);
  });

  it("reports graph as not configured without throwing", async () => {
    resetProviderForTest();
    const diag = await getCapabilityDiagnostic();
    expect(diag.graph.configured).toBe(false);
    expect(diag.providerError).toBeNull();
    expect(diag.capabilities).not.toBeNull();
    expect(Object.keys(diag.capabilities ?? {})).toHaveLength(8);
  });

  it("surfaces scheduler and worker bounds", async () => {
    const diag = await getCapabilityDiagnostic();
    expect(diag.scheduler.tickMs).toBeGreaterThan(0);
    expect(diag.scheduler.batchLimit).toBeGreaterThan(0);
    expect(diag.scheduler.intervalsMs.STORY_SCAN).toBeGreaterThan(0);
    expect(diag.worker.leaseMs).toBeGreaterThan(0);
    expect(diag.worker.providerTimeoutMs).toBeGreaterThan(0);
  });
});

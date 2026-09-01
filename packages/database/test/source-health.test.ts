import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceKind } from "@igtrack/core";
import {
  getSourceHealth,
  markCapabilityUnavailable,
  recordCapabilityFailure,
  recordCapabilitySuccess,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
} as const;

describe.runIf(available)("source health", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("records success as HEALTHY", async () => {
    const row = await recordCapabilitySuccess(handle.db, {
      source: SOURCE,
      capability: "getProfile",
      latencyMs: 42,
    });
    expect(row.status).toBe("HEALTHY");
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    expect(row.latencyMs).toBe(42);
  });

  it("counts consecutive failures and degrades", async () => {
    await recordCapabilityFailure(handle.db, {
      source: SOURCE,
      capability: "getStories",
      reason: "timeout",
      errorCategory: "NETWORK",
    });
    const second = await recordCapabilityFailure(handle.db, {
      source: SOURCE,
      capability: "getStories",
      reason: "timeout again",
      errorCategory: "NETWORK",
    });
    expect(second.status).toBe("DEGRADED");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.lastFailureReason).toBe("timeout again");
  });

  it("resets failure streak on success", async () => {
    const row = await recordCapabilitySuccess(handle.db, {
      source: SOURCE,
      capability: "getStories",
    });
    expect(row.status).toBe("HEALTHY");
    expect(row.consecutiveFailures).toBe(0);
  });

  it("keeps UNAVAILABLE distinct from empty results", async () => {
    const row = await markCapabilityUnavailable(handle.db, {
      source: SOURCE,
      capability: "getLikesHistory",
      coverageNote:
        "Instagram does not expose a complete public feed of everything an account liked.",
    });
    expect(row.status).toBe("UNAVAILABLE");
    expect(row.coverageNote).toContain("does not expose");

    const health = await getSourceHealth(handle.db, "fixture:v1");
    const likes = health.find((h) => h.capability === "getLikesHistory");
    expect(likes?.status).toBe("UNAVAILABLE");
    expect(health.map((h) => h.capability).sort()).toEqual([
      "getLikesHistory",
      "getProfile",
      "getStories",
    ]);
  });

  // STEP 15 (Phase 10): authorization lifecycle. Revocation must surface as a
  // FORBIDDEN/AUTH_REQUIRED failure that degrades health — a stale HEALTHY must
  // never survive a known authorization loss — and recovery (re-authorization)
  // must restore HEALTHY. UNAVAILABLE stays reserved for capability gaps.
  it("revoked authorization degrades health; recovery restores it (PH10-R1)", async () => {
    // healthy baseline for the capability
    await recordCapabilitySuccess(handle.db, {
      source: SOURCE,
      capability: "getFollowers",
    });
    // authorization revoked → provider answers FORBIDDEN
    const revoked = await recordCapabilityFailure(handle.db, {
      source: SOURCE,
      capability: "getFollowers",
      reason: "authorization revoked",
      errorCategory: "FORBIDDEN",
    });
    expect(revoked.status).toBe("DEGRADED");
    expect(revoked.errorCategory).toBe("FORBIDDEN");
    expect(revoked.consecutiveFailures).toBe(1);

    // re-authorization → recovery
    const recovered = await recordCapabilitySuccess(handle.db, {
      source: SOURCE,
      capability: "getFollowers",
    });
    expect(recovered.status).toBe("HEALTHY");
    expect(recovered.consecutiveFailures).toBe(0);

    const health = await getSourceHealth(handle.db, SOURCE.id);
    const followers = health.find((h) => h.capability === "getFollowers");
    expect(followers?.status).toBe("HEALTHY");
  });
});

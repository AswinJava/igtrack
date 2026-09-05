import { describe, expect, it } from "vitest";
import { targetSyncState } from "../lib/sync-state.js";

const T0 = new Date("2026-08-27T12:00:00.000Z");
const FRESH = new Date("2026-08-27T18:00:00.000Z");
const OLD = new Date("2026-08-20T12:00:00.000Z");

function base() {
  return {
    status: "ACTIVE",
    latestJobStatus: "succeeded",
    latestJobOutcome: "COMPLETED",
    latestJobCompletedAt: T0,
    lastObserved: T0,
    now: FRESH,
  };
}

describe("target sync state", () => {
  it("reports PAUSED for paused and stopped targets", () => {
    expect(targetSyncState({ ...base(), status: "PAUSED" }).state).toBe("PAUSED");
    expect(targetSyncState({ ...base(), status: "STOPPED" }).state).toBe("PAUSED");
  });

  it("reports SYNCING while a job is queued, running, or waiting", () => {
    for (const s of ["queued", "running", "retry_wait"]) {
      expect(targetSyncState({ ...base(), latestJobStatus: s }).state).toBe("SYNCING");
    }
  });

  it("reports FAILED on terminal failure without touching history claims", () => {
    const r = targetSyncState({ ...base(), latestJobStatus: "failed" });
    expect(r.state).toBe("FAILED");
    expect(r.detail).toMatch(/preserved/);
  });

  it("reports UNAVAILABLE and PARTIAL from job outcomes", () => {
    expect(
      targetSyncState({ ...base(), latestJobOutcome: "UNAVAILABLE" }).state,
    ).toBe("UNAVAILABLE");
    expect(
      targetSyncState({ ...base(), latestJobOutcome: "COMPLETED_PARTIAL" }).state,
    ).toBe("PARTIAL");
  });

  it("reports SYNCED when fresh and STALE when old or never synced", () => {
    expect(targetSyncState(base()).state).toBe("SYNCED");
    expect(
      targetSyncState({ ...base(), latestJobCompletedAt: OLD, lastObserved: OLD }).state,
    ).toBe("STALE");
    expect(
      targetSyncState({
        ...base(),
        latestJobCompletedAt: null,
        lastObserved: null,
      }).state,
    ).toBe("STALE");
  });
});

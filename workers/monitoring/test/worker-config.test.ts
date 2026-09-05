import { describe, expect, it } from "vitest";
import { validateWorkerEnv } from "../src/config.js";

describe("worker startup configuration guard", () => {
  it("accepts an empty environment (all defaults apply)", () => {
    expect(validateWorkerEnv({})).toEqual([]);
  });

  it("accepts sane positive values", () => {
    expect(
      validateWorkerEnv({
        IGTRACK_JOB_LEASE_MS: "300000",
        IGTRACK_JOB_POLL_MS: "5000",
        IGTRACK_PROVIDER_TIMEOUT_MS: "30000",
        IGTRACK_SCHEDULER_TICK_MS: "60000",
        IGTRACK_JOB_MAX_ITER: "25",
      }),
    ).toEqual([]);
  });

  it("rejects zero, negative, and non-numeric lease values", () => {
    for (const value of ["0", "-1", "NaN", "abc", ""]) {
      if (value === "") continue;
      const errors = validateWorkerEnv({ IGTRACK_JOB_LEASE_MS: value });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/IGTRACK_JOB_LEASE_MS/);
    }
  });

  it("rejects dangerous poll, timeout, tick, and iteration values", () => {
    expect(validateWorkerEnv({ IGTRACK_JOB_POLL_MS: "0" })).toHaveLength(1);
    expect(validateWorkerEnv({ IGTRACK_PROVIDER_TIMEOUT_MS: "-5" })).toHaveLength(1);
    expect(validateWorkerEnv({ IGTRACK_SCHEDULER_TICK_MS: "never" })).toHaveLength(1);
    expect(validateWorkerEnv({ IGTRACK_JOB_MAX_ITER: "0" })).toHaveLength(1);
  });

  it("reports every bad key in one pass", () => {
    const errors = validateWorkerEnv({
      IGTRACK_JOB_LEASE_MS: "0",
      IGTRACK_JOB_POLL_MS: "0",
    });
    expect(errors).toHaveLength(2);
  });
});

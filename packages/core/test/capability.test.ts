import { describe, expect, it } from "vitest";
import {
  available,
  CapabilityErrorKind,
  CapabilityStatus,
  Confidence,
  errored,
  isUsable,
  partial,
  SourceKind,
  unavailable,
} from "../src/index.js";

const source = { sourceId: "test", kind: SourceKind.FIXTURE };
const meta = { observedAt: "2026-08-27T00:00:00.000Z", source };

describe("CapabilityResult constructors", () => {
  it("available carries data and confidence", () => {
    const result = available({ n: 1 }, { ...meta, confidence: Confidence.HIGH });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data).toEqual({ n: 1 });
    expect(result.confidence).toBe(Confidence.HIGH);
    expect(isUsable(result)).toBe(true);
  });

  it("partial carries data plus a note", () => {
    const result = partial(
      ["a"],
      { ...meta, confidence: Confidence.MEDIUM, note: "first page only" },
    );
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.note).toBe("first page only");
    expect(isUsable(result)).toBe(true);
  });

  it("unavailable has no data and UNKNOWN confidence", () => {
    const result = unavailable(meta, "not exposed by platform");
    expect(result.status).toBe(CapabilityStatus.UNAVAILABLE);
    expect(result.data).toBeUndefined();
    expect(result.confidence).toBe(Confidence.UNKNOWN);
    expect(result.note).toBe("not exposed by platform");
    expect(isUsable(result)).toBe(false);
  });

  it("errored carries a typed error", () => {
    const result = errored(meta, {
      kind: CapabilityErrorKind.RATE_LIMITED,
      message: "slow down",
      retryable: true,
    });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.error?.retryable).toBe(true);
    expect(isUsable(result)).toBe(false);
  });
});

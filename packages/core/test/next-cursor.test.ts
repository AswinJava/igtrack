import { describe, expect, it } from "vitest";
import { available, partial } from "../src/capability.js";
import { Confidence, SourceKind } from "../src/index.js";

const meta = {
  observedAt: "2026-08-27T09:15:00.000Z",
  source: { sourceId: "stub:t", kind: SourceKind.FIXTURE },
  confidence: Confidence.HIGH,
};

describe("capability continuation cursors", () => {
  it("available() passes nextCursor through when present", () => {
    const r = available([1], { ...meta, nextCursor: "abc" });
    expect(r.nextCursor).toBe("abc");
  });

  it("available() omits the key when the listing is complete", () => {
    const r = available([1], meta);
    expect("nextCursor" in r).toBe(false);
  });

  it("partial() carries the cursor for resumption", () => {
    const r = partial([1], { ...meta, note: "more", nextCursor: "n-2" });
    expect(r.status).toBe("PARTIAL");
    expect(r.nextCursor).toBe("n-2");
  });
});

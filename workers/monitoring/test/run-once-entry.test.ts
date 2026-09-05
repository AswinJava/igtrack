import { describe, expect, it } from "vitest";
import { isDirectlyInvoked } from "../src/run-once.js";

describe("run-once entry detection", () => {
  it("detects direct invocation on posix paths", () => {
    expect(isDirectlyInvoked("/app/work/run-once.ts", "file:///app/work/run-once.ts")).toBe(true);
    expect(isDirectlyInvoked("/app/work/other.ts", "file:///app/work/run-once.ts")).toBe(false);
    expect(isDirectlyInvoked(undefined, "file:///app/work/run-once.ts")).toBe(false);
  });

  it("detects direct invocation on Windows paths (no silent no-op)", () => {
    // The old implementation compared `file://` + argv against import.meta.url
    // and never matched on Windows (`file://C:/` vs `file:///C:/`), so the
    // script exited 0 having done nothing.
    expect(
      isDirectlyInvoked("C:\\repo\\workers\\monitoring\\src\\run-once.ts", "file:///C:/repo/workers/monitoring/src/run-once.ts"),
    ).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY,
  capabilityMatrixSummary,
  isCapabilityAvailable,
  renderCapabilityMatrixDocument,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The published capability matrix is a promise to users and to agents. It is
// generated from the registry, and this test fails when the committed file is
// stale — so "we only claim what we can observe" is enforced by CI rather than
// by good intentions.
// ---------------------------------------------------------------------------

const MATRIX_PATH = fileURLToPath(
  new URL("../../../docs/CAPABILITIES.md", import.meta.url),
);

describe("capability matrix document", () => {
  it("is in sync with the registry", () => {
    const committed = readFileSync(MATRIX_PATH, "utf8");
    expect(committed).toBe(renderCapabilityMatrixDocument());
  });

  it("states the same totals the registry reports", () => {
    const summary = capabilityMatrixSummary();
    expect(summary.total).toBe(CAPABILITY_REGISTRY.length);
    expect(summary.available + summary.unavailable).toBe(summary.total);
    const committed = readFileSync(MATRIX_PATH, "utf8");
    expect(committed).toContain(
      `${summary.available} of ${summary.total} capabilities are obtainable`,
    );
  });

  it("gives every unavailable capability a reason in the document", () => {
    const committed = readFileSync(MATRIX_PATH, "utf8");
    for (const entry of CAPABILITY_REGISTRY.filter((e) => !isCapabilityAvailable(e))) {
      expect(entry.whyUnavailable).not.toBeNull();
      expect(committed).toContain(entry.label);
      // The reason must survive into the published text, not just the registry.
      const firstClaim = (entry.whyUnavailable ?? "").split(". ")[0] ?? "";
      expect(committed).toContain(firstClaim.replace(/\s+/g, " ").trim().slice(0, 60));
    }
  });

  it("never lists a provider method for a capability the registry calls unavailable", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      if (entry.whyUnavailable !== null) {
        expect(entry.providerMethods).toHaveLength(0);
      }
    }
  });
});

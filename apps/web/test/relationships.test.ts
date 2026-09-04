import { describe, expect, it } from "vitest";
import {
  relationshipBand,
  describeRelationshipSignals,
} from "../lib/relationships.js";

describe("relationship evidence bands (Phase 15 honesty pass)", () => {
  it("never labels few signals as strong", () => {
    expect(relationshipBand(1).label).toBe("Limited evidence");
    expect(relationshipBand(2).label).toBe("Limited evidence");
    expect(relationshipBand(1).label.toLowerCase()).not.toContain("strong");
    expect(relationshipBand(2).label.toLowerCase()).not.toContain("strong");
  });

  it("reserves the highest band for three or more signals", () => {
    expect(relationshipBand(3).label).toBe("Higher observed activity");
    expect(relationshipBand(10).label).toBe("Higher observed activity");
    expect(relationshipBand(3).label.toLowerCase()).not.toContain("favourite");
    expect(relationshipBand(3).label.toLowerCase()).not.toContain("favorite");
  });

  it("marks zero signals as insufficient, never weak-by-character", () => {
    expect(relationshipBand(0).label).toBe("Insufficient evidence");
  });

  it("exposes raw signal counts without interpretation", () => {
    expect(describeRelationshipSignals({ mentions: 2, deltas: 1 })).toBe(
      "Mentions 2 · Follow signals 1",
    );
  });
});

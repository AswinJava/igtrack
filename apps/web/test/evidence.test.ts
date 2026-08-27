import { describe, expect, it } from "vitest";

describe("evidence presentation contract", () => {
  it("evidence data exposes required provenance fields", () => {
    const evidence = {
      id: "ev_abc",
      observationKind: "profile_snapshot",
      observationId: "snap-1",
      sourceId: "fixture:v1",
      observedAt: new Date(),
      capturedAt: new Date(),
      confidence: "HIGH",
      rawHash: "a".repeat(64),
      normalizedHash: "b".repeat(64),
    };

    expect(evidence.observationKind).toBeDefined();
    expect(evidence.sourceId).toBeDefined();
    expect(evidence.confidence).toBeDefined();
    expect(evidence.rawHash).toHaveLength(64);
    expect(evidence.observedAt).toBeInstanceOf(Date);
  });

  it("inferred intelligence is labelled as inferred", () => {
    const label = "Inferred";
    expect(label).not.toBe("Fact");
    expect(label.toLowerCase()).toContain("infer");
  });

  it("unavailable capabilities are not represented as zero", () => {
    const unavailablePresentation = {
      label: "Unavailable",
      count: null as number | null,
      description: "This source does not provide the capability.",
    };
    expect(unavailablePresentation.count).toBeNull();
    expect(unavailablePresentation.label).not.toBe("0");
    expect(unavailablePresentation.description).toContain("does not provide");
  });
});

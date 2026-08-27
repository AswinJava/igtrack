import { describe, expect, it } from "vitest";
import { presentCapability, capabilityToneClasses } from "../lib/capability.js";

describe("capability presentation", () => {
  it("keeps AVAILABLE/PARTIAL/UNAVAILABLE/ERROR distinct", () => {
    const avail = presentCapability("AVAILABLE");
    const partial = presentCapability("PARTIAL");
    const unavailable = presentCapability("UNAVAILABLE");
    const error = presentCapability("ERROR");

    expect(avail.label).not.toBe(partial.label);
    expect(unavailable.label).not.toBe(partial.label);
    expect(error.label).not.toBe(avail.label);

    expect(avail.tone).toBe("success");
    expect(partial.tone).toBe("warning");
    expect(unavailable.tone).toBe("muted");
    expect(error.tone).toBe("danger");

    expect(avail.description).not.toBe(unavailable.description);
  });

  it("never collapses unavailable into zero", () => {
    const unavailable = presentCapability("UNAVAILABLE");
    expect(unavailable.description.toLowerCase()).toContain("does not provide");
    expect(unavailable.label).not.toBe("0");
    expect(unavailable.label).not.toBe("Empty");
  });

  it("maps tones to distinct classes", () => {
    const tones = ["success", "warning", "muted", "danger"] as const;
    const classes = tones.map((t) => capabilityToneClasses(t));
    expect(new Set(classes).size).toBe(tones.length);
  });
});

import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY, CapabilityName } from "@igtrack/core";
import * as schema from "../src/schema/index.js";

// capabilities.ts claims every registry entry names real InstagramProvider
// methods and real schema exports. This test makes that claim executable:
// the registry can no longer drift from the interface or the tables without
// a red test.
describe("capability registry consistency", () => {
  it("names only real InstagramProvider methods", () => {
    const methods = new Set<string>(Object.values(CapabilityName));
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      for (const method of cap.providerMethods) {
        expect(
          methods.has(method),
          `${cap.id} names unknown provider method "${method}"`,
        ).toBe(true);
      }
    }
  });

  it("names only real schema exports", () => {
    const exports = new Set(Object.keys(schema));
    for (const cap of Object.values(CAPABILITY_REGISTRY)) {
      for (const table of cap.persistence) {
        expect(
          exports.has(table),
          `${cap.id} names unknown schema export "${table}"`,
        ).toBe(true);
      }
    }
  });
});

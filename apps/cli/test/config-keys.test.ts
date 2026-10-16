import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../src/commands/setup.js";

// Drift regression (2026-10-16): the `import` provider's two variables were
// read by providerFromEnv and documented in .env.example, but missing from
// `igtrack config`'s reference table — the command claimed to show "the
// resolved values of the core variables" while silently omitting a whole
// provider's configuration. Keep every runtime provider var listed.
describe("config command reference table", () => {
  it("lists the import provider's variables alongside every other runtime var", () => {
    const keys = CONFIG_KEYS.map((entry) => entry.key);
    expect(keys).toContain("IGTRACK_PROVIDER");
    expect(keys).toContain("IGTRACK_FIXTURES_DIR");
    expect(keys).toContain("IGTRACK_IMPORT_DIR");
    expect(keys).toContain("IGTRACK_IMPORT_USERNAME");
  });

  it("has no duplicate rows and no empty meanings", () => {
    const keys = CONFIG_KEYS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of CONFIG_KEYS) {
      expect(entry.meaning.length).toBeGreaterThan(0);
    }
  });
});

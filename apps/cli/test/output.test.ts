import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY } from "@igtrack/core";
import {
  capabilityLines,
  display,
  errorEnvelope,
  envelope,
  flagBool,
  flagNumber,
  flagString,
  parseArgs,
  parseSince,
  table,
  UsageError,
} from "../src/output.js";
import { parseEnvFile, redactEnvValue } from "../src/env.js";

describe("argument parsing", () => {
  it("separates the command, positionals and flags", () => {
    const parsed = parseArgs(["scans", "run", "--target", "abc", "--force"]);
    expect(parsed.command).toBe("scans");
    expect(parsed.positionals).toEqual(["run"]);
    expect(parsed.flags["target"]).toBe("abc");
    expect(parsed.flags["force"]).toBe(true);
  });

  it("supports --flag=value and short flags", () => {
    const parsed = parseArgs(["activity", "--limit=5", "-t", "x"]);
    expect(parsed.flags["limit"]).toBe("5");
    expect(parsed.flags["t"]).toBe("x");
  });

  it("treats a flag followed by another flag as boolean", () => {
    const parsed = parseArgs(["work", "--json", "--max"]);
    expect(parsed.flags["json"]).toBe(true);
    expect(parsed.flags["max"]).toBe(true);
  });

  it("defaults to help with no arguments", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("reads typed flag values and rejects non-numeric numbers", () => {
    const flags = parseArgs(["--limit", "7", "--name", "n", "--force"]).flags;
    expect(flagNumber(flags, "limit", 30)).toBe(7);
    expect(flagNumber(flags, "missing", 30)).toBe(30);
    expect(flagString(flags, "name")).toBe("n");
    expect(flagString(flags, "force")).toBeUndefined();
    expect(flagBool(flags, "force")).toBe(true);
    expect(flagBool(flags, "missing")).toBe(false);
    expect(() => flagNumber(flags, "name", 1)).toThrow(UsageError);
  });
});

describe("absence is rendered as absence", () => {
  it("never renders a null count as zero", () => {
    expect(display(null)).toBe("unavailable");
    expect(display(undefined)).toBe("unavailable");
    expect(display(0)).toBe("0");
    expect(display([])).toBe("none");
    expect(display("")).toBe("(empty)");
  });

  it("prints (none) for an empty table", () => {
    expect(table(["a", "b"], [])).toBe("(none)");
  });
});

describe("time parsing", () => {
  it("accepts durations", () => {
    const since = parseSince("7d");
    expect(since).not.toBeNull();
    const deltaMs = Date.now() - (since as Date).getTime();
    expect(Math.abs(deltaMs - 7 * 86_400_000)).toBeLessThan(5_000);
  });

  it("accepts ISO timestamps and rejects nonsense", () => {
    expect(parseSince("2026-08-01T00:00:00.000Z")?.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(parseSince(undefined)).toBeNull();
    expect(() => parseSince("last tuesday")).toThrow(UsageError);
  });
});

describe("envelopes", () => {
  it("marks ok and error shapes distinctly", () => {
    const ok = envelope({ n: 1 }, {
      provider: "fixture",
      sourceId: "fixture:v1",
      synthetic: true,
      production: false,
      studio: "cli",
      generatedAt: "2026-10-15T00:00:00.000Z",
    });
    expect(ok.ok).toBe(true);
    expect(ok._meta.synthetic).toBe(true);
    const bad = errorEnvelope("USAGE", "nope");
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("USAGE");
  });
});

describe("capability honesty", () => {
  it("reports a capability with no source at all as unavailable", () => {
    for (const line of capabilityLines()) {
      const entry = CAPABILITY_REGISTRY.find((e) => e.id === line.id);
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      // "No platform method" and "no source at all" are different facts: the
      // claims ledger has no provider route and is still available because the
      // operator supplies its rows (FOUNDING §18, D70); the research engine
      // has no provider route and is available because the engine itself is
      // the bounded, lawful source (D69).
      const hasSource =
        entry.providerMethods.length > 0 ||
        entry.operatorSupplied === true ||
        entry.engineSupplied === true;
      if (!hasSource) {
        expect(line.available).toBe(false);
      }
      if (line.available === false) {
        // Unavailability must always carry a reason. A bare "no" is a bug.
        expect(line.why === null || line.why.length > 0).toBe(true);
      }
    }
    const claimsLedger = capabilityLines().find((l) => l.id === "ACCOUNT_RESEARCH");
    expect(claimsLedger?.available).toBe(true);
    // The research engine is available (the pipeline is real and tested) while
    // its live search adapter stays honestly NOT_VERIFIED (D69).
    const webResearch = capabilityLines().find((l) => l.id === "WEB_RESEARCH");
    expect(webResearch?.available).toBe(true);
  });
});

describe("env loading", () => {
  it("parses key=value, export prefixes, quotes and comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "PLAIN=value",
        "export EXPORTED=other",
        'QUOTED="a b"',
        "SINGLE='c d'",
        "EMPTY=",
        "not a pair",
      ].join("\n"),
    );
    expect(parsed["PLAIN"]).toBe("value");
    expect(parsed["EXPORTED"]).toBe("other");
    expect(parsed["QUOTED"]).toBe("a b");
    expect(parsed["SINGLE"]).toBe("c d");
    expect(parsed["EMPTY"]).toBe("");
    expect(Object.keys(parsed)).toHaveLength(5);
  });

  it("redacts credentials but keeps their shape", () => {
    expect(
      redactEnvValue("DATABASE_URL", "postgresql://user:secret@localhost:5432/db"),
    ).toBe("postgresql://user:***@localhost:5432/db");
    expect(redactEnvValue("IGTRACK_GRAPH_ACCESS_TOKEN", "abc123")).toBe("(set)");
    expect(redactEnvValue("IGTRACK_PROVIDER", "fixture")).toBe("fixture");
    expect(redactEnvValue("IGTRACK_PROVIDER", undefined)).toBe("(unset)");
    expect(redactEnvValue("DATABASE_URL", "not-a-url")).toBe("(set, unparsable)");
  });
});

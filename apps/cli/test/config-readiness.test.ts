import { describe, expect, it } from "vitest";
import {
  ConfigState,
  assessReadiness,
  graphConfigBlocker,
  graphConfigFromEnv,
  isBlocking,
  looksLikePlaceholder,
} from "@igtrack/ingestion";

// ---------------------------------------------------------------------------
// Regression: "are the credentials set?" is not "can these credentials work?".
//
// Before this existed, `igtrack doctor` answered the easy question and the
// operator heard the important one — a fresh checkout with three literal
// `PASTE_..._HERE` markers read as a ready deployment. Same class of lie as
// drawing absence as zero.
//
// Everything here is local: no network request, no database, no value printed.
// ---------------------------------------------------------------------------

/** The exact markers a fresh `.env` ships with. */
const PLACEHOLDER_TOKEN = "PASTE_LONG_LIVED_TOKEN_HERE";
const PLACEHOLDER_USER_ID = "PASTE_IG_USER_ID_HERE";
const PLACEHOLDER_USERNAME = "PASTE_OWNED_USERNAME_HERE";

/** Structurally ordinary values that must clear every local check. */
const REALISTIC = {
  IGTRACK_PROVIDER: "graph",
  IGTRACK_GRAPH_ACCESS_TOKEN: "EAAG1i0Xn2Kp4Qr7St0Uv3Wx6Yz9Ab1Cd3Ef",
  IGTRACK_GRAPH_IG_USER_ID: "17841400000000002",
  IGTRACK_GRAPH_USERNAME: "dune.harbor",
};

function stateOf(env: Record<string, string | undefined>, name: string): string {
  const row = assessReadiness(env).variables.find((v) => v.name === name);
  if (row === undefined) throw new Error(`no assessment row for ${name}`);
  return row.state;
}

describe("placeholder detection", () => {
  it("recognizes the markers the example file ships, in any case and with surrounding whitespace", () => {
    for (const raw of [
      PLACEHOLDER_TOKEN,
      PLACEHOLDER_USER_ID,
      PLACEHOLDER_USERNAME,
      PLACEHOLDER_TOKEN.toLowerCase(),
      `  ${PLACEHOLDER_USER_ID}  `,
      `paste_owned_username_here`,
      `PASTE_YOUR_TOKEN_HERE`,
    ]) {
      expect(looksLikePlaceholder(raw), raw).toBe(true);
    }
  });

  it("recognizes bracket-wrapped and filler markers", () => {
    expect(looksLikePlaceholder("<YOUR_ACCESS_TOKEN>")).toBe(true);
    expect(looksLikePlaceholder("{TOKEN}")).toBe(true);
    expect(looksLikePlaceholder("xxxx")).toBe(true);
    expect(looksLikePlaceholder("000000")).toBe(true);
    expect(looksLikePlaceholder("host.invalid")).toBe(true);
  });

  it("does not flag real-shaped values, or handles that merely start like a marker", () => {
    for (const real of [
      REALISTIC.IGTRACK_GRAPH_ACCESS_TOKEN,
      REALISTIC.IGTRACK_GRAPH_IG_USER_ID,
      REALISTIC.IGTRACK_GRAPH_USERNAME,
      "pastel", // a brandable handle is not `PASTE_..._HERE`
      "your_brand", // one separator, not a sentence-shaped stub
      "",
    ]) {
      expect(looksLikePlaceholder(real), real).toBe(false);
    }
  });
});

describe("graph configuration states", () => {
  it("1. reports every required credential MISSING when the graph provider has none", () => {
    const readiness = assessReadiness({ IGTRACK_PROVIDER: "graph" });
    expect(readiness.status).toBe(ConfigState.MISSING);
    expect(readiness.graphCredentialsRequired).toBe(true);
    for (const name of [
      "IGTRACK_GRAPH_ACCESS_TOKEN",
      "IGTRACK_GRAPH_IG_USER_ID",
      "IGTRACK_GRAPH_USERNAME",
    ]) {
      const row = readiness.variables.find((v) => v.name === name);
      expect(row?.state, name).toBe(ConfigState.MISSING);
      expect(row?.required, name).toBe(true);
      expect(row?.action.length, name).toBeGreaterThan(0);
    }
    expect(isBlocking(readiness.status)).toBe(true);
  });

  it("2/3/4. reports each literal placeholder as PLACEHOLDER, one variable at a time", () => {
    const cases: Array<[string, string]> = [
      ["IGTRACK_GRAPH_ACCESS_TOKEN", PLACEHOLDER_TOKEN],
      ["IGTRACK_GRAPH_IG_USER_ID", PLACEHOLDER_USER_ID],
      ["IGTRACK_GRAPH_USERNAME", PLACEHOLDER_USERNAME],
    ];
    for (const [name, value] of cases) {
      const env = { ...REALISTIC, [name]: value };
      expect(stateOf(env, name), name).toBe(ConfigState.PLACEHOLDER);
      // The other two are untouched, so the worst required state is PLACEHOLDER.
      expect(assessReadiness(env).status, name).toBe(ConfigState.PLACEHOLDER);
    }
  });

  it("2/3/4. reports all three placeholders at once, as a fresh checkout does", () => {
    const env = {
      IGTRACK_PROVIDER: "graph",
      IGTRACK_GRAPH_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
      IGTRACK_GRAPH_IG_USER_ID: PLACEHOLDER_USER_ID,
      IGTRACK_GRAPH_USERNAME: PLACEHOLDER_USERNAME,
    };
    const readiness = assessReadiness(env);
    expect(readiness.status).toBe(ConfigState.PLACEHOLDER);
    expect(isBlocking(readiness.status)).toBe(true);
    expect(readiness.problems.length).toBe(3);
    for (const p of readiness.problems) expect(p).toContain("is PLACEHOLDER");
  });

  it("5. reports ordinary-looking values as NOT_VERIFIED — never as valid", () => {
    const readiness = assessReadiness(REALISTIC);
    expect(readiness.status).toBe(ConfigState.NOT_VERIFIED);
    expect(isBlocking(readiness.status)).toBe(false);
    expect(readiness.variables.every((v) => v.state === ConfigState.NOT_VERIFIED)).toBe(true);
    expect(readiness.networkCallMade).toBe(false);
    expect(graphConfigBlocker(REALISTIC)).toBeNull();
    // "Verified" would be a lie no local check can back.
    expect(JSON.stringify(readiness)).not.toMatch(/"VALID"|"VERIFIED_OK"/);
  });

  it("does not silently accept a structurally impossible value", () => {
    expect(stateOf({ ...REALISTIC, IGTRACK_GRAPH_IG_USER_ID: "not-a-numeric-id" }, "IGTRACK_GRAPH_IG_USER_ID")).toBe(
      ConfigState.INVALID_CONFIGURATION,
    );
    expect(
      stateOf({ ...REALISTIC, IGTRACK_GRAPH_USERNAME: "Not A Handle!" }, "IGTRACK_GRAPH_USERNAME"),
    ).toBe(ConfigState.INVALID_CONFIGURATION);
    expect(
      stateOf({ ...REALISTIC, IGTRACK_GRAPH_ACCESS_TOKEN: "token with spaces" }, "IGTRACK_GRAPH_ACCESS_TOKEN"),
    ).toBe(ConfigState.INVALID_CONFIGURATION);
    expect(assessReadiness({ ...REALISTIC, IGTRACK_PROVIDER: "grah" }).status).toBe(
      ConfigState.INVALID_CONFIGURATION,
    );
  });

  it("treats the Business Discovery opt-in as optional, and refuses anything but the documented values", () => {
    expect(stateOf(REALISTIC, "IGTRACK_GRAPH_BUSINESS_DISCOVERY")).toBe(ConfigState.NOT_VERIFIED);
    expect(stateOf({ ...REALISTIC, IGTRACK_GRAPH_BUSINESS_DISCOVERY: "1" }, "IGTRACK_GRAPH_BUSINESS_DISCOVERY")).toBe(
      ConfigState.NOT_VERIFIED,
    );
    expect(stateOf({ ...REALISTIC, IGTRACK_GRAPH_BUSINESS_DISCOVERY: "0" }, "IGTRACK_GRAPH_BUSINESS_DISCOVERY")).toBe(
      ConfigState.NOT_VERIFIED,
    );
    // `true` looks enabled to a person but leaves the route switched off —
    // reported instead of accepted.
    expect(
      stateOf({ ...REALISTIC, IGTRACK_GRAPH_BUSINESS_DISCOVERY: "true" }, "IGTRACK_GRAPH_BUSINESS_DISCOVERY"),
    ).toBe(ConfigState.INVALID_CONFIGURATION);
    // Optional: a wrong opt-in value never blocks the core credentials.
    expect(assessReadiness({ ...REALISTIC, IGTRACK_GRAPH_BUSINESS_DISCOVERY: "true" }).status).toBe(
      ConfigState.NOT_VERIFIED,
    );
  });
});

describe("graphConfigFromEnv refuses what cannot work", () => {
  it("throws naming every missing variable instead of building a credential-less provider", () => {
    let message = "";
    try {
      graphConfigFromEnv({ IGTRACK_PROVIDER: "graph" });
      throw new Error("should have thrown");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("IGTRACK_GRAPH_ACCESS_TOKEN is MISSING");
    expect(message).toContain("IGTRACK_GRAPH_IG_USER_ID is MISSING");
    expect(message).toContain("IGTRACK_GRAPH_USERNAME is MISSING");
    expect(message).toContain("no API request was made");
  });

  it("throws on the literal placeholders — presence is not validity", () => {
    const env = {
      IGTRACK_PROVIDER: "graph",
      IGTRACK_GRAPH_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
      IGTRACK_GRAPH_IG_USER_ID: PLACEHOLDER_USER_ID,
      IGTRACK_GRAPH_USERNAME: PLACEHOLDER_USERNAME,
    };
    expect(() => graphConfigFromEnv(env)).toThrow(/PLACEHOLDER/);
    // Nothing falls back to a fixture configuration: the call throws, it does
    // not quietly hand back some other provider's data.
    expect(graphConfigBlocker(env)).not.toBeNull();
  });

  it("11. never returns a usable config while a required value is missing or a placeholder", () => {
    for (const env of [
      { IGTRACK_PROVIDER: "graph" },
      { ...REALISTIC, IGTRACK_GRAPH_ACCESS_TOKEN: PLACEHOLDER_TOKEN },
      { ...REALISTIC, IGTRACK_GRAPH_USERNAME: "  " },
    ]) {
      let threw = false;
      try {
        graphConfigFromEnv(env);
      } catch {
        threw = true;
      }
      expect(threw, JSON.stringify(env)).toBe(true);
    }
  });

  it("returns the configuration unchanged once every local check passes", () => {
    const config = graphConfigFromEnv(REALISTIC);
    expect(config.accessToken).toBe(REALISTIC.IGTRACK_GRAPH_ACCESS_TOKEN);
    expect(config.igUserId).toBe(REALISTIC.IGTRACK_GRAPH_IG_USER_ID);
    expect(config.username).toBe(REALISTIC.IGTRACK_GRAPH_USERNAME.toLowerCase());
    expect(config.businessDiscovery).toBeUndefined();
    expect(
      graphConfigFromEnv({ ...REALISTIC, IGTRACK_GRAPH_BUSINESS_DISCOVERY: "1" }).businessDiscovery,
    ).toBe(true);
  });
});

describe("10. no credential value ever reaches an error or an assessment", () => {
  it("names variables and fixes only", () => {
    const env = {
      IGTRACK_PROVIDER: "graph",
      IGTRACK_GRAPH_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
      IGTRACK_GRAPH_IG_USER_ID: PLACEHOLDER_USER_ID,
      IGTRACK_GRAPH_USERNAME: PLACEHOLDER_USERNAME,
    };
    const readiness = assessReadiness(env);
    const rendered = `${JSON.stringify(readiness)}|${graphConfigBlocker(env) ?? ""}`;
    for (const secret of [PLACEHOLDER_TOKEN, PLACEHOLDER_USER_ID, PLACEHOLDER_USERNAME]) {
      expect(rendered).not.toContain(secret);
    }

    // The same holds when one variable is a real-looking credential: only the
    // defective variable is named, and only by name.
    const mixed = { ...REALISTIC, IGTRACK_GRAPH_IG_USER_ID: PLACEHOLDER_USER_ID };
    const blocker = graphConfigBlocker(mixed) ?? "";
    expect(blocker).toContain("IGTRACK_GRAPH_IG_USER_ID");
    expect(blocker).not.toContain(PLACEHOLDER_USER_ID);
    expect(blocker).not.toContain(REALISTIC.IGTRACK_GRAPH_ACCESS_TOKEN);
    expect(blocker).not.toContain(REALISTIC.IGTRACK_GRAPH_USERNAME);
  });
});

describe("provider selection stays explicit", () => {
  it("keeps a placeholder sitting behind the fixture provider out of the way, but says it is there", () => {
    const env = {
      IGTRACK_PROVIDER: "fixture",
      IGTRACK_GRAPH_ACCESS_TOKEN: PLACEHOLDER_TOKEN,
      IGTRACK_GRAPH_IG_USER_ID: PLACEHOLDER_USER_ID,
      IGTRACK_GRAPH_USERNAME: PLACEHOLDER_USERNAME,
    };
    const readiness = assessReadiness(env);
    // Not consumed → not blocking, so the fixture dev workflow keeps working.
    expect(readiness.graphCredentialsRequired).toBe(false);
    expect(isBlocking(readiness.status)).toBe(false);
    // …but switching to graph would be blocked, and the report says so now.
    expect(readiness.problems.length).toBe(3);
    expect(readiness.problems.join("\n")).toContain("IGTRACK_GRAPH_ACCESS_TOKEN");
  });

  it("reports a fixture deployment with no graph configuration as simply not configured", () => {
    const readiness = assessReadiness({ IGTRACK_PROVIDER: "fixture" });
    expect(readiness.status).toBe(ConfigState.NOT_VERIFIED);
    expect(readiness.problems).toEqual([]);
    expect(readiness.graphCredentialsRequired).toBe(false);
    expect(isBlocking(readiness.status)).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The provider descriptor is the single object every surface reads a
// configuration failure from: doctor's payload and findings, the status
// payload, the ask answers and the refusal reasons all echo `provider.error`
// as written. That text comes out of another package, and a driver or HTTP
// error quotes the URL it was handed — so it is scrubbed where it enters the
// descriptor, once, instead of at each screen that has to remember to.
//
// Today's known provider failures name variables and carry no secret, which is
// exactly why a test that only exercised them would prove nothing. The failure
// below is injected.
//
// No database: provider construction is pure environment.
// ---------------------------------------------------------------------------

const thrown = { message: undefined as string | undefined };

vi.mock("@igtrack/monitoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@igtrack/monitoring")>();
  return {
    ...actual,
    providerFromEnv: () => {
      if (thrown.message !== undefined) throw new Error(thrown.message);
      return actual.providerFromEnv();
    },
  };
});

import { describeProvider } from "../src/context.js";

describe("the provider descriptor's failure text", () => {
  afterEach(() => {
    thrown.message = undefined;
    vi.unstubAllEnvs();
  });

  it("keeps a configuration message readable, because the variable name is the diagnosis", () => {
    vi.stubEnv("IGTRACK_PROVIDER", "graph");
    thrown.message = "missing required env IGTRACK_GRAPH_TOKEN when IGTRACK_PROVIDER=graph";
    const descriptor = describeProvider();
    expect(descriptor.sourceId).toBeNull();
    expect(descriptor.provider).toBeNull();
    expect(descriptor.error).toContain("IGTRACK_GRAPH_TOKEN");
  });

  it("scrubs the credential out of a failure it did not write, and keeps the shape", () => {
    vi.stubEnv("IGTRACK_PROVIDER", "graph");
    thrown.message =
      "Graph client could not start: postgres://igtrack:s3cr3t-value@db.internal:5432/igtrack refused connection";
    const printed = describeProvider().error ?? "";
    expect(printed).not.toContain("s3cr3t-value");
    expect(printed).toContain("postgres://igtrack:***@db.internal:5432/igtrack");
    expect(printed).toContain("refused connection");
  });

  it("scrubs a token carried in a request URL the same way", () => {
    vi.stubEnv("IGTRACK_PROVIDER", "graph");
    thrown.message = "GET https://graph.facebook.com/v23.0/me?access_token=EEE-secret failed";
    const printed = describeProvider().error ?? "";
    expect(printed).not.toContain("EEE-secret");
    expect(printed).toContain("access_token=***");
  });

  it("labels the evidence class the selected provider would have produced, not the failure", () => {
    thrown.message = "boot failed";
    vi.stubEnv("IGTRACK_PROVIDER", "graph");
    expect(describeProvider().synthetic).toBe(false);
    vi.stubEnv("IGTRACK_PROVIDER", "fixture");
    expect(describeProvider().synthetic).toBe(true);
  });
});

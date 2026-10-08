import { describe, expect, it } from "vitest";
import { opAsk } from "../src/ask/execute.js";
import { planAsk } from "../src/ask/parse.js";

// ---------------------------------------------------------------------------
// The executor is tested without a database for exactly the paths that must
// work without one, plus the two safety behaviours that matter most:
// destructive requests are suggestions, and a request that genuinely needs the
// database fails loudly instead of returning an empty success.
// ---------------------------------------------------------------------------

describe("opAsk without a database", () => {
  it("answers the guide from the capability registry alone", async () => {
    const result = await opAsk(null, planAsk("what can you do?"));
    expect(result.status).toBe("ANSWERED");
    expect(result.steps[0]?.intent).toBe("guide");
    expect(result.steps[0]?.status).toBe("OK");
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.examples.length).toBeGreaterThan(0);
    expect(result.understanding.intents).toEqual(["guide"]);
  });

  it("answers a capability question without touching the database", async () => {
    const result = await opAsk(null, planAsk("what are the limitations?"));
    expect(result.status).toBe("ANSWERED");
    const step = result.steps[0];
    expect(step?.intent).toBe("capabilities");
    const data = step?.result as { summary: { available: number; total: number } };
    expect(data.summary.available).toBeGreaterThan(0);
    // Each unavailable capability is named with its reason, never as a zero.
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it("returns the exact command for a destructive request instead of running it", async () => {
    const result = await opAsk(null, planAsk("delete @someone"));
    expect(result.status).toBe("ANSWERED");
    const step = result.steps[0];
    expect(step?.status).toBe("SUGGESTED");
    expect(step?.suggestion).toBe("igtrack targets rm someone --yes");
    expect(step?.result).toBeUndefined();
  });

  it("routes stories to the anonstories command with its evidence caveat", async () => {
    const result = await opAsk(null, planAsk("show the stories for @someone"));
    const step = result.steps[0];
    expect(step?.status).toBe("SUGGESTED");
    expect(step?.suggestion).toBe("igtrack anonstories someone");
    expect(step?.summary).toMatch(/PUBLIC_AGGREGATOR/);
  });

  it("routes a post permalink to the database-free post reader", async () => {
    const result = await opAsk(
      null,
      planAsk("read this post https://www.instagram.com/vishnu_vichuz_/p/DeM2pENH67Y/"),
    );
    const step = result.steps[0];
    expect(step?.intent).toBe("post");
    expect(step?.status).toBe("SUGGESTED");
    expect(step?.suggestion).toBe("igtrack post https://www.instagram.com/vishnu_vichuz_/p/DeM2pENH67Y/");
    expect(step?.summary).toMatch(/database-free/);
  });

  it("asks for a permalink when a single post is requested without one", async () => {
    const result = await opAsk(null, planAsk("read this post"));
    const step = result.steps[0];
    expect(step?.status).toBe("SUGGESTED");
    expect(step?.suggestion).toBe("igtrack post <permalink>");
  });

  it("asks which account instead of guessing when a handle is required", async () => {
    const result = await opAsk(null, planAsk("show the stories"));
    expect(result.status).toBe("NEEDS_INPUT");
    expect(result.steps[0]?.status).toBe("SKIPPED");
    expect(result.answer.join(" ")).toMatch(/need an account/i);
  });

  it("fails with DB_UNAVAILABLE when the request genuinely needs the database", async () => {
    await expect(opAsk(null, planAsk("what changed on @someone"))).rejects.toMatchObject({
      code: "DB_UNAVAILABLE",
      exitCode: 3,
    });
  });
});

describe("opAsk: report surfaces without a database", () => {
  it("asks for the account a report is about before doing anything", async () => {
    const result = await opAsk(null, planAsk("monthly report"));
    expect(result.status).toBe("NEEDS_INPUT");
    expect(result.steps[0]?.status).toBe("SKIPPED");
  });

  it("requires the database for a report instead of composing an empty one", async () => {
    await expect(opAsk(null, planAsk("give me the weekly report for @aurora.wilde"))).rejects.toMatchObject({
      code: "DB_UNAVAILABLE",
      exitCode: 3,
    });
  });

  it("requires the database for audience set algebra", async () => {
    await expect(opAsk(null, planAsk("who doesn't follow @aurora.wilde back?"))).rejects.toMatchObject({
      code: "DB_UNAVAILABLE",
      exitCode: 3,
    });
  });

  it("requires the database for a digest", async () => {
    await expect(opAsk(null, planAsk("digest for @aurora.wilde"))).rejects.toMatchObject({
      code: "DB_UNAVAILABLE",
      exitCode: 3,
    });
  });
});

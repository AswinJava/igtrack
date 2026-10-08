import { describe, expect, it } from "vitest";
import { describePlan, planAsk } from "../src/ask/parse.js";

// ---------------------------------------------------------------------------
// The prompt layer is deterministic on purpose, so its behaviour is pinned
// here: what a sentence is understood to mean, which entities are pulled out,
// and — just as important — what it says out loud when it had to assume or
// could not understand. A parser that silently guesses would violate the same
// evidence rules the rest of the product enforces.
// ---------------------------------------------------------------------------

describe("planAsk: intent recognition", () => {
  it("maps a capability question to the database-free guide", () => {
    const plan = planAsk("what can you do?");
    expect(plan.intents).toEqual(["guide"]);
    expect(plan.primary).toBe("guide");
    expect(plan.needsDb).toBe(false);
    expect(plan.needsUsername).toBe(false);
  });

  it("runs the primary investigation for an explicit handle", () => {
    const plan = planAsk("investigate @aurora.wilde");
    expect(plan.primary).toBe("investigate");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.needsDb).toBe(true);
    expect(plan.confidence).toBe("high");
  });

  it("tolerates a typo in the verb", () => {
    const plan = planAsk("investigat aurora.wilde");
    expect(plan.primary).toBe("investigate");
    expect(plan.username).toBe("aurora.wilde");
  });

  it("reads a change question with its window, not a row limit", () => {
    const plan = planAsk("what changed on @aurora.wilde in the last 7 days?");
    expect(plan.primary).toBe("changes");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.since).toBe("7d");
    expect(plan.limit).toBeNull();
  });

  it("states the default window when none was given", () => {
    const plan = planAsk("what changed?");
    expect(plan.primary).toBe("changes");
    expect(plan.since).toBeNull();
    expect(plan.needsUsername).toBe(false);
    expect(plan.assumptions).toContain(
      "No time window was given, so changes are read from the last 7 days.",
    );
  });

  it("recognises relationship questions", () => {
    expect(planAsk("who does @aurora.wilde interact with most?").primary).toBe("relationships");
    expect(planAsk("show me the strongest connections for @aurora.wilde").primary).toBe(
      "relationships",
    );
  });

  it("recognises insights, tagged media and the next-step plan", () => {
    expect(planAsk("show me the insights for @aurora.wilde").primary).toBe("insights");
    expect(planAsk("which posts is @aurora.wilde tagged in?").primary).toBe("tags");
    expect(planAsk("what should I do next for @aurora.wilde?").primary).toBe("plan");
  });

  it("recognises a lookup and a status question", () => {
    expect(planAsk("look up @someone").primary).toBe("lookup");
    const status = planAsk("whats teh status of this deployment");
    expect(status.primary).toBe("status");
    expect(status.confidence).toBe("medium");
  });

  it("treats a bare handle as an investigation, with the assumption stated", () => {
    const plan = planAsk("aurora.wilde");
    expect(plan.primary).toBe("investigate");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.assumptions.join(" ")).toMatch(/full investigation/i);
  });

  it("falls back to the guide when nothing is recognised", () => {
    const plan = planAsk("hello there");
    expect(plan.primary).toBe("guide");
    expect(plan.needsDb).toBe(false);
  });

  it("turns an empty prompt into the guide, and says why", () => {
    const plan = planAsk("   ");
    expect(plan.intents).toEqual(["guide"]);
    expect(plan.confidence).toBe("low");
    expect(plan.assumptions.length).toBe(1);
  });
});

describe("planAsk: multi-step requests", () => {
  it("runs a requested write before the read it feeds", () => {
    const plan = planAsk("track @somehandle and run the first scan");
    expect(plan.username).toBe("somehandle");
    expect(plan.intents).toContain("track");
    expect(plan.intents).toContain("scan");
    expect(plan.intents.indexOf("track")).toBeLessThan(plan.intents.indexOf("scan"));
  });

  it("keeps two explicitly requested reads", () => {
    const plan = planAsk("what changed on @aurora.wilde and who does she interact with?");
    expect(plan.intents).toContain("changes");
    expect(plan.intents).toContain("relationships");
  });

  it("lets the investigation subsume the reads it already includes", () => {
    const plan = planAsk("investigate @aurora.wilde and show me the dossier and research");
    expect(plan.intents).toEqual(["investigate"]);
  });
});

describe("planAsk: safety and evidence", () => {
  it("never proposes to execute a destructive request, only the command", () => {
    const plan = planAsk("delete @aurora.wilde");
    expect(plan.intents).toEqual(["untrack"]);
    expect(plan.executable).toBe(false);
    expect(plan.needsDb).toBe(false);
  });

  it("routes stories and logged-out pages to their dedicated commands", () => {
    expect(planAsk("show the stories for @someone").executable).toBe(false);
    expect(planAsk("show me the public profile of @someone without login").intents).toEqual([
      "public",
    ]);
  });

  it("routes a post permalink to the single-post reader, not a full investigation", () => {
    const plan = planAsk("read this post https://www.instagram.com/vishnu_vichuz_/p/DeM2pENH67Y/");
    expect(plan.intents).toEqual(["post"]);
    expect(plan.primary).toBe("post");
    expect(plan.urls).toEqual(["https://www.instagram.com/vishnu_vichuz_/p/DeM2pENH67Y/"]);
    expect(plan.executable).toBe(false);
    expect(plan.needsDb).toBe(false);
    expect(plan.needsUsername).toBe(false);
  });

  it("keeps a posts export an export, not a single-post read", () => {
    expect(planAsk("export @aurora.wilde's posts as csv").intents).toEqual(["export"]);
  });

  it("reads a possessive handle and a count question into the stored dossier", () => {
    expect(planAsk("export someone.else's posts as csv").username).toBe("someone.else");
    const count = planAsk("how many followers does @someone have?");
    expect(count.intents).toEqual(["dossier"]);
    expect(count.assumptions).toEqual([]);
  });

  it("does not mistake an evidence id for an account", () => {
    const plan = planAsk("show me evidence for ev_ab12cd34");
    expect(plan.primary).toBe("evidence");
    expect(plan.evidenceId).toBe("ev_ab12cd34");
    expect(plan.username).toBeNull();
  });
});

describe("planAsk: entities", () => {
  it("extracts limits and ISO windows", () => {
    const top = planAsk("show me the top 10 relationships for @aurora.wilde");
    expect(top.limit).toBe(10);
    const iso = planAsk("what changed on @aurora.wilde since 2026-01-01?");
    expect(iso.since).toBe("2026-01-01");
  });

  it("reads word numbers and shorthand durations", () => {
    expect(planAsk("first five connections for @aurora.wilde").limit).toBe(5);
    expect(planAsk("what changed on @aurora.wilde in the past 24h?").since).toBe("24h");
    expect(planAsk("what changed on @aurora.wilde in the last 2 weeks?").since).toBe("14d");
  });

  it("resolves a tracked account by full name or unique base name", () => {
    const options = { knownTargets: ["aurora.wilde", "brand.other"] };
    expect(planAsk("what changed on aurora last week", options).username).toBe("aurora.wilde");
    expect(planAsk("investigate brand", options).username).toBe("brand.other");
  });

  it("prefers an explicitly typed handle over a tracked name elsewhere", () => {
    const plan = planAsk("compare @other.handle with aurora.wilde", {
      knownTargets: ["aurora.wilde"],
    });
    expect(plan.username).toBe("other.handle");
  });

  it("collects public URLs for the web stage", () => {
    const plan = planAsk("audit @aurora.wilde using https://example.com/about.");
    expect(plan.urls).toEqual(["https://example.com/about"]);
  });
});

describe("describePlan", () => {
  it("restates the operation, the account and the window in one line", () => {
    expect(describePlan(planAsk("what changed on @aurora.wilde in the last 7 days?"))).toBe(
      "changes @aurora.wilde · last 7d",
    );
  });
});

describe("planAsk: periodic reports", () => {
  it("reads a named calendar period and its account", () => {
    const plan = planAsk("give me the weekly report for @aurora.wilde");
    expect(plan.intents).toEqual(["report"]);
    expect(plan.primary).toBe("report");
    expect(plan.period).toBe("weekly");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.needsDb).toBe(true);
    expect(describePlan(plan)).toBe("report @aurora.wilde · weekly");
  });

  it("states the default period when only a report was asked for", () => {
    const plan = planAsk("make a report for @aurora.wilde");
    expect(plan.primary).toBe("report");
    expect(plan.period).toBeNull();
    expect(plan.assumptions).toContain("No period was named, so the current week is reported.");
  });

  it("asks for the account a report is about", () => {
    const plan = planAsk("monthly report");
    expect(plan.primary).toBe("report");
    expect(plan.period).toBe("monthly");
    expect(plan.needsUsername).toBe(true);
  });

  it("recognises a quarter label", () => {
    expect(planAsk("q4 report").period).toBe("quarterly");
    expect(planAsk("annual report").period).toBe("yearly");
  });

  it("lists stored report windows", () => {
    expect(planAsk("show me the reports for @aurora.wilde").primary).toBe("reports");
  });
});

describe("planAsk: audience sets", () => {
  it("recognises follow-back questions with an account in the middle", () => {
    const plan = planAsk("who doesn't follow @aurora.wilde back?");
    expect(plan.primary).toBe("audience");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.needsDb).toBe(true);
  });

  it("recognises mutuals, roster and following questions", () => {
    expect(planAsk("show me the mutuals for @aurora.wilde").primary).toBe("audience");
    expect(planAsk("who follows @aurora.wilde").primary).toBe("audience");
    expect(planAsk("who does @aurora.wilde follow").primary).toBe("audience");
  });
});

describe("planAsk: recent follow activity", () => {
  it("requires a recency marker so a plain roster question stays audience", () => {
    expect(planAsk("who did @aurora.wilde recently follow?").primary).toBe("recent");
    expect(planAsk("who did @aurora.wilde follow recently?").primary).toBe("recent");
    expect(planAsk("who does @aurora.wilde follow").primary).toBe("audience");
    expect(planAsk("who did @aurora.wilde follow").primary).toBe("audience");
  });

  it("recognises recent, new and unfollower phrasing", () => {
    expect(planAsk("show me recent follows for @aurora.wilde").primary).toBe("recent");
    expect(planAsk("any new followers for @aurora.wilde?").primary).toBe("recent");
    expect(planAsk("who unfollowed @aurora.wilde").primary).toBe("recent");
    const plan = planAsk("who did @aurora.wilde recently follow?");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.needsDb).toBe(true);
  });
});

describe("planAsk: exports and digests", () => {
  it("carries the row kind an export names", () => {
    const plan = planAsk("export @aurora.wilde's posts as csv");
    expect(plan.primary).toBe("export");
    expect(plan.exportKind).toBe("posts");
    expect(plan.username).toBe("aurora.wilde");
  });

  it("states the default export kind when none was named", () => {
    const plan = planAsk("export @aurora.wilde");
    expect(plan.exportKind).toBeNull();
    expect(plan.assumptions).toContain("No row kind was named, so the activity feed is exported.");
  });

  it("defaults a digest to the last 7 days and says so", () => {
    const plan = planAsk("digest for @aurora.wilde");
    expect(plan.primary).toBe("digest");
    expect(plan.username).toBe("aurora.wilde");
    expect(plan.needsUsername).toBe(false);
    expect(plan.assumptions).toContain("No window was given, so the digest covers the last 7 days.");
  });
});

import { describe, expect, it } from "vitest";
import { namedEdgesSentence, recentActivitySentence } from "../src/ask/execute.js";

// ---------------------------------------------------------------------------
// The two sentences that turn a recent-activity read into prose.
//
// A roster side with no COMPLETE baseline has null counts, and a sentence that
// renders null as 0 tells the operator "nobody followed or unfollowed" — a
// claim about the account rather than about this deployment's data. A real zero
// from a side that WAS read must still print as zero, so both directions are
// pinned here. Pure functions, no database.
// ---------------------------------------------------------------------------

const since = "2026-10-01T00:00:00.000Z";

describe("recent-activity prose never states an unmade observation", () => {
  it("names only the side that had a baseline (followers asked)", () => {
    const sentence = recentActivitySentence("aurora.wilde", since, {
      newFollowing: null,
      lostFollowing: null,
      newFollowers: 3,
      lostFollowers: 1,
    });
    expect(sentence).toContain("3 new follower(s), 1 lost follower(s)");
    expect(sentence).not.toMatch(/\b0 new follow\(s\)/);
    expect(sentence).not.toMatch(/\b0 lost follow\(s\)/);
    expect(sentence).not.toMatch(/null|undefined/);
  });

  it("names only the side that had a baseline (following asked)", () => {
    const sentence = recentActivitySentence("aurora.wilde", since, {
      newFollowing: 2,
      lostFollowing: 0,
      newFollowers: null,
      lostFollowers: null,
    });
    expect(sentence).toContain("2 new follow(s), 0 lost follow(s)");
    expect(sentence).not.toMatch(/new follower/);
    expect(sentence).not.toMatch(/null|undefined/);
  });

  it("names both sides when both were read", () => {
    const sentence = recentActivitySentence("aurora.wilde", since, {
      newFollowing: 2,
      lostFollowing: 1,
      newFollowers: 4,
      lostFollowers: 0,
    });
    expect(sentence).toContain("2 new follow(s), 1 lost follow(s)");
    expect(sentence).toContain("4 new follower(s), 0 lost follower(s)");
  });

  it("says plainly when neither side carried counts", () => {
    const sentence = recentActivitySentence("aurora.wilde", since, {
      newFollowing: null,
      lostFollowing: null,
      newFollowers: null,
      lostFollowers: null,
    });
    expect(sentence).toContain("no side had a COMPLETE roster to diff");
    expect(sentence).not.toMatch(/\b0\b/);
  });

  it("labels an unobserved side in the full-audit sentence instead of printing null", () => {
    const sentence = namedEdgesSentence({
      newFollowing: 2,
      lostFollowing: 0,
      newFollowers: null,
      lostFollowers: null,
    });
    expect(sentence).toContain("2 new following");
    expect(sentence).toContain("0 lost following");
    expect(sentence).toContain("new followers: side not observed");
    expect(sentence).toContain("lost followers: side not observed");
    expect(sentence).not.toMatch(/\bnull\b/);
  });
});

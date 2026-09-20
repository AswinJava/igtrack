import { describe, expect, it } from "vitest";
import { handleSearchQueries, HANDLE_QUERY_LIMIT } from "../src/research/queries.js";

// ---------------------------------------------------------------------------
// The query strategy is a tested value, not string building
// inside a fetch loop. These tests pin the questions asked for an arbitrary
// handle — their order, their distinctness, and the budget that keeps query
// variety from becoming an endless near-duplicate crawl.
// ---------------------------------------------------------------------------

describe("handleSearchQueries", () => {
  it("asks the four distinct forms for a plain handle, in order", () => {
    expect(handleSearchQueries("sel_win_")).toEqual([
      '"sel_win_" instagram',
      "instagram.com/sel_win_",
      '"@sel_win_"',
      '"sel_win_"',
    ]);
  });

  it("strips a leading @ instead of double-prefixing the mention form", () => {
    expect(handleSearchQueries("@sel_win_")).toEqual(handleSearchQueries("sel_win_"));
    expect(handleSearchQueries("@sel_win_")).toContain('"@sel_win_"');
  });

  it("honours a smaller budget and never emits empty or zero budgets", () => {
    expect(handleSearchQueries("someuser", 2)).toEqual(['"someuser" instagram', "instagram.com/someuser"]);
    expect(handleSearchQueries("someuser", 1)).toEqual(['"someuser" instagram']);
    expect(handleSearchQueries("someuser", 0)).toEqual([]);
    // The default budget is part of the contract the audit test pins against.
    expect(HANDLE_QUERY_LIMIT).toBe(4);
  });

  it("returns nothing for an empty handle — there is no question to ask", () => {
    expect(handleSearchQueries("")).toEqual([]);
    expect(handleSearchQueries("   ")).toEqual([]);
    expect(handleSearchQueries("@")).toEqual([]);
  });

  it("never emits a near-duplicate: every query is distinct case-insensitively", () => {
    const queries = handleSearchQueries("Sel_Win_");
    const lowered = queries.map((query) => query.toLowerCase());
    expect(new Set(lowered).size).toBe(queries.length);
    // Every variant still carries the handle — no variant asks a question
    // about something else.
    for (const query of queries) expect(query.toLowerCase()).toContain("sel_win_");
  });
});

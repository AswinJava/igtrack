import { describe, expect, it } from "vitest";
import { deriveCadence, deriveThemes, THEME_TERM_LIMIT } from "../src/synthesis.js";

// Themes and cadence are presented inside the research report as derived facts
// about a stated corpus. These tests pin the two properties that presentation
// depends on: determinism (same rows, same bytes) and honest scoping (an empty
// or tiny corpus never yields an invented figure).

describe("deriveThemes", () => {
  it("is deterministic and orders by count then term", () => {
    const captions = ["aurora glaze aurora", "blue glaze", "aurora firing"];
    const first = deriveThemes(captions);
    const second = deriveThemes(captions);
    expect(second).toEqual(first);
    // aurora x3, glaze x2 (captions 1 and 2), then a tie between blue and
    // firing that resolves alphabetically.
    expect(first.terms).toEqual([
      { term: "aurora", count: 3 },
      { term: "glaze", count: 2 },
      { term: "blue", count: 1 },
      { term: "firing", count: 1 },
    ]);
  });

  it("excludes stopwords, short tokens and bare numbers, and scopes the corpus", () => {
    const result = deriveThemes([null, "   ", "the 2026 kiln is a big kiln", undefined]);
    // Only one caption carries text; the blank/null rows are not part of the corpus.
    expect(result.captionRows).toBe(1);
    expect(result.terms.map((t) => t.term).sort()).toEqual(["big", "kiln"]);
  });

  it("tallies hashtags separately, lowercased and bounded by the limit", () => {
    const result = deriveThemes(["#Pottery #glaze day", "#pottery again"], { limit: 1 });
    expect(result.hashtags).toEqual([{ term: "pottery", count: 2 }]);
    // Hashtag words are still words of the text, so they appear in the term
    // tally too — the two lists double-count by construction and are labelled.
    expect(result.terms).toEqual([{ term: "pottery", count: 2 }]);
    // The default limit is in effect when none is given.
    const defaults = deriveThemes(Array.from({ length: 30 }, (_, i) => `word${String(i)}x`));
    expect(defaults.terms).toHaveLength(THEME_TERM_LIMIT);
  });

  it("answers an empty corpus with an empty result, never a guess", () => {
    const result = deriveThemes([null, undefined, ""]);
    expect(result).toEqual({ captionRows: 0, terms: [], hashtags: [] });
  });
});

describe("deriveCadence", () => {
  it("computes the median gap over distinct timestamps, rounded to one decimal", () => {
    const result = deriveCadence([
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-03T00:00:00Z"), // 2 days
      new Date("2026-09-08T00:00:00Z"), // 5 days
    ]);
    expect(result.timestampRows).toBe(3);
    expect(result.firstPublishedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(result.lastPublishedAt).toBe("2026-09-08T00:00:00.000Z");
    // Two gaps: 2 days and 5 days -> (2 + 5) / 2 = 3.5.
    expect(result.medianGapDays).toBe(3.5);
  });

  it("deduplicates timestamps so a re-observed post is not a zero-length gap", () => {
    const result = deriveCadence([
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T12:00:00Z"),
    ]);
    expect(result.timestampRows).toBe(2);
    expect(result.medianGapDays).toBe(1.5);
  });

  it("averages the two middle gaps when there is an even number of intervals", () => {
    const result = deriveCadence([
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T00:00:00Z"), // 1
      new Date("2026-09-06T00:00:00Z"), // 4
      new Date("2026-09-07T00:00:00Z"), // 1
      new Date("2026-09-11T00:00:00Z"), // 4
    ]);
    // gaps [1, 1, 4, 4] -> (1 + 4) / 2 = 2.5
    expect(result.medianGapDays).toBe(2.5);
  });

  it("refuses to state a cadence below two timestamps", () => {
    const single = deriveCadence([new Date("2026-09-01T00:00:00Z")]);
    expect(single.timestampRows).toBe(1);
    expect(single.medianGapDays).toBeNull();
    expect(single.firstPublishedAt).toBe(single.lastPublishedAt);
    const none = deriveCadence([null, undefined]);
    expect(none).toEqual({
      timestampRows: 0,
      firstPublishedAt: null,
      lastPublishedAt: null,
      medianGapDays: null,
    });
    // Invalid dates are absence, not a timestamp.
    expect(deriveCadence([new Date("not a date")]).timestampRows).toBe(0);
  });
});

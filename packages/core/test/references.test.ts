import { describe, expect, it } from "vitest";
import { parseAccountReference, parsePostReference } from "../src/index.js";

// ---------------------------------------------------------------------------
// The parser exists so "invalid reference" is a different answer from
// "valid but not tracked". An agent that gets the two confused retries the
// wrong thing, so every divergence is pinned here.
// ---------------------------------------------------------------------------

describe("parseAccountReference", () => {
  it("accepts a plain username and a handle, recording the surface form", () => {
    expect(parseAccountReference("aurora.wilde")).toEqual({
      ok: true,
      reference: { username: "aurora.wilde", form: "USERNAME" },
    });
    expect(parseAccountReference("@aurora.wilde")).toEqual({
      ok: true,
      reference: { username: "aurora.wilde", form: "HANDLE" },
    });
  });

  it("accepts profile URLs with or without scheme, www, trailing slash or query", () => {
    for (const raw of [
      "https://www.instagram.com/aurora.wilde",
      "https://www.instagram.com/aurora.wilde/",
      "https://www.instagram.com/aurora.wilde/?hl=en",
      "http://instagram.com/aurora.wilde",
      "instagram.com/aurora.wilde",
      "www.instagram.com/aurora.wilde/",
      "m.instagram.com/aurora.wilde",
    ]) {
      const parsed = parseAccountReference(raw);
      expect(parsed, raw).toEqual({
        ok: true,
        reference: { username: "aurora.wilde", form: "PROFILE_URL" },
      });
    }
  });

  it("refuses a profile URL with extra path segments instead of guessing a username", () => {
    for (const raw of [
      "https://www.instagram.com/aurora.wilde/reel/CxYz123/",
      "https://www.instagram.com/p/CxYz123/",
      "https://www.instagram.com/explore/tags/aurora/",
    ]) {
      const parsed = parseAccountReference(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("profile URL is instagram.com/<username>");
    }
  });

  it("refuses bare instagram.com with no username", () => {
    const parsed = parseAccountReference("https://www.instagram.com/");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("contains no username");
  });

  it("refuses non-instagram hosts rather than parsing them anyway", () => {
    const parsed = parseAccountReference("https://example.org/aurora.wilde");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("not instagram.com");
  });

  it("refuses invalid usernames with a message an agent can act on", () => {
    for (const raw of ["aurora wilde", "aurora/wilde", "aur or a", "aurora@example.org", "a".repeat(31), "äurora"]) {
      const parsed = parseAccountReference(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("not a valid Instagram username");
    }
  });

  it("refuses an empty reference", () => {
    const parsed = parseAccountReference("   ");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("required");
  });

  it("rejects id-shaped strings (hyphens) so target ids are matched before parsing", () => {
    // resolveTarget tries the id match first; the parser is the username path
    // and must not silently mangle a uuid into a username candidate.
    const parsed = parseAccountReference("8f1f4b6e-0000-4000-8000-000000000000");
    expect(parsed.ok).toBe(false);
  });
});

describe("parsePostReference", () => {
  it("accepts every canonical post URL kind, with or without scheme and query", () => {
    const cases: Array<[string, "p" | "reel" | "tv"]> = [
      ["https://www.instagram.com/p/CxYz123AbCd/", "p"],
      ["https://www.instagram.com/reel/CxYz123AbCd/", "reel"],
      ["https://instagram.com/tv/CxYz123AbCd", "tv"],
      ["instagram.com/p/CxYz123AbCd/?igsh=tracking", "p"],
      ["m.instagram.com/reel/CxYz123AbCd/", "reel"],
      ["https://www.instagram.com/aurora.wilde/p/CxYz123AbCd/", "p"],
    ];
    for (const [raw, kind] of cases) {
      const parsed = parsePostReference(raw);
      expect(parsed, raw).toEqual({
        ok: true,
        reference: { shortcode: "CxYz123AbCd", kind, form: "POST_URL" },
      });
    }
  });

  it("names the right surface for a profile URL instead of treating it as a post", () => {
    const parsed = parsePostReference("https://www.instagram.com/aurora.wilde/");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("profile URL, not a post URL");
      expect(parsed.message).toContain("igtrack public");
    }
  });

  it("refuses story, tag and explore links with an actionable reason", () => {
    const story = parsePostReference("https://www.instagram.com/stories/aurora.wilde/123/");
    expect(story.ok).toBe(false);
    if (!story.ok) expect(story.message).toContain("story link");

    for (const raw of [
      "https://www.instagram.com/explore/tags/aurora/",
      "https://www.instagram.com/aurora.wilde/",
    ]) {
      const parsed = parsePostReference(raw);
      expect(parsed.ok, raw).toBe(false);
    }
  });

  it("refuses a bare shortcode, a foreign host and an impossible shortcode", () => {
    const bare = parsePostReference("CxYz123AbCd");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.message).toContain("full link");

    const foreign = parsePostReference("https://example.org/p/CxYz123AbCd/");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.message).toContain("not instagram.com");

    const short = parsePostReference("https://www.instagram.com/p/abc/");
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.message).toContain("not a possible Instagram shortcode");
  });

  it("refuses an empty reference", () => {
    const parsed = parsePostReference("   ");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("required");
  });
});

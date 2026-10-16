import { describe, expect, it } from "vitest";
import { parseAccountReference } from "../src/index.js";

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

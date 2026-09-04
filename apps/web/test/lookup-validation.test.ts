import { describe, expect, it } from "vitest";
import { usernameQuerySchema } from "../lib/username.js";

describe("lookup username validation", () => {
  it("strips @, trims, and lowercases", () => {
    expect(usernameQuerySchema.parse({ username: "  @Aurora.Wilde " })).toEqual({
      username: "aurora.wilde",
    });
  });

  it("rejects empty, too-long, and illegal characters", () => {
    expect(() => usernameQuerySchema.parse({ username: "" })).toThrow();
    expect(() => usernameQuerySchema.parse({ username: "a".repeat(31) })).toThrow();
    expect(() => usernameQuerySchema.parse({ username: "bad-name!" })).toThrow();
    expect(() => usernameQuerySchema.parse({ username: "has space" })).toThrow();
  });

  it("accepts dots and underscores", () => {
    expect(usernameQuerySchema.parse({ username: "a.b_c9" })).toEqual({
      username: "a.b_c9",
    });
  });
});

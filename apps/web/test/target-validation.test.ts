import { describe, expect, it } from "vitest";
import { targetCreateSchema } from "../lib/target-validation.js";
import { usernameQuerySchema } from "../lib/username.js";

describe("target create validation", () => {
  it("strips @, trims, and lowercases", () => {
    expect(
      targetCreateSchema.parse({ username: "  @Aurora.Wilde " }).username,
    ).toBe("aurora.wilde");
  });

  it("rejects usernames longer than 30 chars like the lookup schema", () => {
    expect(() =>
      targetCreateSchema.parse({ username: "a".repeat(31) }),
    ).toThrow();
    expect(() => usernameQuerySchema.parse({ username: "a".repeat(31) })).toThrow();
    // 30 chars is the shared boundary and stays valid on both schemas.
    expect(
      targetCreateSchema.parse({ username: "a".repeat(30) }).username,
    ).toBe("a".repeat(30));
  });

  it("rejects illegal characters", () => {
    expect(() => targetCreateSchema.parse({ username: "bad-name!" })).toThrow();
    expect(() => targetCreateSchema.parse({ username: "has space" })).toThrow();
    expect(() => targetCreateSchema.parse({ username: "" })).toThrow();
  });

  it("accepts dots and underscores with optional metadata", () => {
    expect(
      targetCreateSchema.parse({
        username: "a.b_c9",
        localName: "Local",
        tags: ["close"],
      }).username,
    ).toBe("a.b_c9");
  });
});

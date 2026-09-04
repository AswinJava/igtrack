import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isSameOrigin } from "../lib/csrf.js";

function req(headers: Record<string, string>, url = "http://localhost:3000/api/targets"): NextRequest {
  return new NextRequest(url, { headers });
}

describe("isSameOrigin", () => {
  it("allows requests without Origin/Referer", () => {
    expect(isSameOrigin(req({ host: "localhost:3000" }))).toBe(true);
  });

  it("allows matching Origin", () => {
    expect(
      isSameOrigin(req({ host: "localhost:3000", origin: "http://localhost:3000" })),
    ).toBe(true);
  });

  it("rejects cross-origin Origin", () => {
    expect(
      isSameOrigin(req({ host: "localhost:3000", origin: "https://evil.example" })),
    ).toBe(false);
  });

  it("rejects cross-origin Referer when Origin is absent", () => {
    expect(
      isSameOrigin(
        req({ host: "localhost:3000", referer: "https://evil.example/x" }),
      ),
    ).toBe(false);
  });

  it("allows matching Referer", () => {
    expect(
      isSameOrigin(
        req({ host: "localhost:3000", referer: "http://localhost:3000/targets" }),
      ),
    ).toBe(true);
  });
});

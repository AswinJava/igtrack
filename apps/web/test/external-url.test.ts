import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "../lib/external-url.js";

describe("external URL guard", () => {
  it("allows http and https links", () => {
    expect(isSafeExternalUrl("https://www.instagram.com/p/AxYz001/")).toBe(true);
    expect(isSafeExternalUrl("http://example.com/x")).toBe(true);
    expect(isSafeExternalUrl("  https://example.com/prints  ")).toBe(true);
    expect(isSafeExternalUrl("HTTPS://EXAMPLE.COM/")).toBe(true);
  });

  it("blocks script, data, and non-web schemes", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeExternalUrl("ftp://example.com/f")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });

  it("blocks credential-bearing URLs even on safe schemes", () => {
    expect(isSafeExternalUrl("https://user:pass@example.com/")).toBe(false);
    expect(isSafeExternalUrl("https://user@example.com/")).toBe(false);
    expect(isSafeExternalUrl("http://a:b@127.0.0.1/")).toBe(false);
  });

  it("allows loopback and private-network URLs as user-initiated navigation", () => {
    // Documented behavior: links are never server-fetched (no SSRF surface)
    // and carry rel=noreferrer, so these render for explicit user clicks only.
    expect(isSafeExternalUrl("http://localhost:3000/x")).toBe(true);
    expect(isSafeExternalUrl("http://192.168.1.10/y")).toBe(true);
  });
  it("blocks relative URLs, blanks, and oversized input", () => {
    expect(isSafeExternalUrl("/p/AxYz001/")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("   ")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });
});

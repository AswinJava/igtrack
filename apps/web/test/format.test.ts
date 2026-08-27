import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatRelative } from "../lib/format.js";

describe("format helpers", () => {
  it("returns em dash for null", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatRelative(null)).toBe("—");
  });

  it("formats relative times", () => {
    const now = new Date();
    expect(formatRelative(now)).toBe("just now");
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000))).toBe("5m ago");
    expect(formatRelative(new Date(now.getTime() - 2 * 60 * 60_000))).toBe("2h ago");
    expect(formatRelative(new Date(now.getTime() - 3 * 24 * 60 * 60_000))).toBe("3d ago");
  });

  it("formats dates without throwing", () => {
    const d = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));
    expect(formatDate(d)).toContain("Aug");
    expect(formatDateTime(d)).toContain("2026");
  });
});

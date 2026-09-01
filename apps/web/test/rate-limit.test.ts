import { describe, expect, it, beforeEach } from "vitest";
import {
  checkRateLimit,
  loginRateLimitKey,
  LOGIN_LIMIT,
  resetRateLimitForTest,
} from "../lib/rate-limit.js";

describe("login rate limiter (Phase 10 P2 #1)", () => {
  beforeEach(() => resetRateLimitForTest());

  it("allows up to max attempts then blocks with Retry-After", () => {
    const key = loginRateLimitKey("1.2.3.4", "a@b.com");
    for (let i = 0; i < LOGIN_LIMIT.max; i += 1) {
      const r = checkRateLimit(key, LOGIN_LIMIT);
      expect(r.allowed).toBe(true);
    }
    const blocked = checkRateLimit(key, LOGIN_LIMIT);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(LOGIN_LIMIT.windowMs);
  });

  it("resets after the window elapses", () => {
    const key = loginRateLimitKey("1.2.3.4", "a@b.com");
    const now = Date.now();
    for (let i = 0; i < LOGIN_LIMIT.max; i += 1) {
      checkRateLimit(key, { ...LOGIN_LIMIT, now });
    }
    const blocked = checkRateLimit(key, { ...LOGIN_LIMIT, now });
    expect(blocked.allowed).toBe(false);

    const afterWindow = now + LOGIN_LIMIT.windowMs + 1;
    const after = checkRateLimit(key, { ...LOGIN_LIMIT, now: afterWindow });
    expect(after.allowed).toBe(true);
  });

  it("isolates different IP+email buckets", () => {
    const k1 = loginRateLimitKey("1.2.3.4", "a@b.com");
    const k2 = loginRateLimitKey("5.6.7.8", "a@b.com");
    const k3 = loginRateLimitKey("1.2.3.4", "other@b.com");
    for (let i = 0; i < LOGIN_LIMIT.max; i += 1) checkRateLimit(k1, LOGIN_LIMIT);
    expect(checkRateLimit(k1, LOGIN_LIMIT).allowed).toBe(false);
    expect(checkRateLimit(k2, LOGIN_LIMIT).allowed).toBe(true);
    expect(checkRateLimit(k3, LOGIN_LIMIT).allowed).toBe(true);
  });
});

// Rate limiting seam: the deployment runs ONE web process (render.yaml single
// service, docker-compose single web), so the default store is in-memory.
// The RateLimiter interface is the migration path — a shared-store (Redis/DB)
// implementation can replace InMemoryRateLimiter without touching call sites
// if the app ever scales horizontally. Until then, documented as
// single-process: never claim distributed protection.
//
// Contract: limit to N attempts per window per key. Returns 429 with
// Retry-After when exceeded. Never logs passwords or tokens.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
}

export interface RateLimiter {
  check(key: string, opts: { windowMs: number; max: number; now?: number }): RateLimitResult;
  reset(key?: string): void;
}

interface Bucket {
  count: number;
  windowStart: number;
}

class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPruneAt = 0;

  // Sweeps stale buckets — prevents unbounded memory growth.
  // Under normal load (<1k distinct IPs) memory is trivial; worst-case a
  // hostile sweep could grow the map — mitigation: periodic prune + cap.
  private prune(now: number, windowMs: number): void {
    if (now - this.lastPruneAt < windowMs) return;
    this.lastPruneAt = now;
    for (const [k, b] of this.buckets) {
      if (now - b.windowStart > windowMs * 2) this.buckets.delete(k);
    }
    // hard cap: if still huge, drop oldest (defense against hostile key spam)
    if (this.buckets.size > 5000) {
      const toDelete = this.buckets.size - 4000;
      let i = 0;
      for (const k of this.buckets.keys()) {
        if (i++ >= toDelete) break;
        this.buckets.delete(k);
      }
    }
  }

  check(
    key: string,
    opts: { windowMs: number; max: number; now?: number },
  ): RateLimitResult {
    const now = opts.now ?? Date.now();
    this.prune(now, opts.windowMs);
    const existing = this.buckets.get(key);
    if (!existing || now - existing.windowStart >= opts.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: opts.max - 1 };
    }
    if (existing.count < opts.max) {
      existing.count += 1;
      return { allowed: true, remaining: opts.max - existing.count };
    }
    const retryAfterMs = existing.windowStart + opts.windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}

// Process-wide default. All existing call sites go through these functions,
// so swapping the store is one line: setDefaultRateLimiter(new SharedLimiter).
let defaultLimiter: RateLimiter = new InMemoryRateLimiter();

export function setDefaultRateLimiter(limiter: RateLimiter): void {
  defaultLimiter = limiter;
}

export function checkRateLimit(
  key: string,
  opts: { windowMs: number; max: number; now?: number },
): RateLimitResult {
  return defaultLimiter.check(key, opts);
}

export function resetRateLimitForTest(key?: string): void {
  defaultLimiter.reset(key);
}

// Convenience for the login route: per-IP + per-email key so an attacker
// cannot rotate emails to bypass an IP limit, and legitimate users sharing
// an IP are not unnecessarily collateral-limited on email alone.
export function loginRateLimitKey(ip: string, emailLower: string): string {
  return `login:${ip}:${emailLower}`;
}

export const LOGIN_LIMIT = {
  // 5 attempts per 15 minutes per IP+email — conservative for brute-force
  // protection while remaining usable for legitimate retries.
  windowMs: 15 * 60 * 1000,
  max: 5,
} as const;

// Lightweight abuse protection for authenticated target mutations
// (Phase 15). Keyed per user, not per IP: every caller here is already
// authenticated, so per-user buckets avoid punishing users behind shared IPs.
// Generous by design (60/min) — legitimate UI flows and E2E (a handful of
// mutations per minute) never trip it; only runaway clients do.
export function mutationRateLimitKey(userId: string): string {
  return `mutation:${userId}`;
}

export const MUTATION_LIMIT = {
  windowMs: 60 * 1000,
  max: 60,
} as const;

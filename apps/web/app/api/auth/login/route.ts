import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = loginBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Email and password are required" } },
        { status: 400 },
      );
    }
    // Phase 10 P2 #1 — brute-force protection before any public exposure.
    // In-memory sliding window per IP+email; 429 with Retry-After on overflow.
    // Never logs passwords or tokens.
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const { checkRateLimit, loginRateLimitKey, LOGIN_LIMIT } = await import("@/lib/rate-limit");
    const rateKey = loginRateLimitKey(ip, parsed.data.email.toLowerCase());
    const limit = checkRateLimit(rateKey, LOGIN_LIMIT);
    if (!limit.allowed) {
      const retryAfterSec = Math.ceil((limit.retryAfterMs ?? LOGIN_LIMIT.windowMs) / 1000);
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many login attempts. Please try again later." } },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }
    const { verifyCredentials, startSessionForUser } = await import("@/lib/auth");
    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) {
      // Same response for unknown user vs wrong password.
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid email or password" } },
        { status: 401 },
      );
    }
    await startSessionForUser(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] login failure:", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Login failed" } },
      { status: 500 },
    );
  }
}

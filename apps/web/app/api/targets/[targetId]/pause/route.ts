import { NextRequest, NextResponse } from "next/server";
import { transitionTargetStatus } from "@igtrack/database";
import { getDatabase } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ targetId: string }> },
) {
  try {
    const session = await requireApiSession();
    const { checkRateLimit, mutationRateLimitKey, MUTATION_LIMIT } = await import("@/lib/rate-limit");
    const mutationLimit = checkRateLimit(mutationRateLimitKey(session.userId), MUTATION_LIMIT);
    if (!mutationLimit.allowed) {
      const retryAfterSec = Math.ceil((mutationLimit.retryAfterMs ?? MUTATION_LIMIT.windowMs) / 1000);
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } },
      );
    }
    const { targetId } = await ctx.params;
    const target = await transitionTargetStatus(getDatabase(), session.userId, targetId, "PAUSED");
    return NextResponse.json({ target: target satisfies object }, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

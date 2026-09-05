import { NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";
import { previewAccount } from "@/lib/account-preview";
import { usernameQuerySchema as querySchema } from "@/lib/username";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/targets/lookup?username=... — resolve a public account through the
// configured provider WITHOUT creating a target. Distinguishes live provider
// data from cached DB state: the response carries observedAt + source + a
// lastSynchronized:null marker so callers never confuse it with a snapshot.
// Mapping lives in lib/account-preview so the /lookup page renders identical
// outcomes without duplicating provider logic.
export async function GET(req: NextRequest) {
  try {
    const session = await requireApiSession();
    const { checkRateLimit, mutationRateLimitKey, MUTATION_LIMIT } = await import(
      "@/lib/rate-limit"
    );
    const limit = checkRateLimit(mutationRateLimitKey(session.userId), MUTATION_LIMIT);
    if (!limit.allowed) {
      const retryAfterSec = Math.ceil(
        (limit.retryAfterMs ?? MUTATION_LIMIT.windowMs) / 1000,
      );
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } },
      );
    }

    const raw = req.nextUrl.searchParams.get("username") ?? "";
    const { username } = querySchema.parse({ username: raw });

    const result = await previewAccount(username);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: NO_STORE,
    });
  } catch (err) {
    return respondError(err);
  }
}

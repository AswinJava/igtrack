import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getOwnedTargetDetail,
  updateOwnedTargetMeta,
  deleteOwnedTarget,
} from "@igtrack/database";
import { getDatabase } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const metaBody = z.object({
  localName: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ targetId: string }> },
) {
  try {
    const session = await requireApiSession();
    const { targetId: raw } = await ctx.params;
    const bundle = await getOwnedTargetDetail(getDatabase(), session.userId, raw);
    if (!bundle) {
      // Not found AND not-yours look identical by design.
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Target not found" } }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(bundle satisfies object, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

// PATCH /api/targets/:id - metadata only (name/notes/tags).
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ targetId: string }> },
) {
  try {
    const { isSameOrigin } = await import("@/lib/csrf");
    if (!isSameOrigin(req)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Cross-origin request rejected." } },
        { status: 403, headers: NO_STORE },
      );
    }
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
    const { targetId: raw } = await ctx.params;
    const parsed = metaBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Invalid metadata payload", details: parsed.error.flatten().fieldErrors } }, { status: 400, headers: NO_STORE });
    }
    const { localName, notes, tags } = parsed.data;
    const updated = await updateOwnedTargetMeta(getDatabase(), {
      userId: session.userId,
      targetId: raw,
      ...(localName !== undefined ? { localName } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
    return NextResponse.json({ target: updated satisfies object }, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ targetId: string }> },
) {
  try {
    const { isSameOrigin } = await import("@/lib/csrf");
    if (!isSameOrigin(req)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Cross-origin request rejected." } },
        { status: 403, headers: NO_STORE },
      );
    }
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
    const { targetId: raw } = await ctx.params;
    const deleted = await deleteOwnedTarget(getDatabase(), session.userId, raw);
    if (!deleted) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Target not found" } }, { status: 404, headers: NO_STORE });
    }
    // Observations/evidence were removed via the retention boundary;
    // ig_accounts intentionally survives as shared registry state.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return respondError(err);
  }
}
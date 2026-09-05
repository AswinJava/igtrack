import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  enqueueJob,
  getOwnedTarget,
  kindsForTarget,
  SCHEDULABLE_KINDS,
} from "@igtrack/database";
import { getDatabase } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

const syncBody = z.object({
  kinds: z
    .array(z.enum(SCHEDULABLE_KINDS as unknown as [string, ...string[]]))
    .max(SCHEDULABLE_KINDS.length)
    .optional(),
});

// POST /api/targets/:targetId/sync — manually trigger an observation round
// for an ACTIVE target. Enqueues one job per requested (default: enabled)
// scan kind with minute-bucketed idempotency keys, so an accidental double
// click collapses instead of flooding the queue, while a later explicit
// trigger still enqueues fresh work. Same-kind serialization in the queue
// prevents concurrent duplicate scans. Paused targets get 409: the worker
// would skip the jobs anyway, and silence would lie about it.
export async function POST(
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
    const { targetId } = await ctx.params;
    const db = getDatabase();
    const target = await getOwnedTarget(db, session.userId, targetId);
    if (target === null) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Target not found" } },
        { status: 404, headers: NO_STORE },
      );
    }
    if (target.status !== "ACTIVE") {
      return NextResponse.json(
        {
          error: {
            code: "TARGET_PAUSED",
            message: "Target is not active; resume monitoring before triggering a manual sync.",
          },
        },
        { status: 409, headers: NO_STORE },
      );
    }
    let kinds = kindsForTarget(target.scanKinds);
    const raw = await req.json().catch(() => ({}));
    const parsed = syncBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid sync payload",
            details: parsed.error.flatten().fieldErrors,
          },
        },
        { status: 400, headers: NO_STORE },
      );
    }
    if (parsed.data.kinds !== undefined && parsed.data.kinds.length > 0) {
      const wanted = new Set(parsed.data.kinds);
      kinds = kinds.filter((k) => wanted.has(k));
    }
    // Minute bucket: double-click safe, later triggers still fresh work.
    const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const queued: string[] = [];
    let deduplicated = 0;
    for (const kind of kinds) {
      const { deduplicated: dup } = await enqueueJob(db, {
        kind,
        targetId: target.id,
        idempotencyKey: `manual:${target.id}:${kind}:${bucket}`,
        payload: { trigger: "manual" },
      });
      if (dup) deduplicated += 1;
      else queued.push(kind);
    }
    return NextResponse.json({ queued, deduplicated }, { status: 202, headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

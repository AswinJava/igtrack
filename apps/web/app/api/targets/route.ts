import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createTarget,
  enqueueJob,
  listTargetsForUser,
} from "@igtrack/database";
import { getDatabase } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const createBody = z.object({
  username: z
    .string()
    .min(1)
    .max(40)
    .transform((v) => v.trim().replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]+$/, "invalid Instagram username")),
  localName: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

// POST /api/targets — create a monitoring target for the authenticated user.
// Creating does NOT assume Instagram availability: observation is queued and
// executed through the provider capability pipeline.
export async function POST(req: NextRequest) {
  try {
    const session = await requireApiSession();
    // Lightweight per-user abuse protection (Phase 15). Single-process and
    // generous (60/min) — legitimate use never trips it.
    const { checkRateLimit, mutationRateLimitKey, MUTATION_LIMIT } = await import("@/lib/rate-limit");
    const mutationLimit = checkRateLimit(mutationRateLimitKey(session.userId), MUTATION_LIMIT);
    if (!mutationLimit.allowed) {
      const retryAfterSec = Math.ceil((mutationLimit.retryAfterMs ?? MUTATION_LIMIT.windowMs) / 1000);
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } },
      );
    }
    const body = createBody.parse(await req.json());

    const db = getDatabase();
    const { target, created } = await createTarget(db, {
      userId: session.userId,
      username: body.username,
      ...(body.localName !== undefined ? { localName: body.localName } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
    });

    let jobsQueued = false;
    if (created) {
      // Initial observation loop. Idempotency keys make re-runs safe.
      await enqueueJob(db, {
        kind: "PROFILE_SCAN",
        targetId: target.id,
        idempotencyKey: `initial:${target.id}:PROFILE_SCAN`,
        payload: { trigger: "initial" },
      });
      await enqueueJob(db, {
        kind: "FOLLOWER_SCAN",
        targetId: target.id,
        priority: -1,
        idempotencyKey: `initial:${target.id}:FOLLOWER_SCAN`,
        payload: { trigger: "initial" },
      });
      jobsQueued = true;
    }

    return NextResponse.json(
      {
        target: {
          id: target.id,
          localName: target.localName,
          status: target.status,
          tags: target.tags,
          createdAt: target.createdAt,
        },
        deduplicated: !created,
        jobsQueued,
      },
      { status: created ? 201 : 200, headers: NO_STORE },
    );
  } catch (err) {
    return respondError(err);
  }
}

// GET /api/targets — list only targets owned by the authenticated user.
export async function GET() {
  try {
    const session = await requireApiSession();
    const targets = await listTargetsForUser(getDatabase(), session.userId);
    return NextResponse.json({ targets }, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

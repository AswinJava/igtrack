import { NextRequest, NextResponse } from "next/server";
import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
import {
  createTarget,
  enqueueJob,
  listTargetsForUser,
} from "@igtrack/database";
import { getDatabase } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";
import { targetCreateSchema as createBody } from "@/lib/target-validation";
import { getProvider } from "@/lib/provider";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// POST /api/targets — create a monitoring target for the authenticated user.
// The username must resolve through the configured provider first; only then
// is the target row created and the initial observation loop queued.
export async function POST(req: NextRequest) {
  try {
    const { isSameOrigin } = await import("@/lib/csrf");
    if (!isSameOrigin(req)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Cross-origin request rejected." } },
        { status: 403, headers: NO_STORE },
      );
    }
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

    // A target is only created for an account the configured provider can
    // actually resolve: nonexistent names get 404, private accounts 403, so
    // no target is ever created from an invalid preview. Transient provider
    // trouble surfaces as 502/503 and creates nothing.
    const resolved = await getProvider().resolveAccount(body.username);
    if (resolved.status === CapabilityStatus.ERROR) {
      const kind = resolved.error?.kind;
      if (kind === CapabilityErrorKind.ACCOUNT_NOT_FOUND) {
        return NextResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `No public account @${body.username} is observable from this source.`,
            },
          },
          { status: 404, headers: NO_STORE },
        );
      }
      if (kind === CapabilityErrorKind.ACCOUNT_PRIVATE) {
        return NextResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: `Account @${body.username} is private; public monitoring is unavailable.`,
            },
          },
          { status: 403, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        {
          error: {
            code: "PROVIDER_ERROR",
            message: resolved.error?.message ?? "Provider temporarily unavailable.",
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }
    if (resolved.status === CapabilityStatus.UNAVAILABLE) {
      return NextResponse.json(
        {
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: resolved.note ?? "Account resolution is unavailable from this source.",
          },
        },
        { status: 503, headers: NO_STORE },
      );
    }

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
      // Initial observation loop: one job per scan executor so the first
      // sync populates profile, followers, following, stories, and posts
      // together. Idempotency keys make re-runs safe.
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
      await enqueueJob(db, {
        kind: "FOLLOWING_SCAN",
        targetId: target.id,
        priority: -1,
        idempotencyKey: `initial:${target.id}:FOLLOWING_SCAN`,
        payload: { trigger: "initial" },
      });
      await enqueueJob(db, {
        kind: "STORY_SCAN",
        targetId: target.id,
        priority: -1,
        idempotencyKey: `initial:${target.id}:STORY_SCAN`,
        payload: { trigger: "initial" },
      });
      await enqueueJob(db, {
        kind: "POSTS_SCAN",
        targetId: target.id,
        priority: -1,
        idempotencyKey: `initial:${target.id}:POSTS_SCAN`,
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

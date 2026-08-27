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

export async function POST(req: NextRequest) {
  try {
    const session = await requireApiSession();
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
      // Initial observation loop: profile scan first, follower scan after.
      // Idempotency keys make re-runs of this flow safe.
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
          username: body.username,
          status: target.status,
          localName: target.localName,
          tags: target.tags,
          createdAt: target.createdAt,
        },
        deduplicated: !created,
        jobsQueued,
      },
      { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return respondError(err);
  }
}

export function GET() {
  return NextResponse.json(
    { error: { code: "VALIDATION_ERROR", message: "Use POST to create targets" } },
    { status: 405 },
  );
}

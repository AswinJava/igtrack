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
    const { targetId } = await ctx.params;
    const target = await transitionTargetStatus(getDatabase(), session.userId, targetId, "PAUSED");
    return NextResponse.json({ target: target satisfies object }, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

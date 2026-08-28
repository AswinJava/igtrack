import { NextResponse } from "next/server";
import { isDevLoginEnabled, startSessionForUser, findUserByEmailSafe } from "@/lib/dev-users";

export const dynamic = "force-dynamic";

async function devLogin(request: Request): Promise<NextResponse> {
  // Hard production gate. This endpoint must not exist operationally in prod.
  if (!isDevLoginEnabled()) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  }
  const user = await findUserByEmailSafe("dev@igtrack.local");
  if (!user) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "No dev user - run db:seed" } }, { status: 404 });
  }
  await startSessionForUser(user.id);
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  return NextResponse.redirect(new URL('/', base), 303);
}

export async function POST(request: Request) {
  return devLogin(request);
}

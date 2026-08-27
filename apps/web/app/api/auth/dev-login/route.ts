import { NextResponse } from "next/server";
import { isDevLoginEnabled, startSessionForUser, findUserByEmailSafe } from "@/lib/dev-users";

export const dynamic = "force-dynamic";

async function devLogin(): Promise<NextResponse> {
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
  return NextResponse.redirect(new URL("/", process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"), 303);
}

export async function POST() {
  return devLogin();
}

import { NextResponse } from "next/server";
import { getDevUser, isDevLoginEnabled, startSessionForUser } from "@/lib/auth";

function redirectToApp(): NextResponse {
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return NextResponse.redirect(new URL("/", base), 303);
}

// POST only — issuing a session must never be a linkable, pre-fetchable GET.
// Gating lives in @/lib/auth so every entry point shares one source of truth.
export async function POST() {
  if (!isDevLoginEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const user = await getDevUser();
  if (user === null) {
    return NextResponse.json({ error: "No dev user — run db:seed" }, { status: 404 });
  }
  await startSessionForUser(user.id);
  return redirectToApp();
}

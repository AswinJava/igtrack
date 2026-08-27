import { NextResponse } from "next/server";
import { endCurrentSession } from "@/lib/auth";

function redirectToLogin(): NextResponse {
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  return NextResponse.redirect(new URL("/login", base), 303);
}

// POST only — logging out must never be triggerable by a pre-fetched link.
export async function POST() {
  await endCurrentSession();
  return redirectToLogin();
}

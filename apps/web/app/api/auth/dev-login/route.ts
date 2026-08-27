import { NextResponse } from "next/server";
import { getDevUser, createSession } from "@/lib/auth";

export async function POST() {
  const user = await getDevUser();
  if (!user) {
    return NextResponse.json({ error: "No dev user — run db:seed" }, { status: 404 });
  }
  await createSession(user.id, user.email);
  return NextResponse.redirect(new URL("/", process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"), 303);
}

export async function GET() {
  return POST();
}

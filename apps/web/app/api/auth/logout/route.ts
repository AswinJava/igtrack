import { NextResponse } from "next/server";
import { endCurrentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await endCurrentSession();
  return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"), 303);
}

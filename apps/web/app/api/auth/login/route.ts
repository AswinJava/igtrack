import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = loginBody.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Email and password are required" } },
        { status: 400 },
      );
    }
    const { verifyCredentials, startSessionForUser } = await import("@/lib/auth");
    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) {
      // Same response for unknown user vs wrong password.
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid email or password" } },
        { status: 401 },
      );
    }
    await startSessionForUser(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] login failure:", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Login failed" } },
      { status: 500 },
    );
  }
}

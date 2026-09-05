import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";
import { getCapabilityDiagnostic } from "@/lib/capability-diagnostic";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/diagnostics/capabilities — secret-free self-diagnostic: which
// provider is active, what it can observe, scheduler/worker configuration,
// source health, and provider call metrics. Never includes tokens, cookies,
// or credentials; graph identity is limited to username + account id.
export async function GET() {
  try {
    await requireApiSession();
    const diagnostic = await getCapabilityDiagnostic();
    return NextResponse.json(diagnostic, { headers: NO_STORE });
  } catch (err) {
    return respondError(err);
  }
}

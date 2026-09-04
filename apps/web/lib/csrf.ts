import type { NextRequest } from "next/server";

// Cookie-authed JSON mutations rely on SameSite=Lax plus this same-origin
// check. Requests without Origin/Referer (same-origin navigations, curl with
// cookies) pass; cross-origin Origins are rejected.
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) return true;
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const expected = `${req.nextUrl.protocol}//${host}`;
  if (origin && origin !== expected) return false;
  if (!origin && referer) {
    try {
      const refUrl = new URL(referer);
      if (`${refUrl.protocol}//${refUrl.host}` !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

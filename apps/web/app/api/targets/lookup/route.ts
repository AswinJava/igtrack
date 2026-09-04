import { NextRequest, NextResponse } from "next/server";
import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
import { requireApiSession } from "@/lib/auth";
import { respondError } from "@/lib/api-helpers";
import { getProvider } from "@/lib/provider";
import { usernameQuerySchema as querySchema } from "@/lib/username";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /api/targets/lookup?username=... — resolve a public account through the
// configured provider WITHOUT creating a target. Distinguishes live provider
// data from cached DB state: the response carries observedAt + source + a
// lastSynchronized:null marker so callers never confuse it with a snapshot.
export async function GET(req: NextRequest) {
  try {
    const session = await requireApiSession();
    const { checkRateLimit, mutationRateLimitKey, MUTATION_LIMIT } = await import(
      "@/lib/rate-limit"
    );
    const limit = checkRateLimit(mutationRateLimitKey(session.userId), MUTATION_LIMIT);
    if (!limit.allowed) {
      const retryAfterSec = Math.ceil(
        (limit.retryAfterMs ?? MUTATION_LIMIT.windowMs) / 1000,
      );
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfterSec) } },
      );
    }

    const raw = req.nextUrl.searchParams.get("username") ?? "";
    const { username } = querySchema.parse({ username: raw });

    const provider = getProvider();
    const resolved = await provider.resolveAccount(username);
    if (resolved.status === CapabilityStatus.ERROR) {
      const kind = resolved.error?.kind;
      if (kind === CapabilityErrorKind.ACCOUNT_NOT_FOUND) {
        return NextResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: `No public account @${username} is observable from this source.`,
            },
          },
          { status: 404, headers: NO_STORE },
        );
      }
      if (kind === CapabilityErrorKind.ACCOUNT_PRIVATE) {
        return NextResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: `Account @${username} is private; public lookup is unavailable.`,
            },
          },
          { status: 403, headers: NO_STORE },
        );
      }
      if (
        kind === CapabilityErrorKind.RATE_LIMITED ||
        kind === CapabilityErrorKind.TIMEOUT ||
        kind === CapabilityErrorKind.NETWORK
      ) {
        return NextResponse.json(
          {
            error: {
              code: "PROVIDER_ERROR",
              message: resolved.error?.message ?? "Provider temporarily unavailable.",
            },
          },
          { status: 502, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        {
          error: {
            code: "PROVIDER_ERROR",
            message: resolved.error?.message ?? "Provider lookup failed.",
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }

    if (resolved.status === CapabilityStatus.UNAVAILABLE) {
      return NextResponse.json(
        {
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: resolved.note ?? "Account resolution is unavailable from this source.",
          },
        },
        { status: 503, headers: NO_STORE },
      );
    }

    const account = resolved.data;
    if (!account) {
      return NextResponse.json(
        { error: { code: "PROVIDER_ERROR", message: "Provider returned no account data." } },
        { status: 502, headers: NO_STORE },
      );
    }

    const profile = await provider.getProfile(account);
    if (profile.status === CapabilityStatus.ERROR) {
      const kind = profile.error?.kind;
      if (kind === CapabilityErrorKind.ACCOUNT_PRIVATE) {
        return NextResponse.json(
          {
            account: {
              username: account.username,
              displayName: account.displayName ?? null,
              isPrivate: true,
            },
            profile: null,
            private: true,
            observedAt: profile.observedAt,
            sourceId: profile.source.sourceId,
            lastSynchronized: null,
          },
          { headers: NO_STORE },
        );
      }
      return NextResponse.json(
        {
          account: {
            username: account.username,
            displayName: account.displayName ?? null,
            isPrivate: account.isPrivate ?? null,
          },
          profile: null,
          profileError: profile.error?.message ?? "Profile unavailable.",
          observedAt: profile.observedAt,
          sourceId: profile.source.sourceId,
          lastSynchronized: null,
        },
        { headers: NO_STORE },
      );
    }

    return NextResponse.json(
      {
        account: {
          username: account.username,
          displayName: account.displayName ?? profile.data?.account.displayName ?? null,
          isPrivate: account.isPrivate ?? null,
          igId: account.igId ?? null,
        },
        profile: profile.data
          ? {
              bio: profile.data.bio ?? null,
              followerCount: profile.data.followerCount ?? null,
              followingCount: profile.data.followingCount ?? null,
              postCount: profile.data.postCount ?? null,
              isVerified: profile.data.isVerified ?? null,
              profilePicUrl: profile.data.profilePicUrl ?? null,
              externalUrl: profile.data.externalUrl ?? null,
            }
          : null,
        observedAt: profile.observedAt ?? resolved.observedAt,
        sourceId: profile.source.sourceId,
        rawReference: profile.rawReference ?? resolved.rawReference ?? null,
        lastSynchronized: null,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return respondError(err);
  }
}

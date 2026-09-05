import { CapabilityErrorKind, CapabilityStatus } from "@igtrack/core";
import { getProvider } from "./provider.js";

// Shared account-preview pipeline for the lookup API route and the /lookup
// page: resolve through the configured provider WITHOUT creating anything.
// Every outcome is explicit — the caller maps status to HTTP or renders it.
// lastSynchronized is always null: a preview is live provider data, never a
// stored snapshot, and must never be confused with one.
export interface PreviewBody {
  error?: { code: string; message?: string };
  account?: {
    username: string;
    displayName?: string | null;
    isPrivate?: boolean | null;
    igId?: string | null;
  };
  profile?: {
    bio?: string | null;
    followerCount?: number | null;
    followingCount?: number | null;
    postCount?: number | null;
    isVerified?: boolean | null;
    profilePicUrl?: string | null;
    externalUrl?: string | null;
  } | null;
  profileError?: string;
  private?: boolean;
  observedAt?: string;
  sourceId?: string;
  rawReference?: string | null;
  lastSynchronized?: null;
}

export interface PreviewResult {
  status: number;
  body: PreviewBody;
  retryAfterSec?: number;
}

export async function previewAccount(username: string): Promise<PreviewResult> {
  const provider = getProvider();
  const resolved = await provider.resolveAccount(username);
  if (resolved.status === CapabilityStatus.ERROR) {
    const kind = resolved.error?.kind;
    if (kind === CapabilityErrorKind.ACCOUNT_NOT_FOUND) {
      return {
        status: 404,
        body: {
          error: {
            code: "NOT_FOUND",
            message: `No public account @${username} is observable from this source.`,
          },
        },
      };
    }
    if (kind === CapabilityErrorKind.ACCOUNT_PRIVATE) {
      return {
        status: 403,
        body: {
          error: {
            code: "FORBIDDEN",
            message: `Account @${username} is private; public lookup is unavailable.`,
          },
        },
      };
    }
    if (
      kind === CapabilityErrorKind.RATE_LIMITED ||
      kind === CapabilityErrorKind.TIMEOUT ||
      kind === CapabilityErrorKind.NETWORK
    ) {
      return {
        status: 502,
        body: {
          error: {
            code: "PROVIDER_ERROR",
            message: resolved.error?.message ?? "Provider temporarily unavailable.",
          },
        },
      };
    }
    return {
      status: 502,
      body: {
        error: {
          code: "PROVIDER_ERROR",
          message: resolved.error?.message ?? "Provider lookup failed.",
        },
      },
    };
  }

  if (resolved.status === CapabilityStatus.UNAVAILABLE) {
    return {
      status: 503,
      body: {
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: resolved.note ?? "Account resolution is unavailable from this source.",
        },
      },
    };
  }

  const account = resolved.data;
  if (!account) {
    return {
      status: 502,
      body: { error: { code: "PROVIDER_ERROR", message: "Provider returned no account data." } },
    };
  }

  const profile = await provider.getProfile(account);
  if (profile.status === CapabilityStatus.ERROR) {
    const kind = profile.error?.kind;
    if (kind === CapabilityErrorKind.ACCOUNT_PRIVATE) {
      return {
        status: 200,
        body: {
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
      };
    }
    return {
      status: 200,
      body: {
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
    };
  }

  return {
    status: 200,
    body: {
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
  };
}

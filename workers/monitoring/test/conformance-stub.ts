import {
  available,
  Confidence,
  ObservationCategory,
  SourceKind,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedFollowPage,
  type NormalizedProfile,
  type NormalizedStory,
  type ProviderCapabilities,
} from "@igtrack/core";
import type { ExecutionSource } from "../src/index.js";

// Shared stub provider for provider-boundary tests (PC-T1, PC-T2, ST).
export interface StubConfig {
  capabilities?: Partial<ProviderCapabilities>;
  getProfile?: () => Promise<CapabilityResult<NormalizedProfile>>;
  getStories?: () => Promise<CapabilityResult<NormalizedStory[]>>;
  getFollowers?: () => Promise<CapabilityResult<NormalizedFollowPage>>;
  getFollowing?: () => Promise<CapabilityResult<NormalizedFollowPage>>;
}

export const STUB_PROFILE: NormalizedProfile = {
  account: { username: "target_a", isPrivate: false },
  isVerified: false,
  meta: {
    category: ObservationCategory.OBSERVED,
    confidence: Confidence.HIGH,
    observedAt: "2026-08-27T09:15:00.000Z",
  },
};

export function stubSource(config: StubConfig = {}): ExecutionSource {
  const sourceRef = { sourceId: "stub:boundary", kind: SourceKind.FIXTURE };
  const provider: InstagramProvider = {
    sourceId: "stub:boundary",
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
      ...config.capabilities,
    }),
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile:
      config.getProfile ??
      (async () =>
        available(STUB_PROFILE, {
          observedAt: STUB_PROFILE.meta.observedAt,
          source: sourceRef,
          confidence: Confidence.HIGH,
        })),
    getStories:
      config.getStories ??
      (async () => {
        throw new Error("stub: getStories not wired");
      }),
    getFollowers:
      config.getFollowers ??
      (async () => {
        throw new Error("stub: getFollowers not wired");
      }),
    getFollowing:
      config.getFollowing ??
      (async () => {
        throw new Error("stub: getFollowing not wired");
      }),
    getPublicPosts: async () => {
      throw new Error("stub: getPublicPosts not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
  };
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "boundary stub" },
  };
}

// Type-only re-export so tests can reference the follow-page shape without
// importing from engine-specific paths.
export type { NormalizedFollowPage } from "@igtrack/core";
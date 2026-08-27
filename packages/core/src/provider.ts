import type { CapabilityResult } from "./capability.js";
import type {
  NormalizedAccountRef,
  NormalizedComment,
  NormalizedFollowPage,
  NormalizedPost,
  NormalizedProfile,
  NormalizedStory,
} from "./models.js";

export const CapabilityName = {
  RESOLVE_ACCOUNT: "resolveAccount",
  GET_PROFILE: "getProfile",
  GET_STORIES: "getStories",
  GET_FOLLOWERS: "getFollowers",
  GET_FOLLOWING: "getFollowing",
  GET_PUBLIC_POSTS: "getPublicPosts",
  GET_PUBLIC_COMMENTS: "getPublicComments",
} as const;

export type CapabilityName =
  (typeof CapabilityName)[keyof typeof CapabilityName];

export type ProviderCapabilities = Record<CapabilityName, boolean>;

export interface Cursor {
  value: string;
}

export interface InstagramProvider {
  readonly sourceId: string;
  capabilities(): ProviderCapabilities;
  resolveAccount(username: string): Promise<CapabilityResult<NormalizedAccountRef>>;
  getProfile(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedProfile>>;
  getStories(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedStory[]>>;
  getFollowers(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>>;
  getFollowing(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>>;
  getPublicPosts(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>>;
  getPublicComments(
    post: NormalizedPost,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>>;
}

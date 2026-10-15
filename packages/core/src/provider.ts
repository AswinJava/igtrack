import type { CapabilityResult } from "./capability.js";
import type {
  NormalizedAccountRef,
  NormalizedComment,
  NormalizedFollowPage,
  NormalizedInsightSet,
  NormalizedPost,
  NormalizedPostChild,
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
  GET_POST_CHILDREN: "getPostChildren",
  GET_ACCOUNT_INSIGHTS: "getAccountInsights",
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
  /**
   * PRODUCT STATUS: provider-level AVAILABLE in fixture:v1 (synthetic posts +
   * comments for the fixture target) and the official Graph API (owned
   * account media + comments), consumed end-to-end by the POSTS_SCAN executor
   * (persistence in posts/post_comments, evidence, content tab). Multi-page
   * listings resume via CapabilityResult.nextCursor; a result without
   * nextCursor is a complete listing. Highlights, reels-as-distinct-type, and
   * likes have no provider method anywhere — those stay UNAVAILABLE.
   */
  getPublicPosts(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>>;
  /** PRODUCT STATUS — see getPublicPosts. */
  getPublicComments(
    post: NormalizedPost,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>>;
  /**
   * Album children for one post. Called only for provider-declared CAROUSEL
   * posts; providers without a child source honestly report UNAVAILABLE.
   * No pagination: albums are bounded single responses.
   */
  getPostChildren(post: NormalizedPost): Promise<CapabilityResult<NormalizedPostChild[]>>;
  /**
   * PRODUCT STATUS: provider-level AVAILABLE via the documented IG User
   * insights edge (owned account). A metric the platform does not return is
   * reported as an absence WITH a reason (documented rules: below 100
   * followers, 48 h demographic delay, empty-data-set for unavailable
   * metrics) — never as zero and never as a fabricated point. Providers
   * whose source carries no insight metrics honestly report UNAVAILABLE.
   */
  getAccountInsights(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedInsightSet>>;
}

import type { CapabilityResult } from "./capability.js";
import type {
  NormalizedAccountRef,
  NormalizedComment,
  NormalizedDiscoveredAccount,
  NormalizedFollowPage,
  NormalizedInsightSet,
  NormalizedMentionedComment,
  NormalizedPost,
  NormalizedPostChild,
  NormalizedProfile,
  NormalizedStory,
  NormalizedTagPage,
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
  GET_TAGS: "getTags",
  GET_MENTIONED_COMMENT: "getMentionedComment",
  GET_ACCOUNT_INSIGHTS: "getAccountInsights",
  DISCOVER_ACCOUNT: "discoverAccount",
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
  /**
   * LOCAL identity predicate: does this provider observe the named account?
   *
   * The answer must be a pure local check — configuration, a manifest, an
   * in-memory string comparison — never a network read. It is not an
   * observation and must never be reported as one; it only says which
   * account this source is allowed to speak about.
   *
   * The worker asks BEFORE it writes anything under a target. A source that
   * observes one account (a fixture set, the operator's own export, the
   * authorized Graph account) must never answer for another one: serving
   * account A's bytes under account B's record is how synthetic or foreign
   * data becomes evidence about a real account.
   *
   * Optional: a provider that does not implement it asserts nothing, and the
   * worker cannot gate on it. The three shipped providers implement it.
   */
  observesAccount?(username: string): Promise<boolean>;
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
   * Media owned by OTHER accounts in which this account was tagged (the
   * documented IG User `tags` edge; the edge exists on the owned account
   * only). Rows are references — first-observed records of who tagged the
   * account — never diffed and never rendered as the account's own media. A
   * complete empty listing IS a claim (no tags observed); a provider without
   * the edge reports UNAVAILABLE with the reason.
   */
  getTags(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedTagPage>>;
  /**
   * The documented IG User `mentioned_comment` field expansion: one comment
   * on someone else's media in which this account was @mentioned, read by id.
   * The platform publishes no listing edge — ids arrive via Meta webhook
   * notifications — so this is an on-demand read, not a feed. Providers
   * without the route report UNAVAILABLE with the reason.
   */
  getMentionedComment(
    account: NormalizedAccountRef,
    commentId: string,
  ): Promise<CapabilityResult<NormalizedMentionedComment>>;
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
  /**
   * Other-account public data via the documented Business Discovery edge:
   * public profile fields + a bounded recent-media preview, for public
   * Business/Creator accounts only. A PROBE, not a record — callers render
   * it, nothing is persisted, so no evidence row is owed. Providers with no
   * discovery route report UNAVAILABLE with the reason (and the unlock path
   * when one exists); unreachable classes (consumer, private, age-gated)
   * report UNAVAILABLE with the platform's reason, never an empty profile.
   * The platform id of the discovered account travels in
   * `account.igId` when the platform returned one — it is an output, never a
   * lookup key.
   */
  discoverAccount(username: string): Promise<CapabilityResult<NormalizedDiscoveredAccount>>;
}

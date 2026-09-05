import {
  available,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  Confidence,
  errored,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type MediaType,
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedFollowPage,
  type NormalizedPost,
  type NormalizedPostChild,
  type NormalizedProfile,
  type NormalizedStory,
  type ProviderCapabilities,
  type SourceRef,
} from "@igtrack/core";

export interface GraphProviderConfig {
  accessToken: string;
  igUserId: string;
  username: string;
  apiVersion?: string;
}

// Documented request shapes, exported so the field-coverage audit
// (field-coverage.ts) can pin them without parsing source. Every name here
// must exist in the Meta IG reference for this login type — an unknown field
// fails the whole call, so additions need docs evidence, not guesses.
export const GRAPH_PROFILE_FIELDS =
  "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website";
export const GRAPH_MEDIA_FIELDS =
  "id,caption,timestamp,like_count,comments_count,permalink,shortcode,media_type,media_product_type";
export const GRAPH_CHILD_FIELDS = "id,media_type,permalink,shortcode,timestamp";
export const GRAPH_STORY_FIELDS = "id,timestamp,media_type,caption";
export const GRAPH_COMMENT_FIELDS =
  "id,text,username,timestamp,parent_id,like_count,from{id,username},replies{id,text,username,timestamp,parent_id,like_count,from{id,username}}";

// Authorized Graph API provider: talks ONLY to Meta's official Instagram
// Graph API, and ONLY about the owned Business/Creator account whose token
// the founder provisioned. No scraping, no private-API, no credential
// handling beyond reading env at construction. The token travels in the
// Authorization header and is never logged, persisted, or returned.
export function graphConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): GraphProviderConfig {
  const missing: string[] = [];
  if (!env.IGTRACK_GRAPH_ACCESS_TOKEN) missing.push("IGTRACK_GRAPH_ACCESS_TOKEN");
  if (!env.IGTRACK_GRAPH_IG_USER_ID) missing.push("IGTRACK_GRAPH_IG_USER_ID");
  if (!env.IGTRACK_GRAPH_USERNAME) missing.push("IGTRACK_GRAPH_USERNAME");
  if (missing.length > 0) {
    throw new Error(
      `igtrack graph provider: missing required env: ${missing.join(", ")}. ` +
        `Provision an owned Business/Creator account + Meta app + long-lived token; ` +
        `never commit token values — env/secret-store only.`,
    );
  }
  return {
    accessToken: env.IGTRACK_GRAPH_ACCESS_TOKEN as string,
    igUserId: env.IGTRACK_GRAPH_IG_USER_ID as string,
    username: (env.IGTRACK_GRAPH_USERNAME as string).toLowerCase(),
    ...(env.IGTRACK_GRAPH_API_VERSION !== undefined
      ? { apiVersion: env.IGTRACK_GRAPH_API_VERSION }
      : {}),
  };
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Provider-declared Graph media_type token → MediaType. IMAGE/VIDEO map
 * directly, CAROUSEL_ALBUM maps to CAROUSEL, anything else stays UNKNOWN —
 * never inferred from any other signal.
 */
export function mapGraphMediaType(raw: string | undefined): MediaType {
  if (raw === "IMAGE") return "IMAGE";
  if (raw === "VIDEO") return "VIDEO";
  if (raw === "CAROUSEL_ALBUM") return "CAROUSEL";
  return "UNKNOWN";
}

/**
 * Derive the canonical shortcode from an Instagram permalink
 * (…/p/SHORTCODE/, …/reel/SHORTCODE/, …/tv/SHORTCODE/). Returns undefined
 * when the URL carries no recognizable shortcode — callers keep shortcode
 * absent rather than storing a guess.
 */
export function shortcodeFromPermalink(permalink: string | undefined): string | undefined {
  if (permalink === undefined) return undefined;
  const match = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(permalink);
  return match?.[1];
}

/**
 * Provider shortcode when the response carries one, else the permalink
 * parse. Provider truth wins; the parse is a fallback, never a guess from
 * any other signal.
 */
export function shortcodeFor(
  shortcode: string | undefined,
  permalink: string | undefined,
): string | undefined {
  if (typeof shortcode === "string" && shortcode.length > 0) return shortcode;
  return shortcodeFromPermalink(permalink);
}

export class GraphProvider implements InstagramProvider {
  readonly sourceId = "graph:v1";

  private readonly token: string;
  private readonly igUserId: string;
  private readonly ownedUsername: string;
  private readonly baseUrl: string;

  constructor(config: GraphProviderConfig) {
    this.token = config.accessToken;
    this.igUserId = config.igUserId;
    this.ownedUsername = config.username.toLowerCase();
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion ?? "v21.0"}`;
  }

  capabilities(): ProviderCapabilities {
    return {
      [CapabilityName.RESOLVE_ACCOUNT]: true,
      [CapabilityName.GET_PROFILE]: true,
      [CapabilityName.GET_STORIES]: true,
      [CapabilityName.GET_FOLLOWERS]: false,
      [CapabilityName.GET_FOLLOWING]: false,
      [CapabilityName.GET_PUBLIC_POSTS]: true,
      [CapabilityName.GET_PUBLIC_COMMENTS]: true,
      [CapabilityName.GET_POST_CHILDREN]: true,
    };
  }

  private meta(account?: NormalizedAccountRef): { observedAt: string; source: SourceRef } {
    return {
      observedAt: new Date().toISOString(),
      source: {
        sourceId: this.sourceId,
        kind: SourceKind.GRAPH_API,
        ...(account !== undefined ? { reference: account.username } : {}),
      },
    };
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw graphFailure(CapabilityErrorKind.TIMEOUT, "Graph API request timed out", true);
      }
      throw graphFailure(
        CapabilityErrorKind.NETWORK,
        err instanceof Error ? err.message : "Graph API network failure",
        true,
      );
    }
    if (res.ok) return (await res.json()) as T;
    throw await graphHttpFailure(res);
  }

  async resolveAccount(username: string): Promise<CapabilityResult<NormalizedAccountRef>> {
    const meta = this.meta();
    // The Graph path observes the authorized owned account only. Any other
    // username is honestly NOT_FOUND here — never probed, never scraped.
    if (username.toLowerCase() !== this.ownedUsername) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `Graph provider only observes the authorized owned account @${this.ownedUsername}; @${username} is not observable through it`,
        retryable: false,
      });
    }
    try {
      const data = await this.get<{ id: string; username: string }>(
        `/${this.igUserId}`,
        { fields: "id,username" },
      );
      return available(
        { username: data.username, igId: data.id },
        { ...meta, confidence: Confidence.HIGH },
      );
    } catch (err) {
      return providerFailure(meta, err);
    }
  }

  async getProfile(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedProfile>> {
    const meta = this.meta(account);
    try {
      const data = await this.get<{
        id: string;
        username: string;
        name?: string;
        biography?: string;
        profile_picture_url?: string;
        followers_count?: number;
        follows_count?: number;
        media_count?: number;
        // Documented public IG User field (Meta IG User reference). The only
        // external-link slot the provider exposes — mapped to externalUrl.
        // No account_type / is_verified / category field exists on the node,
        // so those stay absent rather than fabricated.
        website?: string;
      }>(`/${this.igUserId}`, {
        fields: GRAPH_PROFILE_FIELDS,
      });
      return available(
        {
          account: {
            username: data.username,
            igId: data.id,
            ...(data.name !== undefined ? { displayName: data.name } : {}),
          },
          ...(data.biography !== undefined ? { bio: data.biography } : {}),
          ...(data.profile_picture_url !== undefined
            ? { profilePicUrl: data.profile_picture_url }
            : {}),
          ...(data.followers_count !== undefined ? { followerCount: data.followers_count } : {}),
          ...(data.follows_count !== undefined ? { followingCount: data.follows_count } : {}),
          ...(data.media_count !== undefined ? { postCount: data.media_count } : {}),
          ...(data.website !== undefined ? { externalUrl: data.website } : {}),
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: meta.observedAt,
          },
        },
        { ...meta, confidence: Confidence.HIGH },
      );
    } catch (err) {
      return providerFailure(meta, err);
    }
  }

  async getStories(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedStory[]>> {
    const meta = this.meta(account);
    try {
      const data = await this.get<{
        data?: Array<{ id: string; timestamp?: string; media_type?: string; caption?: string }>;
      }>(`/${this.igUserId}/stories`, { fields: GRAPH_STORY_FIELDS });
      const stories: NormalizedStory[] = (data.data ?? []).map((s) => ({
        storyId: s.id,
        mediaType: mapGraphMediaType(s.media_type),
        takenAt: s.timestamp ?? meta.observedAt,
        // The provider returns at most one caption per story (documented
        // limitation); absent means none exposed, never empty-faked.
        ...(s.caption !== undefined ? { caption: s.caption } : {}),
        hasLink: false,
        stickerKinds: [],
        mentions: [],
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.MEDIUM,
          observedAt: meta.observedAt,
        },
      }));
      return available(stories, { ...meta, confidence: Confidence.MEDIUM });
    } catch (err) {
      if (err instanceof GraphFailure && err.unavailable) {
        return unavailable(meta, err.message);
      }
      return providerFailure(meta, err);
    }
  }

  async getFollowers(
    account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    // The Graph API exposes no follower LIST (only counts). UNAVAILABLE by
    // design — never simulated.
    return unavailable(
      this.meta(account),
      "Instagram Graph API exposes follower counts but no follower list; list observation is UNAVAILABLE through this provider",
    );
  }

  async getFollowing(
    account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return unavailable(
      this.meta(account),
      "Instagram Graph API exposes following counts but no following list; list observation is UNAVAILABLE through this provider",
    );
  }

  async getPublicPosts(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>> {
    const meta = this.meta(account);
    try {
      const data = await this.get<{
        data?: Array<{
          id: string;
          caption?: string;
          timestamp?: string;
          like_count?: number;
          comments_count?: number;
          permalink?: string;
          // Documented public IG Media field: provider truth for the
          // shortcode, preferred over parsing the permalink (kept as
          // fallback for responses that omit it).
          shortcode?: string;
          media_type?: string;
          media_product_type?: string;
        }>;
        paging?: { cursors?: { after?: string } };
      }>(
        `/${this.igUserId}/media`,
        {
          fields: GRAPH_MEDIA_FIELDS,
          limit: "25",
          ...(cursor !== undefined ? { after: cursor.value } : {}),
        },
      );
      const observedAt = meta.observedAt;
      const posts: NormalizedPost[] = (data.data ?? []).map((p) => ({
        postId: p.id,
        ...(shortcodeFor(p.shortcode, p.permalink) !== undefined
          ? { shortcode: shortcodeFor(p.shortcode, p.permalink) as string }
          : {}),
        // Permalink kept verbatim alongside the derived shortcode: the URL
        // is provider data, the shortcode a parse of it. UI guards the
        // scheme before rendering it as a link.
        ...(p.permalink !== undefined ? { permalink: p.permalink } : {}),
        takenAt: p.timestamp ?? observedAt,
        ...(p.caption !== undefined ? { caption: p.caption } : {}),
        ...(p.like_count !== undefined ? { likeCount: p.like_count } : {}),
        ...(p.comments_count !== undefined ? { commentCount: p.comments_count } : {}),
        ...(p.media_type !== undefined ? { mediaType: mapGraphMediaType(p.media_type) } : {}),
        ...(p.media_product_type !== undefined
          ? { mediaProductType: p.media_product_type }
          : {}),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt,
        },
      }));
      const after = data.paging?.cursors?.after;
      if (after === undefined) {
        return available(posts, { ...meta, confidence: Confidence.HIGH });
      }
      return {
        status: CapabilityStatus.PARTIAL,
        data: posts,
        ...meta,
        confidence: Confidence.MEDIUM,
        note: "More media pages available; continue with the returned cursor",
        rawReference: `graph:v1/media?after=${after}`,
        nextCursor: after,
      };
    } catch (err) {
      return providerFailure(meta, err);
    }
  }

  async getPublicComments(
    post: NormalizedPost,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>> {
    const meta = this.meta();
    try {
      const data = await this.get<{
        data?: GraphRawComment[];
        paging?: { cursors?: { after?: string } };
      }>(
        `/${post.postId}/comments`,
        {
          // parent_id + replies expansion are documented IG Comment reads:
          // the listing edge returns top-level comments only, so threading
          // arrives via the replies field (one level, same call). like_count
          // is provider metadata (omitted when the owner hides counts);
          // from carries the author IGSID when the token may see it.
          fields: GRAPH_COMMENT_FIELDS,
          ...(cursor !== undefined ? { after: cursor.value } : {}),
        },
      );
      const observedAt = meta.observedAt;
      const comments: NormalizedComment[] = [];
      for (const c of data.data ?? []) {
        comments.push(mapGraphComment(c, post.postId, c.parent_id, observedAt));
        for (const r of nestedReplies(c)) {
          // The enclosing edge is the reply's parent: authoritative even
          // when the nested parent_id is absent.
          comments.push(mapGraphComment(r, post.postId, c.id, observedAt));
        }
      }
      const after = data.paging?.cursors?.after;
      if (after === undefined) {
        return available(comments, { ...meta, confidence: Confidence.MEDIUM });
      }
      return {
        status: CapabilityStatus.PARTIAL,
        data: comments,
        ...meta,
        confidence: Confidence.MEDIUM,
        note: "More comment pages available; continue with the returned cursor",
        nextCursor: after,
      };
    } catch (err) {
      if (err instanceof GraphFailure && err.unavailable) {
        return unavailable(meta, err.message);
      }
      return providerFailure(meta, err);
    }
  }

  async getPostChildren(
    post: NormalizedPost,
  ): Promise<CapabilityResult<NormalizedPostChild[]>> {
    const meta = this.meta();
    try {
      // Dedicated edge per album post (never folded into the /media listing):
      // a failure here must not endanger the already-persisted parent post.
      // Only documented album-child fields are requested; media_url is
      // deliberately excluded (expiring CDN URLs with no archival policy).
      const data = await this.get<{
        data?: Array<{
          id: string;
          media_type?: string;
          permalink?: string;
          shortcode?: string;
          timestamp?: string;
        }>;
      }>(`/${post.postId}/children`, {
        fields: GRAPH_CHILD_FIELDS,
      });
      const children: NormalizedPostChild[] = (data.data ?? []).map((c) => ({
        childId: c.id,
        ...(c.media_type !== undefined ? { mediaType: mapGraphMediaType(c.media_type) } : {}),
        ...(shortcodeFor(c.shortcode, c.permalink) !== undefined
          ? { shortcode: shortcodeFor(c.shortcode, c.permalink) as string }
          : {}),
        ...(c.permalink !== undefined ? { permalink: c.permalink } : {}),
        ...(c.timestamp !== undefined ? { takenAt: c.timestamp } : {}),
      }));
      return available(children, { ...meta, confidence: Confidence.MEDIUM });
    } catch (err) {
      if (err instanceof GraphFailure && err.unavailable) {
        return unavailable(meta, err.message);
      }
      return providerFailure(meta, err);
    }
  }
}

interface GraphCommentAuthor {
  id?: string;
  username?: string;
}

interface GraphRawComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  parent_id?: string;
  like_count?: number;
  from?: GraphCommentAuthor;
  replies?: { data?: GraphRawComment[] } | GraphRawComment[];
}

/**
 * Field-expansion replies arrive as {data:[...]}; tolerate a bare array so
 * a shape change degrades to flat comments instead of throwing.
 */
function nestedReplies(raw: GraphRawComment): GraphRawComment[] {
  const replies = raw.replies;
  if (Array.isArray(replies)) return replies;
  if (replies !== undefined && Array.isArray(replies.data)) return replies.data;
  return [];
}

function mapGraphComment(
  raw: GraphRawComment,
  postId: string,
  parentId: string | undefined,
  observedAt: string,
): NormalizedComment {
  return {
    commentId: raw.id,
    postId,
    author: {
      username: raw.username ?? raw.from?.username ?? "unknown",
      ...(raw.from?.id !== undefined ? { igId: raw.from.id } : {}),
    },
    text: raw.text ?? "",
    createdAt: raw.timestamp ?? observedAt,
    ...(parentId !== undefined ? { inReplyToCommentId: parentId } : {}),
    // Omitted by the provider when counts are hidden — never zero-filled.
    ...(typeof raw.like_count === "number" ? { likeCount: raw.like_count } : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.MEDIUM,
      observedAt,
    },
  };
}

class GraphFailure extends Error {
  readonly kind: CapabilityErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly unavailable: boolean;

  constructor(
    kind: CapabilityErrorKind,
    message: string,
    retryable: boolean,
    options: { retryAfterMs?: number; unavailable?: boolean } = {},
  ) {
    super(message);
    this.name = "GraphFailure";
    this.kind = kind;
    this.retryable = retryable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.unavailable = options.unavailable ?? false;
  }
}

function graphFailure(
  kind: CapabilityErrorKind,
  message: string,
  retryable: boolean,
): GraphFailure {
  return new GraphFailure(kind, message, retryable);
}

async function graphHttpFailure(res: Response): Promise<GraphFailure> {
  let body: GraphErrorBody = {};
  try {
    body = (await res.json()) as GraphErrorBody;
  } catch {
    body = {};
  }
  const detail = body.error?.message ?? `Graph API HTTP ${res.status}`;
  const code = body.error?.code;
  // Token/permission problems are configuration failures, never retried as data.
  if (res.status === 401 || code === 190) {
    return new GraphFailure(
      CapabilityErrorKind.AUTH_REQUIRED,
      `Graph API authentication failed: ${detail.slice(0, 200)}`,
      false,
    );
  }
  if (res.status === 403) {
    return new GraphFailure(
      CapabilityErrorKind.FORBIDDEN,
      `Graph API refused the request: ${detail.slice(0, 200)}`,
      false,
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const secs = retryAfter !== null ? Number(retryAfter) : Number.NaN;
    const options: { retryAfterMs?: number } =
      Number.isFinite(secs) && secs > 0 ? { retryAfterMs: secs * 1000 } : {};
    return new GraphFailure(
      CapabilityErrorKind.RATE_LIMITED,
      `Graph API rate limited: ${detail.slice(0, 200)}`,
      true,
      options,
    );
  }
  // Unsupported endpoints (e.g. stories on some account types) surface as
  // 400/404 Graph errors — those mean UNAVAILABLE, not retryable failure.
  if (res.status === 400 || res.status === 404) {
    return new GraphFailure(
      CapabilityErrorKind.PROVIDER_ERROR,
      detail.slice(0, 200),
      false,
      { unavailable: true },
    );
  }
  if (res.status >= 500) {
    return new GraphFailure(
      CapabilityErrorKind.PROVIDER_ERROR,
      `Graph API server error: ${detail.slice(0, 200)}`,
      true,
    );
  }
  return new GraphFailure(CapabilityErrorKind.PROVIDER_ERROR, detail.slice(0, 200), false);
}

function providerFailure(
  meta: { observedAt: string; source: SourceRef },
  err: unknown,
): CapabilityResult<never> {
  if (err instanceof GraphFailure) {
    return errored(meta, {
      kind: err.kind,
      message: err.message.slice(0, 300),
      retryable: err.retryable,
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    });
  }
  const message = err instanceof Error ? err.message : "Graph provider failure";
  return errored(meta, {
    kind: CapabilityErrorKind.INTERNAL,
    message: `Graph provider failure: ${message.slice(0, 200)}`,
    retryable: false,
  });
}

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
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedFollowPage,
  type NormalizedPost,
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
      }>(`/${this.igUserId}`, {
        fields: "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count",
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
        data?: Array<{ id: string; timestamp?: string; media_type?: string }>;
      }>(`/${this.igUserId}/stories`, { fields: "id,timestamp,media_type" });
      const stories: NormalizedStory[] = (data.data ?? []).map((s) => ({
        storyId: s.id,
        mediaType: "UNKNOWN",
        takenAt: s.timestamp ?? meta.observedAt,
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
        }>;
        paging?: { cursors?: { after?: string } };
      }>(
        `/${this.igUserId}/media`,
        {
          fields: "id,caption,timestamp,like_count,comments_count,permalink",
          limit: "25",
          ...(cursor !== undefined ? { after: cursor.value } : {}),
        },
      );
      const observedAt = meta.observedAt;
      const posts: NormalizedPost[] = (data.data ?? []).map((p) => ({
        postId: p.id,
        takenAt: p.timestamp ?? observedAt,
        ...(p.caption !== undefined ? { caption: p.caption } : {}),
        ...(p.like_count !== undefined ? { likeCount: p.like_count } : {}),
        ...(p.comments_count !== undefined ? { commentCount: p.comments_count } : {}),
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
        data?: Array<{
          id: string;
          text?: string;
          username?: string;
          timestamp?: string;
        }>;
      }>(
        `/${post.postId}/comments`,
        {
          fields: "id,text,username,timestamp",
          ...(cursor !== undefined ? { after: cursor.value } : {}),
        },
      );
      const observedAt = meta.observedAt;
      const comments: NormalizedComment[] = (data.data ?? []).map((c) => ({
        commentId: c.id,
        postId: post.postId,
        author: { username: c.username ?? "unknown" },
        text: c.text ?? "",
        createdAt: c.timestamp ?? observedAt,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.MEDIUM,
          observedAt,
        },
      }));
      return available(comments, { ...meta, confidence: Confidence.MEDIUM });
    } catch (err) {
      if (err instanceof GraphFailure && err.unavailable) {
        return unavailable(meta, err.message);
      }
      return providerFailure(meta, err);
    }
  }
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

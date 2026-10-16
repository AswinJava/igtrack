import {
  available,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  Confidence,
  DISCOVERY_MEDIA_PREVIEW_LIMIT,
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
  type NormalizedDiscoveredAccount,
  type NormalizedFollowPage,
  type NormalizedInsightAbsence,
  type NormalizedInsightPoint,
  type NormalizedInsightSet,
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
  /**
   * Opt-in for the documented Business Discovery edge (D42). Off by default:
   * it is the one route that reads OTHER accounts, so it never turns itself
   * on — `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` does, explicitly.
   */
  businessDiscovery?: boolean;
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

// Documented IG User insights request shapes (Meta "Instagram Account
// Insights", read 2026-10-15). The metric sets are split BY metric_type: the
// API errors on a metric requested with a type it does not support, and the
// reference lists reach as time_series-capable while
// accounts_engaged/total_interactions/views are total_value only. Requesting
// a metric under the wrong type silently yields an empty set, which would
// become a false absence — so the split is pinned here, not guessed per call.
export const GRAPH_INSIGHTS_TIME_SERIES_METRICS = "follower_count,reach";
export const GRAPH_INSIGHTS_TOTAL_METRICS =
  "accounts_engaged,total_interactions,views";
export const GRAPH_INSIGHTS_DEMOGRAPHICS_METRIC = "follower_demographics";
export const GRAPH_INSIGHTS_DEMOGRAPHICS_TIMEFRAME = "this_month";
// Documented default when since/until are omitted is a 24-hour lookback — a
// trap for a product whose entire value is a retained series — so the window
// is always explicit.
export const GRAPH_INSIGHTS_WINDOW_DAYS = 30;

// Business Discovery (D42): the one documented route to another account's
// public data. The request reuses the audited profile and media field sets
// verbatim, so no field enters the product through this route that the §15
// field-coverage audit has not already accounted for.
// The preview ceiling lives in core (it is a property of the route, and the
// recording layer must state the same bound the request enforced).
export const GRAPH_DISCOVERY_MEDIA_LIMIT = DISCOVERY_MEDIA_PREVIEW_LIMIT;
export function graphDiscoveryFields(username: string): string {
  return (
    `business_discovery.username(${username})` +
    `{${GRAPH_PROFILE_FIELDS},media.limit(${GRAPH_DISCOVERY_MEDIA_LIMIT}){${GRAPH_MEDIA_FIELDS}}}`
  );
}

interface GraphInsightsValue {
  value?: number;
  end_time?: string;
}

interface GraphInsightsBreakdown {
  dimension_keys?: string[];
  results?: Array<{ dimension_values?: string[]; value?: number }>;
}

interface GraphInsightsItem {
  name: string;
  period?: string;
  values?: GraphInsightsValue[];
  total_value?: { value?: number; breakdowns?: GraphInsightsBreakdown[] };
}

interface GraphInsightsResponse {
  data?: GraphInsightsItem[];
}

/**
 * Documented reason text for a metric the platform returned nothing for.
 * `follower_count` and `follower_demographics` carry the documented
 * below-100-followers gate; every other metric gets the documented
 * empty-data-set rule. Neither ever degrades to a zero claim.
 */
function insightAbsenceReason(metric: string): string {
  if (metric === "follower_count" || metric === "follower_demographics") {
    return "The platform returned no data for this metric (documented: not returned for accounts with fewer than 100 followers). Recorded as an absence, never as 0.";
  }
  return "The platform returned an empty data set for this metric in the requested window (documented behavior: the API returns an empty set instead of 0).";
}

/**
 * Response item → normalized points. Handles all three documented shapes:
 * time_series `values`, total_value `total_value.value`, and breakdown results
 * under `total_value.breakdowns`. A breakdown whose keys are all "timeframe"
 * is skipped: a timeframe with no dimension carries no dimension claim.
 */
function insightPointsFromItem(
  item: GraphInsightsItem,
  fallbackPeriod: string,
  requestedTimeframe: string | undefined,
): NormalizedInsightPoint[] {
  const period = item.period ?? fallbackPeriod;
  const out: NormalizedInsightPoint[] = [];
  for (const value of item.values ?? []) {
    if (typeof value.value !== "number") continue;
    out.push({
      metric: item.name,
      period,
      ...(value.end_time !== undefined ? { endTime: value.end_time } : {}),
      value: value.value,
    });
  }
  const total = item.total_value;
  if (typeof total?.value === "number") {
    out.push({ metric: item.name, period, value: total.value });
  }
  for (const breakdown of total?.breakdowns ?? []) {
    const keys = breakdown.dimension_keys ?? [];
    const dimensionIndex = keys.findIndex((key) => key !== "timeframe");
    if (dimensionIndex < 0) continue;
    const timeframeIndex = keys.indexOf("timeframe");
    for (const result of breakdown.results ?? []) {
      if (typeof result.value !== "number") continue;
      const values = result.dimension_values ?? [];
      const timeframe =
        timeframeIndex >= 0 ? values[timeframeIndex] : requestedTimeframe;
      const dimensionValue = values[dimensionIndex];
      out.push({
        metric: item.name,
        period,
        ...(timeframe !== undefined ? { timeframe } : {}),
        dimension: keys[dimensionIndex] as string,
        ...(dimensionValue !== undefined ? { dimensionValue } : {}),
        value: result.value,
      });
    }
  }
  return out;
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
    // Only the literal "1" enables it: an empty, misspelled, or placeholder
    // value must not silently widen the provider's read scope.
    ...(env.IGTRACK_GRAPH_BUSINESS_DISCOVERY === "1" ? { businessDiscovery: true } : {}),
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
  private readonly businessDiscovery: boolean;

  constructor(config: GraphProviderConfig) {
    this.token = config.accessToken;
    this.igUserId = config.igUserId;
    this.ownedUsername = config.username.toLowerCase();
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion ?? "v21.0"}`;
    this.businessDiscovery = config.businessDiscovery === true;
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
      // Documented IG User insights edge for the owned account (D36).
      [CapabilityName.GET_ACCOUNT_INSIGHTS]: true,
      // The documented business_discovery edge, opt-in (D42). Off by default
      // because it is the only route that reads accounts other than the owned
      // one; discoverAccount still answers UNAVAILABLE with the unlock path
      // when it is off, rather than pretending the method does not exist.
      [CapabilityName.DISCOVER_ACCOUNT]: true,
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
      const posts: NormalizedPost[] = (data.data ?? []).map((p) =>
        mapGraphMediaItem(p, observedAt),
      );
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
      return providerFailure(meta, err);
    }
  }

  async getAccountInsights(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedInsightSet>> {
    const meta = this.meta(account);
    const until = Math.floor(Date.now() / 1000);
    const since = until - GRAPH_INSIGHTS_WINDOW_DAYS * 24 * 60 * 60;

    const points: NormalizedInsightPoint[] = [];
    const absences: NormalizedInsightAbsence[] = [];

    // One documented call shape per block. A 400/404 is structural FOR THIS
    // REQUEST (the platform refuses the shape, or the metric is unsupported at
    // this API version): the call's metrics become absences carrying the
    // platform's own message. Every other failure — auth, rate limit, network,
    // 5xx — rethrows so the executor classifies it as a FAILURE: a temporary
    // error must never be recorded as "the platform doesn't expose this"
    // (invariant 2).
    const runCall = async (
      metrics: readonly string[],
      period: string,
      params: Record<string, string>,
      requestedTimeframe?: string,
    ): Promise<void> => {
      let data: GraphInsightsResponse;
      try {
        data = await this.get<GraphInsightsResponse>(
          `/${this.igUserId}/insights`,
          params,
        );
      } catch (err) {
        if (err instanceof GraphFailure && err.unavailable) {
          for (const metric of metrics) {
            absences.push({
              metric,
              period,
              reason: `The platform refused this metric request (${err.message.slice(0, 200)}).`,
            });
          }
          return;
        }
        throw err;
      }
      const seen = new Set<string>();
      for (const item of data.data ?? []) {
        seen.add(item.name);
        const itemPoints = insightPointsFromItem(item, period, requestedTimeframe);
        if (itemPoints.length === 0) {
          absences.push({ metric: item.name, period, reason: insightAbsenceReason(item.name) });
          continue;
        }
        points.push(...itemPoints);
      }
      // A metric named in the request but absent from the response is the
      // documented "empty data set" case — an absence with a reason, never
      // silence and never a zero.
      for (const metric of metrics) {
        if (!seen.has(metric)) {
          absences.push({ metric, period, reason: insightAbsenceReason(metric) });
        }
      }
    };

    try {
      await runCall(["follower_count", "reach"], "day", {
        metric: GRAPH_INSIGHTS_TIME_SERIES_METRICS,
        period: "day",
        metric_type: "time_series",
        since: String(since),
        until: String(until),
      });
      await runCall(["accounts_engaged", "total_interactions", "views"], "day", {
        metric: GRAPH_INSIGHTS_TOTAL_METRICS,
        period: "day",
        metric_type: "total_value",
        since: String(since),
        until: String(until),
      });
      await runCall(
        ["follower_demographics"],
        "lifetime",
        {
          metric: GRAPH_INSIGHTS_DEMOGRAPHICS_METRIC,
          period: "lifetime",
          timeframe: GRAPH_INSIGHTS_DEMOGRAPHICS_TIMEFRAME,
          breakdown: "country",
          metric_type: "total_value",
        },
        GRAPH_INSIGHTS_DEMOGRAPHICS_TIMEFRAME,
      );

      const set: NormalizedInsightSet = {
        points,
        absences,
        windowSince: new Date(since * 1000).toISOString(),
        windowUntil: new Date(until * 1000).toISOString(),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.MEDIUM,
          observedAt: meta.observedAt,
        },
      };
      // No rawPayloadHash: three calls produced this set, so there is no
      // single transported raw representation to hash (the normalized hash is
      // computed by the executor from the set itself). sourceReference names
      // the edge instead.
      return available(set, {
        ...meta,
        confidence: Confidence.MEDIUM,
        rawReference: `${this.sourceId}/insights?since=${since}&until=${until}`,
      });
    } catch (err) {
      return providerFailure(meta, err);
    }
  }

  /**
   * The documented business_discovery edge (D42). A PROBE, not a record:
   * nothing is persisted, so no evidence row is owed. Off by default — the
   * refusal names the unlock (the env flag + the documented permissions)
   * instead of pretending the account is unobservable. Unreachable classes
   * (consumer, private, age-gated, nonexistent) are UNAVAILABLE with the
   * platform's reason, never an empty profile and never a zero.
   */
  async discoverAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedDiscoveredAccount>> {
    const meta = this.meta();
    const target = username.trim().replace(/^@/, "").toLowerCase();
    if (target === "") {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: "discoverAccount requires a non-empty username",
        retryable: false,
      });
    }
    // Instagram usernames are letters, digits, periods and underscores (max
    // 30). This guard is about more than honesty: the username is embedded in
    // the fields expression, so anything else must never reach the request
    // builder — and no such account can exist, so the answer is "not found",
    // not "unavailable".
    if (!/^[a-z0-9._]{1,30}$/.test(target)) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `"${username.trim()}" is not a possible Instagram username (documented charset: letters, digits, periods, underscores; at most 30 characters) — nothing was requested.`,
        retryable: false,
      });
    }
    if (target === this.ownedUsername) {
      return unavailable(
        meta,
        `@${target} is the account this provider already observes; use the profile path for it.`,
      );
    }
    if (!this.businessDiscovery) {
      return unavailable(
        meta,
        "Business Discovery is off (the default). It is the only documented route to another account's public data, so enabling it is explicit: set IGTRACK_GRAPH_BUSINESS_DISCOVERY=1 and use a Facebook-Login token carrying instagram_basic + instagram_manage_insights + pages_read_engagement.",
      );
    }
    try {
      const data = await this.get<GraphDiscoveryResponse>(`/${this.igUserId}`, {
        fields: graphDiscoveryFields(target),
      });
      const d = data.business_discovery;
      if (d === undefined || d.id === undefined) {
        // Meta documents this: Business Discovery answers only for public
        // Business/Creator accounts; consumer and private accounts are
        // unreachable and age-gated accounts return nothing. The absence
        // says that, rather than inventing an empty profile.
        return unavailable(
          meta,
          `The platform returned no public data for @${target}. Documented behavior: Business Discovery surfaces only public Business/Creator accounts — consumer and private accounts are unreachable, age-gated accounts return nothing, and a nonexistent username has nothing to return.`,
        );
      }
      const observedAt = meta.observedAt;
      const discovered: NormalizedDiscoveredAccount = {
        account: {
          username: d.username ?? target,
          igId: d.id,
          ...(d.name !== undefined ? { displayName: d.name } : {}),
        },
        ...(d.name !== undefined ? { displayName: d.name } : {}),
        ...(d.biography !== undefined ? { bio: d.biography } : {}),
        ...(d.website !== undefined ? { externalUrl: d.website } : {}),
        ...(d.profile_picture_url !== undefined
          ? { profilePicUrl: d.profile_picture_url }
          : {}),
        ...(d.followers_count !== undefined ? { followerCount: d.followers_count } : {}),
        ...(d.follows_count !== undefined ? { followingCount: d.follows_count } : {}),
        ...(d.media_count !== undefined ? { postCount: d.media_count } : {}),
        recentMedia: (d.media?.data ?? []).map((m) => mapGraphMediaItem(m, observedAt)),
        // The request asked for at most this many; declaring it on the result
        // lets the recording layer state the same bound (D48).
        recentMediaLimit: GRAPH_DISCOVERY_MEDIA_LIMIT,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.MEDIUM,
          observedAt,
        },
      };
      // Confidence MEDIUM and a note: this is another account's platform-
      // reported public data, unhashed (probe, not record), and the media
      // preview is a bounded window — it is not the account's full history.
      const result = available(discovered, {
        ...meta,
        confidence: Confidence.MEDIUM,
        rawReference: `${this.sourceId}/business_discovery?username=${target}`,
      });
      result.note = `Probe of another account's public data via the documented Business Discovery edge; nothing was persisted. Recent media is a bounded preview (limit ${GRAPH_DISCOVERY_MEDIA_LIMIT}), not the account's full post history.`;
      return result;
    } catch (err) {
      return providerFailure(meta, err);
    }
  }
}

interface GraphRawMedia {
  id: string;
  caption?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  shortcode?: string;
  media_type?: string;
  media_product_type?: string;
}

/**
 * One IG Media node → NormalizedPost. Shared by the owned-account media edge
 * and the Business Discovery media preview: the two routes normalize the same
 * documented fields the same way, and a field the provider withheld stays
 * absent (never zero-filled).
 */
function mapGraphMediaItem(p: GraphRawMedia, observedAt: string): NormalizedPost {
  return {
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
  };
}

interface GraphDiscoveryResponse {
  business_discovery?: {
    id?: string;
    username?: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    profile_picture_url?: string;
    media?: { data?: GraphRawMedia[] };
  };
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
    // Documented 400/404 responses are structural facts about what this
    // source can expose — UNAVAILABLE with the reason, honoured on EVERY
    // catch path so honesty never depends on which method was called.
    if (err.unavailable) {
      return unavailable(meta, err.message.slice(0, 300));
    }
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

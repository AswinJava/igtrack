import { createHash } from "node:crypto";
import {
  available,
  CapabilityErrorKind,
  CapabilityName,
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  errored,
  partial,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedComment,
  type NormalizedDiscoveredAccount,
  type NormalizedFollowPage,
  type NormalizedInsightSet,
  type NormalizedMentionedComment,
  type NormalizedPost,
  type NormalizedPostChild,
  type NormalizedProfile,
  type NormalizedStory,
  type NormalizedTagPage,
  type ProviderCapabilities,
  type SourceRef,
} from "@igtrack/core";
import { IG_USERNAME_PATTERN } from "../config/readiness.js";
import {
  ANON_ENDPOINTS,
  ANON_PACE_MS,
  ANON_QUEUE_BOUND_MS,
  ANON_RATE_LIMIT_DELAYS_MS,
  ANONSTORIES_ORIGIN,
  anonHighlightStoriesAuth,
  anonStoryAuth,
  anonStoriesOf,
  buildMentionIndex,
  classifyAnonResponse,
  parseAnonHighlightContents,
  parseAnonHighlightRefs,
  parseAnonSubject,
  toNormalizedStories,
  type AnonClass,
  type AnonHighlightRef,
  type AnonHttpResponse,
  type AnonItemsParse,
  type AnonMention,
  type AnonMentionIndexEntry,
  type AnonStoryItem,
  type AnonStoriesTransport,
  type AnonSubject,
} from "./anonstories.js";
import { AnonTransportError, openAnonStoriesChrome } from "./anonstories-chrome.js";
import { chromeUnavailableMessage, findChrome } from "./chrome.js";

// ---------------------------------------------------------------------------
// The anonstories provider: stories, highlight contents and story mentions for
// any public username, without a login.
//
// What it is: a third-party public aggregator (anonstories.com) relaying
// Instagram's own story/highlight objects. Every row it produces is stamped
// SourceKind.PUBLIC_AGGREGATOR — never PUBLIC_WEB (Instagram did not serve
// this page) and never GRAPH_API (no platform API answered) — at MEDIUM
// confidence, because a relay is not the platform.
//
// Capabilities: resolveAccount, getProfile (the aggregator's user_info), and
// getStories (active stories with their metadata mentions, which the logged-out
// profile page cannot expose). Highlight contents have no method in the
// provider interface anywhere — they surface through getDossier(), the
// `igtrack anonstories` payload. Everything else (rosters, comments, tags,
// insights, discovery) stays UNAVAILABLE with the reason: the aggregator
// carries no such edge, and absence is never filled in.
//
// Transport: calls run inside a local Chrome page context (see
// anonstories-chrome.ts). The constructor fails fast when no browser is
// available rather than deferring the failure to runtime.
// ---------------------------------------------------------------------------

export interface AnonStoriesProviderConfig {
  /** Browser executable. Defaults to a detected Chrome/Chromium/Edge. */
  chromePath?: string | undefined;
  userAgent?: string | undefined;
  /** Minimum spacing between API calls (default ANON_PACE_MS). */
  paceMs?: number | undefined;
  /** Page settle time after load (default ANON_SETTLE_MS). */
  settleMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /** Safety bound on highlights opened per dossier (rate limit is real). */
  maxHighlights?: number | undefined;
  /** Test seam: replace the browser session entirely (fixtures, no network). */
  transportFactory?: (() => Promise<AnonStoriesTransport>) | undefined;
  /** Test seam: pacing/backoff become instant under test. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  rateLimitDelaysMs?: readonly number[] | undefined;
  queueBoundMs?: number | undefined;
  now?: (() => Date) | undefined;
}

type AnonRequest = (endpoint: string, auth: string) => Promise<AnonHttpResponse>;

interface CallOutcome {
  cls: AnonClass;
  /** Raw response text of the last classified answer (hashed into evidence). */
  raw: string | null;
}

export interface AnonStoriesSourceInfo {
  sourceId: string;
  kind: typeof SourceKind.PUBLIC_AGGREGATOR;
  origin: string;
  retrieval: "headless-chrome" | "injected-transport";
}

export interface AnonCoverageRow {
  subject: string;
  status: "OBSERVED" | "PARTIAL" | "UNAVAILABLE";
  value?: string | number | null;
  reason?: string;
}

export interface AnonGap {
  subject: string;
  reason: string;
  howToImprove: string | null;
}

export interface AnonStoryRow {
  storyId: string;
  mediaType?: "image" | "video";
  /** ISO publication time parsed from the item's unix timestamp; absent when unreadable. */
  publishedAt?: string;
  /** The aggregator's own relative age string, verbatim ("23 hours"). */
  age?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  linkUrl?: string;
  mentions: AnonMention[];
  reshareAuthor?: AnonMention;
}

export interface AnonHighlightDossier {
  id: string;
  title?: string;
  coverUrl?: string;
  /** READ = items parsed; UNAVAILABLE = the exact reason, no rows. */
  status: "READ" | "UNAVAILABLE";
  reason?: string;
  itemCount: number;
  droppedItems: number;
  items: AnonStoryRow[];
}

export interface AnonStoriesDossier {
  requestedAt: string;
  observedAt: string;
  username: string;
  source: AnonStoriesSourceInfo;
  account: AnonSubject;
  stories: AnonStoryRow[];
  /** Items that could not be represented, with the exact reason. */
  droppedStoryItems: number;
  highlights: AnonHighlightDossier[];
  /** Every account named in any observed story/highlight metadata, and where. */
  mentions: AnonMentionIndexEntry[];
  counts: {
    activeStories: number;
    highlights: number;
    highlightContentsRead: number;
    highlightItems: number;
    mentionedAccounts: number;
  };
  coverage: AnonCoverageRow[];
  gaps: AnonGap[];
  notes: string[];
}

export interface AnonStoriesDossierResult {
  status: CapabilityStatus;
  dossier?: AnonStoriesDossier;
  note?: string;
  error?: { kind: CapabilityErrorKind; message: string; retryable: boolean };
  observedAt: string;
}

function cleanUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

function itemRow(item: AnonStoryItem): AnonStoryRow {
  return {
    ...(item.storyId !== undefined ? { storyId: item.storyId } : { storyId: "" }),
    ...(item.mediaType !== undefined ? { mediaType: item.mediaType } : {}),
    ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
    ...(item.takenAtLabel !== undefined ? { age: item.takenAtLabel } : {}),
    ...(item.mediaUrl !== undefined ? { mediaUrl: item.mediaUrl } : {}),
    ...(item.thumbnailUrl !== undefined ? { thumbnailUrl: item.thumbnailUrl } : {}),
    ...(item.linkUrl !== undefined ? { linkUrl: item.linkUrl } : {}),
    mentions: item.mentions,
    ...(item.reshareAuthor !== undefined ? { reshareAuthor: item.reshareAuthor } : {}),
  };
}

function rowsFrom(parse: AnonItemsParse): AnonStoryRow[] {
  return parse.items.map(itemRow);
}

export class AnonStoriesProvider implements InstagramProvider {
  readonly sourceId = "anonstories:v1";

  private readonly chromePath: string | undefined;
  private readonly userAgent: string | undefined;
  private readonly paceMs: number;
  private readonly settleMs: number | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly maxHighlights: number;
  private readonly transportFactory: (() => Promise<AnonStoriesTransport>) | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly rateLimitDelaysMs: readonly number[];
  private readonly queueBoundMs: number;
  private readonly now: () => Date;

  constructor(config: AnonStoriesProviderConfig = {}) {
    this.chromePath = config.chromePath;
    this.userAgent = config.userAgent;
    this.paceMs = config.paceMs ?? ANON_PACE_MS;
    this.settleMs = config.settleMs;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.maxHighlights = config.maxHighlights ?? 5;
    this.transportFactory = config.transportFactory;
    this.sleepFn =
      config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.rateLimitDelaysMs = config.rateLimitDelaysMs ?? ANON_RATE_LIMIT_DELAYS_MS;
    this.queueBoundMs = config.queueBoundMs ?? ANON_QUEUE_BOUND_MS;
    this.now = config.now ?? (() => new Date());
    if (this.transportFactory === undefined && findChrome(this.chromePath) === undefined) {
      throw new Error(`igtrack anonstories provider: ${chromeUnavailableMessage()}`);
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      [CapabilityName.RESOLVE_ACCOUNT]: true,
      [CapabilityName.GET_PROFILE]: true,
      [CapabilityName.GET_STORIES]: true,
      [CapabilityName.GET_FOLLOWERS]: false,
      [CapabilityName.GET_FOLLOWING]: false,
      [CapabilityName.GET_PUBLIC_POSTS]: false,
      [CapabilityName.GET_PUBLIC_COMMENTS]: false,
      [CapabilityName.GET_POST_CHILDREN]: false,
      [CapabilityName.GET_TAGS]: false,
      [CapabilityName.GET_MENTIONED_COMMENT]: false,
      [CapabilityName.GET_ACCOUNT_INSIGHTS]: false,
      // Discovery is a Graph API route; this provider reads the named account
      // directly through resolveAccount/getProfile instead.
      [CapabilityName.DISCOVER_ACCOUNT]: false,
    };
  }

  /** Any well-formed public username: the aggregator is keyed by username. */
  async observesAccount(username: string): Promise<boolean> {
    return IG_USERNAME_PATTERN.test(cleanUsername(username));
  }

  private meta(reference?: string): { observedAt: string; source: SourceRef } {
    return {
      observedAt: this.now().toISOString(),
      source: {
        sourceId: this.sourceId,
        kind: SourceKind.PUBLIC_AGGREGATOR,
        ...(reference !== undefined ? { reference } : {}),
      },
    };
  }

  private async openTransport(): Promise<AnonStoriesTransport> {
    if (this.transportFactory !== undefined) return this.transportFactory();
    return await openAnonStoriesChrome({
      ...(this.chromePath !== undefined ? { executablePath: this.chromePath } : {}),
      ...(this.userAgent !== undefined ? { userAgent: this.userAgent } : {}),
      paceMs: this.paceMs,
      ...(this.settleMs !== undefined ? { settleMs: this.settleMs } : {}),
      ...(this.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
    });
  }

  private async withSession<T>(fn: (request: AnonRequest) => Promise<T>): Promise<T> {
    const transport = await this.openTransport();
    try {
      return await fn((endpoint, auth) => transport.request(endpoint, auth));
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  /**
   * One classified read: honour the aggregator's `queue` epochs and 429 backoff
   * ladder, then classify what is left. Both budgets are bounded, so an unready
   * or rate-limited answer becomes a typed error with a reason — never an empty
   * result, never an infinite wait.
   */
  private async classifiedCall(
    request: AnonRequest,
    endpoint: string,
    auth: string,
    requestedUsername: string,
  ): Promise<CallOutcome> {
    let rateAttempt = 0;
    let queueWaitedMs = 0;
    let last: AnonClass = { kind: "malformed", detail: "no request was made" };
    let lastRaw: string | null = null;

    for (let guard = 0; guard < 6; guard++) {
      let response: AnonHttpResponse;
      try {
        response = await request(endpoint, auth);
      } catch (err) {
        if (err instanceof AnonTransportError) {
          return {
            cls: { kind: "malformed", detail: `transport failure (${err.kind}): ${err.message}` },
            raw: null,
          };
        }
        throw err;
      }
      const cls = classifyAnonResponse(response, requestedUsername);
      last = cls;
      lastRaw = response.body;

      if (cls.kind === "rate-limited") {
        const delay = this.rateLimitDelaysMs[rateAttempt];
        if (delay === undefined) break;
        rateAttempt += 1;
        await this.sleepFn(delay);
        continue;
      }
      if (cls.kind === "queued") {
        const waitMs = Math.max(0, cls.readyAtEpochSec * 1000 - this.now().getTime()) + 1_000;
        if (queueWaitedMs + waitMs > this.queueBoundMs) break;
        queueWaitedMs += waitMs;
        await this.sleepFn(waitMs);
        continue;
      }
      return { cls, raw: response.body };
    }
    return { cls: last, raw: lastRaw };
  }

  /** Typed failure for every non-answer class; null when the caller should proceed. */
  private mapFailure(
    meta: { observedAt: string; source: SourceRef },
    cls: AnonClass,
  ): CapabilityResult<never> | null {
    switch (cls.kind) {
      case "rate-limited":
        return errored(meta, {
          kind: CapabilityErrorKind.RATE_LIMITED,
          message:
            "The aggregator rate-limited this read (HTTP 429, \"Too many requests\") through its full backoff ladder. Nothing was inferred and no empty result was reported.",
          retryable: true,
          retryAfterMs: this.rateLimitDelaysMs[0] ?? 20_000,
        });
      case "queued":
        return errored(meta, {
          kind: CapabilityErrorKind.TIMEOUT,
          message: `The aggregator queued this result and it was not ready within the ${this.queueBoundMs} ms bound. No partial or empty answer was accepted.`,
          retryable: true,
        });
      case "not-found":
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: `The aggregator answered: "${cls.message}".`,
          retryable: false,
        });
      case "invalid-username":
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message:
            "The aggregator returned a numeric ticket with no subject and no message — its own signal that the username is not valid. Nothing was stored.",
          retryable: false,
        });
      case "refused":
        return errored(meta, {
          kind: CapabilityErrorKind.PROVIDER_ERROR,
          message: `The aggregator refused the read: "${cls.message}".`,
          retryable: true,
        });
      case "decoy":
        return errored(meta, {
          kind: CapabilityErrorKind.PROVIDER_ERROR,
          message: `${cls.detail}. The aggregator serves fabricated placeholder answers to headless user agents; this response was rejected instead of being stored.`,
          retryable: false,
        });
      case "malformed":
        return errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: `The aggregator response was not the documented envelope: ${cls.detail}.`,
          retryable: true,
        });
      case "ok":
      case "private":
        return null;
    }
  }

  private async readSubject(
    username: string,
  ): Promise<
    { outcome: "answer"; subject: AnonSubject; raw: string } | { failure: CapabilityResult<never> }
  > {
    const meta = this.meta(username);
    const { cls, raw } = await this.withSession((request) =>
      this.classifiedCall(request, ANON_ENDPOINTS.story, anonStoryAuth(username), username),
    );
    const failure = this.mapFailure(meta, cls);
    if (failure !== null) return { failure };
    const body = cls.kind === "ok" ? cls.body : undefined;
    const subject =
      body !== undefined
        ? parseAnonSubject(body.user_info)
        : cls.kind === "private"
          ? cls.subject
          : null;
    if (subject === null) {
      return {
        failure: errored(meta, {
          kind: CapabilityErrorKind.SCHEMA_MISMATCH,
          message: "The aggregator's answer carried no user_info; nothing was inferred about the account.",
          retryable: true,
        }),
      };
    }
    return { outcome: "answer", subject, raw: raw ?? "" };
  }

  async resolveAccount(username: string): Promise<CapabilityResult<NormalizedAccountRef>> {
    const target = cleanUsername(username);
    const meta = this.meta(target);
    if (!IG_USERNAME_PATTERN.test(target)) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `"${username.trim()}" is not a possible Instagram username (letters, digits, periods, underscores; at most 30 characters) — no request was made.`,
        retryable: false,
      });
    }
    try {
      const answer = await this.readSubject(target);
      if ("failure" in answer) return answer.failure;
      const subject = answer.subject;
      return available(
        {
          username: subject.username,
          ...(subject.fullName !== undefined ? { displayName: subject.fullName } : {}),
          ...(subject.isPrivate !== undefined ? { isPrivate: subject.isPrivate } : {}),
        },
        {
          observedAt: this.now().toISOString(),
          source: meta.source,
          confidence: Confidence.MEDIUM,
          ...(answer.raw !== "" ? { rawPayloadHash: sha256(answer.raw) } : {}),
        },
      );
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getProfile(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedProfile>> {
    const target = cleanUsername(account.username);
    const meta = this.meta(target);
    if (!IG_USERNAME_PATTERN.test(target)) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `"${account.username}" is not a possible Instagram username — no request was made.`,
        retryable: false,
      });
    }
    try {
      const answer = await this.readSubject(target);
      if ("failure" in answer) return answer.failure;
      const subject = answer.subject;
      // Biography, external URL and account type are not carried by the
      // aggregator: absent here, exactly as absent in its response.
      return available(
        {
          account: {
            // The aggregator reports the legacy pk, not the IGSID. Recording
            // it as igId would collide with the same account observed via the
            // public page or Graph, so identity here is username-only.
            username: subject.username,
            ...(subject.fullName !== undefined ? { displayName: subject.fullName } : {}),
            ...(subject.isPrivate !== undefined ? { isPrivate: subject.isPrivate } : {}),
          },
          ...(subject.profilePicUrl !== undefined ? { profilePicUrl: subject.profilePicUrl } : {}),
          ...(subject.followerCount !== undefined ? { followerCount: subject.followerCount } : {}),
          ...(subject.followingCount !== undefined ? { followingCount: subject.followingCount } : {}),
          ...(subject.postCount !== undefined ? { postCount: subject.postCount } : {}),
          ...(subject.isVerified !== undefined ? { isVerified: subject.isVerified } : {}),
          ...(subject.isPrivate !== undefined ? { isPrivate: subject.isPrivate } : {}),
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.MEDIUM,
            observedAt: this.now().toISOString(),
          },
        },
        {
          observedAt: this.now().toISOString(),
          source: meta.source,
          confidence: Confidence.MEDIUM,
          ...(answer.raw !== "" ? { rawPayloadHash: sha256(answer.raw) } : {}),
        },
      );
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getStories(account: NormalizedAccountRef): Promise<CapabilityResult<NormalizedStory[]>> {
    const target = cleanUsername(account.username);
    const meta = this.meta(target);
    if (!IG_USERNAME_PATTERN.test(target)) {
      return errored(meta, {
        kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
        message: `"${account.username}" is not a possible Instagram username — no request was made.`,
        retryable: false,
      });
    }
    try {
      const { cls, raw } = await this.withSession((request) =>
        this.classifiedCall(request, ANON_ENDPOINTS.story, anonStoryAuth(target), target),
      );
      const failure = this.mapFailure(meta, cls);
      if (failure !== null) return failure;
      if (cls.kind === "private") {
        return unavailable(
          meta,
          `The aggregator reports @${target} is private and serves no story items for it. No story rows and no "no stories" claim were written.`,
        );
      }
      if (cls.kind !== "ok") {
        // Defensive: mapFailure covers every non-ok class above.
        return errored(meta, {
          kind: CapabilityErrorKind.PROVIDER_ERROR,
          message: `The aggregator read ended as ${cls.kind}.`,
          retryable: true,
        });
      }
      const observedAt = this.now().toISOString();
      const items = anonStoriesOf(cls.body);
      const { stories, skipped, reasons } = toNormalizedStories(items, observedAt, Confidence.MEDIUM);
      const resultMeta = {
        observedAt,
        source: meta.source,
        confidence: Confidence.MEDIUM,
        ...(raw !== null ? { rawPayloadHash: sha256(raw) } : {}),
      };
      if (skipped > 0) {
        return partial(stories, {
          ...resultMeta,
          note: `${skipped} observed item(s) could not be represented: ${dedupe(reasons).join("; ")}.`,
        });
      }
      // AVAILABLE + zero stories is a positive observation of absence: the
      // account answered and carried no active story at this moment.
      return available(stories, resultMeta);
    } catch (err) {
      return this.failure(meta, err);
    }
  }

  async getFollowers(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return unavailable(
      this.meta(),
      "The aggregator exposes no follower roster endpoint. Only the follower COUNT is relayed with the profile; no roster is requested, inferred or zero-filled.",
    );
  }

  async getFollowing(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return unavailable(
      this.meta(),
      "The aggregator exposes no following roster endpoint. Only the following COUNT is relayed with the profile; no roster is requested, inferred or zero-filled.",
    );
  }

  async getPublicPosts(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>> {
    return unavailable(
      this.meta(),
      "The aggregator carries no post listing — only stories, highlights and their mentions. Posts are read through the public provider (IGTRACK_PROVIDER=public) or the Graph API.",
    );
  }

  async getPublicComments(
    _post: NormalizedPost,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>> {
    return unavailable(
      this.meta(),
      "The aggregator exposes no comment list for any media. Comments stay UNAVAILABLE rather than inferred from a comment count.",
    );
  }

  async getPostChildren(_post: NormalizedPost): Promise<CapabilityResult<NormalizedPostChild[]>> {
    return unavailable(this.meta(), "The aggregator exposes no carousel-child endpoint.");
  }

  async getTags(
    _account: NormalizedAccountRef,
    _cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedTagPage>> {
    return unavailable(
      this.meta(),
      "The aggregator exposes no tagged-media listing; the /tagged/ edge is login-gated and this source never authenticates.",
    );
  }

  async getMentionedComment(
    _account: NormalizedAccountRef,
    _commentId: string,
  ): Promise<CapabilityResult<NormalizedMentionedComment>> {
    return unavailable(
      this.meta(),
      "A mentioned comment is a webhook-keyed, authenticated Graph API read. The aggregator has no such route.",
    );
  }

  async getAccountInsights(
    _account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedInsightSet>> {
    return unavailable(
      this.meta(),
      "Insights are owner-authorized metrics. A third-party aggregator carries none, so no metric is recorded or zero-filled.",
    );
  }

  async discoverAccount(_username: string): Promise<CapabilityResult<NormalizedDiscoveredAccount>> {
    return unavailable(
      this.meta(),
      "Business Discovery is a Graph API route. Select IGTRACK_PROVIDER=graph with IGTRACK_GRAPH_BUSINESS_DISCOVERY=1 for it; this provider reads the named account directly instead.",
    );
  }

  private failure(
    meta: { observedAt: string; source: SourceRef },
    err: unknown,
  ): CapabilityResult<never> {
    if (err instanceof AnonTransportError) {
      return errored(meta, {
        kind: err.kind,
        message: err.message.slice(0, 500),
        retryable: err.kind === CapabilityErrorKind.NETWORK || err.kind === CapabilityErrorKind.TIMEOUT,
      });
    }
    if (err instanceof Error && /Chrome|browser executable/i.test(err.message)) {
      return errored(meta, {
        kind: CapabilityErrorKind.PROVIDER_ERROR,
        message: err.message.slice(0, 500),
        retryable: false,
      });
    }
    const message = err instanceof Error ? err.message : "anonstories provider failure";
    return errored(meta, {
      kind: CapabilityErrorKind.INTERNAL,
      message: `anonstories provider failure: ${message.slice(0, 300)}`,
      retryable: false,
    });
  }

  /** Human-readable reason for a class that did not produce data. */
  private classReason(cls: AnonClass): string {
    switch (cls.kind) {
      case "rate-limited":
        return "rate-limited by the aggregator (HTTP 429) after its full backoff ladder";
      case "queued":
        return `queued by the aggregator and not ready within the ${this.queueBoundMs} ms bound`;
      case "not-found":
      case "refused":
        return `the aggregator answered: "${cls.message}"`;
      case "invalid-username":
        return "the aggregator reported an invalid username (numeric ticket, no subject, no message)";
      case "decoy":
        return `${cls.detail}; the placeholder answer was rejected`;
      case "malformed":
        return `the response was not the documented envelope: ${cls.detail}`;
      case "private":
        return "the account is private";
      case "ok":
        return "answered";
    }
  }

  /**
   * The full aggregator dossier: account, active stories, the highlight list,
   * each highlight's contents, and the merged mention index — plus the
   * explicit gaps (private profile, bounded highlights, rate limit, and every
   * class this source cannot answer). This is the `igtrack anonstories`
   * payload; the generic provider methods above feed the scan pipeline.
   *
   * One browser session serves the whole dossier: story read, highlight list,
   * then each highlight's items — bounded by maxHighlights and stopped early
   * on a rate limit, whose remaining highlights are reported UNAVAILABLE with
   * that reason, never as empty.
   */
  async getDossier(
    username: string,
    options: { maxHighlights?: number } = {},
  ): Promise<AnonStoriesDossierResult> {
    const target = cleanUsername(username);
    const requestedAt = this.now().toISOString();
    if (!IG_USERNAME_PATTERN.test(target)) {
      return {
        status: CapabilityStatus.ERROR,
        observedAt: requestedAt,
        error: {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: `"${username.trim()}" is not a possible Instagram username (letters, digits, periods, underscores; at most 30 characters) — no request was made.`,
          retryable: false,
        },
      };
    }

    const maxHighlights = options.maxHighlights ?? this.maxHighlights;
    const notes = [
      `Source: ${ANONSTORIES_ORIGIN}, a third-party public aggregator relaying Instagram story objects. Every row is ${SourceKind.PUBLIC_AGGREGATOR}, never ${SourceKind.PUBLIC_WEB} and never ${SourceKind.GRAPH_API}: the platform did not serve this answer.`,
      "Requests run inside a local Chrome page context because the aggregator refuses non-browser clients (Cloudflare 403); no login, cookie or credential of the operator's is used.",
      "The aggregator answers the HeadlessChrome user agent with fabricated placeholder data, so this transport presents a desktop Chrome user agent and rejects any response whose subject username does not match the request.",
      "Responses are relayed by a third party: observations carry MEDIUM confidence, and story mentions have no sticker geometry here — they are metadata-only mentions (visibility METADATA_ONLY).",
      "The site rate-limits after ~5 rapid calls; calls are paced and its 429 backoff ladder is honoured before a read is reported as rate-limited.",
      "A missing field stays absent: no count is zero-filled, no relative age string is converted into a publication time, and a server refusal is reported with the server's own words.",
    ];

    try {
      const outcome = await this.withSession(async (request) => {
        const story = await this.classifiedCall(
          request,
          ANON_ENDPOINTS.story,
          anonStoryAuth(target),
          target,
        );

        // Every subsequent call shares this one browser session: one
        // Cloudflare clearance, one pacing clock, no second Chrome launch.
        const highlights: AnonHighlightDossier[] = [];
        let refs: AnonHighlightRef[] = [];
        let highlightFailure: string | null = null;
        let rateLimited = false;

        if (story.cls.kind !== "ok") {
          // Private or refused: the story call already carries the reason, and
          // no highlight call is made for a subject that cannot answer.
          return {
            story,
            refs,
            highlights,
            highlightFailure:
              story.cls.kind === "private"
                ? "the account is private: the aggregator serves no highlight list for it"
                : `not read: the story read ended as ${this.classReason(story.cls)}`,
            rateLimited,
          };
        }

        const list = await this.classifiedCall(
          request,
          ANON_ENDPOINTS.highlights,
          anonStoryAuth(target),
          target,
        );
        if (list.cls.kind !== "ok") {
          return {
            story,
            refs,
            highlights,
            highlightFailure: this.classReason(list.cls),
            rateLimited,
          };
        }
        const parsedRefs = parseAnonHighlightRefs(list.cls.body.highlights);
        if (parsedRefs === null) {
          return {
            story,
            refs,
            highlights,
            highlightFailure: "the aggregator's highlight answer carried no highlight array",
            rateLimited,
          };
        }
        refs = parsedRefs;

        const userId = parseAnonSubject(story.cls.body.user_info)?.pk;
        for (const ref of refs.slice(0, maxHighlights)) {
          if (rateLimited) break;
          const pushUnavailable = (reason: string): void => {
            highlights.push({
              id: ref.id,
              ...(ref.title !== undefined ? { title: ref.title } : {}),
              ...(ref.coverUrl !== undefined ? { coverUrl: ref.coverUrl } : {}),
              status: "UNAVAILABLE",
              reason,
              itemCount: 0,
              droppedItems: 0,
              items: [],
            });
          };
          if (userId === undefined) {
            pushUnavailable("the answer carried no account id to address the highlight by");
            continue;
          }
          const contents = await this.classifiedCall(
            request,
            ANON_ENDPOINTS.highlightStories,
            anonHighlightStoriesAuth(userId, target, ref.id),
            target,
          );
          if (contents.cls.kind === "rate-limited") rateLimited = true;
          if (contents.cls.kind !== "ok") {
            pushUnavailable(this.classReason(contents.cls));
            continue;
          }
          const parsed = parseAnonHighlightContents(contents.cls.body);
          highlights.push({
            id: ref.id,
            ...(parsed.title !== undefined
              ? { title: parsed.title }
              : ref.title !== undefined
                ? { title: ref.title }
                : {}),
            ...(parsed.coverUrl !== undefined
              ? { coverUrl: parsed.coverUrl }
              : ref.coverUrl !== undefined
                ? { coverUrl: ref.coverUrl }
                : {}),
            status: "READ",
            itemCount: parsed.items.length,
            droppedItems: parsed.dropped,
            items: rowsFrom(parsed),
          });
        }
        // Highlights beyond the bound get their own explicit row, so a bound
        // never reads as "this account has no more highlights".
        for (const ref of refs.slice(maxHighlights)) {
          highlights.push({
            id: ref.id,
            ...(ref.title !== undefined ? { title: ref.title } : {}),
            ...(ref.coverUrl !== undefined ? { coverUrl: ref.coverUrl } : {}),
            status: "UNAVAILABLE",
            reason: `not read: bounded to ${maxHighlights} highlight(s) per dossier (raise --max-highlights to read more; the aggregator rate-limits)`,
            itemCount: 0,
            droppedItems: 0,
            items: [],
          });
        }
        return { story, refs, highlights, highlightFailure, rateLimited };
      });

      const storyClass = outcome.story.cls;
      if (storyClass.kind === "private") {
        return {
          status: CapabilityStatus.UNAVAILABLE,
          observedAt: requestedAt,
          note: `The aggregator reports @${target} is private: it serves no stories and no highlight contents for a private profile, so this dossier carries only that refused state.`,
        };
      }
      if (storyClass.kind !== "ok") {
        const failure = this.mapFailure(this.meta(target), storyClass);
        return {
          status: CapabilityStatus.ERROR,
          observedAt: requestedAt,
          error:
            failure?.error !== undefined
              ? { ...failure.error }
              : {
                  kind: CapabilityErrorKind.PROVIDER_ERROR,
                  message: this.classReason(storyClass),
                  retryable: true,
                },
        };
      }

      const subject = parseAnonSubject(storyClass.body.user_info);
      if (subject === null) {
        return {
          status: CapabilityStatus.ERROR,
          observedAt: requestedAt,
          error: {
            kind: CapabilityErrorKind.SCHEMA_MISMATCH,
            message: "The aggregator's answer carried no user_info; nothing was inferred about the account.",
            retryable: true,
          },
        };
      }

      const storyParse = anonStoriesOf(storyClass.body);
      const stories = rowsFrom(storyParse);
      const refs = outcome.refs;
      const highlights = outcome.highlights;
      const rateLimited = outcome.rateLimited;
      const skippedByBound = Math.max(0, refs.length - maxHighlights);

      // One index across active stories and every read highlight: who was
      // named in story metadata, and in which context.
      const mentionSections: Array<{ label: string; items: Array<{ mentions: AnonMention[] }> }> = [
        { label: "story", items: storyParse.items },
        ...highlights
          .filter((row) => row.status === "READ")
          .map((row) => ({ label: `highlight:${row.title ?? row.id}`, items: row.items })),
      ];
      const mentions = buildMentionIndex(mentionSections);

      const highlightItems = highlights.reduce((sum, h) => sum + h.itemCount, 0);
      const highlightRead = highlights.filter((h) => h.status === "READ").length;

      const coverage: AnonCoverageRow[] = [
        {
          subject: "Account (aggregator user_info)",
          status: "OBSERVED",
          value: `@${subject.username}`,
        },
        {
          subject: "Active stories",
          status: storyParse.dropped > 0 ? "PARTIAL" : "OBSERVED",
          value: stories.length,
          ...(storyParse.dropped > 0
            ? {
                reason: `${storyParse.dropped} item(s) dropped: ${dedupe(storyParse.dropReasons).join("; ")}`,
              }
            : stories.length === 0
              ? { reason: "the account answered and carried no active story at this moment" }
              : {}),
        },
        {
          subject: "Story mentions (metadata)",
          status: "OBSERVED",
          value: mentions.length,
          ...(mentions.length === 0
            ? { reason: "no observed story or highlight named another account" }
            : {}),
        },
        {
          subject: "Highlights (list)",
          status:
            outcome.highlightFailure === null
              ? "OBSERVED"
              : refs.length > 0
                ? "PARTIAL"
                : "UNAVAILABLE",
          value: refs.length,
          ...(outcome.highlightFailure !== null ? { reason: outcome.highlightFailure } : {}),
        },
        {
          subject: "Highlight contents",
          status:
            refs.length === 0
              ? outcome.highlightFailure === null
                ? "OBSERVED"
                : "UNAVAILABLE"
              : highlightRead === refs.length
                ? "OBSERVED"
                : "PARTIAL",
          value: `${highlightRead}/${refs.length} highlight(s), ${highlightItems} item(s)`,
          ...(highlightRead < refs.length
            ? {
                reason:
                  highlights.find((h) => h.status === "UNAVAILABLE")?.reason ??
                  "some highlights did not answer",
              }
            : {}),
        },
        {
          subject: "Follower / following rosters",
          status: "UNAVAILABLE",
          reason: "the aggregator exposes no roster endpoint; only counts are relayed",
        },
        {
          subject: "Post listings",
          status: "UNAVAILABLE",
          reason: "the aggregator carries no post listing; read posts with IGTRACK_PROVIDER=public or the Graph API",
        },
        {
          subject: "Comment lists",
          status: "UNAVAILABLE",
          reason: "the aggregator exposes no comment list",
        },
        {
          subject: "Tagged media",
          status: "UNAVAILABLE",
          reason: "the aggregator exposes no tagged-media listing",
        },
        {
          subject: "Insights",
          status: "UNAVAILABLE",
          reason: "insights are owner-authorized; a third-party aggregator carries none",
        },
      ];

      const gaps: AnonGap[] = [];
      if (skippedByBound > 0) {
        gaps.push({
          subject: `${skippedByBound} highlight(s) beyond the bound`,
          reason: `The account lists ${refs.length} highlight(s); this dossier reads at most ${maxHighlights}.`,
          howToImprove:
            "Re-run with --max-highlights raised (each extra highlight costs paced API calls and the site rate-limits).",
        });
      }
      if (rateLimited) {
        gaps.push({
          subject: "highlight contents beyond the rate limit",
          reason:
            "The aggregator rate-limited the session (HTTP 429) before every highlight could be read. The unread highlights are reported UNAVAILABLE with that reason, never as empty.",
          howToImprove: "Re-run later; the site's limit resets within seconds to minutes.",
        });
      }
      for (const row of highlights.filter((h) => h.status === "UNAVAILABLE")) {
        if (row.reason !== undefined && !/rate-limit/i.test(row.reason) && !/bounded to/.test(row.reason)) {
          gaps.push({
            subject: `highlight ${row.title ?? row.id}`,
            reason: `The aggregator did not serve this highlight's items: ${row.reason}`,
            howToImprove:
              "Re-run later; refusals and queued results are reported with the server's own message.",
          });
        }
      }
      if (storyParse.dropped > 0) {
        gaps.push({
          subject: "unrepresentable story items",
          reason: `${storyParse.dropped} observed item(s) could not be represented: ${dedupe(storyParse.dropReasons).join("; ")}.`,
          howToImprove: "Nothing: the item data itself was incomplete; the gap is stated, not filled.",
        });
      }
      gaps.push({
        subject: "posts, rosters, comments, tags, insights",
        reason:
          "This source carries only stories, highlight contents and their mentions; every other class is UNAVAILABLE with its own reason.",
        howToImprove:
          "IGTRACK_PROVIDER=public for logged-out posts, IGTRACK_PROVIDER=graph for the owned account, IGTRACK_PROVIDER=import for your own export.",
      });

      const status =
        gaps.length === 0 && storyParse.dropped === 0 && highlightRead === refs.length
          ? CapabilityStatus.AVAILABLE
          : CapabilityStatus.PARTIAL;

      return {
        status,
        observedAt: requestedAt,
        ...(gaps.length > 0 ? { note: `${gaps.length} explicit gap(s); see coverage and gaps.` } : {}),
        dossier: {
          requestedAt,
          observedAt: requestedAt,
          username: subject.username,
          source: {
            sourceId: this.sourceId,
            kind: SourceKind.PUBLIC_AGGREGATOR,
            origin: ANONSTORIES_ORIGIN,
            retrieval:
              this.transportFactory === undefined ? "headless-chrome" : "injected-transport",
          },
          account: subject,
          stories,
          droppedStoryItems: storyParse.dropped,
          highlights,
          mentions,
          counts: {
            activeStories: stories.length,
            highlights: refs.length,
            highlightContentsRead: highlightRead,
            highlightItems: highlightItems,
            mentionedAccounts: mentions.length,
          },
          coverage,
          gaps,
          notes,
        },
      };
    } catch (err) {
      const meta = this.meta(target);
      const failure = this.failure(meta, err);
      return {
        status: CapabilityStatus.ERROR,
        observedAt: requestedAt,
        error:
          failure.error !== undefined
            ? { ...failure.error }
            : {
                kind: CapabilityErrorKind.INTERNAL,
                message: "anonstories dossier failure",
                retryable: false,
              },
      };
    }
  }
}

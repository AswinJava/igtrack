import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
import {
  rawCommentsPageV1,
  rawDiscoveryV1,
  rawFollowPageV1,
  rawInsightsV1,
  rawPostsPageV1,
  rawProfileV1,
  rawStoriesV1,
  type RawCommentsPageV1,
  type RawDiscoveryV1,
  type RawFollowPageV1,
  type RawInsightsV1,
  type RawPostsPageV1,
  type RawProfileV1,
  type RawStoriesV1,
} from "../raw-schemas/v1.js";
import { normalizeProfile } from "../normalize/profile.js";
import { normalizeStory } from "../normalize/story.js";
import {
  normalizeComments,
  normalizeFollowPage,
  normalizePosts,
} from "../normalize/collections.js";

const fixtureManifestSchema = z.object({
  version: z.string().min(1),
  description: z.string().optional(),
  target_username: z.string().min(1),
  captured_at: z.string().datetime({ offset: true }),
  files: z.object({
    profile: z.string().min(1),
    stories: z.string().min(1),
    followers: z.array(z.string().min(1)),
    following: z.array(z.string().min(1)),
    posts: z.array(z.string().min(1)),
    comments: z.record(z.string().min(1), z.string().min(1)),
    // Optional by design: a hand-written fixture set without an insights file
    // is a complete set for what it declares — the provider answers
    // UNAVAILABLE for insights instead of rejecting the whole set.
    insights: z.string().min(1).optional(),
    // Same rule for the discovery probe (D42): optional, and its absence is
    // an UNAVAILABLE with a reason, never a schema rejection.
    discovery: z.string().min(1).optional(),
  }),
});

type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

class FixtureIoError extends Error {
  readonly kind:
    | typeof CapabilityErrorKind.SOURCE_NOT_FOUND
    | typeof CapabilityErrorKind.SCHEMA_MISMATCH;
  constructor(
    kind:
      | typeof CapabilityErrorKind.SOURCE_NOT_FOUND
      | typeof CapabilityErrorKind.SCHEMA_MISMATCH,
    message: string,
  ) {
    super(message);
    this.name = "FixtureIoError";
    this.kind = kind;
  }
}

function toProviderError(
  meta: { observedAt: string; source: SourceRef },
  err: unknown,
): CapabilityResult<never> {
  if (err instanceof FixtureIoError) {
    return errored(meta, {
      kind: err.kind,
      message: err.message.slice(0, 300),
      retryable: false,
    });
  }
  const message = err instanceof Error ? err.message : "Fixture read failed";
  const isMissing =
    message.includes("ENOENT") || message.includes("no such file");
  return errored(meta, {
    kind: isMissing
      ? CapabilityErrorKind.SOURCE_NOT_FOUND
      : CapabilityErrorKind.INTERNAL,
    message: `Fixture source failure: ${message.slice(0, 200)}`,
    retryable: false,
  });
}

export interface FixtureProviderOptions {
  fixturesDir: string;
  clock?: () => Date;
  // Version label for provenance. Must agree with the set's manifest.version:
  // the provider refuses a manifest that disagrees, so the source id can
  // never lie about which bytes were actually read.
  version?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class FixtureProvider implements InstagramProvider {
  readonly sourceId: string;

  private readonly fixturesDir: string;
  private readonly clock: () => Date;
  private readonly declaredVersion: string;
  private manifestCache?: FixtureManifest;
  private fileCache = new Map<string, string>();

  constructor(options: FixtureProviderOptions) {
    this.fixturesDir = options.fixturesDir;
    this.clock = options.clock ?? (() => new Date());
    this.declaredVersion = options.version ?? "v1";
    this.sourceId = `fixture:${this.declaredVersion}`;
  }

  capabilities(): ProviderCapabilities {
    return {
      [CapabilityName.RESOLVE_ACCOUNT]: true,
      [CapabilityName.GET_PROFILE]: true,
      [CapabilityName.GET_STORIES]: true,
      [CapabilityName.GET_FOLLOWERS]: true,
      [CapabilityName.GET_FOLLOWING]: true,
      [CapabilityName.GET_PUBLIC_POSTS]: true,
      [CapabilityName.GET_PUBLIC_COMMENTS]: true,
      // Fixture insights exercise the full absence pipeline: the payload
      // carries both points and reasons (D39).
      [CapabilityName.GET_ACCOUNT_INSIGHTS]: true,
      // Synthetic discovery probes exercise the D42 path offline; whether the
      // set actually declares a discovery file is answered per call with an
      // UNAVAILABLE + reason, like insights.
      [CapabilityName.DISCOVER_ACCOUNT]: true,
      // No child-media source ships in the v1 fixture set: honest
      // UNAVAILABLE from getPostChildren, never an empty album masquerading
      // as observed structure.
      [CapabilityName.GET_POST_CHILDREN]: false,
    };
  }

  async resolveAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedAccountRef>> {
    const meta = this.meta();
    try {
      const profile = await this.loadProfile();
      const manifest = await this.loadManifest();
      if (profile instanceof ErrorResult) return profile.asResult(meta);

      const raw = profile.value;
      if (raw.profile.username.toLowerCase() !== username.toLowerCase()) {
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: `Fixture set only contains @${raw.profile.username}, requested @${username}`,
          retryable: false,
        });
      }

      const ref: NormalizedAccountRef = {
        username: raw.profile.username,
        ...(raw.profile.id !== undefined ? { igId: raw.profile.id } : {}),
        ...(raw.profile.full_name !== undefined
          ? { displayName: raw.profile.full_name }
          : {}),
        ...(raw.profile.is_private !== undefined
          ? { isPrivate: raw.profile.is_private }
          : {}),
      };
      return available(ref, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(profile.rawText),
        rawReference: this.manifestRef(manifest.files.profile),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  async getProfile(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedProfile>> {
    const meta = this.meta(account);
    try {
      const loaded = await this.loadProfile();
      const manifest = await this.loadManifest();
      if (loaded instanceof ErrorResult) return loaded.asResult(meta);

      const raw = loaded.value;
      if (raw.profile.is_private === true) {
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_PRIVATE,
          message: "Account is private; public profile data unavailable",
          retryable: false,
        });
      }

      const normalized = normalizeProfile(raw);
      return available(normalized, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(loaded.rawText),
        rawReference: this.manifestRef(manifest.files.profile),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  async getStories(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedStory[]>> {
    const meta = this.meta(account);
    try {
      const manifest = await this.loadManifest();
      const rawText = await this.readFixture(manifest.files.stories);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawStoriesV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);

      const raw: RawStoriesV1 = parsed.data;
      const canvas = raw.canvas
        ? { width: raw.canvas.width, height: raw.canvas.height }
        : undefined;

      const stories = raw.stories.map((s) =>
        normalizeStory(s, canvas, raw.captured_at),
      );

      return available(stories, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(rawText),
        rawReference: this.manifestRef(manifest.files.stories),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  async getFollowers(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    try {
      return await this.getFollowPage("followers", account, cursor);
    } catch (err) {
      return toProviderError(this.meta(account), err);
    }
  }

  async getFollowing(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    try {
      return await this.getFollowPage("following", account, cursor);
    } catch (err) {
      return toProviderError(this.meta(account), err);
    }
  }

  async getPublicPosts(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>> {
    const meta = this.meta(account);
    try {
      const manifest = await this.loadManifest();
      const files = manifest.files.posts;
      const index = cursor === undefined ? 0 : files.indexOf(cursor.value);
      if (index < 0 || index >= files.length) {
        return errored(meta, {
          kind: CapabilityErrorKind.INTERNAL,
          message: `Unknown posts cursor: ${cursor?.value ?? "(none)"}`,
          retryable: false,
        });
      }

      const rawText = await this.readFixture(files[index]!);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawPostsPageV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);

      const raw: RawPostsPageV1 = parsed.data;
      const posts = normalizePosts(raw);

      // Continuation: the v1 cursor is the next file in manifest order. When
      // the page declares more data (next_cursor non-null), expose the next
      // file so executors can resume instead of truncating. Single-file sets
      // (next_cursor null) return no cursor — a complete listing.
      const nextFile = raw.next_cursor !== null ? files[index + 1] : undefined;
      return available(posts, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
        rawPayloadHash: sha256(rawText),
        rawReference: this.manifestRef(files[index]!),
        ...(nextFile !== undefined ? { nextCursor: nextFile } : {}),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  async getPublicComments(
    post: NormalizedPost,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>> {
    const meta = this.meta();
    try {
      if (cursor !== undefined) {
        return errored(meta, {
          kind: CapabilityErrorKind.INTERNAL,
          message: "Comment pagination is not supported by fixture:v1; request without a cursor",
          retryable: false,
        });
      }
      const manifest = await this.loadManifest();
      const file = manifest.files.comments[post.postId];
      if (file === undefined) {
        return unavailable(
          meta,
          `No comment source available for post ${post.postId} in this fixture set`,
        );
      }

      const rawText = await this.readFixture(file);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawCommentsPageV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);

      const raw: RawCommentsPageV1 = parsed.data;
      const comments = normalizeComments(raw);

      // Honesty: fixture:v1 ships one comments page per post. A payload that
      // declares more pages (next_cursor non-null) cannot be served further —
      // so the result is PARTIAL, never a complete listing in disguise.
      if (raw.next_cursor !== null) {
        return {
          status: CapabilityStatus.PARTIAL,
          data: comments,
          ...meta,
          observedAt: raw.captured_at,
          confidence: Confidence.MEDIUM,
          note: "Fixture:v1 serves one comments page per post; the payload declares further pages this source cannot serve.",
          rawPayloadHash: sha256(rawText),
          rawReference: this.manifestRef(file),
        };
      }
      return available(comments, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(rawText),
        rawReference: this.manifestRef(file),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  async getPostChildren(
    post: NormalizedPost,
  ): Promise<CapabilityResult<NormalizedPostChild[]>> {
    return unavailable(
      this.meta(),
      `No child-media source for post ${post.postId} in this fixture set`,
    );
  }

  // Documented platform rule, mirrored verbatim so the synthetic absence is
  // structurally indistinguishable from the real one (D39).
  private static readonly BELOW_100_FOLLOWERS_REASON =
    "Not returned for accounts with fewer than 100 followers (documented platform limitation); the platform returns an empty data set instead of 0.";

  async getAccountInsights(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedInsightSet>> {
    const meta = this.meta(account);
    try {
      const manifest = await this.loadManifest();
      const insightsFile = manifest.files.insights;
      if (insightsFile === undefined) {
        // Undeclared, not broken: the set simply carries no insights payload.
        // Different claim from "the platform does not expose this".
        return unavailable(
          meta,
          "This fixture set declares no insights file, so it can provide no account insight metrics. Add files.insights to the manifest to exercise the insights pipeline.",
        );
      }
      const rawText = await this.readFixture(insightsFile);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawInsightsV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);

      const raw: RawInsightsV1 = parsed.data;
      const profile = await this.loadProfile();
      const followerCount =
        profile instanceof ErrorResult ? undefined : profile.value.profile.follower_count;

      const gated = new Set(["follower_count", "follower_demographics"]);
      let points: NormalizedInsightPoint[] = raw.points.map((p) => ({
        metric: p.metric,
        period: p.period,
        ...(p.timeframe !== undefined ? { timeframe: p.timeframe } : {}),
        ...(p.dimension !== undefined ? { dimension: p.dimension } : {}),
        ...(p.dimension_value !== undefined ? { dimensionValue: p.dimension_value } : {}),
        ...(p.end_time !== undefined ? { endTime: p.end_time } : {}),
        value: p.value,
      }));
      const absences: NormalizedInsightAbsence[] = raw.absences.map((a) => ({
        metric: a.metric,
        period: a.period,
        reason: a.reason,
      }));

      // D39: below 100 followers the platform returns neither metric. The
      // synthetic set mirrors that rule from the profile's own follower count
      // instead of baking whichever branch into the payload — the pipeline
      // stays exercised either way.
      if (followerCount !== undefined && followerCount < 100) {
        points = points.filter((p) => !gated.has(p.metric));
        for (const metric of gated) {
          if (!absences.some((a) => a.metric === metric)) {
            absences.push({
              metric,
              period: metric === "follower_demographics" ? "lifetime" : "day",
              reason: FixtureProvider.BELOW_100_FOLLOWERS_REASON,
            });
          }
        }
      }

      const set: NormalizedInsightSet = {
        points,
        absences,
        ...(raw.window_since !== undefined ? { windowSince: raw.window_since } : {}),
        ...(raw.window_until !== undefined ? { windowUntil: raw.window_until } : {}),
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.MEDIUM,
          observedAt: raw.captured_at,
        },
      };
      return available(set, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.MEDIUM,
        rawPayloadHash: sha256(rawText),
        rawReference: this.manifestRef(insightsFile),
      });
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  /**
   * Synthetic counterpart of the documented Business Discovery probe (D42):
   * reads the optional discovery file and mirrors the provider semantics that
   * matter — the fixture's own target is never returned as "discovered", a
   * name the set does not carry is ACCOUNT_NOT_FOUND, and an undeclared file
   * is UNAVAILABLE with a reason (not a schema failure).
   */
  async discoverAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedDiscoveredAccount>> {
    const meta = this.meta();
    try {
      const manifest = await this.loadManifest();
      const target = username.trim().replace(/^@/, "").toLowerCase();
      if (target === "") {
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: "discoverAccount requires a non-empty username",
          retryable: false,
        });
      }
      const file = manifest.files.discovery;
      if (file === undefined) {
        return unavailable(
          meta,
          "This fixture set declares no discovery file, so it carries no other-account public data. Add files.discovery to the manifest to exercise the discovery probe.",
        );
      }
      if (target === manifest.target_username.toLowerCase()) {
        return unavailable(
          meta,
          `@${manifest.target_username} is the account this fixture set observes; use the profile path for it.`,
        );
      }
      const rawText = await this.readFixture(file);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawDiscoveryV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);

      const raw: RawDiscoveryV1 = parsed.data;
      if (raw.account.username.toLowerCase() !== target) {
        return errored(meta, {
          kind: CapabilityErrorKind.ACCOUNT_NOT_FOUND,
          message: `Fixture set contains discovery data only for @${raw.account.username}, requested @${username}`,
          retryable: false,
        });
      }

      const recentMedia = normalizePosts({
        schema_version: "v1",
        captured_at: raw.captured_at,
        posts: raw.recent_media,
        next_cursor: null,
      });      const discovered: NormalizedDiscoveredAccount = {
        account: {
          username: raw.account.username,
          igId: raw.account.id,
          ...(raw.account.full_name !== undefined
            ? { displayName: raw.account.full_name }
            : {}),
        },
        ...(raw.account.full_name !== undefined
          ? { displayName: raw.account.full_name }
          : {}),
        ...(raw.account.biography !== undefined ? { bio: raw.account.biography } : {}),
        ...(raw.account.website !== undefined ? { externalUrl: raw.account.website } : {}),
        ...(raw.account.profile_picture_url !== undefined
          ? { profilePicUrl: raw.account.profile_picture_url }
          : {}),
        ...(raw.account.followers_count !== undefined
          ? { followerCount: raw.account.followers_count }
          : {}),
        ...(raw.account.follows_count !== undefined
          ? { followingCount: raw.account.follows_count }
          : {}),
        ...(raw.account.media_count !== undefined
          ? { postCount: raw.account.media_count }
          : {}),
        recentMedia: recentMedia.slice(0, DISCOVERY_MEDIA_PREVIEW_LIMIT),
        // A fixture set stands in for the documented route, so it declares the
        // same ceiling — a synthetic run exercises the bounded-preview
        // bookkeeping exactly as the real edge would.
        recentMediaLimit: DISCOVERY_MEDIA_PREVIEW_LIMIT,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: raw.captured_at,
        },
      };
      const result = available(discovered, {
        ...meta,
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayloadHash: sha256(rawText),
        rawReference: this.manifestRef(file),
      });
      result.note =
        "Synthetic fixture probe of another account's public data (D42); nothing was persisted. Real deployments answer this from the documented Business Discovery edge.";
      return result;
    } catch (err) {
      return toProviderError(meta, err);
    }
  }

  private async getFollowPage(
    direction: "followers" | "following",
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    const meta = this.meta(account);
    const manifest = await this.loadManifest();
    const files = manifest.files[direction];

    const pages: Array<{ raw: RawFollowPageV1; rawText: string; file: string }> = [];
    for (const file of files) {
      const rawText = await this.readFixture(file);
      const json = this.parseJson(rawText);
      if (!("value" in json)) return json;
      const parsed = rawFollowPageV1.safeParse(json.value);
      if (!parsed.success) return this.schemaError(meta, parsed.error.message);
      pages.push({ raw: parsed.data, rawText, file });
    }

    let pageIndex = 0;
    if (cursor !== undefined) {
      const ownerIndex = pages.findIndex(
        (p) => p.raw.next_cursor === cursor.value,
      );
      if (ownerIndex < 0 || ownerIndex + 1 >= pages.length) {
        return errored(meta, {
          kind: CapabilityErrorKind.INTERNAL,
          message: `Unknown ${direction} cursor: ${cursor.value}`,
          retryable: false,
        });
      }
      pageIndex = ownerIndex + 1;
    }

    const page = pages[pageIndex]!;
    const normalized = normalizeFollowPage(page.raw);

    return available(normalized, {
      ...meta,
      observedAt: page.raw.captured_at,
      rawPayloadHash: sha256(page.rawText),
      rawReference: this.manifestRef(page.file),
      confidence: normalized.meta.confidence,
      ...(normalized.complete
        ? {}
        : { note: `Partial ${direction} list; more pages available` }),
    });
  }

  private meta(account?: NormalizedAccountRef): {
    observedAt: string;
    source: SourceRef;
  } {
    return {
      observedAt: this.clock().toISOString(),
      source: {
        sourceId: this.sourceId,
        kind: SourceKind.FIXTURE,
        ...(account !== undefined ? { reference: account.username } : {}),
      },
    };
  }

  private manifestRef(file: string): string {
    return `${this.sourceId}/${file}`;
  }

  private schemaError(
    meta: { observedAt: string; source: SourceRef },
    detail: string,
  ): CapabilityResult<never> {
    return errored(meta, {
      kind: CapabilityErrorKind.SCHEMA_MISMATCH,
      message: `Fixture payload failed v1 schema validation: ${detail.slice(0, 300)}`,
      retryable: false,
    });
  }

  // A malformed payload is a CapabilityResult, never a thrown exception: the
  // provider contract keeps parsing failures inside the capability model (C5).
  private parseJson(rawText: string): { value: unknown } | CapabilityResult<never> {
    try {
      return { value: JSON.parse(rawText) };
    } catch (err) {
      return this.schemaError(
        this.meta(),
        err instanceof Error ? err.message : "Fixture payload is not valid JSON",
      );
    }
  }

  private async loadManifest(): Promise<FixtureManifest> {
    if (this.manifestCache !== undefined) return this.manifestCache;
    let text: string;
    try {
      text = await readFile(join(this.fixturesDir, "manifest.json"), "utf8");
    } catch (err) {
      throw new FixtureIoError(
        CapabilityErrorKind.SOURCE_NOT_FOUND,
        `Fixture manifest missing in ${this.fixturesDir}: ${err instanceof Error ? err.message : "read failed"}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new FixtureIoError(
        CapabilityErrorKind.SCHEMA_MISMATCH,
        `Fixture manifest is not valid JSON: ${err instanceof Error ? err.message : "parse failure"}`,
      );
    }
    const validated = fixtureManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new FixtureIoError(
        CapabilityErrorKind.SCHEMA_MISMATCH,
        `Fixture manifest failed validation: ${validated.error.message.slice(0, 300)}`,
      );
    }
    if (validated.data.version !== this.declaredVersion) {
      // Provenance honesty: serving a v2 directory while labelled v1 (or the
      // reverse) would poison every evidence row with a false source id.
      throw new FixtureIoError(
        CapabilityErrorKind.SCHEMA_MISMATCH,
        `Fixture set declares version "${validated.data.version}" but the provider was constructed as "${this.declaredVersion}"`,
      );
    }
    this.manifestCache = validated.data;
    return this.manifestCache;
  }

  private async readFixture(file: string): Promise<string> {
    const cached = this.fileCache.get(file);
    if (cached !== undefined) return cached;
    try {
      const text = await readFile(join(this.fixturesDir, file), "utf8");
      this.fileCache.set(file, text);
      return text;
    } catch (err) {
      throw new FixtureIoError(
        CapabilityErrorKind.SOURCE_NOT_FOUND,
        `Fixture file missing: ${file} (${err instanceof Error ? err.message : "read failed"})`,
      );
    }
  }

  private async loadProfile(): Promise<
    | { value: RawProfileV1; rawText: string }
    | ErrorResult
  > {
    const manifest = await this.loadManifest();
    const rawText = await this.readFixture(manifest.files.profile);
    const json = this.parseJson(rawText);
    if (!("value" in json)) {
      return new ErrorResult({
        kind: CapabilityErrorKind.SCHEMA_MISMATCH,
        message: `Profile fixture is not valid JSON: ${(json.error?.message ?? "parse failure").slice(0, 300)}`,
        retryable: false,
      });
    }
    const parsed = rawProfileV1.safeParse(json.value);
    if (!parsed.success) {
      return new ErrorResult({
        kind: CapabilityErrorKind.SCHEMA_MISMATCH,
        message: `Profile fixture failed v1 schema validation: ${parsed.error.message.slice(0, 300)}`,
        retryable: false,
      });
    }
    return { value: parsed.data, rawText };
  }
}

class ErrorResult {
  constructor(readonly error: { kind: (typeof CapabilityErrorKind)[keyof typeof CapabilityErrorKind]; message: string; retryable: boolean }) {}

  asResult(meta: {
    observedAt: string;
    source: SourceRef;
  }): CapabilityResult<never> {
    return errored(meta, this.error);
  }
}

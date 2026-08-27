import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  available,
  CapabilityErrorKind,
  CapabilityName,
  Confidence,
  errored,
  SourceKind,
  stableStringify,
  unavailable,
  type CapabilityResult,
  type Cursor,
  type Evidence,
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
import {
  rawCommentsPageV1,
  rawFollowPageV1,
  rawPostsPageV1,
  rawProfileV1,
  rawStoriesV1,
  type RawCommentsPageV1,
  type RawFollowPageV1,
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

interface FixtureManifest {
  version: string;
  description?: string;
  target_username: string;
  captured_at: string;
  files: {
    profile: string;
    stories: string;
    followers: string[];
    following: string[];
    posts: string[];
    comments: Record<string, string>;
  };
}

export interface FixtureProviderOptions {
  fixturesDir: string;
  clock?: () => Date;
  evidenceSink?: (evidence: Evidence) => void;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class FixtureProvider implements InstagramProvider {
  readonly sourceId: string;

  private readonly fixturesDir: string;
  private readonly clock: () => Date;
  private readonly evidenceSink?: (evidence: Evidence) => void;
  private readonly evidenceStore: Evidence[] = [];
  private manifestCache?: FixtureManifest;
  private fileCache = new Map<string, string>();

  constructor(options: FixtureProviderOptions) {
    this.fixturesDir = options.fixturesDir;
    this.clock = options.clock ?? (() => new Date());
    if (options.evidenceSink !== undefined) {
      this.evidenceSink = options.evidenceSink;
    }
    this.sourceId = "fixture:v1";
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
    };
  }

  drainEvidence(): Evidence[] {
    return this.evidenceStore.splice(0, this.evidenceStore.length);
  }

  async resolveAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedAccountRef>> {
    const meta = this.meta();
    const profile = await this.loadProfile();
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
    });
  }

  async getProfile(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedProfile>> {
    const meta = this.meta(account);
    const loaded = await this.loadProfile();
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
    const evidenceId = this.recordEvidence({
      observationKind: "profile",
      observationId: `profile:${raw.profile.username}@${raw.captured_at}`,
      sourceReference: this.manifestRef("profile"),
      observedAt: raw.captured_at,
      confidence: Confidence.HIGH,
      rawPayload: loaded.rawText,
      normalizedPayload: stableStringify(normalized),
    });
    normalized.meta.evidenceId = evidenceId;
    return available(normalized, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: Confidence.HIGH,
    });
  }

  async getStories(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedStory[]>> {
    const meta = this.meta(account);
    const manifest = await this.loadManifest();
    const rawText = await this.readFixture(manifest.files.stories);
    const parsed = rawStoriesV1.safeParse(JSON.parse(rawText));
    if (!parsed.success) return this.schemaError(meta, parsed.error.message);

    const raw: RawStoriesV1 = parsed.data;
    const canvas = raw.canvas
      ? { width: raw.canvas.width, height: raw.canvas.height }
      : undefined;

    const stories = raw.stories.map((s) => {
      const normalized = normalizeStory(s, canvas, raw.captured_at);
      const evidenceId = this.recordEvidence({
        observationKind: "story",
        observationId: `story:${s.id}`,
        sourceReference: this.manifestRef("stories"),
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayload: stableStringify(s),
        normalizedPayload: stableStringify(normalized),
      });
      normalized.meta.evidenceId = evidenceId;
      for (const mention of normalized.mentions) {
        const mentionEvidenceId = this.recordEvidence({
          observationKind: "story_mention",
          observationId: `story_mention:${s.id}:${mention.account.username}`,
          sourceReference: this.manifestRef("stories"),
          observedAt: raw.captured_at,
          confidence: mention.meta.confidence,
          rawPayload: stableStringify(s.mentions ?? []),
          normalizedPayload: stableStringify(mention),
        });
        mention.meta.evidenceId = mentionEvidenceId;
      }
      return normalized;
    });

    return available(stories, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: Confidence.HIGH,
    });
  }

  async getFollowers(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return this.getFollowPage("followers", account, cursor);
  }

  async getFollowing(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedFollowPage>> {
    return this.getFollowPage("following", account, cursor);
  }

  async getPublicPosts(
    account: NormalizedAccountRef,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedPost[]>> {
    const meta = this.meta(account);
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
    const parsed = rawPostsPageV1.safeParse(JSON.parse(rawText));
    if (!parsed.success) return this.schemaError(meta, parsed.error.message);

    const raw: RawPostsPageV1 = parsed.data;
    const posts = normalizePosts(raw).map((post) => {
      const evidenceId = this.recordEvidence({
        observationKind: "post",
        observationId: `post:${post.postId}`,
        sourceReference: this.manifestRef(files[index]!),
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayload: rawText,
        normalizedPayload: stableStringify(post),
      });
      post.meta.evidenceId = evidenceId;
      return post;
    });

    return available(posts, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
    });
  }

  async getPublicComments(
    post: NormalizedPost,
    cursor?: Cursor,
  ): Promise<CapabilityResult<NormalizedComment[]>> {
    const meta = this.meta();
    const manifest = await this.loadManifest();
    const file = manifest.files.comments[post.postId];
    if (file === undefined) {
      return unavailable(
        meta,
        `No comment source available for post ${post.postId} in this fixture set`,
      );
    }

    const rawText = await this.readFixture(file);
    const parsed = rawCommentsPageV1.safeParse(JSON.parse(rawText));
    if (!parsed.success) return this.schemaError(meta, parsed.error.message);

    const raw: RawCommentsPageV1 = parsed.data;
    const comments = normalizeComments(raw).map((comment) => {
      const evidenceId = this.recordEvidence({
        observationKind: "comment",
        observationId: `comment:${comment.commentId}`,
        sourceReference: this.manifestRef(file),
        observedAt: raw.captured_at,
        confidence: Confidence.HIGH,
        rawPayload: rawText,
        normalizedPayload: stableStringify(comment),
      });
      comment.meta.evidenceId = evidenceId;
      return comment;
    });

    return available(comments, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
    });
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
      const parsed = rawFollowPageV1.safeParse(JSON.parse(rawText));
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
    const evidenceId = this.recordEvidence({
      observationKind: `${direction}_page`,
      observationId: `${direction}:page:${pageIndex}@${page.raw.captured_at}`,
      sourceReference: this.manifestRef(page.file),
      observedAt: page.raw.captured_at,
      confidence: normalized.meta.confidence,
      rawPayload: page.rawText,
      normalizedPayload: stableStringify(normalized),
    });
    normalized.meta.evidenceId = evidenceId;

    return available(normalized, {
      ...meta,
      observedAt: page.raw.captured_at,
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
    return `fixture:v1/${file}`;
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

  private recordEvidence(input: {
    observationKind: string;
    observationId: string;
    sourceReference: string;
    observedAt: string;
    confidence: Confidence;
    rawPayload: string;
    normalizedPayload: string;
  }): string {
    const rawHash = sha256(input.rawPayload);
    const normalizedHash = sha256(input.normalizedPayload);
    const evidenceId = `ev_${rawHash.slice(0, 12)}_${normalizedHash.slice(0, 12)}`;
    const evidence: Evidence = {
      observationKind: input.observationKind,
      observationId: input.observationId,
      sourceType: SourceKind.FIXTURE,
      sourceReference: input.sourceReference,
      observedAt: input.observedAt,
      capturedAt: this.clock().toISOString(),
      confidence: input.confidence,
      rawHash,
      normalizedHash,
    };
    this.evidenceStore.push(evidence);
    this.evidenceSink?.(evidence);
    return evidenceId;
  }

  private async loadManifest(): Promise<FixtureManifest> {
    if (this.manifestCache !== undefined) return this.manifestCache;
    const text = await readFile(join(this.fixturesDir, "manifest.json"), "utf8");
    this.manifestCache = JSON.parse(text) as FixtureManifest;
    return this.manifestCache;
  }

  private async readFixture(file: string): Promise<string> {
    const cached = this.fileCache.get(file);
    if (cached !== undefined) return cached;
    const text = await readFile(join(this.fixturesDir, file), "utf8");
    this.fileCache.set(file, text);
    return text;
  }

  private async loadProfile(): Promise<
    | { value: RawProfileV1; rawText: string }
    | ErrorResult
  > {
    const manifest = await this.loadManifest();
    const rawText = await this.readFixture(manifest.files.profile);
    const parsed = rawProfileV1.safeParse(JSON.parse(rawText));
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

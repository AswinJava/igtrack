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
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class FixtureProvider implements InstagramProvider {
  readonly sourceId: string;

  private readonly fixturesDir: string;
  private readonly clock: () => Date;
  private manifestCache?: FixtureManifest;
  private fileCache = new Map<string, string>();

  constructor(options: FixtureProviderOptions) {
    this.fixturesDir = options.fixturesDir;
    this.clock = options.clock ?? (() => new Date());
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

  async resolveAccount(
    username: string,
  ): Promise<CapabilityResult<NormalizedAccountRef>> {
    const meta = this.meta();
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
  }

  async getProfile(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedProfile>> {
    const meta = this.meta(account);
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
  }

  async getStories(
    account: NormalizedAccountRef,
  ): Promise<CapabilityResult<NormalizedStory[]>> {
    const meta = this.meta(account);
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
    const json = this.parseJson(rawText);
    if (!("value" in json)) return json;
    const parsed = rawPostsPageV1.safeParse(json.value);
    if (!parsed.success) return this.schemaError(meta, parsed.error.message);

    const raw: RawPostsPageV1 = parsed.data;
    const posts = normalizePosts(raw);

    return available(posts, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
      rawPayloadHash: sha256(rawText),
      rawReference: this.manifestRef(files[index]!),
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
    const json = this.parseJson(rawText);
    if (!("value" in json)) return json;
    const parsed = rawCommentsPageV1.safeParse(json.value);
    if (!parsed.success) return this.schemaError(meta, parsed.error.message);

    const raw: RawCommentsPageV1 = parsed.data;
    const comments = normalizeComments(raw);

    return available(comments, {
      ...meta,
      observedAt: raw.captured_at,
      confidence: raw.next_cursor === null ? Confidence.HIGH : Confidence.MEDIUM,
      rawPayloadHash: sha256(rawText),
      rawReference: this.manifestRef(file),
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
    const json = this.parseJson(rawText);
    if (!("value" in json)) {
      return new ErrorResult({
        kind: CapabilityErrorKind.SCHEMA_MISMATCH,
        message: `Profile fixture is not valid JSON: ${json.error.message.slice(0, 300)}`,
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

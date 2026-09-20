import {
  Confidence,
  type NormalizedStory,
} from "@igtrack/core";
import { normalizeStory } from "../normalize/story.js";
import { rawStoryV1 } from "../raw-schemas/v1.js";
import { asBoolean, asNumber, asString, type JsonRecord } from "./ssr.js";

// ---------------------------------------------------------------------------
// anonstories.com — protocol, classification and parsing.
//
// What this site is: a third-party, login-free aggregator that answers three
// POST endpoints with Instagram's own story/highlight objects. Everything here
// was established against the site's shipped bundle (c.js) and live responses:
//
//   POST /api/v1/story            auth = base64url("-1::<username>::" + CRED)
//   POST /api/v1/highlights       auth = base64url("-1::<username>::" + CRED)
//   POST /api/v1/highlight/stories auth = base64url("<userId>::<username>::<highlightId>::" + CRED)
//
// Form-encoded (application/x-www-form-urlencoded), header
// x-requested-with: XMLHttpRequest, same-origin — and only from inside a page
// on the origin: a non-browser client is refused by Cloudflare with 403, so
// the transport that carries these calls runs them in a local Chrome page
// context (anonstories-chrome.ts).
//
// Response envelope shared by all three (field presence varies per endpoint):
//   { user_info, picture?, stories?|highlights?|items?, message, ticket, queue }
//
//   queue   — unix epoch seconds when the server will have the result; the
//             site waits until then and re-posts. Treated as "not ready yet",
//             never as data.
//   ticket  — numeric processing marker; a numeric ticket with no subject and
//             no message is how the site reports an invalid username.
//   message — the server's own refusal text ("User not found", rate-limit and
//             error strings). Carried through verbatim, never reworded into a
//             result.
//
// Anti-bot decoy: with the `HeadlessChrome` user agent the server answers
// 200 with a DIFFERENT account's fabricated profile and placeholder stories
// (a `no-image.jpeg` source) instead of the requested one. Proven by toggling
// only the UA on a live session: same navigator.webdriver value, decoy came
// back the moment the UA read HeadlessChrome. The transport therefore presents
// a desktop Chrome UA, and every response is re-checked against the requested
// username below — a mismatch is classified DECOY and rejected, never stored.
//
// Rate limit: ~5 rapid calls answer HTTP 429 {"message":"Too many requests"}.
// Calls are paced (ANON_PACE_MS) and retried with the site's own backoff
// ladder; a response that still rate-limits after the ladder is an error with
// a reason, never an empty result.
//
// Confidence: this is a third-party relay of platform data, so observations
// carry MEDIUM confidence structurally (the source kind is PUBLIC_AGGREGATOR
// on every row), and story mentions have no sticker geometry here — they are
// metadata-only mentions classified by the normal taxonomy (METADATA_ONLY).
// ---------------------------------------------------------------------------

export const ANONSTORIES_ORIGIN = "https://anonstories.com";

export const ANON_ENDPOINTS = {
  story: "/api/v1/story",
  highlights: "/api/v1/highlights",
  highlightStories: "/api/v1/highlight/stories",
} as const;

/** Minimum spacing between two API calls from one session (the site's ~5-call limit). */
export const ANON_PACE_MS = 5_000;
/** Backoff ladder for HTTP 429, mirroring the site's own retry behaviour. */
export const ANON_RATE_LIMIT_DELAYS_MS: readonly number[] = [20_000, 40_000];
/** How long one `queue` epoch may be honoured before the read gives up. */
export const ANON_QUEUE_BOUND_MS = 90_000;
/** Page settle time after load (the bundle fires a rate-limit probe on load). */
export const ANON_SETTLE_MS = 3_000;

// The aggregator's client credential, shipped verbatim inside its own public
// JavaScript bundle (the `l` constant of c.js). It is not an operator secret,
// no account login exists behind it, and the site may rotate or revoke it at
// any time — which would surface as a refusal with the server's message, not
// as fabricated data.
const ANON_CRED = "LTE6Om11cmllbGdhbGxlOjpySlAydEJSS2Y2a3RiUnFQVUJ0UkU5a2xnQldiN2Q-";

/** base64 with the URL-safe alphabet the site uses: `.` `_` `-` instead of `+` `/` `=`. */
export function anonB64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, ".")
    .replace(/\//g, "_")
    .replace(/=/g, "-");
}

export function anonStoryAuth(username: string): string {
  return anonB64Url(`-1::${username}::${ANON_CRED}`);
}

export function anonHighlightStoriesAuth(
  userId: string | number,
  username: string,
  highlightId: string,
): string {
  return anonB64Url(`${userId}::${username}::${highlightId}::${ANON_CRED}`);
}

export interface AnonHttpResponse {
  status: number;
  body: string;
}

/**
 * One live session against the aggregator. `request` performs exactly one
 * API call (the session owns pacing and the browser context); provider-level
 * classification and retry decide what a response means.
 */
export interface AnonStoriesTransport {
  request(endpoint: string, auth: string): Promise<AnonHttpResponse>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Subjects and items
// ---------------------------------------------------------------------------

export interface AnonSubject {
  username: string;
  /**
   * The aggregator's numeric account id — Instagram's legacy `pk`, not the
   * IGSID the Graph API and the public page use. It addresses aggregator
   * endpoints and is never written as an account's platform id: doing so
   * collides with the same account already observed through public/Graph.
   */
  pk?: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  profilePicUrl?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
}

export interface AnonMention {
  username: string;
  /** Legacy `pk` from the aggregator, not an IGSID — kept for reference only. */
  pk?: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  /** True when this account is also the author of the reshared story reposted here. */
  isReshareAuthor?: boolean;
}

export interface AnonStoryItem {
  storyId?: string;
  mediaType?: "image" | "video";
  /** The site's own relative age string exactly as returned ("23 hours"). */
  takenAtLabel?: string;
  /** ISO publication time parsed from the unix timestamp the item carried. */
  publishedAt?: string;
  /** Provider-supplied media URL (the aggregator's embed proxy), never reconstructed. */
  mediaUrl?: string;
  thumbnailUrl?: string;
  linkUrl?: string;
  mentions: AnonMention[];
  reshareAuthor?: AnonMention;
}

export interface AnonItemsParse {
  items: AnonStoryItem[];
  /** Items that could not be represented, with the exact reason — never silent. */
  dropped: number;
  dropReasons: string[];
}

export interface AnonHighlightRef {
  id: string;
  title?: string;
  coverUrl?: string;
}

export interface AnonHighlightContents {
  title?: string;
  coverUrl?: string;
  items: AnonStoryItem[];
  dropped: number;
  dropReasons: string[];
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type AnonClass =
  /** HTTP 429 / the site's own "Too many requests" — back off and retry. */
  | { kind: "rate-limited" }
  /** Server says the result is ready at this unix epoch; wait and re-post. */
  | { kind: "queued"; readyAtEpochSec: number }
  /** A real answer about the requested account (public). */
  | { kind: "ok"; body: JsonRecord }
  /** The subject exists but is private: the aggregator refuses item reads. */
  | { kind: "private"; subject: AnonSubject }
  /** Placeholder answer for a different account — the headless-UA decoy. */
  | { kind: "decoy"; servedUsername: string | null; detail: string }
  /** The server's own "not found" for this username. */
  | { kind: "not-found"; message: string }
  /** Any other server refusal, carried verbatim. */
  | { kind: "refused"; message: string }
  /** Numeric ticket, no subject, no message: how the site reports a bad username. */
  | { kind: "invalid-username" }
  /** The response was not the documented envelope at all. */
  | { kind: "malformed"; detail: string };

export function parseAnonSubject(value: unknown): AnonSubject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const username = asString(record.username);
  if (username === undefined || username === "") return null;
  const id = asString(record.id) ?? asNumber(record.id);
  const fullName = asString(record.full_name);
  const isPrivate = asBoolean(record.is_private);
  const isVerified = asBoolean(record.is_verified);
  const profilePicUrl = asString(record.profile_pic_url);
  const followers = asNumber(record.followers);
  const following = asNumber(record.following);
  const posts = asNumber(record.posts);
  return {
    username,
    ...(id !== undefined ? { pk: String(id) } : {}),
    ...(fullName !== undefined ? { fullName } : {}),
    ...(isPrivate !== undefined ? { isPrivate } : {}),
    ...(isVerified !== undefined ? { isVerified } : {}),
    ...(profilePicUrl !== undefined ? { profilePicUrl } : {}),
    ...(followers !== undefined ? { followerCount: followers } : {}),
    ...(following !== undefined ? { followingCount: following } : {}),
    ...(posts !== undefined ? { postCount: posts } : {}),
  };
}

function looksPlaceholder(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => looksPlaceholder(item));
  if (value === null || typeof value !== "object") return false;
  const record = value as JsonRecord;
  const source = asString(record.source) ?? asString(record.thumbnail) ?? "";
  if (/no-image\.jpeg/i.test(source)) return true;
  return Object.values(record).some((child) => looksPlaceholder(child));
}

export function classifyAnonResponse(
  response: AnonHttpResponse,
  requestedUsername: string,
): AnonClass {
  const trimmed = response.body.trim();
  if (
    response.status === 429 ||
    (response.status === 200 && /^{"message":\s*"Too many requests"}/i.test(trimmed))
  ) {
    return { kind: "rate-limited" };
  }
  if (response.status !== 200) {
    return { kind: "malformed", detail: `unexpected HTTP ${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "malformed", detail: "response body is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", detail: "response body is not a JSON object" };
  }
  const body = parsed as JsonRecord;

  const queue = asNumber(body.queue);
  if (queue !== undefined && Number.isFinite(queue)) {
    return { kind: "queued", readyAtEpochSec: queue };
  }

  // Highlight contents answer without a subject: the item array is the proof
  // of a real answer for that endpoint.
  if (Array.isArray(body.items)) {
    return { kind: "ok", body };
  }

  const subject = parseAnonSubject(body.user_info);
  if (subject !== null) {
    if (subject.username.toLowerCase() !== requestedUsername.toLowerCase().replace(/^@/, "")) {
      return {
        kind: "decoy",
        servedUsername: subject.username,
        detail: `the aggregator answered with @${subject.username} for a request about @${requestedUsername}`,
      };
    }
    if (looksPlaceholder(body.stories)) {
      return {
        kind: "decoy",
        servedUsername: subject.username,
        detail: "the aggregator answered with placeholder story media (no-image.jpeg)",
      };
    }
    if (subject.isPrivate === true) {
      return { kind: "private", subject };
    }
    return { kind: "ok", body };
  }

  const message = asString(body.message);
  if (message !== undefined && message !== "") {
    if (/not found/i.test(message)) return { kind: "not-found", message };
    return { kind: "refused", message };
  }

  if (asNumber(body.ticket) !== undefined) {
    return { kind: "invalid-username" };
  }

  return {
    kind: "malformed",
    detail: `envelope carried none of user_info, items, message, ticket or queue (keys: ${Object.keys(body).join(", ")})`,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isoFromUnix(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return undefined;
  // 2000-01-01 .. 2100-01-01: outside that window a "timestamp" is not one.
  if (seconds < 946684800 || seconds > 4102444800) return undefined;
  return new Date(Math.round(seconds) * 1000).toISOString();
}

function absoluteUrl(value: unknown): string | undefined {
  const candidate = asString(value);
  if (candidate === undefined || candidate === "") return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseMentionUser(value: unknown): AnonMention | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const username = asString(record.username);
  if (username === undefined || username === "") return null;
  const pk = asString(record.pk) ?? asNumber(record.pk);
  const fullName = asString(record.full_name);
  const isPrivate = asBoolean(record.is_private);
  const isVerified = asBoolean(record.is_verified);
  return {
    username,
    ...(pk !== undefined ? { pk: String(pk) } : {}),
    ...(fullName !== undefined ? { fullName } : {}),
    ...(isPrivate !== undefined ? { isPrivate } : {}),
    ...(isVerified !== undefined ? { isVerified } : {}),
  };
}

/**
 * The story item's mentioned accounts. `mentions` (usernames) and
 * `mentioned_users` (profile records) are NOT index-aligned in the real
 * responses — one observed item listed mentions in the opposite order of its
 * users — so the two are merged by USERNAME, never by position. The result is
 * the union: every account either array names on this item.
 */
function mergeMentions(record: JsonRecord): {
  mentions: AnonMention[];
  reshareAuthor: AnonMention | undefined;
} {
  const byName = new Map<string, AnonMention>();
  const order: string[] = [];

  const usernames = Array.isArray(record.mentions) ? record.mentions : [];
  for (const entry of usernames) {
    const username = asString(entry);
    if (username === undefined || username === "") continue;
    const key = username.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, { username });
      order.push(key);
    }
  }

  const users = Array.isArray(record.mentioned_users) ? record.mentioned_users : [];
  for (const entry of users) {
    const user = parseMentionUser(entry);
    if (user === null) continue;
    const key = user.username.toLowerCase();
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, user);
      order.push(key);
    } else {
      byName.set(key, { ...user, username: existing.username });
    }
  }

  const reshareAuthor = parseMentionUser(record.reshared_story_media_author) ?? undefined;
  if (reshareAuthor !== undefined) {
    const key = reshareAuthor.username.toLowerCase();
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, { ...reshareAuthor, isReshareAuthor: true });
      order.push(key);
    } else {
      byName.set(key, { ...existing, isReshareAuthor: true });
    }
  }

  return {
    mentions: order.map((key) => byName.get(key)).filter((m): m is AnonMention => m !== undefined),
    reshareAuthor,
  };
}

export function parseAnonItems(value: unknown): AnonItemsParse {
  const items: AnonStoryItem[] = [];
  let dropped = 0;
  const dropReasons: string[] = [];
  if (!Array.isArray(value)) {
    return { items, dropped, dropReasons: ["the response carried no item array"] };
  }
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      dropped += 1;
      dropReasons.push("an item was not an object");
      continue;
    }
    const record = entry as JsonRecord;
    const { mentions, reshareAuthor } = mergeMentions(record);
    const storyId = asString(record.id);
    const publishedAt =
      isoFromUnix(record.taken_at_timestamp) ?? isoFromUnix(record.taken_at_raw);
    if (storyId === undefined || storyId === "") {
      dropped += 1;
      dropReasons.push("an item carried no id and cannot be keyed");
      continue;
    }
    const mediaType = asString(record.media_type);
    const takenAtLabel = asString(record.taken_at);
    const mediaUrl = absoluteUrl(record.source);
    const thumbnailUrl = absoluteUrl(record.thumbnail);
    const linkUrl = absoluteUrl(record.link);
    items.push({
      storyId,
      ...(mediaType === "image" || mediaType === "video" ? { mediaType } : {}),
      ...(takenAtLabel !== undefined ? { takenAtLabel } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(mediaUrl !== undefined ? { mediaUrl } : {}),
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      ...(linkUrl !== undefined ? { linkUrl } : {}),
      mentions,
      ...(reshareAuthor !== undefined ? { reshareAuthor } : {}),
    });
  }
  return { items, dropped, dropReasons };
}

/** Highlights list: `[{ node: { id, title, cover_media: { thumbnail_src } } }, …]`. */
export function parseAnonHighlightRefs(value: unknown): AnonHighlightRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: AnonHighlightRef[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const node = (entry as JsonRecord).node;
    if (node === null || typeof node !== "object") continue;
    const record = node as JsonRecord;
    const id = asString(record.id);
    if (id === undefined || id === "") continue;
    const coverMedia = record.cover_media;
    const cover =
      coverMedia !== null && typeof coverMedia === "object"
        ? asString((coverMedia as JsonRecord).thumbnail_src)
        : undefined;
    refs.push({
      id,
      ...(asString(record.title) !== undefined ? { title: asString(record.title) as string } : {}),
      ...(cover !== undefined ? { coverUrl: cover } : {}),
    });
  }
  return refs;
}

export function parseAnonHighlightContents(body: JsonRecord): AnonHighlightContents {
  const parsed = parseAnonItems(body.items);
  const title = asString(body.title);
  const coverMedia = body.cover_media;
  const cover =
    coverMedia !== null && coverMedia !== undefined && typeof coverMedia === "object"
      ? asString((coverMedia as JsonRecord).thumbnail_src) ??
        asString((coverMedia as JsonRecord).url)
      : undefined;
  return {
    ...(title !== undefined ? { title } : {}),
    ...(cover !== undefined ? { coverUrl: cover } : {}),
    items: parsed.items,
    dropped: parsed.dropped,
    dropReasons: parsed.dropReasons,
  };
}

export function anonStoriesOf(body: JsonRecord): AnonItemsParse {
  return parseAnonItems(body.stories);
}

/**
 * Convert parsed items into the pipeline's NormalizedStory rows.
 *
 * The raw story schema requires an id and an ISO publication time; an item
 * without a readable timestamp cannot be represented and is counted here and
 * reported by the caller — never back-dated, never invented from the relative
 * age string.
 */
export function toNormalizedStories(
  parse: AnonItemsParse,
  observedAt: string,
  confidence: Confidence = Confidence.MEDIUM,
): { stories: NormalizedStory[]; skipped: number; reasons: string[] } {
  const stories: NormalizedStory[] = [];
  const reasons = [...parse.dropReasons];
  let skipped = 0;
  for (const item of parse.items) {
    if (item.storyId === undefined) {
      skipped += 1;
      reasons.push("an item carried no id");
      continue;
    }
    if (item.publishedAt === undefined) {
      skipped += 1;
      reasons.push(`story ${item.storyId} carried no readable publication timestamp`);
      continue;
    }
    const candidate = {
      id: item.storyId,
      taken_at: item.publishedAt,
      ...(item.mediaType !== undefined ? { media_type: item.mediaType } : {}),
      ...(item.linkUrl !== undefined ? { link_url: item.linkUrl } : {}),
      mentions: item.mentions.map((mention) => ({ username: mention.username })),
    };
    const validated = rawStoryV1.safeParse(candidate);
    if (!validated.success) {
      skipped += 1;
      reasons.push(`story ${item.storyId}: ${validated.error.issues[0]?.message ?? "schema mismatch"}`);
      continue;
    }
    const normalized = normalizeStory(validated.data, undefined, observedAt);
    // The aggregator is a third-party relay: the observation stays MEDIUM even
    // where the normalizer's own default would be HIGH.
    stories.push({ ...normalized, meta: { ...normalized.meta, confidence } });
  }
  return { stories, skipped, reasons };
}

/** Aggregated mention index for a dossier: who was named, and where. */
export interface AnonMentionIndexEntry {
  username: string;
  /** Legacy `pk` reported by the aggregator, never a platform (IGSID) binding. */
  pk?: string;
  fullName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  isReshareAuthor: boolean;
  /** Where the mention was observed: "story" or `highlight:<title>`. */
  seenIn: string[];
  itemCount: number;
}

/**
 * Only `mentions` is read here, so story rows and highlight rows (and any
 * future item shape) feed the same index without a cast.
 */
export function buildMentionIndex(
  sections: Array<{ label: string; items: Array<{ mentions: AnonMention[] }> }>,
): AnonMentionIndexEntry[] {
  const byName = new Map<string, AnonMentionIndexEntry>();
  for (const section of sections) {
    const seenHere = new Set<string>();
    for (const item of section.items) {
      for (const mention of item.mentions) {
        const key = mention.username.toLowerCase();
        const existing = byName.get(key);
        if (existing === undefined) {
          byName.set(key, {
            username: mention.username,
            ...(mention.pk !== undefined ? { pk: mention.pk } : {}),
            ...(mention.fullName !== undefined ? { fullName: mention.fullName } : {}),
            ...(mention.isPrivate !== undefined ? { isPrivate: mention.isPrivate } : {}),
            ...(mention.isVerified !== undefined ? { isVerified: mention.isVerified } : {}),
            isReshareAuthor: mention.isReshareAuthor === true,
            seenIn: [section.label],
            itemCount: 1,
          });
        } else {
          existing.itemCount += 1;
          if (mention.isReshareAuthor === true) existing.isReshareAuthor = true;
          if (mention.fullName !== undefined) existing.fullName = mention.fullName;
          if (mention.isPrivate !== undefined) existing.isPrivate = mention.isPrivate;
          if (mention.pk !== undefined) existing.pk = mention.pk;
        }
        seenHere.add(key);
      }
    }
    // One label per section even when several items named the same account.
    for (const key of seenHere) {
      const entry = byName.get(key);
      if (entry !== undefined && !entry.seenIn.includes(section.label)) {
        entry.seenIn.push(section.label);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.username.localeCompare(b.username));
}

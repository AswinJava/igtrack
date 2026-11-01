import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { IG_USERNAME_PATTERN } from "../config/readiness.js";

// ---------------------------------------------------------------------------
// Public-archive profile-count history.
//
// A logged-out public profile page carries exact follower / following / post
// counts inside its embedded JSON. Public web archives have captured those
// pages for years, each capture stamped with the time the archive saw it. Those
// captures are the only lawful way to say anything about an account's recent
// count movement on the FIRST look: the platform exposes no count history, no
// follow timestamps, and no roster for an account this deployment does not own.
//
// What this is: a third-party public-web record of counts at capture times.
// What it is not: an observation of the account now, a roster, or proof that a
// specific person followed or unfollowed. Only exact integers from embedded
// JSON are accepted — the rounded "104M followers" prose is never recorded as
// a count, because a rounded figure cannot support a delta.
//
// Bounds: one index query, a bounded number of capture reads, per-request
// timeout and byte cap, sequential-with-small-concurrency reads, and reads
// only from the archive host. Every capture that could not be read, or that
// carried no exact counts, is counted and reported — never silently dropped
// into "no history".
// ---------------------------------------------------------------------------

export const ARCHIVE_PROFILE_SOURCE_ID = "archive:wayback:v1";
export const ARCHIVE_PROFILE_SOURCE_NAME = "Public web archive (profile captures)";

export interface ArchivedProfileCounts {
  /** When the archive captured the page — the time the counts describe. */
  capturedAt: Date;
  /** The raw capture URL that was read. */
  captureUrl: string;
  /** The page URL the archive captured. */
  originalUrl: string;
  /** Exact integers from embedded JSON; null when that figure was absent. */
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  /** sha256 of the decoded page bytes, for the evidence row. */
  contentSha256: string;
}

export interface ArchiveHistoryOptions {
  windowDays?: number | undefined;
  maxCaptures?: number | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  now?: Date | undefined;
  /** Test seam: replaces the network transport entirely. */
  fetchImpl?: ((url: string, init: { signal: AbortSignal }) => Promise<ArchiveHttpResponse>) | undefined;
}

export interface ArchiveHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ArchiveHistoryResult {
  state: "OBSERVED" | "EMPTY" | "UNAVAILABLE";
  username: string;
  windowDays: number;
  from: string;
  to: string;
  /** Capture rows the index returned inside the window. */
  capturesFound: number;
  /** Captures whose bytes were read (successfully or not). */
  capturesRead: number;
  /** Captures that produced at least one exact count. */
  capturesWithCounts: number;
  /** Captures read but skipped: no exact integer counts in the payload. */
  capturesWithoutCounts: number;
  /** Captures that could not be read at all (network, HTTP, oversized, wrong host). */
  capturesFailed: number;
  points: ArchivedProfileCounts[];
  /** Why the state is EMPTY / UNAVAILABLE; null when OBSERVED. */
  reason: string | null;
  notes: string[];
  /** Every URL this run asked for, in order. */
  consultedUrls: string[];
}

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const RAW_CAPTURE_PREFIX = "https://web.archive.org/web/";
const ALLOWED_HOST = "web.archive.org";
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_CAPTURES = 12;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

interface CdxRow {
  timestamp: string;
  original: string;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseTimestamp(value: string): Date | null {
  // CDX timestamps are UTC: YYYYMMDDhhmmss.
  if (!/^\d{14}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** The archive may serve the stored bytes gzip-compressed without the header. */
function decodeBody(body: Uint8Array, maxOutputBytes: number): Uint8Array {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    // The compressed size is capped before this point, but a few kilobytes of
    // gzip can still expand far past the cap, so the limit is applied to the
    // decompressed output as well.
    return new Uint8Array(gunzipSync(body, { maxOutputLength: maxOutputBytes }));
  }
  return body;
}

function exactInt(body: string, patterns: readonly RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match === null) continue;
    const digits = match[1];
    if (digits === undefined) continue;
    const value = Number.parseInt(digits, 10);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

const FOLLOWER_PATTERNS = [
  /"follower_count"\s*:\s*(\d+)/,
  /"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
] as const;
const FOLLOWING_PATTERNS = [
  /"following_count"\s*:\s*(\d+)/,
  /"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
] as const;
const POST_PATTERNS = [
  /"all_media_count"\s*:\s*(\d+)/,
  /"media_count"\s*:\s*(\d+)/,
  /"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
] as const;

function mentionsAccount(body: string, username: string): boolean {
  const quoted = new RegExp(`"username"\\s*:\\s*"${username}"`, "i");
  if (quoted.test(body)) return true;
  const canonical = new RegExp(`instagram\\.com/${username}/?["'<]`, "i");
  return canonical.test(body);
}

function isProfileUrl(original: string, username: string): boolean {
  try {
    const url = new URL(original);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com") return false;
    const path = url.pathname.toLowerCase();
    return path === `/${username}/` || path === `/${username}`;
  } catch {
    return false;
  }
}

function parseCdxRows(payload: unknown): CdxRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: CdxRow[] = [];
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [timestamp, original] = entry;
    if (typeof timestamp !== "string" || typeof original !== "string") continue;
    rows.push({ timestamp, original });
  }
  return rows;
}

async function readBounded(
  response: ArchiveHttpResponse,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { failure: string }> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (Number.isSafeInteger(size) && size > maxBytes) {
      return { failure: `response declares ${size} bytes, above the ${maxBytes}-byte cap` };
    }
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return { failure: `response is ${buffer.byteLength} bytes, above the ${maxBytes}-byte cap` };
  }
  try {
    return { bytes: decodeBody(new Uint8Array(buffer), maxBytes) };
  } catch {
    return {
      failure: `response unpacked past the ${maxBytes}-byte cap, so its bytes were not read`,
    };
  }
}

/**
 * Read the public archive's captures of one account's profile page and extract
 * the exact counts each capture carried.
 */
export async function fetchArchivedProfileHistory(
  username: string,
  options: ArchiveHistoryOptions = {},
): Promise<ArchiveHistoryResult> {
  const normalized = username.trim().toLowerCase().replace(/^@/, "");
  const windowDays = Math.max(1, Math.min(options.windowDays ?? DEFAULT_WINDOW_DAYS, 365));
  const maxCaptures = Math.max(1, Math.min(options.maxCaptures ?? DEFAULT_MAX_CAPTURES, 40));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const fetchImpl =
    options.fetchImpl ??
    ((url: string, init: { signal: AbortSignal }) => fetch(url, init) as Promise<ArchiveHttpResponse>);

  const base: ArchiveHistoryResult = {
    state: "EMPTY",
    username: normalized,
    windowDays,
    from: from.toISOString(),
    to: now.toISOString(),
    capturesFound: 0,
    capturesRead: 0,
    capturesWithCounts: 0,
    capturesWithoutCounts: 0,
    capturesFailed: 0,
    points: [],
    reason: null,
    notes: [],
    consultedUrls: [],
  };

  if (!IG_USERNAME_PATTERN.test(normalized)) {
    return {
      ...base,
      state: "UNAVAILABLE",
      reason: `"${username}" is not a valid Instagram username, so no archive query was made.`,
    };
  }

  const cdxUrl =
    `${CDX_ENDPOINT}?` +
    new URLSearchParams({
      url: `instagram.com/${normalized}/`,
      output: "json",
      from: utcDay(from),
      to: utcDay(now),
      filter: "statuscode:200",
      collapse: "timestamp:8",
      fl: "timestamp,original",
      limit: String(maxCaptures),
      fastLatest: "true",
    }).toString();
  base.consultedUrls.push(cdxUrl);

  let cdxPayload: unknown;
  try {
    const response = await fetchImpl(cdxUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      return {
        ...base,
        state: "UNAVAILABLE",
        reason: `The public archive index answered HTTP ${response.status}; this is a failure to look, not proof that no capture exists.`,
      };
    }
    const index = await readBounded(response, maxBytes);
    if ("failure" in index) {
      return {
        ...base,
        state: "UNAVAILABLE",
        reason:
          `The public archive index was not read: ${index.failure}. ` +
          "This is a failure to look, not proof that no capture exists.",
      };
    }
    const text = Buffer.from(index.bytes).toString("utf8").trim();
    cdxPayload = text === "" ? [] : JSON.parse(text);
  } catch (err) {
    return {
      ...base,
      state: "UNAVAILABLE",
      reason:
        "The public archive index could not be reached" +
        (err instanceof Error ? `: ${err.message}` : "") +
        ". This is a failure to look, not proof that no capture exists.",
    };
  }

  const rows = parseCdxRows(cdxPayload)
    .filter((row) => isProfileUrl(row.original, normalized))
    .map((row) => ({ row, at: parseTimestamp(row.timestamp) }))
    .filter((entry): entry is { row: CdxRow; at: Date } => entry.at !== null)
    .filter((entry) => entry.at.getTime() >= from.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  base.capturesFound = rows.length;
  if (rows.length === 0) {
    return {
      ...base,
      state: "EMPTY",
      reason: `The public archive holds no capture of instagram.com/${normalized}/ in the last ${windowDays} day(s). That is an absence of archive coverage, not a statement about the account's activity.`,
      notes: [
        "Archive coverage is per-account and uneven: a missing capture proves nothing about what the account did.",
        "Counts on a capture describe the moment the archive saw the page, not the moment a follow happened.",
      ],
    };
  }

  const points: ArchivedProfileCounts[] = [];
  const seen = new Set<number>();
  const notes: string[] = [];
  for (const { row, at } of rows) {
    if (points.length >= maxCaptures) break;
    if (seen.has(at.getTime())) continue;
    const captureUrl = `${RAW_CAPTURE_PREFIX}${row.timestamp}id_/${row.original}`;
    base.consultedUrls.push(captureUrl);
    base.capturesRead += 1;
    try {
      const response = await fetchImpl(captureUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) {
        base.capturesFailed += 1;
        notes.push(`${row.timestamp}: archive returned HTTP ${response.status}; the capture was skipped.`);
        continue;
      }
      const bounded = await readBounded(response, maxBytes);
      if ("failure" in bounded) {
        base.capturesFailed += 1;
        notes.push(`${row.timestamp}: ${bounded.failure}; the capture was skipped.`);
        continue;
      }
      const body = Buffer.from(bounded.bytes).toString("utf8");
      if (!mentionsAccount(body, normalized)) {
        base.capturesFailed += 1;
        notes.push(
          `${row.timestamp}: the archived page does not name @${normalized} (a login wall or a different page); the capture was skipped.`,
        );
        continue;
      }
      const followerCount = exactInt(body, FOLLOWER_PATTERNS);
      const followingCount = exactInt(body, FOLLOWING_PATTERNS);
      const postCount = exactInt(body, POST_PATTERNS);
      if (followerCount === null && followingCount === null && postCount === null) {
        base.capturesWithoutCounts += 1;
        notes.push(
          `${row.timestamp}: the archived page carried no exact count fields (only rounded prose, if anything); nothing was recorded from it.`,
        );
        continue;
      }
      seen.add(at.getTime());
      points.push({
        capturedAt: at,
        captureUrl,
        originalUrl: row.original,
        followerCount,
        followingCount,
        postCount,
        contentSha256: sha256Hex(bounded.bytes),
      });
      base.capturesWithCounts += 1;
    } catch (err) {
      base.capturesFailed += 1;
      notes.push(
        `${row.timestamp}: the capture could not be read${err instanceof Error ? ` (${err.message})` : ""}; the capture was skipped.`,
      );
    }
  }

  if (points.length === 0) {
    return {
      ...base,
      state: base.capturesFailed === rows.length ? "UNAVAILABLE" : "EMPTY",
      reason:
        base.capturesFailed === rows.length
          ? `The public archive lists ${rows.length} capture(s) of @${normalized} in the last ${windowDays} day(s), but none could be read. This is a failure to look, not an absence of history.`
          : `The public archive lists ${rows.length} capture(s) of @${normalized} in the last ${windowDays} day(s), but none carried an exact count. No count history was recorded.`,
      notes,
    };
  }

  notes.push(
    `Counts are exact integers read from the embedded payload of each archived page; the rounded "followers" prose is never used, because it cannot support a delta.`,
    `Each point's time is when the public archive captured the page, not when any follow occurred.`,
    `An archive captures an account at uneven intervals; a quiet interval is not evidence that nothing happened.`,
  );

  return {
    ...base,
    state: "OBSERVED",
    points,
    notes,
  };
}

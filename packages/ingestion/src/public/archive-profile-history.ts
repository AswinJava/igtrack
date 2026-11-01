import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { IG_USERNAME_PATTERN } from "../config/readiness.js";
import { ResponseTooLargeError, readBoundedBytes } from "../http/bounded-response.js";

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
// only from the archive host — a redirect away from it is refused, not
// followed. Every capture that could not be read, or that carried no exact
// counts, is counted and reported — never silently dropped into "no history".
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
  fetchImpl?: ArchiveFetch | undefined;
}

/**
 * How this reader asks for bytes. `redirect: "manual"` is part of the shape:
 * following a redirect would move the read off the archive host, and the
 * result of that read would still be labelled an archived capture.
 */
export type ArchiveFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "manual" },
) => Promise<ArchiveHttpResponse>;

/**
 * The part of an HTTP answer this reader uses: the status, one header, and a
 * byte stream it is allowed to stop reading. Archived captures are whole web
 * pages, so the stream is where the cap has to bite — a body collected before
 * being measured is a body whose size the archive chose.
 */
export interface ArchiveHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
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
  /** Captures that could not be read at all (network, HTTP status, oversized, redirected off the archive host). */
  capturesFailed: number;
  points: ArchivedProfileCounts[];
  /** Why the state is EMPTY / UNAVAILABLE; null when OBSERVED. */
  reason: string | null;
  notes: string[];
  /** Every URL this run asked for, in order. */
  consultedUrls: string[];
}

const ARCHIVE_HOST = "web.archive.org";
const CDX_ENDPOINT = `https://${ARCHIVE_HOST}/cdx/search/cdx`;
const RAW_CAPTURE_PREFIX = `https://${ARCHIVE_HOST}/web/`;
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

/**
 * Every URL this reader builds starts with the archive host, so a 3xx means the
 * bytes would come from somewhere else. The redirect is refused rather than
 * followed: reading another server's page and labelling it an archived capture
 * is the failure this prevents. The `Location` value is not quoted — it is
 * remote data, and nothing an operator could act on changes with its content.
 */
function wasRedirected(status: number): boolean {
  return status >= 300 && status <= 399;
}

function indexFailure(status: number): string {
  if (wasRedirected(status)) {
    return (
      `The public archive index answered HTTP ${status} with a redirect off the archive host. ` +
      "The redirect was not followed, so no listing was read; this is a failure to look, " +
      "not proof that no capture exists."
    );
  }
  return (
    `The public archive index answered HTTP ${status}; ` +
    "this is a failure to look, not proof that no capture exists."
  );
}

async function readBounded(
  response: ArchiveHttpResponse,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { failure: string }> {
  let raw: Uint8Array;
  try {
    // The cap bites while the bytes arrive, through the one reading primitive
    // this package uses everywhere else. A capture collected whole and
    // measured afterwards is a capture whose size the archive chose.
    raw = await readBoundedBytes(response, maxBytes, "archive capture");
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      return {
        failure: `response passed the ${err.maxBytes}-byte cap (at least ${err.receivedBytes} bytes were offered)`,
      };
    }
    throw err;
  }
  try {
    return { bytes: decodeBody(raw, maxBytes) };
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
    ((url: string, init: { signal: AbortSignal; redirect: "manual" }) =>
      fetch(url, init) as Promise<ArchiveHttpResponse>);

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
    const response = await fetchImpl(cdxUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (response.status !== 200) {
      return { ...base, state: "UNAVAILABLE", reason: indexFailure(response.status) };
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
    // Its own refusal, not the reachability catch below: a JSON syntax error
    // quotes a slice of the body it choked on, and response bytes do not go into
    // operator-visible output.
    if (text === "") {
      cdxPayload = [];
    } else {
      try {
        cdxPayload = JSON.parse(text) as unknown;
      } catch {
        return {
          ...base,
          state: "UNAVAILABLE",
          reason:
            "The public archive index answered with a body that is not the JSON list it documents. " +
            "This is a failure to look, not proof that no capture exists.",
        };
      }
    }
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
      const response = await fetchImpl(captureUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      if (response.status !== 200) {
        base.capturesFailed += 1;
        notes.push(
          wasRedirected(response.status)
            ? `${row.timestamp}: archive answered HTTP ${response.status} with a redirect off the archive host; the redirect was not followed and the capture was skipped.`
            : `${row.timestamp}: archive returned HTTP ${response.status}; the capture was skipped.`,
        );
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
    const failed = base.capturesFailed;
    // Any unreadable capture makes this a failure to look: "nothing was
    // recorded" is true, but "there was nothing to record" is unproven while
    // one capture was never read.
    if (failed === 0) {
      return {
        ...base,
        state: "EMPTY",
        reason: `The public archive lists ${rows.length} capture(s) of @${normalized} in the last ${windowDays} day(s), but none carried an exact count. No count history was recorded.`,
        notes,
      };
    }
    return {
      ...base,
      state: "UNAVAILABLE",
      reason:
        `The public archive lists ${rows.length} capture(s) of @${normalized} in the last ${windowDays} day(s), but ` +
        (failed === rows.length
          ? "none could be read"
          : `${failed} of the ${base.capturesRead} capture(s) attempted could not be read`) +
        `. This is a failure to look, not an absence of history.`,
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

// ---------------------------------------------------------------------------
// SSRF-guarded public page fetcher (FOUNDING §19, D69).
//
// The engine fetches pages the operator named or a search provider returned.
// Every fetch passes this gate, and the gate assumes the URL is hostile:
//   - http(s) only, no embedded credentials, ports limited to 80/443
//   - hostname policy (Instagram-family refused before any DNS work)
//   - DNS resolution checked against private / loopback / link-local /
//     metadata ranges, IPv4 and IPv6
//   - robots.txt respected (our UA and *), cached per host per fetcher
//   - redirects followed manually; EVERY hop re-runs the full gate
//   - content types limited to HTML/XHTML/plain text
//   - byte cap and wall-clock timeout enforced while streaming
//
// Retrieved bytes are DATA, never instructions: nothing in this file parses
// page prose into behaviour, and downstream the extractor only reads fixed
// structured fields (see extract.ts).
// ---------------------------------------------------------------------------

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  RESEARCH_BLOCKED_HOSTS,
  RESEARCH_FETCH_TIMEOUT_MS,
  RESEARCH_MAX_BYTES,
  RESEARCH_MAX_REDIRECTS,
  researchHostPolicy,
} from "@igtrack/core";

export const RESEARCH_USER_AGENT = "IGTrack-Research/0.1 (+self-hosted; operator-authority)";

const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

export type FetchFailureKind =
  | "UNSAFE_URL"
  | "BLOCKED_BY_POLICY"
  | "BLOCKED_BY_ROBOTS"
  | "BLOCKED_CONTENT_TYPE"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK_ERROR";

export interface FetchSuccess {
  ok: true;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  body: string;
  byteSize: number;
  fetchedAt: Date;
  redirectsFollowed: number;
  robotsChecked: boolean;
}

export interface FetchFailure {
  ok: false;
  kind: FetchFailureKind;
  reason: string;
  httpStatus: number | null;
  finalUrl: string | null;
}

export type FetchResult = FetchSuccess | FetchFailure;

export interface FetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Test seam: resolve every hostname to this fixed address instead of DNS.
   * Lets the test suite exercise the full gate against a local HTTP server
   * without weakening any production check.
   */
  pinLookup?: ((hostname: string) => Promise<string>) | undefined;
}

// --- URL gate ---------------------------------------------------------------

export type UrlGateDecision =
  | { allowed: true; url: URL }
  | { allowed: false; kind: FetchFailureKind; reason: string };

function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Static URL checks, before any DNS or socket work. `blockedHosts` extends
 * the core policy list (used by tests to pin extra hosts without touching
 * the real blocklist).
 */
export function gateResearchUrl(
  raw: string,
  blockedHosts: readonly string[] = RESEARCH_BLOCKED_HOSTS,
): UrlGateDecision {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { allowed: false, kind: "UNSAFE_URL", reason: `"${raw}" is not an absolute URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      kind: "UNSAFE_URL",
      reason: `Only http(s) URLs may be fetched (got "${url.protocol}").`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      allowed: false,
      kind: "UNSAFE_URL",
      reason: "URLs with embedded credentials are refused.",
    };
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return {
      allowed: false,
      kind: "UNSAFE_URL",
      reason: `Only standard web ports are allowed (got :${url.port}); research sources are ordinary public pages.`,
    };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") {
    return { allowed: false, kind: "UNSAFE_URL", reason: "URL has no hostname." };
  }
  const policy = researchHostPolicy(host);
  if (!policy.allowed) {
    // Core policy wins; the caller's extra blocklist (tests) adds on top.
    return { allowed: false, kind: "BLOCKED_BY_POLICY", reason: policy.reason };
  }
  const lower = host.toLowerCase();
  for (const blocked of blockedHosts) {
    if (matchesSuffix(lower, blocked.toLowerCase())) {
      return {
        allowed: false,
        kind: "BLOCKED_BY_POLICY",
        reason: `"${host}" is on the research engine's refused-host list (FOUNDING §19, D69).`,
      };
    }
  }
  return { allowed: true, url };
}

// --- IP policy ---------------------------------------------------------------

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** Is this resolved address one a public web page would never live on? */
export function isPrivateOrReservedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToNumber(ip);
    if (n === null) return true; // unparseable → refuse, never guess
    const inRange = (base: string, bits: number): boolean => {
      const b = ipv4ToNumber(base);
      if (b === null) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (b & mask);
    };
    return (
      inRange("0.0.0.0", 8) || // "this network"
      inRange("10.0.0.0", 8) || // RFC1918
      inRange("100.64.0.0", 10) || // CGNAT
      inRange("127.0.0.0", 8) || // loopback
      inRange("169.254.0.0", 16) || // link-local + cloud metadata
      inRange("172.16.0.0", 12) || // RFC1918
      inRange("192.0.0.0", 24) || // IETF protocol assignments
      inRange("192.168.0.0", 16) || // RFC1918
      inRange("198.18.0.0", 15) || // benchmarking
      inRange("224.0.0.0", 4) || // multicast
      inRange("240.0.0.0", 4) // reserved + broadcast
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified + loopback
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
    if (lower.startsWith("fe80")) return true; // fe80::/10 link-local
    if (lower.startsWith("ff")) return true; // ff00::/8 multicast
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the embedded v4.
    const mapped = /^(?:::ffff:(\d+\.\d+\.\d+\.\d+))$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPrivateOrReservedAddress(mapped[1]);
    const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (nat64?.[1] !== undefined) return isPrivateOrReservedAddress(nat64[1]);
    return false; // any other global unicast v6 is a public address
  }
  return true; // not an IP at all in an IP context → refuse
}

export type AddressCheck =
  | { safe: true }
  | { safe: false; reason: string };

/** Check every resolved address for a host. All must be public. */
export function checkResolvedAddresses(addresses: readonly string[]): AddressCheck {
  if (addresses.length === 0) {
    return { safe: false, reason: "hostname resolved to no addresses." };
  }
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      return {
        safe: false,
        reason: `hostname resolves to ${address}, a private/loopback/link-local/metadata address — the research engine fetches public pages only.`,
      };
    }
  }
  return { safe: true };
}

// --- robots.txt --------------------------------------------------------------

interface RobotsRules {
  /** Disallow path prefixes applying to our UA (or *). */
  disallows: string[];
}

function parseRobots(text: string, userAgent: string): RobotsRules {
  const uaToken = userAgent.split("/")[0]?.toLowerCase() ?? "";
  const lines = text.split(/\r?\n/);
  let applicable: string[] | null = null; // null = no matching group seen yet
  let inStarGroup = false;
  const disallows: string[] = [];
  let currentApplies = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      // A new group starts when a UA line follows rules (simplified RFC9309 grouping).
      if (applicable !== null && !currentApplies) {
        // keep scanning; group boundaries below handle it
      }
      const isOurs =
        value === "*"
          ? (inStarGroup = true, true)
          : value.toLowerCase().includes(uaToken) || uaToken.includes(value.toLowerCase().replace(/^\*/, ""));
      if (value === "*") {
        currentApplies = true;
      } else {
        currentApplies = isOurs;
      }
      applicable = applicable ?? [];
      continue;
    }
    if (field === "disallow") {
      if (currentApplies && value !== "") disallows.push(value);
    }
    // Allow lines are deliberately not modeled: the engine is a research
    // client, not a crawler — the most restrictive rule wins, and a site
    // that disallows a path simply does not get fetched there.
  }
  return { disallows };
}

function robotsAllows(rules: RobotsRules | null, path: string): boolean {
  if (rules === null) return true; // no robots fetched → allow (public page)
  return !rules.disallows.some((prefix) => path.startsWith(prefix));
}

// --- The fetcher ---------------------------------------------------------------

export class ResearchFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;
  private readonly pinLookup: ((hostname: string) => Promise<string>) | undefined;
  private readonly robotsCache = new Map<string, RobotsRules | null>();

  constructor(options: FetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RESEARCH_FETCH_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? RESEARCH_MAX_BYTES;
    this.maxRedirects = options.maxRedirects ?? RESEARCH_MAX_REDIRECTS;
    this.userAgent = options.userAgent ?? RESEARCH_USER_AGENT;
    this.pinLookup = options.pinLookup;
  }

  /** Resolve + validate. Split out so the gate is testable without sockets. */
  private async checkDestination(rawUrl: string): Promise<UrlGateDecision> {
    const gated = gateResearchUrl(rawUrl);
    if (!gated.allowed) return gated;
    const host = gated.url.hostname;
    let addresses: string[];
    if (this.pinLookup !== undefined) {
      try {
        addresses = [await this.pinLookup(host)];
      } catch (err) {
        return {
          allowed: false,
          kind: "NETWORK_ERROR",
          reason: `DNS lookup for "${host}" failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      try {
        const resolved = await dnsLookup(host, { all: true });
        addresses = resolved.map((entry) => entry.address);
      } catch (err) {
        return {
          allowed: false,
          kind: "NOT_FOUND",
          reason: `DNS lookup for "${host}" failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const checked = checkResolvedAddresses(addresses);
    if (!checked.safe) {
      return { allowed: false, kind: "BLOCKED_BY_POLICY", reason: checked.reason };
    }
    return gated;
  }

  private async fetchRobots(url: URL): Promise<RobotsRules | null> {
    const cached = this.robotsCache.get(url.origin);
    if (cached !== undefined) return cached;
    let rules: RobotsRules | null = null;
    try {
      const robotsUrl = `${url.origin}/robots.txt`;
      const response = await this.rawGet(robotsUrl, 16 * 1024, 5_000);
      if (response !== null && response.status === 200) {
        rules = parseRobots(response.body, this.userAgent);
      }
    } catch {
      // robots.txt unreachable → treated as "no rules", which is RFC9309's
      // own default. A fetch-level refusal (SSRF etc.) already blocked the
      // page itself if the host were unsafe.
      rules = null;
    }
    this.robotsCache.set(url.origin, rules);
    return rules;
  }

  /** One hop, no robots, no redirect following. */
  private async rawGet(
    rawUrl: string,
    byteCap: number,
    timeoutMs: number,
  ): Promise<
    | { status: number; contentType: string; body: string; bytes: number; location: string | null }
    | null
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(rawUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": this.userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
        },
      });
      const status = response.status;
      if (status >= 300 && status < 400) {
        return { status, contentType: "", body: "", bytes: 0, location: response.headers.get("location") };
      }
      const contentType = response.headers.get("content-type") ?? "";
      // Error statuses: consume nothing, report honestly.
      if (status >= 400) {
        return { status, contentType, body: "", bytes: 0, location: null };
      }
      // Stream with a hard byte cap: never trust content-length alone.
      const reader = response.body?.getReader();
      if (reader === undefined) {
        return { status, contentType, body: "", bytes: 0, location: null };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > byteCap) {
          await reader.cancel().catch(() => undefined);
          throw new ByteCapError(rawUrl);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status, contentType, body: new TextDecoder("utf-8", { fatal: false }).decode(merged), bytes: total, location: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch one URL through the full gate. Sequential redirect following with
   * per-hop validation; every hop counts against the redirect budget.
   */
  async fetchPage(rawUrl: string): Promise<FetchResult> {
    let current = rawUrl;
    let redirects = 0;
    for (;;) {
      const gated = await this.checkDestination(current);
      if (!gated.allowed) {
        return { ok: false, kind: gated.kind, reason: gated.reason, httpStatus: null, finalUrl: current };
      }
      const url = gated.url;
      const robots = await this.fetchRobots(url);
      if (!robotsAllows(robots, url.pathname + url.search)) {
        return {
          ok: false,
          kind: "BLOCKED_BY_ROBOTS",
          reason: `${url.origin}/robots.txt disallows ${url.pathname} for this user-agent; the engine respects robots and does not fetch it.`,
          httpStatus: null,
          finalUrl: current,
        };
      }
      let response: Awaited<ReturnType<ResearchFetcher["rawGet"]>>;
      try {
        response = await this.rawGet(url.toString(), this.maxBytes, this.timeoutMs);
      } catch (err) {
        if (err instanceof ByteCapError) {
          return {
            ok: false,
            kind: "TOO_LARGE",
            reason: `response exceeded the ${this.maxBytes}-byte per-document cap; a research source is a page, not a mirror.`,
            httpStatus: null,
            finalUrl: current,
          };
        }
        const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        return {
          ok: false,
          kind: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
          reason: isTimeout
            ? `fetch exceeded the ${this.timeoutMs}ms per-document timeout.`
            : `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          httpStatus: null,
          finalUrl: current,
        };
      }
      if (response === null) {
        return { ok: false, kind: "NETWORK_ERROR", reason: "fetch returned no response.", httpStatus: null, finalUrl: current };
      }
      if (response.status >= 300 && response.status < 400) {
        redirects += 1;
        if (redirects > this.maxRedirects) {
          return {
            ok: false,
            kind: "NETWORK_ERROR",
            reason: `redirect chain exceeded the ${this.maxRedirects}-hop cap.`,
            httpStatus: response.status,
            finalUrl: current,
          };
        }
        if (response.location === null) {
          return { ok: false, kind: "NETWORK_ERROR", reason: `HTTP ${response.status} with no Location header.`, httpStatus: response.status, finalUrl: current };
        }
        // Absolute-or-relative resolution, then the FULL gate on the next loop.
        let next: string;
        try {
          next = new URL(response.location, url).toString();
        } catch {
          return { ok: false, kind: "UNSAFE_URL", reason: `redirect target "${response.location}" is not a valid URL.`, httpStatus: response.status, finalUrl: current };
        }
        current = next;
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        return { ok: false, kind: "NOT_FOUND", reason: `HTTP ${response.status}.`, httpStatus: response.status, finalUrl: current };
      }
      if (response.status === 429) {
        return { ok: false, kind: "RATE_LIMITED", reason: "HTTP 429: the site asked us to slow down.", httpStatus: response.status, finalUrl: current };
      }
      if (response.status >= 400) {
        return { ok: false, kind: "NETWORK_ERROR", reason: `HTTP ${response.status}.`, httpStatus: response.status, finalUrl: current };
      }
      const base = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ALLOWED_CONTENT_TYPES.includes(base)) {
        return {
          ok: false,
          kind: "BLOCKED_CONTENT_TYPE",
          reason: `content-type "${response.contentType || "none"}" is not HTML/XHTML/plain text; the engine reads pages, not binaries.`,
          httpStatus: response.status,
          finalUrl: current,
        };
      }
      return {
        ok: true,
        finalUrl: url.toString(),
        httpStatus: response.status,
        contentType: response.contentType,
        body: response.body,
        byteSize: response.bytes,
        fetchedAt: new Date(),
        redirectsFollowed: redirects,
        robotsChecked: true,
      };
    }
  }
}

class ByteCapError extends Error {
  constructor(url: string) {
    super(`byte cap exceeded for ${url}`);
    this.name = "ByteCapError";
  }
}

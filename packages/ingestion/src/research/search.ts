// ---------------------------------------------------------------------------
// Search providers for the research engine (FOUNDING §19, D69, D73).
//
// Search returns CANDIDATE URLs, never evidence: nothing is stored from a
// search hit alone — each URL still goes through the full fetch gate, the
// extractor, and the claims validation boundary.
//
// Four implementations:
//   none     — the honest default when nothing is configured. Answers
//              UNAVAILABLE with the exact reason and the env vars to set.
//   fixture  — deterministic, for tests and the offline demo path.
//   brave    — the official Brave Search API behind
//              IGTRACK_RESEARCH_SEARCH_API_KEY (keyed, metered; the opted-in
//              route when a deployment holds a key).
//   freeserp — a keyless, unmetered, documented JSON API over its own crawl
//              index (no account, no key, no per-request meter). This is what
//              makes `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto` able to run a
//              REAL search on a fresh install without inventing one.
//
// Provider selection is env-gated, mirroring providerFromEnv(): a missing
// key never becomes a fake result list, an unknown name is a configuration
// error, and a request that failed is an error — never an empty result set.
// ---------------------------------------------------------------------------

import { AppError, AppErrorCode } from "@igtrack/core";

export interface SearchResult {
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface SearchOutcome {
  /** null provider = none configured; the run reports the reason instead. */
  provider: string | null;
  query: string;
  results: SearchResult[];
  unavailableReason: string | null;
  error: string | null;
  /**
   * A provider-side caveat that changes how the results should be read (for
   * example results served from a narrower fallback index). Present even when
   * results are non-empty, because partial coverage is still coverage worth
   * naming.
   */
  note?: string;
}

export interface ResearchSearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchOutcome>;
}

const NO_PROVIDER_REASON =
  "No search provider is configured. Set IGTRACK_RESEARCH_SEARCH_PROVIDER=auto " +
  "(uses IGTRACK_RESEARCH_SEARCH_API_KEY with Brave when a key is present, otherwise the keyless FreeSerp index), " +
  "or IGTRACK_RESEARCH_SEARCH_PROVIDER=brave with IGTRACK_RESEARCH_SEARCH_API_KEY, or pass --url to name public " +
  "pages directly. IGTRACK_RESEARCH_SEARCH_PROVIDER=none is the explicit " +
  "'no search request may leave this machine' setting. Without a source the engine can only re-research pages it " +
  "already knows (prior claim sources); it will not invent candidate sources.";

/**
 * The default: no provider configured. Honest unavailability, not silence.
 * The reason may be overridden when a provider WAS selected but cannot run
 * (e.g. `brave` with an empty key) — an operator must be told which variable
 * is wrong, not shown a generic "no provider" (invariant 7).
 */
export class NoSearchProvider implements ResearchSearchProvider {
  readonly name = "none";

  constructor(private readonly reason: string = NO_PROVIDER_REASON) {}

  async search(query: string, limit: number): Promise<SearchOutcome> {
    return {
      provider: null,
      query,
      results: [],
      unavailableReason: this.reason,
      error: null,
    };
  }
}

/** Deterministic provider over a fixed table, for tests and offline demos. */
export class FixtureSearchProvider implements ResearchSearchProvider {
  readonly name = "fixture";

  constructor(private readonly table: Readonly<Record<string, readonly SearchResult[]>>) {}

  async search(query: string, limit: number): Promise<SearchOutcome> {
    const results = this.table[query.trim().toLowerCase()] ?? [];
    return {
      provider: this.name,
      query,
      results: results.slice(0, limit),
      unavailableReason: null,
      error: null,
    };
  }
}

export interface BraveProviderOptions {
  apiKey: string;
  /** Endpoint override for tests; production uses the public API. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Brave Search API (web.search endpoint). The keyed, metered route: it is
 * selected only when a deployment supplies IGTRACK_RESEARCH_SEARCH_API_KEY,
 * so invariant 10 holds — a metered API is never reached without that
 * explicit act, and `auto` falls through to the keyless provider without it.
 */
export class BraveSearchProvider implements ResearchSearchProvider {
  readonly name = "brave";
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BraveProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: string, limit: number): Promise<SearchOutcome> {
    const url = `${this.endpoint}?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}&safesearch=strict`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          "accept": "application/json",
          "x-subscription-token": this.apiKey,
          "user-agent": "IGTrack-Research/0.1 (+self-hosted; operator-authority)",
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason:
            "The search provider rejected the API key (HTTP " +
            `${response.status}). Presence is not validity — check IGTRACK_RESEARCH_SEARCH_API_KEY.`,
          error: null,
        };
      }
      if (response.status === 429) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason: "The search provider rate-limited this query (HTTP 429); retry later.",
          error: null,
        };
      }
      if (!response.ok) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason: null,
          error: `search provider returned HTTP ${response.status}.`,
        };
      }
      const body = (await response.json()) as {
        web?: { results?: Array<{ url?: unknown; title?: unknown; description?: unknown }> };
      };
      const raw = body.web?.results ?? [];
      const results: SearchResult[] = [];
      for (const entry of raw) {
        if (typeof entry.url !== "string") continue;
        results.push({
          url: entry.url,
          title: typeof entry.title === "string" ? entry.title : null,
          snippet: typeof entry.description === "string" ? entry.description : null,
        });
        if (results.length >= limit) break;
      }
      return { provider: this.name, query, results, unavailableReason: null, error: null };
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      return {
        provider: this.name,
        query,
        results: [],
        unavailableReason: null,
        error: isTimeout
          ? "search provider timed out after 15s."
          // Defensive: transport errors may echo request context, so the
          // credential is stripped before any string can reach a report or log.
          : `search provider request failed: ${redactSecret(
              err instanceof Error ? err.message : String(err),
              this.apiKey,
            )}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Remove a secret from a string that is about to be reported or logged. */
function redactSecret(message: string, secret: string): string {
  if (secret === "") return message;
  return message.split(secret).join("[redacted]");
}

export interface FreeSerpProviderOptions {
  /** Endpoint override for tests; production uses the public API. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * FreeSerp (freeserp.ai) — the keyless leg of `auto`.
 *
 * Why this vendor and not another: general web search through a documented,
 * account-free endpoint is the one thing the default path needs, and the
 * alternatives were all excluded on evidence (docs/verification/SOURCE-AUDIT.md,
 * 2026-10-19 addendum): DuckDuckGo publishes only an instant-answer API (its
 * HTML endpoint is undocumented → refused, invariant 3), Mojeek now requires
 * an API key, SearXNG aggregates engines that forbid it (boundary 8), Google
 * CSE is closed to new customers and Bing's API is retired. FreeSerp publishes
 * first-party docs for this exact endpoint — parameters, response shape, error
 * statuses, rate guidance ("a few requests/second, identify yourself") — over
 * its OWN crawl index rather than a re-served scrape of somebody else's SERP.
 *
 * It is unmetered and keyless, so invariant 10 survives: no account, no meter,
 * no telemetry — only an `agent` identifier the docs ask for. Failures are
 * reported as failures (429/502/timeout/ok:false), never as an empty result
 * set, and a degraded fallback index is surfaced through `note`.
 */
export class FreeSerpSearchProvider implements ResearchSearchProvider {
  readonly name = "freeserp";
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FreeSerpProviderOptions = {}) {
    this.endpoint = options.endpoint ?? "https://freeserp.ai/api.php";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(query: string, limit: number): Promise<SearchOutcome> {
    const params = new URLSearchParams({
      index: "web",
      q: query,
      size: String(Math.min(Math.max(limit, 1), 20)),
      agent: "IGTrack/0.1",
      project: "IGTrack",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}?${params.toString()}`, {
        headers: {
          "accept": "application/json",
          "user-agent": "IGTrack-Research/0.1 (+self-hosted; operator-authority)",
        },
        signal: controller.signal,
      });
      if (response.status === 400) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason:
            "The search provider rejected the request (HTTP 400 query_required): index=web needs a non-empty q.",
          error: null,
        };
      }
      if (response.status === 429) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason: "The search provider rate-limited this query (HTTP 429); retry later.",
          error: null,
        };
      }
      if (!response.ok) {
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason: null,
          error: `search provider returned HTTP ${response.status}.${
            response.status === 502 ? " (upstream search error — retry with backoff)" : ""
          }`,
        };
      }
      const body = (await response.json()) as {
        ok?: unknown;
        error?: unknown;
        detail?: unknown;
        engine_fallback?: unknown;
        results?: Array<{ url?: unknown; title?: unknown; snippet?: unknown }>;
      };
      if (body.ok !== true) {
        // Remote-supplied strings are data: only a conservative token shape is
        // echoed back, so a hostile body cannot inject prose into a report.
        const remote = [body.error, body.detail]
          .map((part) => (typeof part === "string" ? part : ""))
          .filter((part) => /^[a-z0-9_. -]{1,80}$/i.test(part))
          .join(": ");
        return {
          provider: this.name,
          query,
          results: [],
          unavailableReason: null,
          error: `search provider reported a failure${remote === "" ? "" : ` (${remote})`}.`,
        };
      }
      const raw = body.results ?? [];
      const results: SearchResult[] = [];
      for (const entry of raw) {
        if (typeof entry.url !== "string") continue;
        results.push({
          url: entry.url,
          title: typeof entry.title === "string" ? entry.title : null,
          snippet: typeof entry.snippet === "string" ? entry.snippet : null,
        });
        if (results.length >= limit) break;
      }
      const outcome: SearchOutcome = {
        provider: this.name,
        query,
        results,
        unavailableReason: null,
        error: null,
      };
      if (body.engine_fallback === true) {
        outcome.note =
          "The provider served these results from its narrower sites index because its web index was unavailable " +
          "(engine_fallback): full-web coverage for this query may be incomplete.";
      }
      return outcome;
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      return {
        provider: this.name,
        query,
        results: [],
        unavailableReason: null,
        error: isTimeout
          ? `search provider timed out after ${this.timeoutMs}ms.`
          : `search provider request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Provider from environment, mirroring providerFromEnv()'s fail-fast shape:
 * an UNKNOWN provider name is a configuration error (never silently "none"),
 * and a missing key on a keyed provider degrades to `none` with the reason
 * carried into the run record — naming the variable, never a fake result list.
 *
 * `auto` is the configured default (set in .env): Brave when a key exists,
 * otherwise the keyless FreeSerp index, so a fresh installation can run a real
 * search without an account while a keyed deployment keeps the official API.
 */
export function researchSearchProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): ResearchSearchProvider {
  const name = (env["IGTRACK_RESEARCH_SEARCH_PROVIDER"] ?? "").trim().toLowerCase();
  const apiKey = (env["IGTRACK_RESEARCH_SEARCH_API_KEY"] ?? "").trim();
  if (name === "" || name === "none") return new NoSearchProvider();
  if (name === "fixture") {
    throw new AppError(
      AppErrorCode.VALIDATION_ERROR,
      "IGTRACK_RESEARCH_SEARCH_PROVIDER=fixture is for tests only; it has no configured table at runtime.",
    );
  }
  if (name === "brave") {
    if (apiKey === "") {
      // Missing key ≠ error at boot: the run still works over operator URLs
      // and prior sources — and the reason must name the variable that is
      // wrong, not read like an ordinary "no provider" (invariant 7).
      return new NoSearchProvider(
        "IGTRACK_RESEARCH_SEARCH_PROVIDER=brave is selected, but IGTRACK_RESEARCH_SEARCH_API_KEY is empty. " +
          "Set the key (any Brave-compatible key), switch to IGTRACK_RESEARCH_SEARCH_PROVIDER=auto (keyless FreeSerp " +
          "index when no key is present), or IGTRACK_RESEARCH_SEARCH_PROVIDER=none to disable search. A missing key " +
          "is never reported as a search that ran and found nothing — pass --url to name public pages directly.",
      );
    }
    return new BraveSearchProvider({ apiKey });
  }
  if (name === "freeserp") return new FreeSerpSearchProvider();
  if (name === "auto") {
    return apiKey === "" ? new FreeSerpSearchProvider() : new BraveSearchProvider({ apiKey });
  }
  throw new AppError(
    AppErrorCode.VALIDATION_ERROR,
    `Unsupported IGTRACK_RESEARCH_SEARCH_PROVIDER "${name}". Supported providers: none, auto, brave, freeserp.`,
  );
}

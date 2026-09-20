import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityErrorKind } from "@igtrack/core";
import {
  ANON_PACE_MS,
  ANON_SETTLE_MS,
  ANONSTORIES_ORIGIN,
  type AnonHttpResponse,
  type AnonStoriesTransport,
} from "./anonstories.js";
import {
  chromeUnavailableMessage,
  DEFAULT_CHROME_USER_AGENT,
  findChrome,
} from "./chrome.js";

// ---------------------------------------------------------------------------
// The anonstories transport: a real local Chrome page context.
//
// Why a page context at all: the aggregator's API answers Cloudflare 403 to
// any non-browser client, and it serves fabricated decoy data to the
// `HeadlessChrome` user agent (see anonstories.ts). So the calls run as
// fetch() calls inside a page on the origin — same origin, same cookies, real
// desktop UA — and Chrome is driven over CDP by the WebSocket that Node 22+
// ships natively. No Puppeteer/Playwright dependency, no profile reuse.
//
// One transport = one browser session: launch, load the origin (letting the
// bundle's rate-limit probe and challenge settle), then serve paced API calls
// until `close()` kills the browser and removes its temporary profile.
// ---------------------------------------------------------------------------

export class AnonTransportError extends Error {
  readonly kind: CapabilityErrorKind;

  constructor(kind: CapabilityErrorKind, message: string) {
    super(message);
    this.name = "AnonTransportError";
    this.kind = kind;
  }
}

export interface AnonChromeOptions {
  /** Browser executable. Defaults to a detected Chrome/Chromium/Edge. */
  executablePath?: string | undefined;
  /** Desktop UA presented to the aggregator. Must never read HeadlessChrome. */
  userAgent?: string | undefined;
  /** Minimum spacing between two API calls (default ANON_PACE_MS). */
  paceMs?: number | undefined;
  /** How long the origin may take to load and settle (default ANON_SETTLE_MS). */
  settleMs?: number | undefined;
  /** Per-call deadline before the call is a TIMEOUT (default 30s). */
  requestTimeoutMs?: number | undefined;
}

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string, timeoutMs: number): Promise<string>;
  close(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDebugPort(profileDir: string, timeoutMs: number): Promise<number> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const contents = readFileSync(portFile, "utf8");
      const port = Number.parseInt(contents.split(/\r?\n/)[0] ?? "", 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) {
      throw new AnonTransportError(
        "PROVIDER_ERROR",
        "Chrome never opened its DevTools endpoint (DevToolsActivePort missing).",
      );
    }
    await sleep(200);
  }
}

async function connectCdp(port: number, timeoutMs: number): Promise<CdpConnection> {
  const deadline = Date.now() + timeoutMs;
  let targets: Array<{ type: string; webSocketDebuggerUrl?: string }> = [];
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) targets = (await response.json()) as typeof targets;
    } catch {
      // Endpoint not accepting yet.
    }
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined);
    if (page !== undefined && page.webSocketDebuggerUrl !== undefined) {
      return await openSocket(page.webSocketDebuggerUrl, deadline);
    }
    if (Date.now() > deadline) {
      throw new AnonTransportError("PROVIDER_ERROR", "Chrome exposed no debuggable page target.");
    }
    await sleep(200);
  }
}

async function openSocket(url: string, deadline: number): Promise<CdpConnection> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AnonTransportError("TIMEOUT", "CDP handshake timed out.")),
      Math.max(1, deadline - Date.now()),
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new AnonTransportError("PROVIDER_ERROR", "CDP WebSocket failed to open."));
    };
  });

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  ws.onmessage = (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      waiter.reject(new Error(message.error.message ?? "CDP command failed"));
    } else {
      waiter.resolve(message.result);
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression: string, timeoutMs: number): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = (await Promise.race([
        send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AnonTransportError("TIMEOUT", "in-page request timed out")),
            timeoutMs,
          );
        }),
      ])) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      if (timer !== undefined) clearTimeout(timer);
      if (result.exceptionDetails !== undefined) {
        throw new AnonTransportError(
          "PROVIDER_ERROR",
          `in-page request raised: ${result.exceptionDetails.text ?? "unknown exception"}`,
        );
      }
      const value = result.result?.value;
      if (typeof value !== "string") {
        throw new AnonTransportError(
          "PROVIDER_ERROR",
          "in-page request returned no value (page navigated away?)",
        );
      }
      return value;
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      throw err;
    }
  };

  return {
    send,
    evaluate,
    close: () => {
      for (const waiter of pending.values()) waiter.reject(new Error("CDP connection closed"));
      pending.clear();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Open one session against the aggregator. The browser stays alive for the
 * session's lifetime so every call shares one Cloudflare clearance and one
 * pacing clock; `close()` always tears everything down.
 */
export async function openAnonStoriesChrome(
  options: AnonChromeOptions = {},
): Promise<AnonStoriesTransport> {
  const executable = findChrome(options.executablePath);
  if (executable === undefined) {
    throw new AnonTransportError("PROVIDER_ERROR", chromeUnavailableMessage());
  }
  const userAgent = options.userAgent ?? DEFAULT_CHROME_USER_AGENT;
  if (/HeadlessChrome/i.test(userAgent)) {
    // The aggregator answers this UA with fabricated decoy data; refuse to
    // start rather than ingest it.
    throw new AnonTransportError(
      "PROVIDER_ERROR",
      "The anonstories transport requires a desktop user agent; a HeadlessChrome UA is answered with decoy data.",
    );
  }
  const paceMs = options.paceMs ?? ANON_PACE_MS;
  const settleMs = options.settleMs ?? ANON_SETTLE_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const profileDir = mkdtempSync(join(tmpdir(), "igtrack-anon-"));
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  let lastRequestAt = 0;
  let broken: AnonTransportError | null = null;

  const teardown = (): void => {
    try {
      cdp?.close();
    } catch {
      // Best effort.
    }
    cdp = undefined;
    if (chrome !== undefined && chrome.exitCode === null) {
      try {
        chrome.kill();
      } catch {
        // Best effort.
      }
    }
    chrome = undefined;
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Best effort: the OS reaps its own temp eventually.
    }
  };

  try {
    chrome = spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        `--user-agent=${userAgent}`,
        // Keep navigator.webdriver false: the decoy trigger is the UA, but the
        // bundle also probes automation signals.
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    chrome.on("error", () => {
      broken ??= new AnonTransportError("PROVIDER_ERROR", "Chrome process error.");
    });

    const port = await waitForDebugPort(profileDir, 15_000);
    cdp = await connectCdp(port, 15_000);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: ANONSTORIES_ORIGIN });

    const loadDeadline = Date.now() + 20_000;
    for (;;) {
      const state = await cdp.evaluate("document.readyState", 5_000);
      if (state.includes("complete")) break;
      if (Date.now() > loadDeadline) {
        throw new AnonTransportError("TIMEOUT", "the aggregator page never finished loading");
      }
      await sleep(250);
    }
    // The bundle fires its own rate-limit probe and settles its challenge on
    // load; API calls made earlier are answered inconsistently.
    await sleep(settleMs);
  } catch (err) {
    teardown();
    if (err instanceof AnonTransportError) throw err;
    throw new AnonTransportError(
      "PROVIDER_ERROR",
      `could not open the anonstories browser session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const session: AnonStoriesTransport = {
    async request(endpoint: string, auth: string): Promise<AnonHttpResponse> {
      if (broken !== null) throw broken;
      const connection = cdp;
      if (connection === undefined) {
        throw new AnonTransportError("PROVIDER_ERROR", "the browser session is closed");
      }
      // Pace: the site rate-limits ~5 rapid calls, and one session is one
      // client as far as the server is concerned.
      const sinceLast = Date.now() - lastRequestAt;
      if (lastRequestAt !== 0 && sinceLast < paceMs) {
        await sleep(paceMs - sinceLast);
      }
      lastRequestAt = Date.now();

      const expression = `(async () => {
        try {
          const res = await fetch(${JSON.stringify(endpoint)}, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest"
            },
            body: "auth=" + ${JSON.stringify(auth)},
            credentials: "include"
          });
          const text = await res.text();
          return JSON.stringify({ status: res.status, body: text });
        } catch (err) {
          return JSON.stringify({ status: 0, body: "", error: String((err && err.message) || err) });
        }
      })()`;

      let payload: string;
      try {
        payload = await connection.evaluate(expression, requestTimeoutMs);
      } catch (err) {
        if (err instanceof AnonTransportError && err.kind === "TIMEOUT") {
          // A hung page fetch leaves the session in an unknown state.
          broken = err;
        }
        throw err;
      }

      let parsed: { status?: number; body?: string; error?: string };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        throw new AnonTransportError("PROVIDER_ERROR", "the in-page request returned malformed JSON");
      }
      if (parsed.error !== undefined && parsed.error !== "") {
        throw new AnonTransportError(
          "NETWORK",
          `the in-page request failed: ${parsed.error.slice(0, 200)}`,
        );
      }
      return { status: parsed.status ?? 0, body: parsed.body ?? "" };
    },

    async close(): Promise<void> {
      teardown();
    },
  };

  return session;
}

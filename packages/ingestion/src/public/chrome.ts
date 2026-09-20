import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal local-browser transport for the public-web provider.
//
// Why Chrome and not fetch(): Instagram's logged-out HTML is server-rendered,
// but its bare HTTP endpoints answer 429/redirect-to-login for ordinary
// clients. A real Chrome loads the public page the same way a visitor does,
// and `--dump-dom` returns the final, script-populated DOM. No credentials,
// no cookies, no private endpoints: the page a logged-out browser can open.
//
// Every invocation gets its own temporary profile so Chrome can never hand
// the request to an already-running desktop session, and the profile is
// removed afterwards. The browser exits on its own after dumping the DOM;
// there is no orphan process to reap.
// ---------------------------------------------------------------------------

export const DEFAULT_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

export interface ChromeRunOptions {
  executablePath?: string | undefined;
  userAgent?: string | undefined;
  /** Total process budget. Chrome is killed when this expires. */
  timeoutMs?: number | undefined;
  /** Virtual time Chrome may spend running page scripts before dumping. */
  virtualTimeBudgetMs?: number | undefined;
}

export class ChromeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeUnavailableError";
  }
}

function candidateChromePaths(): string[] {
  const fromEnv = [process.env.IGTRACK_CHROME_PATH, process.env.CHROME_PATH].filter(
    (value): value is string => value !== undefined && value.trim() !== "",
  );
  if (process.platform === "win32") {
    return [
      ...fromEnv,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      ...fromEnv,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    ...fromEnv,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

/** The first installed Chrome/Chromium/Edge binary, or undefined. */
export function findChrome(executablePath?: string): string | undefined {
  if (executablePath !== undefined && executablePath.trim() !== "") {
    return existsSync(executablePath) ? executablePath : undefined;
  }
  for (const candidate of candidateChromePaths()) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function chromeUnavailableMessage(): string {
  return (
    "The public-web provider needs a local Chrome/Chromium/Edge binary. " +
    "Install Google Chrome, or set IGTRACK_CHROME_PATH to the browser executable. " +
    "No request was made."
  );
}

interface ChromeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runChrome(
  executablePath: string,
  args: string[],
  timeoutMs: number,
): Promise<ChromeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error !== null) {
          // Chrome sometimes exits non-zero after it has already produced the
          // complete DOM (a crashpad/macOS keychain warning, a devtools race).
          // A real HTML document is the product; only a missing document is a
          // transport failure.
          if (/<html[\s>]/i.test(out)) {
            resolve({
              stdout: out,
              stderr: err,
              exitCode: typeof error.code === "number" ? error.code : null,
            });
            return;
          }
          const reason =
            error.killed === true
              ? `Chrome exceeded its ${timeoutMs} ms budget`
              : err.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400) ||
                error.message;
          reject(new Error(`Chrome could not load the page: ${reason}`));
          return;
        }
        resolve({ stdout: out, stderr: err, exitCode: 0 });
      },
    );
  });
}

/**
 * Render one URL in a fresh headless Chrome profile and return its DOM.
 * Throws ChromeUnavailableError when no browser exists; any other failure is
 * a normal transport error the provider maps to a typed capability failure.
 */
export async function dumpDom(url: string, options: ChromeRunOptions = {}): Promise<string> {
  const executablePath = findChrome(options.executablePath);
  if (executablePath === undefined) {
    throw new ChromeUnavailableError(chromeUnavailableMessage());
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const budget = options.virtualTimeBudgetMs ?? 4_000;
  const profileDir = mkdtempSync(join(tmpdir(), "igtrack-chrome-"));
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--hide-scrollbars",
    "--mute-audio",
    `--user-agent=${options.userAgent ?? DEFAULT_CHROME_USER_AGENT}`,
    `--user-data-dir=${profileDir}`,
    `--virtual-time-budget=${budget}`,
    "--dump-dom",
    url,
  ];
  try {
    const result = await runChrome(executablePath, args, timeoutMs);
    if (!/<html[\s>]/i.test(result.stdout)) {
      throw new Error("Chrome returned no HTML document");
    }
    return result.stdout;
  } finally {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A leftover temp profile is harmless; it carries no credentials and is
      // removed by the OS temp cleaner.
    }
  }
}

// PC-T1: provider execution boundary. A provider call may never wedge the
// single-threaded worker loop. Every provider capability call is raced against
// an explicit timeout; a timeout is a typed, retryable capability error —
// never fabricated data, never a partial completion.

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

// Browser-backed providers do not make one network call per capability: a
// single getPublicPosts renders the profile, the timeline and reels tabs, and
// one media page per post inside one provider call, each with its own 60 s
// page budget. A 30 s wall around that call would time out work the provider
// would otherwise finish and report honestly, so browser sources get a
// per-call default large enough for a real listing. IGTRACK_PROVIDER_TIMEOUT_MS
// still overrides both.
export const DEFAULT_BROWSER_PROVIDER_TIMEOUT_MS = 180_000;

const BROWSER_SOURCE_CLASSES = new Set(["public", "anonstories"]);

export class ProviderTimeoutError extends Error {
  constructor(
    readonly capability: string,
    readonly timeoutMs: number,
  ) {
    super(`provider ${capability} timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

// Read per call so tests and operators can tune it; invalid values fail safe
// to the default rather than disabling the boundary (fail closed).
export function providerTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  sourceId?: string,
): number {
  const parsed = Number(env.IGTRACK_PROVIDER_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const sourceClass = sourceId?.split(":")[0] ?? "";
  return BROWSER_SOURCE_CLASSES.has(sourceClass)
    ? DEFAULT_BROWSER_PROVIDER_TIMEOUT_MS
    : DEFAULT_PROVIDER_TIMEOUT_MS;
}

export function withProviderTimeout<T>(
  operation: Promise<T>,
  capability: string,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderTimeoutError(capability, timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([
    operation.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

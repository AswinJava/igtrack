// PC-T1: provider execution boundary. A provider call may never wedge the
// single-threaded worker loop. Every provider capability call is raced against
// an explicit timeout; a timeout is a typed, retryable capability error —
// never fabricated data, never a partial completion.

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

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
export function providerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.IGTRACK_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_TIMEOUT_MS;
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

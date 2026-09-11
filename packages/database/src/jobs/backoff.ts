export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
}

export function computeBackoffMs(
  attempts: number,
  options: BackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? 30_000;
  const capMs = options.capMs ?? 900_000;
  if (attempts < 1) return 0;
  const exponent = Math.min(attempts - 1, 20);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

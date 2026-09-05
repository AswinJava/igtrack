// Worker startup configuration guard (§10): dangerous numeric env values
// must fail fast with an unmistakable error instead of silently running a
// broken loop. Only SET values are validated — unset keys fall back to safe
// defaults at each use site. Explicit `leaseMs: 0` passed programmatically
// (deterministic tests) is unaffected; this guards the environment path.

export interface WorkerEnvErrors {
  errors: string[];
}

const CHECKS: Array<{ key: string; why: string }> = [
  {
    key: "IGTRACK_JOB_LEASE_MS",
    why: "must be a positive number of milliseconds; 0 reclaims every in-flight job instantly and duplicates all scans",
  },
  {
    key: "IGTRACK_JOB_POLL_MS",
    why: "must be a positive number of milliseconds; 0 spins the claim query with no sleep",
  },
  {
    key: "IGTRACK_PROVIDER_TIMEOUT_MS",
    why: "must be a positive number of milliseconds; 0 times out every provider call",
  },
  {
    key: "IGTRACK_SCHEDULER_TICK_MS",
    why: "must be a positive number of milliseconds; 0 re-runs the scheduler tick with no sleep",
  },
  {
    key: "IGTRACK_JOB_MAX_ITER",
    why: "must be a positive integer; bounds the ephemeral --once drain",
  },
];

export function validateWorkerEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const errors: string[] = [];
  for (const { key, why } of CHECKS) {
    const raw = env[key];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`igtrack worker: ${key}="${raw}" is invalid — ${why}. Unset it to use the safe default.`);
    }
  }
  return errors;
}

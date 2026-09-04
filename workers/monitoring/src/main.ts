import { createDb } from "@igtrack/database";
import { logWorker, providerFromEnv, runWorkerLoop } from "./index.js";

// Worker daemon entry point: `pnpm --filter @igtrack/monitoring start`.
// SIGINT/SIGTERM are cooperative: the loop stops claiming new work, the
// in-flight job finishes (ownership/lease guarantees cover the rest), and the
// database pool is closed before exit.
const handle = createDb();
let stopping = false;
function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logWorker("info", "worker_shutdown_signal", { signal });
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

const once = process.argv.includes("--once") || process.env.IGTRACK_WORKER_ONCE === "1";
// Ephemeral (GitHub Actions) bound: drain up to IGTRACK_JOB_MAX_ITER jobs
// (default 25) then exit. A single-iteration drain (MAX_ITER=1) cannot keep up
// with the beta envelope (20 targets x 5 kinds per window); the 5-minute
// Actions timeout is the wall-clock bound and lease/ownership guards make a
// timeout kill safe (next tick reclaims). Long-running self-host keeps the
// infinite loop by omitting --once.
function resolveOnceMaxIterations(): number {
  const raw = Number(process.env.IGTRACK_JOB_MAX_ITER ?? 25);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25;
}
const onceErrors: unknown[] = [];
try {
  await runWorkerLoop({
    db: handle.db,
    src: providerFromEnv(),
    shouldStop: () => stopping,
    ...(once
      ? {
          maxIterations: resolveOnceMaxIterations(),
          // Fail-loud for scheduled runs: a --once invocation that hit
          // scheduler-tick or poll errors (e.g. unreachable DATABASE_URL)
          // exits non-zero so the Actions step goes red instead of silently
          // "succeeding" with no work done. An idle queue produces no errors
          // and still exits 0. Daemon semantics are untouched: the loop still
          // survives every recoverable error, only the ephemeral exit code
          // reflects them.
          onError: (err: unknown) => {
            onceErrors.push(err);
          },
        }
      : {}),
  });
  await handle.close();
  if (once && onceErrors.length > 0) {
    logWorker("error", "worker_once_errors", { count: onceErrors.length });
    process.exit(1);
  }
  logWorker("info", "worker_stopped", {});
  process.exit(0);
} catch (err) {
  logWorker("error", "worker_fatal", {
    message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  });
  try {
    await handle.close();
  } catch {
    // Pool already broken; exit code carries the signal.
  }
  process.exit(1);
}

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

try {
  await runWorkerLoop({
    db: handle.db,
    src: providerFromEnv(),
    shouldStop: () => stopping,
  });
  await handle.close();
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

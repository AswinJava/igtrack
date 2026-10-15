import { resolve } from "node:path";
import { createDb } from "@igtrack/database";
import { providerFromEnv, pollOnce, makeWorkerId, runSchedulerTick } from "./index.js";
import { validateWorkerEnv } from "./config.js";

// One-shot dev worker: one scheduler tick (idempotent enqueue) plus one
// claimed job, then exits. Matches `start -- --once` with MAX_ITER=1 for a
// single-job probe; production ephemeral runs use `start -- --once` with
// IGTRACK_JOB_MAX_ITER=25 (bounded drain).
// For `pnpm --filter @igtrack/monitoring run-once`.
export async function runOnce(): Promise<void> {
  // Same fail-fast boot guard as the daemon entry (main.ts): an invalid
  // lease/poll/timeout value must refuse to run, never run differently.
  const configErrors = validateWorkerEnv();
  if (configErrors.length > 0) {
    for (const message of configErrors) {
      console.error(message);
    }
    throw new Error("igtrack run-once: invalid worker configuration");
  }
  const handle = createDb();
  try {
    const src = providerFromEnv();
    const workerId = makeWorkerId();
    try {
      await runSchedulerTick(handle.db);
    } catch (err) {
      console.error("scheduler tick failed (continuing to poll):", err);
    }
    const outcome = await pollOnce(handle.db, workerId, src);
    console.log(`worker ${workerId}:`, JSON.stringify(outcome));
  } finally {
    await handle.close();
  }
}

// Entry-point detection must be Windows-safe: comparing file:// URLs
// literally fails on Windows (`file://C:/...` vs `file:///C:/...`), which
// used to make this script exit 0 having done nothing. Compare resolved
// filesystem paths instead so a silent no-op is impossible.
export function isDirectlyInvoked(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  // Normalize without fileURLToPath: it rejects drive-less file URLs on
  // Windows, and literal URL comparison fails there (`file://C:/` vs
  // `file:///C:/`). Compare filesystem paths case- and slash-insensitively.
  const norm = (p: string): string =>
    p.replace(/\\/g, "/").toLowerCase().replace(/^\/([a-z]:\/)/, "$1");
  let metaPath: string;
  try {
    metaPath = norm(decodeURIComponent(new URL(metaUrl).pathname));
  } catch {
    return false;
  }
  const invokedPath = norm(resolve(argv1));
  if (metaPath === invokedPath) return true;
  // Fallback for root-relative or symlinked invocations (tsx wrappers, pnpm
  // shims): a full-path suffix match still proves identity without ever
  // matching an unrelated script, since argv[1] is the invoked script path.
  return metaPath.endsWith(invokedPath) || invokedPath.endsWith(metaPath);
}

const invokedDirectly = isDirectlyInvoked(process.argv[1], import.meta.url);

if (invokedDirectly) {
  runOnce().catch((err) => {
    console.error("worker error:", err);
    process.exit(1);
  });
}

